const { shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const utils = require("./utils");
const { updateBuild, getBuildVersion } = require("./upgrade");
var timeoutId = 0; // Set timeout id

const ipcAppInit = (app, ipcMain) => {
  // Get the version number
  ipcMain.handle("appVersion", async () => {
    return {
      app: app.getVersion(),
      upgrade: global?.upgrade?.buildVersion,
      build: global?.upgrade?.buildPath,
    };
  });
  // Exit
  ipcMain.handle("appQuit", async () => {
    app.quit();
    app.exit(0);
  });
  // Restart
  ipcMain.handle("appRestart", async (event) => {
    app.relaunch({ args: process.argv.slice(1).concat(['--relaunch']) });
    app.exit(0);
  });
  // Open link
  ipcMain.handle("openLink", async (event, url) => {
    let isValid = false;
    try {
      let urlObj = new URL(url);
      if (urlObj.protocol == "http:" || urlObj.protocol == "https:") {
        isValid = true;
      }
    } catch (_) {}
    if (!isValid) {
      console.error("Invalid URL:", url);
      return Promise.reject(`Invalid URL:${url}`);
    }
    return shell.openExternal(url);
  });
  //install
  ipcMain.handle("install", async (event, file_path) => {
    console.log("install", file_path);
    if (!file_path || !fs.existsSync(file_path)) {
      return Promise.reject("Invalid file path");
    }
    if (process.platform === "darwin") {
      shell.openExternal(`file://${file_path}`).then(function () {
        app.exit(0);
      });
    } else {
      shell.openPath(file_path).then(function () {
        app.exit(0);
      });
    }
  });
  // Hot Update
  ipcMain.handle("hotUpdate", async (event, version, hotUrl, diffUrl) => {
    console.log("hotUpdate", version, hotUrl, diffUrl);
    return updateBuild(version, hotUrl, diffUrl);
  });
  // Open a folder and return the result
  ipcMain.handle("openFolder", async (event, folderName) => {
    const userPath = path.join(app.getPath("userData"), folderName);
    try {
      const stats = await fs.promises.stat(userPath);
      if (stats.isDirectory()) {
        shell.openPath(userPath);
        return Promise.resolve("Folder opened successfully");
      } else {
        return Promise.reject("Path exists, but it's not a folder");
      }
    } catch (err) {
      if (err.code === "ENOENT") {
        try {
          await fs.promises.mkdir(userPath, { recursive: true });
          shell.openPath(userPath);
          return Promise.resolve("Folder created successfully");
        } catch (err2) {
          return Promise.reject(`Failed to create folder:${userPath}, ${err2}`);
        }
      }
    }
  });
  // Open a file
  ipcMain.handle("openFile", async (event, filePath) => {
    console.log(`open file ${filePath}`);
    try {
      shell.showItemInFolder(filePath);
    } catch (err) {
      return Promise.reject(`openFile ${err}`);
    }
  });
  // Fetch remote text
  ipcMain.handle("getRemoteText", async (event, url, headers) => {
    console.log(`getRemoteText ${url}`);
    return utils.getRemoteText(url, headers);
  });
  // User Data Directory
  ipcMain.on("getUserDataPath", (event) => {
    event.returnValue = app.getPath("userData");
  });
  ipcMain.on("getTempPath", (event) => {
    event.returnValue = app.getPath("temp");
  });
  ipcMain.on("getDownloadsPath", (event) => {
    event.returnValue = app.getPath("downloads");
  });
  ipcMain.on("getLogsPath", (event) => {
    event.returnValue = app.getPath("logs");
  });
  ipcMain.on("getCrashPath", (event) => {
    event.returnValue = app.getPath("crashDumps");
  });
  // Query tasks
  ipcMain.on("getAutoImport", (event) => {
    event.returnValue = app.AutoImportTask.queryNextInvocations();
  });
  // Query hot update version
  ipcMain.on("getBuildVersion", (event) => {
    event.returnValue = getBuildVersion();
  });
  ipcMain.on("getShellVersion", (event) => {
    event.returnValue = app.getVersion();
  });
  // Get default language
  ipcMain.on("getLocale", (event) => {
    event.returnValue = app.getLocale();
  });
  ipcMain.on("getRegion", (event) => {
    event.returnValue = global.initRegion;
  });
  ipcMain.on("getSystemRegion", (event) => {
    event.returnValue = app.getLocaleCountryCode();
  });
  ipcMain.on("getIsThemeDark", (event) => {
    event.returnValue = global.isThemeDark;
  });
  // Initialize tasks
  ipcMain.handle("initAutoImport", async (event, taskList) => {
    taskList.forEach((task) => app.AutoImportTask.addOrUpdateTask(task));
    app.AutoImportTask.cleanUp(taskList);
  });

  // Simulate crash
  ipcMain.handle("doCrash", async (event) => {
    process.crash();
  });

  ipcMain.handle("setRedirect", async (event, url, redirectUrl) => {
    if (!url || !redirectUrl) {
      return Promise.reject("Invalid parameters");
    }
    url = utils.clearUrlQuery(url);
    redirectUrl = utils.clearUrlQuery(redirectUrl);
    // If the redirect URL does not contain a protocol, add "app://localhost"
    if (redirectUrl.indexOf("://") < 0) {
      if (redirectUrl.startsWith("/")) {
        redirectUrl = `${app.originUrl}${redirectUrl}`;
      } else {
        redirectUrl = `${app.originUrl}/${redirectUrl}`;
      }
    }
    console.log(`setRedirect, url: ${url}, redirectUrl: ${redirectUrl}`);
    if (typeof app?.RedirectMap === "object") {
      app.RedirectMap[url] = redirectUrl;
    } else {
      app.RedirectMap = {};
      app.RedirectMap[url] = redirectUrl;
    }
    return Promise.resolve(app?.RedirectMap);
  });
};

const ipcWindowInit = (mainWindow, ipcMain, app) => {
  // Function to safely register handle, removing any previous registrations
  function safeHandle(channel, listener) {
    // Register a new handler
    ipcMain.removeHandler(channel); //Deregister the old one to prevent duplicate registrations
    ipcMain.handle(channel, listener);
  }
  // Open devTools
  safeHandle("openDevTools", async (event) => {
    mainWindow.webContents.openDevTools();
  });
  safeHandle("toggleDevTools", async (event) => {
    mainWindow.webContents.toggleDevTools();
  }); //toggle
  // Minimize
  safeHandle("miniWindow", async (event) => {
    mainWindow.minimize();
  });
  // Maximize
  safeHandle("maxWindow", async (event) => {
    mainWindow.maximize();
  });
  // Scale
  safeHandle("scaleWindow", async (event) => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });
  safeHandle("hideWindow", async (event) => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      console.log("window is hidden");
    }
  });
  // Close the window
  safeHandle("closeWindow", async (event) => {
    if (mainWindow && mainWindow.isClosable()) {
      mainWindow.close(); // Close the window
    }
  });

  safeHandle("activeWindow", async (event) => {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();

    // For macOS, you can add this line
    if (process.platform === "darwin") {
      app.focus({ steal: true });
    }
  });

  // Force close the window
  safeHandle("forceCloseWindow", async (event, cfg) => {
    //win has a tray, handle it according to the user
    if (process.platform == "win32") {
      if (cfg?.isTray > 0) {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        }
      } else {
        // Destroy the window directly
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.destroy();
        }
        console.log("quit by forceCloseWindow");
        app.quit(); // Force exit
      }
      return;
    }

    // Destroy the window directly in other cases
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
    }
    if (cfg?.isTray < 0) {
      console.log("quit by not tray");
      app.quit();
    }
  });

  // Cancel exit, requires window operation
  safeHandle("cancelQuit", async (event) => {
    if (app?.DelayQuitTimeId > 0) {
      clearTimeout(app.DelayQuitTimeId);
      app.DelayQuitTimeId = 0;
      console.log("receive cancel quit and cancel ok");
    } else {
      console.log("receive cancel quit");
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.show();
    }
  });

  // Register random upgrade
  console.log("regiester new timeout");
  checkUpdate(mainWindow, 20);

  // Register a new callback function
  app.AutoImportTask.setCallBack((data, nextInvocation) => {
    if (mainWindow.isDestroyed()) {
      console.log("task mainWindow is distory");
    } else {
      console.log("autoImport", data, nextInvocation);
      mainWindow.webContents.send("autoImport", data, nextInvocation);
    }
  });
};

const checkUpdate = (mainWindow, timeout) => {
  if (timeout && timeout > 0) {
    //timeout ok
  } else {
    timeout = Math.floor(Math.random() * 3600 + 1800); // Within the range of 30 minutes to 1 hour and 30 minutes
  }

  if (timeoutId > 0) {
    clearTimeout(timeoutId);
    // Clear old timer
  }

  console.log("wait " + timeout + "s");
  timeoutId = setTimeout(() => {
    console.log("send checkUpdate, wait by" + timeout + "s");
    if (mainWindow.isDestroyed()) {
      console.log("mainWindow is distory");
    } else {
      mainWindow.webContents.send("checkUpdate", timeout);
    }
    checkUpdate(mainWindow); //recursive call
  }, timeout * 1000);
};

module.exports = { ipcAppInit, ipcWindowInit };
