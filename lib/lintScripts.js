'use strict';

const fs = require('fs-extra');
const path = require('path');
const { logInfo, logSuccess } = require('./logger');

/**
 * setupLintScripts()
 *
 * Adds a "lint" script to package.json if one doesn't already exist.
 * Detects the project type (Next.js, Turbo, Vite, plain ESLint) and
 * picks the most appropriate command.
 *
 * This must run BEFORE setupESLintConfig() so that the config generator
 * sees the lint script and doesn't skip ESLint config creation.
 */
exports.setupLintScripts = async () => {
  const pkgPath = path.join(process.cwd(), 'package.json');
  if (!await fs.pathExists(pkgPath)) return;

  const pkg = await fs.readJSON(pkgPath);
  if (pkg.scripts && pkg.scripts.lint) {
    logInfo('Found existing "lint" script — skipping auto-generation.');
    return;
  }

  const cwd = process.cwd();

  // Detect project type
  const hasNext =
    fs.existsSync(path.join(cwd, 'next.config.js')) ||
    fs.existsSync(path.join(cwd, 'next.config.mjs')) ||
    fs.existsSync(path.join(cwd, 'next.config.ts')) ||
    !!(pkg.dependencies?.next || pkg.devDependencies?.next);

  const hasTurbo =
    fs.existsSync(path.join(cwd, 'turbo.json')) ||
    !!(pkg.dependencies?.turbo || pkg.devDependencies?.turbo);

  let lintCmd = '';

  if (hasNext) {
    lintCmd = 'next lint';
  } else if (hasTurbo) {
    lintCmd = 'turbo lint';
  } else {
    // Use npx to invoke eslint — this works cross-platform (Windows Git Bash, WSL, Linux, macOS)
    // Direct ./node_modules/.bin/eslint paths can fail on Windows Git Bash
    lintCmd = 'npx eslint .';
  }

  pkg.scripts = pkg.scripts || {};
  pkg.scripts.lint = lintCmd;

  await fs.writeJson(pkgPath, pkg, { spaces: 2 });
  logSuccess(`Added "lint": "${lintCmd}" to package.json`);
};
