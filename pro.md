# PRD：Windows 桌面壳（Electron + TypeScript + chttp 虚拟 HTTP 服务）

> 本文档用于指导新项目从零开发，包含需求、架构设计、接口约定、完整示例代码与验收标准。
> 文中代码为参考实现，可直接作为工程起点；涉及第三方工具链的配置项以对应版本的官方文档为准。

---

## 1. 产品定义

### 1.1 一句话

一个**只运行在 Windows x64** 的 Electron 桌面壳：前端页面与后端接口都通过自定义协议 `chttp://app` 提供，主进程充当"虚拟 HTTP Server"（不监听任何端口），支持普通 JSON 接口和 SSE 流式接口，业务能力可以内置路由或插件的形式扩展。

### 1.2 目标

| # | 目标 |
|---|------|
| G1 | 基于最新稳定版 Electron，使用 Electron Forge + Vite 插件 + TypeScript（strict）构建 |
| G2 | `chttp://app/` 提供前端静态资源，`chttp://app/api/*` 提供 HTTP 与 SSE 接口，同源、无端口 |
| G3 | 路由可在主进程注册，也可通过安装包内置的插件动态加载；插件之间相互隔离 |
| G4 | 安全基线符合 Electron 官方安全建议 |
| G5 | 产出 Inno Setup 安装包（按用户安装），预留统一的代码签名接入点 |

### 1.3 范围外（不做）

- macOS / Linux，Windows ia32 / arm64
- 前端热更新、应用自动更新
- 运行时安装第三方插件；插件之间互相调用
- 执行本地脚本、在主进程执行前端传入的代码、任意 URL 代理
- 应用代码写入任何文件：不写日志文件、不保存崩溃转储、不记住窗口尺寸、不记住关闭选择、定时任务不持久化
  - 说明：Chromium 自身在 `%APPDATA%\<应用名>` 下的缓存不受应用代码控制，不在此限

### 1.4 术语

| 术语 | 含义 |
|------|------|
| chttp | 本应用的自定义协议，唯一主机名为 `app`，origin 为 `chttp://app` |
| 路由 | 主进程中处理 `/api/*` 请求的函数 |
| 插件 | 随安装包发布、启动时动态加载的路由模块，位于 `app.asar` 内的 `plugins/` 目录 |
| 桥接（bridge） | preload 通过 `contextBridge` 暴露给页面的 `window.app` 对象 |

---

## 2. 技术选型

| 领域 | 选型 | 说明 |
|------|------|------|
| 运行时 | Electron 最新稳定版 | 立项时执行 `npm view electron version` 获取，`package.json` 中锁定**精确版本** |
| 语言 | TypeScript `strict: true` | main / preload / renderer / 插件全部使用 TS |
| 工具链 | Electron Forge + `@electron-forge/plugin-vite` | 使用 `vite-typescript` 模板初始化 |
| 插件构建 | esbuild | 每个插件独立打包为一个 CJS 文件，并用 metafile 检查插件之间的导入隔离 |
| 安全加固 | `@electron-forge/plugin-fuses` | 关闭 RunAsNode 等危险能力，开启 asar 完整性校验 |
| 安装包 | Inno Setup 6 | 仓库内实现自定义 Forge maker |
| 单元测试 | Vitest | |
| E2E | Playwright（Electron 模式） | |
| 规范 | ESLint（typescript-eslint）+ Prettier | |
| 开发环境 | Windows 10/11 x64，Node.js 22 LTS 或更高 | 打包必须在 Windows 上进行 |

**运行时依赖**：`dependencies` 保持为空，所有代码在构建时打包。

---

## 3. 架构设计

### 3.1 总体结构

```
┌──────────────────────────────── 主进程 Main ─────────────────────────────────┐
│                                                                              │
│  ┌──────────── Lifecycle (index.ts) ────────────┐                             │
│  │ 单实例 · 安全策略 · 启动编排 · 退出           │                             │
│  └───────┬───────────────┬───────────────┬──────┘                             │
│          │               │               │                                    │
│  ┌───────▼──────┐ ┌──────▼──────┐ ┌──────▼───────┐ ┌───────────────────────┐   │
│  │ Window       │ │ Tray        │ │ IPC          │ │ AutoImport Scheduler  │   │
│  │ 主窗口/关闭流程 │ │ 托盘菜单     │ │ 白名单+来源校验 │ │ 内存中的定时任务        │   │
│  └──────────────┘ └─────────────┘ └──────────────┘ └───────────┬───────────┘   │
│                                                                │ tick         │
│  ┌───────────────────────── chttp 协议层 ──────────────────────────────────┐   │
│  │ protocol.handle("chttp")                                               │   │
│  │   host ≠ app → 404       origin ≠ chttp://app → 403                    │   │
│  │   /api/*  ──► Router ──► 中间件(体积限制/错误包装) ──► Handler           │   │
│  │                │            ├─ 内置路由  /api/ping /api/plugins /api/tasks │
│  │                │            └─ 插件路由  /api/plugins/<name>/*           │   │
│  │                └─ JSON: {code,msg,data}    SSE: text/event-stream       │   │
│  │   其他     ──► Static：生产读 asar 内 renderer；开发代理 Vite dev server  │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌──── Plugin Loader ────┐   app.asar/plugins/<name>/index.js                 │
│  │ 扫描→校验→scope 挂载    │   每个插件只拿到自己的 scoped router 和 ctx         │
│  └───────────────────────┘                                                    │
└──────────────────────────────────────────────────────────────────────────────┘
          ▲ ipcRenderer（白名单）                       ▲ fetch / SSE（同源）
┌──── Preload（sandbox）────┐                 ┌──── Renderer  chttp://app/ ─────┐
│ contextBridge → window.app │◄───────────────│ 业务前端 + api 客户端 + 自绘标题栏 │
└────────────────────────────┘                └─────────────────────────────────┘
```

### 3.2 职责边界

| 通道 | 承载内容 | 原则 |
|------|----------|------|
| `chttp://app/api/*` | 所有业务数据与业务操作（含插件） | 能用 HTTP 表达的一律走这里 |
| IPC（`window.app`） | 窗口控制、应用信息、打开外部链接、主进程主动推送的事件 | 只放 HTTP 无法表达或与窗口强相关的能力 |

### 3.3 模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| Lifecycle | `src/main/index.ts` | 注册协议权限、单实例锁、启动编排、退出控制 |
| Security | `src/main/security.ts` | 全局沙箱、导航与弹窗限制、权限拒绝、禁止 webview |
| Window | `src/main/window.ts` | 创建主窗口、关闭流程、最大化状态推送、主题推送 |
| Tray | `src/main/tray.ts` | 托盘图标与菜单 |
| IPC | `src/main/ipc.ts` | 注册白名单通道、校验调用来源 |
| chttp | `src/main/chttp/*` | 协议入口、路由器、SSE、静态资源 |
| Routes | `src/main/routes/*` | 内置接口 |
| Plugins | `src/main/plugins/loader.ts` | 加载插件并隔离挂载 |
| Tasks | `src/main/tasks/auto-import.ts` | AutoImport 调度 |
| Logger | `src/main/logger.ts` | 只输出到控制台，不写文件 |
| Shared | `src/shared/*` | main、preload、renderer 共享的类型与常量（IPC 契约、API 格式、错误码） |
| SDK | `src/sdk/index.ts` | 插件开发唯一可导入的入口 |

### 3.4 启动时序

```
app 进程启动
 ├─ registerChttpScheme()            // 必须在 ready 之前
 ├─ app.enableSandbox()
 ├─ requestSingleInstanceLock() ── 失败 → app.quit()
 └─ app.whenReady()
     ├─ applySecurityPolicy()
     ├─ router = new Router()
     ├─ 注册内置路由（ping / tasks）
     ├─ loadPlugins(router)          // 插件失败只记录，不中断
     ├─ 注册 GET /api/plugins
     ├─ handleChttp(router, staticHandler)
     ├─ registerIpc()
     ├─ createMainWindow() → loadURL("chttp://app/")
     └─ createTray()
```

### 3.5 一次 chttp 请求的处理流程

```
Renderer fetch("/api/plugins/hello/greet?name=a")
 → protocol.handle("chttp")
   1. 解析 URL：host 必须是 app，否则返回 404
   2. 带有 Origin 头且不等于 chttp://app → 返回 403
   3. path 以 /api/ 开头 → Router.dispatch
        a. 按路径匹配；没有匹配 → {code:3007}
        b. 路径匹配但方法不匹配 → {code:3008}
        c. Content-Length 超过上限 → {code:3009}
        d. JSON 路由：执行 handler → 返回值包装为 {code:0,msg:"success",data}
           抛出 ApiError → {code,msg,data:""}；其他异常 → {code:30004}
        e. SSE 路由：立即返回流式响应，handler 异步向流中写入
   4. 其他路径 → Static（生产读 asar，开发代理 dev server）
```

### 3.6 关闭窗口时序（不记录选择）

```
用户点击自绘标题栏的关闭按钮 → window.app.window.close()
 → 主进程 win.close() → 触发 'close' 事件
     ├─ 已标记退出(quitting) 或 页面未注册关闭监听 → 放行 → 窗口销毁 → 应用退出
     └─ 否则 preventDefault → 推送 window:close-requested
          → 前端弹窗："最小化到托盘 / 退出 / 取消"（每次都询问，不记住选择）
              ├─ 托盘 → window.app.window.closeAction('tray') → win.hide()
              ├─ 退出 → window.app.window.closeAction('quit') → quitting=true → app.quit()
              └─ 取消 → 不做任何事
托盘菜单"退出"、系统关机 → before-quit → quitting=true → 直接退出
渲染进程崩溃或页面重新加载 → 关闭监听标记重置为"未注册"（保证总能关掉窗口）
```

