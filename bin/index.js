#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// STEP 0 — Self-install own dependencies using ONLY Node.js built-ins.
//
// When installed via `npm install /local/path` or `npm install github:user/repo`,
// npm does NOT guarantee our own node_modules exists before running postinstall.
// We must bootstrap ourselves using only fs, path, child_process (always available).
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const PKG_DIR = path.resolve(__dirname, '..');          // our package root
const OWN_NODE_MODULES = path.join(PKG_DIR, 'node_modules');
const SENTINEL = path.join(OWN_NODE_MODULES, 'fs-extra', 'package.json');

if (!fs.existsSync(SENTINEL)) {
  console.log('[cs-setup] Installing own dependencies first...');
  
  // Minimal detection for bootstrap phase
  let manager = 'npm';
  if (fs.existsSync(path.join(PKG_DIR, 'pnpm-lock.yaml'))) manager = 'pnpm';
  else if (fs.existsSync(path.join(PKG_DIR, 'yarn.lock'))) manager = 'yarn';
  else if (fs.existsSync(path.join(PKG_DIR, 'bun.lockb'))) manager = 'bun';

  const installArgs = (manager === 'yarn' || manager === 'pnpm' || manager === 'bun') 
    ? ['install', '--ignore-scripts'] 
    : ['install', '--ignore-scripts', '--legacy-peer-deps'];

  const result = spawnSync(manager, installArgs, {
    cwd: PKG_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`[cs-setup] Failed to install own dependencies via ${manager}. Please run:`);
    console.error(`  cd ${PKG_DIR} && ${manager} install`);
    process.exit(0);
  }
  console.log('[cs-setup] Own dependencies installed.');
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Now safe to require our dependencies
// ─────────────────────────────────────────────────────────────────────────────
console.log('[cs-setup] Script starting...');

const { installHusky } = require('../lib/husky');
const { installGitleaks } = require('../lib/gitleaks');
const { installSonarScanner, setupSonarProperties } = require('../lib/sonarqube');
const { setupPreCommitHook } = require('../lib/hooks');
const { setupPrePushHook, setupCIScript,
  setupCIWorkflow, validateProject,
  ensurePackageLock } = require('../lib/ci');
const { isGitRepo } = require('../lib/git');
const { logInfo, logError, logSuccess } = require('../lib/logger');
const { fixInvalidAliases } = require('../lib/fixer');
const { setupESLintConfig } = require('../lib/eslint');
const { readJSON } = require('../lib/utils');

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — Parse command and detect context
// ─────────────────────────────────────────────────────────────────────────────
const command = process.argv[2];
const validCommands = ['init', 'install', 'check-hooks'];

if (command && !validCommands.includes(command)) {
  console.log('Usage: cs-setup [init|install|check-hooks]');
  process.exit(0);
}

const isPostInstall = process.env.npm_lifecycle_event === 'postinstall';
const initCwd = process.env.INIT_CWD || process.env.npm_config_local_prefix;

if (isPostInstall) {
  console.log('\n\x1b[1m\x1b[34m[cs-setup] 🚀 Automatic setup starting...\x1b[0m');
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Guard: skip if npm is installing OUR OWN deps (nested postinstall)
//
// We want to run ONLY when the USER installs us.
// If process.cwd() is the SAME as initCwd, it means someone is running 
// 'npm install' inside the cs-setup folder itself (development) — skip.
// ─────────────────────────────────────────────────────────────────────────────
if (isPostInstall) {
  const currentDir = path.resolve(process.cwd());
  let projectDir = initCwd ? path.resolve(initCwd) : null;

  console.log(`[cs-setup] Post-install check: currentDir=${currentDir}, projectDir=${projectDir}`);

  // If we are developing (currentDir === projectDir), skip setup
  if (currentDir === projectDir) {
    console.log('[cs-setup] Development detected — skipping automatic setup.');
    process.exit(0);
  }

  if (!projectDir) {
    // Attempt fallback: if we're in node_modules/cs-setup, projectDir is 2 levels up
    if (currentDir.includes('node_modules')) {
      const potentialProjectDir = path.resolve(currentDir, '..', '..');
      if (fs.existsSync(path.join(potentialProjectDir, 'package.json'))) {
        logInfo(`INIT_CWD missing, but local node_modules detected. Assuming project root: ${potentialProjectDir}`);
        projectDir = potentialProjectDir;
      }
    }
  }

  if (!projectDir) {
    logError('Could not determine project directory. Run `npx cs-setup init` manually.');
    process.exit(0);
  }

  // cd into the user's project
  if (process.cwd() !== projectDir) {
    try {
      process.chdir(projectDir);
      logInfo(`Target project: ${projectDir}`);
    } catch (e) {
      logError(`Failed to switch to project directory: ${e.message}`);
      process.exit(0);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — Run the full setup
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  try {
    if (command === 'install') {
      const source = process.argv[3] || 'github:Creolestudios/DevOps-standards';
      const { detectPackageManager, getHttpsUrl, whitelistInPnpm } = require('../lib/packageManager');
      const manager = detectPackageManager();
      
      logInfo(`[install] Starting one-step installation for ${manager}...`);

      if (manager === 'pnpm') {
        await whitelistInPnpm();
      }

      // 1. Fix source to HTTPS if needed
      const fixedSource = getHttpsUrl(source);
      
      // 2. Install the package itself as a devDependency
      const spawn = require('child_process').spawnSync;
      const installArgs = manager === 'pnpm' ? ['add', '-D', fixedSource] : 
                        (manager === 'yarn' ? ['add', '-D', fixedSource] : 
                        (manager === 'bun' ? ['add', '-d', fixedSource] : ['install', '--save-dev', fixedSource]));
      
      logInfo(`[install] Running: ${manager} ${installArgs.join(' ')}`);
      const res = spawn(manager, installArgs, { stdio: 'inherit', shell: true });
      
      if (res.status === 0) {
        logSuccess(`[install] ${fixedSource} added to devDependencies.`);
      } else {
        logError(`[install] Failed to install package via ${manager}. Please check your authentication.`);
        process.exit(1);
      }

      logInfo('[install] Proceeding with project initialization...');
      // Fall through to init logic below
    }

    const { found, gitRoot, projectRoot } = await isGitRepo();

    if (command === 'check-hooks') {
      if (!found) {
        logInfo('Not a git repository — skipping check-hooks.');
        process.exit(0);
      }

      logInfo('\x1b[1mChecking git hooks and configuration integrity...\x1b[0m');

      // Always re-run these to ensure hooks are up-to-date and configs are present
      await installHusky(gitRoot);
      await setupPreCommitHook(gitRoot);
      await setupPrePushHook(gitRoot);

      // Ensure tools are installed
      const { installSonarScanner } = require('../lib/sonarqube');
      const { whitelistInPnpm, installAllRequiredDependencies } = require('../lib/packageManager');
      await whitelistInPnpm();
      await installSonarScanner();
      await installAllRequiredDependencies();

      await setupESLintConfig();
      await setupSonarProperties();
      
      // Setup CI script and Workflows
      await setupCIScript(projectRoot);
      await setupCIWorkflow(gitRoot);
      
      logSuccess('Git hooks and configuration verified/restored.');
      process.exit(0);
    }

    logInfo('cs-setup: Initializing secure git hooks...');

    // ─────────────────────────────────────────────────────────────────────────────
    // AUTO-FIX: Handle invalid npm aliases (e.g. rolldown-vite@7.2.2)
    // ─────────────────────────────────────────────────────────────────────────────
    await fixInvalidAliases();

    if (!found) {
      logError('Not inside a git repository — skipping setup.');
      logInfo('Run `git init` first, then: npx cs-setup init');
      process.exit(0);
    }

    if (gitRoot !== projectRoot) {
      logInfo(`Git root:     ${gitRoot}`);
      logInfo(`Project root: ${projectRoot}`);
      logInfo('Monorepo detected — hooks at git root, config files at project root.');
    }

    const { whitelistInPnpm, installAllRequiredDependencies } = require('../lib/packageManager');
    await whitelistInPnpm();
    await installHusky(gitRoot);
    await installGitleaks(gitRoot);
    await installSonarScanner();
    
    // Install all required ESLint dependencies
    await installAllRequiredDependencies();

    // Setup ESLint with TypeScript support
    await setupESLintConfig();

    await setupSonarProperties();
    await setupPreCommitHook(gitRoot);
    logSuccess('Husky + Gitleaks + SonarQube pre-commit hook ready.');
    logInfo('Edit sonar-project.properties — set sonar.host.url and sonar.token.');

    await ensurePackageLock();
    await setupCIScript(projectRoot);
    await require('../lib/ci').ensureProjectScripts();
    
    await setupCIWorkflow(gitRoot);
    await setupPrePushHook(gitRoot);
    logSuccess('Pre-push hook ready.');

  } catch (err) {
    logError(`cs-setup failed: ${err.message}`);
    process.exit(0);
  }
})();