#!/bin/sh
# Dumps upstream /api/system/recap and /api/system/bandwidth bodies for shape comparison.
set -eu
echo "→ ${REMNAWAVE_HOST}/api/system/recap"
wget -O - --header "Authorization: Bearer ${REMNAWAVE_TOKEN}" "https://${REMNAWAVE_HOST}/api/system/recap" 2>/dev/null
echo
echo
echo "→ ${REMNAWAVE_HOST}/api/system/bandwidth"
wget -O - --header "Authorization: Bearer ${REMNAWAVE_TOKEN}" "https://${REMNAWAVE_HOST}/api/system/bandwidth" 2>/dev/null
echo