### 3.7 构建与打包流水线

```
npm start
 ├─ tsx scripts/build-plugins.ts      → .plugins/<name>/index.js（开发用）
 └─ electron-forge start              → Vite 构建 main/preload，启动 renderer dev server

npm run make
 ├─ electron-forge package
 │    ├─ Vite 构建 → .vite/build/{main,preload}.js、.vite/renderer/main_window/
 │    ├─ 钩子 packageAfterCopy → 把插件构建到 <staging>/plugins/
 │    ├─ 打包为 app.asar；Fuses 插件写入熔断配置并启用 asar 完整性校验
 │    └─ windowsSign → 签名钩子签 exe/dll（未配置签名时跳过）
 └─ MakerInno → 生成参数 → ISCC.exe → *_setup.exe（安装/卸载程序同样经签名钩子签名）
```

### 3.8 目录结构

```
my-app/
├── forge.config.ts
├── forge/
│   └── maker-inno.ts               # 自定义 Inno Setup maker
├── installer/
│   └── app.iss                     # Inno 脚本
├── scripts/
│   ├── build-plugins.ts            # 插件构建与隔离检查
│   ├── sign-hook.cjs               # 统一签名钩子（后端待定）
│   └── sign-cli.cjs                # 给 Inno SignTool 调用的命令行入口
├── vite.main.config.ts
├── vite.preload.config.ts
├── vite.renderer.config.ts
├── tsconfig.json
├── index.html                      # renderer 入口（Forge Vite 模板约定）
├── assets/
│   ├── icon.ico                    # exe 与安装包图标
│   └── tray.ico                    # 托盘图标
├── src/
│   ├── main/
│   │   ├── index.ts
│   │   ├── security.ts
│   │   ├── window.ts
│   │   ├── tray.ts
│   │   ├── ipc.ts
│   │   ├── logger.ts
│   │   ├── chttp/
│   │   │   ├── scheme.ts
│   │   │   ├── router.ts
│   │   │   ├── sse.ts
│   │   │   └── static.ts
│   │   ├── routes/
│   │   │   ├── system.ts
│   │   │   └── tasks.ts
│   │   ├── plugins/
│   │   │   └── loader.ts
│   │   └── tasks/
│   │       └── auto-import.ts
│   ├── preload/
│   │   └── index.ts
│   ├── renderer/
│   │   ├── main.ts
│   │   ├── api.ts                  # HTTP / SSE 客户端
│   │   └── global.d.ts             # window.app 类型声明
│   ├── shared/
│   │   ├── api.ts                  # 返回格式、错误码、ApiError
│   │   └── ipc.ts                  # IPC 契约
│   └── sdk/
│       └── index.ts                # 插件 SDK
├── plugins/
│   └── hello/
│       └── index.ts                # 示例插件
└── tests/
    ├── unit/
    └── e2e/
```

`.gitignore` 至少包含：`node_modules/`、`.vite/`、`out/`、`.plugins/`。

---

## 4. 功能需求

> 编号格式 `FR-<模块>-<序号>`。每条需求都要有对应的自动化测试，或在第 9 节中有手工验收项。

### 4.1 工程（BLD）

| 编号 | 需求 |
|------|------|
| FR-BLD-1 | 用 `npm init electron-app@latest <name> -- --template=vite-typescript` 初始化，再按 3.8 调整目录 |
| FR-BLD-2 | 提供脚本：`start`、`package`、`make`、`lint`、`typecheck`、`test`、`test:e2e` |
| FR-BLD-3 | `tsc --noEmit` 零错误，ESLint 零错误 |
| FR-BLD-4 | 路径别名 `@shared/*` → `src/shared/*`，`@app/sdk` → `src/sdk/index.ts`，tsconfig 与 Vite 配置保持一致 |
| FR-BLD-5 | 只允许构建 win32 x64；在其他平台或架构上执行 `make` 时给出明确报错 |

### 4.2 chttp 协议（PRT）

| 编号 | 需求 |
|------|------|
| FR-PRT-1 | ready 之前注册特权协议 `chttp`：`standard`、`secure`、`supportFetchAPI`、`stream`、`corsEnabled` |
| FR-PRT-2 | ready 之后用 `protocol.handle` 处理；主机名不是 `app` 时返回 HTTP 404 |
| FR-PRT-3 | 请求带有 `Origin` 头且值不为 `chttp://app` 时返回 HTTP 403 |
| FR-PRT-4 | 路径为 `/api` 或以 `/api/` 开头时交给 Router，其余交给 Static |
| FR-PRT-5 | Static（生产）：根目录为 asar 内的 renderer 输出目录；按扩展名设置 `Content-Type`（见 5.5） |
| FR-PRT-6 | Static（生产）：路径解码后必须仍在根目录内，否则返回 403；路径解码失败返回 400 |
| FR-PRT-7 | Static（生产）：文件不存在且路径没有扩展名时，返回 `index.html`（SPA 回落）；有扩展名则返回 404 |
| FR-PRT-8 | Static（生产）：`index.html` 带 `Cache-Control: no-cache`；所有静态响应带 CSP（见 6.1） |
| FR-PRT-9 | Static（开发）：把请求转发到 Vite dev server，页面 origin 始终为 `chttp://app`；HMR 通过 `ws://localhost:<port>` 直连 dev server |

### 4.3 路由（RTE）

| 编号 | 需求 |
|------|------|
| FR-RTE-1 | 支持 GET/POST/PUT/PATCH/DELETE；支持路径参数 `:name`；query 用 `URLSearchParams` 提供 |
| FR-RTE-2 | 请求对象提供：`method`、`path`、`params`、`query`、`headers`、`json()`、`text()`、`signal` |
| FR-RTE-3 | JSON 路由的 handler 返回任意可序列化的值，框架包装为 `{code:0,msg:"success",data}`；返回 `undefined` 时 `data` 为 `null` |
| FR-RTE-4 | handler 也可以直接返回 `Response`，框架原样透传（用于文件、二进制等场景） |
| FR-RTE-5 | 业务错误通过 `throw new ApiError(code, msg)` 表达；其他异常统一为 30004，生产环境下 `msg` 不包含堆栈 |
| FR-RTE-6 | `/api` 下的所有 JSON 响应 HTTP 状态码固定为 200，成败只看 `code` |
| FR-RTE-7 | 同一方法加同一路径重复注册时抛错：内置路由重复导致启动失败，插件路由重复导致该插件加载失败 |
| FR-RTE-8 | 请求体上限默认 10 MB（可配置），超过返回 3009 |
| FR-RTE-9 | `router.scope(prefix)` 返回一个子路由器，注册的路由自动加上前缀；`removeScope(prefix)` 删除该前缀下的全部路由 |

### 4.4 SSE（SSE）

| 编号 | 需求 |
|------|------|
| FR-SSE-1 | 通过 `router.sse(path, handler, method = 'GET')` 注册；响应头为 `Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache` |
| FR-SSE-2 | `sse.send(data, { event?, id?, retry? })`：字符串原样输出，其他值 JSON 序列化；包含多行的数据拆成多条 `data:` 行 |
| FR-SSE-3 | 标准事件名：`progress`（进度）、`complete`（完成）、`error`（错误，data 为 `{code,msg}`）；未指定时为默认的 `message` |
| FR-SSE-4 | handler 抛出异常时，自动发送 `error` 事件并关闭流 |
| FR-SSE-5 | 客户端断开时，`sse.isClosed` 变为 `true`，触发 `onClose` 回调，同时 `req.signal` 被中止 |
| FR-SSE-6 | 每 15 秒发送一次心跳注释 `: ping`（可配置，0 表示关闭）；流关闭时清理定时器 |
| FR-SSE-7 | handler 负责调用 `sse.close()` 结束流；不调用时连接保持，用于长时间推送 |

### 4.5 插件（PLG）

| 编号 | 需求 |
|------|------|
| FR-PLG-1 | 插件源码放在 `plugins/<name>/index.ts`，`<name>` 必须匹配 `^[a-z][a-z0-9-]*$` |
| FR-PLG-2 | 插件只能导入 `@app/sdk`、`electron`、Node 内置模块和 npm 包；**禁止导入其他插件或 `src/` 下的任何内部模块**，违反时构建失败 |
| FR-PLG-3 | 每个插件打包为单个 CJS 文件；打包时放在 `app.asar/plugins/<name>/index.js`，开发时放在 `.plugins/<name>/index.js` |
| FR-PLG-4 | 插件以 `export default definePlugin({ name, version, setup, dispose? })` 导出，且 `name` 必须与目录名一致 |
| FR-PLG-5 | 启动时按目录名排序依次加载；插件只拿到挂载在 `/api/plugins/<name>` 下的子路由器和 `ctx` |
| FR-PLG-6 | 插件加载或 `setup` 失败时，删除它已注册的路由并记录状态，应用和其他插件照常运行 |
| FR-PLG-7 | `ctx` 只包含：`name`、`logger`（输出带插件名前缀）、`app`（`version`、`isPackaged`）；不提供其他插件的引用 |
| FR-PLG-8 | `GET /api/plugins` 返回 `[{ name, version, status: 'loaded' \| 'failed', error? }]` |
| FR-PLG-9 | 应用退出前，对已加载的插件调用 `dispose()`（如果插件提供了该方法），并对它做超时保护 |

