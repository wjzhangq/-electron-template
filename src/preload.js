const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("versions", {
  node: () => process.versions.node,
  chrome: () => process.versions.chrome,
  electron: () => process.versions.electron,
  // In addition to functions, we can also expose variables. 
});

contextBridge.exposeInMainWorld("app", {
  appVersion: () => ipcRenderer.invoke("appVersion"),
  appQuit: () => ipcRenderer.invoke("appQuit"),
  appRestart: () => ipcRenderer.invoke("appRestart"),
  openDevTools: () => ipcRenderer.invoke("openDevTools"),
  toggleDevTools: () => ipcRenderer.invoke("toggleDevTools"),
  miniWindow: () => ipcRenderer.invoke("miniWindow"),
  maxWindow: () => ipcRenderer.invoke("maxWindow"),
  scaleWindow: () => ipcRenderer.invoke("scaleWindow"),
  closeWindow: () => ipcRenderer.invoke("closeWindow"), //Close window
  hideWindow: () => ipcRenderer.invoke("hideWindow"), //Hide window
  activeWindow: () => ipcRenderer.invoke("activeWindow"), //Bring the window to the front
  forceCloseWindow: (cfg) => ipcRenderer.invoke("forceCloseWindow", cfg), //Force destroy the window
  openLink: (url) => ipcRenderer.invoke("openLink", url), //Open a new link in the same browser
  getUserDataPath: () => ipcRenderer.sendSync("getUserDataPath"),
  getTempPath: () => ipcRenderer.sendSync("getTempPath"),
  getDownloadsPath: () => ipcRenderer.sendSync("getDownloadsPath"),
  getLogsPath: () => ipcRenderer.sendSync("getLogsPath"),
  getCrashPath: () => ipcRenderer.sendSync("getCrashPath"),
  getAutoImport: () => ipcRenderer.sendSync("getAutoImport"), //Query the task
  getBuildVersion: () => ipcRenderer.sendSync("getBuildVersion"), //get  hotfix version
  getShellVersion: () => ipcRenderer.sendSync("getShellVersion"), //get  shell version
  getLocale: () => ipcRenderer.sendSync("getLocale"), //Get default language
  getRegion: () => ipcRenderer.sendSync("getRegion"), //Get default Region
  getSystemRegion: () => ipcRenderer.sendSync("getSystemRegion"), //Get default system Region
  getIsThemeDark: ()  => ipcRenderer.sendSync("getIsThemeDark"), //Get theme is dark
  getArch: () => process.arch, //System version architecture: ARM, x64
  getPlatform: () => process.platform, //system
  install: (filePath) => ipcRenderer.invoke("install", filePath), //Installation package
  hotUpdate: (version, hotUrl, diffUrl) =>
    ipcRenderer.invoke("hotUpdate", version, hotUrl, diffUrl), //Hot update operation
  openFile: (filePath) => ipcRenderer.invoke("openFile", filePath), //Open local file
  cancelQuit: () => ipcRenderer.invoke("cancelQuit"), //Cancel exit, can be called multiple times
  sendMessage: (...args) => ipcRenderer.send(...args), //Send Message
  initAutoImport: (taskList) => ipcRenderer.invoke("initAutoImport", taskList), //Initialize import task
  setRedirect: (url, redirectUrl) => ipcRenderer.invoke("setRedirect", url, redirectUrl), //Set redirect URL
  doCrash: () => ipcRenderer.invoke("doCrash"), //Simulate crash for testing
  getRemoteText: (url, headers = {}) =>
    ipcRenderer.invoke("getRemoteText", url, headers), //Fetch remote text for importing remote files
  onMessage: (channel, func) => {
    const listener = (event, ...args) => func(...args);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  }, //Receive message
});