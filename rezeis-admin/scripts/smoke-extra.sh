#!/bin/sh
set -eu
probe() {
  url="$1"
  echo "── ${url} ──"
  wget -O - --header "Authorization: Bearer ${REMNAWAVE_TOKEN}" "${url}" 2>/dev/null | head -c 1500
  echo
  echo
}
probe "https://${REMNAWAVE_HOST}/api/snippets"
probe "https://${REMNAWAVE_HOST}/api/subscription-page-configs"
probe "https://${REMNAWAVE_HOST}/api/infra-billing/providers"
probe "https://${REMNAWAVE_HOST}/api/node-plugins"
probe "https://${REMNAWAVE_HOST}/api/subscription-templates"
probe "https://${REMNAWAVE_HOST}/api/subscription-settings/"
probe "https://${REMNAWAVE_HOST}/api/subscription-request-history?limit=3"
probe "https://${REMNAWAVE_HOST}/api/hwid/devices/top-users?limit=3"