> 可信性说明：插件位于 `app.asar` 内，受 Fuses 开启的 asar 完整性校验保护。虽然是按用户安装（目录可写），但篡改插件会导致应用无法启动，不会出现被静默加载的情况。

### 4.6 窗口与托盘（WIN）

| 编号 | 需求 |
|------|------|
| FR-WIN-1 | 单实例：第二次启动时，恢复（如已最小化）、显示并聚焦主窗口，然后退出第二个进程 |
| FR-WIN-2 | 无边框窗口（`frame: false`、`titleBarStyle: 'hidden'`），标题栏由前端用 `-webkit-app-region: drag` 自绘 |
| FR-WIN-3 | 初始尺寸 1080×720，屏幕工作区宽度大于 1800 时为工作区的 50%×80%；最小尺寸 960×640；居中显示；**不记住尺寸和位置** |
| FR-WIN-4 | `ready-to-show` 之后才显示窗口，避免白屏闪烁 |
| FR-WIN-5 | 关闭流程按 3.6 执行，**不记录**用户的选择 |
| FR-WIN-6 | 托盘：提示文字为 productName；单击显示主窗口；右键菜单为"显示主窗口""退出" |
| FR-WIN-7 | 最大化状态变化时推送 `window:maximize-changed`；系统深色模式变化时推送 `theme:changed` |
| FR-WIN-8 | 右键菜单：复制、全选；在可编辑区域额外提供剪切、粘贴 |

### 4.7 IPC（IPC）

| 编号 | 需求 |
|------|------|
| FR-IPC-1 | 所有通道在 `src/shared/ipc.ts` 中定义并带有类型，main 与 preload 共用 |
| FR-IPC-2 | 只开放第 5.6 节列出的通道；preload 不提供通用的 `send`、`on`、`invoke` |
| FR-IPC-3 | 主进程对每个调用校验 `event.senderFrame.url` 是否以 `chttp://app/` 开头，不是则拒绝 |
| FR-IPC-4 | `openExternal` 只接受 `http:` 和 `https:`，其他协议直接拒绝 |
| FR-IPC-5 | `toggleDevTools` 只在未打包（开发）时生效 |

### 4.8 AutoImport 定时任务（TSK）

| 编号 | 需求 |
|------|------|
| FR-TSK-1 | 任务结构为 `{ id: string; intervalSec: number; data: unknown }`；`id` 不能为空且不能重复，`intervalSec` 为不小于 10 的整数，否则返回 3006 |
| FR-TSK-2 | `PUT /api/tasks` 提交**完整**任务列表：列表外的任务删除，新任务创建，已有任务更新 |
| FR-TSK-3 | 间隔不变的任务只更新 `data`，不重新计时；间隔改变的任务重新计时 |
| FR-TSK-4 | `GET /api/tasks` 返回 `[{ id, intervalSec, nextRunAt }]`，`nextRunAt` 为毫秒时间戳 |
| FR-TSK-5 | 任务到期时推送 `auto-import:tick`，载荷为 `{ id, data, nextRunAt }`；窗口隐藏时照常推送 |
| FR-TSK-6 | 任务只保存在内存中，应用重启后由前端重新提交 |

### 4.9 日志（LOG）

| 编号 | 需求 |
|------|------|
| FR-LOG-1 | 日志只输出到控制台，分 `debug`、`info`、`warn`、`error` 四级；打包后默认级别为 `info` |
| FR-LOG-2 | 不启用 `crashReporter`，不写任何日志文件 |

---

## 5. 接口约定

### 5.1 返回格式

```jsonc
// 成功
{ "code": 0, "msg": "success", "data": { /* 任意 */ } }
// 失败
{ "code": 3006, "msg": "name is required", "data": "" }
```

### 5.2 错误码

| code | 含义 |
|------|------|
| 0 | 成功 |
| 10001 | 通用业务错误（未指定具体 code） |
| 3006 | 参数缺失或校验失败 |
| 3007 | 接口不存在 |
| 3008 | 请求方法不允许 |
| 3009 | 请求体过大 |
| 30004 | 服务内部异常 |
| 30005 | 请求体 JSON 解析失败 |
| 40000–49999 | 插件自定义（每个插件在自己的 README 中说明） |

### 5.3 SSE 帧格式

```
event: progress
data: {"i":1,"total":5}

event: complete
data: {"done":true}

event: error
data: {"code":30004,"msg":"..."}

: ping
```

### 5.4 内置接口

| 方法 | 路径 | 请求 | 响应 `data` |
|------|------|------|-------------|
| GET | `/api/ping` | — | `{ pong: true, time: number }` |
| GET | `/api/plugins` | — | `PluginStatus[]` |
| GET | `/api/tasks` | — | `TaskState[]` |
| PUT | `/api/tasks` | `{ tasks: TaskInput[] }` | `TaskState[]` |

### 5.5 静态资源 MIME

`.html` text/html · `.js`/`.mjs` text/javascript · `.css` text/css · `.json`/`.map` application/json · `.svg` image/svg+xml · `.png` image/png · `.jpg`/`.jpeg` image/jpeg · `.webp` image/webp · `.gif` image/gif · `.ico` image/x-icon · `.woff` font/woff · `.woff2` font/woff2 · `.ttf` font/ttf · `.wasm` application/wasm · `.txt` text/plain · 其他 application/octet-stream

### 5.6 `window.app` 桥接

| 方法 / 事件 | 通道 | 说明 |
|-------------|------|------|
| `info(): Promise<AppInfo>` | `app:info` | 返回 `{ name, version, electron, chrome, node, arch, locale, isDark, isPackaged }` |
| `openExternal(url)` | `app:open-external` | 只允许 http/https |
| `toggleDevTools()` | `app:toggle-devtools` | 仅开发模式生效 |
| `window.minimize()` | `window:minimize` | |
| `window.toggleMaximize()` | `window:toggle-maximize` | |
| `window.close()` | `window:close` | 进入关闭流程 |
| `window.closeAction('tray' \| 'quit')` | `window:close-action` | 响应关闭询问 |
| `window.onCloseRequested(cb) → 取消函数` | 事件 `window:close-requested` | 注册即视为页面接管关闭；调用取消函数后不再接管 |
| `window.onMaximizeChanged(cb)` | 事件 `window:maximize-changed` | |
| `onThemeChanged(cb)` | 事件 `theme:changed` | |
| `onAutoImport(cb)` | 事件 `auto-import:tick` | |

---

## 6. 非功能需求

### 6.1 安全（SEC）

| 编号 | 要求 |
|------|------|
| SEC-1 | 启动时调用 `app.enableSandbox()`；窗口设置 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true` |
| SEC-2 | 证书正常校验；不全局注入 CORS 头；不修改请求头 |
| SEC-3 | 拒绝所有权限请求和权限检查（摄像头、通知、地理位置等），需要时按白名单逐项放开 |
| SEC-4 | 禁止页面导航到 `chttp://app/` 之外的地址；`window.open` 一律拒绝，其中 http/https 链接交给系统浏览器打开；禁止 `<webview>` |
| SEC-5 | 生产环境 CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'` |
| SEC-6 | Fuses：`RunAsNode=false`、`EnableCookieEncryption=true`、`EnableNodeOptionsEnvironmentVariable=false`、`EnableNodeCliInspectArguments=false`、`EnableEmbeddedAsarIntegrityValidation=true`、`OnlyLoadAppFromAsar=true` |
| SEC-7 | CI 执行 `npm audit --omit=dev --audit-level=high` |

> 第三方接口：由于 CSP 中 `connect-src 'self'`，并且不放开 CORS，前端不能直接请求外部地址；需要访问外部服务时，在主进程路由或插件中实现，再通过 `/api` 提供给前端。

### 6.2 性能

| 编号 | 指标 |
|------|------|
| PERF-1 | 冷启动到窗口显示 ≤ 2 秒（基准机器在 M1 确定） |
| PERF-2 | `GET /api/ping` 往返耗时 P95 ≤ 5 毫秒 |
| PERF-3 | 单条 SSE 连续推送 10 分钟（每秒 10 条），主进程内存无持续增长 |
| PERF-4 | 安装包体积 ≤ 120 MB |

### 6.3 质量

| 编号 | 要求 |
|------|------|
| QA-1 | 单元测试覆盖：Router（匹配、scope、冲突、错误包装、体积限制）、SSE 编码与关闭、静态路径越界、AutoImport（使用假定时器）、插件加载（成功、失败、名称不一致），覆盖率 ≥ 80% |
| QA-2 | E2E：启动应用 → 首页加载 → `/api/ping` → 示例插件的 JSON 与 SSE 接口 → 窗口最小化/最大化 → 关闭流程 |
| QA-3 | CI（GitHub Actions `windows-latest`）：`npm ci` → lint → typecheck → test → make；未预装 Inno Setup 时先执行 `choco install innosetup -y` |

---

## 7. 打包与签名

### 7.1 安装包规格

| 项 | 值 |
|----|----|
| 格式 | Inno Setup 6，单个 `.exe` 安装程序 |
| 安装模式 | 按用户安装：`PrivilegesRequired=lowest`，默认目录 `%LOCALAPPDATA%\Programs\<AppName>`，不需要管理员权限 |
| 架构 | 仅 x64（`x64compatible`） |
| 升级 | `AppId` 固定为一个 GUID（生成一次后**永不修改**），覆盖安装；安装前自动关闭正在运行的应用 |
| 快捷方式 | 开始菜单；桌面快捷方式可选，默认不勾选 |
| 卸载 | 删除安装目录和 `%APPDATA%\<AppName>`（Chromium 缓存） |
| 产物命名 | `<productName>_x64_<version>_setup.exe` |
| 构建机 | Windows，安装 Inno Setup 6；可用环境变量 `ISCC_PATH` 指定 ISCC 路径 |

