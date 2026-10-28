#!/bin/bash
# ==============================================================================
# On-Premises DevSecOps Stack — generate onprem/.env
# ==============================================================================
# Creates onprem/.env from .env.example with:
#   - random strong secrets (SonarQube admin, DefectDojo DB/keys/admin)
#   - LAN_CIDRS = the subnet of this machine's default-route interface
#   - SONAR_PUBLIC_URL = http://<this machine's LAN IP>:9000
#
#   sudo bash onprem/gen-env.sh
#
# Never overwrites an existing .env. Review the result before running
# firewall.sh, especially LAN_CIDRS if your office has several subnets.
# ------------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=SCRIPTDIR/common.sh
source "${SCRIPT_DIR}/common.sh"

EXAMPLE_FILE="${SCRIPT_DIR}/.env.example"

[ -f "${ENV_FILE}" ] && die "${ENV_FILE} already exists — not overwriting. Edit it directly, or move it away and re-run."
[ -f "${EXAMPLE_FILE}" ] || die "${EXAMPLE_FILE} not found."
command -v openssl >/dev/null 2>&1 || die "openssl is required (sudo apt-get install -y openssl)."

# Interface + IP used for the default route, and that interface's subnet.
read -r LAN_DEV LAN_IP < <(ip -4 route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) {if ($i=="dev") d=$(i+1); if ($i=="src") s=$(i+1)}} END {print d, s}')
if [ -z "${LAN_DEV:-}" ] || [ -z "${LAN_IP:-}" ]; then
  die "could not detect the LAN interface/IP (no default route?)."
fi
LAN_SUBNET="$(ip -4 route show dev "${LAN_DEV}" proto kernel scope link | awk 'NR==1 {print $1}')"
[ -n "${LAN_SUBNET}" ] || die "could not detect the subnet of ${LAN_DEV}."

# Passwords: hex body plus a fixed prefix so SonarQube's policy (upper, lower,
# digit, special, 12+ chars) is always met. Only shell/URL-safe characters.
SONAR_PW="Sq9@$(openssl rand -hex 16)"
DD_ADMIN_PW="Dd9@$(openssl rand -hex 16)"
DD_DB_PW="$(openssl rand -hex 32)"
DD_SECRET="$(openssl rand -hex 32)"
DD_AES="$(openssl rand -hex 32)"

umask 077
sed \
  -e "s|^LAN_CIDRS=.*|LAN_CIDRS=\"${LAN_SUBNET}\"|" \
  -e "s|^SONARQUBE_ADMIN_PASSWORD=.*|SONARQUBE_ADMIN_PASSWORD=${SONAR_PW}|" \
  -e "s|^DD_DATABASE_PASSWORD=.*|DD_DATABASE_PASSWORD=${DD_DB_PW}|" \
  -e "s|^DD_SECRET_KEY=.*|DD_SECRET_KEY=${DD_SECRET}|" \
  -e "s|^DD_CREDENTIAL_AES_256_KEY=.*|DD_CREDENTIAL_AES_256_KEY=${DD_AES}|" \
  -e "s|^DD_ADMIN_PASSWORD=.*|DD_ADMIN_PASSWORD=${DD_ADMIN_PW}|" \
  -e "s|^SONAR_PUBLIC_URL=.*|SONAR_PUBLIC_URL=http://${LAN_IP}:9000|" \
  "${EXAMPLE_FILE}" > "${ENV_FILE}"
chmod 600 "${ENV_FILE}"

echo "Created ${ENV_FILE} (mode 600)."
echo "  LAN interface    : ${LAN_DEV} (${LAN_IP})"
echo "  LAN_CIDRS        : ${LAN_SUBNET}   <- add other office subnets (Wi-Fi/VPN) if needed"
echo "  SONAR_PUBLIC_URL : http://${LAN_IP}:9000"
echo "  Secrets          : generated (view with: sudo cat ${ENV_FILE})"
