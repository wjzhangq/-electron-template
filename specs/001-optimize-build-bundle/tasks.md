---
description: "Task list for Electron 项目构建打包优化"
---

# Tasks: Electron 项目构建打包优化

**Input**: Design documents from `/specs/001-optimize-build-bundle/`

**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅

**Tests**: 本特性未要求 TDD 自动化测试。验证通过 quickstart.md 的手动/命令行场景完成。

**Organization**: 任务按用户故事分组，每个故事可独立实现与验证。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件，无依赖）
- **[Story]**: 所属用户故事 (US1, US2, US3)
- 每个任务包含明确文件路径

## Path Conventions

- 源码目录: `src/` (main.js, preload.js, utils/)
- 构建产物: 仓库根目录 (main.js, preload.js)
- 构建配置: `esbuild.config.mjs` (根目录)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 建立源码目录结构，为迁移和构建做准备

- [X] T001 创建 `src/` 目录及 `src/utils/` 子目录
- [X] T002 [P] 安装 esbuild 为 devDependency：`npm install -D esbuild`
- [X] T003 [P] 备份当前 `package.json`、`rollup.config.js`、`build3.sh` 到 `specs/001-optimize-build-bundle/backup/` 以便回滚参考

**Checkpoint**: 目录结构就绪，esbuild 已安装

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 源码迁移与路径修正——这是所有后续构建/打包工作的前置条件

**⚠️ CRITICAL**: 必须完成本阶段才能进行任何用户故事的构建验证

- [X] T004 将 `main.js` 移动到 `src/main.js`（`git mv main.js src/main.js`，若根目录 main.js 为产物则从原始源码迁移）
- [X] T005 将 `preload.js` 移动到 `src/preload.js`
- [X] T006 将 `utils/*.js`（autoImportTask.js, ipcInit.js, newElectronServer.js, protocol.js, upgrade.js, utils.js, zip.js）移动到 `src/utils/`
- [X] T007 删除废弃文件 `utils/zip.bundle.js`（其功能将由 esbuild 打包 `src/utils/zip.js` 取代）
- [X] T008 修正 `src/main.js` 中 `require(path.resolve(__dirname, "package.json"))` 的路径——打包后 main.js 位于根目录，`__dirname` 指向根目录，`package.json` 路径应保持 `./package.json`
- [X] T009 修正 `src/utils/upgrade.js` 中 `require("../utils/zip.bundle")` 改为 `require("./zip")`（由 esbuild 打包 adm-zip）
- [X] T010 修正 `src/utils/upgrade.js` 中 `originPath = path.join(__dirname, "../build")` 与 `raw_bspatch_bin = path.join(path.dirname(path.dirname(__dirname)), "extraResources", ...)` 的相对路径——打包后 `__dirname` 为根目录，需调整为 `path.join(__dirname, "build")` 与 `path.join(__dirname, "extraResources", ...)`
- [X] T011 修正 `src/utils/protocol.js` 中 `require("../utils/upgrade")` 与 `require("../utils/utils")` 为 `require("./upgrade")` / `require("./utils")`（源码内相对引用统一为同级）

**Checkpoint**: 源码已迁移到 `src/`，所有内部 require 路径与打包后运行时路径逻辑已修正

---

## Phase 3: User Story 1 - 零运行时依赖打包 (Priority: P1) 🎯 MVP

**Goal**: 通过 esbuild 将 lodash、iconv-lite、shell-env、adm-zip 打包进产物，清空 dependencies

**Independent Test**: 删除 node_modules 后运行 `npx electron .`，应用正常启动且所有功能可用；`package.json` 的 dependencies 为空

### Implementation for User Story 1

