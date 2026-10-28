#!/bin/bash
# =============================================================================
# run-all-scans.sh
# Scans: SonarQube SAST, Newman API, OWASP ZAP DAST
# Output: Imported to DefectDojo via the on-prem credential broker → final
#         report as a GitHub artifact.
#
# This script holds NO SonarQube/DefectDojo secrets. It talks only to the
# credential broker (CS_DEVTEST_BROKER_URL), which performs all privileged work
# server-side. It must run on a self-hosted LAN runner that can reach the broker.
# =============================================================================

set -euo pipefail

# ── Paths ────────────────────────────────────────────────────────────────────
WORKSPACE="${HOME}/security-scan"
APP_DIR="${WORKSPACE}/app"          # Scan entire repo root
REPORTS_DIR="${WORKSPACE}/reports"
LOG_FILE="${REPORTS_DIR}/scan.log"

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

REQUIRED=(
  GIT_SHA GIT_BRANCH RUN_DATE
  GIT_REPO
  CS_DEVTEST_BROKER_URL
)
MISSING=()
for var in "${REQUIRED[@]}"; do
  [ -z "${!var:-}" ] && MISSING+=("$var")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  fail "Missing required variables: ${MISSING[*]}"
  exit 1
fi
ok "All required env vars present"

# ── Normalize broker URL ─────────────────────────────────────────────────────
CS_DEVTEST_BROKER_URL=$(echo "${CS_DEVTEST_BROKER_URL}" | tr -d '\r\n ')
if [[ ! "${CS_DEVTEST_BROKER_URL}" =~ ^https?:// ]]; then
  log "Normalizing CS_DEVTEST_BROKER_URL to include http://"
  CS_DEVTEST_BROKER_URL="http://${CS_DEVTEST_BROKER_URL}"
fi
CS_DEVTEST_BROKER_URL="${CS_DEVTEST_BROKER_URL%/}"

# Stable CI consumer identity — scopes the broker-minted scanner token so CI
# never clobbers a developer laptop's token (§3.1).
CONSUMER_ID="ci-${RUNNER_NAME:-unknown}"

# ── Check environment ────────────────────────────────────────────────────────
command -v docker &>/dev/null || { fail "Docker not found"; exit 1; }
ok "Docker: $(docker --version | cut -d' ' -f3 | tr -d ',')"

# ── Verify APP_DIR exists ────────────────────────────────────────────────────
if [ ! -d "${APP_DIR}" ]; then
  fail "APP_DIR not found: ${APP_DIR}"
  exit 1
fi
ok "Scanning directory: ${APP_DIR}"
log "Contents of scan root:"
ls -la "${APP_DIR}" | head -30

# ── Fix permissions upfront ──────────────────────────────────────────────────
chmod -R 777 "${REPORTS_DIR}" 2>/dev/null || true
ok "Permissions set on reports directory"

# ── Broker health (advisory, non-fatal) ──────────────────────────────────────
# /healthz returns 503 whenever EITHER upstream is down (§3.4). We never exit on
# that; we branch per field. Only a fully unreachable broker skips SAST and
# forces the raw-report bundle.
log "Checking broker at ${CS_DEVTEST_BROKER_URL}/healthz ..."
SONAR_REACHABLE=false
BROKER_REACHABLE=false
HEALTH_RESPONSE=$(curl -s -w "\n%{http_code}" --connect-timeout 10 --max-time 15 \
  "${CS_DEVTEST_BROKER_URL}/healthz" 2>/dev/null || echo $'\n000')
HEALTH_CODE=$(echo "${HEALTH_RESPONSE}" | tail -1)
HEALTH_BODY=$(echo "${HEALTH_RESPONSE}" | sed '$d')

if [ "${HEALTH_CODE}" = "000" ] || [ -z "${HEALTH_CODE}" ]; then
  warn "Broker not reachable — SAST will be skipped and raw reports bundled"
else
  BROKER_REACHABLE=true
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

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — SonarQube Project Setup & SAST (via broker)
# ─────────────────────────────────────────────────────────────────────────────
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

  # --- Provision via the broker (CI sends consumerId, omits gitEmail) ---------
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
fi

if [ "${SONAR_REACHABLE}" = "true" ] && [ -n "${SONAR_SCAN_TOKEN}" ]; then
  cd "${APP_DIR}"
  SONAR_OK=false

  log "Running SonarScanner via NPX to avoid Docker pulls..."
  npx --yes sonar-scanner \
    -Dsonar.projectKey="${SONAR_PROJECT_KEY}" \
    -Dsonar.projectName="${PROJECT_NAME}" \
    -Dsonar.host.url="${SONAR_SCAN_HOST}" \
    -Dsonar.token="${SONAR_SCAN_TOKEN}" \
    -Dsonar.sources=. \
    -Dsonar.exclusions="**/node_modules/**,**/dist/**,**/build/**,**/coverage/**,**/tests/**,**/seeds/**,**/scripts/**,**/.git/**" \
    -Dsonar.sourceEncoding=UTF-8 \
    2>&1 && SONAR_OK=true || SONAR_OK=false

  if [ "${SONAR_OK}" = "true" ]; then
    log "Waiting 30s for SonarQube to process analysis..."
    sleep 30

    log "Polling SonarQube background task..."
    for i in $(seq 1 12); do
      RAW_RESP=$(curl -s -u "${SONAR_SCAN_TOKEN}:" \
        "${SONAR_SCAN_HOST}/api/ce/component?component=${SONAR_PROJECT_KEY}")
      STATUS=$(echo "${RAW_RESP}" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
      if [ -z "${STATUS}" ]; then
        STATUS="UNKNOWN"
        log "  Raw API response: ${RAW_RESP}"
      fi
      log "  Task status: ${STATUS} (attempt ${i}/12)"
      [ "${STATUS}" = "SUCCESS" ] && break
      [ "${STATUS}" = "FAILED" ] && { warn "SonarQube background task FAILED"; break; }
      sleep 10
    done

    QG_FAILED=false
    if [ "${STATUS}" = "SUCCESS" ]; then
      log "Checking SonarQube Quality Gate status..."
      # Give Elasticsearch/Quality Gate engine a few seconds to finalize
      sleep 5
      QG_RESP=$(curl -s -u "${SONAR_SCAN_TOKEN}:" \
        "${SONAR_SCAN_HOST}/api/qualitygates/project_status?projectKey=${SONAR_PROJECT_KEY}")
      QG_STATUS=$(echo "${QG_RESP}" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "UNKNOWN")

      if [ "${QG_STATUS}" = "OK" ]; then
        ok "Quality Gate Passed (Status: ${QG_STATUS})"
        SONAR_RESULT="passed"
      else
        warn "Quality Gate FAILED (Status: ${QG_STATUS})"
        log "  Raw Quality Gate API Response: ${QG_RESP}"
        SONAR_RESULT="failed (quality gate)"
        QG_FAILED=true
      fi
    else
      warn "SonarQube background task did not reach SUCCESS. Status: ${STATUS}"
      SONAR_RESULT="failed (task incomplete)"
    fi

    curl -s \
      -u "${SONAR_SCAN_TOKEN}:" \
      "${SONAR_SCAN_HOST}/api/issues/search?componentKeys=${SONAR_PROJECT_KEY}&resolved=false&ps=500" \
      -o "${REPORTS_DIR}/sonarqube-report.json"
    SIZE=$(wc -c < "${REPORTS_DIR}/sonarqube-report.json" 2>/dev/null || echo 0)

    if [ "${SIZE}" -gt 500 ]; then
      ok "SonarQube report saved (${SIZE} bytes)"
      [ "${QG_FAILED}" != "true" ] && SONAR_RESULT="passed"
    else
      warn "SonarQube report too small (${SIZE} bytes) — likely empty or error"
      warn "Raw: $(cat "${REPORTS_DIR}/sonarqube-report.json" 2>/dev/null || echo 'unreadable')"
      SONAR_RESULT="partial"
    fi
  else
    banner_fail "SONARQUBE SCAN"
    SONAR_RESULT="failed"
  fi
else
  warn "Skipping SonarQube — broker/SonarQube not reachable"
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — Unit Testing
# ─────────────────────────────────────────────────────────────────────────────
log "-------------------------------------------------------"
log "STEP 2: Unit Testing"
log "-------------------------------------------------------"
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

if $PKG_MANAGER test; then
  ok "Unit tests passed"
  UNIT_RESULT="passed"
else
  banner_fail "UNIT TESTS"
  UNIT_RESULT="failed"
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 — API Integration Testing (Newman)
# ─────────────────────────────────────────────────────────────────────────────
log "-------------------------------------------------------"
log "STEP 3: API Integration Testing (Newman)"
log "-------------------------------------------------------"
log "Starting the backend application on port 3000..."
cd "${APP_DIR}"
$PKG_MANAGER start > /dev/null 2>&1 &
APP_PID=$!

log "Waiting up to 30s for the application to be ready on http://localhost:3000..."
APP_READY=false
for i in $(seq 1 15); do
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

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5 — Import to DefectDojo (via broker)
# ─────────────────────────────────────────────────────────────────────────────
log "-------------------------------------------------------"
log "STEP 5: Importing to DefectDojo"
log "-------------------------------------------------------"

do_import() {
  local FILE="$1" SCAN_TYPE="$2" LABEL="$3"
  if [ ! -f "${FILE}" ]; then
    warn "Skipping ${LABEL} — file not found: ${FILE}"
    return 1
  fi
  log "Importing ${LABEL} ($(wc -c < "${FILE}") bytes) via broker..."
  local RESPONSE HTTP_CODE BODY
  RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -F "file=@${FILE}" \
    -F "repo=${GIT_REPO}" \
    -F "branch=${GIT_BRANCH}" \
    -F "commit=${GIT_SHA}" \
    -F "scanType=${SCAN_TYPE}" \
    "${CS_DEVTEST_BROKER_URL}/defectdojo/import")
  HTTP_CODE=$(echo "${RESPONSE}" | tail -1)
  BODY=$(echo "${RESPONSE}" | sed '$d')
  if [ "${HTTP_CODE}" = "200" ]; then
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
  warn "  1. CS_DEVTEST_BROKER_URL — must point at the on-prem broker (port 8900)"
  warn "  2. The runner must be a self-hosted LAN runner that can reach the broker"
  warn "  3. The broker's DefectDojo credentials (onprem/.env on the server)"
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

  log "Fetching findings from broker..."
  HTTP=$(curl -s -G \
    -o "${REPORTS_DIR}/final-report.json" \
    -w "%{http_code}" \
    --data-urlencode "repo=${GIT_REPO}" \
    --data-urlencode "branch=${GIT_BRANCH}" \
    --data-urlencode "limit=500" \
    "${CS_DEVTEST_BROKER_URL}/defectdojo/findings")
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

log ""
log "Reports directory contents:"
ls -lh "${REPORTS_DIR}" || true

# ─────────────────────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────────────────────
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

if [ "${QG_FAILED:-false}" = "true" ]; then
  log ""
  fail "TERMINAL ERROR: SonarQube Quality Gate Failed"
  fail "The pipeline is blocked from passing because security/quality conditions were not met."
  exit 1
fi
