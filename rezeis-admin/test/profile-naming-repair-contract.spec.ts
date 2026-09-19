import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as vm from 'node:vm';

import * as ts from 'typescript';

import { readProfileNamingConfig } from '../src/modules/profile-sync/remnawave-profile-naming.service';
import { readBrandingSettings } from '../src/modules/settings/utils/branding-settings.util';

/**
 * THE NAME THE SETTINGS PAGE PROMISES IS THE NAME NEW PROFILES GET.
 *
 * A naming value stored before the alphabet was checked is not sent to
 * Remnawave as it is: the server repairs it for every new profile
 * (`readProfileNamingConfig`), and «Panel settings → Customization» shows the
 * operator the name that repair produces (`effectiveNamingPart`,
 * `web/src/features/settings/profile-naming-rule.ts`). The two are separate
 * copies of one rule — nothing but JSON crosses the SPA/Nest boundary — so a
 * change to either one alone would make the page show a name no profile gets.
 *
 * Both run here over the same stored values, the page's copy on exactly what
 * the settings API hands it (`readBrandingSettings`). The page's module is
 * transpiled and run as it stands rather than imported: `web/` is an ES-module
 * package, which this CommonJS test process cannot require reliably. So the
 * module must stay free of runtime imports, and the loader refuses one by name.
 */

const RULE = join(__dirname, '..', 'web', 'src', 'features', 'settings', 'profile-naming-rule.ts');

type Part = 'prefix' | 'separator' | 'suffixBase';

function loadPageRule(): (value: string | undefined, part: Part) => string {
  const { outputText } = ts.transpileModule(readFileSync(RULE, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, removeComments: true },
    fileName: RULE,
  });
  assert.doesNotMatch(
    outputText,
    /\brequire\(/,
    'profile-naming-rule.ts gained a runtime import; this spec runs it on its own, so keep it self-contained',
  );
  const loaded = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(outputText, { module: loaded, exports: loaded.exports }, { filename: RULE });
  const rule = loaded.exports['effectiveNamingPart'];
  assert.equal(typeof rule, 'function', 'profile-naming-rule.ts no longer exports effectiveNamingPart');
  return rule as (value: string | undefined, part: Part) => string;
}

const char = (code: number): string => String.fromCodePoint(code);

/**
 * Stored values, each chosen for a behaviour of the rule: valid as stored,
 * a run to collapse, ends to trim, a separator to replace whole, letters that
 * only NFKD keeps, nothing valid left, too long, not a string.
 */
const STORED: readonly unknown[] = [
  'rz',
  'shop',
  '_rz-',
  '--',
  'my shop',
  'my _shop',
  ' my shop!',
  '__rz__',
  'x.',
  'a b',
  '.',
  `caf${char(0xe9)}`,
  `${char(0xff21)}nna`,
  `e${char(0x301)}`,
  `a${char(0x200b)}b`,
  'Магазин',
  '😀vpn',
  'x'.repeat(16),
  'x'.repeat(17),
  's'.repeat(32),
  's'.repeat(33),
  '',
  5,
  null,
];

describe('the settings page shows the naming repair the server applies', () => {
  const pageRule = loadPageRule();

  for (const part of ['prefix', 'separator', 'suffixBase'] as const) {
    it(`${part}: every stored value is repaired the same way on the page and on the server`, () => {
      for (const value of STORED) {
        const stored = { profileNaming: { [part]: value } };
        const shownTo = (readBrandingSettings(stored).profileNaming as unknown as Record<Part, string>)[part];
        const server = readProfileNamingConfig(stored)[part];
        assert.equal(pageRule(shownTo, part), server, `${part} stored as ${JSON.stringify(value)}`);
      }
    });
  }
});