### 7.2 签名方案

**签名后端待定。** 自 2023 年 6 月起，代码签名证书的私钥必须存放在硬件或云端 HSM 中，不能以 `.pfx` 文件放在构建机上。因此先实现统一的签名接入点，后端确定后只需改一个文件。

| 项 | 规定 |
|----|------|
| 唯一入口 | `scripts/sign-hook.cjs` 导出 `async function sign(filePath)` |
| 调用方 1 | Forge 的 `packagerConfig.windowsSign.hookModulePath`：签名主程序 exe 和其他 PE 文件 |
| 调用方 2 | Inno 的 `SignTool` 指令经 `scripts/sign-cli.cjs` 调用：签名安装程序和卸载程序 |
| 签名要求 | Authenticode SHA-256，加 RFC 3161 时间戳；签名后执行 `signtool verify /pa`，失败即构建失败 |
| 开关 | 设置环境变量 `WIN_SIGN_BACKEND` 时启用签名；未设置时跳过，并对每个文件输出警告 |
| 凭据 | 只从 CI 密钥或环境变量读取，禁止提交到仓库 |
| 可选后端 | 自建远程签名服务；Azure Trusted Signing；云 HSM 托管的 OV/EV 证书（DigiCert KeyLocker、SSL.com eSigner 等） |

---

## 8. 示例实现

> 以下代码组成一个可以运行的最小工程。实现时按第 4 节的需求补全测试和边界处理。

### 8.1 package.json（节选）

```json
{
  "name": "my-app",
  "productName": "My App",
  "version": "1.0.0",
  "main": ".vite/build/main.js",
  "scripts": {
    "build:plugins": "tsx scripts/build-plugins.ts",
    "start": "npm run build:plugins && electron-forge start",
    "package": "electron-forge package --platform=win32 --arch=x64",
    "make": "electron-forge make --platform=win32 --arch=x64",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:e2e": "playwright test"
  },
  "dependencies": {},
  "devDependencies": {
    "electron": "<立项时最新稳定版的精确版本>",
    "@electron-forge/cli": "^7",
    "@electron-forge/maker-base": "^7",
    "@electron-forge/plugin-vite": "^7",
    "@electron-forge/plugin-fuses": "^7",
    "@electron-forge/shared-types": "^7",
    "@electron/fuses": "^1",
    "vite": "^5",
    "esbuild": "^0.24",
    "typescript": "^5",
    "tsx": "^4",
    "vitest": "^2",
    "@playwright/test": "^1",
    "eslint": "^9",
    "typescript-eslint": "^8",
    "prettier": "^3"
  }
}
```

> 上表中依赖的主版本号只是示意，以初始化模板生成的版本为准，再统一锁定。

### 8.2 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["src/shared/*"],
      "@app/sdk": ["src/sdk/index.ts"]
    },
    "types": ["node"]
  },
  "include": ["src", "plugins", "scripts", "forge", "tests", "*.ts"]
}
```

### 8.3 Vite 配置

```ts
// vite.main.config.ts（preload 配置与此相同）
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@app/sdk': path.resolve(__dirname, 'src/sdk/index.ts'),
    },
  },
});
```

```ts
// vite.renderer.config.ts
import path from 'node:path';
import { defineConfig } from 'vite';

const DEV_PORT = 5173;

export default defineConfig({
  resolve: { alias: { '@shared': path.resolve(__dirname, 'src/shared') } },
  server: {
    port: DEV_PORT,
    strictPort: true,
    // 页面 origin 是 chttp://app，需要显式指定 HMR 的连接地址
    hmr: { protocol: 'ws', host: 'localhost', clientPort: DEV_PORT },
  },
});
```

### 8.4 forge.config.ts

```ts
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { MakerInno } from './forge/maker-inno';
import { buildPlugins } from './scripts/build-plugins';

const signEnabled = Boolean(process.env.WIN_SIGN_BACKEND);

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: 'my-app',
    icon: 'assets/icon', // Windows 自动使用 icon.ico
    extraResource: ['assets/tray.ico'],
    ...(signEnabled
      ? { windowsSign: { hookModulePath: path.resolve(__dirname, 'scripts/sign-hook.cjs') } }
      : {}),
  },
  hooks: {
    // 把插件构建到待打包目录中，随后一起进入 app.asar
    packageAfterCopy: async (_config, buildPath) => {
      await buildPlugins(path.join(buildPath, 'plugins'));
    },
  },
  makers: [
    new MakerInno({
      script: path.resolve(__dirname, 'installer/app.iss'),
      exeName: 'my-app.exe',
      iconFile: path.resolve(__dirname, 'assets/icon.ico'),
      publisher: 'Your Company',
      signCommand: signEnabled
        ? `$qnode$q $q${path.resolve(__dirname, 'scripts/sign-cli.cjs')}$q $f`
        : undefined,
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
```

### 8.5 共享定义

```ts
// src/shared/api.ts
export const Codes = {
  OK: 0,
  BUSINESS: 10001,
  PARAM_INVALID: 3006,
  NOT_FOUND: 3007,
  METHOD_NOT_ALLOWED: 3008,
  PAYLOAD_TOO_LARGE: 3009,
  INTERNAL: 30004,
  JSON_PARSE: 30005,
} as const;

export interface ApiResult<T = unknown> {
  code: number;
  msg: string;
  data: T | '';
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/** 插件是独立打包的，各自带一份 ApiError，因此不能用 instanceof 判断，改按字段识别 */
export function isApiError(e: unknown): e is ApiError {
  return (
    typeof e === 'object' && e !== null &&
    (e as { name?: unknown }).name === 'ApiError' &&
    typeof (e as { code?: unknown }).code === 'number'
  );
}

export const ok = <T>(data: T): ApiResult<T> => ({ code: Codes.OK, msg: 'success', data });
export const fail = (code: number, msg: string): ApiResult<never> => ({ code, msg, data: '' });

export interface TaskInput { id: string; intervalSec: number; data: unknown }
export interface TaskState { id: string; intervalSec: number; nextRunAt: number }
export interface TaskTick { id: string; data: unknown; nextRunAt: number }
export interface PluginStatus { name: string; version?: string; status: 'loaded' | 'failed'; error?: string }
```

```ts
// src/shared/ipc.ts
import type { TaskTick } from './api';

export const ORIGIN = 'chttp://app';
export type CloseAction = 'tray' | 'quit';

export interface AppInfo {
  name: string; version: string; electron: string; chrome: string; node: string;
  arch: string; locale: string; isDark: boolean; isPackaged: boolean;
}

/** renderer → main（invoke） */
export interface InvokeChannels {
  'app:info': { args: []; result: AppInfo };
  'app:open-external': { args: [url: string]; result: void };
  'app:toggle-devtools': { args: []; result: void };
  'window:minimize': { args: []; result: void };
  'window:toggle-maximize': { args: []; result: void };
  'window:close': { args: []; result: void };
  'window:close-action': { args: [action: CloseAction]; result: void };
}

/** renderer → main（send，无返回值） */
export interface SendChannels {
  'window:close-handler': [registered: boolean];
}

/** main → renderer（事件） */
export interface EventChannels {
  'window:close-requested': [];
  'window:maximize-changed': [maximized: boolean];
  'theme:changed': [isDark: boolean];
  'auto-import:tick': [tick: TaskTick];
}

export type Unsubscribe = () => void;

export interface AppBridge {
  info(): Promise<AppInfo>;
  openExternal(url: string): Promise<void>;
  toggleDevTools(): Promise<void>;
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
    closeAction(action: CloseAction): Promise<void>;
    onCloseRequested(cb: () => void): Unsubscribe;
    onMaximizeChanged(cb: (maximized: boolean) => void): Unsubscribe;
  };
  onThemeChanged(cb: (isDark: boolean) => void): Unsubscribe;
  onAutoImport(cb: (tick: TaskTick) => void): Unsubscribe;
}
```

### 8.6 插件 SDK

```ts
// src/sdk/index.ts —— 插件唯一允许导入的内部模块
export { ApiError, Codes } from '@shared/api';

export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: Headers;
  /** 客户端断开时中止 */
  readonly signal: AbortSignal;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
}

export interface SseSendOptions { event?: string; id?: string; retry?: number }

export interface SseStream {
  readonly isClosed: boolean;
  send(data: unknown, opts?: SseSendOptions): void;
  error(code: number, msg: string): void;
  onClose(cb: () => void): void;
  close(): void;
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type JsonHandler = (req: ApiRequest) => unknown;
export type SseHandler = (req: ApiRequest, sse: SseStream) => void | Promise<void>;

export interface RouteRegistrar {
  get(path: string, h: JsonHandler): void;
  post(path: string, h: JsonHandler): void;
  put(path: string, h: JsonHandler): void;
  patch(path: string, h: JsonHandler): void;
  delete(path: string, h: JsonHandler): void;
  sse(path: string, h: SseHandler, method?: Method): void;
}

export interface Logger {
  debug(...a: unknown[]): void; info(...a: unknown[]): void;
  warn(...a: unknown[]): void; error(...a: unknown[]): void;
}

export interface PluginContext {
  readonly name: string;
  readonly logger: Logger;
  readonly app: { readonly version: string; readonly isPackaged: boolean };
}

export interface PluginDefinition {
  name: string;
  version: string;
  setup(router: RouteRegistrar, ctx: PluginContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export const definePlugin = (def: PluginDefinition): PluginDefinition => def;
```

### 8.7 chttp 协议层

```ts
// src/main/chttp/scheme.ts
import { protocol } from 'electron';
import { ORIGIN } from '@shared/ipc';
import type { Router } from './router';

export const SCHEME = 'chttp';
export const HOST = 'app';

/** 必须在 app ready 之前调用 */
export function registerChttpScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ]);
}

export type StaticHandler = (req: Request, url: URL) => Promise<Response>;

export function handleChttp(router: Router, serveStatic: StaticHandler): void {
  protocol.handle(SCHEME, async (req) => {
    const url = new URL(req.url);
    if (url.host !== HOST) return new Response('Not Found', { status: 404 });

    const origin = req.headers.get('origin');
    if (origin && origin !== ORIGIN) return new Response('Forbidden', { status: 403 });

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return router.dispatch(req, url);
    }
    return serveStatic(req, url);
  });
}
```

```ts
// src/main/chttp/router.ts
import { Codes, fail, isApiError, ok } from '@shared/api';
import type { ApiRequest, JsonHandler, Method, RouteRegistrar, SseHandler } from '@app/sdk';
import { SseStreamImpl } from './sse';
import { logger } from '../logger';

interface Route {
  method: Method;
  path: string;
  pattern: RegExp;
  keys: string[];
  kind: 'json' | 'sse';
  handler: JsonHandler | SseHandler;
}

export interface RouterOptions { maxBodyBytes: number; exposeErrors: boolean; heartbeatMs: number }

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { pattern: new RegExp(`^${source}/?$`), keys };
}

