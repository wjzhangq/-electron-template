# Implementation Plan: Electron 项目构建打包优化

**Branch**: `001-optimize-build-bundle` | **Date**: 2026-07-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-optimize-build-bundle/spec.md`

## Summary

对 Electron 模板项目进行构建优化：将所有运行时依赖（lodash、iconv-lite、shell-env、adm-zip）通过 esbuild 打包进产物，清空 `dependencies` 字段；移除未使用的依赖（superagent、rawheaders2obj）；将源码迁移到 `src/` 目录实现源码/产物分离；用统一的 esbuild 构建流程替代分散的 rollup + @vercel/ncc 组合。

## Technical Context

**Language/Version**: JavaScript (Node.js 18+, CommonJS)

**Primary Dependencies**: esbuild (新增构建工具), electron@26, electron-builder@24

**Storage**: 文件系统（本地文件、用户数据目录、构建产物）

**Testing**: 手动验证 (quickstart.md 场景) + 功能冒烟测试；无现有自动化测试框架

**Target Platform**: Electron 桌面应用 - macOS (arm64/x64), Windows (x64/ia32), Linux (x64/arm64)

**Project Type**: Desktop application (Electron template)

**Performance Goals**: 构建耗时 < 5 秒 (SC-004: < 30 秒); 冷启动不超过当前版本 110% (SC-003)

**Constraints**: dependencies 必须为空 (SC-001); 包体积减少 50%+ (SC-002); 所有功能 100% 正常 (SC-006)

**Scale/Scope**: 8 个源码文件 (main.js + preload.js + 6 个 utils 模块), 4 个运行时依赖需打包, 2 个未使用依赖需移除

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

项目的 `.specify/memory/constitution.md` 目前仍为模板占位符（未定制具体原则）。因此无具体的宪法门禁约束需要检查。

采用的通用工程原则：
- **简单优先 (Simplicity)**: 用单一构建工具 esbuild 替代 5 个工具（rollup + 3 插件 + ncc），符合 YAGNI ✅
- **无冗余依赖**: 移除未使用的 superagent、rawheaders2obj ✅
- **可维护性**: 源码/产物分离，清晰目录结构 ✅

**Gate 状态**: PASS (无宪法违规)

## Project Structure

### Documentation (this feature)

```text
specs/001-optimize-build-bundle/
├── plan.md              # This file (/speckit-plan command output)
├── spec.md              # Feature specification
├── research.md          # Phase 0 output (技术决策)
├── data-model.md        # Phase 1 output (文件/配置实体)
├── quickstart.md        # Phase 1 output (验证场景)
├── contracts/           # Phase 1 output
│   └── build-system.md  # 构建系统契约
└── tasks.md             # Phase 2 output (/speckit-tasks - 尚未创建)
```

### Source Code (repository root)

**优化前**:
```text
electron-template/
├── main.js              # 主进程源码（根目录）
├── preload.js           # 预加载源码
├── rollup.config.js     # rollup 配置
├── build3.sh            # 构建脚本
├── utils/
│   ├── autoImportTask.js
│   ├── ipcInit.js
│   ├── newElectronServer.js
│   ├── protocol.js
│   ├── upgrade.js
│   ├── utils.js
│   ├── zip.js
│   └── zip.bundle.js    # ncc 打包产物
├── icon/
├── build/               # 静态资源 (work.asar)
└── extraResources/      # 平台二进制
```

**优化后**:
```text
electron-template/
├── src/                 # ✨ 源码目录（新增）
│   ├── main.js          # 主进程源码
│   ├── preload.js       # 预加载源码
│   └── utils/
│       ├── autoImportTask.js
│       ├── ipcInit.js
│       ├── newElectronServer.js
│       ├── protocol.js
│       ├── upgrade.js
│       ├── utils.js
│       └── zip.js       # 不再需要 zip.bundle.js
├── esbuild.config.mjs   # ✨ 统一构建配置（替代 rollup.config.js）
├── main.js              # 🔨 构建产物 (gitignored)
├── preload.js           # 🔨 构建产物 (gitignored)
├── icon/
├── build/
└── extraResources/
```

**Structure Decision**:
采用 Desktop application (单项目) 结构。源码集中到 `src/` 目录，构建产物输出到根目录以保持与现有 electron-builder `files` 配置和 Electron 运行时路径（`app://` 协议指向 `build/work.asar`）的兼容性。`esbuild.config.mjs` 替代 `rollup.config.js` 作为唯一构建配置。移除 `zip.bundle.js`（其功能由 esbuild 对 `src/utils/zip.js` 的打包取代）。

## 实施要点摘要

### 关键技术决策 (详见 research.md)

1. **构建工具**: esbuild（速度快、原生 ESM/CJS 支持、内置压缩）
2. **依赖处理**:
   - 打包进产物: lodash, iconv-lite, shell-env, adm-zip
   - 移除（未使用）: superagent, rawheaders2obj
   - External: electron, Node.js builtins
3. **多入口**: main.js 和 preload.js 分别打包（运行环境不同）
4. **路径调整**: upgrade.js 中 `../build` 和 `extraResources` 的相对路径需从 `src/utils/` 重新计算

### 风险点

| 风险 | 缓解措施 |
|------|----------|
| upgrade.js 中 `__dirname` 相对路径依赖目录层级 | 打包后 main.js 在根目录，`__dirname` 变为根目录，需验证 `../build` → `build`, `path.dirname(path.dirname(__dirname))` 路径逻辑 |
| iconv-lite 动态编码表加载 | esbuild bundle 模式追踪静态 require，验证 cp936 编码功能 |
| shell-env ESM 打包 | esbuild format=cjs 自动转换，验证 shellEnv() 调用 |
| zip.bundle.js 被 upgrade.js 引用 | 改为直接 require('./zip')，由 esbuild 打包 |

## Complexity Tracking

> 无宪法违规，无需填写。
