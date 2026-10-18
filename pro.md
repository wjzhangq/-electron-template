# Electron Template 项目分析

> 本文档整理自仓库源码（`src/`、`esbuild.config.mjs`、`build3.sh`、`package.json`、`specs/`），用于快速了解项目的结构、运行机制、对外接口与已知问题。

---

## 1. 项目概览

| 项 | 内容 |
|----|------|
| 定位 | 从成熟产品中抽离出的 **Electron 壳模板**：壳层负责窗口、协议、IPC、热更新、打包；业务前端以 `work.asar` 形式加载 |
| 运行时 | Electron `^26.6.10`（Node 18） |
| 语言 | 纯 JavaScript（CommonJS），无 TypeScript |
| 构建 | esbuild（`src/` → 根目录 `main.js` / `preload.js`，第三方依赖全部内联） |
| 打包 | electron-builder `^24.13.3` + 自定义多平台脚本 `build3.sh` |
| 运行时依赖 | **无**（`dependencies: {}`），lodash / iconv-lite / shell-env / adm-zip 均为 devDependencies，构建时打包进产物 |
| 研发流程 | 使用 Spec Kit（`.specify/`、`specs/001-optimize-build-bundle/`）管理需求 → 方案 → 任务 |
| 代码规模 | `src/` 约 2.2k 行；`build3.sh` 约 280 行 |

Git 历史：

1. `8293ff1` 初始化项目与 `.gitignore`
2. `5a18a63` 用 esbuild 替代 rollup + ncc，依赖内联，源码迁入 `src/`

---

## 2. 目录结构

```
-electron-template/
├── src/                          # 源码（日常编辑这里）
│   ├── main.js                   # 主进程入口：窗口、协议注册、托盘、单实例、快捷键
│   ├── preload.js                # contextBridge：暴露 window.app.* / window.versions.*
│   └── utils/
│       ├── protocol.js           # app:// / api:// / apt:// 三个自定义协议处理器
│       ├── ipcInit.js            # 应用级 + 窗口级 IPC 通道，定时检查更新
│       ├── utils.js              # URL 工具、下载、HTTP 请求、窗口尺寸持久化、SSE/JSON 格式化等
│       ├── upgrade.js            # 热更新：全量包 / bsdiff 增量包，版本回退保护
│       ├── autoImportTask.js     # 基于 setInterval 的定时任务调度器
│       ├── newElectronServer.js  # 本地 IPC Socket 服务：执行本地脚本（node/python/go/php…）
│       └── zip.js                # adm-zip 解压并删除压缩包
├── esbuild.config.mjs            # 统一构建配置（main + preload 两个入口）
├── build3.sh                     # 多平台 × 多架构 × 多语言打包 + 签名脚本
├── package.json                  # 应用元信息、scripts、electron-builder 配置
├── icon/                         # app.icns / app.ico / app.png
├── specs/001-optimize-build-bundle/  # 构建优化需求规格、方案、任务、备份的旧配置
├── .specify/                     # Spec Kit 模板与脚本
└── .gitignore                    # 忽略根目录 main.js/preload.js、build/、extraResources/、dist/ 等
```

运行/打包时还需要（被 gitignore，不在仓库中）：

- `build/work.asar/index.html` 等：前端产物（目录形式，非真正 asar 归档）
- `extraResources/<platform>_<arch>/`：`bspatch` 二进制，用于增量热更新

---

## 3. 构建与运行

### 3.1 npm scripts

| 命令 | 作用 |
|------|------|
| `npm run build` | 生产构建：压缩、无 sourcemap |
| `npm run build:dev` | 开发构建：不压缩、带 sourcemap |
| `npm run watch` | 监听增量构建（隐含 dev 模式） |
| `npm run dev` | `build:dev` 后执行 `electron .` |
| `npm start` | `build` 后执行 `electron . -url=http://localhost:3000`（加载本地前端 dev server） |
| `npm run pack:{m1,intel,win64,win32,linux,linuxarm}` | 调用 electron-builder 打包对应平台 |
| `npm run grant-exec` | 给 `extraResources/*` 加可执行权限 |

### 3.2 esbuild 配置要点（`esbuild.config.mjs`）

- `bundle: true`、`platform: "node"`、`format: "cjs"`、`target: "node18"`
- `external: ["electron"]`，Node 内置模块自动 external
- 入口：`src/main.js → main.js`，`src/preload.js → preload.js`
- 注意：`shell-env@2` 是 ESM-only，**不能直接 `electron src/main.js`**，必须走构建产物

