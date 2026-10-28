#!/bin/bash
# ==============================================================================
# On-Premises DevSecOps Stack — Bootstrap
# ==============================================================================
# Local-machine translation of the GCP VM startup-script in terraform/main.tf.
# Run it directly on an Ubuntu 24.04 office machine with sudo:
#
#   sudo bash onprem/setup.sh
#
# It is idempotent: every step is guarded so re-running does not duplicate work
# or error out. It installs Docker, tunes the kernel for Elasticsearch/SonarQube,
# creates swap, brings up SonarQube + DefectDojo, bootstraps the SonarQube quality
# gate, installs Wazuh (single-node), and loads the custom VAPT rules/decoders.
# ------------------------------------------------------------------------------
set -euo pipefail

# ------------------------------------------------------------------------------
# 0. Preconditions
# ------------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: this script must be run as root. Re-run with: sudo bash onprem/setup.sh" >&2
  exit 1
fi

# Load secrets from onprem/.env (copied from .env.example by the user).
ENV_FILE="${SCRIPT_DIR}/.env"
if [ ! -f "${ENV_FILE}" ]; then
  echo "ERROR: ${ENV_FILE} not found." >&2
  echo "Copy the example and fill it in first:" >&2
  echo "    cp onprem/.env.example onprem/.env" >&2
  echo "Then edit onprem/.env and re-run this script." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

# SonarQube admin password: REQUIRED. The broker derives its admin token from
# this value, so there is no safe default — fail fast if it is unset/empty.
if [ -z "${SONARQUBE_ADMIN_PASSWORD:-}" ]; then
  echo "ERROR: SONARQUBE_ADMIN_PASSWORD is not set." >&2
  echo "Set it in ${ENV_FILE} (copied from onprem/.env.example) and re-run." >&2
  exit 1
fi

echo "Starting On-Premises DevOps Server Setup..."

# ------------------------------------------------------------------------------
# 1. Update and install prerequisites
# ------------------------------------------------------------------------------
apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release git

# ------------------------------------------------------------------------------
# 2. OS prerequisites for Elasticsearch (used by SonarQube)
# ------------------------------------------------------------------------------
sysctl -w vm.max_map_count=262144
sysctl -w fs.file-max=65536
grep -qxF 'vm.max_map_count=262144' /etc/sysctl.conf || echo 'vm.max_map_count=262144' >> /etc/sysctl.conf
grep -qxF 'fs.file-max=65536' /etc/sysctl.conf || echo 'fs.file-max=65536' >> /etc/sysctl.conf

# ------------------------------------------------------------------------------
# 3. Swap space setup (8G, only if not already present)
# ------------------------------------------------------------------------------
if [ ! -f /swapfile ]; then
  fallocate -l 8G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

grep -qxF 'vm.swappiness=10' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
sysctl -w vm.swappiness=10

# ------------------------------------------------------------------------------
# 4. Install Docker CE + compose plugin (skip if already installed)
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

# ------------------------------------------------------------------------------
# 4.1 LAN restriction for Docker-published ports (DOCKER-USER chain)
# ------------------------------------------------------------------------------
# ufw's INPUT chain does NOT filter Docker-published ports: Docker inserts its
# own rules in the DOCKER/DOCKER-USER chains, evaluated before and independently
# of INPUT. So the broker (8900), SonarQube (9000) and DefectDojo (8080) must be
# LAN-restricted HERE, in DOCKER-USER — which only exists once Docker is
# installed (hence this lives in setup.sh, not firewall.sh).
#
# LAN_CIDRS MUST match onprem/firewall.sh (the single source of truth). Keep the
# two in sync if you change your office subnet.
LAN_CIDRS=("192.168.0.0/16" "10.0.0.0/8")
# Optional IPv6 office CIDRs — leave empty if IPv6 is not used on your LAN.
LAN_CIDRS6=()
BROKER_PORTS=(8900 9000 8080)
DOCKER_USER_TAG="cs-devtest-broker"
BRIDGE_CIDR="172.16.0.0/12"    # Docker bridge range: devsecops-net + default bridge
BRIDGE_CIDR6="fc00::/7"        # ULA range Docker assigns to IPv6-enabled bridges

