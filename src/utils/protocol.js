const { Readable } = require("stream");
const path = require("node:path");
const { getBuildPath } = require("./upgrade");
const BuildPath = getBuildPath();
const utils = require("./utils");
const EventConvertResult = utils.EventConvertResult;
const HttpConvertResult = utils.HttpConvertResult;

//File protocol — serves static assets from build/work.asar
const appHandler = async (request, callback) => {
  let filePath = utils.getBasePath(request.url);
  let fileExtension = utils.getExt(filePath);
  if (!fileExtension) {
    filePath = "index.html"; // Reset to index.html if no extension
    fileExtension = ".html";
  }

  //Read local file
  const resolvedPath = path.join(BuildPath, "work.asar", filePath);
  const mimeTypes = {
    ".html": "text/html",
    ".wasm": "application/wasm",
    ".js": "application/javascript",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
  };

  if (
    filePath ||
    !fileExtension ||
    fileExtension === "html" ||
    fileExtension === "asar"
  ) {
    let headers = {};
    if (mimeTypes[fileExtension]) {
      headers["Content-Type"] = mimeTypes[fileExtension];
    }
    if (fileExtension == "js") {
      const jsHash = utils.getJsHash(filePath);
      if (jsHash) {
        headers["ETag"] = jsHash; // Set the etag environment
      }
    }
    if (filePath == "index.html") {
      headers["Pragma"] = "no-cache";
    }
    callback({
      path: resolvedPath,
      headers: headers,
    });
  } else {
    callback({ error: -6 });
  }
};

//api interface handling — reverse proxy
function apiHandler(request, respond) {
  const newUrl = request.url;
  const params = {
    method: request.method,
    headers: request.headers,
    body: request.uploadData ? request.uploadData[0].bytes : null,
  };
  fetch(newUrl, params)
    .then(async (response) => {
      respond({
        statusCode: response.status,
        mimeType: response.headers.get("Content-Type"),
        data: Buffer.from(await response.text()),
      });
    })
    .catch((error) => {
      console.error(error);
      respond({ statusCode: 404, data: Buffer.from("File not found") });
    });
}

