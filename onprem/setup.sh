#!/bin/bash
# ==============================================================================
# On-Premises DevSecOps Stack — Bootstrap
# ==============================================================================
# Local-machine translation of the GCP VM startup-script in terraform/main.tf.
# Run it directly on an Ubuntu 24.04 office machine with sudo:
#
#   sudo bash onprem/gen-env.sh     # once: creates onprem/.env
#   sudo bash onprem/firewall.sh
#   sudo bash onprem/setup.sh
#
# Idempotent: every step is guarded so re-running does not duplicate work. It
# installs Docker, tunes the kernel, brings up SonarQube + DefectDojo + the
# credential broker, bootstraps the SonarQube quality gate, installs Wazuh
# (single-node), and loads the custom VAPT rules/decoders.
# ------------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=SCRIPTDIR/common.sh
source "${SCRIPT_DIR}/common.sh"

require_root setup.sh
load_env

# ------------------------------------------------------------------------------
# 0. Validate onprem/.env before touching the system
# ------------------------------------------------------------------------------
# Characters that break `source`, Docker env_file parsing or compose interpolation.
has_unsafe_chars() {
  case "$1" in
    *[[:space:]\'\"\$\`\\#]*) return 0 ;;
    *) return 1 ;;
  esac
}

require_value() {
  local name="$1" value="${!1:-}"
  [ -n "$value" ] || die "${name} is not set in ${ENV_FILE}."
  case "$value" in *CHANGE_ME*) die "${name} still has the placeholder value in ${ENV_FILE}." ;; esac
  if has_unsafe_chars "$value"; then
    die "${name} contains a space, quote, \$, backtick, backslash or #. Use a value without them."
  fi
}

for var in SONARQUBE_ADMIN_PASSWORD DD_DATABASE_PASSWORD DD_SECRET_KEY \
           DD_CREDENTIAL_AES_256_KEY DD_ADMIN_USER DD_ADMIN_PASSWORD SONAR_PUBLIC_URL; do
  require_value "$var"
done

# SonarQube's password policy; it rejects anything weaker.
SONAR_PW="${SONARQUBE_ADMIN_PASSWORD}"
if [ "${#SONAR_PW}" -lt 12 ] || ! [[ "$SONAR_PW" =~ [A-Z] ]] || ! [[ "$SONAR_PW" =~ [a-z] ]] \
   || ! [[ "$SONAR_PW" =~ [0-9] ]] || ! [[ "$SONAR_PW" =~ [^A-Za-z0-9] ]]; then
  die "SONARQUBE_ADMIN_PASSWORD must be 12+ characters with upper case, lower case, a digit and a special character."
fi
[ "$SONAR_PW" != "admin" ] || die "SONARQUBE_ADMIN_PASSWORD must not be 'admin'."

# The DB password is embedded in a postgresql:// URL.
[[ "${DD_DATABASE_PASSWORD}" =~ ^[A-Za-z0-9._~-]+$ ]] \
  || die "DD_DATABASE_PASSWORD may only contain letters, digits and . _ ~ - (use: openssl rand -hex 32)."
