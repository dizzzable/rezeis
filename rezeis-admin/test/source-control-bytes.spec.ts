import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

/**
 * No raw control characters in source
 * ═══════════════════════════════════
 * Two NUL bytes sat inside template literals in
 * `panel-link-reconciliation.service.ts`, typed as a backslash-u escape into an
 * editing tool that decodes those into the character itself. The runtime string
 * was right, so every test passed — but a raw control byte renders as nothing in
 * an editor or a review, and a NUL anywhere in a file makes git's `text=auto`
 * treat the file as binary: it was stored with CRLF and never normalised. The
 * two-character escape (`\x00` in a string or template) yields the same string
 * and can be seen.
 *
 * The tests are held to it too. A fixture is where raw bytes are most tempting,
 * and one was there: the "arbitrary bytes" of a banner-upload spec were typed
 * as the characters themselves, NUL included, so git stored that spec as
 * binary as well.
 *
 * Refused: every C0 control (0x00-0x1F) except TAB, LF and CR, in
 * `src/**\/*.ts`, `web/src/**\/*.{ts,tsx}` and `test/**\/*.ts`. The set is
 * built from its codes, never typed as characters, so this file carries none of
 * the bytes it looks for — and says so below.
 */

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const REFUSED = new Set(
  Array.from({ length: 0x20 }, (_unused, code) => code).filter((code) => code !== TAB && code !== LF && code !== CR),
);

const projectRoot = join(__dirname, '..');

interface ControlByte {
  readonly line: number;
  readonly code: number;
}

/** Every refused byte in `bytes`, with its 1-based line. UTF-8 never encodes a C0 control inside another character. */
function controlBytesIn(bytes: Buffer): ControlByte[] {
  const found: ControlByte[] = [];
  let line = 1;
  for (const byte of bytes) {
    if (byte === LF) line += 1;
    else if (REFUSED.has(byte)) found.push({ line, code: byte });
  }
  return found;
}

function sourceFiles(root: string, extension: RegExp): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (extension.test(entry.name)) files.push(path);
    }
  };
  walk(root);
  return files;
}

/** `file:line: 0xNN` for every refused byte under `root`, plus how many files were read. */
function scan(root: string, extension: RegExp): { readonly files: number; readonly hits: string[] } {
  const files = sourceFiles(join(projectRoot, root), extension);
  const hits: string[] = [];
  for (const file of files) {
    for (const { line, code } of controlBytesIn(readFileSync(file))) {
      hits.push(`${relative(projectRoot, file)}:${line}: 0x${code.toString(16).padStart(2, '0')}`);
    }
  }
  return { files: files.length, hits };
}

const HOW_TO_FIX =
  'write the character as an escape instead (\\x00 in a string, template or regex), ' +
  'or build it with String.fromCharCode — the escape evaluates to the same string';

describe('no raw control bytes in source', () => {
  it('finds a refused byte where one is, names its line, and lets TAB, LF, CR and UTF-8 through', () => {
    // The detector itself, on bytes built from codes: a scan that could never
    // report anything would pass the two cases below on any tree.
    assert.deepEqual(controlBytesIn(Buffer.from([0x61, LF, 0x62, 0x00, 0x63])), [{ line: 2, code: 0x00 }]);
    assert.deepEqual(controlBytesIn(Buffer.from([0x1b, 0x5b, 0x30, 0x6d])), [{ line: 1, code: 0x1b }]);
    assert.deepEqual(controlBytesIn(Buffer.from([TAB, 0x78, CR, LF, 0x79])), []);
    assert.deepEqual(controlBytesIn(Buffer.from('Оператор — 5 ₽', 'utf8')), []);
    assert.equal(REFUSED.size, 29);
  });

  it('keeps them out of the panel source (src/**/*.ts)', () => {
    const { files, hits } = scan('src', /\.ts$/);
    assert.ok(files > 500, `only ${files} files under src/ — the walk is looking in the wrong place`);
    assert.deepEqual(hits, [], `raw control bytes in the panel source — ${HOW_TO_FIX}:\n  ${hits.join('\n  ')}`);
  });

  it('keeps them out of the SPA source (web/src/**/*.{ts,tsx})', () => {
    const { files, hits } = scan(join('web', 'src'), /\.tsx?$/);
    assert.ok(files > 500, `only ${files} files under web/src/ — the walk is looking in the wrong place`);
    assert.deepEqual(hits, [], `raw control bytes in the SPA source — ${HOW_TO_FIX}:\n  ${hits.join('\n  ')}`);
  });

  it('keeps them out of the tests (test/**/*.ts)', () => {
    // Fixture bytes included: build them with escapes or `Buffer.from([...])`.
    const { files, hits } = scan('test', /\.ts$/);
    assert.ok(files > 500, `only ${files} files under test/ — the walk is looking in the wrong place`);
    assert.deepEqual(hits, [], `raw control bytes in the tests — ${HOW_TO_FIX}:\n  ${hits.join('\n  ')}`);
  });

  it('carries none of the bytes it looks for', () => {
    assert.deepEqual(controlBytesIn(readFileSync(__filename)), []);
  });
});
