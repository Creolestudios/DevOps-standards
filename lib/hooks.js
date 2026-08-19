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

# Detect package manager
PKG_MANAGER="npm"
DLX_CMD="npx"
if [ -f "pnpm-lock.yaml" ] || [ -f "../pnpm-lock.yaml" ]; then PKG_MANAGER="pnpm"; DLX_CMD="pnpm dlx";
elif [ -f "yarn.lock" ] || [ -f "../yarn.lock" ]; then PKG_MANAGER="yarn"; DLX_CMD="yarn dlx";
elif [ -f "bun.lockb" ] || [ -f "../bun.lockb" ]; then PKG_MANAGER="bun"; DLX_CMD="bunx"; fi

${cdBlock}
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)

if [ -z "$STAGED_FILES" ]; then
  echo "No changed files detected. Skipping checks."
  exit 0
fi
echo "[Git Diff] All staged files (git root):"
echo "$STAGED_FILES" | while IFS= read -r FILE; do
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
printf "\n\\033[1;36m=====================================================================\\033[0m\n"
printf "\\033[1;36m STAGE 1/4: ESLint (Code Quality Check)\\033[0m\n"
printf "\\033[1;36m=====================================================================\\033[0m\n"
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

    INSTALL_CMD="$PKG_MANAGER install --save-dev"
    if [ "$PKG_MANAGER" = "pnpm" ] || [ "$PKG_MANAGER" = "yarn" ] || [ "$PKG_MANAGER" = "bun" ]; then
      INSTALL_CMD="$PKG_MANAGER add -D"
    fi

    if [ -n "$ESLINT_VERSION_HINT" ] && [ "$ESLINT_VERSION_HINT" -lt 9 ] 2>/dev/null; then
      echo "[ESLint] ESLint v\${ESLINT_VERSION_HINT} detected in package.json — installing without @eslint/js..."
      $INSTALL_CMD eslint --quiet 2>&1 | tail -n 3
    elif [ -z "$ESLINT_VERSION_HINT" ] && [ -f "package.json" ] && grep -q '"eslintConfig"' package.json; then
      echo "[ESLint] Legacy 'eslintConfig' found in package.json. Installing ESLint v8 for compatibility..."
      $INSTALL_CMD eslint@^8.57.0 --quiet 2>&1 | tail -n 3
    else
      $INSTALL_CMD eslint @eslint/js --quiet 2>&1 | tail -n 3
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
      echo "️  [ESLint] Found 'eslintConfig' in package.json but ESLint v\${ESLINT_MAJOR} does not support it — will auto-generate flat config..."
    fi
  fi

  # If the config type doesn't match the ESLint version, remove the wrong one so cs-devtest recreates it correctly
  if [ "\$ESLINT_MAJOR" -lt 9 ] 2>/dev/null && [ \$HAS_FLAT_CONFIG -eq 1 ] && [ \$HAS_LEGACY_CONFIG -eq 0 ]; then
    echo "️  [ESLint] Flat config found but ESLint v\${ESLINT_MAJOR} requires legacy config — removing flat config..."
    rm -f eslint.config.js eslint.config.mjs eslint.config.cjs
    HAS_CONFIG=0
    HAS_FLAT_CONFIG=0
  elif [ "\$ESLINT_MAJOR" -ge 9 ] 2>/dev/null && [ \$HAS_LEGACY_CONFIG -eq 1 ] && [ \$HAS_FLAT_CONFIG -eq 0 ]; then
    echo "️  [ESLint] Legacy config found but ESLint v\${ESLINT_MAJOR} requires flat config — removing legacy config..."
    rm -f .eslintrc.js .eslintrc.cjs .eslintrc.yaml .eslintrc.yml .eslintrc.json .eslintrc
    HAS_CONFIG=0
    HAS_LEGACY_CONFIG=0
  fi

  run_cs_setup() {
    if [ -f "./node_modules/.bin/cs-devtest" ]; then
      ./node_modules/.bin/cs-devtest "$@"
    elif [ -f "../node_modules/.bin/cs-devtest" ]; then
      ../node_modules/.bin/cs-devtest "$@"
    elif [ -f "$HOOK_DIR/node_modules/.bin/cs-devtest" ]; then
      "$HOOK_DIR/node_modules/.bin/cs-devtest" "$@"
    elif command -v cs-devtest >/dev/null 2>&1; then
      cs-devtest "$@"
    else
      echo "[cs-devtest] Binary not found locally. Run '$DLX_CMD cs-devtest init' to set up."
      return 1
    fi
  }

  if [ $HAS_CONFIG -eq 0 ]; then
    echo "️  [ESLint] No configuration found. Attempting compulsory auto-configuration..."
    run_cs_setup check-hooks || true

    if [ -f "eslint.config.js" ] || [ -f "eslint.config.mjs" ] || [ -f "eslint.config.cjs" ] || \\
       [ -f ".eslintrc.js" ] || [ -f ".eslintrc.cjs" ] || [ -f ".eslintrc.yaml" ] || \\
       [ -f ".eslintrc.yml" ] || [ -f ".eslintrc.json" ] || [ -f ".eslintrc" ]; then
      HAS_CONFIG=1
      echo "✔ [ESLint] Configuration created by cs-devtest."
    fi
  fi

  if [ $HAS_CONFIG -eq 1 ]; then
    echo "[ESLint] Running lint check..."

    ESLINT_EXIT=0
    $ESLINT_BIN . || ESLINT_EXIT=$?

    if [ $ESLINT_EXIT -ne 0 ]; then
      echo ""
      printf "\\033[1;31m✖ [ESLint] Linting detected issues.\\033[0m\n"
      printf "\\033[1;33mTIP: To automatically fix these issues, run:\\033[0m\n"
      printf "\\033[1;33m  $DLX_CMD eslint --fix .\\033[0m\n"
      exit 1
    else
      printf "\\033[1;32m✔ [ESLint] Lint check passed.\\033[0m\n"
    fi
  else
    echo "️  [ESLint] Could not create ESLint config — skipping lint check."
    echo "   Run '$DLX_CMD cs-devtest init' in your project to set up ESLint."
  fi
