'use strict';

const fs = require('fs-extra');
const path = require('path');
const execa = require('execa');
const { logInfo, logSuccess, logError } = require('./logger');
const { detectPackageManager, getPackageManagerCommand } = require('./packageManager');

/**
 * fixInvalidAliases()
 *
 * Scans the project's package.json for npm: aliases that cause "Invalid comparator" errors.
 * Specifically handles the known culprit: npm:rolldown-vite@7.2.2
 */
exports.fixInvalidAliases = async () => {
    const pkgPath = path.join(process.cwd(), 'package.json');

    if (!await fs.pathExists(pkgPath)) {
        return;
    }

    let pkg;
    try {
        pkg = await fs.readJSON(pkgPath);
    } catch (err) {
        logError(`Failed to read package.json: ${err.message}`);
        return;
    }

    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const fixes = [];

    for (const [name, version] of Object.entries(allDeps)) {
        if (version && version.startsWith('npm:')) {
            // Found an alias like "rolldown": "npm:rolldown-vite@7.2.2"
            // or "some-pkg": "npm:other-pkg@version"
            const match = version.match(/^npm:(.+)@(.+)$/);
            if (match) {
                const actualPkgName = match[1];
                const actualVersion = match[2];
                fixes.push({
                    aliasName: name,
                    actualPkgName,
                    actualVersion,
                    fullAlias: version
                });
            }
        }
    }

    if (fixes.length === 0) {
        return;
    }

    logInfo(`[Fixer] Detected ${fixes.length} npm aliases. Checking integrity...`);

    // Backup original package.json
    const originalPkg = await fs.readJSON(pkgPath);
    let tempPkg = JSON.parse(JSON.stringify(originalPkg));

    // Remove aliases from tempPkg to prevent npm from crashing
    for (const fix of fixes) {
        if (tempPkg.dependencies) delete tempPkg.dependencies[fix.aliasName];
        if (tempPkg.devDependencies) delete tempPkg.devDependencies[fix.aliasName];
    }

    try {
        // Write "clean" package.json temporarily
        await fs.writeJSON(pkgPath, tempPkg, { spaces: 2 });

        for (const fix of fixes) {
            const marker = path.join(process.cwd(), 'node_modules', fix.aliasName, 'package.json');
            
            if (!await fs.pathExists(marker)) {
                logInfo(`[Fixer] Missing aliased package: ${fix.aliasName} -> ${fix.fullAlias}`);
                logInfo(`[Fixer] Auto-downloading ${fix.actualPkgName}@${fix.actualVersion}...`);

                try {
                    const manager = detectPackageManager();
                    const installArgs = manager === 'npm' 
                        ? ['install', '--no-save', `${fix.actualPkgName}@${fix.actualVersion}`, '--legacy-peer-deps']
                        : manager === 'pnpm' 
                            ? ['add', `${fix.actualPkgName}@${fix.actualVersion}`]
                            : manager === 'yarn'
                                ? ['add', `${fix.actualPkgName}@${fix.actualVersion}`]
                                : ['add', `${fix.actualPkgName}@${fix.actualVersion}`];

                    await execa(manager, installArgs, {
                        stdio: 'inherit',
                        cwd: process.cwd(),
                        env: process.env,
                    });

                    const actualInstallPath = path.join(process.cwd(), 'node_modules', fix.actualPkgName);
                    const aliasPath = path.join(process.cwd(), 'node_modules', fix.aliasName);

                    if (fix.actualPkgName !== fix.aliasName && await fs.pathExists(actualInstallPath)) {
                        if (!await fs.pathExists(aliasPath)) {
                            logInfo(`[Fixer] Linking ${fix.actualPkgName} to alias ${fix.aliasName}...`);
                            await fs.ensureDir(path.dirname(aliasPath));
                            await fs.copy(actualInstallPath, aliasPath);
                        }
                    }

                    logSuccess(`[Fixer] Successfully auto-fixed ${fix.aliasName}.`);
                } catch (err) {
                    logError(`[Fixer] Failed to auto-download ${fix.actualPkgName}: ${err.message}`);
                }
            } else {
                logInfo(`[Fixer] ${fix.aliasName} is present in node_modules.`);
            }
        }
    } finally {
        // Always restore original package.json
        await fs.writeJSON(pkgPath, originalPkg, { spaces: 2 });
        logInfo('[Fixer] Restored original package.json.');
    }
};
