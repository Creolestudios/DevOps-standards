# cs-devtest

A robust, zero-config CLI package that automatically secures and standardizes your projects. Install `cs-devtest` in any project to configure **Husky**, **Gitleaks**, **ESLint**, **SonarQube**, **Smoke Testing**, and **Newman API Testing** natively into your Git workflow.

---

## 🚀 Features

### 🛡️ Pre-Commit Hook (Code Quality & Security)
Whenever you run `git commit`, the following checks run automatically on your staged files:
1. **ESLint**: Auto-lints all staged `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs` files.
2. **Gitleaks**: Scans staged files for hardcoded secrets and credentials. **Blocks the commit** if any secrets are detected.
3. **Coverage & SonarQube**: Attempts to generate test coverage (via Jest/Vitest) and then runs a SonarQube scan. If the Quality Gate fails, the **commit is blocked**.

### 🧪 Pre-Push Hook (CI Pipeline)
Whenever you run `git push`, a compulsory local CI pipeline runs:
1. **Smoke Test**: Automatically boots up your server and waits for it to be accessible.
2. **Newman API Tests**: Automatically runs Postman collections against your locally running server. **Blocks the push** if any tests fail.
3. **Branch Guard**: Automatically detects branch deletions (e.g., `git push origin --delete`) and skips CI checks to allow instant deletion.

---

## 📦 Installation

To install the package in any project, run:

```bash
npm i cs-devtest
```

The package postinstall automatically initializes the setup and creates the required Git hooks, scripts, and configuration files.

For pnpm 10+, allow the package postinstall script so the Git hooks and generated files can be created automatically:

```json
{
  "pnpm": {
    "onlyBuiltDependencies": [
      "cs-devtest"
    ]
  }
}
```

Then install with:

```bash
pnpm add cs-devtest
```

If the postinstall script does not run, initialize manually:

```bash
npx cs-devtest init
```

---

## 🔄 Updating to Latest Version

If new features or fixes are added to `cs-devtest`, reinstall the package and then sync hooks, scripts, and required dependencies:

```bash
npm i cs-devtest
npx cs-devtest check-hooks
```

For pnpm projects, use:

```bash
pnpm add cs-devtest
pnpm dlx cs-devtest check-hooks
```

`check-hooks` refreshes `.husky/`, `scripts/run-ci-checks.sh`, SonarQube tooling, ESLint dependencies, and test coverage dependencies when needed.

---

## ⚙️ Manual Initialization

If the automatic setup didn't trigger, or if you want to re-run the initialization:

```bash
npx cs-devtest init
```

To verify and restore your hooks without a full initialization:

```bash
npx cs-devtest check-hooks
```

The CLI supports:
- `cs-devtest init` — initialize Husky, Gitleaks, SonarQube config, hooks, and required project dependencies.
- `cs-devtest check-hooks` — restore hook files and refresh required tooling without a full reinstall.
- `cs-devtest install [source]` — run the one-step installer for advanced/custom package sources.

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

- **Hooks aren't running?** Ensure you have initialized a Git repository (`git init`) before installing. You can manually run `npx cs-devtest check-hooks` to restore them.
- **Using pnpm and postinstall did not run?** Add `cs-devtest` to `pnpm.onlyBuiltDependencies`, run `pnpm install`, then run `pnpm dlx cs-devtest check-hooks` if needed.
- **Missing Vitest Coverage?** If your smoke tests fail due to a missing `@vitest/coverage-v8` dependency, run `npx cs-devtest check-hooks` to install it automatically.
- **Server fails to start in CI?** Ensure your `package.json` has a valid `start` or `dev` script.
