#!/usr/bin/env node
'use strict';

// Under pnpm/yarn, lifecycle scripts run after dependencies are linked.
// Attempting to run `npm install` inside our own package directory can break
// (pnpm uses a symlinked store layout and expects immutability).
console.log('[cs-setup] Script starting...');

const fs = require('fs');
const path = require('path');

const { installHusky } = require('../lib/husky');
const { installGitleaks } = require('../lib/gitleaks');
const { installSonarScanner, setupSonarProperties } = require('../lib/sonarqube');
const { setupPreCommitHook } = require('../lib/hooks');
const { setupPrePushHook, setupCIScript,
  setupCIWorkflow, ensurePackageLock } = require('../lib/ci');
const { isGitRepo } = require('../lib/git');
const { logInfo, logError, logSuccess } = require('../lib/logger');
const { fixInvalidAliases } = require('../lib/fixer');
const { setupESLintConfig } = require('../lib/eslint');
const { ensureTypeScriptEslintCompatibility } = require('../lib/eslint');


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
const userAgent = String(process.env.npm_config_user_agent || '');
const pmFromUserAgent =
  userAgent.startsWith('pnpm/') ? 'pnpm' :
  userAgent.startsWith('yarn/') ? 'yarn' :
  userAgent.startsWith('bun/') ? 'bun' :
  'npm';

if (isPostInstall) {
  console.log('\n\x1b[1m\x1b[34m[cs-setup] 🚀 Automatic setup starting...\x1b[0m');
}

// Yarn/pnpm installs are more strict about lifecycle side-effects.
// In particular, running a package manager again during installation (to add deps,
// modify scripts, etc.) can break the install (yarn) or be blocked (pnpm approve-builds).
// We keep full automation for npm, but for others we require explicit `init`.
if (isPostInstall && pmFromUserAgent !== 'npm') {
  console.log(`[cs-setup] Detected package manager "${pmFromUserAgent}" via user agent.`);
  console.log('[cs-setup] Skipping automatic postinstall setup.');
  console.log('[cs-setup] Run this after install: npx cs-setup init');
  process.exit(0);
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
    const targetTool = process.argv[3]; // e.g. 'gitleaks'

    if (command === 'install' && targetTool === 'gitleaks') {
      const { found, gitRoot } = await isGitRepo();
      if (!found) {
        logInfo('Not a git repository — skipping gitleaks install.');
        process.exit(0);
      }
      await installGitleaks(gitRoot);
      process.exit(0);
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
      const { installAllRequiredDependencies } = require('../lib/packageManager');
      await installSonarScanner();
      await installAllRequiredDependencies();

      await ensureTypeScriptEslintCompatibility();
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

    const { installAllRequiredDependencies } = require('../lib/packageManager');
    await installHusky(gitRoot);
    await installGitleaks(gitRoot);
    await installSonarScanner();
    
    // Install all required ESLint dependencies
    await installAllRequiredDependencies();

    // Setup ESLint with TypeScript support
    await ensureTypeScriptEslintCompatibility();
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