import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decryptQuestPartnerSecrets,
  mergeQuestPartnerSecrets,
  readQuestPartnerStore,
  toQuestPartnerView,
} from '../src/modules/settings/utils/quest-partner-settings.util';
import { encryptTotpSecret } from '../src/modules/two-factor/utils/secret-cipher';

const KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('quest-partner-settings.util', () => {
  it('readQuestPartnerStore tolerates junk and returns an empty partner list', () => {
    for (const junk of [null, 42, 'x', [], {}, { partners: null }, { partners: 'x' }]) {
      assert.deepStrictEqual(readQuestPartnerStore(junk as never), { partners: [] });
    }
  });

  it('readQuestPartnerStore keeps only well-formed partner entries', () => {
    const store = readQuestPartnerStore({
      partners: [
        { slug: 'acme', secretEnc: 'iv:ct:tag', label: 'Acme' },
        { slug: 'nolabel', secretEnc: 'a:b:c' },
        { slug: '', secretEnc: 'x' }, // bad slug
        { slug: 'nosecret' }, // missing secretEnc
        'garbage',
      ],
    });
    assert.deepStrictEqual(store.partners, [
      { slug: 'acme', secretEnc: 'iv:ct:tag', label: 'Acme' },
      { slug: 'nolabel', secretEnc: 'a:b:c' },
    ]);
  });

  it('toQuestPartnerView exposes slug/label/configured but NEVER the secret', () => {
    const view = toQuestPartnerView({
      partners: [{ slug: 'acme', secretEnc: 'iv:ct:tag', label: 'Acme' }],
    });
    assert.deepStrictEqual(view, [{ slug: 'acme', label: 'Acme', configured: true }]);
    assert.equal(JSON.stringify(view).includes('iv:ct:tag'), false);
  });

  it('decryptQuestPartnerSecrets returns a slug->plaintext map', () => {
    const store = {
      partners: [
        { slug: 'acme', secretEnc: encryptTotpSecret('secret-acme', KEY) },
        { slug: 'globex', secretEnc: encryptTotpSecret('secret-globex', KEY) },
      ],
    };
    const map = decryptQuestPartnerSecrets(store, KEY);
    assert.equal(map.acme, 'secret-acme');
    assert.equal(map.globex, 'secret-globex');
  });

  it('decryptQuestPartnerSecrets skips undecryptable entries (never throws)', () => {
    const store = {
      partners: [
        { slug: 'acme', secretEnc: encryptTotpSecret('ok', KEY) },
        { slug: 'broken', secretEnc: 'not-a-valid-payload' },
      ],
    };
    const map = decryptQuestPartnerSecrets(store, KEY);
    assert.equal(map.acme, 'ok');
    assert.equal(map.broken, undefined);
  });

  it('mergeQuestPartnerSecrets upserts a new partner (encrypting the secret)', () => {
    const next = mergeQuestPartnerSecrets(
      { partners: [] },
      [{ slug: 'acme', secret: 'brand-new', label: 'Acme' }],
      KEY,
    );
    assert.equal(next.partners.length, 1);
    assert.equal(next.partners[0]!.slug, 'acme');
    assert.equal(next.partners[0]!.label, 'Acme');
    // Stored encrypted, not plaintext.
    assert.notEqual(next.partners[0]!.secretEnc, 'brand-new');
    assert.equal(next.partners[0]!.secretEnc.split(':').length, 3);
  });

  it('mergeQuestPartnerSecrets with empty secret removes the partner (clear semantics)', () => {
    const start = mergeQuestPartnerSecrets({ partners: [] }, [{ slug: 'acme', secret: 'x' }], KEY);
    const cleared = mergeQuestPartnerSecrets(start, [{ slug: 'acme', secret: '' }], KEY);
    assert.deepStrictEqual(cleared.partners, []);
  });

  it('mergeQuestPartnerSecrets updates label without a new secret (secret undefined = keep)', () => {
    const start = mergeQuestPartnerSecrets({ partners: [] }, [{ slug: 'acme', secret: 'keep' }], KEY);
    const enc = start.partners[0]!.secretEnc;
    const updated = mergeQuestPartnerSecrets(start, [{ slug: 'acme', label: 'Renamed' }], KEY);
    assert.equal(updated.partners[0]!.label, 'Renamed');
    assert.equal(updated.partners[0]!.secretEnc, enc); // unchanged
  });
});
