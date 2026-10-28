#!/bin/bash
# ==============================================================================
# On-Premises DevSecOps Stack — Host Firewall (ufw)
# ==============================================================================
# Replaces the GCP firewall rules in terraform/main.tf. Those rules opened the
# service ports to 0.0.0.0/0 (the whole internet); on-prem we restrict every
# service port to the office LAN (LAN_CIDRS in onprem/.env) and only allow SSH
# more broadly.
#
# Run AFTER gen-env.sh and BEFORE setup.sh:
#   sudo bash onprem/firewall.sh
#
# ufw only filters services that run directly on the host (Wazuh, Apache, SSH).
# Docker-published ports (SonarQube 9000, DefectDojo 8080/8443, broker 8900)
# bypass ufw; setup.sh restricts those with DOCKER-USER rules
# (onprem/docker-user-rules.sh), which are re-applied on every boot.
#
# Idempotent: `ufw allow` rules are not duplicated, so it is safe to re-run.
# ------------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=SCRIPTDIR/common.sh
source "${SCRIPT_DIR}/common.sh"

require_root firewall.sh
load_env

# Host services (Wazuh dashboard 443, indexer 9200, agent 1514/1515, API 55000)
# plus the Docker ports, listed for documentation/consistency only.
SERVICE_PORTS=(443 9200 1514 1515 55000 9000 8080 8443 8900 "${EXTRA_PORT_LIST[@]}")

if ! command -v ufw >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ufw
fi

echo "Configuring ufw rules..."
ufw default deny incoming
ufw default allow outgoing

# SSH (22) — allowed broadly so you do not lock yourself out of remote access.
# Tighten this to your admin subnet if all admins are on the LAN.
ufw allow 22/tcp comment 'SSH'

for cidr in "${LAN_CIDR_LIST[@]}" "${LAN_CIDR6_LIST[@]}"; do
  for port in "${SERVICE_PORTS[@]}"; do
    ufw allow from "${cidr}" to any port "${port}" proto tcp comment "DevSecOps LAN ${port}"
  done
done

ufw --force enable
ufw status verbose

echo ""
echo "ufw configured. Service ports are reachable only from: ${LAN_CIDR_LIST[*]} ${LAN_CIDR6_LIST[*]}"
echo "SSH (22) is allowed from anywhere — tighten it if your admins are LAN-only."
if [ "${#EXTRA_PORT_LIST[@]}" -eq 0 ]; then
  echo "Note: other host ports (e.g. Apache on 80) are now closed to the LAN."
  echo "      Add them to EXTRA_LAN_PORTS in onprem/.env and re-run if colleagues need them."
fi