# Insert, per port: DROP first (lands at the BOTTOM because -I prepends), then a
# RETURN for the Docker bridge range, then one RETURN per LAN CIDR — so the
# evaluation order ends up: RETURN(bridge), RETURN(cidr...), DROP. The bridge
# RETURN is load-bearing: without it the DROP would also sever the broker's OWN
# container-origin calls to sonarqube:9000 and host.docker.internal:8080. Every
# rule is comment-tagged so re-runs delete-by-match before re-inserting.
apply_docker_user_rules() {
  local ipt="$1"; local bridge="$2"; shift 2
  local lan_cidrs=("$@")

  "$ipt" -nL DOCKER-USER >/dev/null 2>&1 || "$ipt" -N DOCKER-USER

  for port in "${BROKER_PORTS[@]}"; do
    # (a) Idempotency — remove our own prior rules by comment match.
    while "$ipt" -D DOCKER-USER -p tcp --dport "$port" -m comment --comment "$DOCKER_USER_TAG" -j DROP 2>/dev/null; do :; done
    while "$ipt" -D DOCKER-USER -p tcp --dport "$port" -s "$bridge" -m comment --comment "$DOCKER_USER_TAG" -j RETURN 2>/dev/null; do :; done
    for cidr in "${lan_cidrs[@]}"; do
      while "$ipt" -D DOCKER-USER -p tcp --dport "$port" -s "$cidr" -m comment --comment "$DOCKER_USER_TAG" -j RETURN 2>/dev/null; do :; done
    done

    # (b) Re-insert in the order described above.
    "$ipt" -I DOCKER-USER -p tcp --dport "$port" -m comment --comment "$DOCKER_USER_TAG" -j DROP
    "$ipt" -I DOCKER-USER -p tcp --dport "$port" -s "$bridge" -m comment --comment "$DOCKER_USER_TAG" -j RETURN
    for cidr in "${lan_cidrs[@]}"; do
      "$ipt" -I DOCKER-USER -p tcp --dport "$port" -s "$cidr" -m comment --comment "$DOCKER_USER_TAG" -j RETURN
    done
  done
}

if command -v iptables >/dev/null 2>&1; then
  echo "Applying DOCKER-USER LAN restriction for ports ${BROKER_PORTS[*]}..."
  apply_docker_user_rules iptables "$BRIDGE_CIDR" "${LAN_CIDRS[@]}"
  if command -v ip6tables >/dev/null 2>&1 && [ "${#LAN_CIDRS6[@]}" -gt 0 ]; then
    echo "Applying DOCKER-USER IPv6 LAN restriction..."
    apply_docker_user_rules ip6tables "$BRIDGE_CIDR6" "${LAN_CIDRS6[@]}"
  fi
else
  echo "WARNING: iptables not found — skipping DOCKER-USER LAN restriction." >&2
fi

# ------------------------------------------------------------------------------
# 5. SonarQube via Docker Compose
# ------------------------------------------------------------------------------
docker network create devsecops-net || true

echo "Bringing up SonarQube..."
docker compose -f "${SCRIPT_DIR}/docker-compose.yml" up -d

# ------------------------------------------------------------------------------
# 5.1 SonarQube API bootstrap (idempotent)
# ------------------------------------------------------------------------------
SONAR_URL="http://localhost:9000"

echo "Waiting for SonarQube to come online..."
until curl -s "${SONAR_URL}/api/system/status" | grep -q '"status":"UP"'; do
  sleep 10
done
echo "SonarQube is UP. Bootstrapping configuration..."

# 1. Change default admin password — only if the default admin:admin still works.
if curl -s -u admin:admin "${SONAR_URL}/api/authentication/validate" | grep -q '"valid":true'; then
  echo "Changing default admin password..."
  curl -s -X POST -u admin:admin \
    "${SONAR_URL}/api/users/change_password?login=admin&previousPassword=admin&password=${SONARQUBE_ADMIN_PASSWORD}" >/dev/null
else
  echo "Admin password already changed, skipping."
fi

SONAR_AUTH="admin:${SONARQUBE_ADMIN_PASSWORD}"

# 2. Create custom quality gate + conditions — only if it does not already exist.
if curl -s -u "${SONAR_AUTH}" "${SONAR_URL}/api/qualitygates/list" | grep -q '"name":"DevSecOps_Gate"'; then
  echo "Quality gate DevSecOps_Gate already exists, skipping creation."
