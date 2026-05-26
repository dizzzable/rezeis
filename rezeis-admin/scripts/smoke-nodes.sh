#!/bin/sh
# Pull /api/nodes and count online/offline.
set -eu

URL="https://${REMNAWAVE_HOST}/api/nodes"
echo "→ ${URL}"

BODY="$(wget -O - --header "Authorization: Bearer ${REMNAWAVE_TOKEN}" "${URL}" 2>/dev/null)"

# Quick stats via grep counting "isConnected":true / false occurrences.
echo "── raw counts ────────────────────────────────────────────"
printf '%s' "${BODY}" | grep -o '"isConnected":true'  | wc -l | xargs -I{} echo "isConnected=true  : {}"
printf '%s' "${BODY}" | grep -o '"isConnected":false' | wc -l | xargs -I{} echo "isConnected=false : {}"
printf '%s' "${BODY}" | grep -o '"isDisabled":true'   | wc -l | xargs -I{} echo "isDisabled=true   : {}"
printf '%s' "${BODY}" | grep -o '"uuid"'              | wc -l | xargs -I{} echo "total nodes (~uuid) : {}"

echo
echo "── per-node summary ──────────────────────────────────────"
# Tiny inline node script — extracts (name, isConnected, isDisabled, usersOnline) per node
printf '%s' "${BODY}" | node -e '
let s = ""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => {
  try {
    const data = JSON.parse(s);
    const list = data.response ?? data;
    for (const n of list) {
      const flags = [
        n.isConnected ? "connected" : "DISCONN",
        n.isDisabled  ? "DISABLED"  : "enabled",
      ].join(",");
      console.log(`${n.name?.padEnd(30) ?? "(no-name)".padEnd(30)} ${flags}  online=${n.usersOnline ?? 0}`);
    }
    const online   = list.filter(n => n.isConnected && !n.isDisabled).length;
    const offline  = list.filter(n => !n.isConnected && !n.isDisabled).length;
    const disabled = list.filter(n =>  n.isDisabled).length;
    const sumUsers = list.reduce((acc, n) => acc + (n.usersOnline || 0), 0);
    console.log("");
    console.log(`online   : ${online}`);
    console.log(`offline  : ${offline}`);
    console.log(`disabled : ${disabled}`);
    console.log(`total    : ${list.length}`);
    console.log(`sum of usersOnline across all nodes : ${sumUsers}`);
  } catch (e) { console.error("parse error:", e.message); }
});
'