- [X] T012 [US1] 创建 `esbuild.config.mjs`，定义 main 入口：`entryPoints: ['src/main.js']`, `outfile: 'main.js'`, `bundle: true`, `platform: 'node'`, `format: 'cjs'`, `target: 'node18'`, `external: ['electron']`（Node.js 内置模块由 platform:node 自动 external）；支持 `--dev`/`--watch` 参数：dev 模式 `minify:false` + `sourcemap:true`，prod 模式 `minify:true`
- [X] T013 [US1] 在 `esbuild.config.mjs` 中新增 preload 入口：`entryPoints: ['src/preload.js']`, `outfile: 'preload.js'`, `external: ['electron']`
- [X] T014 [US1] 从 `package.json` 移除未使用依赖 `superagent` 与 `rawheaders2obj`（已代码验证无引用）
- [X] T015 [US1] 将 `lodash`、`iconv-lite`、`shell-env` 从 `dependencies` **移动到** `devDependencies`（构建时被 esbuild 内联打包进产物，运行时不再需要），并将 `dependencies` 置为空对象 `{}`
- [X] T016 [US1] 确认所有被 bundle 的库均在 `devDependencies`：`lodash`、`iconv-lite`、`shell-env`、`adm-zip`；⚠️ **构建必须在 `npm install`（含 devDeps）后执行**——`npm ci --omit=dev` 环境无法构建（缺构建期库），但可运行已内联依赖的构建产物
- [X] T017 [US1] 执行构建 `node esbuild.config.mjs`，验证 `main.js` 与 `preload.js` 产物生成且已 minified
- [X] T018 [US1] 验证 iconv-lite 编码功能：检查产物中 cp936 编码表已被打包（quickstart 场景 4 中的编码转换路径 `src/utils/newElectronServer.js`）
- [X] T019 [US1] 验证 shell-env ESM→CJS 转换：产物中 `shellEnv()` 调用可正常执行
- [X] T019a [US1] 验证 shell-env 在 dev 与 prod 产物中均可执行：分别用 `npm run build:dev` 与 `npm run build` 构建后触发 `src/utils/newElectronServer.js` 的 `shellEnv()` 调用，确认无 `ERR_REQUIRE_ESM`（CJS 无法直接 require ESM，必须经 esbuild 转译）
- [X] T020 [US1] 删除 node_modules 后运行 `npx electron .`，确认应用启动无 `Cannot find module` 错误（quickstart 场景 2）

**Checkpoint**: dependencies 为空，所有第三方库已内联打包，应用可在无 node_modules 情况下运行 — MVP 达成

---

## Phase 4: User Story 2 - 统一构建流程 (Priority: P2)

**Goal**: 提供单条 `npm run build` 命令完成所有文件打包压缩，替代分散的 ncc 命令

**Independent Test**: 执行 `npm run build` 一条命令后，main.js 与 preload.js 均已打包压缩输出

### Implementation for User Story 2

