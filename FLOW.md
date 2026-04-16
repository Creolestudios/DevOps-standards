# cs-pack — Package Flow Documentation

## Overview

`cs-pack` is an npm package that automatically installs and configures a standardized local DevOps pipeline into any JS/TS project. It sets up Git hooks (via Husky), secret scanning (Gitleaks), code quality analysis (SonarQube), linting (ESLint), and CI scripts — all in one command.

---

## How It Gets Triggered

```
npm i cs-pack
    │
    └── postinstall script fires automatically
            │
            └── node ./bin/index.js install
```

It can also be triggered manually:

| Command | Purpose |
|---|---|
| `npx cs-setup init` | Full setup from scratch |
| `npx cs-setup install` | Same as init (postinstall alias) |
| `npx cs-setup check-hooks` | Repair / refresh hooks without full reinstall |

---

## High-Level Flow Diagram

```
npm i cs-pack
      │
      ▼
bin/index.js
      │
      ├── Postinstall guard (skip if running in cs-pack's own dev dir)
      │
      ├── [install / init] ──────────────────────────────────────────┐
      │                                                               │
      │   1.  fixInvalidAliases()         lib/fixer.js               │
      │   2.  isGitRepo()                 lib/git.js                 │
      │   3.  installHusky()              lib/husky.js               │
      │   4.  installGitleaks()           lib/gitleaks.js            │
      │   5.  installSonarScanner()       lib/sonarqube.js           │
      │   6.  installAllRequiredDeps()    lib/packageManager.js      │
      │   7.  Toolchain checks            lib/eslint.js              │
      │   8.  setupLintScripts()          lib/lintScripts.js         │
      │   9.  setupESLintConfig()         lib/eslint.js              │
      │   10. setupSonarProperties()      lib/sonarqube.js           │
      │   11. setupPreCommitHook()        lib/hooks.js               │
      │   12. ensurePackageLock()         lib/ci.js                  │
      │   13. setupCIScript()             lib/ci.js                  │
      │   14. ensureProjectScripts()      lib/ci.js                  │
      │   15. setupCIWorkflow()           lib/ci.js                  │
      │   16. setupPrePushHook()          lib/ci.js                  │
      │                                                               │
      └── [check-hooks] ─────────────────────────────────────────────┘
          (subset: steps 3, 11, 16, 7, 8, 9, 10, 13, 15)
```

---

## Step-by-Step Breakdown

### Step 1 — Postinstall Guard (`bin/index.js`)

Before doing anything, the package checks whether it is running inside its own development directory.

```
INIT_CWD  (where user ran npm i)
    vs
process.cwd()  (current working dir)

If equal → "Development detected — skipping automatic setup"
```

This prevents cs-pack from accidentally setting up hooks on itself when a developer is working on the package.

---

### Step 2 — Fix Invalid Aliases (`lib/fixer.js`)

Scans the target project's `package.json` for `npm:` aliased packages:

```json
"rolldown": "npm:rolldown-vite@7.2.2"
```

These cause npm to crash with "Invalid comparator" errors. The fix:

```
1. Read all npm: aliases from package.json
2. Temporarily remove them from package.json
3. Install the real package (e.g. rolldown-vite@7.2.2) via npm install --no-save
4. Copy installed package into node_modules under the alias name
5. Restore original package.json
```

---

### Step 3 — Git Repo Detection (`lib/git.js`)

Walks up the directory tree from `process.cwd()` looking for a `.git` folder.

Returns two important paths:

| Path | Description | Used for |
|---|---|---|
| `gitRoot` | Directory containing `.git` | Husky hooks, `.husky/` |
| `projectRoot` | Directory containing `package.json` | Config files, scripts |

If `gitRoot !== projectRoot`, a monorepo is detected and the package logs both paths.

---

### Step 4 — Install Husky (`lib/husky.js`)

