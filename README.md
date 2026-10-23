# dsh-plugin-inspector

一个「看得见、能调试所有插件」的 DSH 插件。

![panel](https://img.shields.io/badge/DSH-plugin-0.1.0-blue)

## 它给你什么

- **看全部插件**：面板里列出当前 profile 的依赖插件 + 补丁条目，含版本与配置项；
- **调试每个插件**：把某个插件注册的工具列出来，填参数、点「运行」，结果直接显示；
- **随手打开**：右下角 **🛠 悬浮按钮**，或 **Ctrl / Cmd + Shift + P**，`Esc` 关闭。

## 三块组成

| 文件 | 作用 |
|---|---|
| `src/index.js` | host 插件：包一层 `ctx.tools.register` 收集工具目录；提供两个接口 |
| `lib/client.js` | 客户端模块（手写，无需构建）：悬浮按钮 + 快捷键 + 面板渲染 |
| `cordis.patch.yml` | 装进 profile 的插入条目 |

## 接口

```http
GET  /plugins/dsh-plugin-inspector/state
     → { ok, profiles:[{name,bundles,plugins[]}], tools:[{name,description,parameters}] }

POST /plugins/dsh-plugin-inspector/call      { "name": "gpt_status", "args": {} }
GET  /plugins/dsh-plugin-inspector/call?name=gpt_status&args=%7B%7D   （POST 被拦时的退路）
     → { ok, ms, result } 或 { ok:false, error }
```

两个接口都只接受 **127.0.0.1** 且校验 `Origin` 与 `Host` 一致。

## 工具目录是怎么来的

注册表没有公开的“列出全部工具”接口，所以用了两条路：

1. **包装**：插件加载时把 `ctx.tools.register` 包一层，之后注册的工具全部记下；
2. **补录**：`config.probeTools` 里的名字直接从 `ctx.tools.get(name)` 解析
   （默认是 `gpt_*` 五个，可在 patch 里改）。

调用时如果目录里没有，会现场问注册表，所以**加载顺序不影响调用**。

## 配置

```yaml
- insert:
    - id: dsh-plugin-inspector
      name: dsh-plugin-inspector
      config:
        allowTools: []          # 空 = 允许全部；也可 ["gpt_*","todo_write"]
        probeTools: ["gpt_status","gpt_send","gpt_wait_image","gpt_ask","gpt_export_latest"]
```

## 安装

```powershell
copy 本目录 到 %USERPROFILE%\.dsh\profiles\web\node_modules\dsh-plugin-inspector
# 然后在 profile 的 cordis.patch.yml 末尾追加 cordis.patch.yml 里的四行
# 重启 DSH
```

## 注意

- host 插件是 **Node 模块**，改完 `.js` 不会热加载——**必须重启 DSH**；
- 客户端面板是浏览器模块，随页面刷新生效；
- 快捷键用捕获阶段监听，输入框里也能触发，但 `Ctrl+Shift+P` 会和浏览器打印面板冲突时，
  以页面为准（我们 `preventDefault`）。