- [X] T021 [US2] 更新 `package.json` 的 `scripts`：`"build": "node esbuild.config.mjs"`，移除旧的 `build:main`、`build:zip` 脚本
- [X] T022 [US2] 更新 `package.json` 的 `scripts.dev`：dev 模式统一走 esbuild 产物（**不直接加载 src/**，因 shell-env 为 ESM 无法被 CJS require）。设 `"build:dev": "node esbuild.config.mjs --dev"`（sourcemap、不 minify），`"dev": "npm run build:dev && electron ."`
- [X] T023 [US2] 新增 watch 脚本 `"watch": "node esbuild.config.mjs --watch"`（esbuild context.watch 增量编译毫秒级重建）；文档说明开发方式：终端 1 运行 `npm run watch`，终端 2 运行 `electron .`（每次修改后 Cmd+R 刷新）
- [X] T024 [P] [US2] 删除废弃的 `rollup.config.js`（功能已被 esbuild.config.mjs 取代）
- [X] T025 [P] [US2] 评估并更新/删除 `build3.sh`（若其逻辑已被 npm scripts 覆盖）
- [X] T026 [US2] 从 `devDependencies` 移除 rollup 工具链：`rollup`、`rollup-plugin-terser`、`@rollup/plugin-commonjs`、`@rollup/plugin-node-resolve`、`@vercel/ncc`
- [X] T027 [US2] 执行 `npm install && npm run build`，确认单命令构建成功无错误（quickstart 场景 1），耗时 < 30 秒

**Checkpoint**: 统一构建命令可用，旧工具链已清理，US1 + US2 均正常工作

---

## Phase 5: User Story 3 - 合理的源码目录结构 (Priority: P3)

**Goal**: 源码与产物清晰分离，更新 electron-builder 配置与 .gitignore

**Independent Test**: 查看目录结构，src/ 含全部源码，产物在根目录且被 gitignore；electron-builder 打包只含产物

### Implementation for User Story 3

- [X] T028 [US3] 更新 `package.json` 中 electron-builder `build.files` 配置：确保包含 `main.js`、`preload.js`、`icon`、`build`；移除 `utils`（已打包进 main.js）
- [X] T029 [P] [US3] 更新 `.gitignore`：确认根目录构建产物 `main.js`、`preload.js` 被忽略（当前已忽略 main.js，需补充 preload.js）
- [X] T030 [P] [US3] 更新 `README.md`：说明新的目录结构（src/ 源码、根目录产物）、构建命令（npm run build / npm run dev）
- [ ] T031 [US3] 执行当前平台 electron-builder 打包（如 `npm run pack:m1`），确认打包成功且产物可运行（quickstart 场景 6）

**Checkpoint**: 目录结构清晰，electron-builder 兼容，所有三个用户故事独立可用

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: 完整功能验证与文档收尾

- [ ] T032 运行 quickstart.md 全部 6 个验证场景，确认全部通过
- [X] T033 [P] 功能冒烟测试：验证 IPC 通信、协议处理（app://、api://、apt://）、热更新（upgrade.js）、zip 解压、HTTP 请求、编码转换全部正常（SC-006）
- [X] T034 [P] 测量并记录优化前后的应用包体积对比，确认减少 ≥ 50%（SC-002）
- [ ] T035 [P] 测量冷启动时间，确认不超过优化前 110%（SC-003）
- [ ] T036 清理 `specs/001-optimize-build-bundle/backup/` 备份目录（如不再需要）
- [X] T037 更新 checklist：在 `specs/001-optimize-build-bundle/checklists/requirements.md` 标注实施完成

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖，可立即开始
- **Foundational (Phase 2)**: 依赖 Setup 完成 — **阻塞所有用户故事**
- **User Story 1 (Phase 3)**: 依赖 Foundational — MVP，无跨故事依赖
- **User Story 2 (Phase 4)**: 依赖 Foundational；US2 的构建脚本调用 US1 建立的 esbuild.config.mjs
- **User Story 3 (Phase 5)**: 依赖 Foundational；US3 的 electron-builder 配置依赖 US1 的产物结构
- **Polish (Phase 6)**: 依赖所有用户故事完成

### User Story Dependencies

- **US1 (P1)**: Foundational 后即可开始 — 核心，无其他故事依赖
- **US2 (P2)**: 逻辑上复用 US1 的 esbuild.config.mjs（T012/T013），建议在 US1 后进行
- **US3 (P3)**: 依赖 US1 的产物结构确定后进行配置对齐

### Within Each User Story

- 配置文件创建（esbuild.config.mjs）先于依赖清理
- 依赖清理先于构建验证
- 构建验证先于功能验证

### Parallel Opportunities

- Phase 1: T002、T003 可并行
- Phase 2: 路径修正 T008-T011 涉及不同文件，可部分并行（但都在同一批源码上，建议顺序以避免混淆）
- Phase 5: T029、T030 可并行
- Phase 6: T033、T034、T035 可并行

---

## Parallel Example: Phase 1 Setup

```bash
# T002 与 T003 可同时进行：
Task: "npm install -D esbuild"
Task: "备份 package.json / rollup.config.js / build3.sh 到 backup/"
```

## Parallel Example: Phase 6 Polish

```bash
# T033、T034、T035 可并行验证：
Task: "功能冒烟测试（IPC/协议/热更新/zip/HTTP/编码）"
Task: "测量包体积对比（目标 -50%）"
Task: "测量冷启动时间（目标 ≤110%）"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. 完成 Phase 1: Setup（目录 + esbuild）
2. 完成 Phase 2: Foundational（源码迁移 + 路径修正）— **关键，阻塞所有故事**
3. 完成 Phase 3: User Story 1（零依赖打包）
4. **停止并验证**：删除 node_modules 后应用正常运行，dependencies 为空
5. 达成 MVP，可交付

### Incremental Delivery

1. Setup + Foundational → 源码结构就绪
2. US1（零依赖打包）→ 独立验证 → MVP 交付
3. US2（统一构建流程）→ 独立验证 → 交付
4. US3（目录结构 + 打包配置）→ 独立验证 → 交付
5. Polish → 完整验证与文档

---

## Notes

- 本项目为单人可完成的模板优化，任务基本呈线性依赖（源码迁移 → 打包配置 → 脚本 → 打包配置对齐）
- ⚠️ **最高风险**：T010 中 upgrade.js 的 `__dirname` 相对路径——务必在 T017 构建后实测 `build/` 与 `extraResources/` 路径解析正确
- [P] 标记的任务操作不同文件，无相互依赖
- 每完成一个 Phase 建议 git commit
- 可在任意 Checkpoint 停下验证故事独立性
