const AdmZip = require("adm-zip");
const path = require("node:path");
const fs = require("node:fs");

function unzipAndDeleteFile(zipFilePath) {
  try {
    // Create an AdmZip instance
    const zip = new AdmZip(zipFilePath);

    // Get the directory of the ZIP file
    const extractPath = path.dirname(zipFilePath);


    // Extract files
    zip.extractAllTo(extractPath, true);

    console.log(`File extracted to: ${extractPath}`);

    // After successful extraction, delete the original ZIP file
    fs.unlinkSync(zipFilePath);
    console.log(`Original ZIP file deleted: ${zipFilePath}`);

    return true; // Indicates operation was successful
  } catch (error) {
    console.error("Error during unzip process:", error);
    return false; // Indicates operation failed
  }
}

module.exports = {
  unzipAndDeleteFile,
};
