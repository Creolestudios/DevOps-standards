'use strict';

const fs = require('fs-extra');
const path = require('path');
const { logInfo, logSuccess } = require('./logger');

/**
 * checkForTypeScript(projectRoot)
 *
 * Checks if the project uses TypeScript by looking for:
 * - tsconfig.json file
 * - .ts/.tsx files in the project
 */
async function checkForTypeScript(projectRoot) {
  if (await fs.pathExists(path.join(projectRoot, 'tsconfig.json'))) {
    return true;
  }

  const searchDirs = ['src', 'lib', 'app', 'components', 'pages', 'utils'];
  for (const dir of searchDirs) {
    const dirPath = path.join(projectRoot, dir);
    if (await fs.pathExists(dirPath)) {
      try {
        const files = await fs.readdir(dirPath);
        if (files.some(file => file.endsWith('.ts') || file.endsWith('.tsx'))) return true;
      } catch {
        // Ignore directory read errors
      }
    }
  }

  try {
    const rootFiles = await fs.readdir(projectRoot);
    return rootFiles.some(file => file.endsWith('.ts') || file.endsWith('.tsx'));
  } catch {
    return false;
  }
}

/**
 * detectInstalledEslintMajor(projectRoot)
 *
 * Returns the major version number of ESLint installed in the project.
 * Defaults to 9 (modern/flat config) if ESLint cannot be found.
 */
async function detectInstalledEslintMajor(projectRoot) {
  try {
    const eslintPkgPath = path.join(projectRoot, 'node_modules', 'eslint', 'package.json');
    if (await fs.pathExists(eslintPkgPath)) {
      const eslintPkg = await fs.readJSON(eslintPkgPath);
      return parseInt(eslintPkg.version.split('.')[0], 10);
    }
  } catch { /* ignore */ }
  return 9; // assume modern by default
}

/**
 * setupESLintConfig()
 *
 * Detects the installed ESLint version ONCE and uses that single value to
 * drive every decision:
 *
 *   ESLint v9+  →  flat config  (eslint.config.mjs)
 *   ESLint v8   →  legacy config (.eslintrc.json)
 *
 * Scenarios handled:
 *   1. No config exists          → create the correct template for the ESLint version
 *   2. Config exists, right type → merge/patch only (no replacement)
 *   3. Config exists, wrong type → migrate to the correct format for the ESLint version
 */
