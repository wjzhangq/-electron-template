# Data Model: Electron 项目构建打包优化

本特性主要涉及文件系统结构和构建配置，无传统数据库实体。以下是核心"实体"描述。

## Entities

### 1. 源码文件 (Source Files)

| 属性 | 描述 |
|------|------|
| 位置 | `src/` 目录下 |
| 入口文件 | `src/main.js` (主进程), `src/preload.js` (预加载脚本) |
| 工具模块 | `src/utils/*.js` |
| 格式 | CommonJS (require/module.exports) |

### 2. 构建产物 (Build Artifacts)

| 属性 | 描述 |
|------|------|
| 主进程产物 | `main.js` (根目录) |
| 预加载产物 | `preload.js` (根目录) |
| 格式 | CommonJS, minified |
| 特征 | 所有第三方依赖已内联，仅 electron 和 Node.js 内置模块为 external |

### 3. 构建配置 (Build Configuration)

| 属性 | 描述 |
|------|------|
| 配置文件 | `esbuild.config.mjs` (根目录) |
| 入口定义 | main 和 preload 两个入口点 |
| 输出格式 | CJS (`format: 'cjs'`) |
| External | `electron`, Node.js builtins |
| 压缩 | `minify: true` |

### 4. Package.json 结构

| 字段 | 当前 | 优化后 |
|------|------|--------|
| `main` | `main.js` | `main.js` (不变) |
| `dependencies` | 5 个包 | `{}` (空) |
| `devDependencies` | 7 个包 | 7 个包：`esbuild`、`electron`、`electron-builder`（工具链）+ `adm-zip`、`iconv-lite`、`lodash`、`shell-env`（被 esbuild 内联打包，仅构建期需要） |
| `scripts.build` | 分散的 ncc 命令 | 统一的 esbuild 构建 |
| `scripts.dev` | `electron .` | `electron src/main.js` 或 watch 模式 |

## Relationships

```
src/main.js ──requires──> src/utils/protocol.js
src/main.js ──requires──> src/utils/utils.js
src/main.js ──requires──> src/utils/ipcInit.js
src/main.js ──requires──> src/utils/newElectronServer.js
src/main.js ──requires──> src/utils/autoImportTask.js

src/utils/protocol.js ──requires──> src/utils/upgrade.js
src/utils/protocol.js ──requires──> src/utils/utils.js
src/utils/ipcInit.js ──requires──> src/utils/utils.js
src/utils/ipcInit.js ──requires──> src/utils/upgrade.js
src/utils/upgrade.js ──requires──> src/utils/utils.js
src/utils/upgrade.js ──requires──> src/utils/zip.js (via zip.bundle)

src/utils/newElectronServer.js ──requires──> lodash
src/utils/newElectronServer.js ──requires──> iconv-lite
src/utils/newElectronServer.js ──requires──> shell-env
src/utils/zip.js ──requires──> adm-zip
```

## State Transitions

### 构建流程状态

```
[源码] --esbuild bundle--> [产物生成] --electron-builder--> [应用包]
   |                            |
   |                            +-- main.js (minified, deps bundled)
   |                            +-- preload.js (minified)
   |
   +-- src/main.js
   +-- src/preload.js
   +-- src/utils/*.js
```

### 开发模式状态

```
[源码修改] --esbuild watch--> [产物更新] --electron reload--> [应用刷新]
```
