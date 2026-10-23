/**
 * dsh-plugin-inspector —— 一个能看见、能调试所有插件的插件。
 *
 * 它做三件事：
 *   1. 收集：包装 `ctx.tools.register`，把之后注册的工具记进目录（不改原行为）；
 *   2. 展示：`GET /plugins/dsh-plugin-inspector/state` 返回插件清单 + 工具清单；
 *   3. 调试：`GET|POST /plugins/dsh-plugin-inspector/call` 执行某个工具并返回结果。
 *
 * 设计原则：**这个插件绝不能把 DSH 弄挂**。
 *   - 全流程 try/catch，任何一步失败只打日志，不向上抛；
 *   - 不往服务对象上写标记（早期版本往 ctx.tools 挂字段，遇到不可扩展对象会直接炸启动）；
 *   - 路由注册失败也不影响其它插件。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const name = 'plugin-inspector';
export const inject = ['tools', 'webServer'];

const ROUTE_STATE = '/plugins/dsh-plugin-inspector/state';
const ROUTE_CALL = '/plugins/dsh-plugin-inspector/call';
const ROUTE_PAGE = '/plugins/dsh-plugin-inspector/page';

/** 默认想暴露的工具：插件自己的 + 常见第三方（可用 config.probeTools 覆盖） */
const DEFAULT_PROBE = ['gpt_status', 'gpt_send', 'gpt_wait_image', 'gpt_ask', 'gpt_export_latest'];

/** 独立页面（不依赖客户端模块）：直接开 /plugins/dsh-plugin-inspector/page 就能用 */
const PAGE_HTML = [
  '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>插件面板</title><style>',
  ':root{color-scheme:dark}body{margin:0;padding:24px;background:#0b1522;color:#dce9f7;',
  'font:13px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}',
  'h1{font-size:16px;margin:0 0 4px}.sub{color:#7f97b0;margin-bottom:18px}',
  '.tabs{display:flex;gap:8px;margin-bottom:14px}',
  '.tab{padding:5px 12px;border-radius:8px;cursor:pointer;border:1px solid #24405f;color:#9fb6cf}',
  '.tab.on{color:#eaf4ff;background:#1a3352;border-color:#3d6b9e}',
  '.row{border:1px solid #1d3350;border-radius:10px;padding:10px 12px;margin-bottom:9px;background:#101d2e}',
  '.name{color:#8fd0ff;font-weight:600}.desc{color:#8aa2ba;font-size:12px;margin-top:2px;white-space:pre-wrap}',
  '.acts{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}',
  'input{flex:1;min-width:220px;padding:4px 8px;border-radius:8px;border:1px solid #29456a;background:#0a1320;color:#dceaf9;font:inherit}',
  'button{padding:4px 12px;border-radius:8px;cursor:pointer;border:1px solid #3a628f;background:#1b3352;color:#dceaf9;font:inherit}',
  'button:hover{background:#25456b}pre{margin:8px 0 0;padding:8px;border-radius:8px;background:#08111c;',
  'border:1px solid #1c3049;white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto}',
  '.ok{color:#63e6a8}.err{color:#ff9b9b}.hint{color:#7f97b0;font-size:12px}',
  '</style></head><body>',
  '<h1>插件面板</h1><div class="sub">/plugins/dsh-plugin-inspector/page　·　数据来自 /state，执行走 /call</div>',
  '<div class="tabs" id="tabs"></div><div id="body" class="hint">加载中…</div>',
  '<script>',
  'var state=null,tab="tools";',
  'function el(t,p,c){var n=document.createElement(t);if(p)for(var k in p){if(k.slice(0,2)==="on")n.addEventListener(k.slice(2),p[k]);else n.setAttribute(k,p[k]);} (c||[]).forEach(function(x){n.append(x);});return n;}',
  'function render(){var tabs=document.getElementById("tabs"),body=document.getElementById("body");',
  'tabs.innerHTML="";[["tools","工具 ("+((state&&state.tools)?state.tools.length:0)+")"],["plugins","插件"]].forEach(function(kv){',
  'var d=el("div",{class:"tab"+(tab===kv[0]?" on":""),onclick:function(){tab=kv[0];render();}},[kv[1]]);tabs.append(d);});',
  'body.innerHTML="";',
  'if(tab==="tools"){if(!state.tools.length){body.append(el("div",{class:"hint"},["没有捕获到工具"]));}',
  'state.tools.forEach(function(t){var out=el("div");var inp=el("input",{placeholder:"参数 JSON，例如 {\\"text\\":\\"hi\\"}"});',
  'var btn=el("button",{onclick:function(){out.innerHTML="<div class=hint>运行中…</div>";var a={};var raw=inp.value.trim();',
  'if(raw){try{a=JSON.parse(raw);}catch(e){out.innerHTML="<pre class=err>JSON 解析失败: "+e.message+"</pre>";return;}}',
  'fetch("/plugins/dsh-plugin-inspector/call",{method:"POST",headers:{"content-type":"application/json"},',
  'body:JSON.stringify({name:t.name,args:a})}).then(function(r){return r.text();}).then(function(txt){var j={};try{j=JSON.parse(txt);}catch(e){}',
  'var ok=j&&j.ok;out.innerHTML="<pre class="+(ok?"ok":"err")+">"+String(ok?JSON.stringify(j.result,null,2):(j.error||txt)).replace(/</g,"&lt;")+"</pre>";',
  '}).catch(function(e){out.innerHTML="<pre class=err>"+e.message+"</pre>";});}},[\"运行\"]);',
  'body.append(el("div",{class:"row"},[el("div",{class:"name"},[t.name]),el("div",{class:"desc"},[t.description||""]),',
  'el("div",{class:"acts"},[inp,btn]),out]));});}',
  'else{state.profiles.forEach(function(p){body.append(el("div",{class:"hint"},["profile: "+p.name+" · bundles: "+(p.bundles||[]).join(", ")]));',
  'p.plugins.forEach(function(it){var cfg=(it.config&&Object.keys(it.config).length)?Object.keys(it.config).map(function(k){return k+": "+it.config[k];}).join("\\n"):"(no config)";',
  'body.append(el("div",{class:"row"},[el("div",{class:"name"},[it.name]),el("div",{class:"desc"},["id: "+it.id+" · "+it.kind]),el("pre",{},[cfg])]));});});}}',
  'fetch("/plugins/dsh-plugin-inspector/state").then(function(r){return r.json();}).then(function(j){state=j;render();})',
  '.catch(function(e){document.getElementById("body").textContent="读取失败: "+e.message;});',
  '</script></body></html>'
].join('');

