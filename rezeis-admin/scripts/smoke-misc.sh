#!/bin/sh
set -eu

probe_body() {
  url="$1"
  echo "── ${url} ─────────────────────────────────────────"
  wget -O - --header "Authorization: Bearer ${REMNAWAVE_TOKEN}" "${url}" 2>/dev/null | head -c 1500
  echo
  echo
}

probe_body "https://${REMNAWAVE_HOST}/api/internal-squads/"
probe_body "https://${REMNAWAVE_HOST}/api/external-squads/"