exports.setupESLintConfig = async () => {
  const projectRoot = process.cwd();

  // If the project already has a lint script, do NOT generate/replace ESLint config.
  // In monorepos (turbo/pnpm workspaces), a root flat config can override per-package
  // lint behavior and make cs-setup "pass" while the real `pnpm lint` fails.
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (await fs.pathExists(pkgPath)) {
      const pkg = await fs.readJSON(pkgPath);
      if (pkg?.scripts?.lint) {
        logInfo('Found existing "lint" script — skipping ESLint config auto-generation.');
        return;
      }
    }
  } catch { /* ignore */ }

  // ── Step 1: detect ESLint version — single source of truth ──────────────────
  const eslintMajor = await detectInstalledEslintMajor(projectRoot);
  const useFlatConfig = eslintMajor >= 9;

  logInfo(`Detected ESLint v${eslintMajor} — using ${useFlatConfig ? 'flat config (eslint.config.mjs)' : 'legacy config (.eslintrc.json)'}`);

  // ── Step 2: install TypeScript deps if needed ────────────────────────────────
  const hasTypeScript = await checkForTypeScript(projectRoot);
  if (hasTypeScript) {
    const { installDevDependency } = require('./packageManager');
    logInfo('TypeScript files detected. Installing TypeScript ESLint dependencies...');
    await installDevDependency('@typescript-eslint/parser');
    await installDevDependency('@typescript-eslint/eslint-plugin');
    await installDevDependency('typescript');
  }

  // ── Step 3: find any existing ESLint config ──────────────────────────────────
  const flatConfigFiles = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs'];
  const legacyConfigFiles = ['.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yaml', '.eslintrc.yml', '.eslintrc.json', '.eslintrc'];
  const allConfigFiles = [...flatConfigFiles, ...legacyConfigFiles];

  let existingConfigFile = null;
  for (const file of allConfigFiles) {
    if (await fs.pathExists(path.join(projectRoot, file))) {
      existingConfigFile = file;
      break;
    }
  }

  const pkgPath = path.join(projectRoot, 'package.json');
  let hasPkgConfig = false;
  if (await fs.pathExists(pkgPath)) {
    const pkg = await fs.readJSON(pkgPath);
    if (pkg.eslintConfig) hasPkgConfig = true;
  }

  const existingIsFlatConfig = existingConfigFile && flatConfigFiles.includes(existingConfigFile);
  const existingIsLegacyConfig = existingConfigFile && legacyConfigFiles.includes(existingConfigFile);

  // ── Step 4: determine which template to use ──────────────────────────────────
  const correctTemplateFile = useFlatConfig ? 'eslint.config.mjs' : '.eslintrc.json';
  const correctTemplatePath = path.resolve(__dirname, '../templates', correctTemplateFile);
  const correctTargetPath = path.join(projectRoot, correctTemplateFile);

  // ── Step 5: handle each scenario ─────────────────────────────────────────────

  // Scenario A: existing config is already the correct type for this ESLint version
  if (
    (useFlatConfig && existingIsFlatConfig) ||
    (!useFlatConfig && existingIsLegacyConfig)
  ) {
    logInfo(`ESLint config found (${existingConfigFile}) — merging required settings...`);

    // Patch .eslintrc.json: ensure root:true and .mjs override are present
    if (!useFlatConfig && existingConfigFile === '.eslintrc.json') {
      const targetPath = path.join(projectRoot, '.eslintrc.json');
      try {
        const config = await fs.readJSON(targetPath);
        let changed = false;

        if (!config.root) {
          config.root = true;
          changed = true;
        }

        // Self-healing: remove @typescript-eslint/recommended if it was previously injected
        if (Array.isArray(config.extends)) {
          const brokenIndex = config.extends.indexOf('@typescript-eslint/recommended');
          if (brokenIndex !== -1) {
            config.extends.splice(brokenIndex, 1);
            changed = true;
            logInfo('Removed broken @typescript-eslint/recommended from extends (self-healing).');
          }
        }

        if (!config.overrides) config.overrides = [];
        const hasMjsOverride = config.overrides.some(o =>
          Array.isArray(o.files) && o.files.includes('*.mjs')
        );
        if (!hasMjsOverride) {
          config.overrides.push({
            files: ['*.mjs'],
            parserOptions: { sourceType: 'module', ecmaVersion: 'latest' }
          });
          changed = true;
        }

        if (changed) {
          await fs.writeJSON(targetPath, config, { spaces: 2 });
          logSuccess('ESLint config updated — added root:true and .mjs override.');
        } else {
          logInfo('ESLint config already up to date — no changes needed.');
        }
      } catch {
        logInfo('Could not merge into existing .eslintrc.json — skipping.');
      }
    } else {
      logInfo('Existing config is correct format — no changes needed.');
    }

    return;
  }

  // Scenario B: existing config is the WRONG type for this ESLint version → migrate
  if (existingConfigFile) {
    logInfo(`Config mismatch: found "${existingConfigFile}" but ESLint v${eslintMajor} requires "${correctTemplateFile}" — migrating...`);

    if (!await fs.pathExists(correctTemplatePath)) {
      logInfo(`Template "${correctTemplateFile}" not found — skipping migration.`);
      return;
    }

    await fs.copy(correctTemplatePath, correctTargetPath);
    logSuccess(`Created "${correctTemplateFile}" for ESLint v${eslintMajor}. Old "${existingConfigFile}" kept as backup.`);
    return;
  }

  // Scenario C: no config found → create the correct one from scratch
  logInfo(`No ESLint config found — creating "${correctTemplateFile}" for ESLint v${eslintMajor} (TypeScript: ${hasTypeScript})...`);

  if (!await fs.pathExists(correctTemplatePath)) {
    logInfo(`Template "${correctTemplateFile}" not found — skipping auto-configuration.`);
    return;
  }

  await fs.copy(correctTemplatePath, correctTargetPath);
  logSuccess(`ESLint config created: ${correctTargetPath}`);

  // TypeScript support is already handled via 'overrides' in the template .eslintrc.json.
  // Do NOT add @typescript-eslint/recommended to extends here — it requires the plugin
  // to be installed in the user's project, which may not be the case.

  // Cleanup: remove redundant eslintConfig from package.json
  if (hasPkgConfig && await fs.pathExists(pkgPath)) {
    const pkg = await fs.readJSON(pkgPath);
    if (pkg.eslintConfig) {
      delete pkg.eslintConfig;
      await fs.writeJSON(pkgPath, pkg, { spaces: 2 });
      logInfo('Removed redundant eslintConfig from package.json.');
    }
  }
};