### 3.3 启动参数（`utils.getEnterPoint`）

| 参数 | 作用 |
|------|------|
| `-url=<url>` | 覆盖加载地址，默认 `app://localhost` |
| `-dev` | 自动打开 DevTools |
| `-region=<code>` | 设置 `global.initRegion` |

### 3.4 electron-builder 配置（`package.json → build`）

- `asar: false`；`files`: `main.js`、`preload.js`、`icon`、`build`
- 产物命名：`${productName}_${arch}_${version}_unsign.${ext}`，输出 `dist/`
- mac：`dmg`，`hiddenInset` 标题栏；win：NSIS（非一键、可选安装目录）；linux：`deb`、`AppImage`、`tar.xz`
- 每个平台将 `extraResources/<os>_${arch}/` 拷贝到安装包的 `resources/extraResources`
- `extraMetadata.initRegion` 用于按语言/地区出包

### 3.5 `build3.sh` 打包流程

```
./build3.sh -p <win|mac|linux>... -a <x64|x32|arm>... [-l <en|ja>...] [-s]
```

1. 解析参数，生成 `平台_架构` 组合（不存在对应 `*_cmd` 的组合自动跳过，如 `mac_x32`）
2. 用 `asar ef build/work.asar index.html` 取出前端首页，正则提取 `__APP_VERSION__` / `__BUILD_DATE__`
3. 读取 `package.json` 的 `name` / `productName` / `version`
4. 10 秒内需输入 `yes` 确认
5. 对每个 语言 × 平台：`yarn pack:xxx -c.extraMetadata.version=<web版本> -c.extraMetadata.initRegion=<lang>`
6. 产物移动到 `dist/<name>/<web版本>/[<lang>/]<productName>_<identifier>_<版本>.<ext>`
7. `-s` 签名：
   - mac：`xcrun notarytool submit --keychain-profile <name>` + `stapler staple`
   - win：`curl -F file=@... $WIN_SIGN_URL`，返回文件 > 10MB 才视为成功
   - linux：无操作

> 安装包版本号取自前端 `window.__APP_VERSION__`，而不是 `package.json.version`。

---

## 4. 运行时架构

```
┌──────────────────────────── 主进程 main.js ────────────────────────────┐
│ 单实例锁 / crashReporter / 托盘(Win) / Cmd+Q 快捷键(mac)                │
│                                                                        │
│ protocol.js                 ipcInit.js               upgrade.js         │
│  app://  静态文件 ──────────┐ ipcAppInit  (应用级)     getBuildPath     │
│  api://  反向代理           │ ipcWindowInit(窗口级)    updateBuild      │
│  apt://  RPC + SSE          │ checkUpdate 定时推送     bspatch 增量     │
│                             ▼                                           │
│                    BuildPath = userData/upgrade/build_x 或 <app>/build  │
│                                                                        │
│ autoImportTask.js  定时任务 → webContents.send("autoImport")           │
│ newElectronServer.js  Unix Socket / Named Pipe → execSync 本地脚本      │
└────────────────────────────────────────────────────────────────────────┘
                 ▲ ipcRenderer.invoke / sendSync / on
┌──────────── preload.js (contextBridge) ────────────┐
│ window.versions.*      window.app.*                │
└────────────────────────────────────────────────────┘
                 ▲
┌──────────── 渲染进程：build/work.asar/index.html (app://localhost) ──┐
```

### 4.1 启动顺序（`src/main.js`）

1. 读取 `userData`、`appVersion`、系统主题，写入 `global`；从 `package.json` 读取 `initRegion`
2. `require("./utils/protocol")` —— 此时 `upgrade.getBuildPath()` 已被调用，确定前端目录
3. 追加 `max-connections-per-host=20`，启动 `crashReporter`（不上传）
4. `protocol.registerSchemesAsPrivileged` 注册 `app/api/apt` 为特权协议
5. `requestSingleInstanceLock`，第二实例触发时聚焦/重建主窗口
6. `app.whenReady()`：
   - 注册 `app`(file)、`api`(buffer)、`apt`(stream) 三个协议
   - `initElectronServer()` 启动本地脚本服务
   - `initRegion` 为空时使用 `app.getLocaleCountryCode()`
   - 创建 `AutoImportTask`，`ipcAppInit`
   - `createWindow()`；Windows 下创建托盘
   - mac 下窗口聚焦时注册 `Cmd+Q` → 强制退出，失焦时注销

### 4.2 窗口（`createWindow`）

