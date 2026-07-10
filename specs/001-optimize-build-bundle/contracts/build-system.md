# 构建系统契约

## 构建入口契约

构建系统必须处理以下入口点，输出到对应位置：

| 源文件 | 产物位置 | 格式 | External |
|--------|----------|------|----------|
| `src/main.js` | `main.js` | CJS, minified | electron, Node.js builtins |
| `src/preload.js` | `preload.js` | CJS, minified | electron |

## npm scripts 契约

优化后的 package.json scripts 必须保证以下命令可用：

| 命令 | 行为 |
|------|------|
| `npm run build` | 打包压缩所有入口文件，输出产物 |
| `npm run dev` | 启动开发模式（watch + electron） |
| `npm run pack:m1` | electron-builder macOS ARM64 打包 |
| `npm run pack:intel` | electron-builder macOS x64 打包 |
| `npm run pack:win64` | electron-builder Windows x64 打包 |
| `npm run pack:win32` | electron-builder Windows ia32 打包 |
| `npm run pack:linux` | electron-builder Linux x64 打包 |
| `npm run pack:linuxarm` | electron-builder Linux ARM64 打包 |

## electron-builder files 契约

electron-builder 的 `files` 配置必须包含以下构建产物：

```json
{
  "files": [
    "main.js",
    "preload.js",
    "icon",
    "build"
  ]
}
```

**注意**: `utils` 目录不再需要包含在 files 中，因为所有 utils 代码已被打包进 `main.js`。

## 依赖契约

| 类别 | 包含 |
|------|------|
| `dependencies` | `{}` (空) |
| `devDependencies` | esbuild, electron, electron-builder, adm-zip (构建时被 bundle) |

## preload API 契约 (不变)

preload.js 暴露的 `window.app` 和 `window.versions` 接口保持不变，不受构建优化影响。
