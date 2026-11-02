#!/bin/bash
# =============================================================================
# run-all-scans.sh
# Scans: SonarQube SAST, Newman API, OWASP ZAP DAST
# Output: Imported to DefectDojo → final report as a GitHub artifact.
#
# Two modes, chosen by SCAN_MODE (set by security-pipeline.yml):
#   onprem — talks only to the on-prem credential broker (CS_DEVTEST_BROKER_URL);
#            holds no SonarQube/DefectDojo secrets. Runs on a self-hosted LAN
#            runner that can reach the broker.
#   gcp    — talks to SonarQube/DefectDojo directly with the SONAR_* and
#            DEFECTDOJO_* GitHub Secrets. Runs on GitHub's ubuntu-latest.
#
# SCAN_STAGE selects which part runs, so the pipeline can split the work into
# jobs on different machines (default: all):
#   tests   — install dependencies + unit tests           (no office network)
#   dynamic — start the app, Newman API tests, OWASP ZAP   (no office network)
#   sonar   — SonarQube scan + quality gate                (needs SonarQube)
#   report  — DefectDojo import + final JSON/HTML report   (needs DefectDojo)
# Each stage writes status-<stage>.env into the reports directory; the report
# stage reads them (the workflow downloads all stage artifacts first).
# =============================================================================

set -euo pipefail

# ── Paths ────────────────────────────────────────────────────────────────────
WORKSPACE="${HOME}/security-scan"
APP_DIR="${WORKSPACE}/app"          # Scan entire repo root
REPORTS_DIR="${WORKSPACE}/reports"

SCAN_STAGE="${SCAN_STAGE:-all}"
case "${SCAN_STAGE}" in
  all|tests|dynamic|sonar|report) ;;
  *) echo "ERROR: Unknown SCAN_STAGE '${SCAN_STAGE}' (expected all, tests, dynamic, sonar or report)" >&2; exit 1 ;;
esac
stage_has() { [ "${SCAN_STAGE}" = "all" ] || [ "${SCAN_STAGE}" = "$1" ]; }

# Per-stage log name so the merged artifacts do not overwrite each other.
LOG_FILE="${REPORTS_DIR}/scan-${SCAN_STAGE}.log"

# ── State ────────────────────────────────────────────────────────────────────
SONAR_RESULT="skipped"
UNIT_RESULT="skipped"
NEWMAN_RESULT="skipped"
ZAP_RESULT="skipped"
IMPORT_COUNT=0
FINAL_FORMAT="none"
DOJO_IMPORT_FAILED=false

# Sonar host + scoped token come from the broker's /sonar/provision response.
SONAR_SCAN_HOST=""
SONAR_SCAN_TOKEN=""
SONAR_PROJECT_KEY=""
PROJECT_NAME=""

# ── Logging ──────────────────────────────────────────────────────────────────
mkdir -p "${REPORTS_DIR}"
exec > >(tee -a "${LOG_FILE}") 2>&1

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
ok()   { echo "[$(date '+%H:%M:%S')] ✓ $*"; }
warn() { echo "[$(date '+%H:%M:%S')]  WARNING: $*"; }
fail() { echo "[$(date '+%H:%M:%S')] ✗ ERROR: $*"; }
banner_fail() {
  echo ""
  echo "################################################################"
  echo "#                                                              #"
  echo "#   ✗ ERROR: $1 FAILED   #"
  echo "#                                                              #"
  echo "################################################################"
  echo ""
}

# ─────────────────────────────────────────────────────────────────────────────
# BANNER + VALIDATION
# ─────────────────────────────────────────────────────────────────────────────
log "======================================================="
log " Security Scan — Pipeline"
log " SHA:    ${GIT_SHA:0:8}"
log " Branch: ${GIT_BRANCH}"
log " Date:   ${RUN_DATE}"
log "======================================================="

# Default the mode for manual runs: broker URL present → onprem, else gcp.
if [ -z "${SCAN_MODE:-}" ]; then
  if [ -n "${CS_DEVTEST_BROKER_URL:-}" ]; then SCAN_MODE=onprem; else SCAN_MODE=gcp; fi
fi
log " Mode:   ${SCAN_MODE}"
log " Stage:  ${SCAN_STAGE}"