- 默认取主屏工作区尺寸；宽度 > 1800 时缩为约 50% 宽 × 80% 高；最小 960×640
- `frame: false`；mac `hiddenInset`、win `hidden`、其他 `default`
- 会话级钩子：
  - `onHeadersReceived`：响应没有 CORS 头时注入 `Access-Control-Allow-Origin: *`
  - `onBeforeRequest`：一次性重定向表 `app.RedirectMap`（命中即删除，保留原 query）
  - `onBeforeSendHeaders`：附加 `RejectUnauthorized: false` 头
  - `setCertificateVerifyProc(() => 0)`：**忽略所有证书错误**
- `nativeTheme` 变化 → `send("onTheme", isDark)`
- 恢复/保存窗口尺寸：`userData/window-size.json`
- 关闭流程：`close` 事件中 `preventDefault`，向渲染进程发 `onClose`(关闭配置)，500ms 后若未 `cancelQuit` 则强制 `destroy`
- `did-finish-load` 时读取并打印 `window.__APP_VERSION__` / `__BUILD_DATE__`
- 右键菜单：全选、复制；可编辑区域额外有剪切、粘贴

### 4.3 自定义协议（`src/utils/protocol.js`）

| 协议 | 注册方式 | 行为 |
|------|----------|------|
| `app://` | `registerFileProtocol` | 映射到 `<BuildPath>/work.asar/<path>`；无扩展名回落 `index.html`（SPA 路由）；`index.html` 加 `Pragma: no-cache`；`xxx.<8位hash>.js` 设置 `ETag` |
| `api://` | `registerBufferProtocol` | 直接用 `fetch(request.url)` 转发，响应体按文本返回 |
| `apt://` | `registerStreamProtocol` | 按 URL 最后一段分发方法，返回 `Readable` 流，支持 SSE |

`apt://` 内置方法：

| 方法 | 请求 | 响应 |
|------|------|------|
| `fetch` | 请求头 `origin-url: <目标地址>`，其余头/方法/body 原样转发（`electron.net`） | 目标响应原样返回 |
| `callFunction` | `POST {context, text}`，`context` 为函数体 | 在 `vm` 新上下文中执行（3s 超时）→ `{code:0,data:{text,value}}` |
| `download` | `POST {url, filePath}` | SSE：`event: progress` … `event: complete` / `event: error` |

扩展方式：在 `aptHandler` 内的 `handlers` 对象添加 `async (buf, stream) => {}`，推送数据后 `stream.push(null)` 结束；通过 `stream._is_close` 判断客户端是否断开。

返回格式工具（`utils.js`）：

- `HttpConvertResult(obj)` → `{"code":0,"msg":"success","data":obj}`
- `HttpConvertResult("msg@30003")` → `{"code":30003,"msg":"msg","data":""}`；无 `@` 时 `code=10001`
- `EventConvertResult(data, event)` → `event: <event>\ndata: <json>\n\n`

错误码：`3006/3007/10001/30002/30003/30004/30005`（分别为参数缺失、方法不存在、通用错误、无返回值、执行错误、分发异常、JSON 解析失败）。

### 4.4 渲染进程 API（`src/preload.js`）

`window.versions`：`node()`、`chrome()`、`electron()`

`window.app`：

| 分类 | 方法 | 通道类型 |
|------|------|----------|
| 应用 | `appVersion()` → `{app, upgrade, build}`、`appQuit()`、`appRestart()`（带 `--relaunch`）、`doCrash()` | invoke |
| 窗口 | `miniWindow`、`maxWindow`、`scaleWindow`(切换最大化)、`closeWindow`、`hideWindow`、`activeWindow`、`forceCloseWindow(cfg)`、`cancelQuit`、`openDevTools`、`toggleDevTools` | invoke（窗口级 `safeHandle`） |
| 系统 | `openLink(url)`（仅 http/https）、`openFile(path)`（在文件夹中显示）、`install(path)`（打开安装包后退出） | invoke |
| 路径 | `getUserDataPath`、`getTempPath`、`getDownloadsPath`、`getLogsPath`、`getCrashPath` | sendSync |
| 信息 | `getBuildVersion`、`getShellVersion`、`getLocale`、`getRegion`、`getSystemRegion`、`getIsThemeDark`、`getArch`、`getPlatform` | sendSync / 本地 |
| 热更新 | `hotUpdate(version, hotUrl, diffUrl)` → 空字符串表示成功，否则为错误原因 | invoke |
| 任务 | `initAutoImport(taskList)`、`getAutoImport()` | invoke / sendSync |
| 网络 | `getRemoteText(url, headers)`、`setRedirect(url, redirectUrl)` | invoke |
| 消息 | `sendMessage(...args)`（任意通道 send）、`onMessage(channel, fn)` → 返回取消订阅函数 | send / on |