export class Router implements RouteRegistrar {
  constructor(
    private readonly options: RouterOptions = { maxBodyBytes: 10 * 1024 * 1024, exposeErrors: false, heartbeatMs: 15_000 },
    private readonly table: Route[] = [],
    private readonly prefix = '',
  ) {}

  get(p: string, h: JsonHandler) { this.add('GET', p, 'json', h); }
  post(p: string, h: JsonHandler) { this.add('POST', p, 'json', h); }
  put(p: string, h: JsonHandler) { this.add('PUT', p, 'json', h); }
  patch(p: string, h: JsonHandler) { this.add('PATCH', p, 'json', h); }
  delete(p: string, h: JsonHandler) { this.add('DELETE', p, 'json', h); }
  sse(p: string, h: SseHandler, method: Method = 'GET') { this.add(method, p, 'sse', h); }

  /** 返回共享同一路由表的子路由器 */
  scope(prefix: string): Router {
    return new Router(this.options, this.table, this.prefix + prefix);
  }

  removeScope(prefix: string): void {
    for (let i = this.table.length - 1; i >= 0; i--) {
      const r = this.table[i]!;
      if (r.path === prefix || r.path.startsWith(prefix + '/')) this.table.splice(i, 1);
    }
  }

  private add(method: Method, path: string, kind: Route['kind'], handler: Route['handler']): void {
    const full = this.prefix + path;
    if (this.table.some((r) => r.method === method && r.path === full)) {
      throw new Error(`duplicate route: ${method} ${full}`);
    }
    this.table.push({ method, path: full, kind, handler, ...compile(full) });
  }

  async dispatch(req: Request, url: URL): Promise<Response> {
    let matchedPath = false;
    for (const route of this.table) {
      const m = route.pattern.exec(url.pathname);
      if (!m) continue;
      matchedPath = true;
      if (route.method !== req.method) continue;

      const length = Number(req.headers.get('content-length') ?? 0);
      if (length > this.options.maxBodyBytes) return json(fail(Codes.PAYLOAD_TOO_LARGE, 'payload too large'));

      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1] ?? ''); });
      const apiReq = this.toApiRequest(req, url, params);

      return route.kind === 'sse'
        ? this.runSse(route.handler as SseHandler, apiReq)
        : this.runJson(route.handler as JsonHandler, apiReq);
    }
    return matchedPath
      ? json(fail(Codes.METHOD_NOT_ALLOWED, `method ${req.method} not allowed`))
      : json(fail(Codes.NOT_FOUND, `api ${url.pathname} not found`));
  }

  private toApiRequest(req: Request, url: URL, params: Record<string, string>): ApiRequest & { abort(): void } {
    const controller = new AbortController();
    const max = this.options.maxBodyBytes;
    const readText = async (): Promise<string> => {
      const text = await req.text();
      if (Buffer.byteLength(text) > max) throw Object.assign(new Error('payload too large'), { name: 'ApiError', code: Codes.PAYLOAD_TOO_LARGE });
      return text;
    };
    return {
      method: req.method,
      path: url.pathname,
      params,
      query: url.searchParams,
      headers: req.headers,
      signal: controller.signal,
      abort: () => controller.abort(),
      text: readText,
      json: async <T>() => {
        const text = await readText();
        try {
          return (text ? JSON.parse(text) : undefined) as T;
        } catch (e) {
          throw Object.assign(new Error(`json parse error: ${(e as Error).message}`), { name: 'ApiError', code: Codes.JSON_PARSE });
        }
      },
    };
  }

  private toFailure(e: unknown) {
    if (isApiError(e)) return fail(e.code, e.message);
    logger.error('[api] unhandled error', e);
    return fail(Codes.INTERNAL, this.options.exposeErrors ? String(e) : 'internal error');
  }

  private async runJson(handler: JsonHandler, req: ApiRequest): Promise<Response> {
    try {
      const result = await handler(req);
      if (result instanceof Response) return result;
      return json(ok(result === undefined ? null : result));
    } catch (e) {
      return json(this.toFailure(e));
    }
  }

  private runSse(handler: SseHandler, req: ApiRequest & { abort(): void }): Response {
    const sse = new SseStreamImpl(this.options.heartbeatMs);
    sse.onClose(() => req.abort());
    void (async () => {
      try {
        await handler(req, sse);
      } catch (e) {
        const f = this.toFailure(e);
        sse.error(f.code, f.msg);
      }
    })();
    return new Response(sse.body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  }
}
```

```ts
// src/main/chttp/sse.ts
import type { SseSendOptions, SseStream } from '@app/sdk';

const encoder = new TextEncoder();

export class SseStreamImpl implements SseStream {
  readonly body: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private closed = false;
  private readonly closeCallbacks: Array<() => void> = [];
  private readonly heartbeat?: NodeJS.Timeout;

  constructor(heartbeatMs: number) {
    this.body = new ReadableStream<Uint8Array>({
      start: (c) => { this.controller = c; },
      cancel: () => this.finish(), // 客户端断开
    });
    if (heartbeatMs > 0) this.heartbeat = setInterval(() => this.write(': ping\n\n'), heartbeatMs);
  }

  get isClosed(): boolean { return this.closed; }

  send(data: unknown, opts: SseSendOptions = {}): void {
    const lines: string[] = [];
    if (opts.event) lines.push(`event: ${opts.event}`);
    if (opts.id) lines.push(`id: ${opts.id}`);
    if (opts.retry !== undefined) lines.push(`retry: ${opts.retry}`);
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    for (const line of text.split(/\r?\n/)) lines.push(`data: ${line}`);
    this.write(lines.join('\n') + '\n\n');
  }

  error(code: number, msg: string): void {
    this.send({ code, msg }, { event: 'error' });
    this.close();
  }

  onClose(cb: () => void): void {
    if (this.closed) cb();
    else this.closeCallbacks.push(cb);
  }

  close(): void {
    if (this.closed) return;
    try { this.controller.close(); } catch { /* 已被取消 */ }
    this.finish();
  }

  private write(chunk: string): void {
    if (this.closed) return;
    try { this.controller.enqueue(encoder.encode(chunk)); } catch { this.finish(); }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const cb of this.closeCallbacks.splice(0)) {
      try { cb(); } catch { /* 忽略回调异常 */ }
    }
  }
}
```

```ts
// src/main/chttp/static.ts
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { net } from 'electron';
import type { StaticHandler } from './scheme';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
};

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

export function createStaticHandler(opts: { root: string; devServerUrl?: string }): StaticHandler {
  const root = path.resolve(opts.root);

  if (opts.devServerUrl) {
    // 开发：转发到 Vite dev server，SPA 回落由 dev server 处理
    return (req, url) =>
      net.fetch(new URL(url.pathname + url.search, opts.devServerUrl).toString(), {
        method: req.method,
        headers: req.headers,
      });
  }

  return async (_req, url) => {
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    const resolved = path.resolve(root, '.' + rel);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    let file = resolved;
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) {
      if (path.extname(rel)) return new Response('Not Found', { status: 404 });
      file = path.join(root, 'index.html'); // SPA 回落
    }

    const ext = path.extname(file).toLowerCase();
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers({
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
    });
    if (ext === '.html') headers.set('Cache-Control', 'no-cache');
    return new Response(res.body, { status: 200, headers });
  };
}
```

### 8.8 插件加载

```ts
// src/main/plugins/loader.ts
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { app } from 'electron';
import type { PluginDefinition } from '@app/sdk';
import type { PluginStatus } from '@shared/api';
import type { Router } from '../chttp/router';
import { createLogger } from '../logger';

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const loaded: PluginDefinition[] = [];

export function pluginRoot(): string {
  return app.isPackaged
    ? path.join(app.getAppPath(), 'plugins') // …\resources\app.asar\plugins
    : path.join(app.getAppPath(), '.plugins');
}

