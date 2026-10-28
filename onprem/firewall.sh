#!/bin/bash
# ==============================================================================
# On-Premises DevSecOps Stack — Host Firewall (ufw)
# ==============================================================================
# Replaces the GCP firewall rules in terraform/main.tf. Those rules opened the
# service ports to 0.0.0.0/0 (the whole internet); on-prem we restrict every
# service port to the local office LAN and only allow SSH more broadly.
#
# Run BEFORE setup.sh:
#   sudo bash onprem/firewall.sh
#
# Idempotent: `ufw allow` rules are not duplicated, so it is safe to re-run.
# ------------------------------------------------------------------------------
set -euo pipefail

# ------------------------------------------------------------------------------
# CONFIGURE ME: the CIDR(s) allowed to reach the service ports.
# Set this to YOUR actual office subnet. The defaults cover the common private
# RFC1918 ranges; tighten them to the real subnet (e.g. 192.168.10.0/24).
# ------------------------------------------------------------------------------
LAN_CIDRS=("192.168.0.0/16" "10.0.0.0/8")

# Service ports = union of the GCP firewall rules in terraform/main.tf
# (allow_sonarqube 9000; allow_defectdojo 8080,9000; allow_wazuh 443,8080,9000,9200,1514,1515,55000).
# 8900 is the credential broker. NOTE: this ufw entry does NOT actually filter
# the broker's Docker-published port — ufw's INPUT chain does not touch
# Docker-published ports. It is kept here for consistency/documentation and to
# cover any non-Docker listener on 8900; the effective LAN restriction is the
# DOCKER-USER rule applied by setup.sh section 4.1 (after Docker is installed).
SERVICE_PORTS=(8900 9000 8080 443 9200 1514 1515 55000)

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: this script must be run as root. Re-run with: sudo bash onprem/firewall.sh" >&2
  exit 1
fi

# Install ufw if missing.
if ! command -v ufw >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ufw
fi

echo "Configuring ufw rules..."

# SSH (22) — allowed broadly so you do not lock yourself out of remote access.
# Tighten this to your admin subnet if all admins are on the LAN.
ufw allow 22/tcp comment 'SSH'

# Service ports — restricted to the office LAN only.
for cidr in "${LAN_CIDRS[@]}"; do
  for port in "${SERVICE_PORTS[@]}"; do
    ufw allow from "${cidr}" to any port "${port}" proto tcp comment "DevSecOps LAN ${port}"
  done
done

# Enable ufw (non-interactive). Safe to run when already enabled.
ufw --force enable
ufw status verbose

echo ""
echo "ufw configured. Service ports are reachable only from: ${LAN_CIDRS[*]}"
echo "SSH (22) is allowed from anywhere — tighten it if your admins are LAN-only."
