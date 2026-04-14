'use strict';

const fs = require('fs-extra');
const path = require('path');
const execa = require('execa');
const { logInfo, logSuccess, logError } = require('./logger');

/**
 * detectPackageManager(cwd?)
 *
 * Walks up the directory tree from cwd looking for a lock file.
 * Returns: { pm, installFlag, runCmd }
 *   pm          — the binary name: 'pnpm' | 'yarn' | 'bun' | 'npm'
 *   installFlag — extra flags needed (e.g. '-w' for pnpm workspace root)
 *   runCmd      — the command to use for `run` (e.g. 'pnpm run')
 *   addCmd      — the command to add a dev dependency (e.g. 'pnpm add -D')
 */
const detectPackageManager = (cwd = process.cwd()) => {
  let dir = cwd;

  while (true) {
    // pnpm workspace
    if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) {
      const workspaceFile = path.join(dir, 'pnpm-workspace.yaml');
      const isWorkspace = fs.existsSync(workspaceFile);
      const isWorkspaceRootCwd = isWorkspace && path.resolve(dir) === path.resolve(cwd);

      return {
        pm: 'pnpm',
        // If we are running at the pnpm workspace root, pnpm requires `-w`
        // to explicitly install dependencies there.
        // If we are running inside a workspace package, we MUST NOT use `-w`
        // (it would install to the root instead of the package).
        addCmd: isWorkspaceRootCwd ? 'pnpm add -D -w' : 'pnpm add -D',
        runCmd: 'pnpm run',
        ciCmd: 'pnpm install --frozen-lockfile',
        installCmd: 'pnpm install',
        lockFile: 'pnpm-lock.yaml',
      };
    }
    if (fs.existsSync(path.join(dir, 'yarn.lock'))) {
      return {
        pm: 'yarn',
        addCmd: 'yarn add -D',
        runCmd: 'yarn',
        ciCmd: 'yarn install --frozen-lockfile',
        installCmd: 'yarn install',
        lockFile: 'yarn.lock',
      };
    }
    if (fs.existsSync(path.join(dir, 'bun.lockb'))) {
      return {
        pm: 'bun',
        addCmd: 'bun add -d',
        runCmd: 'bun run',
        ciCmd: 'bun install',
        installCmd: 'bun install',
        lockFile: 'bun.lockb',
      };
    }
    if (fs.existsSync(path.join(dir, 'package-lock.json'))) {
      return {
        pm: 'npm',
        addCmd: 'npm install --save-dev',
        runCmd: 'npm run',
        ciCmd: 'npm ci',
        installCmd: 'npm install',
        lockFile: 'package-lock.json',
      };
    }

    // Stop walking up once we reach the git root.
    // This prevents accidentally detecting a parent repo's lockfile (common when
    // running in a subfolder of a larger workspace).
    if (fs.existsSync(path.join(dir, '.git'))) break;

    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // Default fallback — no lock file found
  return {
    pm: 'npm',
    addCmd: 'npm install --save-dev',
    runCmd: 'npm run',
    ciCmd: 'npm ci',
    installCmd: 'npm install',
    lockFile: null,
  };
};

exports.detectPackageManager = detectPackageManager;

/**
 * getPackageBaseName(pkg)
 *
 * Helper to strip version tags from package names
 * (e.g. '@vitest/coverage-v8@^1.0.0' -> '@vitest/coverage-v8')
 */
const getPackageBaseName = (pkg) => {
  if (pkg.startsWith('@')) {
    const parts = pkg.slice(1).split('@');
    return '@' + parts[0];
  }
  return pkg.split('@')[0];
};

// Export it so other files can use it if needed
exports.getPackageBaseName = getPackageBaseName;

/**
 * installAllRequiredDependencies()
 *
 * Installs all required packages for the cs-setup functionality
 */
