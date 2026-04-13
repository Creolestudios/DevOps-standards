'use strict';

const { readJSON, writeJSON } = require('./utils');
const { installDevDependency } = require('./packageManager');
const execa = require('execa');
const path = require('path');
const { logInfo, logSuccess } = require('./logger');

/**
 * installHusky(gitRoot)
 *
 * gitRoot – directory containing .git
 *           Husky MUST be initialised here so hooks land in gitRoot/.husky/
 *           In a monorepo this differs from process.cwd() (the project root).
 */
exports.installHusky = async (gitRoot) => {
  const pkgPath = path.join(process.cwd(), 'package.json');
  const pkg = await readJSON(pkgPath);

  // Install husky if not already in devDependencies / node_modules
  // Always install/update husky in devDependencies
  await installDevDependency('husky');

  // Always run husky init from the git root so .husky/ is created there
  logInfo('Initializing Husky...');
  const opts = { stdio: 'inherit', cwd: gitRoot || process.cwd() };

  try {
    await execa('npx', ['husky'], opts);              // husky v9+
  } catch {
    try {
      await execa('npx', ['husky', 'install'], opts); // husky v8 fallback
    } catch {
      logInfo("Husky init skipped — will run on next installation.");
    }
  }

  // Ensure "prepare": "husky || true" is set (overwrite existing if different)
  if (!pkg.scripts) pkg.scripts = {};
  if (pkg.scripts.prepare !== 'husky || true') {
    pkg.scripts.prepare = 'husky || true';
    await writeJSON(pkgPath, pkg);
    logSuccess('Ensured "prepare": "husky || true" script in package.json.');
  }
};