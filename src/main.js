const {
  app,
  BrowserWindow,
  screen,
  protocol,
  ipcMain,
  Tray,
  Menu,
  crashReporter,
  globalShortcut,
  nativeTheme
} = require("electron");
const path = require("node:path");
const userDataDir = app.getPath("userData"); // Get user directory
const appVersion = app.getVersion(); //Get original version
global.userDataDir = userDataDir; //Set as global
global.appVersion = appVersion; //Set version as global
global.isThemeDark = nativeTheme.shouldUseDarkColors;
global.initRegion = "";
try {
  const packageJson = require(path.resolve(__dirname, "package.json"));
  global.initRegion = packageJson?.initRegion ? packageJson.initRegion : (packageJson?.build?.extraMetadata?.initRegion ? packageJson.build.extraMetadata.initRegion : "");
} catch (e) { }

const {
  appHandler,
  apiHandler,
  aptHandler,
  protocolSchemes,
} = require("./utils/protocol");
const utils = require("./utils/utils");
const { ipcAppInit, ipcWindowInit } = require("./utils/ipcInit");
const { initElectronServer } = require("./utils/newElectronServer");
const AutoImportTask = require("./utils/autoImportTask"); //Scheduled Task

// Optimize request speed
app.commandLine.appendSwitch('max-connections-per-host', '20'); // Default 6

// Enable crash capture and error listening
crashReporter.start({
  submitURL: "",
  uploadToServer: false, // Do not upload to server
  ignoreSystemCrashHandler: false,
});
app.on("render-process-gone", (event, webContents, details) => {
  console.warn("app:render-process-gone", event, webContents, details);
});
app.on("child-process-gone", (event, details) => {
  console.warn("app:child-process-gone", event, details);
});

const forceQuit = () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy(); //Forced destruction to prevent interception.
  }
  app.quit();
};
//Create a tray in the window
const showWindow = () => {
  if (mainWindow === null) {
    createWindow();
    mainWindow.show();
  } else {
    if (mainWindow.isDestroyed()) {
      createWindow();
    } else {
      mainWindow.show();
    }
  }
};

let isShortcutRegistered = false; // Used to track whether the shortcut key has been registered
function registerShortcut() {
  if (process.platform == "darwin" && !isShortcutRegistered) {
    globalShortcut.register("CommandOrControl+Q", forceQuit);
    isShortcutRegistered = true;
  }
}

function unregisterShortcut() {
  if (process.platform == "darwin") {
    globalShortcut.unregister("CommandOrControl+Q");
    isShortcutRegistered = false;
  }
}

//Registration of New Protocol Specifications
protocol.registerSchemesAsPrivileged(protocolSchemes);