# Only the sonar and report stages talk to SonarQube/DefectDojo, so only they
# need the mode-specific settings.
REQUIRED=(GIT_SHA GIT_BRANCH RUN_DATE)
case "${SCAN_MODE}" in
  onprem)
    if stage_has sonar || stage_has report; then REQUIRED+=(GIT_REPO CS_DEVTEST_BROKER_URL); fi ;;
  gcp)
    if stage_has sonar; then REQUIRED+=(SONAR_HOST_URL SONAR_TOKEN); fi
    if stage_has report; then
      REQUIRED+=(DEFECTDOJO_URL DEFECTDOJO_API_KEY DEFECTDOJO_ENGAGEMENT_ID DEFECTDOJO_PRODUCT_ID)
    fi ;;
  *) fail "Unknown SCAN_MODE '${SCAN_MODE}' (expected onprem or gcp)"; exit 1 ;;
esac
MISSING=()
for var in "${REQUIRED[@]}"; do
  [ -z "${!var:-}" ] && MISSING+=("$var")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  fail "Missing required variables: ${MISSING[*]}"
  exit 1
fi
ok "All required env vars present"

normalize_url() {
  local u
  u=$(echo "$1" | tr -d '\r\n ')
  [[ "${u}" =~ ^https?:// ]] || u="http://${u}"
  echo "${u%/}"
}

if [ "${SCAN_MODE}" = "onprem" ]; then
  [ -n "${CS_DEVTEST_BROKER_URL:-}" ] && CS_DEVTEST_BROKER_URL=$(normalize_url "${CS_DEVTEST_BROKER_URL}")
else
  # Strip newlines/whitespace that often sneak into pasted secrets.
  [ -n "${SONAR_TOKEN:-}" ] && SONAR_TOKEN=$(echo "${SONAR_TOKEN}" | tr -d '\r\n ')
  [ -n "${DEFECTDOJO_API_KEY:-}" ] && DEFECTDOJO_API_KEY=$(echo "${DEFECTDOJO_API_KEY}" | tr -d '\r\n ')
  [ -n "${DEFECTDOJO_ENGAGEMENT_ID:-}" ] && DEFECTDOJO_ENGAGEMENT_ID=$(echo "${DEFECTDOJO_ENGAGEMENT_ID}" | tr -d '\r\n ')
  [ -n "${DEFECTDOJO_PRODUCT_ID:-}" ] && DEFECTDOJO_PRODUCT_ID=$(echo "${DEFECTDOJO_PRODUCT_ID}" | tr -d '\r\n ')
  [ -n "${SONAR_HOST_URL:-}" ] && SONAR_HOST_URL=$(normalize_url "${SONAR_HOST_URL}")
  [ -n "${DEFECTDOJO_URL:-}" ] && DEFECTDOJO_URL=$(normalize_url "${DEFECTDOJO_URL}")
fi

# Saves this stage's results for the report stage (values shell-quoted).
write_status() {
  local name="$1"; shift
  local f="${REPORTS_DIR}/status-${name}.env" var
  : > "$f"
  for var in "$@"; do
    printf '%s=%q\n' "$var" "${!var:-}" >> "$f"
  done
}

# Stable CI consumer identity — scopes the broker-minted scanner token so CI
# never clobbers a developer laptop's token (§3.1).
CONSUMER_ID="ci-${RUNNER_NAME:-unknown}"

# ── Check environment ────────────────────────────────────────────────────────
# Only the dynamic stage (OWASP ZAP) needs Docker.
if stage_has dynamic; then
  command -v docker &>/dev/null || { fail "Docker not found"; exit 1; }
  ok "Docker: $(docker --version | cut -d' ' -f3 | tr -d ',')"
fi

# ── Verify APP_DIR exists (the report stage only needs the reports) ──────────
if [ "${SCAN_STAGE}" != "report" ]; then
  if [ ! -d "${APP_DIR}" ]; then
    fail "APP_DIR not found: ${APP_DIR}"
    exit 1
  fi
  ok "Scanning directory: ${APP_DIR}"
  log "Contents of scan root:"
  ls -la "${APP_DIR}" | head -30
fi

# ── Fix permissions upfront ──────────────────────────────────────────────────
chmod -R 777 "${REPORTS_DIR}" 2>/dev/null || true
ok "Permissions set on reports directory"

# ── Broker health (advisory, non-fatal) ──────────────────────────────────────
# /healthz returns 503 whenever EITHER upstream is down (§3.4). We never exit on
# that; we branch per field. Only a fully unreachable broker skips SAST and
# forces the raw-report bundle.
SONAR_REACHABLE=false
if ! stage_has sonar && ! stage_has report; then
  log "Stage '${SCAN_STAGE}' does not contact SonarQube/DefectDojo — skipping server checks."
elif [ "${SCAN_MODE}" = "onprem" ]; then
  log "Checking broker at ${CS_DEVTEST_BROKER_URL}/healthz ..."
  HEALTH_RESPONSE=$(curl -s -w "\n%{http_code}" --connect-timeout 10 --max-time 15 \
    "${CS_DEVTEST_BROKER_URL}/healthz" 2>/dev/null || echo $'\n000')
  HEALTH_CODE=$(echo "${HEALTH_RESPONSE}" | tail -1)
  HEALTH_BODY=$(echo "${HEALTH_RESPONSE}" | sed '$d')

  if [ "${HEALTH_CODE}" = "000" ] || [ -z "${HEALTH_CODE}" ]; then
    warn "Broker not reachable — SAST will be skipped and raw reports bundled"
  else
    log "Broker health (HTTP ${HEALTH_CODE}): ${HEALTH_BODY}"
    if echo "${HEALTH_BODY}" | grep -q '"sonar":"up"'; then
      SONAR_REACHABLE=true
      ok "SonarQube reachable via broker"
    else
      warn "SonarQube reported down by broker — SAST skipped"
    fi
    if echo "${HEALTH_BODY}" | grep -q '"defectdojo":"up"'; then
      ok "DefectDojo reachable via broker"
    else
      warn "DefectDojo reported down by broker — imports may fall back to raw bundle"
    fi
  fi
else
  # GCP: DefectDojo is required for the report stage (hard fail); SonarQube is
  # optional for the sonar stage (soft).
  if stage_has report; then
    log "Checking DefectDojo at ${DEFECTDOJO_URL} ..."
    DOJO_OK=false
    for attempt in 1 2 3; do
      DOJO_HTTP=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 15 --max-time 20 \
        "${DEFECTDOJO_URL}" 2>/dev/null || echo "000")
      if [ "${DOJO_HTTP}" != "000" ]; then
        ok "DefectDojo reachable (HTTP ${DOJO_HTTP})"
        DOJO_OK=true
        break
      fi
      warn "DefectDojo attempt ${attempt}/3 failed — retrying in 15s..."
      sleep 15
    done
    if [ "${DOJO_OK}" = "false" ]; then
      fail "DefectDojo not reachable at ${DEFECTDOJO_URL}"
      exit 1
    fi
  fi

  if stage_has sonar; then
    log "Checking SonarQube at ${SONAR_HOST_URL} ..."
    for attempt in 1 2 3; do
      SONAR_HTTP=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 15 --max-time 20 \
        "${SONAR_HOST_URL}" 2>/dev/null || echo "000")
      if [ "${SONAR_HTTP}" != "000" ]; then
        ok "SonarQube reachable (HTTP ${SONAR_HTTP})"
        SONAR_REACHABLE=true
        break
      fi
      warn "SonarQube attempt ${attempt}/3 — retrying in 15s..."
      sleep 15
    done
    if [ "${SONAR_REACHABLE}" = "false" ]; then warn "SonarQube not reachable — SAST skipped"; fi
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — SonarQube Project Setup & SAST              [stage: sonar]
# ─────────────────────────────────────────────────────────────────────────────
if stage_has sonar; then
log "-------------------------------------------------------"
log "STEP 1: SonarQube Project Setup & SAST"
log "-------------------------------------------------------"