exports.installAllRequiredDependencies = async () => {
  const pkgPath = path.join(process.cwd(), 'package.json');
  let isVite = false;

  // Check for TypeScript and Vite/Vitest
  try {
    const pkg = await fs.readJSON(pkgPath);
    isVite = !!(pkg.dependencies?.vite || pkg.devDependencies?.vite || pkg.devDependencies?.vitest);

    if (!isVite) {
      const configFiles = [
        'vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs',
        'vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs'
      ];
      for (const file of configFiles) {
        if (fs.existsSync(path.join(process.cwd(), file))) {
          isVite = true;
          break;
        }
      }
    }
  } catch {
    // Ignore if package.json doesn't exist or can't be read
  }

  const requiredPackages = [
    'eslint@^9.0.0',
    '@eslint/js@^9.0.0'
  ];

  if (isVite) {
    let vitestVer = '*';
    let hasVitest = false;
    try {
      const pkg = await fs.readJSON(pkgPath);
      hasVitest = !!(pkg.devDependencies?.vitest || pkg.dependencies?.vitest);
      vitestVer = pkg.devDependencies?.vitest || pkg.dependencies?.vitest || '*';
    } catch { }

    // Auto-install vitest if missing (project has vite but not vitest)
    if (!hasVitest) {
      logInfo('Vite project detected without vitest — auto-installing vitest...');
      requiredPackages.push('vitest');
    }
    requiredPackages.push(`@vitest/coverage-v8@${vitestVer}`);
  }

  const { pm } = detectPackageManager();
  logInfo('Installing required dependencies...');
  for (const pkg of requiredPackages) {
    await exports.installDevDependency(pkg);
  }

  logSuccess('All required dependencies installed.');
};

/**
 * installDevDependency(pkg)
 *
 * Installs a dev dependency using the detected package manager.
 */
exports.installDevDependency = async (pkg) => {
  const pkgPath = path.join(process.cwd(), 'package.json');

  if (!await fs.pathExists(pkgPath)) {
    logInfo(`No package.json found at ${process.cwd()}. Skipping: ${pkg}`);
    return;
  }

  const pkgJson = await fs.readJSON(pkgPath);
  const baseName = getPackageBaseName(pkg);

  const isInstalledInPkg = (pkgJson.dependencies && pkgJson.dependencies[baseName]) ||
    (pkgJson.devDependencies && pkgJson.devDependencies[baseName]);

  const isBinaryPresent = await fs.pathExists(path.join(process.cwd(), 'node_modules', baseName));

  if (isInstalledInPkg && isBinaryPresent) {
    logInfo(`${baseName} is already installed — skipping.`);
    return;
  }

  const { pm, addCmd } = detectPackageManager();
  logInfo(`Installing ${pkg} via ${pm}...`);

  // Split the addCmd into binary + args array for execa
  const [bin, ...baseArgs] = addCmd.split(' ');
  const args = [...baseArgs, pkg];

  // pnpm needs --legacy-peer-deps equivalent: --no-strict-peer-dependencies
  if (pm === 'pnpm') args.push('--no-strict-peer-dependencies');
  if (pm === 'npm') args.push('--legacy-peer-deps');

  try {
    await runInstallCommandWithPnpmSelfHeal({ pm, bin, args });
    logSuccess(`${pkg} installed successfully.`);
  } catch (err) {
    logError(
      `Failed to install ${pkg}: ${err.message}\n` +
      `  → Run manually: ${addCmd} ${pkg}`
    );
  }
};

async function runInstallCommandWithPnpmSelfHeal({ pm, bin, args }) {
  const cwd = process.cwd();
  try {
    await execa(bin, args, { stdio: 'inherit', cwd, env: process.env });
    return;
  } catch (err) {
    // pnpm can fail if node_modules/.pnpm was created with a different
    // `virtual-store-dir-max-length` value. In that case, pnpm requires a reinstall.
    const msg = String(err?.message || '');
    const pnpmVirtualStoreMismatch =
      pm === 'pnpm' &&
      (msg.includes('ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF') ||
        msg.includes('virtual-store-dir-max-length'));

    if (!pnpmVirtualStoreMismatch) throw err;

    logInfo('[pnpm] Detected virtual store mismatch. Recreating node_modules via `pnpm install`...');
    try {
      await execa('pnpm', ['install'], { stdio: 'inherit', cwd, env: process.env });
    } catch (installErr) {
      // If reinstall fails, surface the original error (most actionable).
      throw err;
    }

    // Retry original add command once after reinstall
    await execa(bin, args, { stdio: 'inherit', cwd, env: process.env });
  }
}