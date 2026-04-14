# cs-setup

`cs-setup` is a CLI that standardizes local DevOps checks for JS/TS repos by installing tools and generating Husky hooks:

- **pre-commit**: lint (monorepo-aware) → gitleaks (staged-only) → coverage (best-effort) → SonarQube (optional)
- **pre-push**: runs a local CI script (smoke + newman)

> This README is written for real-world usage across **npm**, **pnpm**, and **yarn** (including pnpm workspaces/monorepos).

---

## ✅ What it creates/updates in your project
After running `init` / `check-hooks`, cs-setup may create or update:

- **hooks**: `/.husky/pre-commit`, `/.husky/pre-push`
- **scripts**: `/scripts/run-ci-checks.sh`
- **newman runner**: `/tests/run-newman-cloud.mjs` (template)
- **gitleaks**: `/.gitleaksignore` and `/.tools/gitleaks/`
- **sonar**: `/sonar-project.properties`
- **GitHub templates**: `/.github/` (workflows + scripts)
- **package.json scripts** (added if missing): `test:smoke`, `test:newman`, `test:all`
- **package.json prepare**: a safe cross-platform `prepare` script that won’t break installs on Windows if husky isn’t present yet

---

## 📦 Install (GitHub repo)
Replace `<ORG>/<REPO>` with your public repo (example: `Creolestudios/DevOps-standards`).

### npm

```bash
npm i -D github:<ORG>/<REPO>
npx cs-setup init
```

### yarn (classic v1)

```bash
yarn add -D github:<ORG>/<REPO>
npx cs-setup init
```

### pnpm (single package repo)

```bash
pnpm add -D github:<ORG>/<REPO>
pnpm exec cs-setup init
```

### pnpm workspace / monorepo
If you run the command at the workspace root (you have `pnpm-workspace.yaml`), pnpm requires `-w` to install at root.

#### Install at workspace root

```bash
pnpm add -Dw github:<ORG>/<REPO>
pnpm exec cs-setup init
```

#### Install into a specific workspace package

```bash
pnpm add -D github:<ORG>/<REPO> --filter <package-name>
pnpm --filter <package-name> exec cs-setup init
```

---

## ▶️ Commands

### Initialize

```bash
npx cs-setup init
```

pnpm alternative:

```bash
pnpm exec cs-setup init
```

### Repair / refresh hooks without full setup

```bash
npx cs-setup check-hooks
```

---

## 🧠 How linting works (important for monorepos)

- If a `lint` script exists, cs-setup runs it.
- If this is a **pnpm workspace**, cs-setup runs **lint for every workspace package** (serial, no-bail) and prints **all outputs**.
- Then it also runs a **workspace-root ESLint scan** (only if a root ESLint config + eslint binary exists) to ensure “whole codebase” coverage.
- The commit is blocked **only after the complete run finishes**, if any errors were found.

---

## ⚙️ SonarQube setup
`sonar-project.properties` is generated. You must fill:

- `sonar.host.url`
- `sonar.login` (token) — if it stays as `REPLACE_WITH_YOUR_TOKEN`, Sonar scan is skipped.

---

## 🛠️ Troubleshooting (copy/paste)

### 1) pnpm workspace root warning (`ERR_PNPM_ADDING_TO_ROOT`)
Install at root explicitly:

```bash
pnpm add -Dw github:<ORG>/<REPO>
```

### 2) pnpm store mismatch (`ERR_PNPM_UNEXPECTED_STORE`)
This happens if `node_modules` was installed with a different pnpm store (often WSL vs Windows).

```bash
rm -rf node_modules
pnpm install
```

### 3) pnpm virtual store mismatch (`ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF`)
Recreate `node_modules`:

```bash
rm -rf node_modules
pnpm install
```

### 4) GitHub install tries SSH and fails (DNS/SSH blocked)
If pnpm tries `git+ssh://git@github.com/...` and you get `Could not resolve hostname github.com` / SSH errors, use HTTPS:

```bash
pnpm add -D "git+https://github.com/<ORG>/<REPO>.git#master"
```

or tarball:

```bash
pnpm add -D "https://codeload.github.com/<ORG>/<REPO>/tar.gz/master"
```

### 5) Windows: hooks don’t run
Husky hooks are `sh` scripts. Use **Git Bash** (recommended) or WSL.

### 6) TypeScript / ESLint crash (TypeScript too new for @typescript-eslint)
If you see warnings like:
- `SUPPORTED TYPESCRIPT VERSIONS ... YOUR TYPESCRIPT VERSION: 5.9.x`
and/or ESLint crashes during lint, run:

```bash
npx cs-setup check-hooks
```

cs-setup will auto-upgrade `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin` to a compatible major version.

---

## 🔄 Updating cs-setup

```bash
# npm
npm i -D github:<ORG>/<REPO>#<branch-or-tag>

# pnpm
pnpm add -D github:<ORG>/<REPO>#<branch-or-tag>

# yarn
yarn add -D github:<ORG>/<REPO>#<branch-or-tag>

npx cs-setup check-hooks
```