else
  echo "[ESLint] Failed to find or install eslint — skipping."
  echo "[ESLint] Tip: Run '\$INSTALL_CMD eslint' manually."
fi
# ---------------------------------------------------------------
# Gitleaks — Auto-installs if missing, blocks commit if secrets found
# ---------------------------------------------------------------
printf "\n\\033[1;36m=====================================================================\\033[0m\n"
printf "\\033[1;36m STAGE 2/4: Gitleaks (Security & Secrets Scan)\\033[0m\n"
printf "\\033[1;36m=====================================================================\\033[0m\n"
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

  GITLEAKS_EXIT=0
  $GITLEAKS_BIN detect --source "$GITLEAKS_TMPDIR" --no-git --verbose || GITLEAKS_EXIT=$?
  rm -rf "$GITLEAKS_TMPDIR"

  if [ $GITLEAKS_EXIT -ne 0 ]; then
    printf "\\033[1;31m✖ [Gitleaks] Secrets detected! Commit blocked.\\033[0m\n"
    exit 1
  fi

  printf "\\033[1;32m✔ [Gitleaks] No secrets found.\\033[0m\n"
fi

# ---------------------------------------------------------------
# Coverage — Generate BEFORE SonarQube so it can read the report
# Skip ONLY if every staged file is a pure doc/asset (md, images, fonts, etc.)
# ---------------------------------------------------------------
printf "\n\\033[1;36m=====================================================================\\033[0m\n"
printf "\\033[1;36m STAGE 3/4: Code Coverage (Jest/Vitest)\\033[0m\n"
printf "\\033[1;36m=====================================================================\\033[0m\n"
echo "[Coverage] Checking staged files..."

HAS_SOURCE_CHANGES=$(echo "$STAGED_FILES" | grep -vE '\.(md|txt|png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|eot|otf|pdf|lock)$' | grep -c . 2>/dev/null || echo 0)

