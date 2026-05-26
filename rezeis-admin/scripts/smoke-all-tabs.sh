#!/bin/sh
# Sample one record from every endpoint each Remnawave tab in our admin
# panel reads. Helps spot shape drift before it hits the UI.
set -eu

probe() {
  url="$1"
  echo "── ${url} ────────────────────────────────────────"
  wget -O - --header "Authorization: Bearer ${REMNAWAVE_TOKEN}" "${url}" 2>/dev/null \
    | node -e '
let s = ""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => {
  try {
    const j = JSON.parse(s);
    const root = j.response ?? j;
    const sample = Array.isArray(root) ? root[0] : (Array.isArray(root?.internalSquads) ? root.internalSquads[0]
                  : Array.isArray(root?.externalSquads) ? root.externalSquads[0]
                  : Array.isArray(root?.profiles) ? root.profiles[0]
                  : root);
    console.log(JSON.stringify(sample, null, 2).slice(0, 1800));
  } catch (e) { console.error("parse:", e.message, "\nbody[0..200]:", s.slice(0, 200)); }
});
'
  echo
}

base="https://${REMNAWAVE_HOST}"
probe "${base}/api/nodes"
probe "${base}/api/hosts/"
probe "${base}/api/config-profiles/"
probe "${base}/api/internal-squads/"
probe "${base}/api/external-squads/"
probe "${base}/api/subscription-settings/"
probe "${base}/api/subscription-templates"
