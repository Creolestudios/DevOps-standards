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

function parseMajorMinor(version) {
  if (!version) return null;
  const m = String(version).trim().match(/^(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

async function detectTypeScriptVersion(projectRoot) {
  // Prefer installed TypeScript
  try {
    const tsPkgPath = path.join(projectRoot, 'node_modules', 'typescript', 'package.json');
    if (await fs.pathExists(tsPkgPath)) {
      const tsPkg = await fs.readJSON(tsPkgPath);
      return tsPkg.version || null;
    }
  } catch { /* ignore */ }

  // Fallback to package.json version range
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (await fs.pathExists(pkgPath)) {
      const pkg = await fs.readJSON(pkgPath);
      return pkg.devDependencies?.typescript || pkg.dependencies?.typescript || null;
    }
  } catch { /* ignore */ }

  return null;
}

async function detectTypescriptEslintMajor(projectRoot) {
  try {
    const parserPkgPath = path.join(projectRoot, 'node_modules', '@typescript-eslint', 'parser', 'package.json');
    if (await fs.pathExists(parserPkgPath)) {
      const parserPkg = await fs.readJSON(parserPkgPath);
      return parseInt(String(parserPkg.version || '0').split('.')[0], 10) || 0;
    }
  } catch { /* ignore */ }
  return 0;
}

async function detectHasTypeScript(projectRoot) {
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (await fs.pathExists(pkgPath)) {
      const pkg = await fs.readJSON(pkgPath);
      if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) return true;
    }
  } catch { /* ignore */ }
  return checkForTypeScript(projectRoot);
}

function ensureRulesObject(obj) {
  if (!obj.rules || typeof obj.rules !== 'object') obj.rules = {};
  return obj.rules;
}

function upsertTsNoUnusedVarsRules(target) {
  // Prefer @typescript-eslint/no-unused-vars on TS files; disable core rule.
  const rules = ensureRulesObject(target);
  rules['no-unused-vars'] = 'off';
  rules['@typescript-eslint/no-unused-vars'] = rules['@typescript-eslint/no-unused-vars'] || [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }
  ];
}

/**
 * ensureLegacyNoUnusedVarsFix()
 *
 * Auto-fix for a recurring crash class:
 * - ESLint (core) `no-unused-vars` can crash in TS projects under certain parser/toolchain combos.
 * - Standard practice is: disable core `no-unused-vars` for TS and use `@typescript-eslint/no-unused-vars`.
 *
 * This only patches legacy configs we can edit safely:
 * - `.eslintrc.json`
 * - `package.json` -> `eslintConfig`
 */
exports.ensureLegacyNoUnusedVarsFix = async () => {
  const projectRoot = process.cwd();
  const hasTs = await detectHasTypeScript(projectRoot);
  if (!hasTs) return;

  const eslintrcJsonPath = path.join(projectRoot, '.eslintrc.json');
  if (await fs.pathExists(eslintrcJsonPath)) {
    try {
      const cfg = await fs.readJSON(eslintrcJsonPath);

      // Apply at root rules (harmless even for JS) and ensure TS override if present.
      // If overrides exist, ensure TS files route to @typescript-eslint/no-unused-vars.
      upsertTsNoUnusedVarsRules(cfg);

      if (!Array.isArray(cfg.overrides)) cfg.overrides = [];
      const tsOverride = cfg.overrides.find(o =>
        Array.isArray(o.files) && o.files.some(f => String(f).includes('*.ts'))
      );
      if (tsOverride) {
        if (!tsOverride.parser) tsOverride.parser = '@typescript-eslint/parser';
        if (!Array.isArray(tsOverride.plugins)) tsOverride.plugins = [];
        if (!tsOverride.plugins.includes('@typescript-eslint')) tsOverride.plugins.push('@typescript-eslint');
        upsertTsNoUnusedVarsRules(tsOverride);
      } else {
        cfg.overrides.push({
          files: ['*.ts', '*.tsx'],
          parser: '@typescript-eslint/parser',
          plugins: ['@typescript-eslint'],
          rules: {
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': [
              'error',
              { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }
            ]
          }
        });
      }

      await fs.writeJSON(eslintrcJsonPath, cfg, { spaces: 2 });
      logSuccess('Patched .eslintrc.json — use @typescript-eslint/no-unused-vars for TS.');
      return;
    } catch {
      // ignore
    }
  }

  // package.json eslintConfig (legacy)
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!await fs.pathExists(pkgPath)) return;
    const pkg = await fs.readJSON(pkgPath);
    if (!pkg.eslintConfig) return;
    const cfg = pkg.eslintConfig;
    upsertTsNoUnusedVarsRules(cfg);
    pkg.eslintConfig = cfg;
    await fs.writeJSON(pkgPath, pkg, { spaces: 2 });
    logSuccess('Patched package.json eslintConfig — use @typescript-eslint/no-unused-vars for TS.');
  } catch {
    // ignore
  }
};

/**
 * ensureLintScriptSafety()
 *
 * Some repos run eslint directly from package.json scripts, e.g.:
 *   "lint": "eslint src/**\\/*.ts"
 *
 * When core `no-unused-vars` crashes on TS ASTs (observed with newer Node/TS),
 * patching config files isn't always possible (e.g. .eslintrc.js). As a safe
 * fallback, we can amend the lint script to disable the core rule explicitly:
 *   --rule "no-unused-vars:off"
 *
 * This is idempotent and only applies when the lint script is an eslint CLI run.
 */