export async function loadPlugins(router: Router, root = pluginRoot()): Promise<PluginStatus[]> {
  const statuses: PluginStatus[] = [];
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  const names = entries.filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const load = createRequire(__filename);

  for (const name of names) {
    const prefix = `/api/plugins/${name}`;
    try {
      if (!NAME_RE.test(name)) throw new Error(`invalid plugin name: ${name}`);
      const mod = load(path.join(root, name, 'index.js')) as { default?: PluginDefinition };
      const def = mod.default;
      if (!def || def.name !== name || typeof def.setup !== 'function') {
        throw new Error('plugin must default-export definePlugin({ name: <dir name>, ... })');
      }
      await def.setup(router.scope(prefix), {
        name,
        logger: createLogger(`plugin:${name}`),
        app: { version: app.getVersion(), isPackaged: app.isPackaged },
      });
      loaded.push(def);
      statuses.push({ name, version: def.version, status: 'loaded' });
    } catch (e) {
      router.removeScope(prefix);
      statuses.push({ name, status: 'failed', error: String(e) });
      createLogger('plugins').error(`load ${name} failed`, e);
    }
  }
  return statuses;
}

export async function disposePlugins(timeoutMs = 3000): Promise<void> {
  await Promise.all(
    loaded.map((p) =>
      Promise.race([
        Promise.resolve().then(() => p.dispose?.()).catch(() => undefined),
        new Promise((r) => setTimeout(r, timeoutMs)),
      ]),
    ),
  );
}
```

```ts
// scripts/build-plugins.ts —— 构建插件并检查隔离（禁止导入其他插件和 src 内部模块）
import fs from 'node:fs/promises';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { build } from 'esbuild';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'plugins');
const SDK_DIR = path.join(ROOT, 'src', 'sdk');
const SHARED_DIR = path.join(ROOT, 'src', 'shared'); // SDK 重新导出 shared，属于允许范围