if [ "$HAS_SOURCE_CHANGES" -eq 0 ]; then
  echo "[Coverage] Only docs/assets changed — skipping coverage."
else
  echo "[Coverage] Source files changed — generating coverage report..."

  if [ -f "./node_modules/.bin/jest" ]; then
    ./node_modules/.bin/jest --coverage --coverageReporters=lcov text --passWithNoTests 2>/dev/null || true
    printf "\\033[1;32m✔ [Coverage] Jest coverage report generated\\033[0m\n"
  elif [ -f "./node_modules/.bin/vitest" ]; then
    ./node_modules/.bin/vitest run --coverage 2>/dev/null || true
    printf "\\033[1;32m✔ [Coverage] Vitest coverage report generated\\033[0m\n"
  else
    echo "[Coverage] No test runner found — skipping coverage generation."
  fi
fi

# ---------------------------------------------------------------
# SonarQube — Simplified Robust Scanner
# ---------------------------------------------------------------
printf "\n\\033[1;36m=====================================================================\\033[0m\n"
printf "\\033[1;36m STAGE 4/4: SonarQube (Quality Gate)\\033[0m\n"
printf "\\033[1;36m=====================================================================\\033[0m\n"
echo "[SonarQube] Scanning project..."

if [ ! -f "sonar-project.properties" ]; then
  echo "[SonarQube] sonar-project.properties not found — skipping."
else
  if grep -q "^sonar.login=REPLACE_WITH_YOUR_TOKEN" sonar-project.properties || \
     grep -q "^sonar.login=\s*$" sonar-project.properties; then
    echo "[SonarQube] Token is missing — skipping scan."
  else
    if [ -f "./node_modules/.bin/sonar-scanner" ]; then
      SONAR_BIN="./node_modules/.bin/sonar-scanner"
    else
      if [ "$PKG_MANAGER" = "pnpm" ]; then
        SONAR_BIN="pnpm --package=sonarqube-scanner dlx sonar-scanner"
      elif [ "$PKG_MANAGER" = "yarn" ]; then
        SONAR_BIN="yarn dlx -p sonarqube-scanner sonar-scanner"
      else
        SONAR_BIN="npx -y sonarqube-scanner"
      fi
    fi

    # Read host and project key from sonar-project.properties
    SONAR_DASHBOARD_HOST=$(grep "^sonar.host.url" sonar-project.properties | cut -d'=' -f2 | tr -d '[:space:]')
    SONAR_DASHBOARD_KEY=$(grep "^sonar.projectKey" sonar-project.properties | cut -d'=' -f2 | tr -d '[:space:]')

    SONAR_EXIT=0
    $SONAR_BIN -Dsonar.qualitygate.wait=true || SONAR_EXIT=$?

    if [ $SONAR_EXIT -ne 0 ]; then
      echo ""
      printf "\\033[1;31m✖ [SonarQube] Quality Gate FAILED. Commit blocked.\\033[0m\n"
      echo ""
      printf "\\033[1;33mView issues on SonarQube dashboard:\\033[0m\n"
      printf "\\033[1;33m   URL:      \${SONAR_DASHBOARD_HOST}/dashboard?id=\${SONAR_DASHBOARD_KEY}\\033[0m\n"
      printf "\\033[1;33m   Username: $(git config user.email 2>/dev/null || echo 'your-git-email')\\033[0m\n"
      printf "\\033[1;33m   Password: Creole@123456\\033[0m\n"
      echo ""
      exit 1
    fi

    printf "\\033[1;32m [SonarQube] Quality Gate Passed.\\033[0m\n"
    echo ""
    echo "View results on SonarQube dashboard:"
    echo "   URL:      \${SONAR_DASHBOARD_HOST}/dashboard?id=\${SONAR_DASHBOARD_KEY}"
    echo "   Username: $(git config user.email 2>/dev/null || echo 'your-git-email')"
    echo "   Password: Creole@123456"
    echo ""
  fi
fi

exit 0
`;
}