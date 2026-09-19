import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';

import { DEFAULT_NOTIFICATION_TEMPLATES } from '../src/modules/notifications/catalog/default-templates.catalog';

/**
 * THE TEXT A «НЕ ПОДКЛЮЧИЛСЯ» BROADCAST STARTS FROM IS THE NOTICE'S OWN.
 *
 * `/broadcast?compose=connect-help&bucket=…` opens «Новая рассылка» with the
 * Russian default of «Помощь с подключением» — `connect_help` for «Оплатил»,
 * `connect_help_trial` for trials and gifts — minus one thing: `«{{plan}}»`.
 * The notice fills its placeholders per customer; a broadcast sends its text
 * as written, so the template verbatim would tell every recipient «Подписка
 * «{{plan}}» оплачена».
 *
 * The SPA cannot import the panel's catalogue, so it carries a copy, and this
 * holds the copy to the catalogue: an edit to the notice's text fails here
 * until the broadcast's starting text follows it.
 *
 * The SPA package is an ES-module package, which the panel's CommonJS test
 * runner cannot `require`; its `connect-audience.ts` imports nothing, so it is
 * transpiled with the repo's own TypeScript and evaluated in a sandbox — the
 * very source the SPA ships, not a restatement of it.
 */

type Copy = Readonly<Record<'paid' | 'trial', { readonly title: string; readonly text: string }>>;

function spaCopy(): Copy {
  const file = join(__dirname, '..', 'web', 'src', 'features', 'broadcast', 'connect-audience.ts');
  const source = readFileSync(file, 'utf8');
  assert.ok(!/^\s*import\s/m.test(source), 'connect-audience.ts must stay import-free to be evaluated here');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const sandbox = { module: { exports: {} as Record<string, unknown> }, exports: {} as Record<string, unknown> };
  sandbox.exports = sandbox.module.exports;
  runInNewContext(js, sandbox);
  const copy = sandbox.module.exports['CONNECT_HELP_BROADCAST_COPY'];
  assert.ok(copy !== undefined && copy !== null, 'the SPA no longer exports CONNECT_HELP_BROADCAST_COPY');
  return copy as Copy;
}

describe('the text a «не подключился» broadcast starts from', () => {
  const copy = spaCopy();

  for (const [bucket, type] of [
    ['paid', 'connect_help'],
    ['trial', 'connect_help_trial'],
  ] as const) {
    it(`${bucket}: the catalogue's Russian ${type}, without the placeholder a broadcast would send literally`, () => {
      const template = DEFAULT_NOTIFICATION_TEMPLATES.find((entry) => entry.type === type);
      assert.ok(template !== undefined, `the catalogue has no ${type} template`);
      assert.ok(template.body.includes(' «{{plan}}»'), `${type} no longer names the plan as « «{{plan}}»»`);
      assert.equal(copy[bucket].text, template.body.replace(' «{{plan}}»', ''));
      assert.equal(copy[bucket].title, template.title);
      assert.ok(!copy[bucket].text.includes('{{') && !copy[bucket].title.includes('{{'), 'no placeholder survives');
    });
  }
});