主进程主动推送的事件（通过 `onMessage` 监听）：

| 通道 | 时机 | 参数 |
|------|------|------|
| `onClose` | 用户点击关闭 | `{isTray, noPrompt}`（Windows 读 `close-cfg.json`，默认托盘 + 提示） |
| `onTheme` | 系统主题变化 | `isDark` |
| `checkUpdate` | 首次 20s 后，之后每 30~90 分钟随机 | `timeout` 秒数 |
| `autoImport` | 定时任务触发 | `data, nextInvocation` |

> `ipcAppInit` 中还注册了 `openFolder(folderName)`（打开/创建 userData 子目录），但 preload 未暴露。

### 4.5 关闭行为约定

1. 关闭窗口 → 主进程发 `onClose(cfg)`，并在 500ms 后强制销毁
2. 前端若要接管（弹窗询问"最小化到托盘/退出"），需在 500ms 内调用 `cancelQuit()`
3. 用户选择后调用 `forceCloseWindow({isTray})`：
   - Windows：`isTray > 0` 隐藏到托盘，否则销毁并退出
   - 其他平台：销毁窗口；`isTray < 0` 时退出应用

### 4.6 热更新（`src/utils/upgrade.js`）

存储结构：

```
userData/upgrade/
├── upgrade.json          # {buildPath, buildVersion, appVersion}
└── build_<version>/
    ├── work.asar/…       # 新前端
    └── send.asar/…       # 增量模式下也会打补丁（模板遗留）
```

`updateBuild(version, hotUrl, diffUrl)`：

1. 创建 `build_<version>` 目录
2. 有 `diffUrl`：下载 `diff.zip` → 解压 → 用 `bspatch` 基于旧版 `work.asar`、`send.asar` 打补丁 → 校验 `work.asar/index.html`
3. 增量失败且有 `hotUrl`：下载 `hot.zip` → 解压
4. 校验 `work.asar` 存在 → 写 `upgrade.json` → 删除其它 `build_*` 目录
5. **不会自动重启**，前端需自行调用 `appRestart()`

`getBuildPath()`（启动时调用）：

- 读取 `upgrade.json`；若记录的 `appVersion` 与当前壳版本不同（用户重装了新壳），或 `work.asar/index.html` 不存在，则删除 `upgrade.json`，回退到内置 `<app>/build`
- 结果缓存于 `global.upgrade`

### 4.7 定时任务（`src/utils/autoImportTask.js`）

- 任务结构：`{auto_import_id, intervals(秒), data}`
- `addOrUpdateTask`：间隔不变仅更新 `data`，间隔变化则重建 `setInterval`
- `cleanUp(list)`：删除不在列表中的任务
- `queryNextInvocations()` → `[{auto_import_id, nextInvocations}]`
- 触发时通过窗口级回调发送 `autoImport` 事件（窗口重建时回调会被替换）

### 4.8 本地脚本执行服务（`src/utils/newElectronServer.js`）

- 启动时监听随机地址：Windows `\\.\pipe\myapp-<uuid>`，其他系统 `$TMPDIR/socket_<uuid>.sock`
- 地址 Base64 后写入 `global.ELECTRON_PIPE`、`process.env.ELECTRON_PIPE`（子进程可继承）
- 协议：客户端发送 `{"action":"execute","data":{"file","args","option"}}`
- 按扩展名选择解释器（`langCommandMap`：php/node/python/python3/bash/go/lua/ruby/rustc/cmd/powershell），用 `shell-env` 取登录 shell 的 `PATH` 后 `execSync`
- Windows 非 js 脚本输出按 `cp936`(GBK) 解码
- 响应：`{"status":"success","result":...}\n\n` 或 `{"status":"error","message":...}\n\n`

### 4.9 userData 中的持久化文件

| 文件 | 用途 |
|------|------|
| `window-size.json` | 窗口位置尺寸 |
| `close-cfg.json` | Windows 关闭行为（`isTray`、`noPrompt`），`utils.saveCloseCfg` 负责写入 |
| `upgrade/upgrade.json` | 当前生效的热更新版本 |
| `upgrade/build_<ver>/` | 热更新前端文件 |

---

## 5. 定制入口

