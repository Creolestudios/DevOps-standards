'use strict';

const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const { logInfo, logSuccess, logError } = require('./logger');

const TEMPLATE_PATH = path.resolve(__dirname, '../templates/ci-tests.yml');
const CI_SCRIPT_TEMPLATE = path.resolve(__dirname, '../templates/run-ci-checks.sh');

exports.setupCIScript = async (gitRoot) => {
  const scriptsDir = path.join(gitRoot, 'scripts');
  const scriptPath = path.join(scriptsDir, 'run-ci-checks.sh');

  await fs.ensureDir(scriptsDir);

  if (await fs.pathExists(scriptPath)) {
    logInfo("run-ci-checks.sh already exists — overwriting with latest version.");
  } else {
    logInfo("Creating scripts/run-ci-checks.sh...");
  }

  // Read from template file instead of building strings
  // This avoids ALL quote escaping issues (JS -> SH -> Node multi-layer quoting)
  if (!await fs.pathExists(CI_SCRIPT_TEMPLATE)) {
    logError("CI script template not found. Please reinstall the package.");
    return;
  }
  // Guard: skip if source and destination are the same file (running in cs-setup's own dir)
  if (path.resolve(CI_SCRIPT_TEMPLATE) === path.resolve(scriptPath)) {
    logInfo("CI script template and destination are the same — skipping copy.");
    return;
  }

  await fs.copy(CI_SCRIPT_TEMPLATE, scriptPath);
  await fs.chmod(scriptPath, 0o755);
  logSuccess("scripts/run-ci-checks.sh created.");

  // NEW: Copy the Newman Cloud test template to tests/run-newman-cloud.mjs
  const newmanTemplate = path.resolve(__dirname, '../templates/run-newman-cloud.mjs.template');
  const testsDir = path.join(gitRoot, 'tests');
  const newmanTarget = path.join(testsDir, 'run-newman-cloud.mjs');

  if (fs.existsSync(newmanTemplate)) {
    await fs.ensureDir(testsDir);
    const exists = fs.existsSync(newmanTarget);
    await fs.copy(newmanTemplate, newmanTarget, { overwrite: true });
    logSuccess(exists
      ? "tests/run-newman-cloud.mjs updated to latest version."
      : "tests/run-newman-cloud.mjs created from template."
    );
  }

  logInfo("To move tests to pre-commit in future: add './scripts/run-ci-checks.sh' to .husky/pre-commit.");
};

exports.setupPrePushHook = async (gitRoot) => {
  const huskyDir = path.join(gitRoot, '.husky');
  const hookPath = path.join(huskyDir, 'pre-push');

  if (!await fs.pathExists(huskyDir)) {
    logInfo("Husky directory not found. Skipping pre-push hook setup.");
    return;
  }

  const projectDir = path.relative(gitRoot, process.cwd()) || '.';

  if (await fs.pathExists(hookPath)) {
    logInfo("Pre-push hook already configured. Overwriting with latest setup...");
  } else {
    logInfo("Creating new pre-push hook...");
  }

  await fs.writeFile(hookPath, buildPrePushHook(projectDir));
  await fs.chmod(hookPath, 0o755);
  logSuccess("Pre-push hook created — calls scripts/run-ci-checks.sh.");
};

exports.setupCIWorkflow = async (targetRoot) => {
  const sourceDir = path.resolve(__dirname, '../templates/github-template');
  const targetDir = path.join(targetRoot || process.cwd(), '.github');

  if (!await fs.pathExists(sourceDir)) {
    logInfo("Templates github-template folder not found.");
    return;
  }

  // To prevent self-copying during local development
  if (path.resolve(sourceDir) === path.resolve(targetDir)) {
    logInfo("Template .github and target .github are the same — skipping copy.");
    return;
  }

  logInfo("Copying templates/github-template to project's .github folder...");
  await fs.copy(sourceDir, targetDir, { overwrite: true });
  const scriptsDir = path.join(targetDir, 'scripts');

  if (await fs.pathExists(scriptsDir)) {
    const files = await fs.readdir(scriptsDir);

    for (const file of files) {
      const fullPath = path.join(scriptsDir, file);

      try {
        await fs.chmod(fullPath, 0o755);
      } catch (err) {
        logInfo(`Could not set executable permission for ${file}: ${err.message}`);
      }
    }

    logSuccess(".github/scripts permissions fixed.");
  }

  logSuccess(".github workflows and templates merged successfully.");
};

