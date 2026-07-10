const { net } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

// Get the extension
function getExt(url) {
  let ext = url.slice(-5);
  let dotIndex = ext.indexOf(".");

  return dotIndex !== -1 ? ext.slice(dotIndex + 1) : "";
}

// Get the last path
function getLastPath(url) {
  let lastSlashIndex = url.lastIndexOf("/");
  let queryIndex = url.indexOf("?");

  // 去除query部分
  let cleanUrl = queryIndex !== -1 ? url.slice(0, queryIndex) : url;

  return lastSlashIndex !== -1 ? cleanUrl.slice(lastSlashIndex) : "";
}

// Remove hash remove query and  remove last /
function clearUrlQuery(url) {
  // 去除hash部分
  const hashIndex = url.indexOf("#");
  if (hashIndex > -1) {
    url = url.substring(0, hashIndex);
  }

  // 去除query部分
  const queryIndex = url.indexOf("?");
  if (queryIndex > -1) {
    url = url.substring(0, queryIndex);
  }

  // 去除最后的斜杠
  if (url.endsWith("/")) {
    url = url.slice(0, -1);
  }

  return url;
}

function getUrlQuery(url) {
  const queryIndex = url.indexOf("?");
  return queryIndex !== -1 ? url.slice(queryIndex + 1) : "";
}

// Delete a file
function removeFile(targetPath) {
  try {
    fs.rmSync(targetPath);
  } catch (error) {
    console.log(error);
  }
}

// Get base URL
function getLastBase(url) {
  let lastSlashIndex = url.lastIndexOf("/");

  return lastSlashIndex !== -1 ? url.slice(0, lastSlashIndex) : url;
}

// Get the full path, electron actively filters
function getBasePath(url) {
  let pathEndIndex = url.lastIndexOf("/");
  if (pathEndIndex < 0) {
    pathEndIndex = 0;
  }
  // 去除hash和query部分
  const queryIndex = url.indexOf("?");
  if (queryIndex > -1) {
    url = url.substring(0, queryIndex);
  }  
  const hashIndex = url.indexOf("#");
  if (hashIndex > -1) {
    url = url.substring(0, hashIndex);
  }


  const protocolSeparatorIndex = url.indexOf("://");
  if (protocolSeparatorIndex < 0) {
    return url; // If there is no protocol, return the original URL
  }
  const pathStartIndex = url.indexOf("/", protocolSeparatorIndex + 3);
  return pathStartIndex < 0
    ? url.slice(protocolSeparatorIndex + 3)
    : url.slice(pathStartIndex);
}

function getOriginUrl(url) {
  const protocolSeparatorIndex = url.indexOf("://");
  if (protocolSeparatorIndex < 0) {
    return ""; // If there is no protocol, return empty string
  }
  const pathStartIndex = url.indexOf("/", protocolSeparatorIndex + 3);
  return pathStartIndex < 0
    ? url
    : url.slice(0, pathStartIndex);
}

// Get the regular hash part, 8 bytes
function getJsHash(fileName) {
  const len = fileName.length;
  if (len < 12) {
    return ""; //do not check
  }

  const sep = fileName[len - 12];
  if (sep == "." || sep == "-") {
    return fileName.slice(len - 11, len - 3);
  }
  return ""; // fallback
}

function getMimeTypeByExt(ext) {
  const mapping = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".wasm": "application/wasm",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    // Add more mappings as needed
  };
  return mapping[ext.toLowerCase()] || "application/octet-stream";
}

/**
 * Downloads and installs files
 * @param {string} url - Download URL
 * @param {string} filePath - Local path
 * @param {*} cb
 * @returns
 */
