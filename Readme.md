# cs-setup

A robust, zero-config CLI package that automatically secures and standardizes your projects. By simply installing this package, it automatically configures **Husky**, **Gitleaks**, **ESLint**, **SonarQube**, **Smoke Testing**, and **Newman API Testing** natively hooked into your Git workflow.

---

## 🚀 Features

### 🛡️ Pre-Commit Hook (Code Quality & Security)
Whenever you run `git commit`, the following checks run automatically:
1. **ESLint**: Lints the project (and blocks the commit if lint fails).
2. **Gitleaks**: Scans staged files for hardcoded secrets and credentials. **Blocks the commit** if any secrets are detected.
3. **Coverage & SonarQube**: Attempts to generate test coverage (via Jest/Vitest) and then runs a SonarQube scan. If the Quality Gate fails, the **commit is blocked**.

### 🧪 Pre-Push Hook (CI Pipeline)
Whenever you run `git push`, a compulsory local CI pipeline runs:
1. **Smoke Test**: Automatically boots up your server and waits for it to be accessible.
2. **Newman API Tests**: Automatically runs Postman collections against your locally running server. **Blocks the push** if any tests fail.
3. **Branch Guard**: Automatically detects branch deletions (e.g., `git push origin --delete`) and skips CI checks to allow instant deletion.

---

## 📦 Installation

### Prerequisites
- **Git repo required**: run `git init` first (or clone an existing repo).
- **Node.js**: \(>= 16\)
- **Shell for hooks**: Husky hooks are `sh` scripts. On Windows, use **Git Bash** (recommended) or WSL.

### Install (from GitHub)
Install as a `devDependency` using your package manager.

Replace `<ORG>/<REPO>` with your public repo (example: `Creolestudios/DevOps-standards`).

#### npm

```bash
npm i -D github:<ORG>/<REPO>
```

#### pnpm

```bash
pnpm add -D github:<ORG>/<REPO>
```

#### yarn (classic v1)

```bash
yarn add -D github:<ORG>/<REPO>
```

### Initialize (recommended for all; required for pnpm/yarn)
For **npm**, setup may run automatically via `postinstall`. For **pnpm/yarn**, run init explicitly (more reliable, and avoids install-time script restrictions).

```bash
npx cs-setup init
```

pnpm alternative:

```bash
pnpm exec cs-setup init
```

### One-liners (new projects)

#### npm

```bash
npm i -D github:<ORG>/<REPO> && npx cs-setup init
```

#### pnpm

```bash
pnpm add -D github:<ORG>/<REPO> && pnpm exec cs-setup init
```

#### yarn (classic v1)

```bash
yarn add -D github:<ORG>/<REPO> && npx cs-setup init
```

### pnpm note (build scripts)
pnpm may ignore lifecycle/build scripts by default and require approval.
If you see warnings about ignored scripts, run:

```bash
pnpm approve-builds
```

### pnpm note (virtual store mismatch)
If you see an error like `ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF`, it means `node_modules` was created with a different pnpm setting.
cs-setup will attempt to self-heal by running `pnpm install`, but you can always fix it manually by deleting `node_modules` and reinstalling:

```bash
rm -rf node_modules
pnpm install
```

---

## 🧩 What cs-setup adds/updates in your project
After running `init` / `check-hooks`, cs-setup may create or update:

- **Husky hooks**: `/.husky/pre-commit`, `/.husky/pre-push`
- **Local CI script**: `/scripts/run-ci-checks.sh`
- **Newman runner**: `/tests/run-newman-cloud.mjs` (from template)
- **Sonar config**: `/sonar-project.properties`
- **Gitleaks ignore**: `/.gitleaksignore`
- **Local tools**: `/.tools/gitleaks/` (downloads the correct gitleaks binary for your OS)
- **Project scripts** (added if missing): `test:smoke`, `test:newman`, `test:all`
- **GitHub templates**: copies templates into `/.github/` (workflows + scripts)

---

## 🔄 Updating to Latest Version

If new features or fixes (like updated Git hook templates or new dependencies) are added to the `cs-setup` package, follow these steps to sync your project:

1. **Pull the latest code:**
   ```bash
   npm i -D github:<ORG>/<REPO>#<branch-or-tag>
   ```
2. **Sync hooks and scripts:**
   ```bash
   npx cs-setup check-hooks
   ```
*This will automatically update your `.husky/` files, refresh your `scripts/run-ci-checks.sh`, and install any new required dependencies (like Vitest coverage tools).*

---

## ⚙️ Manual Initialization

If the automatic setup didn't trigger, or if you want to re-run the initialization:

```bash
npx cs-setup init
```

To verify and restore your hooks without a full initialization:
```bash
npx cs-setup check-hooks
```

---

## 📋 Configuration Details

### SonarQube
A `sonar-project.properties` file is generated in your project root. You **must** edit this file to provide your SonarQube credentials:
- `sonar.host.url`: Your SonarQube server URL.
- `sonar.login`: Your SonarQube token.

### Postman / Newman
Save your Postman collections in your repository with the `.postman_collection.json` extension. The CI script will automatically find and execute them against your local server.

### Monorepo Support
The package automatically detects if your Node project is in a subdirectory of the Git repository. The hooks will automatically `cd` into the correct project folder before running checks.

---

## ❌ Troubleshooting

- **Hooks aren't running?** Ensure you have initialized a Git repository (`git init`) before installing. You can manually run `npx cs-setup check-hooks` to restore them.
- **Missing Vitest Coverage?** If your smoke tests fail due to a missing `@vitest/coverage-v8` dependency, run `npx cs-setup check-hooks` to install it automatically.
- **Server fails to start in CI?** Ensure your `package.json` has a valid `start` or `dev` script.
