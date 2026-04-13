# 🛡️ Security Scanning Pipeline

This document explains the complete, automated DevSecOps CI/CD pipeline integrated into the package. It details how the pipeline runs, what secrets it requires, and exactly what causes it to pass, flag warnings, or fail.

> **Core Philosophy:** The pipeline is designed to be **resilient**. It attempts to gather as much data as possible (reports, findings) even if certain test stages fail. It will only completely fail the build if fundamental security gates are breached.

## 🧩 Pipeline Stages

1. **SonarQube SAST:** Static Application Security Testing. Analyzes code for bugs, vulnerabilities, and code smells.
2. **Quality Gate Check:** Validates the SonarQube analysis against the server's Quality Gate rules.
3. **Unit Tests (Phase A):** Automatically runs `jest` or `npm test` if test files are found.
4. **API Tests / Newman (Phase B):** Automatically starts the app server and runs Postman collections if present.
5. **DefectDojo Import:** Pushes all vulnerabilities to DefectDojo for centralized vulnerability management.
6. **Artifact Generation:** Generates a beautiful HTML dashboard and bundles all raw JSON reports.

## ⚙️ Pass, Warn, and Fail Conditions

The pipeline evaluates multiple checks, but only one condition will hard-fail the pipeline. Everything else generates a warning to ensure you still receive the final security report.

| Scenario / Trigger | Result | Behavior Description |
|---|---|---|
| **SonarQube Quality Gate Fails**<br>*(e.g., too many critical vulnerabilities)* | ❌ **FAILS** | **Pipeline halts and exits with error code.** This is the *only* condition that currently fails the entire GitHub Action. |
| **Unit/Smoke Tests Fail**<br>*(e.g., `npm run test` fails)* | ⚠️ **WARNS** | Pipeline logs the error but **continues**. The workflow will still succeed at the end. |
| **Newman / API Tests Fail**<br>*(e.g., Postman assertions fail)* | ⚠️ **WARNS** | Pipeline logs the assertion failures but **continues**. |
| **App Server Crashes**<br>*(Before Newman tests execute)* | ⚠️ **WARNS** | Server crash log is printed. Newman tests are *skipped*. Pipeline continues. |
| **DefectDojo Import Fails**<br>*(e.g., wrong API key)* | ⚠️ **WARNS** | Pipeline logs the HTTP error, skips fetching from DefectDojo, and instead bundles raw SonarQube reports into the final artifact. Pipeline continues. |
| **No `tests/` directory found** | ⏭️ **SKIPS** | Both Unit and API tests are skipped cleanly. |
| **Everything behaves nicely** | ✅ **PASSES** | All security gates passed, tests passed, and reports uploaded to DefectDojo! |

## 🧪 How Tests Are Detected

Test execution is completely automated and relies on the physical presence of files, not what is written in `package.json`.

### Unit Tests (Phase A)
Unit tests will run if ANY of these files exist inside the `tests/` directory:
- `*.test.js`, `*.test.ts`, `*.test.mjs`
- `*.spec.js`, `*.spec.ts`, `*.spec.mjs`

### Newman/API Tests (Phase B)
The pipeline will start your server on port 3000 and run API tests if it finds:
- Any file ending in `.postman_collection.json` or `.collection.json` *(anywhere in the project)*
- The specific file `tests/run-newman-cloud.mjs`

## 🔐 Required GitHub Secrets

To function correctly, the target repository needs the following secrets configured in **Settings → Secrets and variables → Actions**:

```text
SONAR_HOST_URL           = http://your-sonarqube-server:9000
SONAR_TOKEN              = sqp_1234567890abcdef...

DEFECTDOJO_URL           = http://your-defectdojo-server:8080
DEFECTDOJO_API_KEY       = 1234567890abcdef... (just the key, no 'Token' prefix)
DEFECTDOJO_ENGAGEMENT_ID = 1
DEFECTDOJO_PRODUCT_ID    = 1

POSTMAN_API_KEY          = PMAK-xxx (Optional: if using Postman cloud runners)
COLLECTION_UID           = 1234-xxx (Optional: if using Postman cloud runners)
```

## 📦 Artifacts & Retention

Artifacts are downloadable ZIP files containing the scan outputs, attached to every GitHub Actions run.

| Artifact Name | Contents | Retention Period |
|---|---|---|
| `security-report-{branch}-{sha}-{date}` | <ul><li>`final-report.html` - Beautiful user-friendly HTML dashboard</li><li>`final-report.json` - Raw vulnerabilities from DefectDojo</li><li>`sonarqube-report.json` - Raw SonarQube issues</li><li>`newman-report.html` - API test results (if ran)</li><li>`scan.log` & `server.log` - Execution logs</li></ul> | **90 Days**<br>*(GitHub's maximum limit)* |

> *Note: While GitHub deletes artifacts after 90 days, your vulnerability data is stored permanently inside DefectDojo.*
