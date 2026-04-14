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
      logInfo("Husky init skipped — will run on next `npm install`.");
    }
  }

  // Ensure a cross-platform "prepare" script exists.
  //
  // Why not "husky || true"?
  // - On Windows/PowerShell, `true` is not a command.
  // - If husky isn't installed yet (or install failed earlier), a hard-failing
  //   prepare script breaks `pnpm install` / `yarn install`.
  //
  // This script:
  // - Runs husky via `npx --no-install` if it's available locally
  // - Otherwise exits 0 without failing installs
  const PREPARE_SCRIPT =
    'node -e "const {spawnSync}=require(\\\"child_process\\\");' +
    'const r=spawnSync(process.platform===\\\"win32\\\"?\\\"npx.cmd\\\":\\\"npx\\\",[\\\"--no-install\\\",\\\"husky\\\"],{stdio:\\\"inherit\\\"});' +
    'process.exit((r.status===0||r.status===null)?0:0)"';

  if (!pkg.scripts) pkg.scripts = {};
  if (pkg.scripts.prepare !== PREPARE_SCRIPT) {
    pkg.scripts.prepare = PREPARE_SCRIPT;
    await writeJSON(pkgPath, pkg);
    logSuccess('Ensured a safe cross-platform "prepare" script in package.json.');
  }
};