else
  echo "Creating DevSecOps_Gate quality gate..."
  curl -s -X POST -u "${SONAR_AUTH}" "${SONAR_URL}/api/qualitygates/create?name=DevSecOps_Gate" >/dev/null

  # Conditions on New Code
  curl -s -X POST -u "${SONAR_AUTH}" -d "gateName=DevSecOps_Gate&metric=new_security_hotspots_reviewed&op=LT&error=100" "${SONAR_URL}/api/qualitygates/create_condition" >/dev/null
  curl -s -X POST -u "${SONAR_AUTH}" -d "gateName=DevSecOps_Gate&metric=new_coverage&op=LT&error=80" "${SONAR_URL}/api/qualitygates/create_condition" >/dev/null
  curl -s -X POST -u "${SONAR_AUTH}" -d "gateName=DevSecOps_Gate&metric=new_duplicated_lines_density&op=GT&error=2.0" "${SONAR_URL}/api/qualitygates/create_condition" >/dev/null
  curl -s -X POST -u "${SONAR_AUTH}" -d "gateName=DevSecOps_Gate&metric=new_maintainability_rating&op=GT&error=1" "${SONAR_URL}/api/qualitygates/create_condition" >/dev/null
  curl -s -X POST -u "${SONAR_AUTH}" -d "gateName=DevSecOps_Gate&metric=new_reliability_rating&op=GT&error=1" "${SONAR_URL}/api/qualitygates/create_condition" >/dev/null
  curl -s -X POST -u "${SONAR_AUTH}" -d "gateName=DevSecOps_Gate&metric=new_security_rating&op=GT&error=1" "${SONAR_URL}/api/qualitygates/create_condition" >/dev/null

  # Conditions on Overall Code
  curl -s -X POST -u "${SONAR_AUTH}" -d "gateName=DevSecOps_Gate&metric=duplicated_lines_density&op=GT&error=2.0" "${SONAR_URL}/api/qualitygates/create_condition" >/dev/null
  curl -s -X POST -u "${SONAR_AUTH}" -d "gateName=DevSecOps_Gate&metric=sqale_rating&op=GT&error=1" "${SONAR_URL}/api/qualitygates/create_condition" >/dev/null
  curl -s -X POST -u "${SONAR_AUTH}" -d "gateName=DevSecOps_Gate&metric=reliability_rating&op=GT&error=1" "${SONAR_URL}/api/qualitygates/create_condition" >/dev/null
  curl -s -X POST -u "${SONAR_AUTH}" -d "gateName=DevSecOps_Gate&metric=security_hotspots_reviewed&op=LT&error=100" "${SONAR_URL}/api/qualitygates/create_condition" >/dev/null
  curl -s -X POST -u "${SONAR_AUTH}" -d "gateName=DevSecOps_Gate&metric=security_rating&op=GT&error=1" "${SONAR_URL}/api/qualitygates/create_condition" >/dev/null

  # Set as default
  curl -s -X POST -u "${SONAR_AUTH}" -d "name=DevSecOps_Gate" "${SONAR_URL}/api/qualitygates/set_as_default" >/dev/null

  echo "SonarQube bootstrapping complete!"
fi

# ------------------------------------------------------------------------------
# 6. DefectDojo via its official Docker Compose (postgres-redis profile)
# ------------------------------------------------------------------------------
# Mirrors section 6 of the GCP startup-script: clone the official repo and run
# its own compose. We keep everything under onprem/ (non-root /opt avoided) and
# store generated secrets in onprem/defectdojo.env (gitignored).
DD_DIR="${SCRIPT_DIR}/django-DefectDojo"
DD_ENV="${SCRIPT_DIR}/defectdojo.env"

if [ ! -d "${DD_DIR}" ]; then
  git clone https://github.com/DefectDojo/django-DefectDojo "${DD_DIR}"
fi

if [ ! -f "${DD_ENV}" ]; then
  {
    echo "DD_DATABASE_PASSWORD=${DD_DATABASE_PASSWORD:-$(openssl rand -base64 24)}"
    echo "DD_SECRET_KEY=${DD_SECRET_KEY:-$(openssl rand -base64 32)}"
    echo "DD_CREDENTIAL_AES_256_KEY=${DD_CREDENTIAL_AES_256_KEY:-$(openssl rand -base64 32)}"
    # Admin creds the DefectDojo initializer reads — the broker authenticates
    # with these to obtain its API key. Only takes effect on a FRESH init.
    echo "DD_ADMIN_USER=${DD_ADMIN_USER:-admin}"
    echo "DD_ADMIN_PASSWORD=${DD_ADMIN_PASSWORD:-$(openssl rand -base64 24)}"
  } > "${DD_ENV}"
  echo "NOTE: DD_ADMIN_USER/DD_ADMIN_PASSWORD set the DefectDojo admin login on"
  echo "      FIRST initialization only. On an already-initialized DefectDojo you"
  echo "      must either reset the admin password to match onprem/.env, or set"
  echo "      DEFECTDOJO_API_KEY directly in onprem/.env for the broker to use."
fi