[[ "${SONAR_PUBLIC_URL}" =~ ^https?://[^/]+ ]] || die "SONAR_PUBLIC_URL must look like http://<server-ip>:9000"

echo "Starting On-Premises DevOps Server Setup..."

# Track optional components for the final summary.
SUMMARY_WARNINGS=()

# ------------------------------------------------------------------------------
# 1. Prerequisites + keep the machine awake
# ------------------------------------------------------------------------------
apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release git openssl iptables

# A server that suspends when idle takes every service down for the office.
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null

# ------------------------------------------------------------------------------
# 2. Kernel settings for Elasticsearch (SonarQube) / OpenSearch (Wazuh)
# ------------------------------------------------------------------------------
# Only RAISE limits; never lower a value the OS already set higher
# (Ubuntu 24.04 ships vm.max_map_count=1048576 and a huge fs.file-max).
SYSCTL_FILE=/etc/sysctl.d/99-devsecops.conf
: > "${SYSCTL_FILE}.tmp"
raise_sysctl() {
  local key="$1" min="$2" cur
  cur="$(sysctl -n "$key")"
  if [ "$cur" -lt "$min" ]; then
    sysctl -w "${key}=${min}"
    echo "${key}=${min}" >> "${SYSCTL_FILE}.tmp"
  else
    echo "${key} is already ${cur} (>= ${min}), leaving it."
  fi
}
raise_sysctl vm.max_map_count 262144
raise_sysctl fs.file-max 65536
sysctl -w vm.swappiness=10
echo "vm.swappiness=10" >> "${SYSCTL_FILE}.tmp"
mv "${SYSCTL_FILE}.tmp" "${SYSCTL_FILE}"

# ------------------------------------------------------------------------------
# 3. Swap (8G) — only if the machine has no swap at all
# ------------------------------------------------------------------------------
if [ -n "$(swapon --show --noheadings)" ]; then
  echo "Swap already active, skipping swapfile creation."
elif [ ! -f /swapfile ]; then
  fallocate -l 8G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -qF '/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ------------------------------------------------------------------------------
# 4. Docker CE + compose plugin (skip if already installed)
# ------------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker CE..."
  install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor --batch --yes -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
  fi
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "Docker already installed, skipping."
fi
systemctl enable --now docker

# ------------------------------------------------------------------------------
# 4.1 LAN restriction for Docker-published ports, persisted across reboots
# ------------------------------------------------------------------------------
UNIT_FILE=/etc/systemd/system/devsecops-docker-user.service
cat > "${UNIT_FILE}" <<EOF
[Unit]
Description=DevSecOps: restrict Docker-published ports to the office LAN
After=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash ${SCRIPT_DIR}/docker-user-rules.sh

[Install]
WantedBy=docker.service
EOF
systemctl daemon-reload
systemctl enable devsecops-docker-user.service >/dev/null
systemctl restart devsecops-docker-user.service

# ------------------------------------------------------------------------------
# 5. SonarQube via Docker Compose
# ------------------------------------------------------------------------------
docker network inspect devsecops-net >/dev/null 2>&1 || docker network create devsecops-net

echo "Bringing up SonarQube..."
docker compose -f "${SCRIPT_DIR}/docker-compose.yml" up -d sonarqube

# ------------------------------------------------------------------------------
# 5.1 SonarQube API bootstrap (idempotent, fails loudly)
# ------------------------------------------------------------------------------
SONAR_URL="http://localhost:9000"

# sonar_api METHOD PATH USER:PASS [curl args...]
# Sets SONAR_BODY; returns 0 on HTTP 2xx. Parameters are passed with
# --data-urlencode so passwords with special characters are encoded.
SONAR_BODY=""
sonar_api() {
  local method="$1" path="$2" auth="$3" resp code
  shift 3
  if ! resp="$(curl -sS -X "$method" -u "$auth" -w $'\n%{http_code}' "$@" "${SONAR_URL}${path}")"; then
    SONAR_BODY="(connection to ${SONAR_URL} failed)"
    return 1
  fi
  code="${resp##*$'\n'}"
  SONAR_BODY="${resp%$'\n'*}"
  [[ "$code" == 2* ]]
}

echo "Waiting for SonarQube to come online (first start can take several minutes)..."
SONAR_STATUS=""
for _ in $(seq 1 90); do
  SONAR_STATUS="$(curl -s "${SONAR_URL}/api/system/status" | grep -o '"status":"[A-Z_]*"' || true)"
  [ "$SONAR_STATUS" = '"status":"UP"' ] && break
  sleep 10
done
[ "$SONAR_STATUS" = '"status":"UP"' ] \
  || die "SonarQube did not reach UP within 15 minutes (last: ${SONAR_STATUS:-no answer}). Check: docker logs sonarqube"
echo "SonarQube is UP. Bootstrapping configuration..."

# Change the default admin password if admin:admin still works.
if sonar_api GET /api/authentication/validate admin:admin && [[ "$SONAR_BODY" == *'"valid":true'* ]]; then
  echo "Changing default admin password..."
  sonar_api POST /api/users/change_password admin:admin \
    --data-urlencode "login=admin" \
    --data-urlencode "previousPassword=admin" \
    --data-urlencode "password=${SONARQUBE_ADMIN_PASSWORD}" \
    || die "SonarQube rejected the new admin password: ${SONAR_BODY}"
else
  echo "Default admin password already changed."
fi

SONAR_AUTH="admin:${SONARQUBE_ADMIN_PASSWORD}"
if ! sonar_api GET /api/authentication/validate "$SONAR_AUTH" || [[ "$SONAR_BODY" != *'"valid":true'* ]]; then
  die "SONARQUBE_ADMIN_PASSWORD in ${ENV_FILE} does not match the SonarQube admin password. Fix .env (or reset the admin password in SonarQube) and re-run."
fi

GATE="DevSecOps_Gate"
if ! sonar_api GET /api/qualitygates/show "$SONAR_AUTH" -G --data-urlencode "name=${GATE}"; then
  echo "Creating ${GATE} quality gate..."
  sonar_api POST /api/qualitygates/create "$SONAR_AUTH" --data-urlencode "name=${GATE}" \
    || die "could not create quality gate ${GATE}: ${SONAR_BODY}"
  sonar_api GET /api/qualitygates/show "$SONAR_AUTH" -G --data-urlencode "name=${GATE}" \
    || die "could not read quality gate ${GATE}: ${SONAR_BODY}"
fi
GATE_JSON="$SONAR_BODY"

# Adds a condition unless the gate already has one on that metric, so re-runs
# fill in anything that failed before.
GATE_FAILED=0
add_condition() {
  local metric="$1" op="$2" error="$3"
  if [[ "$GATE_JSON" == *"\"metric\":\"${metric}\""* ]]; then
    return 0
  fi
  if sonar_api POST /api/qualitygates/create_condition "$SONAR_AUTH" \
       --data-urlencode "gateName=${GATE}" --data-urlencode "metric=${metric}" \
       --data-urlencode "op=${op}" --data-urlencode "error=${error}"; then
    echo "  + condition ${metric} ${op} ${error}"
  else
    warn "SonarQube refused condition ${metric} ${op} ${error}: ${SONAR_BODY}"
    GATE_FAILED=$((GATE_FAILED + 1))
  fi
}

# Conditions on New Code
add_condition new_security_hotspots_reviewed LT 100
add_condition new_coverage LT 80
add_condition new_duplicated_lines_density GT 2.0
add_condition new_maintainability_rating GT 1
add_condition new_reliability_rating GT 1
add_condition new_security_rating GT 1
# Conditions on Overall Code
add_condition duplicated_lines_density GT 2.0
add_condition sqale_rating GT 1
add_condition reliability_rating GT 1
add_condition security_hotspots_reviewed LT 100
add_condition security_rating GT 1

sonar_api POST /api/qualitygates/set_as_default "$SONAR_AUTH" --data-urlencode "name=${GATE}" \
  || die "could not set ${GATE} as the default quality gate: ${SONAR_BODY}"

if [ "$GATE_FAILED" -gt 0 ]; then
  SUMMARY_WARNINGS+=("SonarQube: ${GATE_FAILED} quality-gate condition(s) were refused (see warnings above).")
fi
echo "SonarQube bootstrap complete (${GATE} is the default gate)."

# ------------------------------------------------------------------------------
# 6. DefectDojo via its official Docker Compose
# ------------------------------------------------------------------------------
# Same approach as the GCP startup-script: clone the official repo and run its
# own compose. onprem/defectdojo.override.yml adds the admin password and the
# devsecops-net alias. Secrets are written to django-DefectDojo/.env, which
# compose reads automatically, so later manual `docker compose` commands in that
# directory use the same values.
DD_DIR="${SCRIPT_DIR}/django-DefectDojo"

if [ ! -d "${DD_DIR}/.git" ]; then
  git clone --depth 1 https://github.com/DefectDojo/django-DefectDojo "${DD_DIR}"
fi

(
  umask 077
  cat > "${DD_DIR}/.env" <<EOF
# Generated by onprem/setup.sh from onprem/.env — edit that file instead.
COMPOSE_FILE=docker-compose.yml:${SCRIPT_DIR}/defectdojo.override.yml
DD_DATABASE_PASSWORD=${DD_DATABASE_PASSWORD}
DD_DATABASE_URL=postgresql://defectdojo:${DD_DATABASE_PASSWORD}@postgres:5432/defectdojo
DD_SECRET_KEY=${DD_SECRET_KEY}
DD_CREDENTIAL_AES_256_KEY=${DD_CREDENTIAL_AES_256_KEY}
DD_ADMIN_USER=${DD_ADMIN_USER}
DD_ADMIN_PASSWORD=${DD_ADMIN_PASSWORD}
EOF
)

echo "Bringing up DefectDojo..."
( cd "${DD_DIR}" && docker compose up -d )

echo "Waiting for DefectDojo (first start runs database migrations, can take 5-10 minutes)..."
DD_READY=false
for _ in $(seq 1 90); do
  DD_CODE="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/login || true)"
  if [ "$DD_CODE" = "200" ] || [ "$DD_CODE" = "302" ]; then
    DD_READY=true
    break
  fi
  sleep 10
done
if [ "$DD_READY" = "true" ]; then
  echo "DefectDojo is up."
else
  warn "DefectDojo did not answer within 15 minutes. Last initializer logs:"
  ( cd "${DD_DIR}" && docker compose logs --tail 30 initializer ) >&2 || true
  SUMMARY_WARNINGS+=("DefectDojo: not answering yet. Check: cd ${DD_DIR} && docker compose logs initializer uwsgi")
fi

# ------------------------------------------------------------------------------
# 6.1 Credential broker (started after the SonarQube bootstrap)
# ------------------------------------------------------------------------------
echo "Building and starting the credential broker..."
docker compose -f "${SCRIPT_DIR}/docker-compose.yml" --profile broker up -d --build broker

echo "Waiting for the broker on http://localhost:8900/healthz ..."
BROKER_BODY=""
for _ in $(seq 1 60); do
  BROKER_BODY="$(curl -s --max-time 5 http://localhost:8900/healthz || true)"
  [ -n "${BROKER_BODY}" ] && break
  sleep 5
done
if [ -n "${BROKER_BODY}" ]; then
  echo "Broker health: ${BROKER_BODY}"
  [[ "$BROKER_BODY" == *'"status":"ok"'* ]] \
    || SUMMARY_WARNINGS+=("Broker: degraded (${BROKER_BODY}). Check: docker logs cs-devtest-broker")
else
  SUMMARY_WARNINGS+=("Broker: not answering. Check: docker logs cs-devtest-broker")
fi

# ------------------------------------------------------------------------------
# 7. Wazuh (single-node, 4.9) — guarded by the installed package
# ------------------------------------------------------------------------------
if dpkg -s wazuh-manager >/dev/null 2>&1; then
  echo "Wazuh already installed, skipping."
else
  echo "Starting Wazuh automated installation (takes 10-20 minutes)..."
  # The installer generates wazuh-install-files.tar itself (with -a it deletes
  # any existing one), so only the script is downloaded.
  if ( cd /root && curl -fsSO https://packages.wazuh.com/4.9/wazuh-install.sh && bash wazuh-install.sh -a ); then
    if tar -xf /root/wazuh-install-files.tar -C /root wazuh-install-files/wazuh-passwords.txt; then
      install -m 600 /root/wazuh-install-files/wazuh-passwords.txt /root/wazuh-passwords.txt
    else
      SUMMARY_WARNINGS+=("Wazuh: could not extract wazuh-passwords.txt from /root/wazuh-install-files.tar")
    fi

    echo "Exposing Wazuh Indexer to the LAN (ufw limits 9200 to LAN_CIDRS)..."
    if sed -i 's/network.host: "127.0.0.1"/network.host: "0.0.0.0"/g' /etc/wazuh-indexer/opensearch.yml \
       && systemctl restart wazuh-indexer; then
      echo "Wazuh setup complete."
    else
      SUMMARY_WARNINGS+=("Wazuh: indexer failed to restart after binding to 0.0.0.0. Check: journalctl -u wazuh-indexer")
    fi
  else
    SUMMARY_WARNINGS+=("Wazuh: installer failed (see output above). Remove the partial install with 'sudo bash /root/wazuh-install.sh -u' and re-run setup.sh.")
  fi
fi

# ------------------------------------------------------------------------------
# 7.1 Load custom Wazuh VAPT rules/decoders
# ------------------------------------------------------------------------------
if [ -d /var/ossec/etc ]; then
  echo "Loading custom VAPT decoders/rules into Wazuh..."
  cp "${SCRIPT_DIR}/wazuh-config/decoders.xml" /var/ossec/etc/decoders/vapt-decoders.xml
  cp "${SCRIPT_DIR}/wazuh-config/rules.xml" /var/ossec/etc/rules/vapt-rules.xml
  chown root:wazuh /var/ossec/etc/decoders/vapt-decoders.xml /var/ossec/etc/rules/vapt-rules.xml 2>/dev/null || true
  systemctl restart wazuh-manager \
    || SUMMARY_WARNINGS+=("Wazuh: manager failed to restart after loading VAPT rules. Check: sudo /var/ossec/bin/wazuh-logtest -t")
fi

# ------------------------------------------------------------------------------
# 8. Final summary
# ------------------------------------------------------------------------------
LAN_IP="$(ip -4 route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}')"
LAN_IP="${LAN_IP:-localhost}"

echo ""
echo "=============================================================="
echo " On-Premises DevSecOps stack"
echo "=============================================================="
echo " SonarQube   : http://${LAN_IP}:9000   (user: admin)"
echo " DefectDojo  : http://${LAN_IP}:8080   (user: ${DD_ADMIN_USER})"
echo " Broker      : http://${LAN_IP}:8900   (developers: CS_DEVTEST_BROKER_URL)"
echo " Wazuh       : https://${LAN_IP}       (user: admin)"
echo "--------------------------------------------------------------"
echo " SonarQube / DefectDojo admin passwords: sudo cat ${ENV_FILE}"
echo " Wazuh passwords                       : sudo cat /root/wazuh-passwords.txt"
echo "=============================================================="
if [ "${#SUMMARY_WARNINGS[@]}" -gt 0 ]; then
  echo ""
  echo "Finished with warnings:"
  for w in "${SUMMARY_WARNINGS[@]}"; do echo "  - ${w}"; done
  exit 2
fi