function downloadFile(url, filePath, cb = () => {}) {
  console.log(`download ${url} to ${filePath}`);
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(filePath);
    const request = net.request(url);

    request.on("response", (response) => {
      let len = 0;
      let cur = 0;
      try {
        console.log(response.headers);
        let rawLength = response.headers["Content-Length"]
          ? response.headers["Content-Length"]
          : response.headers["content-length"];
        len = parseInt(rawLength);
        if (!len) {
          len = 0;
        }
      } catch (e) {
        len = 0;
        console.log(e);
      }

      console.log(`download file expert len ${len}`);

      response.on("data", (chunk) => {
        cur += chunk.length;
        stream.write(chunk);

        if (len < 1) {
          cb((((100 * cur) / 500) * 1024 * 1024).toFixed(2)); //Maximum receive 500 MB
          return;
        }

        if (len < cur) {
          len = cur;
        }
        const progress = ((100 * cur) / len).toFixed(2);
        cb(progress);
      });

      response.on("end", () => {
        if (response.statusCode == 200) {
          if (len < 1 || len == cur) {
            stream.end();
            resolve({
              statusCode: response.statusCode,
              url: url,
              filePath: filePath,
              fileSize: len,
            });
          } else {
            stream.end();
            removeFile(filePath);
            console.log(`download file expert ${len} but ${cur}`);
            reject("The file size is inconsistent, please download it again.");
          }
        } else {
          stream.end();
          removeFile(filePath);
          console.log("file download error", response.statusCode);
          reject("file download error. the code is " + response.statusCode);
        }
      });

      response.on("error", (error) => {
        console.log("download error", error);
        reject(error);
      });
    });

    request.on("error", (error) => {
      stream.end();
      removeFile(filePath);
      console.log("download error 2", error);
      reject(error);
    });

    request.end();
  });
}

/**
 * Fetches remote text
 * @param {string} url - Download URL
 * @param {Object} headers - Request headers
 * @returns {Promise<string>} - Returns the text
 */
function getRemoteText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    makeRequest({
      method: "GET",
      url: url,
      headers: headers,
    }).then((response) => {
      resolve(response.data);
    }).catch((error) => {
        reject(error);
    });
  });
}

// 通用请求函数
/**
 * 通用请求选项定义
 * @param {string} method - 请求方法
 * @param {string} url - 请求的URL
 * @param {Object} headers - 请求头
 * @param {string} body - 请求体
 * @returns {Object} - 返回请求选项对象
 */
function makeRequest(options) {
  return new Promise((resolve, reject) => {
    const request = net.request(options);

    // 收集响应数据
    let responseData = '';
    let responseHeaders = null;

    request.on('response', (response) => {
      // 获取响应头
      responseHeaders = response.headers;

      response.on('data', (chunk) => {
        responseData += chunk;
      });

      response.on('end', () => {
        resolve({
          statusCode: response.statusCode,
          headers: responseHeaders,
          data: responseData
        });
      });
    });

    request.on('error', (error) => {
      reject(error);
    });

    // 如果有请求体，则写入
    if (options.body) {
      request.write(options.body);
    }

    request.end();
  });
}

/**
 * Check if the file exists
 * @param {*} filePath
 * @returns
 */
