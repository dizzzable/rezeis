import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QuestPartnerSecretRegistry } from '../src/modules/quests/services/quest-partner-secret.registry';

describe('QuestPartnerSecretRegistry', () => {
  it('resolves a per-slug secret from the injected map', () => {
    const reg = new QuestPartnerSecretRegistry({ acme: 'secret-acme', globex: 'secret-globex' });
    assert.equal(reg.getSecret('acme'), 'secret-acme');
    assert.equal(reg.getSecret('globex'), 'secret-globex');
  });

  it('returns null for an unknown slug', () => {
    const reg = new QuestPartnerSecretRegistry({ acme: 'x' });
    assert.equal(reg.getSecret('nope'), null);
  });

  it('reports whether a slug is known (for config validation)', () => {
    const reg = new QuestPartnerSecretRegistry({ acme: 'x' });
    assert.equal(reg.has('acme'), true);
    assert.equal(reg.has('nope'), false);
  });

  it('parses a JSON env string into a registry', () => {
    const reg = QuestPartnerSecretRegistry.fromEnv('{"acme":"secret-acme"}');
    assert.equal(reg.getSecret('acme'), 'secret-acme');
  });

  it('is empty (never throws) for missing / malformed env', () => {
    for (const raw of [undefined, '', 'not json', '[]', '123', 'null']) {
      const reg = QuestPartnerSecretRegistry.fromEnv(raw);
      assert.equal(reg.has('anything'), false);
      assert.equal(reg.getSecret('anything'), null);
    }
  });

  it('ignores non-string secret values in the env map', () => {
    const reg = QuestPartnerSecretRegistry.fromEnv('{"acme":"ok","bad":123,"empty":""}');
    assert.equal(reg.getSecret('acme'), 'ok');
    assert.equal(reg.has('bad'), false);
    assert.equal(reg.has('empty'), false);
  });
});
