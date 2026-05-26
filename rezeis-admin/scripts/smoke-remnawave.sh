#!/bin/sh
# Smoke-tests the configured Remnawave upstream from inside the rezeis container.
# Reads REMNAWAVE_HOST / REMNAWAVE_TOKEN from the env, never echoes the token.
set -eu

URL="https://${REMNAWAVE_HOST}/api/auth/status"
echo "→ probing ${URL}"

# BusyBox wget needs the auth header on its own line, separate from -O.
HTTP_BODY="$(wget -O - --header "Authorization: Bearer ${REMNAWAVE_TOKEN}" "${URL}" 2>/tmp/wget.stderr || true)"

echo '── stderr ────────────────────────────────────────────────────────'
cat /tmp/wget.stderr || true
echo
echo '── body (first 800 chars) ────────────────────────────────────────'
printf '%s' "${HTTP_BODY}" | head -c 800
echo
