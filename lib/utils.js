const fs = require('fs-extra');

exports.fileExists = async (path) => {
  return await fs.pathExists(path);
};

exports.readJSON = async (path) => {
  return await fs.readJSON(path);
};

exports.writeJSON = async (path, data) => {
  return await fs.writeJSON(path, data, { spaces: 2 });
};