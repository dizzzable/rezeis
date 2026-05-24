#!/usr/bin/env node
/**
 * Measure the size of each top-level namespace in src/i18n/ru.ts and en.ts.
 * Used to plan the i18n namespace splitting (D2).
 *
 * Strategy: parse the file by finding top-level key boundaries
 * (lines starting with exactly two spaces followed by an identifier).
 * For each namespace, compute the byte size of its slice.
 */

const fs = require('node:fs');
const path = require('node:path');

function measureFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  // Find top-level keys (lines like "  someKey: {" or "  someKey: 'value',")
  const TOP_LEVEL_RE = /^  ([A-Za-z_][A-Za-z0-9_]*):\s/;

  const boundaries = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TOP_LEVEL_RE.exec(lines[i]);
    if (m) {
      boundaries.push({ name: m[1], lineStart: i });
    }
  }

  // Convert to ranges
  const ranges = boundaries.map((b, idx) => {
    const lineEnd = idx + 1 < boundaries.length ? boundaries[idx + 1].lineStart : lines.length;
    const slice = lines.slice(b.lineStart, lineEnd).join('\n');
    return {
      name: b.name,
      bytes: Buffer.byteLength(slice, 'utf8'),
      lines: lineEnd - b.lineStart,
    };
  });

  ranges.sort((a, b) => b.bytes - a.bytes);

  const total = ranges.reduce((sum, r) => sum + r.bytes, 0);
  return { total, ranges };
}

function fmt(bytes) {
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' kB';
  return bytes + ' B';
}

const ruPath = path.join(__dirname, '..', 'src', 'i18n', 'ru.ts');
const enPath = path.join(__dirname, '..', 'src', 'i18n', 'en.ts');

const ru = measureFile(ruPath);
const en = measureFile(enPath);

console.log('Top namespaces by size (combined ru + en):');
console.log('─'.repeat(72));
console.log(
  ['namespace', 'ru', 'en', 'total', '%'].map((s, i) =>
    [30, 10, 10, 10, 6][i] === 30 ? s.padEnd(30) : s.padStart([10, 10, 10, 10, 6][i])
  ).join(''),
);
console.log('─'.repeat(72));

const enByName = new Map(en.ranges.map((r) => [r.name, r.bytes]));
const combined = ru.ranges.map((r) => ({
  name: r.name,
  ru: r.bytes,
  en: enByName.get(r.name) ?? 0,
  total: r.bytes + (enByName.get(r.name) ?? 0),
}));
combined.sort((a, b) => b.total - a.total);

const grandTotal = combined.reduce((s, r) => s + r.total, 0);
let cumulative = 0;
let topThirty = [];
for (const r of combined.slice(0, 30)) {
  cumulative += r.total;
  const pct = ((r.total / grandTotal) * 100).toFixed(1);
  console.log(
    [r.name, fmt(r.ru), fmt(r.en), fmt(r.total), pct + '%']
      .map((s, i) => ([30, 10, 10, 10, 6][i] === 30 ? s.padEnd(30) : s.padStart([10, 10, 10, 10, 6][i])))
      .join(''),
  );
  topThirty.push(r);
}
console.log('─'.repeat(72));
console.log(`Top 30 namespaces account for ${((cumulative / grandTotal) * 100).toFixed(1)}% of total i18n bytes`);
console.log(`Grand total: ${fmt(grandTotal)} (ru ${fmt(ru.total)} + en ${fmt(en.total)})`);
console.log(`Total namespaces: ru=${ru.ranges.length}, en=${en.ranges.length}`);
