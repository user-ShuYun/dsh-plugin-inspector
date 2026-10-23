/**
 * 插件面板（客户端）——手写的 DSH 客户端模块，不需要构建。
 *
 * 不做进设置页，而是自己挂一个悬浮按钮 + 全局快捷键：
 *   Ctrl/Cmd + Shift + P   打开/关闭面板
 *   Esc                    关闭
 *
 * 面板内容来自 host 插件的两个接口：
 *   GET  /plugins/dsh-plugin-inspector/state
 *   GET|POST /plugins/dsh-plugin-inspector/call
 */
(function () {
  const loader = typeof window !== 'undefined' ? window.__ModuleLoader__ : undefined;
  if (!loader || typeof loader.load !== 'function') {
    // 没有模块加载器就安静退出，绝不把页面带崩
    if (typeof console !== 'undefined') console.warn('[dsh-plugin-inspector] module loader missing; panel disabled');
    return;
  }

  loader.load({
    id: 'dsh-plugin-inspector',
    factory: (require) => {
      const STATE_URL = '/plugins/dsh-plugin-inspector/state';
      const CALL_URL = '/plugins/dsh-plugin-inspector/call';

      const CSS = `
        .pi-fab{position:fixed;right:18px;bottom:18px;z-index:9998;width:42px;height:42px;border-radius:50%;
          border:1px solid rgba(120,190,255,.45);background:rgba(16,32,54,.82);color:#cfe6ff;font-size:18px;
          cursor:pointer;backdrop-filter:blur(8px);box-shadow:0 6px 20px rgba(0,0,0,.35)}
        .pi-fab:hover{background:rgba(28,54,86,.92)}
        .pi-panel{position:fixed;right:18px;bottom:70px;z-index:9999;width:540px;max-height:72vh;display:flex;
          flex-direction:column;border-radius:14px;border:1px solid rgba(120,190,255,.35);overflow:hidden;
          background:rgba(10,20,34,.96);color:#dce9f7;font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;
          box-shadow:0 18px 50px rgba(0,0,0,.5);backdrop-filter:blur(14px)}
        .pi-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;
          border-bottom:1px solid rgba(120,190,255,.18);background:rgba(20,38,62,.6)}
        .pi-title{font-weight:600;letter-spacing:.4px}
        .pi-tabs{display:flex;gap:6px;padding:8px 12px 0}
        .pi-tab{padding:4px 10px;border-radius:8px;cursor:pointer;color:#9fb6cf;border:1px solid transparent}
        .pi-tab.on{color:#eaf4ff;border-color:rgba(120,190,255,.45);background:rgba(40,80,130,.35)}
        .pi-body{overflow:auto;padding:10px 12px 14px}
        .pi-row{padding:8px 10px;border:1px solid rgba(120,190,255,.14);border-radius:10px;margin-bottom:8px;
          background:rgba(18,32,52,.55)}
        .pi-name{color:#8fd0ff;font-weight:600}
        .pi-desc{color:#8ea6bf;font-size:12px;margin-top:2px;white-space:pre-wrap}
        .pi-actions{display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap}
        .pi-btn{padding:3px 10px;border-radius:8px;cursor:pointer;border:1px solid rgba(120,190,255,.4);
          background:rgba(30,60,96,.6);color:#dceaf9;font:inherit}
        .pi-btn:hover{background:rgba(44,86,134,.75)}
        .pi-input{flex:1;min-width:160px;padding:3px 8px;border-radius:8px;border:1px solid rgba(120,190,255,.3);
          background:rgba(8,16,28,.8);color:#dceaf9;font:inherit}
        .pi-out{margin-top:6px;padding:6px 8px;border-radius:8px;background:rgba(6,14,24,.9);
          border:1px solid rgba(120,190,255,.16);white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto}
        .pi-ok{color:#63e6a8}.pi-err{color:#ff9b9b}
        .pi-hint{color:#8098b2;font-size:12px;margin:2px 0 10px}
      `;

      function el(tag, props, children) {
        const n = document.createElement(tag);
        if (props) for (const [k, v] of Object.entries(props)) {
          if (k === 'style') n.style.cssText = v;
          else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
          else n.setAttribute(k, v);
        }
        for (const c of children ?? []) n.append(c);
        return n;
      }

      async function getState() {
        const r = await fetch(STATE_URL, { headers: { accept: 'application/json' } });
        if (!r.ok) throw new Error('state ' + r.status);
        return r.json();
      }

      async function callTool(name, args) {
        // 先走 POST；某些部署下 POST 会被前面的处理器截走，退回 GET
        try {
          const r = await fetch(CALL_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, args })
          });
          const text = await r.text();
          if (r.ok && text) return JSON.parse(text);
        } catch {
          /* fall through */
        }
        const q = new URLSearchParams({ name, args: JSON.stringify(args) });
        const r2 = await fetch(CALL_URL + '?' + q.toString());
        return r2.json();
      }

      function mount() {
        if (document.querySelector('.pi-fab')) return;

        const style = el('style');
        style.textContent = CSS;
        document.head.append(style);

        const fab = el('button', { class: 'pi-fab', title: '插件面板 (Ctrl+Shift+P)' }, ['🛠']);
        document.body.append(fab);

        let panel = null;
        let tab = 'tools';
        let state = null;

        const close = () => {
          if (panel) panel.remove();
          panel = null;
        };

        const open = async () => {
          if (panel) return close();
          panel = el('div', { class: 'pi-panel' });
          const head = el('div', { class: 'pi-head' }, [
            el('div', { class: 'pi-title' }, ['插件面板']),
            el('button', { class: 'pi-btn', onclick: close }, ['关闭'])
          ]);
          const tabs = el('div', { class: 'pi-tabs' });
          const body = el('div', { class: 'pi-body' }, ['加载中…']);
          panel.append(head, tabs, body);
          document.body.append(panel);

          const renderTabs = () => {
            tabs.replaceChildren(
              ...['tools', 'plugins'].map((k) => {
                const label = k === 'tools' ? '工具 (' + ((state && state.tools) ? state.tools.length : 0) + ')' : '插件';
                return el('div', {
                  class: 'pi-tab' + (tab === k ? ' on' : ''),
                  onclick: () => { tab = k; renderTabs(); renderBody(); }
                }, [label]);
              })
            );
          };

          const renderBody = () => {
            if (!state) return;
            body.replaceChildren();
            if (tab === 'tools') {
              body.append(el('div', { class: 'pi-hint' }, ['点「运行」执行工具；参数填 JSON（留空表示 {}）。']));
              if (!state.tools.length) {
                body.append(el('div', { class: 'pi-hint' }, ['还没有捕获到工具：可在 cordis.patch.yml 的 probeTools 里写工具名。']));
              }
              for (const t of state.tools) {
                const out = el('div');
                const input = el('input', { class: 'pi-input', placeholder: '参数 JSON，例如 {"text":"hi"}' });
                const run = el('button', {
                  class: 'pi-btn',
                  onclick: async () => {
                    out.replaceChildren(el('div', { class: 'pi-hint' }, ['运行中…']));
                    let args = {};
                    const raw = input.value.trim();
                    if (raw) {
                      try { args = JSON.parse(raw); } catch (e) {
                        out.replaceChildren(el('div', { class: 'pi-err' }, ['JSON 解析失败: ' + e.message]));
                        return;
                      }
                    }
                    try {
                      const r = await callTool(t.name, args);
                      const text = (r && r.ok) ? JSON.stringify(r.result, null, 2) : String((r && r.error) || 'unknown');
                      out.replaceChildren(
                        el('div', { class: (r && r.ok) ? 'pi-ok' : 'pi-err' }, [text]),
                        el('div', { class: 'pi-hint' }, [String((r && r.ms) || 0) + ' ms'])
                      );
                    } catch (e) {
                      out.replaceChildren(el('div', { class: 'pi-err' }, [String(e.message || e)]));
                    }
                  }
                }, ['运行']);
                body.append(el('div', { class: 'pi-row' }, [
                  el('div', { class: 'pi-name' }, [t.name]),
                  el('div', { class: 'pi-desc' }, [t.description || '']),
                  el('div', { class: 'pi-actions' }, [input, run]),
                  out
                ]));
              }
            } else {
              for (const p of state.profiles) {
                body.append(el('div', { class: 'pi-hint' }, ['profile: ' + p.name + '　bundles: ' + ((p.bundles || []).join(', ') || '(none)')]));
                for (const item of p.plugins) {
                  const cfg = (item.config && Object.keys(item.config).length)
                    ? Object.entries(item.config).map((kv) => kv[0] + ': ' + kv[1]).join('\n')
                    : '(no config)';
                  body.append(el('div', { class: 'pi-row' }, [
                    el('div', { class: 'pi-name' }, [item.name]),
                    el('div', { class: 'pi-desc' }, ['id: ' + item.id + '　' + item.kind + (item.version ? '　' + item.version : '')]),
                    el('div', { class: 'pi-out' }, [cfg])
                  ]));
                }
              }
            }
          };

          try {
            state = await getState();
          } catch (e) {
            body.replaceChildren(el('div', { class: 'pi-err' }, ['读取失败: ' + String(e.message || e)]));
            return;
          }
          renderTabs();
          renderBody();
        };

        fab.addEventListener('click', open);

        const onKey = (ev) => {
          const mod = ev.ctrlKey || ev.metaKey;
          if (mod && ev.shiftKey && (ev.key === 'P' || ev.key === 'p')) {
            ev.preventDefault();
            open();
          } else if (ev.key === 'Escape' && panel) {
            close();
          }
        };
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('keydown', onKey, true);
          fab.remove();
          style.remove();
        };
      }

      function apply(ctx) {
        let teardown = null;
        try {
          teardown = mount();
        } catch (error) {
          console.error('[dsh-plugin-inspector] mount failed:', error);
        }
        if (ctx && typeof ctx.effect === 'function' && typeof teardown === 'function') {
          ctx.effect(() => teardown);
        }
      }

      module.exports = {
        name: 'dsh-plugin-inspector-client',
        inject: [],
        apply
      };
      return module.exports;
    }
  });
})();
