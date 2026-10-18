# PRD：Electron 壳模板重构（TypeScript + chttp 虚拟 HTTP 服务）

| 项 | 内容 |
|----|------|
| 文档状态 | 草案 v1，**第 10 节待确认事项关闭后**可进入开发 |
| 适用分支 | `claude/bold-dirac-yzc19u` |
| 上一版 | 原 pro.md 为现状代码分析，见 git 历史 `docs: add pro.md project analysis`；本版附录 A 保留摘要 |

---

## 1. 背景

### 1.1 现状

本仓库是从成熟产品抽离的 Electron 26 壳模板（纯 JS + esbuild + electron-builder）。主进程提供 `app://`（静态资源）、`api://`（反向代理）、`apt://`（RPC + SSE）三个协议，另有热更新、本地脚本执行服务、定时任务、跨平台打包脚本。

### 1.2 问题

| # | 问题 | 影响 |
|---|------|------|
| P1 | Electron 26 已停止维护，`registerFileProtocol/registerStreamProtocol` 等 API 已废弃 | 无安全补丁，后续无法升级 |
| P2 | 纯 JS，无类型、无测试、无 lint、无 CI | 维护成本高，重构风险大 |
| P3 | 三个协议职责重叠、返回格式不统一（`{code,msg,data}` + 自定义错误码 + 字符串 `@code` 约定） | 前端调用方式混乱 |
| P4 | 安全基线差：忽略所有证书错误、全局注入 `CORS: *`、`vm` 执行前端代码、本地脚本服务存在命令注入、preload 暴露任意 IPC 通道 | 一处 XSS 即可在用户机器执行任意命令 |
| P5 | 热更新、增量补丁存在多处缺陷（bspatch 路径错误、`send.asar` 遗留等） | 功能实际不可靠 |

### 1.3 原 pro.md 作为需求的不足

原文档只描述"代码现在做什么"，缺少目标、范围、验收标准，缺陷清单也没有处置结论，不能直接指导开发。本版按"目标 → 决策 → 需求 → 验收"组织。

---

## 2. 目标与非目标

### 2.1 目标

- **G1** 升级到最新稳定版 Electron，使用 Electron Forge + TypeScript 重建工程。
- **G2** 提供统一自定义协议 `chttp://`，以"虚拟 HTTP Server"形式同时承载前端静态资源、HTTP 接口与 SSE，**不监听任何真实端口**。
- **G3** 路由可在主进程用 TS 注册，并支持从安装包内置目录动态加载路由模块（插件）。
- **G4** 安全基线符合 Electron 官方安全建议。
- **G5** 仅面向 Windows x64，产出 Inno Setup 安装包，并具备代码签名能力。

### 2.2 非目标（本期明确不做）

| 不做 | 说明 |
|------|------|
| macOS / Linux 支持 | 代码中删除对应分支（`hiddenInset`、`Cmd+Q`、`activate` 等） |
| Windows ia32 / arm64 | 仅 x64 |
| 热更新（全量/增量） | 删除 `upgrade.js`、bspatch、`extraResources`；前端随安装包发布 |
| 本地脚本执行服务 | 删除 `newElectronServer.js`、shell-env、iconv-lite |
| `callFunction`（vm 执行）、`fetch`/`api://` 任意 URL 代理 | 删除 |
| 按地区/语言出包（initRegion 出包） | 不做 |
| 应用自动更新（autoUpdater） | 不做 |
| 运行时安装第三方插件 | 插件只能随安装包发布 |

---

## 3. 已确认决策

| # | 决策 | 结论 |
|---|------|------|
| D1 | Electron 版本 | 立项时的最新稳定版，锁定 major 版本 |
| D2 | 语言 | TypeScript（`strict: true`） |
| D3 | 工具链 | Electron Forge（构建、打包、make） |
| D4 | 协议 | `chttp://` **统一替代** `app://`、`api://`、`apt://` |
| D5 | URL 规划 | 单主机：`chttp://app/` 静态资源，`chttp://app/api/*` 路由 |
| D6 | 路由来源 | 主进程 TS 注册 + 动态加载**安装包内置** `plugins/` 目录 |
| D7 | 保留的旧功能 | 窗口、托盘、单实例、窗口控制 IPC、AutoImport 定时任务 |
| D8 | 安全 | 移除全部不安全默认行为，遵循官方安全建议 |
| D9 | 平台 | 仅 Windows x64 |
| D10 | 安装包 | Inno Setup |
| D11 | 签名 | 提供签名方案（见第 7 节） |