export async function buildPlugins(outRoot = path.join(ROOT, '.plugins')): Promise<void> {
  await fs.rm(outRoot, { recursive: true, force: true });
  const dirs = (await fs.readdir(SRC, { withFileTypes: true })).filter((d) => d.isDirectory());

  for (const { name } of dirs) {
    const self = path.join(SRC, name) + path.sep;
    const result = await build({
      entryPoints: [path.join(SRC, name, 'index.ts')],
      outfile: path.join(outRoot, name, 'index.js'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22', // 与所用 Electron 内置的 Node 主版本保持一致
      minify: true,
      metafile: true,
      tsconfig: path.join(ROOT, 'tsconfig.json'),
      external: ['electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    });

    for (const input of Object.keys(result.metafile.inputs)) {
      const abs = path.resolve(ROOT, input);
      const inOtherPlugin = abs.startsWith(SRC + path.sep) && !abs.startsWith(self);
      const inSrcInternal =
        abs.startsWith(path.join(ROOT, 'src') + path.sep) &&
        !abs.startsWith(SDK_DIR + path.sep) &&
        !abs.startsWith(SHARED_DIR + path.sep);
      if (inOtherPlugin || inSrcInternal) {
        throw new Error(`plugin "${name}" must not import ${input} (only @app/sdk is allowed)`);
      }
    }
    console.log(`[plugins] built ${name}`);
  }
}

if (require.main === module) {
  buildPlugins().catch((e) => { console.error(e); process.exit(1); });
}
```

### 8.9 示例插件

```ts
// plugins/hello/index.ts
import { ApiError, Codes, definePlugin } from '@app/sdk';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

export default definePlugin({
  name: 'hello',
  version: '1.0.0',
  setup(router, ctx) {
    // GET chttp://app/api/plugins/hello/greet?name=Tom
    router.get('/greet', (req) => {
      const who = req.query.get('name');
      if (!who) throw new ApiError(Codes.PARAM_INVALID, 'name is required');
      return { message: `hello, ${who}` };
    });

    // POST chttp://app/api/plugins/hello/echo   body: {"text":"hi"}
    router.post('/echo', async (req) => {
      const body = await req.json<{ text?: string }>();
      if (typeof body?.text !== 'string') throw new ApiError(40001, 'text must be a string');
      return { text: body.text, length: body.text.length };
    });

    // GET chttp://app/api/plugins/hello/count?n=5   （SSE）
    router.sse('/count', async (req, sse) => {
      const total = Math.min(Number(req.query.get('n') ?? 5) || 5, 100);
      for (let i = 1; i <= total && !sse.isClosed; i++) {
        sse.send({ i, total }, { event: 'progress', id: String(i) });
        await sleep(500, req.signal);
      }
      if (!sse.isClosed) {
        sse.send({ done: true }, { event: 'complete' });
        sse.close();
      }
    });

    ctx.logger.info('ready');
  },
});
```

### 8.10 内置路由与定时任务

```ts
// src/main/tasks/auto-import.ts
import { ApiError, Codes, type TaskInput, type TaskState, type TaskTick } from '@shared/api';

interface Entry { intervalSec: number; data: unknown; timer: NodeJS.Timeout; nextRunAt: number }

export class AutoImportScheduler {
  private readonly tasks = new Map<string, Entry>();
  constructor(private readonly onTick: (tick: TaskTick) => void, private readonly minIntervalSec = 10) {}

  sync(list: TaskInput[]): TaskState[] {
    this.validate(list);
    const ids = new Set(list.map((t) => t.id));
    for (const id of [...this.tasks.keys()]) if (!ids.has(id)) this.remove(id);

    for (const t of list) {
      const cur = this.tasks.get(t.id);
      if (cur && cur.intervalSec === t.intervalSec) {
        cur.data = t.data; // 间隔不变：只更新数据，不重新计时
        continue;
      }
      if (cur) this.remove(t.id);
      const entry: Entry = {
        intervalSec: t.intervalSec,
        data: t.data,
        nextRunAt: Date.now() + t.intervalSec * 1000,
        timer: setInterval(() => {
          entry.nextRunAt = Date.now() + entry.intervalSec * 1000;
          this.onTick({ id: t.id, data: entry.data, nextRunAt: entry.nextRunAt });
        }, t.intervalSec * 1000),
      };
      this.tasks.set(t.id, entry);
    }
    return this.list();
  }

  list(): TaskState[] {
    return [...this.tasks].map(([id, e]) => ({ id, intervalSec: e.intervalSec, nextRunAt: e.nextRunAt }));
  }

  dispose(): void {
    for (const id of [...this.tasks.keys()]) this.remove(id);
  }

  private remove(id: string): void {
    const e = this.tasks.get(id);
    if (e) clearInterval(e.timer);
    this.tasks.delete(id);
  }

  private validate(list: unknown): asserts list is TaskInput[] {
    if (!Array.isArray(list)) throw new ApiError(Codes.PARAM_INVALID, 'tasks must be an array');
    const seen = new Set<string>();
    for (const t of list as Partial<TaskInput>[]) {
      if (typeof t?.id !== 'string' || !t.id) throw new ApiError(Codes.PARAM_INVALID, 'task.id is required');
      if (seen.has(t.id)) throw new ApiError(Codes.PARAM_INVALID, `duplicate task id: ${t.id}`);
      if (!Number.isInteger(t.intervalSec) || (t.intervalSec as number) < this.minIntervalSec) {
        throw new ApiError(Codes.PARAM_INVALID, `task.intervalSec must be an integer >= ${this.minIntervalSec}`);
      }
      seen.add(t.id);
    }
  }
}
```

```ts
// src/main/routes/system.ts
import type { Router } from '../chttp/router';
export function registerSystemRoutes(router: Router): void {
  router.get('/api/ping', () => ({ pong: true, time: Date.now() }));
}

// src/main/routes/tasks.ts
import type { TaskInput } from '@shared/api';
import type { Router } from '../chttp/router';
import type { AutoImportScheduler } from '../tasks/auto-import';
export function registerTaskRoutes(router: Router, scheduler: AutoImportScheduler): void {
  router.get('/api/tasks', () => scheduler.list());
  router.put('/api/tasks', async (req) => {
    const body = await req.json<{ tasks?: TaskInput[] }>();
    return scheduler.sync(body?.tasks as TaskInput[]);
  });
}
```

### 8.11 主进程入口、安全、窗口、托盘、IPC

```ts
// src/main/logger.ts —— 只输出到控制台
import type { Logger } from '@app/sdk';
import { app } from 'electron';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const min = LEVELS.indexOf(app.isPackaged ? 'info' : 'debug');

export function createLogger(scope: string): Logger {
  const at = (lvl: (typeof LEVELS)[number]) => (...a: unknown[]) => {
    if (LEVELS.indexOf(lvl) >= min) console[lvl](`[${lvl}] [${scope}]`, ...a);
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}
export const logger = createLogger('main');
```

```ts
// src/main/security.ts
import { app, session, shell } from 'electron';
import { ORIGIN } from '@shared/ipc';

export const isHttpUrl = (url: string): boolean => {
  try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
};

export function applySecurityPolicy(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      if (!url.startsWith(ORIGIN + '/')) e.preventDefault();
    });
    wc.on('will-attach-webview', (e) => e.preventDefault());
  });
}
```

```ts
// src/main/window.ts
import path from 'node:path';
import { app, BrowserWindow, Menu, nativeTheme, screen } from 'electron';
import { ORIGIN } from '@shared/ipc';

let win: BrowserWindow | null = null;
let quitting = false;
let pageHandlesClose = false;

export const getMainWindow = () => win;
export const markQuitting = () => { quitting = true; };
export const setPageHandlesClose = (v: boolean) => { pageHandlesClose = v; };

export function showMainWindow(): void {
  if (!win || win.isDestroyed()) { createMainWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export function createMainWindow(): BrowserWindow {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const [width, height] = sw > 1800 ? [Math.round(sw * 0.5), Math.round(sh * 0.8)] : [1080, 720];

  win = new BrowserWindow({
    width, height, minWidth: 960, minHeight: 640, center: true, show: false,
    frame: false, titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win?.show());

  win.on('close', (e) => {
    if (quitting || !pageHandlesClose) { quitting = true; return; }
    e.preventDefault();
    win?.webContents.send('window:close-requested');
  });

  // 页面重新加载或崩溃后，必须重新注册关闭监听，避免窗口无法关闭
  win.webContents.on('did-start-loading', () => setPageHandlesClose(false));
  win.webContents.on('render-process-gone', () => setPageHandlesClose(false));

  win.on('maximize', () => win?.webContents.send('window:maximize-changed', true));
  win.on('unmaximize', () => win?.webContents.send('window:maximize-changed', false));

  win.webContents.on('context-menu', (_e, params) => {
    const items: Electron.MenuItemConstructorOptions[] = [{ role: 'copy' }, { role: 'selectAll' }];
    if (params.isEditable) items.unshift({ role: 'cut' }, { role: 'paste' });
    Menu.buildFromTemplate(items).popup({ window: win! });
  });

  void win.loadURL(`${ORIGIN}/`);
  return win;
}

nativeTheme.on('updated', () => {
  win?.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors);
});

app.on('before-quit', () => { quitting = true; });
```

```ts
// src/main/tray.ts
import path from 'node:path';
import { app, Menu, Tray } from 'electron';
import { showMainWindow } from './window';

let tray: Tray | null = null;

export function createTray(): void {
  const icon = app.isPackaged
    ? path.join(process.resourcesPath, 'tray.ico')
    : path.join(app.getAppPath(), 'assets', 'tray.ico');
  tray = new Tray(icon);
  tray.setToolTip(app.getName());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: showMainWindow },
      { label: '退出', click: () => app.quit() },
    ]),
  );
  tray.on('click', showMainWindow);
}
```

```ts
// src/main/ipc.ts
import { app, ipcMain, nativeTheme, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { ORIGIN, type CloseAction, type InvokeChannels, type SendChannels } from '@shared/ipc';
import { isHttpUrl } from './security';
import { getMainWindow, markQuitting, setPageHandlesClose } from './window';

function assertTrusted(e: IpcMainEvent | IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? '';
  if (!url.startsWith(ORIGIN + '/')) throw new Error(`untrusted ipc sender: ${url}`);
}

function handle<C extends keyof InvokeChannels>(
  channel: C,
  fn: (...args: InvokeChannels[C]['args']) => InvokeChannels[C]['result'] | Promise<InvokeChannels[C]['result']>,
): void {
  ipcMain.handle(channel, (e, ...args) => {
    assertTrusted(e);
    return fn(...(args as InvokeChannels[C]['args']));
  });
}

function on<C extends keyof SendChannels>(channel: C, fn: (...args: SendChannels[C]) => void): void {
  ipcMain.on(channel, (e, ...args) => {
    try { assertTrusted(e); } catch { return; }
    fn(...(args as SendChannels[C]));
  });
}

export function registerIpc(): void {
  handle('app:info', () => ({
    name: app.getName(), version: app.getVersion(),
    electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    arch: process.arch, locale: app.getLocale(), isDark: nativeTheme.shouldUseDarkColors, isPackaged: app.isPackaged,
  }));
  handle('app:open-external', async (url) => {
    if (!isHttpUrl(url)) throw new Error('only http/https urls are allowed');
    await shell.openExternal(url);
  });
  handle('app:toggle-devtools', () => {
    if (!app.isPackaged) getMainWindow()?.webContents.toggleDevTools();
  });
  handle('window:minimize', () => { getMainWindow()?.minimize(); });
  handle('window:toggle-maximize', () => {
    const w = getMainWindow();
    if (w) w.isMaximized() ? w.unmaximize() : w.maximize();
  });
  handle('window:close', () => { getMainWindow()?.close(); });
  handle('window:close-action', (action: CloseAction) => {
    if (action === 'tray') getMainWindow()?.hide();
    else if (action === 'quit') { markQuitting(); app.quit(); }
    else throw new Error(`invalid close action: ${String(action)}`);
  });
  on('window:close-handler', (registered) => setPageHandlesClose(registered === true));
}
```

```ts
// src/main/index.ts
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { handleChttp, registerChttpScheme } from './chttp/scheme';
import { Router } from './chttp/router';
import { createStaticHandler } from './chttp/static';
import { applySecurityPolicy } from './security';
import { createMainWindow, getMainWindow, showMainWindow } from './window';
import { createTray } from './tray';
import { registerIpc } from './ipc';
import { disposePlugins, loadPlugins } from './plugins/loader';
import { registerSystemRoutes } from './routes/system';
import { registerTaskRoutes } from './routes/tasks';
import { AutoImportScheduler } from './tasks/auto-import';
import { logger } from './logger';

// 由 Forge Vite 插件注入（见模板中的 forge.env.d.ts）
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

registerChttpScheme();
app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  const scheduler = new AutoImportScheduler((tick) => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send('auto-import:tick', tick);
  });

  app.whenReady().then(async () => {
    applySecurityPolicy();

    const router = new Router({ maxBodyBytes: 10 * 1024 * 1024, exposeErrors: !app.isPackaged, heartbeatMs: 15_000 });
    registerSystemRoutes(router);
    registerTaskRoutes(router, scheduler);
    const pluginStatuses = await loadPlugins(router);
    router.get('/api/plugins', () => pluginStatuses);

    handleChttp(
      router,
      createStaticHandler({
        root: path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`),
        devServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
      }),
    );

    registerIpc();
    createMainWindow();
    createTray();
    logger.info(`started, plugins: ${pluginStatuses.map((p) => `${p.name}(${p.status})`).join(', ') || 'none'}`);
  });

  app.on('window-all-closed', () => app.quit());

  let disposed = false;
  app.on('will-quit', (e) => {
    if (disposed) return;
    e.preventDefault();
    disposed = true;
    scheduler.dispose();
    void disposePlugins().finally(() => app.quit());
  });

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
}
```

### 8.12 preload

```ts
// src/preload/index.ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AppBridge, EventChannels, InvokeChannels, SendChannels, Unsubscribe } from '@shared/ipc';

const invoke = <C extends keyof InvokeChannels>(c: C, ...args: InvokeChannels[C]['args']) =>
  ipcRenderer.invoke(c, ...args) as Promise<InvokeChannels[C]['result']>;

const send = <C extends keyof SendChannels>(c: C, ...args: SendChannels[C]) => ipcRenderer.send(c, ...args);

const on = <C extends keyof EventChannels>(c: C, cb: (...args: EventChannels[C]) => void): Unsubscribe => {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as EventChannels[C]));
  ipcRenderer.on(c, listener);
  return () => { ipcRenderer.removeListener(c, listener); };
};

let closeHandlers = 0;

const bridge: AppBridge = {
  info: () => invoke('app:info'),
  openExternal: (url) => invoke('app:open-external', url),
  toggleDevTools: () => invoke('app:toggle-devtools'),
  window: {
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggle-maximize'),
    close: () => invoke('window:close'),
    closeAction: (action) => invoke('window:close-action', action),
    onCloseRequested: (cb) => {
      const off = on('window:close-requested', cb);
      if (++closeHandlers === 1) send('window:close-handler', true);
      return () => {
        off();
        if (--closeHandlers === 0) send('window:close-handler', false);
      };
    },
    onMaximizeChanged: (cb) => on('window:maximize-changed', cb),
  },
  onThemeChanged: (cb) => on('theme:changed', cb),
  onAutoImport: (cb) => on('auto-import:tick', cb),
};

contextBridge.exposeInMainWorld('app', bridge);
```

### 8.13 renderer 客户端与用法

```ts
// src/renderer/global.d.ts
import type { AppBridge } from '@shared/ipc';
declare global { interface Window { app: AppBridge } }
export {};
```

```ts
// src/renderer/api.ts
import { ApiError, Codes, type ApiResult } from '@shared/api';

type Query = Record<string, string | number | boolean>;
interface RequestInit2 { method?: string; body?: unknown; query?: Query; signal?: AbortSignal }

function buildUrl(path: string, query?: Query): string {
  const url = new URL(`/api${path}`, location.origin);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
  return url.toString();
}

function fetchApi(path: string, init: RequestInit2): Promise<Response> {
  const hasBody = init.body !== undefined;
  return fetch(buildUrl(path, init.query), {
    method: init.method ?? (hasBody ? 'POST' : 'GET'),
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });
}

/** JSON 接口：code 为 0 时返回 data，否则抛出 ApiError */
export async function request<T>(path: string, init: RequestInit2 = {}): Promise<T> {
  const res = await fetchApi(path, init);
  const r = (await res.json()) as ApiResult<T>;
  if (r.code !== Codes.OK) throw new ApiError(r.code, r.msg);
  return r.data as T;
}

export interface SseEvent<T = unknown> { event: string; data: T; id?: string }

/** SSE 接口：逐个产出事件；通过 signal 中止即断开连接 */
export async function* stream<T = unknown>(path: string, init: RequestInit2 = {}): AsyncGenerator<SseEvent<T>> {
  const res = await fetchApi(path, init);
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const evt = parseFrame<T>(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
      if (evt) yield evt;
    }
  }
}

function parseFrame<T>(raw: string): SseEvent<T> | null {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue; // 心跳或注释
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  if (data.length === 0) return null;
  const text = data.join('\n');
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* 非 JSON 时保留原文 */ }
  return { event, data: parsed as T, id };
}
```

```ts
// src/renderer/main.ts —— 示例用法
import { request, stream } from './api';

async function demo() {
  console.log(await request<{ pong: boolean }>('/ping'));
  console.log(await request<{ message: string }>('/plugins/hello/greet', { query: { name: 'Tom' } }));

  const ac = new AbortController();
  for await (const e of stream<{ i: number; total: number }>('/plugins/hello/count', { query: { n: 5 }, signal: ac.signal })) {
    if (e.event === 'progress') console.log(`progress ${e.data.i}/${e.data.total}`);
    if (e.event === 'complete') break;
    if (e.event === 'error') throw new Error(JSON.stringify(e.data));
  }

  await request('/tasks', { method: 'PUT', body: { tasks: [{ id: 'sync', intervalSec: 60, data: { src: 'a' } }] } });
  window.app.onAutoImport((tick) => console.log('auto import', tick));

  // 接管关闭：每次都询问，不记住选择
  window.app.window.onCloseRequested(async () => {
    const choice = await showCloseDialog(); // 'tray' | 'quit' | 'cancel'，由业务 UI 实现
    if (choice !== 'cancel') await window.app.window.closeAction(choice);
  });
}

declare function showCloseDialog(): Promise<'tray' | 'quit' | 'cancel'>;
void demo();
```

### 8.14 Inno Setup

```iss
; installer/app.iss —— 变量由 MakerInno 通过 /D 传入
#ifndef AppName
  #error AppName is required
#endif

[Setup]
; 生成一次后永不修改（双左花括号用于转义）
AppId={{00000000-0000-0000-0000-000000000000}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseFilename}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\{#ExeName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
#ifdef SignEnabled
SignTool=appsign
SignedUninstaller=yes
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#ExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#ExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#ExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
Type: filesandordirs; Name: "{userappdata}\{#AppName}"
```

> 需要中文安装界面时，在 `[Languages]` 中加入简体中文语言文件（官方安装包不自带简体中文，需要单独引入并提交到仓库）。

```ts
// forge/maker-inno.ts
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MakerBase, type MakerOptions } from '@electron-forge/maker-base';
import type { ForgePlatform } from '@electron-forge/shared-types';

export interface MakerInnoConfig {
  script: string;
  exeName: string;
  iconFile: string;
  publisher: string;
  /** Inno SignTool 命令，$f 会被替换为带引号的文件路径；为空时不签名 */
  signCommand?: string;
  isccPath?: string;
}

export class MakerInno extends MakerBase<MakerInnoConfig> {
  name = 'inno';
  defaultPlatforms: ForgePlatform[] = ['win32'];

  isSupportedOnCurrentPlatform(): boolean {
    return process.platform === 'win32';
  }

  async make({ dir, makeDir, appName, packageJSON, targetArch }: MakerOptions): Promise<string[]> {
    if (targetArch !== 'x64') throw new Error(`MakerInno only supports x64, got ${targetArch}`);
    const version = String(packageJSON.version);
    const outputDir = path.join(makeDir, 'inno', targetArch);
    const baseName = `${appName}_x64_${version}_setup`;
    const iscc = this.config.isccPath ?? process.env.ISCC_PATH ?? 'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe';

    const args = [
      `/DAppName=${appName}`,
      `/DAppVersion=${version}`,
      `/DAppPublisher=${this.config.publisher}`,
      `/DExeName=${this.config.exeName}`,
      `/DIconFile=${this.config.iconFile}`,
      `/DSourceDir=${dir}`,
      `/DOutputDir=${outputDir}`,
      `/DOutputBaseFilename=${baseName}`,
    ];
    if (this.config.signCommand) {
      args.push('/DSignEnabled', `/Sappsign=${this.config.signCommand}`);
    }
    args.push(this.config.script);

    await new Promise<void>((resolve, reject) => {
      const p = spawn(iscc, args, { stdio: 'inherit', windowsHide: true });
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ISCC exited with ${code}`))));
    });
    return [path.join(outputDir, `${baseName}.exe`)];
  }
}
```

### 8.15 签名接入点

```js
// scripts/sign-hook.cjs —— 唯一的签名实现位置（后端待定）
/**
 * @param {string} filePath 待签名文件
 * 要求：Authenticode SHA-256 + RFC 3161 时间戳；签名后执行 `signtool verify /pa`，失败则抛错
 */
