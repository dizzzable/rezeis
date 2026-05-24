#!/usr/bin/env node
/**
 * Identify top-level namespaces in src/i18n/ru.ts that are NEVER
 * referenced in src/**\/*.{ts,tsx} via either:
 *   - t('foo.something')
 *   - t("foo.something")
 *   - t(`foo.something${...}`)
 *   - useTranslation('foo')   (i18next namespace mode)
 *   - 'foo.X'                 (raw literal references — for zod schema messages, etc.)
 *
 * Outputs the unused list for safe deletion or extraction into a
 * "legacy" feature bundle.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const I18N_FILE = path.join(ROOT, 'src', 'i18n', 'ru.ts');
const SRC_DIR = path.join(ROOT, 'src');

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'i18n' && full === path.join(SRC_DIR, 'i18n')) continue;
      out.push(...listFiles(full));
    } else if (/\.(ts|tsx|js|jsx|md)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const sources = listFiles(SRC_DIR);
const corpus = sources.map((f) => fs.readFileSync(f, 'utf8')).join('\n\n');

// Top-level namespace extraction
const ruContent = fs.readFileSync(I18N_FILE, 'utf8');
const TOP_KEY_RE = /^ {2}([A-Za-z_][A-Za-z0-9_]*):\s/gm;
const namespaces = [];
let m;
while ((m = TOP_KEY_RE.exec(ruContent)) !== null) {
  namespaces.push(m[1]);
}

const unused = [];
const used = [];
for (const ns of namespaces) {
  // Match: 'ns.something' or "ns.something" or `ns.something`
  // Allow word-boundary on left side (so substring matches like "Page.users." don't false-positive)
  const re = new RegExp(`(^|[^A-Za-z0-9_])${ns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`, 'm');
  if (re.test(corpus)) {
    used.push(ns);
  } else {
    unused.push(ns);
  }
}

console.log('UNUSED top-level i18n namespaces (safe to remove or move out of core):');
console.log('─'.repeat(72));
for (const ns of unused) console.log(`  ${ns}`);
console.log('─'.repeat(72));
console.log(`Total: ${unused.length} unused / ${namespaces.length} all namespaces`);
console.log();
console.log(`Used: ${used.length}`);
