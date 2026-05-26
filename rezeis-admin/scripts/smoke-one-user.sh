#!/bin/sh
set -eu
URL="https://${REMNAWAVE_HOST}/api/users?size=1"
echo "→ ${URL}"
wget -O - --header "Authorization: Bearer ${REMNAWAVE_TOKEN}" "${URL}" 2>/dev/null | head -c 3500
echo