module.exports = async function sign(filePath) {
  const backend = process.env.WIN_SIGN_BACKEND;
  if (!backend) {
    console.warn(`[sign] WIN_SIGN_BACKEND not set, skip: ${filePath}`);
    return;
  }
  switch (backend) {
    // case 'remote':  调用自建签名服务
    // case 'azure':   signtool + Azure Trusted Signing
    // case 'cloudhsm': signtool / jsign + 云 HSM 证书
    default:
      throw new Error(`[sign] unsupported WIN_SIGN_BACKEND: ${backend}`);
  }
};
```

```js
// scripts/sign-cli.cjs —— 供 Inno SignTool 调用：node sign-cli.cjs "<file>"
require('./sign-hook.cjs')(process.argv[2]).catch((e) => {
  console.error(e);
  process.exit(1);
});
```

### 8.16 单元测试示例

```ts
// tests/unit/router.test.ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/logger', () => ({ logger: { error: vi.fn() } }));
import { Router } from '../../src/main/chttp/router';
import { ApiError } from '../../src/shared/api';

const call = async (r: Router, method: string, path: string, body?: unknown) => {
  const url = new URL(`chttp://app${path}`);
  const req = new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return (await r.dispatch(req, url)).json();
};

describe('Router', () => {
  it('wraps return value', async () => {
    const r = new Router();
    r.get('/api/ping', () => ({ pong: true }));
    expect(await call(r, 'GET', '/api/ping')).toEqual({ code: 0, msg: 'success', data: { pong: true } });
  });

  it('maps ApiError and unknown routes', async () => {
    const r = new Router();
    r.get('/api/x/:id', (req) => { throw new ApiError(3006, `bad ${req.params.id}`); });
    expect(await call(r, 'GET', '/api/x/7')).toEqual({ code: 3006, msg: 'bad 7', data: '' });
    expect((await call(r, 'POST', '/api/x/7')).code).toBe(3008);
    expect((await call(r, 'GET', '/api/none')).code).toBe(3007);
  });

  it('scopes and removes plugin routes', async () => {
    const r = new Router();
    r.scope('/api/plugins/a').get('/hi', () => 'a');
    expect((await call(r, 'GET', '/api/plugins/a/hi')).data).toBe('a');
    r.removeScope('/api/plugins/a');
    expect((await call(r, 'GET', '/api/plugins/a/hi')).code).toBe(3007);
  });

  it('rejects duplicate routes', () => {
    const r = new Router();
    r.get('/api/a', () => 1);
    expect(() => r.get('/api/a', () => 2)).toThrow(/duplicate/);
  });
});
```

> `src/main/chttp/router.ts` 依赖的 `logger` 会导入 `electron`，单元测试时需要 mock（如上）。也可以让 Router 通过构造参数接收 logger，避免依赖 electron。

---

## 9. 里程碑与验收

| 里程碑 | 交付内容 | 验收标准 |
|--------|----------|----------|
| **M1 工程骨架** | Forge + Vite + TS 工程；安全策略；窗口、托盘、单实例；IPC；lint、typecheck、单元测试、CI | Windows 上 `npm start` 能启动并显示示例页；FR-BLD、FR-WIN、FR-IPC 通过；CI 全绿 |
| **M2 chttp 核心** | scheme、Router、SSE、Static（生产和开发）、`/api/ping` | FR-PRT、FR-RTE、FR-SSE 单元测试通过；开发模式下 HMR 可用；完成两项技术验证（见下） |
| **M3 插件与任务** | SDK、插件构建与隔离检查、加载器、示例插件 `hello`、AutoImport | FR-PLG、FR-TSK 通过；故意让插件导入另一个插件时构建失败；故意让插件 `setup` 抛错时应用正常启动，且 `/api/plugins` 显示该插件为 failed |
| **M4 发布** | Fuses、CSP、Inno maker、签名接入点、E2E | 安装、覆盖升级、卸载全部正常；安装不需要管理员权限；篡改 `app.asar` 后应用拒绝启动；SEC 清单逐项核对通过；E2E 通过 |

**M2 技术验证项**（结论记录到工程 README）：

1. 渲染进程中止 `fetch` 时，`protocol.handle` 返回的 `ReadableStream` 是否会触发 `cancel`（FR-SSE-5 依赖这一点）。如果不会触发，改用"写入失败即视为断开"加心跳检测的方案。
2. 原生 `EventSource` 能否连接 `chttp://app/api/...`。不论结论如何，前端统一使用 8.13 中的 `stream()` 客户端，以便支持 POST 请求体与中止。

**完成定义（DoD）**：需求编号全部有对应测试或验收记录；lint、typecheck、单元测试、E2E 全部通过；README 包含开发、打包、新增插件、新增路由四部分说明。

---

## 10. 待定事项

| # | 事项 | 影响范围 | 处理方式 |
|---|------|----------|----------|
| 1 | 代码签名后端（自建远程服务 / Azure Trusted Signing / 云 HSM 证书） | 只影响 `scripts/sign-hook.cjs` 的实现和 CI 密钥配置 | M4 之前确定；确定前产出未签名的安装包 |
