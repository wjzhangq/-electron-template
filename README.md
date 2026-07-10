# Electron Template

A production-ready Electron shell template extracted from a mature application. Provides custom protocols, hot update, cross-platform window management, IPC bridge, and a multi-platform build script — all wired up and ready to use.

## What this template provides

- **Custom protocols**: `app://` (static file server from `work.asar`), `apt://` (SSE-capable RPC dispatcher), `api://` (reverse proxy)
- **Hot update**: Download new `work.asar` → extract → restart; version rollback protection included
- **Cross-platform window**: `titleBarStyle` auto-selects per platform; Win32 tray with configurable close behavior
- **One-shot redirect map**: `window.app.setRedirect(from, to)` — single-use URL redirect via `onBeforeRequest`
- **IPC bridge**: Full `window.app.*` and `window.versions.*` API exposed via `contextBridge` in `preload.js`
- **safeHandle pattern**: Duplicate IPC handler registration is safe (window recreate scenarios)
- **AutoImportTask**: Lightweight `setInterval` scheduler with add/update/cleanUp
- **Embedded script runner**: IPC socket server that executes local scripts (node, python, go, php, etc.)
- **Build script**: Multi-platform × multi-arch × multi-lang packaging with optional Mac notarytool / Win signing

## Directory structure

Source lives in `src/`; the build (esbuild) emits bundled, minified `main.js` and
`preload.js` to the repository root. Those root artifacts are gitignored — all
third-party runtime dependencies are inlined into them, so `dependencies` in
`package.json` stays empty.

```
electron-template/
  src/                       # ✨ Source (edit here)
    main.js                  # Main process — window, protocols, tray, IPC wiring
    preload.js               # contextBridge — window.app.* and window.versions.*
    utils/
      protocol.js            # app:// + api:// + apt:// handlers; add RPC methods here
      ipcInit.js             # All IPC channels (safeHandle + app + window level)
      utils.js               # Shared utilities: EventConvertResult, HttpConvertResult, PromiseQueue, etc.
      upgrade.js             # Hot update: download → extract → write upgrade.json → restart
      autoImportTask.js      # setInterval scheduler
      newElectronServer.js   # IPC socket server for running local scripts
      zip.js                 # AdmZip wrapper (source)
  esbuild.config.mjs         # ✨ Unified build config (main + preload entries)
  main.js                    # 🔨 Build artifact (gitignored)
  preload.js                 # 🔨 Build artifact (gitignored)
  package.json               # Customize: name, productName, appId, version, copyright
  build3.sh                  # Multi-platform build script
  .gitignore
  icon/
    app.icns                 # Replace with your branded macOS icon
    app.ico                  # Replace with your branded Windows icon
    app.png                  # Replace with your branded Linux icon (256×256)
  build/
    work.asar/
      index.html             # Placeholder frontend — replace with your bundle
  extraResources/            # Place bspatch binaries here for hot update diff patches
    darwin_x64/
    darwin_arm64/
    win32_x64/
    win32_ia32/
    linux_x64/
    linux_arm64/
```

## Build commands

| Command | What it does |
|---------|--------------|
| `npm run build` | Production build — bundles + minifies `src/main.js` and `src/preload.js` to root |
| `npm run build:dev` | Dev build — no minification, with sourcemaps |
| `npm run watch` | Watch mode — incremental rebuild on source change |
| `npm run dev` | `build:dev` then launch `electron .` |

> **Note**: `shell-env` is an ESM-only package, so you cannot run `electron src/main.js`
> directly (CommonJS cannot `require` ESM). Development always runs the esbuild
> artifact, which transpiles ESM → CJS. For a fast edit loop, run `npm run watch`
> in one terminal and `electron .` in another, pressing Cmd/Ctrl+R to reload after
> each rebuild.
>
> The build must run after `npm install` (with devDependencies present) — the bundled
> libraries are build-time only. A `npm ci --omit=dev` environment cannot build, but it
> can run an already-built artifact.

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Replace icon/app.* with your branded icons

# 3. Update package.json:
#    - name, productName, appId, version, copyright

# 4. Put your frontend build into build/work.asar/
#    (or develop with npm start which loads from localhost:3000)

# 5. Run in dev mode (builds src/ then launches electron)
npm run dev

# 6. Build production artifacts
npm run build

# 7. Package
./build3.sh -p mac -a arm
```

## Adding apt:// RPC methods

Edit `src/utils/protocol.js` and add handlers to the `handlers` object inside `aptHandler`:

```js
// JSON response
handlers['myMethod'] = async (buf, stream) => {
  const data = JSON.parse(buf);
  stream.push(HttpConvertResult({ result: data }));
  stream.push(null);
};

// SSE streaming response
handlers['myStream'] = async (buf, stream) => {
  for (const item of items) {
    if (stream._is_close) break;
    stream.push(EventConvertResult(item, 'data'));
  }
  stream.push(EventConvertResult({ done: true }, 'complete'));
  stream.push(null);
};
```

**Helper functions** (from `src/utils/utils.js`):
- `EventConvertResult(data, event)` — formats SSE frame: `event: xxx\ndata: ...\n\n`
- `HttpConvertResult(data)` — formats JSON response: `{code, msg, data}`
  - String with `@code` suffix → `{code, msg}` (e.g. `"not found@404"`)
  - Object → `{code: 0, data: object}`

**Built-in handlers**: `callFunction` (vm sandbox, POST `{context, text}`), `download` (file download with progress SSE), `fetch` (reverse proxy via `origin-url` header)

## Hot update flow

Frontend calls `window.app.hotUpdate(version, hotUrl)`, which triggers:
1. Main process downloads `hotUrl` → saves as `hot.zip` in `userData/upgrade/build_{version}/`
2. Extracts `work.asar` from the zip
3. Writes `upgrade.json` with `{buildPath, buildVersion, appVersion}`
4. App restarts; `getBuildPath()` reads `upgrade.json` and loads the new `work.asar`
5. Rollback: if `appVersion` mismatches or `work.asar/index.html` is missing, `upgrade.json` is deleted and the bundled build is used

## Build and signing

```bash
./build3.sh -p <platform> -a <arch> [-l <lang>] [-s]

# Examples
./build3.sh -p mac -a arm -s              # macOS arm64, signed
./build3.sh -p win -p mac -a x64 -a arm  # all four combos, unsigned
```

The script reads `window.__APP_VERSION__` from `build/work.asar/index.html` as the output version. Your frontend build must set this global.

**Mac signing**: requires a Keychain credential matching your app's `name` field in `package.json`:
```bash
xcrun notarytool store-credentials "my-electron-app" --apple-id ... --team-id ...
```

**Windows signing**: set `WIN_SIGN_URL` to your signing service endpoint:
```bash
WIN_SIGN_URL=http://sign.internal/upload ./build3.sh -p win -a x64 -s
```
The service must accept `POST multipart/form-data` with `file=@<path>` and return the signed binary (must be > 10 MB).

## Customization points

| What | Where |
|------|-------|
| App name / appId / version | `package.json` → `name`, `productName`, `appId`, `version` |
| Tray tooltip | `src/main.js` → `createTray()` → `tray.setToolTip(...)` |
| Window min size | `src/main.js` → `createWindow()` → `minWidth`, `minHeight` |
| RPC methods | `src/utils/protocol.js` → `handlers` object |
| userData subdirectory | `src/utils/ipcInit.js` → `openFolder` handler |
| Supported locales | `build3.sh` → `validate_lang()` + `-l` flag |
| Script runner languages | `src/utils/newElectronServer.js` → `langCommandMap` |
