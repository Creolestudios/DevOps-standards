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
npm i cs-devtest -D
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
pnpm add cs-devtest -D
```

If the postinstall script does not run, initialize manually:

```bash
npx cs-devtest init
```

---

## 🔄 Updating or Joining an Existing Project

If you are joining a project that already uses `cs-devtest`, or you are updating to a newer version, you should run a lightweight **sync**. This restores missing tools (like Gitleaks binaries, SonarQube credentials, and Git hooks) without needing to re-initialize everything.

```bash
npm i cs-devtest -D
npx cs-devtest sync
```

For pnpm projects, use:

```bash
pnpm add cs-devtest -D
pnpm dlx cs-devtest sync
```

`sync` is blazing fast. It refreshes your local environment, sets up `.husky/` hooks, and regenerates `scripts/run-ci-checks.sh` automatically.

---

## ⚙️ Available CLI Commands

If the automatic setup didn't trigger, or if you need to manually configure your environment, you can use these commands:

- **`npx cs-devtest init`**
  Initializes Husky, Gitleaks, SonarQube configs, hooks, and required project dependencies. Run this if you are the **first developer** setting up the repo.

- **`npx cs-devtest sync`**
  Lightweight restore of missing gitignored tools (Gitleaks, hook files, SonarQube credentials). Run this if you are **joining a project** that is already initialized, or if you just updated to a new version.

- **`npx cs-devtest init --fix-aliases`**
  Runs initialization and temporarily strips invalid `npm:` aliases from `package.json` to bypass known `npm install` crashes.

- **`npx cs-devtest check-hooks`**
  Forces a restore of hook files and refreshes required tooling without a full reinstall.

---

## 📋 Configuration Details

### SonarQube
A `sonar-project.properties` file is automatically generated in your project root, pre-configured with the centralized SonarQube server and service account credentials. No manual setup is required!

### Postman / Newman
Save your Postman collections in your repository with the `.postman_collection.json` extension. The CI script will automatically find and execute them against your local server.

### Monorepo Support
The package automatically detects if your Node project is in a subdirectory of the Git repository. The hooks will automatically `cd` into the correct project folder before running checks.

### ESLint Auto-Fixing & Smart Defaults
The generated ESLint flat config (`eslint.config.mjs`) is pre-loaded with several smart defaults:
- **Auto-Fixing**: You can instantly fix thousands of formatting errors across your entire codebase by simply running `npx eslint . --fix`.
- **Smart Ignores**: It automatically ignores massive auto-generated folders (like `**/functions/**`) and bundled files (`**/*.bundle.js`) to prevent your computer from freezing during linting.
- **Fetch API Globals**: Standard globals like `fetch`, `Headers`, `Request`, `Response`, and `ReadableStream` are pre-whitelisted to prevent false positive `no-undef` errors.

---

## ☁️ Cloud Infrastructure Deployment (Terraform)

The package includes a fully automated Terraform configuration (`terraform/`) that provisions the central DevSecOps infrastructure on Google Cloud Platform (GCP).

### What is provisioned?
- **Networking**: A custom VPC (`devsecops-vpc`), Subnet, and dedicated Static IP.
- **Compute VM**: An Ubuntu instance (`devops-creolestudio-vm`) that acts as the master node.
- **Docker Tooling**: Auto-installs Docker and Docker Compose.
- **SonarQube**: Deploys a containerized SonarQube community server on port `9000`.
- **DefectDojo**: Deploys a full DefectDojo stack (Postgres + Redis) on port `8080`.
- **Wazuh SIEM**: Installs a native Wazuh Manager & Indexer and automatically provisions custom decoders/rules via SSH.
- **Grafana Cloud**: Configures dashboards (Node Exporter, k6 Load Testing) and automated API tokens for pipeline integrations.

### Deployment Instructions (New GCP Environment)

If your existing GCP account goes down and you need to deploy this entire DevSecOps stack to a brand new GCP project:

1. **Authenticate to Google Cloud**:
   ```bash
   gcloud auth application-default login
   gcloud config set project YOUR_NEW_PROJECT_ID
   ```

2. **Initialize Terraform**:
   ```bash
   cd terraform
   terraform init
   ```

3. **Configure Variables**:
   Create a `terraform.tfvars` file inside the `terraform/` folder:
   ```hcl
   project_id              = "YOUR_NEW_PROJECT_ID"
   region                  = "asia-south1"
   zone                    = "asia-south1-a"
   machine_type            = "n4d-standard-4"
   ssh_user                = "your_ssh_username"
   ssh_private_key_path    = "/path/to/your/private/key"
   grafana_url             = "https://your-instance.grafana.net"
   grafana_auth            = "YOUR_GRAFANA_SERVICE_ACCOUNT_TOKEN"
   grafana_cloud_api_token = "YOUR_GRAFANA_CLOUD_ACCESS_TOKEN"
   ```

4. **Deploy the Infrastructure**:
   ```bash
   terraform plan
   terraform apply -auto-approve
   ```

Once completed, Terraform will output the public IP and URLs to access SonarQube, DefectDojo, and Wazuh!

---

## ❌ Troubleshooting

- **Hooks aren't running?** Ensure you have initialized a Git repository (`git init`) before installing. You can manually run `npx cs-devtest check-hooks` to restore them.
- **Using pnpm and postinstall did not run?** Add `cs-devtest` to `pnpm.onlyBuiltDependencies`, run `pnpm install`, then run `pnpm dlx cs-devtest check-hooks` if needed.
- **Missing Vitest Coverage?** If your smoke tests fail due to a missing `@vitest/coverage-v8` dependency, run `npx cs-devtest check-hooks` to install it automatically.
- **Server fails to start in CI?** Ensure your `package.json` has a valid `start` or `dev` script.
