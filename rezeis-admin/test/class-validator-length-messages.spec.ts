/**
 * class-validator's own `@Length` refusals, pinned for the SPA.
 *
 * The roles page recognises the server's refusals by their exact wording
 * (`web/src/features/rbac/role-errors.ts`), and `role-errors.test.ts` feeds it
 * the sentences class-validator writes. That test cannot read class-validator
 * itself: the SPA's CI job installs only `web/`, so the package is not there
 * (it failed with ENOENT on the v0.9.7.61 release commit). The two sentences
 * live in `test/fixtures/class-validator-length-messages.json` instead, and
 * this spec, which runs where the server's dependencies are installed, holds
 * them to the package. A class-validator update that rewords them turns this
 * red rather than the roles page silently English.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

const FIXTURE = join(__dirname, 'fixtures', 'class-validator-length-messages.json');

describe('the class-validator sentences the SPA is pinned to', () => {
  it('are exactly what the installed class-validator writes for @Length', () => {
    const pinned = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(pinned).sort(), ['longer', 'shorter']);

    const lengthJs = join(dirname(require.resolve('class-validator')), 'decorator', 'string', 'Length.js');
    const source = readFileSync(lengthJs, 'utf8');
    for (const key of ['longer', 'shorter'] as const) {
      const sentence = pinned[key];
      assert.equal(typeof sentence, 'string', `${key} must be a sentence`);
      assert.ok(
        source.includes(`'${String(sentence)}'`),
        `class-validator no longer writes the "${key}" sentence: ${String(sentence)}`,
      );
    }
  });
});
