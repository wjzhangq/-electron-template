/**
 * Update code
 * apipost_hot_8.0.18.zip  //Hotfix package, greater than 17M
 * apipost_diff_8.0.18.zip    //Hotfix incremental package, only for patching the previous version, < 500k
 */
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { exec } = require("node:child_process");
const { downloadFile, fileExists } = require("./utils");
const { unzipAndDeleteFile } = require("./zip");

// After esbuild bundling, this module is inlined into the root-level main.js,
// so __dirname resolves to the repository/app root at runtime.
const originPath = path.join(__dirname, "build"); // Original directory (root/build)
let raw_bspatch_bin = path.join(
  __dirname,
  "extraResources",
  `bspatch_${os.platform()}_${os.arch()}`
);
if (raw_bspatch_bin.indexOf("win32") > 0) {
  raw_bspatch_bin = raw_bspatch_bin + ".exe";
}
const bspatch_bin = raw_bspatch_bin;
console.log(bspatch_bin);

/**
 * Clean up subdirectories, excluding specified directories
 * @param {*} parentDir
 * @param {*} excludeDirs
 */
async function removeSubdirectories(parentDir, excludeDirs = []) {
  try {
    // Read the content of the parent directory
    const items = await fs.promises.readdir(parentDir, { withFileTypes: true });

    for (const item of items) {
      if (item.isDirectory()) {
        const dirPath = path.join(parentDir, item.name);

        // Check if it's in the exclude list
        if (!excludeDirs.includes(item.name)) {
          try {
            // Recursively delete the directory and its contents
            await fs.promises.rm(dirPath, { recursive: true, force: true });
            console.log(`delete dir : ${dirPath}`);
          } catch (err) {
            console.error(`delete dir ${dirPath} error:`, err);
          }
        } else {
          console.log(`exclude dir: ${dirPath}`);
        }
      }
    }
  } catch (err) {
    console.error("error:", err);
  }
}

/**
 * Execute patch operation
 * @param {*} oldFile
 * @param {*} newFile
 * @param {*} patchFile
 * @returns
 */
function executeBspatch(oldFile, newFile, patchFile) {
  return new Promise((resolve, reject) => {
    const cmd = `${bspatch_bin} "${oldFile}" "${newFile}" "${patchFile}"`;
    console.log(cmd);
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`bspatch execution error: ${error}`);
        reject(false);
        return;
      }

      if (stderr) {
        console.error(`bspatch stderr: ${stderr}`);
        reject(false);
        return;
      }

      console.log(`bspatch stdout: ${stdout}`);
      resolve(true);
    });
  });
}

/**
 * Downloads files from a remote address to the local machine
 * @param {*} version - The current version to be saved
 * @param {*} hot_url - The URL of the hot update package zip,
 * @param {*} diff_url - The URL of the hot update incremental package zip
 * @returns A string, if empty it represents success, otherwise it is the error reason
 */
