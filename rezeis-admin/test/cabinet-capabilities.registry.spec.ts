import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';

import {
  CABINET_CAPABILITY,
  CABINET_CAPABILITY_REGISTRY,
  CABINET_FLOOR_VERSION,
  CabinetView,
  compareCabinetVersions,
  HOSTED_CAPABILITY_SURFACES,
  impliedCapabilities,
  IMPLIED_CEILING_VERSION,
  SILENT_POLL_VERSION,
} from '../src/modules/reiwa-peers/cabinet-capabilities';
import { PANEL_CAPABILITIES } from '../src/modules/reiwa-peers/panel-capabilities';
import { CAPABILITY_ID_MAX_LENGTH, CAPABILITY_ID_PATTERN } from '../src/modules/reiwa-peers/reiwa-client-headers';
import { compareSemver } from '../src/modules/update-checker/services/update-checker.service';

/**
 * The capability registry, tied to the gates that read it
 * ══════════════════════════════════════════════════════
 * One id per behaviour that needs the other side's new code, in both
 * repositories, in the same pair of releases. What can go wrong on THIS side:
 *
 *  - a gate registered and read nowhere — the row says «не продаётся» and the
 *    panel sells it anyway;
 *  - a gate read somewhere but not where the row says — the listing gated and
 *    the checkout not, or the other way round;
 *  - a `.can(CABINET_CAPABILITY.x)` of an id nobody registered, or registered
 *    without the words the operator and the release notes are written from;
 *  - an id whose `since` the panel cannot order, or that is implied past the
 *    frozen ceiling — a newer capability taken on faith from a version number.
 *
 * The cabinet side of the pair is invisible from here: drift between the two
 * registries is what the pair's end-to-end run catches.
 */

const SRC = join(__dirname, '..', 'src');
const REGISTRY_FILE = join(SRC, 'modules', 'reiwa-peers', 'cabinet-capabilities.ts');
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:\.\d+)?$/;
const KEYS = Object.keys(CABINET_CAPABILITY) as Array<keyof typeof CABINET_CAPABILITY>;

/** Every `.can(CABINET_CAPABILITY.<key>)` in one source. */
function scanChecks(source: string): string[] {
  return [...source.matchAll(/\.can\(\s*CABINET_CAPABILITY\.([A-Za-z0-9_]+)\s*\)/g)].map((match) => match[1]!);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

/** `src/…` → the keys it checks, for every source file but the registry itself. */
function checksInTree(): { readonly byFile: ReadonlyMap<string, readonly string[]>; readonly filesScanned: number } {
  const byFile = new Map<string, string[]>();
  const files = walk(SRC).filter((file) => file !== REGISTRY_FILE);
  for (const file of files) {
    const found = scanChecks(readFileSync(file, 'utf8'));
    if (found.length > 0) byFile.set(relative(join(SRC, '..'), file).split(sep).join('/'), found);
  }
  return { byFile, filesScanned: files.length };
}

describe('the cabinet capability registry', () => {
  it('holds every id once, with a row for each constant and a constant for each row', () => {
    const ids = CABINET_CAPABILITY_REGISTRY.map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length, 'an id registered twice');
    assert.deepEqual([...ids].sort(), Object.values(CABINET_CAPABILITY).sort());
  });

  it('names each id as its surface: `<surface>.<kebab-name>[.v2…]`, at most 48 characters', () => {
    for (const row of CABINET_CAPABILITY_REGISTRY) {
      assert.match(row.id, CAPABILITY_ID_PATTERN, row.id);
      assert.ok(row.id.length <= CAPABILITY_ID_MAX_LENGTH, row.id);
      assert.equal(row.id.split('.')[0], row.surface, `${row.id}: the prefix is the surface that implements it`);
      assert.ok(Object.values(HOSTED_CAPABILITY_SURFACES).some((hosted) => hosted.includes(row.surface)), row.id);
    }
  });

  it('gives each id a `since` the panel can order, and the words the operator reads', () => {
    for (const row of CABINET_CAPABILITY_REGISTRY) {
      assert.match(row.since, VERSION_PATTERN, `${row.id}: since`);
      assert.equal(compareSemver(row.since, row.since), 0, `${row.id}: since`);
      assert.ok(compareCabinetVersions(row.since, CABINET_FLOOR_VERSION) > 0, `${row.id}: newer than the floor, or it is not needed`);
      const text = row.operatorText;
      assert.ok(text.trim().length > 20, `${row.id}: operator text`);
      assert.match(text, /[а-яё]/, `${row.id}: in Russian`);
      assert.equal(text, text.trim(), row.id);
      assert.doesNotMatch(text, /[.;]$/, `${row.id}: one list item, no closing mark — the card adds it`);
      assert.equal(text[0], text[0]!.toLowerCase(), `${row.id}: continues «До его обновления:»`);
      // The page in English says the same thing; the card is Russian only.
      const english = row.operatorTextEn;
      assert.ok(english.trim().length > 20, `${row.id}: English text`);
      assert.match(english, /^[a-z]/, `${row.id}: English, one list item`);
      assert.doesNotMatch(english, /[.;]$/, row.id);
    }
  });

  it('names the files that check a gate, and only for a gate', () => {
    for (const row of CABINET_CAPABILITY_REGISTRY) {
      if (row.kind === 'gate') assert.ok((row.gatedIn ?? []).length > 0, `${row.id}: a gate names where it is checked`);
      else assert.equal(row.gatedIn, undefined, `${row.id}: a degraded capability gates nothing`);
    }
  });

  it('implies nothing past the frozen ceiling, whatever version a silent cabinet claims', () => {
    const everything = impliedCapabilities('99.0.0.0');
    for (const row of CABINET_CAPABILITY_REGISTRY) {
      const pastCeiling = compareCabinetVersions(row.since, IMPLIED_CEILING_VERSION) > 0;
      assert.equal(everything.includes(row.id), !pastCeiling, row.id);
    }
    assert.equal(IMPLIED_CEILING_VERSION, '0.9.7.53');
  });

  it('a silent poll (0.9.7.53) implies «до сброса»; the floor (0.9.7.52) does not', () => {
    assert.equal(SILENT_POLL_VERSION, '0.9.7.53');
    assert.ok(impliedCapabilities(SILENT_POLL_VERSION).includes(CABINET_CAPABILITY.addonResetEnd));
    assert.equal(CABINET_FLOOR_VERSION, '0.9.7.52');
    assert.equal(impliedCapabilities(CABINET_FLOOR_VERSION).includes(CABINET_CAPABILITY.addonResetEnd), false);
    assert.equal(CabinetView.floor().can(CABINET_CAPABILITY.addonResetEnd), false);
    assert.equal(CabinetView.all().can(CABINET_CAPABILITY.addonResetEnd), true);
    assert.equal(CabinetView.of(['web.addon-reset-end', 'web.not-registered'], 'x').capabilities.length, 1);
  });

  it('orders versions exactly as the update checker does', () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['0.9.7.52', '0.9.7.53'],
      ['0.9.7.53', '0.9.7.53'],
      ['0.9.7.54', '0.9.7.53'],
      ['0.9.7', '0.9.7.0'],
      ['0.9.7.53-rc.1', '0.9.7.53'],
      ['0.9.10', '0.9.9.99'],
      ['v1.0.0', '0.99.99.99'],
      ['0.9.7.53-rc.1', '0.9.7.53-rc.2'],
    ];
    for (const [a, b] of pairs) {
      assert.equal(Math.sign(compareCabinetVersions(a, b)), Math.sign(compareSemver(a, b)), `${a} vs ${b}`);
      assert.equal(Math.sign(compareCabinetVersions(b, a)), Math.sign(compareSemver(b, a)), `${b} vs ${a}`);
    }
  });

  it('announces only `panel.*` ids of the same shape back to the cabinet', () => {
    for (const id of PANEL_CAPABILITIES) {
      assert.match(id, CAPABILITY_ID_PATTERN, id);
      assert.ok(id.startsWith('panel.'), id);
    }
  });
});

