# Research: Electron 项目构建打包优化

## Decision 1: 构建工具选择

**Decision**: 使用 **esbuild** 替代当前的 rollup + @vercel/ncc 组合

**Rationale**:
- esbuild 构建速度比 rollup 快 10-100 倍，满足 SC-004（30 秒内完成）
- 原生支持 CJS 和 ESM 混合模块（解决 shell-env@2.0.0 的 ESM 问题）
- 内置 minification 和 tree-shaking，无需额外插件
- 对 Node.js/Electron 项目有一流支持，`--platform=node` 开箱即用
- 单一工具替代 rollup + rollup-plugin-terser + @rollup/plugin-commonjs + @rollup/plugin-node-resolve + @vercel/ncc

**Alternatives considered**:
- **rollup (当前)**: 需要多个插件，ESM→CJS 转换不够稳定，构建速度慢
- **webpack**: 配置复杂，对 Electron main process 打包属于大材小用
- **@vercel/ncc**: 当前已用于部分文件，但不支持多入口打包，配置能力有限
- **tsup (基于 esbuild)**: 增加了 TypeScript 层的抽象，当前项目是纯 JS 无需

## Decision 2: iconv-lite 动态 require 处理

**Decision**: 使用 esbuild 的 `--bundle` 配合 `--packages=bundle` 模式，对 `iconv-lite` 的编码表文件通过 `@esbuild-plugins/node-modules-polyfill` 或显式 include 方式处理

**Rationale**:
- `iconv-lite` 使用 `require("./encodings")` 加载编码表，这是静态路径，esbuild 可正确追踪
- 编码表文件是纯 JS 数据文件，可以被安全打包
- esbuild 的 `--bundle` 模式会递归分析所有 require 路径

**Alternatives considered**:
- 将 iconv-lite 保留为 external 并作为 dependencies：违背核心目标
- 手动复制编码表文件：维护成本高，容易出错

## Decision 3: shell-env ESM 处理

**Decision**: 保持使用 `shell-env@2.0.0`（ESM），esbuild 原生支持 ESM→CJS 转换

**Rationale**:
- esbuild 天然支持将 ESM 模块打包为 CJS 输出格式
- `--format=cjs` 输出格式下，ESM 的 import/export 会被自动转换为 require/module.exports
- 无需降级到旧版本或寻找替代包

**Alternatives considered**:
- 降级到 `shell-env@1.x`（CJS 版本）：引入旧代码，可能有安全问题
- 使用 `shell-path` 替代：功能不完全等价

## Decision 4: lodash 优化策略

**Decision**: 通过 esbuild 的 tree-shaking 自动优化，当前代码仅使用 `_.set`、`_.get`、`_.assign`

**Rationale**:
- 当前代码中只使用了 lodash 的 3 个方法：`_.set`、`_.get`、`_.assign`
- esbuild 打包后 lodash 全量代码会被包含（因为 lodash 不是 ESM 格式，无法 tree-shake）
- 但因为是打包进产物，体积增加可接受（lodash 全量约 70KB minified）
- 未来可考虑替换为 `lodash-es` 或直接用原生 JS 实现这 3 个方法

**Alternatives considered**:
- 替换为 `lodash-es`：需要修改 import 方式，增加改动范围
- 手写替代代码：可在后续优化中进行，当前优先保证功能正确性

## Decision 5: 多入口打包策略

**Decision**: 使用 esbuild 多入口模式，分别打包 main.js 和 preload.js

**Rationale**:
- main.js 和 preload.js 运行在不同上下文（main process vs renderer sandbox）
- 两者的 external 配置不同（main 需排除 electron 全部模块，preload 仅需排除 electron）
- esbuild 支持多入口配置，可以共享配置基础但各自定制
- utils/ 下的模块作为 main.js 的依赖被自动打包（无需单独入口）

**Alternatives considered**:
- 单一入口打包所有代码：无法处理 main/preload 的运行环境差异
- 为每个 utils 文件单独打包：增加复杂度且无必要（它们都被 main.js require）

## Decision 6: 目录结构设计

**Decision**: 源码移入 `src/`，产物输出到根目录（保持与 electron-builder 配置兼容）

**Rationale**:
- electron-builder 的 `files` 配置指向 `main.js`、`preload.js`、`utils`
- 将源码移到 `src/` 后，esbuild 产物输出到根目录的 `main.js`、`preload.js`
- `utils/zip.bundle.js` 被 `upgrade.js` require，打包后不再需要单独存在
- `.gitignore` 需更新以忽略根目录的产物文件（已经忽略了 `main.js` 和 `utils/zip.bundle.js`）

**Alternatives considered**:
- 产物输出到 `dist/`：需要大幅修改 electron-builder 配置和运行时路径
- 不迁移源码：源码和产物混在一起，不利于维护

## Decision 7: superagent 处理

**Decision**: 分析发现 `superagent` 在当前代码中**未被使用**（package.json 中声明但无代码引用），直接移除

**Rationale**:
- 全局搜索项目代码，未找到任何对 `superagent` 的 require/import
- HTTP 请求功能已通过 Electron 的 `net` 模块实现（utils.js 中的 `downloadFile`、`makeRequest`）
- 移除无用依赖可减小打包体积

**Alternatives considered**:
- 保留但打包：增加不必要的体积
- 移到 devDependencies：同样无意义

## Decision 8: rawheaders2obj 处理

**Decision**: 分析发现 `rawheaders2obj` 在当前代码中**未被使用**，直接移除

**Rationale**:
- 全局搜索项目代码，未找到任何对 `rawheaders2obj` 的 require/import
- 移除无用依赖

## Decision 9: adm-zip 处理策略

**Decision**: `adm-zip` 目前仅在 `utils/zip.js` 中使用，通过 esbuild 打包进 main.js 产物

**Rationale**:
- `adm-zip` 是纯 JS 实现，没有原生模块依赖，可安全打包
- `utils/zip.js` 被编译为 `utils/zip.bundle.js`，再被 `upgrade.js` require
- 优化后整个依赖链（zip.js → adm-zip）都会被打包进 main.js

## Decision 10: 开发模式策略

**Decision**: 开发模式统一加载 esbuild 构建产物（**不直接加载 `src/`**），通过 esbuild `--watch` 增量编译 + `electron .` 启动

**Rationale**:
- ⚠️ **关键约束**：`shell-env@2.0.0` 为纯 ESM 包，CJS 的 `src/main.js` 用 `require('shell-env')` 会抛 `ERR_REQUIRE_ESM`——因此**不能**直接 `electron src/main.js`
- 只有经 esbuild `format=cjs` 打包转译内联后，shell-env 才能正常运行，dev 与 prod 都必须走产物
- dev 构建保留 sourcemap 且不压缩（`--dev` 参数），便于调试
- esbuild `--watch` 提供毫秒级增量重建，开发体验接近零延迟
- 开发流程：`npm run watch`（终端 1，持续编译）+ `electron .`（终端 2，加载产物，改动后刷新）

**Alternatives considered**:
- 直接 `electron src/main.js`：**已否决**——shell-env ESM 无法被 CJS require
- 降级 shell-env 到 CJS 版本以支持直接加载 src：引入旧代码，且不如统一走产物干净
- 使用 nodemon 监听文件变化：esbuild --watch 已够用，避免额外依赖