//apt:// — main RPC dispatcher with SSE stream support
const aptHandler = async (request, callback) => {
  const stream = new Readable({
    read() { },
  });

  stream._is_close = false;
  stream._close_cb = function () {
    console.log("close");
  };
  function closeStream() {
    stream._is_close = true;
    stream._close_cb();
  }

  stream.on("end", () => {
    closeStream();
    console.log("Stream ended.");
  });

  stream.on("error", (err) => {
    closeStream();
    console.error("Stream error:", err);
  });

  stream.on("close", () => {
    closeStream();
    console.log("Stream close");
  });

  const method = utils.getLastPath(request.url).replace(/^\/+/, "");

  // Built-in: fetch proxy (pass origin-url header to proxy any URL)
  if (method == "fetch") {
    const fetchHeaders = request.headers;
    const originUrl = request.headers["origin-url"];
    if (!originUrl) {
      callback({ statusCode: 400, headers: {}, data: stream });
      stream.push("origin-url is required");
      stream.push(null);
      return;
    }

    delete fetchHeaders["origin-url"];
    const requestOptions = {
      method: request.method,
      url: originUrl,
      headers: fetchHeaders,
      body: request.uploadData
        ? request.uploadData[0].bytes.toString("utf-8")
        : "",
    };
    try {
      const fetchResponse = await utils.makeRequest(requestOptions);
      callback({
        statusCode: fetchResponse.statusCode,
        headers: fetchResponse.headers,
        data: stream,
      });
      stream.push(fetchResponse.data);
      stream.push(null);
    } catch (error) {
      console.error(error);
      callback({ statusCode: 500, headers: {}, data: stream });
      stream.push(error.message);
      stream.push(null);
    }
    return;
  }

  // Default to JSON; SSE methods should set text/event-stream in their handler
  const headers = {
    "Content-Type": "application/json",
  };
  callback({ statusCode: 200, headers: headers, data: stream });

  let buf = request.uploadData
    ? request.uploadData[0].bytes.toString("utf-8")
    : "";

  if (buf.length < 1) {
    stream.push("data is empty");
    stream.push(null);
    return;
  }

  // ── User-defined method handlers ────────────────────────────────────────────
  // Add your own apt:// method handlers here.
  // Each handler receives (buf: string, stream: Readable) and must either:
  //   - push data to stream then call stream.push(null) to end, OR
  //   - throw an error (caught below)
  //
  // Example SSE handler:
  //   handlers['myStream'] = async (buf, stream) => {
  //     for (const item of items) {
  //       if (stream._is_close) break;
  //       stream.push(EventConvertResult(item, 'data'));
  //     }
  //     stream.push(null);
  //   };
  //
  // Example JSON handler:
  //   handlers['myMethod'] = async (buf, stream) => {
  //     const data = JSON.parse(buf);
  //     stream.push(HttpConvertResult({ result: data }));
  //     stream.push(null);
  //   };
  const handlers = {};

  // Built-in: evaluate a JS expression in a sandboxed vm context
  handlers['callFunction'] = async (buf, stream) => {
    let data;
    try {
      data = JSON.parse(buf);
    } catch (e) {
      stream.push(HttpConvertResult(`json parse error${e.message}@30005`));
      stream.push(null);
      return;
    }
    if (!data?.context) {
      stream.push(HttpConvertResult("context, text is required@3006"));
      stream.push(null);
      return;
    }
    const vm = require("vm");

    const randomFunctionName = `fn_${Math.floor(Math.random() * 10000)}`;

    try {
      const wrappedContext = `
        function ${randomFunctionName}(text) {
          ${data.context}
        }
        ${randomFunctionName}(text);
      `;
      const script = new vm.Script(wrappedContext);
      const result = script.runInNewContext(
        { text: data?.text || '' },
        { timeout: 3000 }
      );
      if (result === undefined) {
        stream.push(HttpConvertResult("Function is not return value@30002"));
        stream.push(null);
        return;
      }
      stream.push(HttpConvertResult({ text: data?.text || '', value: result }));
      stream.push(null);
    } catch (error) {
      console.error("vm execution error", String(error));
      stream.push(
        HttpConvertResult(
          "Function execution error: " + String(error) + "@30003"
        )
      );
      stream.push(null);
    }
  };

  // Built-in: download a file with progress events (SSE)
  handlers['download'] = async (buf, stream) => {
    try {
      const params = JSON.parse(buf);
      const { url, filePath } = params;
      const res = await utils.downloadFile(url, filePath, (progress) => {
        stream.push(
          utils.EventConvertResult({ process: progress }, "progress")
        );
      });
      stream.push(
        utils.EventConvertResult(
          { filePath: res.filePath, fileSize: res.fileSize },
          "complete"
        )
      );
      stream.push(null);
    } catch (e) {
      console.log(e);
      stream.push(utils.EventConvertResult({ msg: e }, "error"));
      stream.push(null);
    }
  };

  // Dispatch
  try {
    if (handlers[method]) {
      await handlers[method](buf, stream);
    } else {
      stream.push(HttpConvertResult(`method ${method} not found@3007`));
      stream.push(null);
    }
  } catch (e) {
    stream.push(HttpConvertResult(`error:${e}@30004`));
    console.log(e);
    stream.push(null);
  }
};

const protocolSchemes = [
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      allowServiceWorkers: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: "api",
    privileges: {
      standard: true,
      secure: true,
      allowServiceWorkers: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: "apt",
    privileges: {
      standard: true,
      secure: true,
      allowServiceWorkers: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
];

module.exports = {
  appHandler,
  apiHandler,
  aptHandler,
  protocolSchemes,
};
