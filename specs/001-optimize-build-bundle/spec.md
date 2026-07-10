# Feature Specification: Electron 项目构建打包优化

**Feature Branch**: `001-optimize-build-bundle`

**Created**: 2026-07-10

**Status**: Draft

**Input**: User description: "这个是一个electron 项目模版文件，创建一个优化方案，对项目代码结构进行合理优化，希望通过增加devDependencies 完成项目相关js的打包压缩，dependencies 尽量不要有依赖。"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 零运行时依赖打包 (Priority: P1)

作为模板使用者，我希望最终构建的 Electron 应用在运行时不依赖任何 node_modules 中的第三方包，所有依赖在构建时被打包进产物，从而减小应用体积、加快启动速度、避免依赖安装问题。

**Why this priority**: 这是核心目标——将 dependencies 中的运行时依赖（lodash、iconv-lite、superagent、shell-env、rawheaders2obj）全部通过构建工具打包到产物中，彻底消除运行时外部依赖。

**Independent Test**: 删除 node_modules 目录后，使用构建产物可以正常启动 Electron 应用并完成所有功能。

**Acceptance Scenarios**:

1. **Given** 项目已完成构建, **When** 删除 node_modules 并运行 `electron .`, **Then** 应用正常启动且所有功能可用
2. **Given** package.json 的 dependencies 字段, **When** 查看其内容, **Then** 字段为空或不存在
3. **Given** 构建后的产物, **When** 检查文件内容, **Then** 所有第三方库代码已被内联打包

---

### User Story 2 - 统一构建流程 (Priority: P2)

作为开发者，我希望有一个清晰统一的构建流程，通过一条命令完成所有 JS 文件（main process、preload、utils）的打包压缩，不再依赖分散的 ncc 命令。

**Why this priority**: 统一构建流程能降低模板使用门槛，减少出错可能，提高开发体验。

**Independent Test**: 执行单条构建命令后，所有入口文件均已被打包压缩，输出到指定目录。

**Acceptance Scenarios**:

1. **Given** 开发者修改了源码, **When** 执行 `npm run build`, **Then** main.js、preload.js 及所有 utils 被打包压缩到产物目录
2. **Given** 构建完成, **When** 查看产物文件, **Then** 代码已被压缩混淆且不包含注释
3. **Given** 首次使用模板, **When** 执行 `npm install && npm run build`, **Then** 构建成功无错误

---

### User Story 3 - 合理的源码目录结构 (Priority: P3)

作为开发者，我希望源码和产物有清晰分离的目录结构，源码放在 `src/` 目录下，构建产物放在项目根目录或指定输出目录，方便理解和维护。

**Why this priority**: 清晰的目录结构让开发者一目了然，便于维护和扩展模板。

**Independent Test**: 查看目录结构，源码和产物文件有明确区分，不混在同一层级。

**Acceptance Scenarios**:

1. **Given** 项目目录结构, **When** 查看根目录, **Then** 存在 `src/` 目录包含所有源码文件
2. **Given** `src/` 目录, **When** 查看其内容, **Then** 包含 main 进程入口、preload 脚本、utils 工具模块
3. **Given** electron-builder 配置, **When** 执行打包, **Then** 只包含构建产物，不包含源码

---

### Edge Cases

- 原生 Node.js 模块（如果未来引入）需要特殊处理，不能被 bundle
- `electron` 模块必须始终作为 external 排除
- Node.js 内置模块（fs、path、net 等）必须作为 external 排除
- `shell-env` 使用 ESM 格式（v2.0.0），需要确保构建工具能正确处理 CJS/ESM 混合场景
- `iconv-lite` 包含动态 require 加载编码表，需要确保构建后编码功能正常
- preload.js 运行在渲染进程沙箱中，打包配置需要与 main process 区分

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 构建系统 MUST 将所有当前 dependencies（lodash、iconv-lite、superagent、shell-env、rawheaders2obj）打包进产物，使 dependencies 字段为空
- **FR-002**: 构建系统 MUST 将 `electron` 和所有 Node.js 内置模块标记为 external
- **FR-003**: 构建系统 MUST 对产物进行代码压缩和 tree-shaking 以减小体积
- **FR-004**: 源码 MUST 从根目录迁移到 `src/` 目录下（包括 main.js → src/main.js, preload.js → src/preload.js, utils/ → src/utils/）
- **FR-005**: 构建系统 MUST 提供统一的构建命令，一次性完成所有文件的打包
- **FR-006**: 构建系统 MUST 支持开发模式，可以直接运行源码进行调试
- **FR-007**: 构建产物 MUST 输出到项目根目录或指定输出位置，保持与 electron-builder 配置兼容
- **FR-008**: 所有新增的构建工具 MUST 作为 devDependencies 安装
- **FR-009**: 构建系统 MUST 正确处理 `iconv-lite` 的动态编码表加载
- **FR-010**: 构建系统 MUST 正确处理 `adm-zip`（zip.js 的依赖），将其打包进产物

### Key Entities

- **源码目录 (src/)**: 包含所有可编辑的源代码文件，开发者日常工作的目录
- **构建产物**: 经过打包压缩的最终 JS 文件，供 Electron 运行时加载
- **构建配置**: 定义打包规则的配置文件（rollup/esbuild 等），属于开发依赖
- **electron-builder 配置**: 定义应用打包分发的配置，需与构建产物目录对齐

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: package.json 的 dependencies 字段为空对象或不存在
- **SC-002**: 构建后的应用包体积相比当前（包含 node_modules）减少 50% 以上
- **SC-003**: 应用冷启动时间不超过当前版本的 110%（不因打包引入性能退化）
- **SC-004**: 执行一条构建命令即可完成所有产物生成，耗时不超过 30 秒
- **SC-005**: 开发者从克隆模板到首次成功构建不超过 5 分钟（含安装依赖）
- **SC-006**: 构建产物中的所有功能（IPC 通信、协议处理、热更新、zip 解压、HTTP 请求、编码转换）100% 正常工作

## Assumptions

- 当前项目中 `shell-env@2.0.0` 为 ESM 包，构建工具需要能处理 ESM→CJS 转换
- `adm-zip` 是纯 JS 实现，可以安全地被 bundle 打包
- 不存在需要 node-gyp 编译的原生模块，所有依赖均为纯 JavaScript
- `iconv-lite` 的编码表可通过构建工具的动态 require 处理机制正确打包
- 开发模式下可以直接运行 `src/` 下的源码（通过 electron 直接加载）
- 模板使用者具备基本的 Node.js 和 npm 使用经验
- 构建工具选择优先考虑已在项目中存在的 rollup，或更现代高效的 esbuild