---

## 4. 总体架构

```
┌──────────────────────────── 主进程 (TypeScript) ────────────────────────────┐
│                                                                             │
│  chttp 协议层  protocol.handle("chttp")                                      │
│   ├─ /api/*            → Router ──┬─ 内置路由（src/main/routes/*.ts）         │
│   │                               └─ 插件路由（resources/plugins/<name>/）    │
│   │                                  挂载到 /api/plugins/<name>/*            │
│   └─ 其他路径           → 静态资源（生产：asar 内 renderer/；开发：代理 dev server） │
│                                                                             │
│  窗口 / 托盘 / 单实例      IPC（白名单 + 类型契约）      AutoImport 调度器      │
└─────────────────────────────────────────────────────────────────────────────┘
          ▲ 白名单 IPC                                ▲ fetch / SSE
┌──────── preload（sandbox，contextBridge）──┐   ┌──── 渲染进程 chttp://app/ ────┐
│ window.app.*（仅窗口/系统类能力）            │   │ 业务前端（与 /api 同源）       │
└────────────────────────────────────────────┘   └──────────────────────────────┘
```

职责边界：**数据与业务接口一律走 `chttp://app/api`**；IPC 只保留 HTTP 无法表达的窗口/系统控制和主进程推送。

---

## 5. 功能需求

> 编号规则：`FR-<模块>-<序号>`。每条需求均需有对应自动化测试或第 9 节中的手工验收项。

### 5.1 工程与构建（BLD）

| 编号 | 需求 |
|------|------|
| FR-BLD-1 | 使用 Electron Forge 的 TypeScript 模板创建工程，main / preload / renderer 三个入口分别构建 |
| FR-BLD-2 | `tsconfig` 开启 `strict`；`npm run typecheck`（`tsc --noEmit`）必须零错误 |
| FR-BLD-3 | 提供 `start`（开发）、`package`、`make`、`lint`、`typecheck`、`test` 脚本 |
| FR-BLD-4 | `dependencies` 为空或仅包含必须在运行时存在的包；其余依赖构建时打包 |
| FR-BLD-5 | 启用 asar；通过 Forge Fuses 插件关闭 `RunAsNode`、`EnableNodeOptionsEnvironmentVariable`、`EnableNodeCliInspectArguments`，开启 `EnableEmbeddedAsarIntegrityValidation`、`OnlyLoadAppFromAsar` |
| FR-BLD-6 | 删除 `esbuild.config.mjs`、`build3.sh`、electron-builder 配置及 `specs/001-*/backup` 中的旧配置 |
| FR-BLD-7 | 提供 CI（至少执行 lint、typecheck、test、Windows 上的 `make`） |

### 5.2 chttp 协议（PRT）

| 编号 | 需求 |
|------|------|
| FR-PRT-1 | 应用 ready 前以 `standard`、`secure`、`supportFetchAPI`、`stream`、`corsEnabled` 权限注册 `chttp` 为特权协议；ready 后用 `protocol.handle` 处理 |
| FR-PRT-2 | 仅接受主机名 `app`，其他主机返回 `404` |
| FR-PRT-3 | 路径以 `/api/` 开头的请求交给 Router（5.3）；其余为静态资源 |
| FR-PRT-4 | 静态资源：按扩展名返回正确 `Content-Type`（至少 html/js/mjs/css/json/svg/png/jpg/webp/ico/woff/woff2/wasm/map） |
| FR-PRT-5 | 静态资源：无扩展名且文件不存在的路径回落 `index.html`（SPA）；`index.html` 带 `Cache-Control: no-cache` |
| FR-PRT-6 | 静态资源：解码后路径必须位于资源根目录内，越界（`..`、绝对路径、编码绕过）返回 `403` |
| FR-PRT-7 | 开发模式：静态资源请求转发到 renderer dev server，保证前端 origin 始终为 `chttp://app` |
| FR-PRT-8 | 所有响应附带 CSP（默认 `default-src 'self'`，开发模式允许 dev server 的 HMR 连接） |
| FR-PRT-9 | 不再全局注入 CORS 头；`chttp://app` 页面与 `/api` 同源，无需 CORS |

