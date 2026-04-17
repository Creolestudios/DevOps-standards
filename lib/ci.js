'use strict';

const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const { logInfo, logSuccess, logError } = require('./logger');
const { detectPackageManager } = require('./packageManager');

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
  // Ensure LF line endings — CRLF causes "syntax error near unexpected token" on Linux/Ubuntu
  const scriptContent = await fs.readFile(scriptPath, 'utf8');
  await fs.writeFile(scriptPath, scriptContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
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

  await fs.writeFile(hookPath, buildPrePushHook(projectDir).replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
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
    const { runCmd } = detectPackageManager();
    pkg.scripts['test:all'] = `${runCmd} test:smoke && ${runCmd} test:newman`;
    logInfo('Creating "test:all" script.');
    changed = true;
  }

  if (changed) {
    await writeJSON(pkgPath, pkg);
    logSuccess("package.json scripts standardized.");
  }
};

exports.ensurePackageLock = async () => {
  const { pm, installCmd, lockFile } = detectPackageManager();

  if (lockFile) {
    logSuccess(`Lock file found (${lockFile}) — using ${pm}.`);
    return;
  }

  logInfo(`No lock file found — running ${installCmd} to generate one...`);
  try {
    execSync(installCmd, { stdio: 'inherit', cwd: process.cwd() });
    logSuccess(`Lock file generated by ${pm}. Remember to commit it.`);
  } catch {
    logError(`Failed to generate lock file. Run '${installCmd}' manually.`);
  }
};

function buildPrePushHook(projectDir) {
  // Read and embed the CI script content at hook-generation time
  // Strip CRLF to ensure it works on Linux/Ubuntu
  let ciScriptContent = '';
  try {
    ciScriptContent = fs.readFileSync(CI_SCRIPT_TEMPLATE, 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
  } catch {
    logError('CI script template not found — pre-push self-restore will be unavailable.');
  }

  // Escape the content for safe embedding in a Node.js string inside a shell script
  // We write it via node -e to avoid ALL heredoc/special-char issues
  const ciScriptEscaped = ciScriptContent
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/"/g, '\\"');

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
# Development mode check
# ---------------------------------------------------------------
if [ "$DEV_MODE" = "true" ] || [ "$SKIP_HOOKS" = "true" ]; then
  echo "[DEV MODE] Skipping all pre-push checks."
  exit 0
fi

# ---------------------------------------------------------------
# Resolve project root
# ---------------------------------------------------------------
HOOK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ROOT="$HOOK_DIR${projectDir !== '.' ? `/${projectDir}` : ''}"

if [ ! -d "$PROJECT_ROOT" ]; then
  echo "[Pre-push] Project directory not found: $PROJECT_ROOT — skipping checks."
  exit 0
fi

cd "$PROJECT_ROOT" || exit 1
echo "[Pre-push] Working directory: $(pwd)"

# ---------------------------------------------------------------
# Detect Package Manager
# ---------------------------------------------------------------
if [ -f "pnpm-lock.yaml" ] || [ -f "../pnpm-lock.yaml" ]; then
  PKG_MANAGER="pnpm"; PKG_RUN="pnpm run"
elif [ -f "yarn.lock" ] || [ -f "../yarn.lock" ]; then
  PKG_MANAGER="yarn"; PKG_RUN="yarn"
elif [ -f "bun.lockb" ] || [ -f "../bun.lockb" ]; then
  PKG_MANAGER="bun"; PKG_RUN="bun run"
else
  PKG_MANAGER="npm"; PKG_RUN="npm run"
fi
echo "[Pre-push] Detected package manager: $PKG_MANAGER"

# ---------------------------------------------------------------
# Ensure CI script exists — restore from embedded content if missing
# Uses node to write the file (avoids heredoc special-char issues)
# ---------------------------------------------------------------
CI_SCRIPT="./scripts/run-ci-checks.sh"

if [ ! -f "$CI_SCRIPT" ]; then
  echo "[Pre-push] CI script missing — restoring from embedded template..."
  mkdir -p ./scripts
  node -e "
    const content = \\"${ciScriptEscaped}\\";
    require('fs').writeFileSync('./scripts/run-ci-checks.sh', content, 'utf8');
  " 2>/dev/null
  chmod +x "$CI_SCRIPT" 2>/dev/null || true
  if [ -f "$CI_SCRIPT" ]; then
    echo "✅ [Pre-push] CI script restored."
  else
    echo "❌ [Pre-push] Could not restore CI script. Run: npx cs-setup check-hooks"
    exit 0
  fi
fi

chmod +x "$CI_SCRIPT" 2>/dev/null || true

# ---------------------------------------------------------------
# Run CI checks � always runs on every push
# ---------------------------------------------------------------
echo "[Pre-push] Running CI checks..."
sh "$CI_SCRIPT"
CI_EXIT=$?
if [ $CI_EXIT -ne 0 ]; then
  echo "? [Pre-push] CI checks failed. Push blocked."
  exit 1
fi
echo "? [Pre-push] All CI checks passed."
exit 0
`;
}
