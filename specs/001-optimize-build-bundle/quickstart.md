# Quickstart: 验证构建打包优化

## Prerequisites

- Node.js >= 18.x
- npm >= 9.x
- 操作系统: macOS / Windows / Linux

## 验证场景

### 场景 1: 完整构建流程验证

**目标**: 验证一条命令完成所有文件打包

```bash
# 1. 安装依赖（仅 devDependencies）
npm install

# 2. 执行构建
npm run build

# 3. 验证产物存在
ls -la main.js preload.js

# 4. 验证产物已压缩（文件内容为单行或极少行）
wc -l main.js    # 期望：极少行数（已 minified）
wc -l preload.js # 期望：极少行数（已 minified）
```

**期望结果**:
- 构建命令退出码为 0
- `main.js` 和 `preload.js` 存在于根目录
- 文件内容为压缩后的代码

### 场景 2: 零运行时依赖验证

**目标**: 验证 dependencies 为空且应用可正常运行

```bash
# 1. 检查 package.json 中 dependencies 为空
node -e "const p=require('./package.json'); console.log('deps:', Object.keys(p.dependencies||{}).length)"
# 期望输出: deps: 0

# 2. 构建后删除 node_modules 并验证启动
npm run build
rm -rf node_modules

# 3. 启动应用（需要重新安装 electron 二进制）
npx electron .
# 期望: 应用正常启动显示窗口
```

**期望结果**:
- `dependencies` 字段为空对象或不存在
- 应用在没有 node_modules 的情况下仍可运行（electron 二进制除外）

### 场景 3: 源码目录结构验证

**目标**: 验证源码和产物正确分离

```bash
# 1. 验证源码在 src/ 目录
ls src/main.js src/preload.js src/utils/

# 2. 验证源码目录包含所有工具模块
ls src/utils/autoImportTask.js src/utils/ipcInit.js src/utils/newElectronServer.js \
   src/utils/protocol.js src/utils/upgrade.js src/utils/utils.js src/utils/zip.js

# 3. 验证根目录的 main.js 是构建产物（非源码）
head -1 main.js
# 期望: 压缩后的代码，非 `const { app, ...` 开头的可读源码
```

**期望结果**:
- `src/` 目录包含所有可编辑源码
- 根目录的 `main.js`/`preload.js` 是构建产物

### 场景 4: 功能完整性验证

**目标**: 验证打包后所有功能正常工作

```bash
# 1. 构建
npm run build

# 2. 以开发模式启动（带 devtools）
npm run dev -- -dev

# 3. 在 DevTools 控制台验证以下功能:
```

在 DevTools 控制台中执行：
- `window.app.appVersion()` → 返回版本信息对象
- `window.app.getPlatform()` → 返回当前平台
- `window.app.getArch()` → 返回架构
- `window.app.getLocale()` → 返回语言
- `window.versions.electron()` → 返回 electron 版本号

**期望结果**:
- 所有 IPC 调用正常响应
- 无 `Cannot find module` 错误
- 无 `require is not defined` 错误

### 场景 5: 开发模式验证

**目标**: 验证开发者可以直接调试源码

```bash
# 使用 watch 模式开发
npm run dev

# 期望: electron 启动，加载应用，支持热重载或快速重建
```

**期望结果**:
- 开发模式可以正常启动
- 修改源码后可以快速看到效果

### 场景 6: electron-builder 打包验证

**目标**: 验证优化后的结构与 electron-builder 兼容

```bash
# 1. 构建产物
npm run build

# 2. 执行平台打包（以当前平台为例）
# macOS:
npm run pack:m1
# 或 Windows:
npm run pack:win64
# 或 Linux:
npm run pack:linux

# 3. 验证输出
ls dist/
```

**期望结果**:
- electron-builder 打包成功
- 输出的 dmg/exe/deb 文件可正常安装运行
- 打包体积较优化前显著减小

## 构建耗时基准

| 操作 | 期望耗时 |
|------|----------|
| `npm run build` | < 5 秒 |
| `npm install` (首次) | < 60 秒 |
| 从克隆到首次构建完成 | < 5 分钟 |