exports.ensureLintScriptSafety = async () => {
  const projectRoot = process.cwd();
  const hasTs = await detectHasTypeScript(projectRoot);
  if (!hasTs) return;

  const pkgPath = path.join(projectRoot, 'package.json');
  if (!await fs.pathExists(pkgPath)) return;

  let pkg;
  try {
    pkg = await fs.readJSON(pkgPath);
  } catch {
    return;
  }
  if (!pkg.scripts?.lint) return;

  const lint = String(pkg.scripts.lint);

  // Only patch if this is an eslint invocation (not turbo/next/etc)
  const looksLikeEslintCmd =
    lint.trim() === 'eslint' ||
    lint.trim().startsWith('eslint ') ||
    lint.includes(' eslint ') ||
    lint.includes('npx eslint') ||
    lint.includes('pnpm eslint') ||
    lint.includes('yarn eslint');

  if (!looksLikeEslintCmd) return;

  // Already patched?
  if (/\-\-rule\s+["']?\{/.test(lint) && /no-unused-vars["']?\s*:\s*["']?off/.test(lint)) return;
  if (/\-\-rule\s+["']?no-unused-vars:off["']?/.test(lint)) {
    // Convert legacy form to ESLint v9+ expected object form
    const fixed = lint.replace(/\-\-rule\s+["']?no-unused-vars:off["']?/, '--rule "{\\"no-unused-vars\\":\\"off\\"}"');
    pkg.scripts.lint = fixed;
    await fs.writeJSON(pkgPath, pkg, { spaces: 2 });
    logSuccess('Updated package.json "lint" --rule to object format (ESLint v9+).');
    return;
  }

  // ESLint v9 expects --rule value to be an object (JSON).
  // Use escaped quotes so it survives Windows cmd + sh.
  pkg.scripts.lint = `${lint} --rule "{\\\"no-unused-vars\\\":\\\"off\\\"}"`;
  await fs.writeJSON(pkgPath, pkg, { spaces: 2 });
  logSuccess('Patched package.json "lint" to disable core no-unused-vars (TS crash guard).');
};

async function detectNodeMajor() {
  try {
    return parseInt(process.versions.node.split('.')[0], 10);
  } catch {
    return 0;
  }
}

async function detectInstalledEslintMajorSafe(projectRoot) {
  try {
    const eslintPkgPath = path.join(projectRoot, 'node_modules', 'eslint', 'package.json');
    if (await fs.pathExists(eslintPkgPath)) {
      const eslintPkg = await fs.readJSON(eslintPkgPath);
      return parseInt(String(eslintPkg.version || '0').split('.')[0], 10) || 0;
    }
  } catch { /* ignore */ }
  return 0;
}

/**
 * ensureTypeScriptEslintCompatibility()
 *
 * Auto-fixes a common class of failures:
 * - TypeScript >= 5.6 with @typescript-eslint v7 (or older)
 *   → produces "unsupported TypeScript" warnings and can crash ESLint (especially on v8).
 *
 * Strategy:
 * - If TypeScript is detected and is >= 5.6, ensure @typescript-eslint/* is v8+.
 * - We do NOT downgrade TypeScript.
 */
exports.ensureTypeScriptEslintCompatibility = async () => {
  const projectRoot = process.cwd();
  const tsVersionRaw = await detectTypeScriptVersion(projectRoot);
  const ts = parseMajorMinor(tsVersionRaw);
  if (!ts) return;

  const isTsTooNewForOldTypescriptEslint =
    ts.major > 5 || (ts.major === 5 && ts.minor >= 6);

  if (!isTsTooNewForOldTypescriptEslint) return;

  const installedTseMajor = await detectTypescriptEslintMajor(projectRoot);
  if (installedTseMajor >= 8) return;

  const { installDevDependency } = require('./packageManager');
  logInfo(`TypeScript ${ts.major}.${ts.minor} detected — ensuring @typescript-eslint v8+ for compatibility...`);
  await installDevDependency('@typescript-eslint/parser@^8.0.0', { force: true });
  await installDevDependency('@typescript-eslint/eslint-plugin@^8.0.0', { force: true });
  logSuccess('TypeScript ESLint toolchain updated for TypeScript compatibility.');
};

/**
 * ensureEslintRuntimeCompatibility()
 *
 * Auto-fix for ESLint v8 crashing under newer Node/TS combos.
 * Strategy:
 * - If Node is very new (>=22) and ESLint major is 8, upgrade to ESLint v9.
 * - Also ensure @eslint/js v9.
 *
 * Note: ESLint v9 prefers flat config, but we do not enforce config migration here;
 * hooks can set ESLINT_USE_FLAT_CONFIG=false when legacy configs are detected.
 */
exports.ensureEslintRuntimeCompatibility = async () => {
  const projectRoot = process.cwd();
  const nodeMajor = await detectNodeMajor();
  const eslintMajor = await detectInstalledEslintMajorSafe(projectRoot);
  if (eslintMajor !== 8) return;
  if (nodeMajor < 22) return;

  const { installDevDependency } = require('./packageManager');
  logInfo(`Node ${nodeMajor} detected with ESLint v8 — upgrading to ESLint v9 for stability...`);
  await installDevDependency('eslint@^9.0.0', { force: true });
  await installDevDependency('@eslint/js@^9.0.0', { force: true });
  logSuccess('ESLint upgraded for Node runtime compatibility.');
};

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

  // Before dealing with config formats, make sure TS/toolchain versions are compatible.
  // This prevents crashes like:
  // - "SUPPORTED TYPESCRIPT VERSIONS ... YOUR TYPESCRIPT VERSION: 5.9.x"
  // - ESLint AssertionError in core rules when parser tooling is incompatible
  await exports.ensureTypeScriptEslintCompatibility();
  await exports.ensureEslintRuntimeCompatibility();
  await exports.ensureLegacyNoUnusedVarsFix();
  await exports.ensureLintScriptSafety();

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