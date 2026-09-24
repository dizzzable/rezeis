import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AddOnCheckoutFingerprintInput,
  RenewalCheckoutFingerprintInput,
  buildAddOnCheckoutFingerprint,
  buildRenewalCheckoutFingerprint,
  canonicalJson,
  fingerprint,
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
    { subscriptionId: 'sub-a', planId: 'plan-a', durationDays: 30, termId: 'term-a' },
    { subscriptionId: 'sub-b', planId: 'plan-b', durationDays: 90, termId: 'term-b' },
  ],
};

describe('renewal checkout fingerprint (T-007)', () => {
  it('is stable regardless of line ordering', () => {
    const reordered: RenewalCheckoutFingerprintInput = {
      ...renewalBase,
      lines: [renewalBase.lines[1]!, renewalBase.lines[0]!],
    };
    assert.equal(buildRenewalCheckoutFingerprint(renewalBase), buildRenewalCheckoutFingerprint(reordered));
  });

  it('differs for the same total but a different plan', () => {
    const swapped: RenewalCheckoutFingerprintInput = {
      ...renewalBase,
      lines: [{ ...renewalBase.lines[0]!, planId: 'plan-z' }, renewalBase.lines[1]!],
    };
    assert.notEqual(buildRenewalCheckoutFingerprint(renewalBase), buildRenewalCheckoutFingerprint(swapped));
  });

  it('changes when any composition field changes (plan/duration/term)', () => {
    const original = buildRenewalCheckoutFingerprint(renewalBase);
    const withLine0 = (patch: Partial<RenewalCheckoutFingerprintInput['lines'][number]>): string =>
      buildRenewalCheckoutFingerprint({
        ...renewalBase,
        lines: [{ ...renewalBase.lines[0]!, ...patch }, renewalBase.lines[1]!],
      });
    assert.notEqual(withLine0({ durationDays: 365 }), original);
    assert.notEqual(withLine0({ termId: 'term-x' }), original);
    assert.notEqual(withLine0({ termId: null }), original);
  });

  it('keeps the fingerprint every renewal draft stored before renewal add-ons were deleted carries', () => {
    // Computed with the code as it stood before 24.09.2026, for a renewal
    // without add-ons — the only kind that was ever sold, stage 5 having never
    // been on by default. A keyed replay or a draft reuse finds its draft by
    // this value, so the lines still hash `addOns: []`.
    assert.equal(
      buildRenewalCheckoutFingerprint(renewalBase),
      'fb8b26d559098b04af33db20b7743cf53c07663f6d67e2f5db855b2935c1947d',
    );
    assert.equal(
      buildRenewalCheckoutFingerprint({ ...renewalBase, savedPaymentMethodId: 'spm-1', providerSubscription: true }),
      'a352a99408d035d1afe4a31a20c776dad52baf20eff1e2fbad5eb0c664aa546e',
    );
  });

  it('is a 64-char hex sha256', () => {
    assert.match(buildRenewalCheckoutFingerprint(renewalBase), /^[0-9a-f]{64}$/);
  });
});