if [ "${SONAR_REACHABLE}" = "true" ]; then
  cd "${APP_DIR}"

  log "Determining SonarQube project identity..."
  PKG_JSON=""
  if [ -f "package.json" ]; then
    PKG_JSON="package.json"
  elif [ -n "$(find . -maxdepth 2 -name "package.json" ! -path "*/node_modules/*" | head -1)" ]; then
    PKG_JSON=$(find . -maxdepth 2 -name "package.json" ! -path "*/node_modules/*" | head -1)
  fi

  if [ -n "${PKG_JSON}" ]; then
    log "Found package.json at: ${PKG_JSON}"
    PROJECT_NAME=$(grep -m 1 '"name":' "${PKG_JSON}" | cut -d'"' -f4 || echo "unknown-project")
  else
    warn "No package.json found — using repository name as project name"
    PROJECT_NAME=$(basename "${APP_DIR}")
  fi

  # §3.0 transform (lowercase + map disallowed chars) — the broker re-applies it.
  SONAR_PROJECT_KEY=$(echo "${PROJECT_NAME}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._:-]/-/g')
  ok "Project name: ${PROJECT_NAME}, key: ${SONAR_PROJECT_KEY}"

  if [ "${SCAN_MODE}" = "onprem" ]; then
    # --- Provision via the broker (CI sends consumerId, omits gitEmail) -------
    log "Requesting SonarQube provisioning from broker..."
    PROVISION_RESP=$(curl -s -w "\n%{http_code}" -X POST \
      -H "Content-Type: application/json" \
      -d "{\"projectKey\":\"${SONAR_PROJECT_KEY}\",\"projectName\":\"${PROJECT_NAME}\",\"consumerId\":\"${CONSUMER_ID}\"}" \
      "${CS_DEVTEST_BROKER_URL}/sonar/provision" 2>/dev/null || echo $'\n000')
    PROVISION_CODE=$(echo "${PROVISION_RESP}" | tail -1)
    PROVISION_BODY=$(echo "${PROVISION_RESP}" | sed '$d')

    if [ "${PROVISION_CODE}" = "200" ]; then
      SONAR_SCAN_HOST=$(echo "${PROVISION_BODY}" | grep -o '"hostUrl":"[^"]*"' | head -1 | cut -d'"' -f4)
      SONAR_SCAN_TOKEN=$(echo "${PROVISION_BODY}" | grep -o '"scannerToken":"[^"]*"' | head -1 | cut -d'"' -f4)
      ok "Broker provisioned project (host: ${SONAR_SCAN_HOST})"
    else
      warn "Broker /sonar/provision failed (HTTP ${PROVISION_CODE}) — skipping SAST"
      SONAR_REACHABLE=false
    fi
  else
    # --- GCP: create the project with the SONAR_TOKEN secret if missing -------
    SONAR_SCAN_HOST="${SONAR_HOST_URL}"
    SONAR_SCAN_TOKEN="${SONAR_TOKEN}"
    log "Checking if project '${SONAR_PROJECT_KEY}' exists in SonarQube..."
    PROJECT_SEARCH_RESP=$(curl -s -u "${SONAR_TOKEN}:" \
      "${SONAR_HOST_URL}/api/projects/search?projects=${SONAR_PROJECT_KEY}" || echo "REACH_ERROR")
    if ! echo "${PROJECT_SEARCH_RESP}" | grep -q "\"key\":\"${SONAR_PROJECT_KEY}\"" \
       && [ "${PROJECT_SEARCH_RESP}" != "REACH_ERROR" ]; then
      log "Project not found. Auto-creating '${SONAR_PROJECT_KEY}'..."
      CREATE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -u "${SONAR_TOKEN}:" -X POST \
        "${SONAR_HOST_URL}/api/projects/create" \
        --data-urlencode "name=${PROJECT_NAME}" \
        --data-urlencode "project=${SONAR_PROJECT_KEY}" || echo "000")
      if [ "${CREATE_STATUS}" = "200" ] || [ "${CREATE_STATUS}" = "201" ]; then
        ok "Project created successfully (HTTP ${CREATE_STATUS})"
      else
        warn "Could not create project (HTTP ${CREATE_STATUS}) — likely missing Admin permissions. Proceeding with scan anyway..."
      fi
    else
      ok "Project '${SONAR_PROJECT_KEY}' existence confirmed or search skipped"
    fi
  fi
fi

if [ "${SONAR_REACHABLE}" = "true" ] && [ -n "${SONAR_SCAN_TOKEN}" ]; then
  cd "${APP_DIR}"

  # Official SonarSource scanner: downloads its own Java runtime, so it works on
  # runners without Java (the old unofficial `sonar-scanner` package needs one).
  # sonar.qualitygate.wait makes the scanner wait for SonarQube to process the
  # analysis and exit non-zero if the gate fails. It only needs the scan token
  # (the on-prem scan-only token cannot call api/ce or api/qualitygates).
  log "Running SonarScanner via NPX (sonarqube-scanner)..."
  SONAR_LOG="${REPORTS_DIR}/sonar-scanner.log"
  QG_FAILED=false
  if npx --yes sonarqube-scanner \
       -Dsonar.projectKey="${SONAR_PROJECT_KEY}" \
       -Dsonar.projectName="${PROJECT_NAME}" \
       -Dsonar.host.url="${SONAR_SCAN_HOST}" \
       -Dsonar.token="${SONAR_SCAN_TOKEN}" \
       -Dsonar.sources=. \
       -Dsonar.exclusions="**/node_modules/**,**/dist/**,**/build/**,**/coverage/**,**/tests/**,**/seeds/**,**/scripts/**,**/.git/**" \
       -Dsonar.sourceEncoding=UTF-8 \
       -Dsonar.qualitygate.wait=true \
       -Dsonar.qualitygate.timeout=600 \
       2>&1 | tee "${SONAR_LOG}"; then
    ok "Quality Gate Passed"
    SONAR_RESULT="passed"
  elif grep -q 'QUALITY GATE STATUS: FAILED' "${SONAR_LOG}"; then
    warn "Quality Gate FAILED — see ${SONAR_SCAN_HOST}/dashboard?id=${SONAR_PROJECT_KEY}"
    SONAR_RESULT="failed (quality gate)"
    QG_FAILED=true
  else
    banner_fail "SONARQUBE SCAN"
    SONAR_RESULT="failed"
  fi

  # Export the open issues for the DefectDojo import (only if the scan ran).
  if [ "${SONAR_RESULT}" != "failed" ]; then
    if [ "${SCAN_MODE}" = "onprem" ]; then
      ISSUES_HTTP=$(curl -s -G -o "${REPORTS_DIR}/sonarqube-report.json" -w "%{http_code}" \
        --data-urlencode "projectKey=${SONAR_PROJECT_KEY}" \
        "${CS_DEVTEST_BROKER_URL}/sonar/issues" || echo "000")
    else
      ISSUES_HTTP=$(curl -s -o "${REPORTS_DIR}/sonarqube-report.json" -w "%{http_code}" \
        -u "${SONAR_SCAN_TOKEN}:" \
        "${SONAR_SCAN_HOST}/api/issues/search?componentKeys=${SONAR_PROJECT_KEY}&resolved=false&ps=500" || echo "000")
    fi
    if [ "${ISSUES_HTTP}" = "200" ] && grep -q '"issues"' "${REPORTS_DIR}/sonarqube-report.json"; then
      ISSUE_COUNT=$(grep -o '"total":[0-9]*' "${REPORTS_DIR}/sonarqube-report.json" | head -1 | cut -d: -f2)
      ok "SonarQube issues exported (${ISSUE_COUNT:-?} open issues)"
    else
      warn "Could not export SonarQube issues (HTTP ${ISSUES_HTTP}): $(head -c 300 "${REPORTS_DIR}/sonarqube-report.json" 2>/dev/null)"
      rm -f "${REPORTS_DIR}/sonarqube-report.json"
      [ "${QG_FAILED}" = "true" ] || SONAR_RESULT="partial"
    fi
  fi
else
  warn "Skipping SonarQube — broker/SonarQube not reachable"
fi
write_status sonar SONAR_RESULT QG_FAILED
fi # stage: sonar

# ─────────────────────────────────────────────────────────────────────────────
# Dependencies — shared by the tests and dynamic stages
# ─────────────────────────────────────────────────────────────────────────────
if stage_has tests || stage_has dynamic; then
cd "${APP_DIR}"
log "Detecting package manager..."
PKG_MANAGER="npm"
if [ -f "pnpm-lock.yaml" ]; then PKG_MANAGER="pnpm";
elif [ -f "yarn.lock" ]; then PKG_MANAGER="yarn";
elif [ -f "bun.lockb" ]; then PKG_MANAGER="bun"; fi

RUN_CMD="$PKG_MANAGER run"
if [ "$PKG_MANAGER" = "yarn" ]; then RUN_CMD="yarn"; fi

ok "Using package manager: $PKG_MANAGER"

log "Installing dependencies..."
if [ "$PKG_MANAGER" = "npm" ]; then
  npm ci --silent > /dev/null 2>&1 || npm install --no-audit --no-fund --silent > /dev/null 2>&1 || true
else
  $PKG_MANAGER install --frozen-lockfile --silent > /dev/null 2>&1 || $PKG_MANAGER install --silent > /dev/null 2>&1 || true
fi
fi # stage: tests or dynamic

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — Unit Testing                                [stage: tests]
# ─────────────────────────────────────────────────────────────────────────────
if stage_has tests; then
log "-------------------------------------------------------"
log "STEP 2: Unit Testing"
log "-------------------------------------------------------"
if $PKG_MANAGER test; then
  ok "Unit tests passed"
  UNIT_RESULT="passed"
else
  banner_fail "UNIT TESTS"
  UNIT_RESULT="failed"
fi
write_status tests UNIT_RESULT
fi # stage: tests

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 — API Integration Testing (Newman)            [stage: dynamic]
# ─────────────────────────────────────────────────────────────────────────────
if stage_has dynamic; then
log "-------------------------------------------------------"
log "STEP 3: API Integration Testing (Newman)"
log "-------------------------------------------------------"
log "Starting the backend application on port 3000..."
cd "${APP_DIR}"
$PKG_MANAGER start > /dev/null 2>&1 &
APP_PID=$!

log "Waiting up to 30s for the application to be ready on http://localhost:3000..."
APP_READY=false
for _ in $(seq 1 15); do
  if curl -s --connect-timeout 2 --max-time 3 http://localhost:3000 > /dev/null; then
    APP_READY=true
    break
  fi
  sleep 2
done

if [ "${APP_READY}" = "true" ]; then
  ok "Application is ready. Running Newman tests..."
  if [ -n "${POSTMAN_API_KEY:-}" ] && [ -n "${COLLECTION_UID:-}" ]; then
    if $RUN_CMD test:newman; then
      ok "Newman tests passed"
      NEWMAN_RESULT="passed"
    else
      banner_fail "NEWMAN API TESTS"
      NEWMAN_RESULT="failed"
    fi
  else
    warn "Missing POSTMAN_API_KEY or COLLECTION_UID — skipping Newman"
    NEWMAN_RESULT="skipped (missing keys)"
  fi

  # ─────────────────────────────────────────────────────────────────────────────
  # STEP 4 — OWASP ZAP DAST Scan
  # ─────────────────────────────────────────────────────────────────────────────
  log "-------------------------------------------------------"
  log "STEP 4: OWASP ZAP DAST Scan"
  log "-------------------------------------------------------"
  ok "Starting ZAP Baseline Scan..."
  # Grant full permissions to REPORTS_DIR so the isolated Docker user 'zap' can write the file back
  chmod 777 "${REPORTS_DIR}"

  # Use || true so the script doesn't abort early if vulnerabilities are found
  docker run --rm --network=host \
    -v "${REPORTS_DIR}:/zap/wrk/:rw" \
    ghcr.io/zaproxy/zaproxy:stable zap-baseline.py \
    -t http://localhost:3000 \
    -x zap-report.xml || true

  if [ -f "${REPORTS_DIR}/zap-report.xml" ]; then
    ZAP_SIZE=$(wc -c < "${REPORTS_DIR}/zap-report.xml")
    if [ "${ZAP_SIZE}" -gt 100 ]; then
      ok "ZAP Scan completed successfully (${ZAP_SIZE} bytes)."
      ZAP_RESULT="completed"
    else
      warn "ZAP Scan completed but report is suspiciously small."
      ZAP_RESULT="failed"
    fi
  else
    warn "ZAP Scan failed to produce a report."
    ZAP_RESULT="failed"
  fi
else
  warn "Application failed to start. Skipping Newman and ZAP scans."
  NEWMAN_RESULT="failed (app not ready)"
  ZAP_RESULT="skipped"
fi

log "Shutting down the backend application..."
kill ${APP_PID} 2>/dev/null || true
cd "${WORKSPACE}"
write_status dynamic NEWMAN_RESULT ZAP_RESULT
fi # stage: dynamic

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5 — Import to DefectDojo                        [stage: report]
# ─────────────────────────────────────────────────────────────────────────────
if stage_has report; then
# Results from the other stages (downloaded artifacts, or this same run).
for STATUS_FILE in "${REPORTS_DIR}"/status-*.env; do
  [ -f "${STATUS_FILE}" ] || continue
  # shellcheck disable=SC1090
  . "${STATUS_FILE}"
done
log "-------------------------------------------------------"
log "STEP 5: Importing to DefectDojo"
log "-------------------------------------------------------"

do_import() {
  local FILE="$1" SCAN_TYPE="$2" LABEL="$3"
  if [ ! -f "${FILE}" ]; then
    warn "Skipping ${LABEL} — file not found: ${FILE}"
    return 1
  fi
  log "Importing ${LABEL} ($(wc -c < "${FILE}") bytes)..."
  local RESPONSE HTTP_CODE BODY EXPECTED
  if [ "${SCAN_MODE}" = "onprem" ]; then
    EXPECTED=200
    RESPONSE=$(curl -s -w "\n%{http_code}" \
      -X POST \
      -F "file=@${FILE}" \
      -F "repo=${GIT_REPO}" \
      -F "branch=${GIT_BRANCH}" \
      -F "commit=${GIT_SHA}" \
      -F "scanType=${SCAN_TYPE}" \
      "${CS_DEVTEST_BROKER_URL}/defectdojo/import" || echo $'\n000')
  else
    EXPECTED=201
    RESPONSE=$(curl -s -w "\n%{http_code}" \
      -X POST \
      -H "Authorization: Token ${DEFECTDOJO_API_KEY}" \
      -F "scan_date=${RUN_DATE}" \
      -F "scan_type=${SCAN_TYPE}" \
      -F "engagement=${DEFECTDOJO_ENGAGEMENT_ID}" \
      -F "file=@${FILE}" \
      -F "close_old_findings=true" \
      -F "minimum_severity=Low" \
      -F "tags=git-sha:${GIT_SHA:0:8},branch:${GIT_BRANCH},date:${RUN_DATE}" \
      "${DEFECTDOJO_URL}/api/v2/import-scan/" || echo $'\n000')
  fi
  HTTP_CODE=$(echo "${RESPONSE}" | tail -1)
  BODY=$(echo "${RESPONSE}" | sed '$d')
  if [ "${HTTP_CODE}" = "${EXPECTED}" ]; then
    ok "${LABEL} imported"
    IMPORT_COUNT=$((IMPORT_COUNT + 1))
    return 0
  else
    warn "${LABEL} import failed (HTTP ${HTTP_CODE})"
    warn "Response: ${BODY}"
    return 1
  fi
}

do_import \
  "${REPORTS_DIR}/sonarqube-report.json" \
  "SonarQube Scan" \
  "SonarQube" || true

do_import \
  "${REPORTS_DIR}/zap-report.xml" \
  "ZAP Scan" \
  "OWASP ZAP" || true

if [ "${IMPORT_COUNT}" -eq 0 ]; then
  warn "DefectDojo import failed — pipeline will continue and bundle raw reports"
  warn "Check:"
  if [ "${SCAN_MODE}" = "onprem" ]; then
    warn "  1. CS_DEVTEST_BROKER_URL — must point at the on-prem broker (port 8900)"
    warn "  2. The runner must be a self-hosted LAN runner that can reach the broker"
    warn "  3. The broker's DefectDojo credentials (onprem/.env on the server)"
  else
    warn "  1. DEFECTDOJO_API_KEY — must be the key value only (no 'Token ' prefix)"
    warn "  2. DEFECTDOJO_ENGAGEMENT_ID — must be a valid numeric ID"
    warn "  3. DEFECTDOJO_URL — e.g. http://your-host:8080"
  fi
  DOJO_IMPORT_FAILED=true
else
  ok "${IMPORT_COUNT} reports imported to DefectDojo"
  DOJO_IMPORT_FAILED=false
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 6 — Generate final report from DefectDojo (or bundle raw reports)
# ─────────────────────────────────────────────────────────────────────────────
log "-------------------------------------------------------"
log "STEP 6: Generating final report"
log "-------------------------------------------------------"

if [ "${DOJO_IMPORT_FAILED}" = "true" ]; then
  warn "DefectDojo unavailable — bundling raw scan reports as final output"

  SONAR_SIZE=$(wc -c < "${REPORTS_DIR}/sonarqube-report.json" 2>/dev/null || echo 0)

  cat > "${REPORTS_DIR}/final-report.json" <<EOF
{
  "scan_summary": {
    "sha": "${GIT_SHA:0:8}",
    "branch": "${GIT_BRANCH}",
    "date": "${RUN_DATE}",
    "sonarqube_result": "${SONAR_RESULT}",
    "unit_tests_result": "${UNIT_RESULT}",
    "newman_tests_result": "${NEWMAN_RESULT}",
    "zap_result": "${ZAP_RESULT}",
    "defectdojo_import": "failed",
    "note": "DefectDojo import failed. Raw reports are included in this artifact.",
    "raw_reports": {
      "sonarqube_report_bytes": ${SONAR_SIZE},
      "zap_report_bytes": $(wc -c < "${REPORTS_DIR}/zap-report.xml" 2>/dev/null || echo 0)
    }
  }
}
EOF
  ok "Summary JSON written — raw reports also available in artifact"
  FINAL_FORMAT="json"

else
  sleep 15

  log "Fetching findings from DefectDojo..."
  if [ "${SCAN_MODE}" = "onprem" ]; then
    HTTP=$(curl -s -G \
      -o "${REPORTS_DIR}/final-report.json" \
      -w "%{http_code}" \
      --data-urlencode "repo=${GIT_REPO}" \
      --data-urlencode "branch=${GIT_BRANCH}" \
      --data-urlencode "limit=500" \
      "${CS_DEVTEST_BROKER_URL}/defectdojo/findings" || echo "000")
  else
    HTTP=$(curl -s \
      -o "${REPORTS_DIR}/final-report.json" \
      -w "%{http_code}" \
      -H "Authorization: Token ${DEFECTDOJO_API_KEY}" \
      "${DEFECTDOJO_URL}/api/v2/findings/?engagement=${DEFECTDOJO_ENGAGEMENT_ID}&limit=500" || echo "000")
  fi
  SIZE=$(wc -c < "${REPORTS_DIR}/final-report.json" 2>/dev/null || echo 0)

  if [ "${HTTP}" = "200" ] && [ "${SIZE}" -gt 10 ]; then
    ok "DefectDojo findings report generated (${SIZE} bytes)"

    # Merge scan_summary into the fetched findings so HTML report shows both
    if command -v jq &>/dev/null; then
      log "Merging pipeline summary into findings..."
      TEMP_JSON="${REPORTS_DIR}/temp-findings.json"
      cp "${REPORTS_DIR}/final-report.json" "${TEMP_JSON}"
      jq --arg sha "${GIT_SHA:0:8}" \
         --arg branch "${GIT_BRANCH}" \
         --arg date "${RUN_DATE}" \
         --arg sonar "${SONAR_RESULT}" \
         --arg unit "${UNIT_RESULT}" \
         --arg newman "${NEWMAN_RESULT}" \
         --arg zap "${ZAP_RESULT}" \
         '. + {scan_summary: {sha: $sha, branch: $branch, date: $date, sonarqube_result: $sonar, unit_tests_result: $unit, newman_tests_result: $newman, zap_result: $zap}}' \
         "${TEMP_JSON}" > "${REPORTS_DIR}/final-report.json"
      rm "${TEMP_JSON}"
    fi

    FINAL_FORMAT="json"
  else
    warn "Findings fetch failed (HTTP ${HTTP}, ${SIZE} bytes) — falling back to raw bundle"
    cat > "${REPORTS_DIR}/final-report.json" <<EOF
{
  "scan_summary": {
    "sha": "${GIT_SHA:0:8}",
    "branch": "${GIT_BRANCH}",
    "date": "${RUN_DATE}",
    "sonarqube_result": "${SONAR_RESULT}",
    "unit_tests_result": "${UNIT_RESULT}",
    "newman_tests_result": "${NEWMAN_RESULT}",
    "zap_result": "${ZAP_RESULT}",
    "defectdojo_import": "imported_but_report_fetch_failed",
    "note": "Raw reports are included in this artifact."
  }
}
EOF
    ok "Fallback summary JSON written"
    FINAL_FORMAT="json"
  fi
fi

log "-------------------------------------------------------"
log "STEP 5: Generating HTML Report"
log "-------------------------------------------------------"
if command -v node &>/dev/null; then
  if [ -f "${WORKSPACE}/scripts/generate-html.js" ] && [ -f "${REPORTS_DIR}/final-report.json" ]; then
    node "${WORKSPACE}/scripts/generate-html.js" "${REPORTS_DIR}/final-report.json" "${REPORTS_DIR}/final-report.html"
    if [ -f "${REPORTS_DIR}/final-report.html" ]; then
      FINAL_FORMAT="json + html"
    else
      warn "Failed to generate HTML report."
    fi
  else
    warn "Missing final-report.json or generate-html.js script. Skipping HTML generation."
  fi
else
  warn "Node.js not installed on runner. Skipping HTML generation."
fi

fi # stage: report

log ""
log "Reports directory contents:"
ls -lh "${REPORTS_DIR}" || true

# ─────────────────────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────────────────────
if ! stage_has report; then
  log ""
  log "======================================================="
  log " STAGE '${SCAN_STAGE}' COMPLETE"
  stage_has sonar   && log " SonarQube SAST:      ${SONAR_RESULT}"
  stage_has tests   && log " Unit Tests:         ${UNIT_RESULT}"
  stage_has dynamic && log " Newman API Tests:   ${NEWMAN_RESULT}"
  stage_has dynamic && log " OWASP ZAP DAST:      ${ZAP_RESULT}"
  log "======================================================="
else
log ""
log "======================================================="
log " SCAN COMPLETE"
log " SHA: ${GIT_SHA:0:8}  Branch: ${GIT_BRANCH}"
log "-------------------------------------------------------"
log " SonarQube SAST:      ${SONAR_RESULT:-skipped}"
log " Unit Tests:         ${UNIT_RESULT}"
log " Newman API Tests:   ${NEWMAN_RESULT}"
log " OWASP ZAP DAST:      ${ZAP_RESULT}"
log " DefectDojo imports: ${IMPORT_COUNT}"
log " Report format:      ${FINAL_FORMAT}"
log " Report:             ${REPORTS_DIR}/final-report.${FINAL_FORMAT}"
log "======================================================="
ok "Done. Report will be uploaded as GitHub artifact."
fi

# The quality gate fails the job that ran the scan (sonar or all), not the
# report job, so GitHub shows the failure on the right job.
if stage_has sonar && [ "${QG_FAILED:-false}" = "true" ]; then
  log ""
  fail "TERMINAL ERROR: SonarQube Quality Gate Failed"
  fail "The pipeline is blocked from passing because security/quality conditions were not met."
  exit 1
fi
