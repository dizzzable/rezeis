#!/bin/sh
# Dumps the upstream Remnawave /api/system/stats body for shape comparison.
set -eu
URL="https://${REMNAWAVE_HOST}/api/system/stats"
echo "→ ${URL}"
wget -O - --header "Authorization: Bearer ${REMNAWAVE_TOKEN}" "${URL}" 2>/dev/null | head -c 2000
echo