/** 工具目录：包装 register 抓到的 + 用 probeTools 从注册表解析出来的 */
const catalog = new Map();

/** 模块级标记：绝不往服务对象上写东西 */
let wrapped = false;

function log(...args) {
  try {
    console.warn('[dsh-plugin-inspector]', ...args);
  } catch {
    /* 连日志都失败就算了 */
  }
}

function profilePaths() {
  const root = join(homedir(), '.dsh', 'profiles');
  const out = [];
  try {
    for (const dir of readdirSync(root)) {
      const p = join(root, dir);
      if (existsSync(join(p, 'package.json'))) out.push({ name: dir, dir: p });
    }
  } catch {
    /* 没有 profile 也不致命 */
  }
  return out;
}

/** 解析 profile：依赖列表 + 补丁条目（轻量 YAML，够用就行） */
function readProfile(dir) {
  const plugins = [];
  const bundles = [];
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const [dep, ver] of Object.entries(pkg.dependencies ?? {})) {
      plugins.push({ id: dep, name: dep, kind: 'dependency', version: String(ver), config: null });
    }
    for (const b of pkg.dsh?.profile?.bundles ?? []) bundles.push(b);
  } catch {
    /* ignore */
  }
  const patchFile = join(dir, 'cordis.patch.yml');
  if (existsSync(patchFile)) {
    const lines = readFileSync(patchFile, 'utf8').split(/\r?\n/);
    let cur = null;
    for (const line of lines) {
      const idm = /^\s*-\s+id:\s*(.+?)\s*$/.exec(line);
      if (idm) {
        cur = { id: idm[1], name: idm[1], kind: 'patch', config: {}, named: false };
        plugins.push(cur);
        continue;
      }
      const nm = /^\s+name:\s*(.+?)\s*$/.exec(line);
      if (nm && cur && !cur.named) {
        cur.name = nm[1].replace(/^["']|["']$/g, '');
        cur.named = true;
        continue;
      }
      const kv = /^\s{6,}([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (kv && cur) cur.config[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
  }
  return { plugins, bundles };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function isLoopback(address) {
  return !address || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function apply(ctx, config = {}) {
  try {
    const tools = ctx.tools;
    const resolveTool = (n) => {
      try {
        return typeof tools?.get === 'function' ? tools.get(n) : undefined;
      } catch {
        return undefined;
      }
    };

    // 1) 收集：包一层 register（只替换方法，不动对象上的其它字段）
    if (!wrapped && tools && typeof tools.register === 'function') {
      try {
        const original = tools.register.bind(tools);
        tools.register = (definition) => {
          try {
            if (definition?.name) catalog.set(definition.name, definition);
          } catch {
            /* 目录失败不影响注册 */
          }
          return original(definition);
        };
        wrapped = true;
      } catch (e) {
        log('wrap register failed (ignored):', e?.message);
      }
    }

    // 2) 补录：加载晚于目标插件时，按名字从注册表解析
    const probe = Array.isArray(config.probeTools) ? config.probeTools : DEFAULT_PROBE;
    for (const n of probe) {
      try {
        const def = resolveTool(n);
        if (def && !catalog.has(n)) catalog.set(n, def);
      } catch {
        /* ignore */
      }
    }

    // 3) 展示接口
    try {
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_STATE,
        handler: async (req, res) => {
          try {
            if (!isLoopback(req.socket?.remoteAddress)) return json(res, 403, { error: 'local only' });
            if (!sameOrigin(req)) return json(res, 403, { error: 'origin mismatch' });
            const profiles = profilePaths().map((p) => ({ name: p.name, ...readProfile(p.dir) }));
            json(res, 200, {
              ok: true,
              profiles,
              tools: [...catalog.values()].map((t) => ({
                name: t.name,
                description: t.description ?? '',
                parameters: t.parameters ?? {}
              })),
              allowTools: config.allowTools ?? null
            });
          } catch (e) {
            json(res, 500, { ok: false, error: String(e?.message ?? e) });
          }
        }
      });
    } catch (e) {
      log('state route failed:', e?.message);
    }

    // 3b) 独立页面：即使客户端模块没加载出来，也能直接开这个 URL 用
    try {
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PAGE,
        handler: async (req, res) => {
          if (!isLoopback(req.socket?.remoteAddress)) {
            res.writeHead(403).end('local only');
            return;
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(PAGE_HTML);
        }
      });
    } catch (e) {
      log('page route failed:', e?.message);
    }

    // 4) 调试接口：POST（JSON body）与 GET（query）都支持
    try {
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_CALL,
        handler: async (req, res) => {
          try {
            if (!isLoopback(req.socket?.remoteAddress)) return json(res, 403, { error: 'local only' });
            if (!sameOrigin(req)) return json(res, 403, { error: 'origin mismatch' });

            let payload;
            if (req.method === 'POST') {
              payload = JSON.parse(await readBody(req));
            } else if (req.method === 'GET') {
              const url = new URL(req.url, 'http://127.0.0.1');
              payload = { name: url.searchParams.get('name'), args: JSON.parse(url.searchParams.get('args') || '{}') };
            } else {
              return json(res, 405, { error: 'GET or POST only' });
            }

            const toolName = payload?.name;
            const def = catalog.get(toolName) ?? resolveTool(toolName);
            if (!def) return json(res, 404, { ok: false, error: `tool not found: ${toolName}` });
            if (!catalog.has(toolName)) catalog.set(toolName, def);

            const allow = config.allowTools;
            if (Array.isArray(allow) && allow.length > 0) {
              const ok = allow.some((p) => (p.endsWith('*') ? toolName.startsWith(p.slice(0, -1)) : p === toolName));
              if (!ok) return json(res, 403, { ok: false, error: `tool not allowed: ${toolName}` });
            }

            const started = Date.now();
            try {
              const result = await def.execute(payload.args ?? {}, {});
              json(res, 200, { ok: true, ms: Date.now() - started, result });
            } catch (e) {
              json(res, 200, { ok: false, ms: Date.now() - started, error: String(e?.message ?? e) });
            }
          } catch (e) {
            json(res, 500, { ok: false, error: String(e?.message ?? e) });
          }
        }
      });
    } catch (e) {
      log('call route failed:', e?.message);
    }
  } catch (e) {
    // 兜底：这个插件的任何失败都不该影响 DSH 启动
    log('apply failed (ignored):', e?.message);
  }
}
