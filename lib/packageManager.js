'use strict';

const fs = require('fs-extra');
const path = require('path');
const execa = require('execa');
const { logInfo, logSuccess, logError } = require('./logger');

/**
 * detectPackageManager()
 * 
 * Detects the package manager used in the current directory.
 */
const detectPackageManager = () => {
  if (fs.existsSync(path.join(process.cwd(), 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(process.cwd(), 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(process.cwd(), 'bun.lockb'))) return 'bun';
  return 'npm';
};

/**
 * getPackageManagerCommand(manager, type, pkg)
 * 
 * Returns the appropriate command for the package manager.
 */
const getPackageManagerCommand = (manager, type, pkg = '') => {
  const commands = {
    npm: {
      install: ['install', '--save-dev', pkg, '--legacy-peer-deps'],
      run: ['run', type],
      exec: ['npx', pkg]
    },
    pnpm: {
      install: ['add', '-D', pkg],
      run: ['run', type],
      exec: ['pnpm', 'dlx', pkg]
    },
    yarn: {
      install: ['add', '-D', pkg],
      run: [type],
      exec: ['yarn', 'dlx', pkg]
    },
    bun: {
      install: ['add', '-d', pkg],
      run: ['run', type],
      exec: ['bun', 'x', pkg]
    }
  };

  return commands[manager] || commands.npm;
};

exports.detectPackageManager = detectPackageManager;
exports.getPackageManagerCommand = getPackageManagerCommand;

/**
 * getHttpsUrl(shortcut)
 * 
 * Converts 'github:user/repo' to 'git+https://github.com/user/repo.git'
 * to avoid pnpm SSH Permission Denied errors.
 */
exports.getHttpsUrl = (shortcut) => {
  if (shortcut && shortcut.startsWith('github:')) {
    return shortcut.replace('github:', 'git+https://github.com/') + '.git';
  }
  return shortcut;
};

/**
 * whitelistInPnpm()
 * 
 * Automatically adds cs-setup to the onlyBuiltDependencies list in package.json
 * to bypass pnpm 10 script blocking.
 */
exports.whitelistInPnpm = async () => {
  if (detectPackageManager() !== 'pnpm') return;

  const pkgPath = path.join(process.cwd(), 'package.json');
  if (!await fs.pathExists(pkgPath)) return;

  try {
    const pkg = await fs.readJSON(pkgPath);
    if (!pkg.pnpm) pkg.pnpm = {};
    if (!pkg.pnpm.onlyBuiltDependencies) pkg.pnpm.onlyBuiltDependencies = [];

    if (!pkg.pnpm.onlyBuiltDependencies.includes('cs-setup')) {
      pkg.pnpm.onlyBuiltDependencies.push('cs-setup');
      logInfo('[pnpm] Automatically whitelisting cs-setup for automatic installation...');
      await fs.writeJSON(pkgPath, pkg, { spaces: 2 });
      logSuccess('[pnpm] cs-setup added to onlyBuiltDependencies in package.json.');
    }
  } catch (err) {
    logInfo(`[pnpm] Could not auto-whitelist: ${err.message}`);
  }
};

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
  } catch (e) {
    // Ignore if package.json doesn't exist or can't be read
  }

  const requiredPackages = [
    'eslint',
    '@eslint/js'
  ];

  if (isVite) {
    let vitestVer = '*';
    let hasVitest = false;
    try {
      const pkg = await fs.readJSON(pkgPath);
      hasVitest = !!(pkg.devDependencies?.vitest || pkg.dependencies?.vitest);
      vitestVer = pkg.devDependencies?.vitest || pkg.dependencies?.vitest || '*';
    } catch (e) { }

    // Auto-install vitest if missing (project has vite but not vitest)
    if (!hasVitest) {
      logInfo('Vite project detected without vitest — auto-installing vitest...');
      requiredPackages.push('vitest');
    }
    requiredPackages.push(`@vitest/coverage-v8@${vitestVer}`);
  }

  logInfo('Installing required dependencies...');
  for (const pkg of requiredPackages) {
    await exports.installDevDependency(pkg);
  }

  logSuccess('All required dependencies installed.');
};

/**
 * installDevDependency(pkg)
 */
exports.installDevDependency = async (pkg) => {
  const pkgPath = path.join(process.cwd(), 'package.json');

  if (!await fs.pathExists(pkgPath)) {
    logInfo(`No package.json found at ${process.cwd()}. Skipping: ${pkg}`);
    return;
  }

  const pkgJson = await fs.readJSON(pkgPath);

  // FIX: This now correctly calls the local function defined at the top
  const baseName = getPackageBaseName(pkg);

  const isInstalledInPkg = (pkgJson.dependencies && pkgJson.dependencies[baseName]) ||
    (pkgJson.devDependencies && pkgJson.devDependencies[baseName]);

  const isBinaryPresent = await fs.pathExists(path.join(process.cwd(), 'node_modules', baseName));

  if (isInstalledInPkg && isBinaryPresent) {
    logInfo(`${baseName} is already installed — skipping.`);
    return;
  }

  const manager = detectPackageManager();
  logInfo(`Installing ${pkg} via ${manager}...`);

  try {
    const cmdArgs = getPackageManagerCommand(manager, 'install', pkg);
    await execa(manager, cmdArgs, {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
    logSuccess(`${pkg} installed successfully.`);
  } catch (err) {
    const installCmd = manager === 'npm' ? 'npm install --save-dev' : 
                      manager === 'yarn' ? 'yarn add -D' : 
                      manager === 'pnpm' ? 'pnpm add -D' : 'bun add -d';
    logError(
      `Failed to install ${pkg}: ${err.message}\n` +
      `  → Run manually: ${installCmd} ${pkg}`
    );
  }
};