| 需求 | 修改位置 |
|------|----------|
| 应用名 / appId / 版本 / 版权 | `package.json` → `name`、`productName`、`build.appId`、`version`、`copyright` |
| 图标 | `icon/app.icns`、`app.ico`、`app.png`(256×256) |
| 托盘提示与菜单 | `src/main.js` → `createTray()` |
| 窗口尺寸 | `src/main.js` → `createWindow()` |
| RPC 方法 | `src/utils/protocol.js` → `handlers` |
| 支持语言 | `build3.sh` → `validate_lang()` |
| 脚本语言 | `src/utils/newElectronServer.js` → `langCommandMap` 与 `switch(ext)` |
| 前端 | `build/work.asar/`，需在页面设置 `window.__APP_VERSION__`、`window.__BUILD_DATE__` |

---

## 6. 代码审查发现

以下为阅读源码时发现的问题，按影响程度排序，供后续迭代参考（本次未修改代码）。

### 6.1 安全相关（作为模板需明确告知使用者）

1. **全局忽略证书校验**：`setCertificateVerifyProc` 恒返回 `0`，所有 HTTPS 中间人攻击都不会被拦截（`src/main.js`）。
2. **本地脚本服务存在命令注入**：`newElectronServer.js` 用字符串拼接 `file`/`args` 后 `execSync`，且 socket 无任何认证；能连到该管道的本机进程（或继承了 `ELECTRON_PIPE` 的子进程）可执行任意命令。
3. **`callFunction` 使用 `vm` 执行前端传入代码**：Node `vm` 不是安全边界，可逃逸到主进程。
4. **`sendMessage` / `onMessage` 暴露任意 IPC 通道**，削弱了 contextBridge 的隔离意义。
5. **CORS 全放开**：所有无 CORS 头的响应被注入 `Access-Control-Allow-Origin: *`。
6. `apt://fetch`、`api://` 可代理任意地址，前端一旦被 XSS 即可借壳访问内网。

### 6.2 功能缺陷

1. **`app://` 的 Content-Type 永远不生效**：`getExt` 返回不带点的扩展名（如 `js`），而 `mimeTypes` 的键带点（`.js`），导致映射失败；同时无扩展名时又被设为 `".html"`，与其他分支不一致。`if (filePath || ...)` 恒为真，`error: -6` 分支不可达。
2. **增量更新成功但未传 `hotUrl` 时返回错误**：`updateBuild` 中 `else if (!hot_url) return "hotUrl is require"` 未判断 `isBuildOk`，diff 已成功也会失败返回。
3. **`bspatch` 路径与打包位置不一致**：代码在 `__dirname/extraResources` 查找（即 `resources/app/extraResources`），而 electron-builder 把 `extraResources` 放到 `resources/extraResources`（`process.resourcesPath`），打包后增量更新大概率失败、回落全量。
4. **增量更新还会 patch `send.asar`**：模板中并不存在该文件，属于原产品遗留，导致 diff 必然失败。
5. **未知长度下载进度公式错误**：`(((100 * cur) / 500) * 1024 * 1024)` 应为 `100 * cur / (500 * 1024 * 1024)`。
6. `upgrade.js` 中 `ret` 未声明即赋值（隐式全局变量）。
7. 关闭延时注释写 3 秒，实际为 500ms；前端处理窗口很短。
8. `api://` 把响应体按 `text()` 读取，二进制内容会损坏。
9. `README` 描述热更新后"App restarts"，实际需要前端手动调用 `appRestart()`。

### 6.3 工程化

1. 无测试、无 lint、无 CI 配置。
2. `build3.sh` 依赖 `yarn`、全局 `asar` CLI，二者都不在 devDependencies 中；`mv index.html ./dist/` 在 `dist/` 不存在时会失败；`find -maxdepth` 位置会产生 GNU find 警告。
3. `getQueryParams`、`getMimeTypeByExt`、`PromiseQueue`、`getLastBase`、`saveCloseCfg` 已导出但未被使用（`saveCloseCfg` 缺少对应 IPC 通道）。
4. `.specify/memory/constitution.md` 仍是未填写的模板。

---

## 7. 快速上手

```bash
npm install
# 放入前端产物：build/work.asar/index.html（需设置 window.__APP_VERSION__）
npm run dev                       # 开发调试（加 -dev 参数可自动打开 DevTools）
npm start                         # 加载 http://localhost:3000 的前端 dev server
npm run build                     # 生产构建
./build3.sh -p mac -a arm -s      # 打包并签名 macOS arm64
```
