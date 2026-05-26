#!/bin/sh
# Verbose dump of recap & bandwidth endpoints (200 + body, or HTTP error).
set -eu

probe() {
  url="$1"
  echo "── ${url} ─────────────────────────────"
  # -S prints HTTP status. Always succeed so the script doesn't bail on 404.
  wget -O - -S --header "Authorization: Bearer ${REMNAWAVE_TOKEN}" "${url}" 2>&1 || true
  echo
  echo
}

probe "https://${REMNAWAVE_HOST}/api/system/recap"
probe "https://${REMNAWAVE_HOST}/api/system/bandwidth"
