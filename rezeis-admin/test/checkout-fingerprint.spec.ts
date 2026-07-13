import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AddOnCheckoutFingerprintInput,
  RenewalCheckoutFingerprintInput,
  buildAddOnCheckoutFingerprint,
  buildRenewalCheckoutFingerprint,
  canonicalJson,
  fingerprint,
  findDuplicateAddOnSelection,
} from '../src/modules/payments/utils/checkout-fingerprint.util';

const base: AddOnCheckoutFingerprintInput = {
  contractVersion: 2,
  userId: 'user-1',
  subscriptionId: 'sub-1',
  termId: 'term-1',
  addOnId: 'addon-1',
  addOnRevision: 3,
  type: 'EXTRA_TRAFFIC',
  value: 50,
  lifetime: 'UNTIL_NEXT_RESET',
  gatewayType: 'YOOKASSA',
  channel: 'WEB',
  currency: 'USD',
  amount: '2.50',
};

describe('checkout fingerprint', () => {
  it('is stable regardless of object key insertion order', () => {
    assert.equal(
      canonicalJson({ b: 1, a: 2, c: { y: 1, x: 2 } }),
      canonicalJson({ c: { x: 2, y: 1 }, a: 2, b: 1 }),
    );
  });

  it('ignores undefined fields', () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
  });

  it('produces a deterministic hash for the same composition', () => {
    assert.equal(buildAddOnCheckoutFingerprint(base), buildAddOnCheckoutFingerprint({ ...base }));
  });

  it('changes when any commercial field changes', () => {
    const original = buildAddOnCheckoutFingerprint(base);
    const mutations: Array<Partial<AddOnCheckoutFingerprintInput>> = [
      { subscriptionId: 'sub-2' },
      { addOnId: 'addon-2' },
      { addOnRevision: 4 },
      { type: 'EXTRA_DEVICES' },
      { value: 100 },
      { lifetime: 'UNTIL_SUBSCRIPTION_END' },
      { gatewayType: 'CRYPTOPAY' },
      { channel: 'TMA' },
      { currency: 'RUB' },
      { amount: '2.51' },
      { termId: null },
      { userId: 'user-2' },
      { contractVersion: 1 },
    ];
    for (const mutation of mutations) {
      assert.notEqual(
        buildAddOnCheckoutFingerprint({ ...base, ...mutation }),
        original,
        `mutation ${JSON.stringify(mutation)} must change the fingerprint`,
      );
    }
  });

  it('serializes bigint deterministically as a string', () => {
    assert.equal(canonicalJson({ v: 10n }), '{"v":"10"}');
  });

  it('fingerprint is a 64-char hex sha256', () => {
    assert.match(fingerprint(base), /^[0-9a-f]{64}$/);
  });
});

const renewalBase: RenewalCheckoutFingerprintInput = {
  contractVersion: 2,
  userId: 'user-1',
  gatewayType: 'YOOKASSA',
  channel: 'WEB',
  currency: 'USD',
  lines: [
    {
      subscriptionId: 'sub-a',
      planId: 'plan-a',
      durationDays: 30,
      termId: 'term-a',
      addOns: [
        { addOnId: 'addon-1', addOnRevision: 2, type: 'EXTRA_TRAFFIC', value: 50, lifetime: 'UNTIL_SUBSCRIPTION_END', activation: 'TERM_START' },
      ],
    },
    {
      subscriptionId: 'sub-b',
      planId: 'plan-b',
      durationDays: 90,
      termId: 'term-b',
      addOns: [],
    },
  ],
};

describe('renewal checkout fingerprint (T-007)', () => {
  it('is stable regardless of line and add-on ordering', () => {
    const reordered: RenewalCheckoutFingerprintInput = {
      ...renewalBase,
      lines: [
        renewalBase.lines[1]!,
        {
          ...renewalBase.lines[0]!,
          addOns: [...renewalBase.lines[0]!.addOns].reverse(),
        },
      ],
    };
    assert.equal(buildRenewalCheckoutFingerprint(renewalBase), buildRenewalCheckoutFingerprint(reordered));
  });

  it('differs for the same total but different products', () => {
    const swapped: RenewalCheckoutFingerprintInput = {
      ...renewalBase,
      lines: [
        {
          ...renewalBase.lines[0]!,
          addOns: [
            { addOnId: 'addon-9', addOnRevision: 1, type: 'EXTRA_DEVICES', value: 2, lifetime: 'UNTIL_SUBSCRIPTION_END', activation: 'TERM_START' },
          ],
        },
        renewalBase.lines[1]!,
      ],
    };
    assert.notEqual(buildRenewalCheckoutFingerprint(renewalBase), buildRenewalCheckoutFingerprint(swapped));
  });

  it('changes when any composition field changes (revision/lifetime/duration/term/activation)', () => {
    const original = buildRenewalCheckoutFingerprint(renewalBase);
    const mutate = (line0: Partial<RenewalCheckoutFingerprintInput['lines'][number]['addOns'][number]>): string => {
      const l0 = renewalBase.lines[0]!;
      return buildRenewalCheckoutFingerprint({
        ...renewalBase,
        lines: [{ ...l0, addOns: [{ ...l0.addOns[0]!, ...line0 }] }, renewalBase.lines[1]!],
      });
    };
    assert.notEqual(mutate({ addOnRevision: 3 }), original);
    assert.notEqual(mutate({ lifetime: 'UNTIL_NEXT_RESET' }), original);
    assert.notEqual(mutate({ activation: 'NOW' }), original);
    assert.notEqual(mutate({ value: 100 }), original);
    // Line-level fields
    assert.notEqual(
      buildRenewalCheckoutFingerprint({ ...renewalBase, lines: [{ ...renewalBase.lines[0]!, durationDays: 365 }, renewalBase.lines[1]!] }),
      original,
    );
    assert.notEqual(
      buildRenewalCheckoutFingerprint({ ...renewalBase, lines: [{ ...renewalBase.lines[0]!, termId: 'term-x' }, renewalBase.lines[1]!] }),
      original,
    );
  });

  it('is a 64-char hex sha256', () => {
    assert.match(buildRenewalCheckoutFingerprint(renewalBase), /^[0-9a-f]{64}$/);
  });

  it('detects a duplicate add-on selection within a line', () => {
    const dup: RenewalCheckoutFingerprintInput = {
      ...renewalBase,
      lines: [
        {
          ...renewalBase.lines[0]!,
          addOns: [
            renewalBase.lines[0]!.addOns[0]!,
            { ...renewalBase.lines[0]!.addOns[0]! },
          ],
        },
      ],
    };
    const found = findDuplicateAddOnSelection(dup);
    assert.notEqual(found, null);
    assert.equal(found!.addOnId, 'addon-1');
    assert.equal(found!.subscriptionId, 'sub-a');
  });

  it('returns null when every line has unique add-on picks', () => {
    assert.equal(findDuplicateAddOnSelection(renewalBase), null);
  });
});
