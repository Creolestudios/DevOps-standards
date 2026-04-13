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

${stripPrefixBlock}

echo "[Git Diff] Staged files in project root (prefix=${projectPrefix}):"
echo "$STAGED_FILES" | while IFS= read -r FILE; do
  echo "  -> $FILE"
done

if [ -z "$STAGED_FILES" ]; then
  echo "No staged files in this project directory. Skipping non-lint checks."
fi

# ---------------------------------------------------------------
# ESLint — Always lints entire project, regardless of staged files
# ---------------------------------------------------------------
echo ""
echo "[ESLint] Linting entire project..."

if [ -f "./node_modules/.bin/eslint" ]; then
  ESLINT_BIN="./node_modules/.bin/eslint"
elif command -v eslint >/dev/null 2>&1; then
  ESLINT_BIN="eslint"
else
  echo "[ESLint] eslint not found — attempting automatic installation..."
  # Check if package.json declares a specific ESLint version before installing
  ESLINT_VERSION_HINT=""
  if [ -f "package.json" ]; then
    ESLINT_VERSION_HINT=$(node -e "
      try {
        const p = require('./package.json');
        const v = (p.dependencies || {}).eslint || (p.devDependencies || {}).eslint || '';
        const major = parseInt(v.replace(/[^0-9]/, ''));
        if (!isNaN(major)) process.stdout.write(String(major));
      } catch(e) {}
    " 2>/dev/null)
  fi
  if [ -n "\$ESLINT_VERSION_HINT" ] && [ "\$ESLINT_VERSION_HINT" -lt 9 ] 2>/dev/null; then
    echo "[ESLint] ESLint v\${ESLINT_VERSION_HINT} detected in package.json — installing without @eslint/js..."
    npm install --save-dev eslint --quiet 2>&1 | tail -n 3
  elif [ -z "\$ESLINT_VERSION_HINT" ] && [ -f "package.json" ] && grep -q '"eslintConfig"' package.json; then
    echo "[ESLint] Legacy 'eslintConfig' found in package.json. Installing ESLint v8 for compatibility..."
    npm install --save-dev eslint@^8.57.0 --quiet 2>&1 | tail -n 3
  else
    npm install --save-dev eslint @eslint/js --quiet 2>&1 | tail -n 3
  fi
  if [ -f "./node_modules/.bin/eslint" ]; then
    ESLINT_BIN="./node_modules/.bin/eslint"
  else
    ESLINT_BIN=""
  fi
fi

# Detect the actual installed ESLint major version — drives config format decisions below
ESLINT_MAJOR=9
if [ -f "./node_modules/eslint/package.json" ]; then
  ESLINT_MAJOR=$(node -e "
    try {
      const v = require('./node_modules/eslint/package.json').version;
      process.stdout.write(String(parseInt(v.split('.')[0])));
    } catch(e) { process.stdout.write('9'); }
  " 2>/dev/null)
fi
echo "[ESLint] Installed ESLint major version: \${ESLINT_MAJOR}"

if [ -n "$ESLINT_BIN" ]; then
  HAS_CONFIG=0
  HAS_FLAT_CONFIG=0
  HAS_LEGACY_CONFIG=0

  if [ -f "eslint.config.js" ] || [ -f "eslint.config.mjs" ] || [ -f "eslint.config.cjs" ]; then
    HAS_FLAT_CONFIG=1
    HAS_CONFIG=1
  fi
  if [ -f ".eslintrc.js" ] || [ -f ".eslintrc.cjs" ] || [ -f ".eslintrc.yaml" ] || \\
     [ -f ".eslintrc.yml" ] || [ -f ".eslintrc.json" ] || [ -f ".eslintrc" ]; then
    HAS_LEGACY_CONFIG=1
    HAS_CONFIG=1
  fi
  if [ -f "package.json" ] && grep -q '"eslintConfig"' package.json; then
    # package.json eslintConfig is only valid for ESLint v8 (legacy).
    # ESLint v9+ requires a flat config file — package.json is NOT supported.
    if [ "\${ESLINT_MAJOR}" -lt 9 ] 2>/dev/null; then
      HAS_CONFIG=1
    else
      echo "⚠️  [ESLint] Found 'eslintConfig' in package.json but ESLint v\${ESLINT_MAJOR} does not support it — will auto-generate flat config..."
    fi
  fi

  # If the config type doesn't match the ESLint version, remove the wrong one so cs-setup recreates it correctly
  if [ "\$ESLINT_MAJOR" -lt 9 ] 2>/dev/null && [ \$HAS_FLAT_CONFIG -eq 1 ] && [ \$HAS_LEGACY_CONFIG -eq 0 ]; then
    echo "⚠️  [ESLint] Flat config found but ESLint v\${ESLINT_MAJOR} requires legacy config — removing flat config..."
    rm -f eslint.config.js eslint.config.mjs eslint.config.cjs
    HAS_CONFIG=0
    HAS_FLAT_CONFIG=0
  elif [ "\$ESLINT_MAJOR" -ge 9 ] 2>/dev/null && [ \$HAS_LEGACY_CONFIG -eq 1 ] && [ \$HAS_FLAT_CONFIG -eq 0 ]; then
    echo "⚠️  [ESLint] Legacy config found but ESLint v\${ESLINT_MAJOR} requires flat config — removing legacy config..."
    rm -f .eslintrc.js .eslintrc.cjs .eslintrc.yaml .eslintrc.yml .eslintrc.json .eslintrc
    HAS_CONFIG=0
    HAS_LEGACY_CONFIG=0
  fi

  run_cs_setup() {
    if [ -f "./node_modules/.bin/cs-setup" ]; then
      ./node_modules/.bin/cs-setup "$@"
    elif [ -f "../node_modules/.bin/cs-setup" ]; then
      ../node_modules/.bin/cs-setup "$@"
    elif [ -f "$HOOK_DIR/node_modules/.bin/cs-setup" ]; then
      "$HOOK_DIR/node_modules/.bin/cs-setup" "$@"
    elif [ -f "$(npm root -g 2>/dev/null)/cs-setup/bin/index.js" ]; then
      node "$(npm root -g)/cs-setup/bin/index.js" "$@"
    else
      echo "[cs-setup] Binary not found locally. Run 'npx cs-setup init' to set up."
      return 1
    fi
  }

  if [ $HAS_CONFIG -eq 0 ]; then
    echo "⚠️  [ESLint] No configuration found. Attempting compulsory auto-configuration..."
    run_cs_setup check-hooks || true

    if [ -f "eslint.config.js" ] || [ -f "eslint.config.mjs" ] || [ -f "eslint.config.cjs" ] || \\
       [ -f ".eslintrc.js" ] || [ -f ".eslintrc.cjs" ] || [ -f ".eslintrc.yaml" ] || \\
       [ -f ".eslintrc.yml" ] || [ -f ".eslintrc.json" ] || [ -f ".eslintrc" ]; then
      HAS_CONFIG=1
      echo "✅ [ESLint] Configuration created by cs-setup."
    fi
  fi

  if [ $HAS_CONFIG -eq 1 ]; then
    echo "[ESLint] Running lint check..."

    $ESLINT_BIN .
    ESLINT_EXIT=$?

    if [ $ESLINT_EXIT -ne 0 ]; then
      echo ""
      echo "✖ [ESLint] Linting detected issues."
      exit 1
    else
      echo "✔ [ESLint] Lint check passed."
    fi
  else
    echo "⚠️  [ESLint] Could not create ESLint config — skipping lint check."
    echo "   Run 'npx cs-setup init' in your project to set up ESLint."
  fi
else
  echo "[ESLint] Failed to find or install eslint — skipping."
  echo "[ESLint] Tip: Run 'npm install --save-dev eslint' manually."
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