exports.ensureProjectScripts = async () => {
  const pkgPath = path.join(process.cwd(), 'package.json');

  if (!await fs.pathExists(pkgPath)) {
    logError("No package.json found. Skipping script standardization.");
    return;
  }

  const { readJSON, writeJSON } = require('./utils');
  const pkg = await readJSON(pkgPath);
  if (!pkg.scripts) pkg.scripts = {};
  let changed = false;

  // 1. Add 'test:smoke' and 'test:newman' if they don't exist
  // NOTE: We never modify the user's existing "test" or "start" scripts.
  if (!pkg.scripts['test:smoke']) {
    const isVite = pkg.dependencies?.vite || pkg.devDependencies?.vite || pkg.devDependencies?.vitest;
    const hasJest = pkg.devDependencies?.jest || pkg.dependencies?.jest;

    if (isVite) {
      // vitest will be auto-installed by installAllRequiredDependencies if missing
      pkg.scripts['test:smoke'] = 'npx vitest run --coverage';
    } else if (hasJest) {
      pkg.scripts['test:smoke'] = 'npx jest --coverage --coverageReporters=lcov text';
    } else {
      pkg.scripts['test:smoke'] = pkg.scripts.test || 'node --test';
    }

    logInfo(`Creating "test:smoke" script -> ${pkg.scripts['test:smoke']}`);
    changed = true;
  }
  if (!pkg.scripts['test:newman']) {
    // Default to the new cloud runner if it exists, otherwise use basic newman
    if (fs.existsSync(path.join(process.cwd(), 'tests', 'run-newman-cloud.mjs'))) {
      pkg.scripts['test:newman'] = 'node tests/run-newman-cloud.mjs';
    } else {
      pkg.scripts['test:newman'] = 'newman run *.postman_collection.json --reporters cli,htmlextra --reporter-htmlextra-export newman-report.html --bail';

    }
    logInfo(`Creating "test:newman" script -> ${pkg.scripts['test:newman']}`);
    changed = true;
  }

  // 2. Ensure 'test:all' script
  if (!pkg.scripts['test:all']) {
    pkg.scripts['test:all'] = 'npm run test:smoke && npm run test:newman';
    logInfo('Creating "test:all" script.');
    changed = true;
  }

  if (changed) {
    await writeJSON(pkgPath, pkg);
    logSuccess("package.json scripts standardized.");
  }
};

exports.ensurePackageLock = async () => {
  const lockPath = path.join(process.cwd(), 'package-lock.json');
  const yarnPath = path.join(process.cwd(), 'yarn.lock');

  if (await fs.pathExists(lockPath) || await fs.pathExists(yarnPath)) {
    logSuccess("Lock file found (package-lock.json / yarn.lock).");
    return;
  }

  logInfo("No package-lock.json found — running npm install to generate it...");
  try {
    execSync('npm install', { stdio: 'inherit', cwd: process.cwd() });
    logSuccess("package-lock.json generated. Remember to commit it.");
  } catch {
    logError("Failed to generate package-lock.json. Run npm install manually.");
  }
};

function buildPrePushHook(projectDir) {
  const cdLine = projectDir !== '.' ? `cd "${projectDir}"` : '';

  // Read the CI script template at build time and embed it in the hook
  let ciScriptContent = '';
  try {
    ciScriptContent = fs.readFileSync(CI_SCRIPT_TEMPLATE, 'utf8');
  } catch {
    logError('CI script template not found — pre-push will skip checks if script is missing.');
  }

  // Escape any single quotes in the template for the heredoc
  const escapedCiScript = ciScriptContent.replace(/'/g, "'\\''");

  return `#!/bin/sh

# ---------------------------------------------------------------
# Git stdin — <local ref> <local sha1> <remote ref> <remote sha1>
# ---------------------------------------------------------------
read local_ref local_sha remote_ref remote_sha

# If local_sha is all zeros, it's a deletion push — skip CI checks
if [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then
  echo "[Pre-push] Deletion detected ($remote_ref). Skipping CI checks."
  exit 0
fi

# ---------------------------------------------------------------
# Development mode check - skip all checks if DEV_MODE is set
# ---------------------------------------------------------------
if [ "$DEV_MODE" = "true" ] || [ "$SKIP_HOOKS" = "true" ]; then
  echo "[DEV MODE] Skipping all pre-push checks."
  exit 0
fi

${cdLine ? cdLine + '\n' : ''}

# ---------------------------------------------------------------
# Self-contained CI script restoration
# If scripts/run-ci-checks.sh is missing, create it inline
# (no external binary needed)
# ---------------------------------------------------------------
if [ ! -f "./scripts/run-ci-checks.sh" ]; then
  echo "⚠️  [Pre-push] CI script missing. Auto-creating from embedded template..."
  mkdir -p ./scripts
  cat > ./scripts/run-ci-checks.sh << 'CISCRIPT_EOF'
${ciScriptContent}
CISCRIPT_EOF
  chmod +x ./scripts/run-ci-checks.sh
  if [ -f "./scripts/run-ci-checks.sh" ]; then
    echo "✅ [Pre-push] CI script restored successfully."
  else
    echo "❌ [Pre-push] Failed to create CI script. Skipping checks."
    exit 0
  fi
fi

./scripts/run-ci-checks.sh
`;
}
