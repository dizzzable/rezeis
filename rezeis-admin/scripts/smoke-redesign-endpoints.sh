#!/bin/sh
# Probes every endpoint our redesign idea-list considers, reports which
# are reachable on the live panel.
set -eu

probe() {
  url="$1"
  status="$(wget -S --spider --header "Authorization: Bearer ${REMNAWAVE_TOKEN}" "${url}" 2>&1 | grep -m1 "HTTP/" || echo 'no-response')"
  printf '%-65s %s\n' "${url}" "${status}"
}

base="https://${REMNAWAVE_HOST}"

echo "── Live & connections ─────────────────────────────"
probe "${base}/api/ip-control/fetch-ips"
probe "${base}/api/ip-control/fetch-users-ips"
probe "${base}/api/ip-control/drop-connections"

echo
echo "── Realtime per-node metrics ──────────────────────"
probe "${base}/api/system/nodes-metrics"
probe "${base}/api/system/nodes-statistics"
probe "${base}/api/system/health"

echo
echo "── HWID ──────────────────────────────────────────"
probe "${base}/api/hwid/devices/stats"
probe "${base}/api/hwid/devices/top-users"
probe "${base}/api/hwid/devices"

echo
echo "── Users / search ────────────────────────────────"
probe "${base}/api/users/resolve"
probe "${base}/api/users/v2"

echo
echo "── Subscription history ──────────────────────────"
probe "${base}/api/subscription-request-history"
probe "${base}/api/subscription-request-history/stats"

echo
echo "── Config-profiles drill-down ────────────────────"
probe "${base}/api/config-profiles/inbounds"

echo
echo "── Remnawave settings ────────────────────────────"
probe "${base}/api/remnawave-settings"

echo
echo "── Snippets / page-configs ───────────────────────"
probe "${base}/api/snippets"
probe "${base}/api/subscription-page-configs"

echo
echo "── Infra-billing ─────────────────────────────────"
probe "${base}/api/infra-billing/providers"
probe "${base}/api/infra-billing/billing-nodes"
probe "${base}/api/infra-billing/bill-records"

echo
echo "── Node plugins ──────────────────────────────────"
probe "${base}/api/node-plugins"
