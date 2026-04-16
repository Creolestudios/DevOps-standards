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
 * Previously this appended --rule "{\"no-unused-vars\":\"off\"}" to the lint
 * script as a workaround for TS/ESLint crashes. That approach is no longer used —
 * the correct fix is to handle no-unused-vars in the ESLint config itself via
 * ensureLegacyNoUnusedVarsFix(), not by polluting the lint CLI command.
 *
 * This function now CLEANS UP any --rule overrides previously injected, restoring
 * the lint script to a plain `eslint .` (or whatever the base command was).
 */
exports.ensureLintScriptSafety = async () => {
  const pkgPath = path.join(process.cwd(), 'package.json');
  if (!await fs.pathExists(pkgPath)) return;

  let pkg;
  try {
    pkg = await fs.readJSON(pkgPath);
  } catch {
    return;
  }
  if (!pkg.scripts?.lint) return;

  const lint = String(pkg.scripts.lint);

  // Only touch eslint invocations
  const looksLikeEslintCmd =
    lint.trim() === 'eslint' ||
    lint.trim().startsWith('eslint ') ||
    lint.includes(' eslint ') ||
    lint.includes('npx eslint') ||
    lint.includes('pnpm eslint') ||
    lint.includes('yarn eslint');

  if (!looksLikeEslintCmd) return;

  // Strip any --rule flags that were previously injected by cs-setup
  let cleaned = lint;
  cleaned = cleaned.replace(/\s--rule\s+["']?no-unused-vars:off["']?/g, ' ');
  cleaned = cleaned.replace(/\s--rule\s+["']?\{[^"']*no-unused-vars[^"']*:\s*["']?off["']?[^"']*\}["']?/g, ' ');
  cleaned = cleaned.replace(/\s--rule\s+"[^"]*no-unused-vars[^"]*"/g, ' ');
  cleaned = cleaned.replace(/\s--rule\s+'[^']*no-unused-vars[^']*'/g, ' ');
  // Remove any dangling --rule with no value
  cleaned = cleaned.replace(/\s--rule(\s*(?=--|$))/g, ' ');
  // Collapse extra whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (cleaned !== lint) {
    pkg.scripts.lint = cleaned;
    await fs.writeJSON(pkgPath, pkg, { spaces: 2 });
    logSuccess('Cleaned up lint script — removed injected --rule overrides.');
  }
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
 * Auto-fixes two classes of failures:
 *
 * 1. TypeScript >= 5.6 with @typescript-eslint v7 (or older)
 *    → produces "unsupported TypeScript" warnings and can crash ESLint.
 *
 * 2. ESLint v9 with @typescript-eslint that uses removed APIs
 *    (context.getScope, context.getAllComments, etc.)
 *    → @typescript-eslint v6 and below use these removed APIs.
 *    → Requires @typescript-eslint v6+ for ESLint v8, v8+ for ESLint v9.
 *
 * Strategy: always ensure @typescript-eslint major matches ESLint major requirements.
 */
exports.ensureTypeScriptEslintCompatibility = async () => {
  const projectRoot = process.cwd();
  const tsVersionRaw = await detectTypeScriptVersion(projectRoot);
  const ts = parseMajorMinor(tsVersionRaw);
  const installedTseMajor = await detectTypescriptEslintMajor(projectRoot);
  const eslintMajor = await detectInstalledEslintMajorSafe(projectRoot);

  // No @typescript-eslint installed at all — nothing to check
  if (installedTseMajor === 0) return;

  const { installDevDependency } = require('./packageManager');

  // Rule 1: ESLint v9 requires @typescript-eslint v6+ (v6 added ESLint v9 API support)
  // In practice v8+ is the safe minimum for full ESLint v9 compatibility
  if (eslintMajor >= 9 && installedTseMajor < 8) {
    logInfo(`ESLint v${eslintMajor} detected with @typescript-eslint v${installedTseMajor} — upgrading to v8+ for ESLint v9 API compatibility...`);
    await installDevDependency('@typescript-eslint/parser@^8.0.0', { force: true });
    await installDevDependency('@typescript-eslint/eslint-plugin@^8.0.0', { force: true });
    logSuccess('@typescript-eslint upgraded for ESLint v9 compatibility.');
    return;
  }

  // Rule 2: TypeScript >= 5.6 requires @typescript-eslint v8+
  if (ts) {
    const isTsTooNewForOldTypescriptEslint =
      ts.major > 5 || (ts.major === 5 && ts.minor >= 6);

    if (isTsTooNewForOldTypescriptEslint && installedTseMajor < 8) {
      logInfo(`TypeScript ${ts.major}.${ts.minor} detected with @typescript-eslint v${installedTseMajor} — upgrading to v8+ for TypeScript compatibility...`);
      await installDevDependency('@typescript-eslint/parser@^8.0.0', { force: true });
      await installDevDependency('@typescript-eslint/eslint-plugin@^8.0.0', { force: true });
      logSuccess('TypeScript ESLint toolchain updated for TypeScript compatibility.');
    }
  }
};

/**
 * ensureEslintRuntimeCompatibility()
 *
 * Handles ESLint version compatibility in both directions:
 *
 * UPGRADE: Node >= 22 + ESLint v8 → upgrade to v9 (if no incompatible plugins)
 * DOWNGRADE: ESLint v9 already installed + incompatible plugins present → downgrade to v8
 *
 * Plugins known incompatible with ESLint v9 (use removed APIs):
 *   - eslint-plugin-flowtype  (context.getAllComments removed)
 *   - eslint-plugin-babel     (context.getAllComments removed)
 *   - eslint-plugin-standard  (context.getAllComments removed)
 */
exports.ensureEslintRuntimeCompatibility = async () => {
  const projectRoot = process.cwd();
  const nodeMajor = await detectNodeMajor();
  const eslintMajor = await detectInstalledEslintMajorSafe(projectRoot);

  // Plugins known to be incompatible with ESLint v9 (use removed APIs like getAllComments/getSource)
  // Format: { name, minCompatibleVersion } — versions below minCompatibleVersion are incompatible
  const v9IncompatiblePlugins = [
    { name: 'eslint-plugin-flowtype',    minCompatibleVersion: null },  // never updated for v9
    { name: 'eslint-plugin-babel',       minCompatibleVersion: null },  // never updated for v9
    { name: 'eslint-plugin-standard',    minCompatibleVersion: null },  // never updated for v9
    { name: 'eslint-plugin-react-hooks', minCompatibleVersion: '5.0.0' },
    { name: 'eslint-plugin-react',       minCompatibleVersion: '7.37.0' },
    { name: 'eslint-plugin-import',      minCompatibleVersion: '2.31.0' },
    { name: 'eslint-plugin-jsx-a11y',    minCompatibleVersion: '6.10.0' },
  ];

  // Check installed plugins — only flag if version is too old or never updated
  const incompatibleInstalled = [];
  for (const { name, minCompatibleVersion } of v9IncompatiblePlugins) {
    const pluginPkgPath = path.join(projectRoot, 'node_modules', name, 'package.json');
    if (await fs.pathExists(pluginPkgPath)) {
      if (!minCompatibleVersion) {
        // Plugin never updated for ESLint v9 — always incompatible
        incompatibleInstalled.push(name);
      } else {
        try {
          const pluginPkg = await fs.readJSON(pluginPkgPath);
          const installed = parseMajorMinor(pluginPkg.version);
          const required = parseMajorMinor(minCompatibleVersion);
          if (installed && required) {
            const tooOld =
              installed.major < required.major ||
              (installed.major === required.major && installed.minor < required.minor);
            if (tooOld) {
              incompatibleInstalled.push(`${name}@${pluginPkg.version} (need >=${minCompatibleVersion})`);
            }
          }
        } catch { /* ignore */ }
      }
    }
  }

  // Also check ESLint config files for plugin references
  let incompatibleInConfig = false;
  if (incompatibleInstalled.length === 0) {
    const legacyConfigs = ['.eslintrc.json', '.eslintrc.js', '.eslintrc.yml', '.eslintrc.yaml', '.eslintrc'];
    for (const configFile of legacyConfigs) {
      const configPath = path.join(projectRoot, configFile);
      if (await fs.pathExists(configPath)) {
        try {
          const raw = await fs.readFile(configPath, 'utf8');
          if (raw.includes('flowtype') || raw.includes('eslint-plugin-babel') || raw.includes('eslint-plugin-standard')) {
            incompatibleInConfig = true;
            break;
          }
        } catch { /* ignore */ }
      }
    }
  }

  const hasIncompatiblePlugins = incompatibleInstalled.length > 0 || incompatibleInConfig;

  // ── CASE 1: ESLint v9 already installed + incompatible plugins → DOWNGRADE to v8 ──
  if (eslintMajor >= 9 && hasIncompatiblePlugins) {
    const { installDevDependency } = require('./packageManager');
    const pluginList = incompatibleInstalled.length > 0
      ? incompatibleInstalled.join(', ')
      : 'plugin referenced in ESLint config';
    logInfo(`ESLint v${eslintMajor} detected with incompatible plugin(s): ${pluginList}`);
    logInfo('Downgrading ESLint to v8 for compatibility...');
    await installDevDependency('eslint@^8.57.0', { force: true });
    logSuccess('ESLint downgraded to v8 for plugin compatibility.');
    return;
  }

  // ── CASE 2: ESLint v8 + Node >= 22 + no incompatible plugins → UPGRADE to v9 ──
  if (eslintMajor === 8 && nodeMajor >= 22 && !hasIncompatiblePlugins) {
    const { installDevDependency } = require('./packageManager');
    logInfo(`Node ${nodeMajor} detected with ESLint v8 — upgrading to ESLint v9 for stability...`);
    await installDevDependency('eslint@^9.0.0', { force: true });
    await installDevDependency('@eslint/js@^9.0.0', { force: true });
    logSuccess('ESLint upgraded for Node runtime compatibility.');
  }
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

  // If the project already has a lint script, skip ESLint config auto-generation
  // ONLY if a valid ESLint config already exists for the installed ESLint version.
  // Do NOT skip if ESLint v9 is installed but only a legacy config exists — that
  // combination will crash at commit time with "couldn't find eslint.config.*".
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (await fs.pathExists(pkgPath)) {
      const pkg = await fs.readJSON(pkgPath);
      if (pkg?.scripts?.lint) {
        // Check if a flat config already exists — if so, we're good, skip generation
        const flatConfigs = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs'];
        const hasFlatConfig = await Promise.any(
          flatConfigs.map(f => fs.pathExists(path.join(projectRoot, f)).then(e => { if (!e) throw new Error(); return true; }))
        ).catch(() => false);

        if (hasFlatConfig) {
          logInfo('Found existing "lint" script and flat ESLint config — skipping ESLint config auto-generation.');
          return;
        }
        // No flat config — fall through to create/migrate one even though lint script exists
        logInfo('Found "lint" script but no flat ESLint config — will create/migrate config for ESLint v9 compatibility.');
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