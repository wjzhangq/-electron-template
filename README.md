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

```
electron-template/
  main.js                    # Main process — window, protocols, tray, IPC wiring
  preload.js                 # contextBridge — window.app.* and window.versions.*
  package.json               # Customize: name, productName, appId, version, copyright
  rollup.config.js           # Bundle config for utils
  build3.sh                  # Multi-platform build script
  .gitignore
  icon/
    app.icns                 # Replace with your branded macOS icon
    app.ico                  # Replace with your branded Windows icon
    app.png                  # Replace with your branded Linux icon (256×256)
  build/
    work.asar/
      index.html             # Placeholder frontend — replace with your bundle
  utils/
    protocol.js              # app:// + api:// + apt:// handlers; add RPC methods here
    ipcInit.js               # All IPC channels (safeHandle + app + window level)
    utils.js                 # Shared utilities: EventConvertResult, HttpConvertResult, PromiseQueue, etc.
    upgrade.js               # Hot update: download → extract → write upgrade.json → restart
    autoImportTask.js        # setInterval scheduler
    newElectronServer.js     # IPC socket server for running local scripts
    zip.js                   # AdmZip wrapper (source)
  extraResources/            # Place bspatch binaries here for hot update diff patches
    darwin_x64/
    darwin_arm64/
    win32_x64/
    win32_ia32/
    linux_x64/
    linux_arm64/
```

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Replace icon/app.* with your branded icons

# 3. Update package.json:
#    - name, productName, appId, version, copyright

# 4. Put your frontend build into build/work.asar/
#    (or develop with npm start which loads from localhost:3000)

# 5. Run in dev mode
npm run dev

# 6. Package
./build3.sh -p mac -a arm
```

## Adding apt:// RPC methods

Edit `utils/protocol.js` and add handlers to the `handlers` object inside `aptHandler`:

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

**Helper functions** (from `utils/utils.js`):
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
| Tray tooltip | `main.js` → `createTray()` → `tray.setToolTip(...)` |
| Window min size | `main.js` → `createWindow()` → `minWidth`, `minHeight` |
| RPC methods | `utils/protocol.js` → `handlers` object |
| userData subdirectory | `utils/ipcInit.js` → `openFolder` handler |
| Supported locales | `build3.sh` → `validate_lang()` + `-l` flag |
| Script runner languages | `utils/newElectronServer.js` → `langCommandMap` |
