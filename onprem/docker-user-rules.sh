#!/bin/bash
# ==============================================================================
# On-Premises DevSecOps Stack — LAN restriction for Docker-published ports
# ==============================================================================
# ufw's INPUT chain does NOT filter Docker-published ports: Docker DNATs them
# and the packets traverse FORWARD, where the DOCKER-USER chain is the supported
# place for user rules. This script confines the published ports to LAN_CIDRS
# (from onprem/.env) and the Docker bridge range.
#
# setup.sh runs it once and installs devsecops-docker-user.service so it is
# re-applied whenever Docker starts (iptables rules do not survive a reboot).
#
# Per port the evaluation order is: RETURN(bridge), RETURN(LAN cidr...), DROP.
# The bridge RETURN keeps container-to-container traffic (broker -> sonarqube)
# working. Every rule is comment-tagged so re-runs delete before re-inserting.
# ------------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=SCRIPTDIR/common.sh
source "${SCRIPT_DIR}/common.sh"

require_root docker-user-rules.sh
load_env

DOCKER_PORTS=(8900 9000 8080 8443)
TAG="cs-devtest-broker"
BRIDGE_CIDR="172.16.0.0/12"   # Docker default bridge pools
BRIDGE_CIDR6="fc00::/7"       # ULA range Docker uses for IPv6 bridges

apply_rules() {
  local ipt="$1" bridge="$2"
  shift 2
  local cidrs=("$@") port cidr

  "$ipt" -nL DOCKER-USER >/dev/null 2>&1 || "$ipt" -N DOCKER-USER

  # Remove every rule carrying our tag (any port/source), so ports or CIDRs
  # removed from the config do not linger.
  local rule
  while rule="$("$ipt" -S DOCKER-USER | grep -m1 -- "--comment \"\?${TAG}\"\?" || true)" && [ -n "$rule" ]; do
    # shellcheck disable=SC2086
    "$ipt" ${rule/-A DOCKER-USER/-D DOCKER-USER}
  done

  for port in "${DOCKER_PORTS[@]}"; do
    "$ipt" -I DOCKER-USER -p tcp --dport "$port" -m comment --comment "$TAG" -j DROP
    "$ipt" -I DOCKER-USER -p tcp --dport "$port" -s "$bridge" -m comment --comment "$TAG" -j RETURN
    for cidr in "${cidrs[@]}"; do
      "$ipt" -I DOCKER-USER -p tcp --dport "$port" -s "$cidr" -m comment --comment "$TAG" -j RETURN
    done
  done
}

command -v iptables >/dev/null 2>&1 || die "iptables not found."

echo "Applying DOCKER-USER LAN restriction for ports ${DOCKER_PORTS[*]} (allowed: ${LAN_CIDR_LIST[*]})..."
apply_rules iptables "$BRIDGE_CIDR" "${LAN_CIDR_LIST[@]}"

if command -v ip6tables >/dev/null 2>&1 && ip6tables -nL DOCKER-USER >/dev/null 2>&1; then
  # Docker created an IPv6 DOCKER-USER chain, so IPv6 forwarding is in use:
  # restrict it too (with no LAN_CIDRS6 only the bridge range is allowed).
  echo "Applying DOCKER-USER IPv6 restriction (allowed: ${LAN_CIDR6_LIST[*]:-none})..."
  apply_rules ip6tables "$BRIDGE_CIDR6" "${LAN_CIDR6_LIST[@]}"
fi
