"use strict";

const fs = require("fs-extra");
const path = require("path");
const { logInfo, logSuccess } = require("./logger");

/**
 * setupPreCommitHook(gitRoot)
 */
exports.setupPreCommitHook = async (gitRoot) => {
  const projectRoot = process.cwd();
  const huskyDir = path.join(gitRoot || projectRoot, ".husky");
  const hookPath = path.join(huskyDir, "pre-commit");

  if (!(await fs.pathExists(huskyDir))) {
    logInfo("Husky directory not found. Skipping hook setup.");
    return;
  }

  const relativeProjectDir =
    path.relative(gitRoot || projectRoot, projectRoot) || ".";

  const hookContent = buildHookScript(relativeProjectDir);

  if (await fs.pathExists(hookPath)) {
    logInfo(
      "Pre-commit hook already configured. Overwriting with latest setup...",
    );
  } else {
    logInfo("Creating new pre-commit hook...");
  }

  await fs.writeFile(hookPath, hookContent);
  await fs.chmod(hookPath, 0o755);

  const gitleaksIgnorePath = path.join(projectRoot, ".gitleaksignore");
  await fs.writeFile(gitleaksIgnorePath, ".tools/\nsonar-project.properties\n");
  logInfo(
    ".gitleaksignore created — excluding .tools/ and sonar-project.properties.",
  );

  logSuccess(
    "Pre-commit hook created with ESLint (warn) + Gitleaks + SonarQube.",
  );
  if (relativeProjectDir !== ".") {
    logInfo(
      `Monorepo detected — hook will cd into "${relativeProjectDir}" before running checks.`,
    );
  }
};

