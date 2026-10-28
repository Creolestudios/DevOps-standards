# shellcheck shell=bash
# ==============================================================================
# Shared helpers for the on-prem scripts (sourced, not executed).
# Callers must set SCRIPT_DIR to the onprem/ directory before sourcing.
# ==============================================================================

ENV_FILE="${SCRIPT_DIR}/.env"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

warn() {
  echo "WARNING: $*" >&2
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "this script must be run as root. Re-run with: sudo bash onprem/$1"
}

# Load onprem/.env and split the space-separated lists into arrays:
#   LAN_CIDR_LIST, LAN_CIDR6_LIST, EXTRA_PORT_LIST
load_env() {
  [ -f "${ENV_FILE}" ] || die "${ENV_FILE} not found. Create it with: sudo bash onprem/gen-env.sh"
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a

  read -r -a LAN_CIDR_LIST <<< "${LAN_CIDRS:-}"
  read -r -a LAN_CIDR6_LIST <<< "${LAN_CIDRS6:-}"
  read -r -a EXTRA_PORT_LIST <<< "${EXTRA_LAN_PORTS:-}"

  [ "${#LAN_CIDR_LIST[@]}" -gt 0 ] || die "LAN_CIDRS is empty in ${ENV_FILE}"
  local c p
  for c in "${LAN_CIDR_LIST[@]}"; do
    [[ "$c" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]] || die "invalid IPv4 CIDR in LAN_CIDRS: '$c'"
  done
  for c in "${LAN_CIDR6_LIST[@]}"; do
    [[ "$c" =~ ^[0-9A-Fa-f:]+/[0-9]{1,3}$ ]] || die "invalid IPv6 CIDR in LAN_CIDRS6: '$c'"
  done
  for p in "${EXTRA_PORT_LIST[@]}"; do
    [[ "$p" =~ ^[0-9]{1,5}$ ]] || die "invalid port in EXTRA_LAN_PORTS: '$p'"
  done
}