const updateBuild = async (version, hot_url, diff_url) => {
  if (!global.userDataDir) {
    return "userData is not set";
  }
  console.log(`update to ${version}`);
  //mkdir  $userDataDir/upgrade/build_$version ,if the folder does not exist, create it step by step
  const buildPath = path.join(
    global.userDataDir,
    "upgrade",
    `build_${version}`
  );
  if (!fs.existsSync(buildPath)) {
    fs.mkdirSync(buildPath, { recursive: true });
  }

  if (!fs.existsSync(buildPath)) {
    return "create dir failed";
  }

  let isBuildOk = false; // whether the patch is successful

  if (diff_url) {
    // Handle the incremental package
    const oldBuildPath = getOldBuildPath();
    if (!oldBuildPath) {
      console.log("old build path error");
    } else {
      try {
        const diffZipPath = path.join(buildPath, "diff.zip");
        await downloadFile(diff_url, diffZipPath);
        let unzipResult = unzipAndDeleteFile(diffZipPath);
        if (!unzipResult) {
          throw new Error("unzip diff error");
        }
        let patchResult = false;
        patchResult = await executeBspatch(
          path.join(oldBuildPath, "work.asar"),
          path.join(buildPath, "work.asar"),
          path.join(buildPath, "work.diff")
        );

        if (!patchResult) {
          throw new Error("patch work error");
        }

        patchResult = await executeBspatch(
          path.join(oldBuildPath, "send.asar"),
          path.join(buildPath, "send.asar"),
          path.join(buildPath, "send.diff")
        );

        if (!patchResult) {
          throw new Error("patch send error");
        }
        // Validate if ok
        if (!fileExists(path.join(buildPath, "work.asar", "index.html"))) {
          console.log(
            path.join(buildPath, "work.asar/index.html"),
            " is not found"
          );
          throw new Error("work.asar/index.html not found");
        }

        isBuildOk = true; //patch successful
      } catch (e) {
        console.log(e);
      }
    }
  }

  if (!isBuildOk && hot_url) {
    //patch failed
    try {
      const hotZipPath = path.join(buildPath, "hot.zip");
      await downloadFile(hot_url, hotZipPath);
      console.log(`unzip ${hotZipPath}`);
      let unzipResult = unzipAndDeleteFile(hotZipPath);
      if (!unzipResult) {
        throw new Error("unzip hot error");
      }
      isBuildOk = true; //download successful
    } catch (e) {
      console.log(e);
      return String(e);
    }
  } else if (!hot_url) {
    return "hotUrl is require";
  }

  // Validate if ok
  if (!fileExists(path.join(buildPath, "work.asar"))) {
    console.log(path.join(buildPath, "work.asar"), " is not found");
    return "work.asar not found";
  }

  //save upgrade.json
  const confPath = path.join(global.userDataDir, "upgrade", "upgrade.json");
  const ret = {
    buildPath: buildPath,
    buildVersion: version,
    appVersion: global.appVersion, // Record the version before the upgrade, if the user upgrades manually, it will be detected immediately
  };
  try {
    fs.writeFileSync(confPath, JSON.stringify(ret));
  } catch (error) {
    console.log(error);
    return "save upgrade.json failed";
  }

  // Clean up other directories, excluding the current directory
  removeSubdirectories(path.join(global.userDataDir, "upgrade"), [
    `build_${version}`,
    "upgrade.json",
  ]);

  return "";
};

/**
 * Returns the old build directory
 * @returns old build path
 */
const getOldBuildPath = () => {
  if (!global.userDataDir) {
    console.log("user data not defined");
    return originPath;
  }
  const confPath = path.join(global.userDataDir, "upgrade", "upgrade.json");
  try {
    ret = JSON.parse(fs.readFileSync(confPath));
  } catch (error) {
    console.log(error);
    return originPath;
  }

  if (!ret?.buildPath) {
    return originPath;
  }

  return ret.buildPath;
};

/**
 * Get the version of the hot update that has been downloaded
 */
const getBuildVersion = () => {
  let version = "";
  if (!global.userDataDir) {
    console.log("user data not defined");
    return version;
  }

  const confPath = path.join(global.userDataDir, "upgrade", "upgrade.json");
  try {
    ret = JSON.parse(fs.readFileSync(confPath));
  } catch (error) {
    //console.log(error);
    return version;
  }

  if (!ret?.buildVersion) {
    return version;
  }

  return ret.buildVersion;
};

/**
 * Get the latest running code, requiring efficient confirmation
 * @returns string - build directory code
 */
const getBuildPath = () => {
  // If there is a cache, return the cache directly
  if (global?.upgrade?.buildPath) {
    return global.upgrade.buildPath;
  }

  if (!global.userDataDir) {
    console.log("userData is not set");
    return originPath;
  }

  const confPath = path.join(global.userDataDir, "upgrade", "upgrade.json");
  try {
    ret = JSON.parse(fs.readFileSync(confPath));
  } catch (error) {
    //console.log(error);
    return originPath;
  }

  if (!ret?.buildPath) {
    console.log("get uprage error");
    return originPath;
  }

  let isFallBack = false;
  if (ret.appVersion && ret.appVersion != global.appVersion) {
    // Reinstalled, reset to the original version
    console.log("reinstall");
    isFallBack = true;
  } else if (!fileExists(path.join(ret.buildPath, "work.asar", "index.html"))) {
    console.log("work.asar not found");
    isFallBack = true;
  }

  if (isFallBack) {
    try {
      fs.unlinkSync(confPath);
    } catch (e) {}

    global.upgrade = {
      buildPath: originPath,
      buildVersion: global.appVersion,
    };

    return originPath;
  }

  //Mark as the latest version
  global.upgrade = {
    buildPath: ret.buildPath,
    buildVersion: ret?.buildVersion,
  };

  return ret.buildPath;
};
module.exports = { getBuildPath, updateBuild, getBuildVersion };
