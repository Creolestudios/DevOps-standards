#!/bin/bash
# =============================================================================
# run-all-scans.sh
# Scans: SonarQube SAST
# Output: Imported to DefectDojo → final report as GitHub artifact
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
SONAR_PROJECT_KEY=""

# ── Logging ──────────────────────────────────────────────────────────────────
mkdir -p "${REPORTS_DIR}"
exec > >(tee -a "${LOG_FILE}") 2>&1

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
ok()   { echo "[$(date '+%H:%M:%S')] ✓ $*"; }
warn() { echo "[$(date '+%H:%M:%S')] ⚠ WARNING: $*"; }
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
  SONAR_HOST_URL SONAR_TOKEN
  DEFECTDOJO_URL DEFECTDOJO_API_KEY
  DEFECTDOJO_ENGAGEMENT_ID DEFECTDOJO_PRODUCT_ID
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

# ── Clean Secrets (Strip Newlines & Whitespace) ──────────────────────────────
log "Trimming whitespace and newlines from secrets..."
SONAR_TOKEN=$(echo "${SONAR_TOKEN}" | tr -d '\r\n ')
SONAR_HOST_URL=$(echo "${SONAR_HOST_URL}" | tr -d '\r\n ')
DEFECTDOJO_URL=$(echo "${DEFECTDOJO_URL}" | tr -d '\r\n ')
DEFECTDOJO_API_KEY=$(echo "${DEFECTDOJO_API_KEY}" | tr -d '\r\n ')
DEFECTDOJO_ENGAGEMENT_ID=$(echo "${DEFECTDOJO_ENGAGEMENT_ID}" | tr -d '\r\n ')
DEFECTDOJO_PRODUCT_ID=$(echo "${DEFECTDOJO_PRODUCT_ID}" | tr -d '\r\n ')

