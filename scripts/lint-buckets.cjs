/**
 * lint-buckets.cjs
 * ────────────────
 * Operator helper: groups ESLint output by rule + by file so we can see
 * the warning landscape at a glance. Reads JSON from process.argv[2].
 *
 * Usage:
 *   npx eslint . -f json --output-file lint.json
 *   node scripts/lint-buckets.cjs lint.json
 */

/* eslint-env node */
const path = require('node:path');
const data = require(path.resolve(process.argv[2]));
const buckets = {};
const fileBuckets = {};
let total = 0;
for (const f of data) {
  for (const m of f.messages) {
    const k = m.ruleId || '(no-rule)';
    buckets[k] = (buckets[k] || 0) + 1;
    total++;
    fileBuckets[f.filePath] = (fileBuckets[f.filePath] || 0) + 1;
  }
}
console.log('TOTAL warnings/errors:', total);
console.log('\nBy rule:');
for (const [k, v] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)} ${k}`);
}
console.log('\nTop 20 files:');
const top = Object.entries(fileBuckets)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20);
for (const [k, v] of top) {
  console.log(`  ${String(v).padStart(4)} ${k.replace(process.cwd(), '.')}`);
}