### 5.3 路由（虚拟 HTTP Server）（RTE）

对开发者暴露的 API（示意，具体签名在技术设计中定稿）：

```ts
const router = createRouter();

router.get("/api/ping", async (req) => ({ ok: true }));          // 返回对象 → 200 JSON
router.post("/api/items/:id", async (req) => {
  const body = await req.json<{ name: string }>();
  return json({ id: req.params.id, ...body }, { status: 201 });
});
router.sse("/api/progress", async (req, sse) => {                  // SSE
  sse.send({ percent: 10 }, { event: "progress", id: "1" });
  sse.onClose(() => {/* 客户端断开时清理 */});
  sse.close();
});
```

| 编号 | 需求 |
|------|------|
| FR-RTE-1 | 支持 GET/POST/PUT/PATCH/DELETE/OPTIONS/HEAD；路径参数 `:id`；query 解析 |
| FR-RTE-2 | 请求对象提供 `method`、`path`、`params`、`query`、`headers`、`json()`、`text()`、`arrayBuffer()` |
| FR-RTE-3 | handler 可返回 `Response`、普通对象（序列化为 JSON）或 `undefined`（`204`） |
| FR-RTE-4 | 使用标准 HTTP 状态码；未匹配路由 `404`，方法不支持 `405`，handler 抛错 `500`（生产不返回堆栈） |
| FR-RTE-5 | 支持中间件（至少：日志、错误处理、请求体大小限制） |
| FR-RTE-6 | 路由注册冲突时启动失败并给出明确报错 |
| FR-RTE-7 | 只接受来自本应用页面的请求（校验请求来源为 `chttp://app`），其他来源 `403` |

### 5.4 SSE（SSE）

| 编号 | 需求 |
|------|------|
| FR-SSE-1 | 响应头 `Content-Type: text/event-stream`、`Cache-Control: no-cache`，响应体为 `ReadableStream` |
| FR-SSE-2 | `send(data, { event?, id?, retry? })`，对象自动 JSON 序列化，多行数据按规范拆分 `data:` 行 |
| FR-SSE-3 | 客户端断开（流被取消）时触发 `onClose`，handler 能停止后续工作 |
| FR-SSE-4 | 支持可选的心跳注释帧（如每 15s 一次 `: ping`） |
| FR-SSE-5 | 渲染进程能以 `fetch` + 流读取方式消费；**`EventSource` 是否可用需在 M2 验证**，不可用则提供轻量客户端封装 |

### 5.5 插件（动态加载路由模块）（PLG）

| 编号 | 需求 |
|------|------|
| FR-PLG-1 | 插件源码位于仓库 `plugins/<name>/index.ts`，构建时编译并随安装包放入 `resources/plugins/<name>/` |
| FR-PLG-2 | 启动时扫描该目录并加载；**不读取 userData 等任何用户可写目录** |
| FR-PLG-3 | 插件导出约定：`export default definePlugin({ name, version, setup(router, ctx) })` |
| FR-PLG-4 | 插件路由自动挂载到 `/api/plugins/<name>/*`，不能注册该前缀以外的路由 |
| FR-PLG-5 | 单个插件加载或 `setup` 失败只记录日志并跳过，不影响应用和其他插件 |
| FR-PLG-6 | 提供 `GET /api/plugins` 返回已加载插件列表与状态 |
| FR-PLG-7 | `ctx` 只暴露受控能力（日志、配置读取、userData 下的插件私有目录），不直接暴露 `BrowserWindow` |

### 5.6 窗口、托盘、单实例（WIN）