describe('the gates that read it', () => {
  it('checks every gate in each file its row names', () => {
    const { byFile } = checksInTree();
    for (const row of CABINET_CAPABILITY_REGISTRY.filter((candidate) => candidate.kind === 'gate')) {
      const key = KEYS.find((candidate) => CABINET_CAPABILITY[candidate] === row.id)!;
      for (const file of row.gatedIn ?? []) {
        assert.ok(
          (byFile.get(file) ?? []).includes(key),
          `${row.id} is a gate named in ${file}, and that file no longer checks .can(CABINET_CAPABILITY.${key}) — ` +
            'the operator is told it is withheld while the panel serves it',
        );
      }
    }
  });

  it('reads no capability that is not registered with its words', () => {
    const { byFile } = checksInTree();
    const read = [...new Set([...byFile.values()].flat())];
    assert.ok(read.length > 0, 'no gate found — the scan, not the code, is wrong');
    for (const key of read) {
      assert.ok((KEYS as string[]).includes(key), `.can(CABINET_CAPABILITY.${key}): no such constant`);
      const row = CABINET_CAPABILITY_REGISTRY.find((candidate) => candidate.id === CABINET_CAPABILITY[key as keyof typeof CABINET_CAPABILITY]);
      assert.ok(row !== undefined, `${key}: not in CABINET_CAPABILITY_REGISTRY`);
      assert.ok(row.operatorText.length > 0 && VERSION_PATTERN.test(row.since), key);
    }
  });

  it('would notice a check the scan cannot see — the scanner itself is exercised', () => {
    const synthetic = [
      'if (!audience.can(CABINET_CAPABILITY.addonResetEnd)) continue;',
      'const ok = view.can( CABINET_CAPABILITY.staleButtonMenu );',
      '// CABINET_CAPABILITY.lifetimeSubscription is only named here',
      'audience.can(someOtherId);',
    ].join('\n');
    assert.deepEqual(scanChecks(synthetic), ['addonResetEnd', 'staleButtonMenu']);
    const { filesScanned } = checksInTree();
    assert.ok(filesScanned > 200, `walked only ${filesScanned} files under src/ — the walk, not the code, is wrong`);
  });
});