function fileExists(filePath) {
  try {
    fs.statSync(filePath);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

/**
 * Convert to sse event
 * @param {Object | string} data - sse data
 * @param {string} event - sse event type, optional values complete, progress, current_event_id
 * @returns {string} - sse format string
 */
const EventConvertResult = function (data, event) {
  let bufs = [];
  if (event) {
    bufs.push(`event: ${event}`);
  }
  if (typeof data == "string") {
    bufs.push(`data: ${data}\n\n`);
  } else {
    bufs.push(`data: ${JSON.stringify(data)}\n\n`);
  }

  return bufs.join("\n");
};

/**
 * Converts to http return string format
 * @param {Object | string} data - http data, string represents error information
 * @returns {string} - http formatted string
 */
const HttpConvertResult = function (data) {
  if (typeof data == "string") {
    // string
    let dataArr = data.split("@", 2);
    if (dataArr.length > 1) {
      let code;
      try {
        code = parseInt(dataArr[1]);
      } catch (e) {
        code = dataArr[1];
      }
      return JSON.stringify({ code: code, msg: dataArr[0], data: "" });
    } else {
      return JSON.stringify({ code: 10001, msg: dataArr[0], data: "" });
    }
  } else {
    // not a string
    return JSON.stringify({ code: 0, msg: "success", data: data });
  }
};

/**
 * Get local startup parameters
 * @returns [loadUrl, devMode]
 */
function getEnterPoint() {
  const argv = process.argv;
  let loadUrl = "app://localhost"; // default local
  let devMode = false; // default not open

  argv.forEach((arg) => {
    if (arg.startsWith("-url=")) {
      loadUrl = arg.split("=", 2)[1];
    } else if (arg.startsWith("-dev")) {
      devMode = true;
    } else if (arg.startsWith("-region")){
      global.initRegion = arg.split("=", 2)[1];
    }
  });

  return [loadUrl, devMode];
}

/**
 * Restore window size and position
 * @param {*} dir
 * @param {*} mainWindow
 */
function restoreWindowSize(fileDir, mainWindow, originSize) {
  const confPath = path.join(fileDir, "window-size.json");
  let bounds;
  try {
    bounds = JSON.parse(fs.readFileSync(confPath));
    console.log(bounds, originSize);
    let { width, height, x, y } = bounds;
    if (width > 100 && height > 100) {
      mainWindow.setSize(width, height);
    }
    if (process.platform == "win32" && x < 1 && y < 1) {
      mainWindow.maximize(); // Set to maximize
      return;
    }

    if (
      width + x > 10 &&
      height + y > 10 &&
      x + 10 < originSize.width &&
      y + 10 < originSize.height
    ) {
      // Ensure that the window is within the screen after moving, negative offset is larger than the window, and positive offset cannot exceed the main window size
      mainWindow.setPosition(x, y);
    }
  } catch (error) {
    console.log(error);
  }
}

/**
 * Save window size
 * @param {*} fileDir
 * @param {*} bounds
 */
function saveWindowSize(fileDir, bounds) {
  const confPath = path.join(fileDir, "window-size.json");
  console.log(confPath, bounds);
  try {
    fs.writeFileSync(confPath, JSON.stringify(bounds));
  } catch (error) {
    console.log(error);
  }
}

/**
 * Get close dialog configuration
 * @param {*} fileDir
 * @returns
 */
function getCloseCfg(fileDir) {
  let ret = {
    isTray: -1, // Whether to exit to the tray
    noPrompt: 1, // If 1, default not to show the dialog box
  };

  if (process.platform != "win32") {
    return ret;
  } else {
    ret = {
      isTray: 1, //win default to tray
      noPrompt: -1, //win default prompt
    };
  }

  const confPath = path.join(fileDir, "close-cfg.json");
  try {
    ret = JSON.parse(fs.readFileSync(confPath));
  } catch (error) {
    console.log(error);
  }

  console.log(ret);

  return ret;
}

/**
 * Save close configuration
 * @param {*} fileDir
 * @param {*} data
 */
function saveCloseCfg(fileDir, data) {
  if (process.platform != "win32") {
    return; // No need to save
  }
  const confPath = path.join(fileDir, "close-cfg.json");
  try {
    const { isTray, noPrompt } = data;
    let ret = { isTray: isTray ? 1 : -1, noPrompt: noPrompt ? 1 : -1 };
    fs.writeFileSync(confPath, JSON.stringify(ret));
  } catch (e) {
    console.log(e);
  }
}

//promise queue
class PromiseQueue {
  queue = Promise.resolve(true);

  add(operation) {
    return new Promise((resolve, reject) => {
      this.queue = this.queue.then(operation).then(resolve).catch(reject);
    });
  }
  get() {
    return this.queue;
  }
}

function getQueryParams(url) {
  // 创建一个空对象来存储查询参数
  const queryParams = {};

  // 找到URL中的查询字符串部分
  const queryString = url.split("?")[1];

  // 如果没有查询字符串，直接返回空对象
  if (!queryString) {
    return queryParams;
  }

  // 将查询字符串分割成单独的参数
  const pairs = queryString.split("&");

  // 遍历每个参数对
  for (let pair of pairs) {
    // 分割键值对
    const [key, value] = pair.split("=");

    // 解码键和值，并存储在对象中
    if (key) {
      queryParams[decodeURIComponent(key)] = decodeURIComponent(value || "");
    }
  }

  return queryParams;
}

module.exports = {
  getExt,
  getBasePath,
  getLastBase,
  getLastPath,
  getOriginUrl,
  getMimeTypeByExt,
  clearUrlQuery,
  getUrlQuery,
  downloadFile,
  fileExists,
  EventConvertResult,
  HttpConvertResult,
  getEnterPoint,
  getJsHash,
  restoreWindowSize,
  saveWindowSize,
  getCloseCfg,
  saveCloseCfg,
  PromiseQueue,
  getRemoteText,
  getQueryParams,
  makeRequest,
};
