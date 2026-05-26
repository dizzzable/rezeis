#!/bin/sh
# Tries several known/likely Remnawave URLs to find the actual ones.
set -eu

probe() {
  url="$1"
  status="$(wget -S --spider --header "Authorization: Bearer ${REMNAWAVE_TOKEN}" "${url}" 2>&1 | grep -m1 "HTTP/" || echo 'no-response')"
  printf '%-60s %s\n' "${url}" "${status}"
}

base="https://${REMNAWAVE_HOST}"
probe "${base}/api/system/stats"
probe "${base}/api/system/recap"
probe "${base}/api/system/bandwidth"
probe "${base}/api/system/info"
probe "${base}/api/keygen/get"
probe "${base}/api/users"
probe "${base}/api/users/stats"
probe "${base}/api/system/uptime"
probe "${base}/api/nodes/usage/realtime"
probe "${base}/api/nodes"
probe "${base}/api/hosts/"
probe "${base}/api/internal-squads/"
probe "${base}/api/external-squads/"
probe "${base}/api/config-profiles/"
probe "${base}/api/hwid/stats"
probe "${base}/api/subscription-settings/"
probe "${base}/api/subscription-templates"
