#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const handoffPath = resolve(root, 'docs/progress/next-session-handoff.md');
const runChecks = process.argv.includes('--run-checks');

const checks = [
  {
    area: 'Backend Prisma generate',
    command: 'npm run prisma:generate',
    cwd: 'rezeis-admin',
    mode: 'quick',
  },
  {
    area: 'Backend typecheck',
    command: 'npm run typecheck',
    cwd: 'rezeis-admin',
    mode: 'quick',
  },
  {
    area: 'Backend lint',
    command: 'npm run lint',
    cwd: 'rezeis-admin',
    mode: 'quick',
  },
  {
    area: 'Backend tests',
    command: 'npm test',
    cwd: 'rezeis-admin',
    mode: 'full',
  },
  {
    area: 'Backend maintained tests',
    command: 'npm run test:maintained',
    cwd: 'rezeis-admin',
    mode: 'quick',
  },
  {
    area: 'Backend audit',
    command: 'npm audit',
    cwd: 'rezeis-admin',
    mode: 'quick',
  },
  {
    area: 'Web typecheck',
    command: 'npx tsc -p tsconfig.app.json --noEmit --incremental false',
    cwd: 'rezeis-admin/web',
    mode: 'quick',
  },
  {
    area: 'Web tests',
    command: 'npm test',
    cwd: 'rezeis-admin/web',
    mode: 'quick',
  },
  {
    area: 'Web lint',
    command: 'npm run lint',
    cwd: 'rezeis-admin/web',
    mode: 'quick',
  },
  {
    area: 'Web build',
    command: 'npm run build',
    cwd: 'rezeis-admin/web',
    mode: 'full',
  },
  {
    area: 'Web audit',
    command: 'npm audit',
    cwd: 'rezeis-admin/web',
    mode: 'quick',
  },
];

if (!existsSync(handoffPath)) {
  throw new Error(`Handoff file not found: ${handoffPath}`);
}

const current = readFileSync(handoffPath, 'utf8');
const next = runChecks
  ? updateHandoffWithResults(current, checks.map((check) => {
    const completed = runCommand(check.command, resolve(root, check.cwd));
    return {
      ...check,
      result: summarize(completed),
    };
  }))
  : updateHandoffTimestampOnly(current);
writeFileSync(handoffPath, next, 'utf8');

console.log(`Updated ${handoffPath}`);
if (!runChecks) {
  console.log('Snapshot timestamp updated; existing gate results preserved. Use `npm run handoff:update:verify` to execute checks.');
}

function runCommand(command, cwd) {
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'sh';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-Command', command]
    : ['-lc', command];

  return spawnSync(shell, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 12,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function summarize(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const normalized = output.replace(/\u001b\[[0-9;]*m/g, '').replace(/\r/g, '');

  if (result.status === 0) {
    const warningMatch = normalized.match(/(\d+) problems? \(0 errors?, (\d+) warnings?\)/i)
      ?? normalized.match(/(\d+) warning/i);
    if (warningMatch) return `Pass, warnings present (${warningMatch[0].trim()})`;
    const testMatch = normalized.match(/Tests\s+([\s\S]{0,80}?passed[^\n]*)/i)
      ?? normalized.match(/tests\s+(\d+)[\s\S]{0,80}?pass\s+(\d+)/i);
    if (testMatch) return `Pass (${oneLine(testMatch[0])})`;
    const auditClean = normalized.match(/found 0 vulnerabilities/i);
    if (auditClean) return 'Pass: found 0 vulnerabilities';
    return 'Pass';
  }

  const firstError = firstUsefulLine(normalized);
  return firstError ? `Fail: ${firstError}` : `Fail: exit ${result.status ?? 'unknown'}`;
}

function firstUsefulLine(output) {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('>'));

  const preferred = lines.find((line) => /error TS\d+|\bFAIL\b|\bfail\b|vulnerabilit|Cannot find module|AssertionError|TypeError/i.test(line));
  return oneLine(preferred ?? lines[0] ?? '');
}

function oneLine(value) {
  return value.replace(/\s+/g, ' ').slice(0, 180);
}

function updateHandoffTimestampOnly(markdown) {
  const now = new Date();
  const withDate = markdown.replace(/^Updated: .*$/m, `Updated: ${now.toISOString().slice(0, 10)}`);
  if (/^Generated: .*$/m.test(withDate)) {
    return withDate.replace(/^Generated: .*$/m, `Generated: ${now.toISOString()} (checks not re-run; previous observed results preserved)`);
  }
  return withDate;
}

function updateHandoffWithResults(markdown, rows) {
  const updated = markdown.replace(/^Updated: .*$/m, `Updated: ${new Date().toISOString().slice(0, 10)}`);
  const table = [
    '## Current Gate Snapshot',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Run these from `V:\\REZEIS_ADMIN_RUID_USER\\rezeis` or the listed subdirectory.',
    '',
    '| Area | Command | Last observed result |',
    '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.area} | \`${row.command}\` in \`${row.cwd}\` | ${escapeTable(row.result)} |`),
    '',
    '',
  ].join('\n');

  return updated.replace(
    /## Current Gate Snapshot[\s\S]*?(?=## Recommended First Slice)/,
    `${table}`,
  );
}

function escapeTable(value) {
  return value.replace(/\|/g, '\\|');
}