set -a
# shellcheck disable=SC1090
source "${DD_ENV}"
set +a

echo "Bringing up DefectDojo..."
( cd "${DD_DIR}" && docker compose --profile postgres-redis up -d )

# ------------------------------------------------------------------------------
# 6.1 Credential broker (started explicitly, after SonarQube bootstrap)
# ------------------------------------------------------------------------------
# The broker is on the `broker` compose profile so the generic section-5
# `up -d` never starts it before the admin password exists. Start it now that
# SonarQube is bootstrapped (5.1) and DefectDojo is up (6).
echo "Building and starting the credential broker..."
docker compose -f "${SCRIPT_DIR}/docker-compose.yml" --profile broker up -d --build broker

# Readiness: wait for the broker to be LISTENING, not for upstreams to be ready.
# Any HTTP response (200 or 503) within the window means the broker is up;
# defectdojo:"down" right after boot is EXPECTED and self-heals (the broker
# re-auths lazily). Only "no HTTP response at all" is an error.
echo "Waiting for the broker to answer on http://localhost:8900/healthz ..."
BROKER_READY=false
for _ in $(seq 1 30); do
  BROKER_BODY="$(curl -s --max-time 5 "http://localhost:8900/healthz" 2>/dev/null || true)"
  if [ -n "${BROKER_BODY}" ]; then
    BROKER_READY=true
    echo "Broker is listening. Health: ${BROKER_BODY}"
    echo "(A 'defectdojo':'down' here right after boot is expected and self-heals.)"
    break
  fi
  sleep 2
done
if [ "${BROKER_READY}" != "true" ]; then
  echo "WARNING: broker did not answer /healthz within the wait window." >&2
  echo "         Check: docker logs cs-devtest-broker" >&2
fi

# ------------------------------------------------------------------------------
# 7. Install Wazuh (single-node, 4.9) — guarded by /root/wazuh-install-files
# ------------------------------------------------------------------------------
if [ ! -d /root/wazuh-install-files ]; then
  echo "Starting Wazuh automated installation..."
  ( cd /root
    curl -sO https://packages.wazuh.com/4.9/wazuh-install.sh
    curl -sO https://packages.wazuh.com/4.9/wazuh-install-files.tar
    bash wazuh-install.sh -a || true

    echo "Retrieving Wazuh passwords..."
    tar -xvf wazuh-install-files.tar wazuh-install-files/wazuh-passwords.txt || true
    cat wazuh-install-files/wazuh-passwords.txt > /root/wazuh-passwords.txt || true

    echo "Exposing Wazuh Indexer to 0.0.0.0..."
    sed -i 's/network.host: "127.0.0.1"/network.host: "0.0.0.0"/g' /etc/wazuh-indexer/opensearch.yml || true
    systemctl restart wazuh-indexer || true
  )
  echo "Wazuh setup complete."
else
  echo "Wazuh already installed, skipping."
fi

# ------------------------------------------------------------------------------
# 7.1 Load custom Wazuh VAPT rules/decoders (local copy — no SSH needed)
# ------------------------------------------------------------------------------
# Replaces the Terraform null_resource + SSH provisioner in terraform/wazuh.tf.
if [ -d /var/ossec ]; then
  echo "Loading custom VAPT decoders/rules into Wazuh..."
  cp "${SCRIPT_DIR}/wazuh-config/decoders.xml" /var/ossec/etc/decoders/vapt-decoders.xml
  cp "${SCRIPT_DIR}/wazuh-config/rules.xml" /var/ossec/etc/rules/vapt-rules.xml
  systemctl restart wazuh-manager || true
else
  echo "WARNING: /var/ossec not found — skipping custom rules/decoders load." >&2
fi

# ------------------------------------------------------------------------------
# 8. Final summary
# ------------------------------------------------------------------------------
LAN_IP="$(hostname -I | awk '{print $1}')"
LAN_IP="${LAN_IP:-localhost}"

echo ""
echo "=============================================================="
echo " On-Premises DevSecOps stack is up!"
echo "=============================================================="
echo " SonarQube   : http://${LAN_IP}:9000"
echo " DefectDojo  : http://${LAN_IP}:8080"
echo " Broker      : http://${LAN_IP}:8900  (clients: CS_DEVTEST_BROKER_URL)"
echo " Wazuh       : https://${LAN_IP}"
echo "--------------------------------------------------------------"
echo " SonarQube admin password: value of SONARQUBE_ADMIN_PASSWORD in onprem/.env"
echo " Wazuh passwords saved to : /root/wazuh-passwords.txt"
echo "=============================================================="