| 编号 | 需求 |
|------|------|
| FR-WIN-1 | 单实例；第二实例启动时恢复并聚焦主窗口 |
| FR-WIN-2 | 无边框窗口（`titleBarStyle: hidden`），最小 960×640；记住窗口位置、尺寸、最大化状态，恢复时确保窗口在可见屏幕内 |
| FR-WIN-3 | 托盘：单击显示主窗口；菜单"显示主窗口""退出" |
| FR-WIN-4 | 关闭行为：用户可选"最小化到托盘"或"退出"，可记住选择；由前端弹窗决策（交互细节见 Q4） |
| FR-WIN-5 | 外部链接（`window.open`、`target=_blank`）只允许 http/https，用系统浏览器打开；禁止主窗口导航离开 `chttp://app` |
| FR-WIN-6 | 右键菜单：复制/全选，可编辑区域增加剪切/粘贴 |
| FR-WIN-7 | 跟随系统深色模式，变化时推送给前端 |

### 5.7 IPC 与 preload（IPC）

| 编号 | 需求 |
|------|------|
| FR-IPC-1 | 通道名与参数类型在 `src/shared/ipc.ts` 统一定义，main 与 preload 共用类型 |
| FR-IPC-2 | preload 只暴露白名单方法，不提供通用 `send`/`on` |
| FR-IPC-3 | 主进程处理每个调用时校验发送方 frame 的 origin 为 `chttp://app`，并校验参数 |
| FR-IPC-4 | 保留的调用：窗口控制（最小化、最大化切换、隐藏、显示、关闭、强制关闭/退出、取消关闭）、DevTools（仅开发模式）、获取版本与平台信息、获取系统语言、打开外部链接 |
| FR-IPC-5 | 主进程推送事件（白名单）：`window:close-requested`、`theme:changed`、`autoImport:tick` |
| FR-IPC-6 | 其余旧 IPC 能力的去留见 Q3 |

### 5.8 AutoImport 定时任务（TSK）

| 编号 | 需求 |
|------|------|
| FR-TSK-1 | 任务结构 `{ id: string; intervalSec: number; data: unknown }`，`intervalSec` 下限 10s（可配置） |
| FR-TSK-2 | 同步接口：前端提交完整任务列表，新增/更新/删除一次完成（替代旧的 add + cleanUp） |
| FR-TSK-3 | 间隔不变只更新 `data`，不重置计时；间隔变化则重新计时 |
| FR-TSK-4 | 查询接口返回每个任务的下次执行时间 |
| FR-TSK-5 | 到期时向主窗口推送 `autoImport:tick`；窗口隐藏时照常推送，窗口销毁重建后继续推送到新窗口 |
| FR-TSK-6 | 任务管理接口改为 HTTP：`PUT /api/tasks`、`GET /api/tasks` |

---

## 6. 非功能需求

### 6.1 安全（SEC）

| 编号 | 需求 |
|------|------|
| SEC-1 | `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webSecurity: true` |
| SEC-2 | 移除 `setCertificateVerifyProc` 忽略证书错误、`RejectUnauthorized` 请求头、全局 CORS 注入 |
| SEC-3 | 默认拒绝所有权限请求（摄像头、通知等），需要时按白名单放行 |
| SEC-4 | 禁止加载远程内容到主窗口；禁止 `webview` |
| SEC-5 | 启用 Fuses 与 asar 完整性校验（见 FR-BLD-5） |
| SEC-6 | 安装包与主程序均签名（见第 7 节） |
| SEC-7 | 依赖审计：CI 中运行 `npm audit --omit=dev`（high 及以上为失败） |

### 6.2 性能

| 编号 | 需求 |
|------|------|
| PERF-1 | 冷启动到首屏可交互 ≤ 2s（参考机器在 M1 确定基线） |
| PERF-2 | `/api` 空路由往返延迟 P95 ≤ 5ms |
| PERF-3 | 单个 SSE 连接持续推送 10 分钟内存无持续增长 |

### 6.3 质量

| 编号 | 需求 |
|------|------|
| QA-1 | Router、SSE 编码、静态路径校验、AutoImport 调度单元测试覆盖率 ≥ 80% |
| QA-2 | 使用 Playwright（Electron 模式）做 E2E：启动、加载首页、调用 `/api/ping`、接收 SSE、窗口控制 |
| QA-3 | ESLint + Prettier，CI 强制 |

---

## 7. 打包与签名方案（Windows x64 + Inno Setup）

### 7.1 打包流程

