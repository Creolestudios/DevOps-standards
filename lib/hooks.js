

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

  // Ensure .gitattributes enforces LF for shell scripts — prevents CRLF issues on Linux/Ubuntu
  const gitattributesPath = path.join(gitRoot || projectRoot, ".gitattributes");
  const gitattributesEntry = [
    "# Ensure shell scripts always use LF (prevents bash syntax errors on Linux)",
    "*.sh text eol=lf",
    ".husky/pre-commit text eol=lf",
    ".husky/pre-push text eol=lf",
  ].join("\n");

  if (await fs.pathExists(gitattributesPath)) {
    const existing = await fs.readFile(gitattributesPath, "utf8");
    if (!existing.includes("*.sh text eol=lf")) {
      await fs.appendFile(gitattributesPath, "\n" + gitattributesEntry + "\n");
      logInfo(".gitattributes updated — enforcing LF for shell scripts.");
    }
  } else {
    await fs.writeFile(gitattributesPath, gitattributesEntry + "\n");
    logInfo(".gitattributes created — enforcing LF for shell scripts.");
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

  await fs.writeFile(hookPath, hookContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
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
ESLINT_MAJOR=$(node -e "try{const v=require('./node_modules/eslint/package.json').version||'';process.stdout.write(String(parseInt(v.split('.')[0],10)||0));}catch(e){process.stdout.write('0')}" 2>/dev/null)
NODE_MAJOR=$(node -e "try{process.stdout.write(String(parseInt(process.versions.node.split('.')[0],10)||0));}catch(e){process.stdout.write('0')}" 2>/dev/null)

needs_tse_upgrade() {
  # returns 0 (true) if upgrade needed
  # Upgrade needed if:
  # 1. ESLint v9 is installed and @typescript-eslint < v8 (context.getScope removed in v9)
  # 2. TypeScript >= 5.6 and @typescript-eslint < v8
  node -e "
    const eslint = parseInt(process.argv[1] || '0', 10) || 0;
    const mm = process.argv[2] || '';
    const tse = parseInt(process.argv[3] || '0', 10) || 0;
    if (tse === 0) process.exit(1); // not installed, nothing to upgrade
    // Rule 1: ESLint v9+ requires @typescript-eslint v8+
    if (eslint >= 9 && tse < 8) process.exit(0);
    // Rule 2: TypeScript >= 5.6 requires @typescript-eslint v8+
    const m = mm.match(/^(\\d+)\\.(\\d+)/);
    if (m) {
      const major = parseInt(m[1],10);
      const minor = parseInt(m[2],10);
      const tsTooNew = (major > 5) || (major === 5 && minor >= 6);
      if (tsTooNew && tse < 8) process.exit(0);
    }
    process.exit(1);
  " "$ESLINT_MAJOR" "$TS_MM" "$TSE_MAJOR" >/dev/null 2>&1
}

if needs_tse_upgrade; then
  echo "[Doctor] Upgrading @typescript-eslint to v8+ (ESLint v$ESLINT_MAJOR / TypeScript \${TS_MM:-unknown} / current @typescript-eslint v\${TSE_MAJOR:-0})..."
  # Best-effort installs; don't hard-fail the hook on install issues.
  $PKG_ADD @typescript-eslint/parser@^8.0.0 @typescript-eslint/eslint-plugin@^8.0.0 typescript || true
  # Re-check installed major after attempt (helps avoid running lint with known-bad toolchain)
  TSE_MAJOR_AFTER=$(node -e "try{const v=require('./node_modules/@typescript-eslint/parser/package.json').version||'';process.stdout.write(String(parseInt(v.split('.')[0],10)||0));}catch(e){process.stdout.write('0')}" 2>/dev/null)
  if [ "$TSE_MAJOR_AFTER" -lt 8 ] 2>/dev/null; then
    echo "✖ [Doctor] @typescript-eslint upgrade did not take effect (still major=$TSE_MAJOR_AFTER)."
    echo "   Run: npx cs-setup check-hooks"
    exit 1
  fi
  echo "[Doctor] @typescript-eslint upgrade applied (major=$TSE_MAJOR_AFTER)."
else
  echo "[Doctor] OK."
fi

# ESLint v8 can crash under very new Node versions. Auto-upgrade to v9 when Node >= 22.
# BUT only if no v9-incompatible plugins are installed (e.g. eslint-plugin-flowtype
# uses context.getAllComments which was removed in ESLint v9).
# ALSO: if ESLint v9 is already installed with incompatible plugins, DOWNGRADE to v8.
HAS_INCOMPATIBLE_PLUGIN=0
INCOMPATIBLE_PLUGIN_NAME=""
# Check for plugins incompatible with ESLint v9 (version-aware)
# Only flags plugins that are actually too old, not just present
INCOMPATIBLE_PLUGIN_NAME=$(node -e "
  const fs = require('fs');
  const path = require('path');
  const checks = [
    { name: 'eslint-plugin-flowtype',    min: null },
    { name: 'eslint-plugin-babel',       min: null },
    { name: 'eslint-plugin-standard',    min: null },
    { name: 'eslint-plugin-react-hooks', min: [5,0] },
    { name: 'eslint-plugin-react',       min: [7,37] },
    { name: 'eslint-plugin-import',      min: [2,31] },
    { name: 'eslint-plugin-jsx-a11y',    min: [6,10] },
  ];
  for (const { name, min } of checks) {
    const p = path.join('node_modules', name, 'package.json');
    if (!fs.existsSync(p)) continue;
    if (!min) { process.stdout.write(name); process.exit(0); }
    try {
      const v = JSON.parse(fs.readFileSync(p,'utf8')).version || '';
      const m = v.match(/^(\\d+)\\.(\\d+)/);
      if (!m) continue;
      const [,maj,mnr] = m.map(Number);
      if (maj < min[0] || (maj === min[0] && mnr < min[1])) {
        process.stdout.write(name + '@' + v);
        process.exit(0);
      }
    } catch {}
  }
" 2>/dev/null || true)
if [ -n "$INCOMPATIBLE_PLUGIN_NAME" ]; then
  HAS_INCOMPATIBLE_PLUGIN=1
fi

if [ "$HAS_INCOMPATIBLE_PLUGIN" = "1" ] && [ "$ESLINT_MAJOR" -ge 9 ] 2>/dev/null; then
  echo "⚠️  [Doctor] ESLint v$ESLINT_MAJOR detected with '$INCOMPATIBLE_PLUGIN_NAME' (incompatible with ESLint v9)."
  echo "[Doctor] Downgrading ESLint to v8 for plugin compatibility..."
  $PKG_ADD eslint@^8.57.0 || true
  ESLINT_MAJOR=$(node -e "try{const v=require('./node_modules/eslint/package.json').version||'';process.stdout.write(String(parseInt(v.split('.')[0],10)||0));}catch(e){process.stdout.write('0')}" 2>/dev/null)
  echo "[Doctor] ESLint is now v$ESLINT_MAJOR."
elif [ "$NODE_MAJOR" -ge 22 ] 2>/dev/null && [ "$ESLINT_MAJOR" -eq 8 ] 2>/dev/null && [ "$HAS_INCOMPATIBLE_PLUGIN" = "0" ]; then
  echo "[Doctor] Node $NODE_MAJOR with ESLint v$ESLINT_MAJOR detected — upgrading ESLint to v9..."
  $PKG_ADD eslint@^9.0.0 @eslint/js@^9.0.0 || true
  echo "[Doctor] ESLint upgrade attempted."
  ESLINT_MAJOR=$(node -e "try{const v=require('./node_modules/eslint/package.json').version||'';process.stdout.write(String(parseInt(v.split('.')[0],10)||0));}catch(e){process.stdout.write('0')}" 2>/dev/null)
  echo "[Doctor] ESLint is now v$ESLINT_MAJOR."
fi

LINT_RAN=0
LINT_FAILED=0

# ---------------------------------------------------------------
# ESLint config compatibility guard
# Detect BEFORE running any lint: if ESLint v9+ is installed but
# no flat config exists, set ESLINT_USE_FLAT_CONFIG=false so the
# lint command doesn't crash with "couldn't find eslint.config.*"
# This is self-healing — works even on stale hooks without check-hooks.
# ---------------------------------------------------------------
ESLINT_USE_FLAT_CONFIG_OVERRIDE=""
HAS_FLAT_CFG=0
if [ -f "eslint.config.js" ] || [ -f "eslint.config.mjs" ] || [ -f "eslint.config.cjs" ]; then
  HAS_FLAT_CFG=1
fi
if [ "$HAS_FLAT_CFG" = "0" ] && [ "$ESLINT_MAJOR" -ge 9 ] 2>/dev/null; then
  echo "[Lint] ESLint v$ESLINT_MAJOR detected with no flat config — setting ESLINT_USE_FLAT_CONFIG=false"
  export ESLINT_USE_FLAT_CONFIG=false
  ESLINT_USE_FLAT_CONFIG_OVERRIDE="true"
fi

LINT_SCRIPTS=$(node -e "try{const p=require('./package.json').scripts||{};const keys=Object.keys(p).filter(k=>k.match(/^lint[:\\w-]*$/));console.log(keys.length>0?keys.join(' && '):'');}catch(e){console.log('')} " 2>/dev/null)
if [ -n "$LINT_SCRIPTS" ]; then
  echo "[Lint] Detected lint scripts: $LINT_SCRIPTS"
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
    HAS_ROOT_FLAT_ESLINT_CONFIG=0
    HAS_ROOT_LEGACY_ESLINT_CONFIG=0
    if [ -f "$WORKSPACE_ROOT/eslint.config.js" ] || [ -f "$WORKSPACE_ROOT/eslint.config.mjs" ] || [ -f "$WORKSPACE_ROOT/eslint.config.cjs" ]; then
      HAS_ROOT_FLAT_ESLINT_CONFIG=1
    fi
    if [ -f "$WORKSPACE_ROOT/.eslintrc.js" ] || [ -f "$WORKSPACE_ROOT/.eslintrc.cjs" ] || [ -f "$WORKSPACE_ROOT/.eslintrc.yaml" ] || \
       [ -f "$WORKSPACE_ROOT/.eslintrc.yml" ] || [ -f "$WORKSPACE_ROOT/.eslintrc.json" ] || [ -f "$WORKSPACE_ROOT/.eslintrc" ]; then
      HAS_ROOT_LEGACY_ESLINT_CONFIG=1
    fi

    ROOT_ESLINT_BIN=""
    if [ -f "$WORKSPACE_ROOT/node_modules/.bin/eslint" ]; then
      ROOT_ESLINT_BIN="npx eslint"
    elif command -v eslint >/dev/null 2>&1; then
      ROOT_ESLINT_BIN="eslint"
    fi

    # Detect ESLint version and Next.js at root for compatibility guard
    ESLINT_MAJOR_ROOT=$(cd "$WORKSPACE_ROOT" && node -e "try{const v=require('./node_modules/eslint/package.json').version||'';process.stdout.write(String(parseInt(v.split('.')[0],10)||0));}catch(e){process.stdout.write('0')}" 2>/dev/null)
    HAS_NEXT_ROOT=0
    if [ -f "$WORKSPACE_ROOT/next.config.js" ] || [ -f "$WORKSPACE_ROOT/next.config.mjs" ] || [ -f "$WORKSPACE_ROOT/next.config.cjs" ] || [ -f "$WORKSPACE_ROOT/next.config.ts" ]; then
      HAS_NEXT_ROOT=1
    elif cd "$WORKSPACE_ROOT" && node -e "try{const p=require('./package.json');process.stdout.write((p.dependencies&&p.dependencies.next)||(p.devDependencies&&p.devDependencies.next)?'1':'0')}catch(e){process.stdout.write('0')}" 2>/dev/null | grep -q 1; then
      HAS_NEXT_ROOT=1
    fi

    ROOT_ESLINT_EXIT=0
    if [ -n "$ROOT_ESLINT_BIN" ] && ( [ "$HAS_ROOT_FLAT_ESLINT_CONFIG" = "1" ] || [ "$HAS_ROOT_LEGACY_ESLINT_CONFIG" = "1" ] ); then
      if [ "$HAS_NEXT_ROOT" = "1" ] && [ "$ESLINT_MAJOR_ROOT" -ge 9 ] && [ "$HAS_ROOT_LEGACY_ESLINT_CONFIG" = "1" ]; then
        echo "⚠️  [Lint] Skipping root ESLint scan: Next.js + ESLint v$ESLINT_MAJOR_ROOT legacy mode unstable (use 'next lint')"
      else
        if [ "$HAS_ROOT_FLAT_ESLINT_CONFIG" = "1" ]; then
          (cd "$WORKSPACE_ROOT" && "$ROOT_ESLINT_BIN" .)
        else
        # Skip legacy ESLint v9+ root scan (known plugin incompatibilities like @next/eslint)
        if [ "$ESLINT_MAJOR_ROOT" -ge 9 ]; then
          echo "⚠️  [Lint] Skipping ESLint v$ESLINT_MAJOR_ROOT root scan (legacy mode unstable - packages already linted)"
        else
          echo "[Lint] Root legacy ESLint config detected — setting ESLINT_USE_FLAT_CONFIG=false for root scan"
          (cd "$WORKSPACE_ROOT" && env ESLINT_USE_FLAT_CONFIG=false "$ROOT_ESLINT_BIN" .)
        fi
        fi
        ROOT_ESLINT_EXIT=$?
        if [ $ROOT_ESLINT_EXIT -ne 0 ]; then
          echo "✖ [Lint] Root ESLint scan failed."
        else
          echo "✔ [Lint] Root ESLint scan passed."
        fi
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
    # If ESLint v9 is installed but only legacy configs exist, allow legacy mode.
    LINT_ENV=""
    HAS_LEGACY_ESLINT_CFG=0
    HAS_FLAT_ESLINT_CFG=0
    if [ -f ".eslintrc" ] || [ -f ".eslintrc.js" ] || [ -f ".eslintrc.cjs" ] || [ -f ".eslintrc.json" ] || [ -f ".eslintrc.yml" ] || [ -f ".eslintrc.yaml" ]; then
      HAS_LEGACY_ESLINT_CFG=1
    fi
    if [ -f "eslint.config.js" ] || [ -f "eslint.config.mjs" ] || [ -f "eslint.config.cjs" ]; then
      HAS_FLAT_ESLINT_CFG=1
    fi
    # Also check package.json for eslintConfig key (another legacy config location)
    if [ "$HAS_LEGACY_ESLINT_CFG" = "0" ] && [ -f "package.json" ]; then
      HAS_PKG_ESLINT_CFG=$(node -e "try{const p=require('./package.json');process.stdout.write(p.eslintConfig?'1':'0')}catch(e){process.stdout.write('0')}" 2>/dev/null)
      if [ "$HAS_PKG_ESLINT_CFG" = "1" ]; then
        HAS_LEGACY_ESLINT_CFG=1
      fi
    fi
    # Set ESLINT_USE_FLAT_CONFIG=false when:
    # - A legacy config exists AND no flat config exists (covers .eslintrc.* and package.json eslintConfig)
    # - OR ESLint v9+ is installed but no flat config exists at all (safe fallback)
    if [ "$HAS_FLAT_ESLINT_CFG" = "0" ]; then
      if [ "$HAS_LEGACY_ESLINT_CFG" = "1" ]; then
        LINT_ENV="ESLINT_USE_FLAT_CONFIG=false"
      elif [ "$ESLINT_MAJOR" -ge 9 ] 2>/dev/null; then
        # ESLint v9 with no config at all — set legacy mode as safe fallback
        # (setupESLintConfig will create the right config on next check-hooks)
        LINT_ENV="ESLINT_USE_FLAT_CONFIG=false"
      fi
    fi
    # Run the project lint script as-is - do NOT pass staged files as arguments.
    # Appending file paths causes 'command line too long' on Windows when many
    # files are staged. The lint script already defines its own scope (e.g. 'eslint .').
    # ESLINT_USE_FLAT_CONFIG is already exported above if needed — just run lint.
    if [ -n "$LINT_ENV" ]; then
      echo "[Lint] Legacy ESLint config detected - ESLINT_USE_FLAT_CONFIG=false already set"
    fi

    # Special handling for next lint — must run from the Next.js app directory
    # Always pass --dir . to prevent Next.js from misinterpreting stray arguments
    # as a directory path (causes "no such directory: .../lint" on Windows)
    LINT_SCRIPT=$(node -e "try{const p=require('./package.json');process.stdout.write(p.scripts&&p.scripts.lint||'')}catch(e){}" 2>/dev/null)
    if echo "$LINT_SCRIPT" | grep -q "next lint"; then
      NEXT_CONFIG_DIR=""
      for CFG in "next.config.js" "next.config.mjs" "next.config.ts" "next.config.cjs"; do
        if [ -f "./$CFG" ]; then
          NEXT_CONFIG_DIR="."
          break
        fi
      done
      # Search one level deep if not found in CWD
      if [ -z "$NEXT_CONFIG_DIR" ]; then
        for CFG in "next.config.js" "next.config.mjs" "next.config.ts" "next.config.cjs"; do
          FOUND=$(find . -maxdepth 2 -name "$CFG" -not -path "*/node_modules/*" 2>/dev/null | head -1)
          if [ -n "$FOUND" ]; then
            NEXT_CONFIG_DIR=$(dirname "$FOUND")
            break
          fi
        done
      fi
      # Default to CWD if still not found
      if [ -z "$NEXT_CONFIG_DIR" ]; then
        NEXT_CONFIG_DIR="."
      fi
      echo "[Lint] Running: next lint --dir $NEXT_CONFIG_DIR"
      # Run next lint directly with --dir to avoid argument misinterpretation on Windows
      if [ -f "./node_modules/.bin/next" ]; then
        ./node_modules/.bin/next lint --dir "$NEXT_CONFIG_DIR"
      else
        npx next lint --dir "$NEXT_CONFIG_DIR"
      fi
      LINT_EXIT=$?
    else
      $PKG_RUN lint
      LINT_EXIT=$?
    fi

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
    echo "[Lint] Next.js detected — running: next lint --dir ."
    if [ -f "./node_modules/.bin/next" ]; then
      ./node_modules/.bin/next lint --dir .
    else
      npx next lint --dir .
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
    npx --no-install turbo lint 2>/dev/null || npx turbo lint
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
    ESLINT_BIN="npx eslint"
  elif command -v eslint >/dev/null 2>&1; then
    ESLINT_BIN="eslint"
  else
    ESLINT_BIN=""
  fi

  if [ -n "$ESLINT_BIN" ]; then
    echo "[ESLint] Running fallback lint: eslint ."
    # ESLINT_USE_FLAT_CONFIG is already exported above if needed
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
  # Use the correct exec command for the detected package manager
  if [ "$PKG_MANAGER" = "pnpm" ]; then
    pnpm exec cs-setup install gitleaks 2>/dev/null || npx cs-setup install gitleaks 2>/dev/null || true
  elif [ "$PKG_MANAGER" = "yarn" ]; then
    yarn cs-setup install gitleaks 2>/dev/null || npx cs-setup install gitleaks 2>/dev/null || true
  elif [ "$PKG_MANAGER" = "bun" ]; then
    bunx cs-setup install gitleaks 2>/dev/null || npx cs-setup install gitleaks 2>/dev/null || true
  else
    npx cs-setup install gitleaks 2>/dev/null || true
  fi
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
# Runs from the directory containing the test config file
# ---------------------------------------------------------------
echo ""
echo "[Coverage] Generating coverage report..."

# Find the directory containing the test runner config
COVERAGE_DIR="."
for CONFIG in "jest.config.js" "jest.config.ts" "jest.config.mjs" "jest.config.cjs" \
              "vitest.config.js" "vitest.config.ts" "vitest.config.mjs"; do
  if [ -f "./$CONFIG" ]; then
    COVERAGE_DIR="."
    break
  fi
  FOUND_CONFIG=$(find . -maxdepth 3 -name "$CONFIG" -not -path "*/node_modules/*" 2>/dev/null | head -1)
  if [ -n "$FOUND_CONFIG" ]; then
    COVERAGE_DIR=$(dirname "$FOUND_CONFIG")
    break
  fi
done

if [ "$COVERAGE_DIR" != "." ]; then
  echo "[Coverage] Test config found in $COVERAGE_DIR — running coverage from there"
fi

if [ -f "./node_modules/.bin/jest" ] || ([ "$COVERAGE_DIR" != "." ] && [ -f "$COVERAGE_DIR/node_modules/.bin/jest" ]); then
  (cd "$COVERAGE_DIR" && npx jest --coverage --coverageReporters=lcov text --passWithNoTests 2>/dev/null) || true
  echo "[Coverage] Jest coverage report generated ✔"
elif [ -f "./node_modules/.bin/vitest" ] || ([ "$COVERAGE_DIR" != "." ] && [ -f "$COVERAGE_DIR/node_modules/.bin/vitest" ]); then
  (cd "$COVERAGE_DIR" && npx vitest run --coverage 2>/dev/null) || true
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
  if grep -q "^sonar.token=REPLACE_WITH_YOUR_TOKEN" sonar-project.properties || \
     grep -q "^sonar.login=REPLACE_WITH_YOUR_TOKEN" sonar-project.properties || \
     grep -qE "^sonar.token=\s*$" sonar-project.properties || \
     grep -qE "^sonar.login=\s*$" sonar-project.properties; then
    echo "[SonarQube] Token is missing — skipping scan."
  else
    if [ -f "./node_modules/.bin/sonar-scanner" ]; then
      SONAR_BIN="npx sonar-scanner"
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