```
1. Install husky as devDependency (if not already present)
2. Run `npx husky` at gitRoot to initialize .husky/ directory
3. Write a safe cross-platform "prepare" script to package.json
```

The `prepare` script uses an inline Node.js call instead of plain `"husky"` to handle:
- Windows: `npx` is `npx.cmd` on Windows
- First install: if Husky isn't installed yet, a plain `husky` call would fail and break `npm install`. This version always exits `0`.

```json
"prepare": "node -e \"const {spawnSync}=require(...)...\""
```

---

### Step 5 — Install Gitleaks (`lib/gitleaks.js`)

Downloads the Gitleaks binary from GitHub releases directly into the project:

```
1. Detect OS + CPU architecture
       darwin/arm64  → gitleaks_X.X.X_darwin_arm64.tar.gz
       win32/x64     → gitleaks_X.X.X_windows_x64.zip
       linux/x64     → gitleaks_X.X.X_linux_x64.tar.gz

2. Download from https://github.com/gitleaks/gitleaks/releases

3. Extract to .tools/gitleaks/

4. Update .gitignore with standard entries:
       node_modules/, .env, .env.*, dist/, build/,
       coverage/, .tools/, .scannerwork/, *.log, etc.
```

---

### Step 6 — Install SonarQube Scanner (`lib/sonarqube.js`)

Installs `sonarqube-scanner` as a dev dependency using the detected package manager.

---

### Step 7 — Install Required Dependencies (`lib/packageManager.js`)

Installs the minimum ESLint toolchain:

```
eslint@^9.0.0
@eslint/js@^9.0.0
```

If the project uses Vite (detected via `vite.config.*` or `package.json` deps):

```
vitest          (if not already installed)
@vitest/coverage-v8
```

---

### Step 8 — Toolchain Compatibility Checks (`lib/eslint.js`)

Three auto-fix checks run in sequence:

#### 8a. TypeScript ESLint Compatibility
```
If TypeScript >= 5.6 is installed
AND @typescript-eslint is older than v8
→ upgrade @typescript-eslint/parser and @typescript-eslint/eslint-plugin to ^8.0.0
```

#### 8b. ESLint Runtime Compatibility
```
If Node.js >= 22
AND ESLint v8 is installed
→ upgrade eslint to ^9.0.0 and @eslint/js to ^9.0.0
```

#### 8c. Legacy no-unused-vars Fix
```
If project has TypeScript
AND has .eslintrc.json or package.json eslintConfig
→ patch config to disable core no-unused-vars
→ add @typescript-eslint/no-unused-vars rule instead
```
This prevents a known crash where the core ESLint rule conflicts with the TypeScript parser.

#### 8d. Lint Script Safety Cleanup
```
If lint script contains --rule overrides injected by older cs-pack versions
→ strip them, restore clean "eslint ." command
```

---

### Step 9 — Setup Lint Script (`lib/lintScripts.js`)

If no `lint` script exists in `package.json`, adds one based on project type:

```
Next.js detected  (next.config.* or "next" in deps)  →  "next lint"
Turbo detected    (turbo.json or "turbo" in deps)     →  "turbo lint"
Everything else                                        →  "eslint ."
```

This runs **before** `setupESLintConfig` so the config generator can see the lint script.

---

### Step 10 — Setup ESLint Config (`lib/eslint.js`)

Detects the installed ESLint version and creates the appropriate config file:

```
ESLint v9+  →  eslint.config.mjs   (flat config)
ESLint v8   →  .eslintrc.json      (legacy config)
```

Three scenarios:

| Scenario | Action |
|---|---|
| No config exists | Create from template |
| Config exists, correct format | Merge/patch only (no replacement) |
| Config exists, wrong format | Migrate to correct format, keep old as backup |

**Skips entirely** if a `lint` script already existed before Step 9 — assumes the project manages its own ESLint setup.

---

### Step 11 — Setup SonarQube Properties (`lib/sonarqube.js`)

Writes `sonar-project.properties` to the project root:

```properties
sonar.host.url=http://localhost:9000
sonar.token=REPLACE_WITH_YOUR_TOKEN
sonar.projectKey=<derived from package.json name>
sonar.projectName=<derived from package.json name>
sonar.sources=.
sonar.tests=tests   (or pattern-based if no test dir found)
sonar.exclusions=node_modules/**,dist/**,build/**,...
```

The token is a placeholder — the developer fills it in manually.

---

### Step 12 — Setup Pre-Commit Hook (`lib/hooks.js`)

Writes `.husky/pre-commit`. This script runs automatically on every `git commit`:

```
git commit
      │
      ▼
.husky/pre-commit
      │
      ├── DEV_MODE=true or SKIP_HOOKS=true? → exit 0 (skip all)
      │
      ├── No staged files? → exit 0
      │
      ├── [Doctor] TypeScript/ESLint version check
      │       TS >= 5.6 + @typescript-eslint < v8 → auto-upgrade
      │       Node >= 22 + ESLint v8 → auto-upgrade to ESLint v9
      │
      ├── [Lint] Run project lint script
      │       Has pnpm workspace? → run lint for all packages serially
      │       Has legacy .eslintrc.*? → set ESLINT_USE_FLAT_CONFIG=false
      │       Has Next.js (no lint script)? → next lint
      │       Has Turbo (no lint script)? → turbo lint
      │       Fallback → eslint .
      │       FAIL → block commit (exit 1)
      │
      ├── [Gitleaks] Scan staged files for secrets
      │       Copy staged files to temp dir
      │       Run gitleaks detect --no-git
      │       FAIL → block commit (exit 1)
      │
      ├── [Coverage] Generate coverage report (best-effort, non-blocking)
      │       Jest detected → jest --coverage
      │       Vitest detected → vitest run --coverage
      │
      └── [SonarQube] Run quality gate scan
              Token is placeholder? → skip
              sonar-project.properties missing? → skip
              Run sonar-scanner -Dsonar.qualitygate.wait=true
              FAIL → block commit (exit 1)
```

---

### Step 13 — Ensure Package Lock (`lib/ci.js`)

If no lock file exists in the project, runs the package manager's install command to generate one:

```
pnpm-lock.yaml missing → pnpm install
yarn.lock missing      → yarn install
package-lock.json missing → npm install
```

---

### Step 14 — Setup CI Script (`lib/ci.js`)

Copies two template files into the target project:

```
templates/run-ci-checks.sh          →  scripts/run-ci-checks.sh
templates/run-newman-cloud.mjs.template  →  tests/run-newman-cloud.mjs
```

`run-ci-checks.sh` is the script that runs during pre-push. It handles smoke tests and Newman API tests.

---

### Step 15 — Ensure Project Scripts (`lib/ci.js`)

Adds standard CI scripts to `package.json` if they don't already exist:

| Script | Default value |
|---|---|
| `test:smoke` | `npx vitest run --coverage` (Vite) / `npx jest --coverage` (Jest) / `node --test` (fallback) |
| `test:newman` | `node tests/run-newman-cloud.mjs` |
| `test:all` | `npm run test:smoke && npm run test:newman` |

---

### Step 16 — Setup GitHub Workflows (`lib/ci.js`)

Copies `templates/github-template/` into the target project's `.github/` directory:

```
templates/github-template/
    workflows/
        security-pipeline.yml   →  .github/workflows/security-pipeline.yml
    scripts/
        generate-html.js        →  .github/scripts/generate-html.js
        run-all-scans.sh        →  .github/scripts/run-all-scans.sh
```

Sets executable permissions (`chmod 755`) on all scripts.

---

### Step 17 — Setup Pre-Push Hook (`lib/ci.js`)

Writes `.husky/pre-push`. This script runs automatically on every `git push`:

```
git push
      │
      ▼
.husky/pre-push
      │
      ├── Read git stdin: <local_ref> <local_sha> <remote_ref> <remote_sha>
      │
      ├── local_sha = 0000000000000000000000000000000000000000?
      │       → Deletion push detected → exit 0 (skip all checks)
      │
      ├── DEV_MODE=true or SKIP_HOOKS=true? → exit 0 (skip all)
      │
      ├── scripts/run-ci-checks.sh missing?
      │       → Auto-recreate from embedded template
      │
      └── ./scripts/run-ci-checks.sh
                │
                ├── [Smoke Tests]
                │       test:smoke script exists + test files found?
                │           → run test:smoke
                │           → FAIL → block push (exit 1)
                │       No test files found → warn and continue
                │
                └── [Newman API Tests]
                        *.postman_collection.json found?
                            → Start server (npm start / npm run dev)
                            → Wait up to 30s for server to be ready (TCP probe)
                            → Run test:newman script (or newman directly)
                            → Stop server
                            → FAIL → block push (exit 1)
                        No collections found → warn and continue
```

---

## `check-hooks` Flow

A lighter repair flow — runs when hooks are corrupted, after updating cs-pack, or after a toolchain version mismatch.

```
npx cs-setup check-hooks
      │
      ├── installHusky()                  (reinitialize .husky/)
      ├── setupPreCommitHook()            (rewrite pre-commit)
      ├── setupPrePushHook()              (rewrite pre-push)
      ├── installSonarScanner()           (ensure scanner installed)
      ├── installAllRequiredDeps()        (ensure eslint etc. installed)
      ├── ensureTypeScriptEslintCompatibility()
      ├── ensureEslintRuntimeCompatibility()
      ├── ensureLegacyNoUnusedVarsFix()
      ├── ensureLintScriptSafety()        (clean up old --rule overrides)
      ├── setupLintScripts()              (add lint script if missing)
      ├── setupESLintConfig()             (create/migrate ESLint config)
      ├── setupSonarProperties()          (refresh sonar-project.properties)
      ├── setupCIScript()                 (refresh run-ci-checks.sh)
      └── setupCIWorkflow()               (refresh .github/ templates)
```

---

## Package Manager Detection

Every install command and generated hook script detects the package manager by walking up the directory tree looking for a lock file:

```
pnpm-lock.yaml found
    + pnpm-workspace.yaml at same level as cwd → pnpm add -D -w  (workspace root)
    + no workspace file                         → pnpm add -D

yarn.lock found   → yarn add -D
bun.lockb found   → bun add -d
package-lock.json → npm install --save-dev
none found        → npm (fallback)
```

This detection runs in both the Node.js setup code (`lib/packageManager.js`) and inside the generated shell hook scripts, so the correct package manager is used at every stage.

---

## Files Created in Target Project

After a full `init`, the following files are created or modified:

```
project-root/
├── .husky/
│   ├── pre-commit          ← lint + gitleaks + coverage + sonar
│   └── pre-push            ← smoke tests + newman
├── .github/
│   ├── workflows/
│   │   └── security-pipeline.yml
│   └── scripts/
│       ├── generate-html.js
│       └── run-all-scans.sh
├── .tools/
│   └── gitleaks/
│       └── gitleaks[.exe]
├── scripts/
│   └── run-ci-checks.sh
├── tests/
│   └── run-newman-cloud.mjs
├── .gitleaksignore
├── .gitignore              ← entries added
├── sonar-project.properties
├── eslint.config.mjs       ← OR .eslintrc.json (depends on ESLint version)
└── package.json            ← prepare, lint, test:smoke, test:newman, test:all added
```

---

## Environment Variables (Hook Bypass)

| Variable | Effect |
|---|---|
| `DEV_MODE=true` | Skips all pre-commit and pre-push checks |
| `SKIP_HOOKS=true` | Same as DEV_MODE |

Usage:
```bash
DEV_MODE=true git commit -m "skip hooks"
DEV_MODE=true git push
```