function buildHookScript(relativeProjectDir) {
  const isWin = process.platform === "win32";
  const gitleaksBin = isWin
    ? "./.tools/gitleaks/gitleaks.exe"
    : "./.tools/gitleaks/gitleaks";

  const isMonorepo = relativeProjectDir !== ".";

  const cdBlock = isMonorepo
    ? `
# ---------------------------------------------------------------
# Monorepo setup
# ---------------------------------------------------------------
PROJECT_DIR="$HOOK_DIR/${relativeProjectDir}"

if [ ! -d "$PROJECT_DIR" ]; then
  echo "[pre-commit] Project directory not found: $PROJECT_DIR — skipping checks."
  exit 0
fi

cd "$PROJECT_DIR" || exit 1
echo "[pre-commit] Working directory: $(pwd)"
`
    : "";

  const projectPrefix = isMonorepo ? `${relativeProjectDir}/` : "";

  const stripPrefixBlock = ""; // Git diff is already relative to CWD after cd


  return `#!/bin/sh
# ---------------------------------------------------------------
# Development mode check - skip all checks if DEV_MODE is set
# ---------------------------------------------------------------
if [ "$DEV_MODE" = "true" ] || [ "$SKIP_HOOKS" = "true" ]; then
  echo "[DEV MODE] Skipping all pre-commit checks."
  exit 0
fi

# ---------------------------------------------------------------
# Base directories
# ---------------------------------------------------------------
GIT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_DIR="$GIT_ROOT"
WORKSPACE_ROOT="$HOOK_DIR"

# ---------------------------------------------------------------
# Detect Package Manager (pnpm > yarn > bun > npm)
# ---------------------------------------------------------------
if [ -f "pnpm-lock.yaml" ] || [ -f "../pnpm-lock.yaml" ]; then
  PKG_MANAGER="pnpm"
  # If running at a pnpm workspace root, pnpm requires -w for root installs.
  if [ -f "$WORKSPACE_ROOT/pnpm-workspace.yaml" ]; then
    PKG_ADD="pnpm add -D -w"
  else
    PKG_ADD="pnpm add -D"
  fi
  PKG_RUN="pnpm run"
elif [ -f "yarn.lock" ] || [ -f "../yarn.lock" ]; then
  PKG_MANAGER="yarn"
  PKG_ADD="yarn add -D"
  PKG_RUN="yarn"
elif [ -f "bun.lockb" ] || [ -f "../bun.lockb" ]; then
  PKG_MANAGER="bun"
  PKG_ADD="bun add -d"
  PKG_RUN="bun run"
else
  PKG_MANAGER="npm"
  PKG_ADD="npm install --save-dev"
  PKG_RUN="npm run"
fi
echo "[cs-setup] Detected package manager: $PKG_MANAGER"

# Prefer local pnpm binary when available (Windows Git Bash friendliness)
PNPM_BIN="pnpm"
if [ -f "$WORKSPACE_ROOT/node_modules/.bin/pnpm" ]; then
  PNPM_BIN="$WORKSPACE_ROOT/node_modules/.bin/pnpm"
fi

${cdBlock}
ALL_STAGED=$(git diff --cached --name-only --diff-filter=ACM)

if [ -z "$ALL_STAGED" ]; then
  echo "No changed files detected. Skipping checks."
  exit 0
fi
echo "[Git Diff] All staged files (git root):"
echo "$ALL_STAGED" | while IFS= read -r FILE; do
  echo "  -> $FILE"
done

# STAGED_FILES are those within the project directory, relative to it.
STAGED_FILES=$(echo "$ALL_STAGED" | grep "^${projectPrefix}" | sed "s|^${projectPrefix}||" | grep -v "^$" || true)

echo "[Git Diff] Staged files in project root (prefix=${projectPrefix}):"
echo "$STAGED_FILES" | while IFS= read -r FILE; do
  echo "  -> $FILE"
done

if [ -z "$STAGED_FILES" ]; then
  echo "No staged files in this project directory. Scanning for project-wide checks (ESLint)..."
fi

# ---------------------------------------------------------------
# Lint — Prefer the project's own lint script when available
# ---------------------------------------------------------------
echo ""
echo "[Lint] Running project lint..."

# ---------------------------------------------------------------
# Toolchain doctor (auto-fix common TS/ESLint crashes)
# - TS >= 5.6 + @typescript-eslint v7 (or older) can crash ESLint.
# - If detected, auto-upgrade @typescript-eslint/* to v8+ before lint runs.
# ---------------------------------------------------------------
echo "[Doctor] Checking TypeScript/ESLint compatibility..."

TS_MM=$(node -e "try{const v=require('./node_modules/typescript/package.json').version||'';const m=v.match(/^(\\d+)\\.(\\d+)/);if(m)process.stdout.write(m[1]+'.'+m[2]);}catch(e){}" 2>/dev/null)
TSE_MAJOR=$(node -e "try{const v=require('./node_modules/@typescript-eslint/parser/package.json').version||'';process.stdout.write(String(parseInt(v.split('.')[0],10)||0));}catch(e){process.stdout.write('0')}" 2>/dev/null)

needs_tse_upgrade() {
  # returns 0 (true) if upgrade needed
  node -e "
    const mm = process.argv[1] || '';
    const tse = parseInt(process.argv[2] || '0', 10) || 0;
    const m = mm.match(/^(\\d+)\\.(\\d+)/);
    if (!m) process.exit(1);
    const major = parseInt(m[1],10);
    const minor = parseInt(m[2],10);
    const tsTooNew = (major > 5) || (major === 5 && minor >= 6);
    if (tsTooNew && tse > 0 && tse < 8) process.exit(0);
    if (tsTooNew && tse === 0) process.exit(0);
    process.exit(1);
  " "$TS_MM" "$TSE_MAJOR" >/dev/null 2>&1
}

if needs_tse_upgrade; then
  echo "[Doctor] TypeScript ${TS_MM:-unknown} detected with @typescript-eslint major ${TSE_MAJOR:-0} — upgrading @typescript-eslint to v8+..."
  # Best-effort installs; don't hard-fail the hook on install issues.
  $PKG_ADD @typescript-eslint/parser@^8.0.0 @typescript-eslint/eslint-plugin@^8.0.0 typescript >/dev/null 2>&1 || true
  echo "[Doctor] @typescript-eslint upgrade attempted."
else
  echo "[Doctor] OK."
fi

LINT_RAN=0
LINT_FAILED=0

HAS_LINT_SCRIPT=0
if [ -f "package.json" ]; then
  HAS_LINT_SCRIPT=$(node -e "try{const p=require('./package.json');console.log(p.scripts&&p.scripts.lint?'1':'0')}catch(e){console.log('0')}" 2>/dev/null)
fi

if [ "$HAS_LINT_SCRIPT" = "1" ]; then
  echo "[Lint] Detected package.json script: lint"
  LINT_RAN=1

  # Monorepo/workspace behavior:
  # If this is a pnpm workspace, run lint for each workspace package serially.
  # This avoids turbo "scope" surprises and makes it explicit what was checked.
  IS_PNPM_WORKSPACE_ROOT=0
  if [ "$PKG_MANAGER" = "pnpm" ] && [ -f "$WORKSPACE_ROOT/pnpm-workspace.yaml" ]; then
    IS_PNPM_WORKSPACE_ROOT=1
  fi

  if [ "$IS_PNPM_WORKSPACE_ROOT" = "1" ]; then
    echo "[Lint] pnpm workspace detected — running lint for all packages (serial)..."
    # --no-bail: run lint for all packages even if one fails
    "$PNPM_BIN" -C "$WORKSPACE_ROOT" -r --workspace-concurrency=1 --no-bail --if-present --stream --reporter=append-only run lint
    LINT_EXIT=$?

    echo ""
    echo "[Lint] Workspace-wide ESLint scan (root)..."
    # If a workspace has lint scripts, they may only lint a subset (e.g. apps/web).
    # Also run a root ESLint scan when a config exists to cover the whole repo.
    HAS_ROOT_ESLINT_CONFIG=0
    if [ -f "$WORKSPACE_ROOT/eslint.config.js" ] || [ -f "$WORKSPACE_ROOT/eslint.config.mjs" ] || [ -f "$WORKSPACE_ROOT/eslint.config.cjs" ] || \
       [ -f "$WORKSPACE_ROOT/.eslintrc.js" ] || [ -f "$WORKSPACE_ROOT/.eslintrc.cjs" ] || [ -f "$WORKSPACE_ROOT/.eslintrc.yaml" ] || \
       [ -f "$WORKSPACE_ROOT/.eslintrc.yml" ] || [ -f "$WORKSPACE_ROOT/.eslintrc.json" ] || [ -f "$WORKSPACE_ROOT/.eslintrc" ]; then
      HAS_ROOT_ESLINT_CONFIG=1
    fi

    ROOT_ESLINT_BIN=""
    if [ -f "$WORKSPACE_ROOT/node_modules/.bin/eslint" ]; then
      ROOT_ESLINT_BIN="$WORKSPACE_ROOT/node_modules/.bin/eslint"
    elif command -v eslint >/dev/null 2>&1; then
      ROOT_ESLINT_BIN="eslint"
    fi

    ROOT_ESLINT_EXIT=0
    if [ "$HAS_ROOT_ESLINT_CONFIG" = "1" ] && [ -n "$ROOT_ESLINT_BIN" ]; then
      (cd "$WORKSPACE_ROOT" && "$ROOT_ESLINT_BIN" .)
      ROOT_ESLINT_EXIT=$?
      if [ $ROOT_ESLINT_EXIT -ne 0 ]; then
        echo "✖ [Lint] Root ESLint scan failed."
      else
        echo "✔ [Lint] Root ESLint scan passed."
      fi
    else
      echo "⚠️  [Lint] No root ESLint config/binary found — skipping workspace-wide ESLint scan."
    fi

    # Merge results
    if [ $LINT_EXIT -ne 0 ] || [ $ROOT_ESLINT_EXIT -ne 0 ]; then
      LINT_EXIT=1
    else
      LINT_EXIT=0
    fi
  else
    $PKG_RUN lint
    LINT_EXIT=$?
  fi

  if [ $LINT_EXIT -ne 0 ]; then
    echo "✖ [Lint] Lint failed. Commit blocked."
    LINT_FAILED=1
    exit 1
  fi
  echo "✔ [Lint] Lint passed."
else
  # No lint script. Try framework-aware defaults before falling back to eslint.
  HAS_NEXT=0
  HAS_TURBO=0
  if [ -f "package.json" ]; then
    HAS_NEXT=$(node -e "try{const p=require('./package.json');console.log((p.dependencies&&p.dependencies.next)||(p.devDependencies&&p.devDependencies.next)?'1':'0')}catch(e){console.log('0')}" 2>/dev/null)
    HAS_TURBO=$(node -e "try{const p=require('./package.json');console.log((p.dependencies&&p.dependencies.turbo)||(p.devDependencies&&p.devDependencies.turbo)?'1':'0')}catch(e){console.log('0')}" 2>/dev/null)
  fi

  # If we're in a pnpm workspace root but there's no root lint script, still try lint in packages.
  if [ "$PKG_MANAGER" = "pnpm" ] && [ -f "$WORKSPACE_ROOT/pnpm-workspace.yaml" ]; then
    echo "[Lint] pnpm workspace detected (no root lint script) — running lint for all packages (serial)..."
    "$PNPM_BIN" -C "$WORKSPACE_ROOT" -r --workspace-concurrency=1 --no-bail --if-present --stream --reporter=append-only run lint
    LINT_EXIT=$?
    if [ $LINT_EXIT -ne 0 ]; then
      echo "✖ [Lint] Workspace lint failed. Commit blocked."
      exit 1
    fi
    echo "✔ [Lint] Workspace lint passed."
    LINT_RAN=1
  fi

  if [ "$HAS_NEXT" = "1" ]; then
    echo "[Lint] Next.js detected — running: next lint"
    if [ -f "./node_modules/.bin/next" ]; then
      ./node_modules/.bin/next lint
    else
      npx --no-install next lint
    fi
    LINT_EXIT=$?
    if [ $LINT_EXIT -ne 0 ]; then
      echo "✖ [Lint] next lint failed. Commit blocked."
      exit 1
    fi
    echo "✔ [Lint] next lint passed."
    LINT_RAN=1
  elif [ "$HAS_TURBO" = "1" ] || [ -f "turbo.json" ]; then
    echo "[Lint] Turbo repo detected — running: turbo lint"
    if [ -f "./node_modules/.bin/turbo" ]; then
      ./node_modules/.bin/turbo lint
    else
      npx --no-install turbo lint
    fi
    LINT_EXIT=$?
    if [ $LINT_EXIT -ne 0 ]; then
      echo "✖ [Lint] turbo lint failed. Commit blocked."
      exit 1
    fi
    echo "✔ [Lint] turbo lint passed."
    LINT_RAN=1
  fi
fi

# ESLint fallback:
# Only run an eslint-based fallback if NO lint strategy ran above.
if [ "$LINT_RAN" = "0" ]; then
  if [ -f "./node_modules/.bin/eslint" ]; then
    ESLINT_BIN="./node_modules/.bin/eslint"
  elif command -v eslint >/dev/null 2>&1; then
    ESLINT_BIN="eslint"
  else
    ESLINT_BIN=""
  fi

  if [ -n "$ESLINT_BIN" ]; then
    echo "[ESLint] Running fallback lint: eslint ."
    $ESLINT_BIN .
    ESLINT_EXIT=$?
    if [ $ESLINT_EXIT -ne 0 ]; then
      echo "✖ [ESLint] Linting detected issues."
      exit 1
    else
      echo "✔ [ESLint] Lint check passed."
    fi
  else
    echo "⚠️  [ESLint] eslint not found — skipping fallback lint."
  fi
fi
# ---------------------------------------------------------------
# Gitleaks — Auto-installs if missing, blocks commit if secrets found
# ---------------------------------------------------------------
echo ""
echo "[Gitleaks] Scanning staged files for secrets..."

GITLEAKS_BIN="${gitleaksBin}"

if [ ! -f "$GITLEAKS_BIN" ]; then
  echo "[Gitleaks] Binary not found — attempting automatic installation..."
  run_cs_setup install gitleaks
fi

if [ ! -f "$GITLEAKS_BIN" ]; then
  echo "[Gitleaks] Automatic installation failed — skipping."
else
  GITLEAKS_TMPDIR=$(mktemp -d)

  echo "$STAGED_FILES" | while IFS= read -r FILE; do
    case "$FILE" in
      sonar-project.properties) ;;
      .tools/*) ;;
      *)
        if [ -f "$FILE" ]; then
          DEST="$GITLEAKS_TMPDIR/$FILE"
          mkdir -p "$(dirname "$DEST")"
          cp "$FILE" "$DEST"
        fi
        ;;
    esac
  done

  $GITLEAKS_BIN detect --source "$GITLEAKS_TMPDIR" --no-git --verbose
  GITLEAKS_EXIT=$?
  rm -rf "$GITLEAKS_TMPDIR"

  if [ $GITLEAKS_EXIT -ne 0 ]; then
    echo "[Gitleaks] Secrets detected! Commit blocked."
    exit 1
  fi

  echo "[Gitleaks] No secrets found. ✔"
fi

# ---------------------------------------------------------------
# Coverage — Generate BEFORE SonarQube so it can read the report
# ---------------------------------------------------------------
echo ""
echo "[Coverage] Generating coverage report..."

if [ -f "./node_modules/.bin/jest" ]; then
  ./node_modules/.bin/jest --coverage --coverageReporters=lcov text --passWithNoTests 2>/dev/null || true
  echo "[Coverage] Jest coverage report generated ✔"
elif [ -f "./node_modules/.bin/vitest" ]; then
  ./node_modules/.bin/vitest run --coverage 2>/dev/null || true
  echo "[Coverage] Vitest coverage report generated ✔"
else
  echo "[Coverage] No test runner found — skipping coverage generation."
fi

# ---------------------------------------------------------------
# SonarQube — Simplified Robust Scanner
# ---------------------------------------------------------------
echo ""
echo "[SonarQube] Scanning project..."

if [ ! -f "sonar-project.properties" ]; then
  echo "[SonarQube] sonar-project.properties not found — skipping."
else
  if grep -q "^sonar.login=REPLACE_WITH_YOUR_TOKEN" sonar-project.properties || \\
     grep -q "^sonar.login=\\s*$" sonar-project.properties; then
    echo "[SonarQube] Token is missing — skipping scan."
  else
    if [ -f "./node_modules/.bin/sonar-scanner" ]; then
      SONAR_BIN="./node_modules/.bin/sonar-scanner"
    else
      SONAR_BIN="npx sonar-scanner"
    fi

    $SONAR_BIN -Dsonar.qualitygate.wait=true
    SONAR_EXIT=$?

    if [ $SONAR_EXIT -ne 0 ]; then
      echo ""
      echo "✖ [SonarQube] Quality Gate FAILED. Commit blocked."
      exit 1
    fi

    echo "✅ [SonarQube] Quality Gate Passed. ✔"
  fi
fi

exit 0
`;
}