# ── Normalize URLs ───────────────────────────────────────────────────────────
if [[ ! "${SONAR_HOST_URL}" =~ ^https?:// ]]; then
  log "Normalizing SONAR_HOST_URL to include http://"
  SONAR_HOST_URL="http://${SONAR_HOST_URL}"
fi

if [[ ! "${DEFECTDOJO_URL}" =~ ^https?:// ]]; then
  log "Normalizing DEFECTDOJO_URL to include http://"
  DEFECTDOJO_URL="http://${DEFECTDOJO_URL}"
fi

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

# ── Check DefectDojo ─────────────────────────────────────────────────────────
log "Checking DefectDojo at ${DEFECTDOJO_URL} ..."
DOJO_OK=false
for attempt in 1 2 3; do
  DOJO_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
    --connect-timeout 15 --max-time 20 \
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

# ── Check SonarQube (soft) ───────────────────────────────────────────────────
log "Checking SonarQube at ${SONAR_HOST_URL} ..."
SONAR_REACHABLE=false
for attempt in 1 2 3; do
  SONAR_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
    --connect-timeout 15 --max-time 20 \
    "${SONAR_HOST_URL}" 2>/dev/null || echo "000")
  if [ "${SONAR_HTTP}" != "000" ]; then
    ok "SonarQube reachable (HTTP ${SONAR_HTTP})"
    SONAR_REACHABLE=true
    break
  fi
  warn "SonarQube attempt ${attempt}/3 — retrying in 15s..."
  sleep 15
done
[ "${SONAR_REACHABLE}" = "false" ] && \
  warn "SonarQube not reachable — SAST skipped"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — SonarQube Project Setup & SAST
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
  
  SONAR_PROJECT_KEY=$(echo "${PROJECT_NAME}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._:-]/-/g')
  ok "Derived SonarQube project name: ${PROJECT_NAME}, key: ${SONAR_PROJECT_KEY}"

  # --- Skip Project Creation if Token lacks Admin rights (Graceful 401/403) ---
  log "Checking if project '${SONAR_PROJECT_KEY}' exists in SonarQube..."
  # Use curl with || true to prevent script from exiting on 401
  PROJECT_SEARCH_RESP=$(curl -s -u "${SONAR_TOKEN}:" \
    "${SONAR_HOST_URL}/api/projects/search?projects=${SONAR_PROJECT_KEY}" || echo "REACH_ERROR")
  
  PROJECT_EXISTS=$(echo "${PROJECT_SEARCH_RESP}" | grep -q "\"key\":\"${SONAR_PROJECT_KEY}\"" && echo "true" || echo "false")

  if [ "${PROJECT_EXISTS}" = "false" ] && [ "${PROJECT_SEARCH_RESP}" != "REACH_ERROR" ]; then
    log "Project not found. Auto-creating '${SONAR_PROJECT_KEY}'..."
    CREATE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      -u "${SONAR_TOKEN}:" -X POST \
      "${SONAR_HOST_URL}/api/projects/create" \
      -d "name=${PROJECT_NAME}" \
      -d "project=${SONAR_PROJECT_KEY}" || echo "000")
    
    if [ "${CREATE_STATUS}" = "200" ] || [ "${CREATE_STATUS}" = "201" ]; then
      ok "Project created successfully (HTTP ${CREATE_STATUS})"
    else
      warn "Could not create project (HTTP ${CREATE_STATUS}) — likely missing Admin permissions. Proceeding with scan anyway..."
    fi
  else
    ok "Project '${SONAR_PROJECT_KEY}' existence confirmed or search skipped"
  fi

  SONAR_OK=false

  log "Running SonarScanner via NPX to avoid Docker pulls..."
  npx --yes sonar-scanner \
    -Dsonar.projectKey="${SONAR_PROJECT_KEY}" \
    -Dsonar.projectName="${PROJECT_NAME}" \
    -Dsonar.host.url="${SONAR_HOST_URL}" \
    -Dsonar.token="${SONAR_TOKEN}" \
    -Dsonar.sources=. \
    -Dsonar.exclusions="**/node_modules/**,**/dist/**,**/build/**,**/coverage/**,**/tests/**,**/seeds/**,**/scripts/**,**/.git/**" \
    -Dsonar.sourceEncoding=UTF-8 \
    2>&1 && SONAR_OK=true || SONAR_OK=false

  if [ "${SONAR_OK}" = "true" ]; then
    log "Waiting 30s for SonarQube to process analysis..."
    sleep 30

    log "Polling SonarQube background task..."
    for i in $(seq 1 12); do
      RAW_RESP=$(curl -s -u "${SONAR_TOKEN}:" \
        "${SONAR_HOST_URL}/api/ce/component?component=${SONAR_PROJECT_KEY}")
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
      QG_RESP=$(curl -s -u "${SONAR_TOKEN}:" \
        "${SONAR_HOST_URL}/api/qualitygates/project_status?projectKey=${SONAR_PROJECT_KEY}")
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

    # Fetch issues in DefectDojo-compatible format
    # DefectDojo expects SonarQube API JSON format with issues array
    curl -s \
      -u "${SONAR_TOKEN}:" \
      "${SONAR_HOST_URL}/api/issues/search?componentKeys=${SONAR_PROJECT_KEY}&resolved=false&ps=500&facets=severities,types" \
      -o "${REPORTS_DIR}/sonarqube-report.json"
    SIZE=$(wc -c < "${REPORTS_DIR}/sonarqube-report.json" 2>/dev/null || echo 0)

    if [ "${SIZE}" -gt 100 ]; then
      # Validate JSON structure
      if command -v jq &>/dev/null; then
        ISSUE_COUNT=$(jq -r '.issues | length' "${REPORTS_DIR}/sonarqube-report.json" 2>/dev/null || echo "0")
        ok "SonarQube report saved (${SIZE} bytes, ${ISSUE_COUNT} issues)"
      else
        ok "SonarQube report saved (${SIZE} bytes)"
      fi
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
  warn "Skipping SonarQube — not reachable"
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — Unit Testing
# ─────────────────────────────────────────────────────────────────────────────
log "-------------------------------------------------------"
log "STEP 2: Unit Testing"
log "-------------------------------------------------------"
cd "${APP_DIR}"
log "Installing dependencies..."
npm ci --silent > /dev/null 2>&1 || npm install --no-audit --no-fund --silent > /dev/null 2>&1 || true

if npm test; then
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
npm start > /dev/null 2>&1 &
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
    if npm run test:newman; then
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
# STEP 5 — Import to DefectDojo
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
  local FILE_SIZE
  FILE_SIZE=$(wc -c < "${FILE}" 2>/dev/null || echo 0)
  if [ "${FILE_SIZE}" -lt 50 ]; then
    warn "Skipping ${LABEL} — file too small (${FILE_SIZE} bytes), likely empty"
    return 1
  fi
  log "Importing ${LABEL} (${FILE_SIZE} bytes, scan_type='${SCAN_TYPE}')..."
  local RESPONSE HTTP_CODE BODY
  RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Authorization: Token ${DEFECTDOJO_API_KEY}" \
    -F "scan_date=${RUN_DATE}" \
    -F "scan_type=${SCAN_TYPE}" \
    -F "engagement=${DEFECTDOJO_ENGAGEMENT_ID}" \
    -F "product_id=${DEFECTDOJO_PRODUCT_ID}" \
    -F "environment=Development" \
    -F "file=@${FILE}" \
    -F "close_old_findings=true" \
    -F "active=true" \
    -F "verified=false" \
    -F "minimum_severity=Low" \
    -F "tags=git-sha:${GIT_SHA:0:8},branch:${GIT_BRANCH},date:${RUN_DATE}" \
    "${DEFECTDOJO_URL}/api/v2/import-scan/")
  HTTP_CODE=$(echo "${RESPONSE}" | tail -1)
  BODY=$(echo "${RESPONSE}" | head -n -1)
  if [ "${HTTP_CODE}" = "201" ]; then
    ok "${LABEL} imported successfully (HTTP 201)"
    IMPORT_COUNT=$((IMPORT_COUNT + 1))
    return 0
  else
    warn "${LABEL} import failed (HTTP ${HTTP_CODE})"
    warn "Response: ${BODY}"
    # Log the first 200 chars of the file for debugging
    warn "File preview: $(head -c 200 "${FILE}" 2>/dev/null || echo 'unreadable')"
    return 1
  fi
}

# ── Verify engagement exists and is active before importing ──────────────────
log "Verifying engagement ${DEFECTDOJO_ENGAGEMENT_ID} in DefectDojo..."
ENG_RESP=$(curl -s -w "\n%{http_code}" \
  -H "Authorization: Token ${DEFECTDOJO_API_KEY}" \
  "${DEFECTDOJO_URL}/api/v2/engagements/${DEFECTDOJO_ENGAGEMENT_ID}/")
ENG_CODE=$(echo "${ENG_RESP}" | tail -1)
ENG_BODY=$(echo "${ENG_RESP}" | head -n -1)

if [ "${ENG_CODE}" = "200" ]; then
  ENG_STATUS=$(echo "${ENG_BODY}" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "unknown")
  ENG_PRODUCT=$(echo "${ENG_BODY}" | grep -o '"product":[0-9]*' | head -1 | cut -d':' -f2 || echo "unknown")
  ok "Engagement found (status: ${ENG_STATUS}, product_id: ${ENG_PRODUCT})"
  log "DEBUG — DEFECTDOJO_PRODUCT_ID secret value: ${DEFECTDOJO_PRODUCT_ID}"
  log "DEBUG — DEFECTDOJO_ENGAGEMENT_ID secret value: ${DEFECTDOJO_ENGAGEMENT_ID}"
  if [ "${ENG_STATUS}" != "In Progress" ]; then
    log "Patching engagement to 'In Progress'..."
    curl -s -o /dev/null -X PATCH \
      -H "Authorization: Token ${DEFECTDOJO_API_KEY}" \
      -H "Content-Type: application/json" \
      -d '{"status":"In Progress"}' \
      "${DEFECTDOJO_URL}/api/v2/engagements/${DEFECTDOJO_ENGAGEMENT_ID}/" || true
  fi
  # Warn if product_id in secret doesn't match the engagement's actual product
  if [ "${ENG_PRODUCT}" != "${DEFECTDOJO_PRODUCT_ID}" ] && [ "${ENG_PRODUCT}" != "unknown" ]; then
    warn "MISMATCH: engagement belongs to product ${ENG_PRODUCT} but DEFECTDOJO_PRODUCT_ID=${DEFECTDOJO_PRODUCT_ID}"
    warn "Overriding product_id to match engagement..."
    DEFECTDOJO_PRODUCT_ID="${ENG_PRODUCT}"
  fi
else
  warn "Could not verify engagement (HTTP ${ENG_CODE}) — attempting import anyway"
fi

# ── Test with minimal ZAP import first to isolate the 500 ────────────────────
log "DEBUG — Testing DefectDojo import endpoint with minimal ZAP payload..."
MINI_RESP=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "Authorization: Token ${DEFECTDOJO_API_KEY}" \
  -F "scan_date=${RUN_DATE}" \
  -F "scan_type=ZAP Scan" \
  -F "engagement=${DEFECTDOJO_ENGAGEMENT_ID}" \
  -F "environment=Development" \
  -F "file=@${REPORTS_DIR}/zap-report.xml" \
  -F "active=true" \
  -F "verified=false" \
  "${DEFECTDOJO_URL}/api/v2/import-scan/")
MINI_CODE=$(echo "${MINI_RESP}" | tail -1)
MINI_BODY=$(echo "${MINI_RESP}" | head -n -1)
log "DEBUG — Minimal ZAP import response (HTTP ${MINI_CODE}): ${MINI_BODY}"

do_import \
  "${REPORTS_DIR}/sonarqube-report.json" \
  "SonarQube API Import" \
  "SonarQube" || true

do_import \
  "${REPORTS_DIR}/zap-report.xml" \
  "ZAP Scan" \
  "OWASP ZAP" || true

if [ "${IMPORT_COUNT}" -eq 0 ]; then
  warn "DefectDojo import failed — pipeline will continue and bundle raw reports"
  warn "Check:"
  warn "  1. DEFECTDOJO_API_KEY — must be the key value only (no 'Token ' prefix)"
  warn "  2. DEFECTDOJO_ENGAGEMENT_ID — must be a valid numeric ID"
  warn "  3. DEFECTDOJO_URL — e.g. http://your-host:8080"
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
  HTTP=$(curl -s \
    -o "${REPORTS_DIR}/final-report.json" \
    -w "%{http_code}" \
    -H "Authorization: Token ${DEFECTDOJO_API_KEY}" \
    "${DEFECTDOJO_URL}/api/v2/findings/?engagement=${DEFECTDOJO_ENGAGEMENT_ID}&limit=500")
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
    warn "DefectDojo report fetch failed (HTTP ${HTTP}, ${SIZE} bytes) — falling back to raw bundle"
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