```
electron-forge package   →   out/<App>-win32-x64/        （Forge 打包，含 asar、Fuses）
        │
        ├─ 签名：主程序 exe 及其他 PE 文件（@electron/windows-sign，经统一签名钩子）
        ▼
electron-forge make      →   自定义 Inno maker：生成 .iss → 调用 ISCC.exe
        │
        ├─ 签名：安装程序与卸载程序（Inno 的 SignTool 指令，调用同一签名钩子）
        ▼
out/make/<App>_x64_<version>_setup.exe
```

| 编号 | 需求 |
|------|------|
| PKG-1 | Forge 没有官方 Inno maker，在仓库内实现自定义 maker（`forge/maker-inno.ts`），基于 `MakerBase`，从模板生成 `.iss` 并调用 `ISCC.exe` |
| PKG-2 | 构建机为 Windows，预装 Inno Setup 6；ISCC 路径可通过环境变量覆盖 |
| PKG-3 | `.iss` 中 `AppId` 为固定 GUID（保证覆盖升级）；版本号取自 `package.json`；含开始菜单、可选桌面快捷方式、卸载项 |
| PKG-4 | 升级安装前关闭正在运行的应用（Inno `CloseApplications`） |
| PKG-5 | 产物命名：`<productName>_x64_<version>_setup.exe` |

### 7.2 签名方案

**前提**：自 2023 年 6 月起，OV/EV 代码签名证书的私钥必须存放在 HSM 或云 HSM 中，不能再以 `.pfx` 文件放在构建机上。因此方案统一为"**签名钩子 + 可替换的签名后端**"。

**统一签名钩子** `scripts/sign-windows.ts`：

- 输入：待签名文件路径
- 行为：调用所选后端完成 Authenticode 签名（SHA-256）并加 RFC 3161 时间戳，然后执行 `signtool verify /pa` 校验
- 调用方：① `@electron/windows-sign`（签 `out/` 中的 exe/dll）；② Inno `SignTool=` 指令（签安装与卸载程序）
- 凭据：只从 CI 环境变量/密钥库读取，不进仓库
- 开关：未配置凭据时跳过签名并输出警告（本地开发可正常 make）

**签名后端选项**（三选一，见 Q1）：

| 后端 | 说明 | 优点 | 注意 |
|------|------|------|------|
| A. 现有远程签名服务 | 沿用 `WIN_SIGN_URL`：上传文件、取回签名后文件 | 零采购成本，延续现有流程 | 需服务端支持时间戳，并返回可校验结果；建议加鉴权，并改为按签名校验结果判断成功，而不是按文件大小 |
| B. Azure Trusted Signing（微软云签名） | `signtool` + 微软提供的 dlib 插件 | 费用低、无需管理证书、可直接接入 CI | 对申请主体有资格限制，需先确认公司能否开通 |
| C. 云 HSM 托管的 OV/EV 证书 | DigiCert KeyLocker、SSL.com eSigner 等，`signtool` 或 `jsign` 调用 | 证书主体就是公司名称，通用性强 | 年费较高；EV 证书已不再立即获得 SmartScreen 信誉 |

**建议**：如果远程签名服务（A）仍在维护并且符合上述要求，本期直接用 A；否则优先评估 B。

---

## 8. 移除与迁移清单

| 旧能力 | 处置 | 前端迁移 |
|--------|------|----------|
| `app://localhost` | 由 `chttp://app/` 替代 | 改加载地址 |
| `api://` 反向代理 | 删除 | 需要访问外部接口时由主进程路由/插件实现 |
| `apt://<method>` | 由 `chttp://app/api/*` 替代 | 改 URL；返回格式从 `{code,msg,data}` 改为 HTTP 状态码 + JSON（见 Q2） |
| `apt://download`（带进度下载） | 删除；如需保留则改写为内置 SSE 路由（见 Q3） | — |
| `callFunction`、`fetch` 代理 | 删除 | — |
| 热更新、`checkUpdate` 定时推送 | 删除 | 删除前端相关逻辑 |
| 本地脚本执行服务 `ELECTRON_PIPE` | 删除 | — |
| `setRedirect` 一次性重定向 | 见 Q3 | — |
| `window.app.sendMessage/onMessage` | 删除，改为白名单方法 | 改调用方式 |
| `initRegion` / `-region` 启动参数 | 删除 | 改用系统语言 |
| mac/linux 代码分支 | 删除 | — |