let mainWindow = null; //Create Window
let tray = null; //Tray
const createWindow = () => {
  //Size
  let size = { width: 1080, height: 720 };
  let originSize; //Original size
  try {
    size = screen.getPrimaryDisplay().workAreaSize || size;
    originSize = size;
    if (size.width > 1800) {
      size.width = parseInt(size.width * 0.25) * 2; //Ensure even numbers
      size.height = parseInt(size.height * 0.4) * 2;
    }
  } catch (e) { }
  //title
  let _titleBarStyle = "default";
  if (process.platform === "darwin") {
    _titleBarStyle = "hiddenInset";
  } else if (process.platform === "win32") {
    _titleBarStyle = "hidden";
  }
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: 960,
    minHeight: 640,
    titleBarStyle: _titleBarStyle,
    frame: false,
    resizable: true, // Allow resizing
    webPreferences: {
      spellcheck: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  //cross-domain
  mainWindow.webContents.session.webRequest.onHeadersReceived(
    (details, callback) => {
      const headers = details.responseHeaders;
      if (
        headers["access-control-allow-origin"] ||
        headers["Access-Control-Allow-Origin"]
      ) {
        //already has cross-domain settings configured
        callback({ cancel: false });
      } else {
        callback({
          cancel: false,
          responseHeaders: {
            ...headers,
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      }
    }
  );

  mainWindow.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const redirectMap = app?.RedirectMap || {};
    if (Object.keys(redirectMap).length < 1) {
      callback({});
      return;
    }

    const url = utils.clearUrlQuery(details.url);
    if (!redirectMap[url]) {
      callback({});
      return;
    }
    let redirectUrl = redirectMap[url];

    delete redirectMap[url];
    const query = utils.getUrlQuery(details.url);
    if (query) {
      redirectUrl += "?" + query;
    }
    callback({ redirectURL: redirectUrl });
  });

  //Prevent certificate issues.
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    (details, callback) => {
      details.requestHeaders["RejectUnauthorized"] = "false";
      callback({ cancel: false, requestHeaders: details.requestHeaders });
    }
  );

  mainWindow.webContents.session.setCertificateVerifyProc(
    (request, callback) => {
      callback(0); // 0 indicates that certificate errors should be ignored
    }
  );

  nativeTheme.on('updated', () => {
    global.isThemeDark = nativeTheme.shouldUseDarkColors;
    try {
      mainWindow.webContents.send("onTheme", global.isThemeDark);
    } catch (e) { }
  });

  const [loadUrl, devMode] = utils.getEnterPoint();

  // loading index.html
  mainWindow.loadURL(`${loadUrl}`);
  app.originUrl = utils.getOriginUrl(loadUrl);

  //Handle window size
  utils.restoreWindowSize(app.getPath("userData"), mainWindow, originSize);
  // Save window size when the window is closed
  mainWindow.on("close", (event) => {
    try {
      mainWindow.webContents.send("onClose", utils.getCloseCfg(userDataDir)); //Send exit message to the rendering process
      event.preventDefault(); //Do not execute exit

      // Exit after waiting for 3 seconds to prevent being unable to exit. If the webpage receives the message and handles it on its own, it needs to cancel the exit
      if (app?.DelayQuitTimeId > 0) {
        clearTimeout(app.DelayQuitTimeId); //Clear the existing timer
        app.DelayQuitTimeId = 0;
      }
      app.DelayQuitTimeId = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.destroy();
        }
      }, 500); //Force exit after a delay of 500ms
      //Check if the window is visible
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
      }
    } catch (e) { }

    const bounds = mainWindow.getBounds();
    utils.saveWindowSize(userDataDir, bounds);
  });

  // Open the developer tools
  if (devMode) {
    mainWindow.webContents.openDevTools();
  }
  ipcWindowInit(mainWindow, ipcMain, app); //Window-related message handling

  // Send a message to the rendering process when the window has finished loading
  mainWindow.webContents.on("did-finish-load", () => {
    const appVersion = mainWindow.webContents.executeJavaScript(
      "window.__APP_VERSION__"
    );
    const buildDate = mainWindow.webContents.executeJavaScript(
      "window.__BUILD_DATE__"
    );

    appVersion
      .then((version) => {
        console.log(`App Version: ${version}`);
      })
      .catch((err) => {
        console.error("Failed to get app version:", err);
      });

    buildDate
      .then((date) => {
        console.log(`Build Date: ${date}`);
      })
      .catch((err) => {
        console.error("Failed to get build date:", err);
      });
  });

  mainWindow.webContents.on("context-menu", (event, params) => {
    const template = [];

    // Check if clicked inside the input box.
    template.push({ role: "selectAll" });
    template.push({ role: "copy" });
    if (params.isEditable) {
      template.push({ role: "cut" }, { role: "paste" });
    }
    const menu = Menu.buildFromTemplate(template);
    menu.popup(mainWindow);
  });
};

// app.requestSingleInstanceLock() is used to check if this is the first instance. If it is not, the first instance is brought to focus and the current instance is closed
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    // When attempting to open the second instance, we should focus on mainWindow
    try {
      if (typeof mainWindow === "object") {
        if (mainWindow.isDestroyed()) {
          createWindow(); //The window has been destroyed; create it actively
          return;
        }
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
        mainWindow.show();
      }
    } catch (err) { }
  });

  // This code will be called when Electron finishes initialization
  // and creates the browser window.
  // Some APIs can only be used after the ready event is triggered.
  app.whenReady().then(() => {
    protocol.registerFileProtocol("app", appHandler, (error) => {
      if (error) console.error("Failed to register protocol");
    });

    protocol.registerBufferProtocol("api", apiHandler, (error) => {
      if (error) console.error("Failed to register protocol");
    });

    protocol.registerStreamProtocol("apt", aptHandler, (error) => {
      if (error) console.error("Failed to register protocol");
    });

    // Init Electron service
    initElectronServer();

    if (!global.initRegion) {
      global.initRegion = app.getLocaleCountryCode();
    }

    app.AutoImportTask = new AutoImportTask(); //Create a task object
    ipcAppInit(app, ipcMain);

    // createWindow
    createWindow();

    if (process.platform == "win32") {
      createTray(); //Create a tray for the window
    }

    app.on("activate", () => {
      // On macOS, if there are no open application windows,
      // clicking the tray icon will usually create a new window.
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
        }
      }
    });
    // Handle focus changes for other windows
    app.on("browser-window-focus", () => {
      registerShortcut();
    });

    app.on("browser-window-blur", () => {
      unregisterShortcut();
    });
  });

  // Except for macOS, the program exits when all windows are closed. On Windows, the tray remains open and does not exit.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll(); //Unregister all keyboard shortcuts
  });
}

//window Tray (Win32 only)
const createTray = () => {
  const iconPath = path.join(__dirname, "icon/app.ico");
  tray = new Tray(iconPath);

  tray.setToolTip(" My App ");

  const contextMenu = Menu.buildFromTemplate([
    { label: "  Main window  ", click: showWindow },
    {
      label: "  Force Quit  ",
      click: forceQuit,
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("click", showWindow);
};