> 注意：移除全局 CORS 注入后，前端**不能再直接请求未开放 CORS 的第三方接口**，此类请求必须改为调用主进程路由或插件。

---

## 9. 里程碑与验收

| 里程碑 | 内容 | 验收标准 |
|--------|------|----------|
| M1 工程骨架 | Forge + TS + 最新 Electron；窗口、托盘、单实例；lint/typecheck/test/CI | Windows 上 `npm start` 正常启动；CI 全绿 |
| M2 chttp 核心 | 静态资源、Router、SSE、开发模式代理 | FR-PRT、FR-RTE、FR-SSE 全部测试通过；E2E 能调用 `/api/ping` 并收到 SSE；完成 `EventSource` 验证 |
| M3 插件与业务 | 插件加载、AutoImport、白名单 IPC | 示例插件 `plugins/hello` 可访问；单个插件故障不影响启动；FR-TSK 测试通过 |
| M4 发布 | 安全加固、Fuses、Inno maker、签名钩子 | 安装、升级覆盖、卸载正常；`signtool verify /pa` 通过；SEC 清单逐项核对通过 |

---

## 10. 待确认事项

以下事项会影响实现。表中只给出建议，确认前不按建议默认执行。

| # | 问题 | 建议 |
|---|------|------|
| Q1 | 签名后端选 A / B / C？远程签名服务是否仍在维护？ | A（若服务满足 7.2 的要求），否则 B |
| Q2 | `/api` 返回格式：标准 HTTP 状态码 + JSON，还是沿用 `{code,msg,data}`？ | 标准状态码；错误体 `{ "error": { "code": "...", "message": "..." } }` |
| Q3 | 下列旧 IPC/协议能力是否保留：`openFolder`、`openFile`（在文件夹中显示）、`install`（运行安装包）、`getRemoteText`、`setRedirect`、`download`（带进度）、各类系统路径查询、`doCrash` | 保留 `openFile`；`download` 改为 SSE 路由；`getRemoteText` 由插件按需实现；其余删除 |
| Q4 | 关闭窗口交互：首次弹窗询问并可"记住选择"，还是固定最小化到托盘？ | 首次询问并记住，设置页可修改 |
| Q5 | Inno 安装模式：按用户安装（AppData，无需管理员）还是按机器安装（Program Files，需管理员）？ | 按机器安装：插件目录位于用户无写权限的位置，才能满足 FR-PLG-2 的可信要求 |
| Q6 | Forge 的 renderer 构建用 Vite 插件还是 Webpack 插件？模板是否内置示例前端？ | Vite；内置一个最小示例页面，用于演示 `/api` 和 SSE |
| Q7 | 插件之间是否允许互相调用？插件是否需要读写配置？ | 本期不允许互相调用；只提供只读配置与私有目录 |
| Q8 | 是否需要日志落盘及崩溃转储收集？ | 日志写入 `userData/logs` 并按大小轮转；崩溃转储仅保存在本地 |

---

## 附录 A：现状摘要（重构前）

- 运行时：Electron 26，纯 JS，esbuild 构建产物 `main.js`/`preload.js`，electron-builder + `build3.sh` 多平台打包
- 模块：`protocol.js`（app/api/apt 三协议）、`ipcInit.js`（约 35 个 IPC 通道）、`upgrade.js`（热更新）、`newElectronServer.js`（脚本执行）、`autoImportTask.js`（定时任务）、`utils.js`、`zip.js`
- 已知缺陷（重构后随模块删除或改写而消失，此处仅作记录）：
  - `app://` 的 MIME 映射因扩展名带不带点不一致而失效
  - bspatch 查找路径与打包后实际位置不一致
  - 增量补丁会处理不存在的 `send.asar`
  - 只传增量包地址时，即使打补丁成功也会返回错误
  - 未知文件长度时下载进度公式错误
  - `upgrade.js` 中 `ret` 未声明即赋值
  - 关闭延时注释写 3 秒，实际为 500ms
  - 脚本执行服务存在命令注入
