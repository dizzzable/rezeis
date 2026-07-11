import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveQuestPartnerConfig } from '../src/modules/quests/utils/quest-partner-config.util';

describe('resolveQuestPartnerConfig', () => {
  it('parses a manual_code partner config', () => {
    const cfg = resolveQuestPartnerConfig({
      partner: {
        method: 'manual_code',
        partnerSlug: 'acme',
        code: 'PROMO2026',
        landingUrl: 'https://acme.example/offer',
      },
    });
    assert.deepStrictEqual(cfg, {
      method: 'manual_code',
      partnerSlug: 'acme',
      code: 'PROMO2026',
      landingUrl: 'https://acme.example/offer',
      minDwellSeconds: null,
    });
  });

  it('parses a postback partner config (no code / dwell)', () => {
    const cfg = resolveQuestPartnerConfig({
      partner: { method: 'postback', partnerSlug: 'acme', landingUrl: 'https://acme.example/go' },
    });
    assert.equal(cfg?.method, 'postback');
    assert.equal(cfg?.partnerSlug, 'acme');
    assert.equal(cfg?.code, null);
  });

  it('parses a timed_visit config with dwell seconds', () => {
    const cfg = resolveQuestPartnerConfig({
      partner: {
        method: 'timed_visit',
        partnerSlug: 'acme',
        landingUrl: 'https://acme.example/land',
        minDwellSeconds: 30,
      },
    });
    assert.equal(cfg?.method, 'timed_visit');
    assert.equal(cfg?.minDwellSeconds, 30);
  });

  it('rejects an unknown method', () => {
    assert.equal(
      resolveQuestPartnerConfig({ partner: { method: 'wormhole', partnerSlug: 'acme' } }),
      null,
    );
  });

  it('rejects a malformed partnerSlug', () => {
    assert.equal(
      resolveQuestPartnerConfig({ partner: { method: 'postback', partnerSlug: 'BAD SLUG!' } }),
      null,
    );
  });

  it('rejects a non-https landing url', () => {
    assert.equal(
      resolveQuestPartnerConfig({
        partner: { method: 'postback', partnerSlug: 'acme', landingUrl: 'javascript:alert(1)' },
      }),
      null,
    );
  });

  it('rejects a manual_code config with an empty code', () => {
    assert.equal(
      resolveQuestPartnerConfig({
        partner: { method: 'manual_code', partnerSlug: 'acme', code: '' },
      }),
      null,
    );
  });

  it('rejects timed_visit with out-of-range dwell seconds', () => {
    assert.equal(
      resolveQuestPartnerConfig({
        partner: { method: 'timed_visit', partnerSlug: 'acme', landingUrl: 'https://a.example', minDwellSeconds: 99999 },
      }),
      null,
    );
  });

  it('never leaks a raw secret placed in params (secret is not a config field)', () => {
    const cfg = resolveQuestPartnerConfig({
      partner: { method: 'postback', partnerSlug: 'acme', secret: 'super-secret', landingUrl: 'https://a.example' },
    });
    assert.ok(cfg !== null);
    assert.equal((cfg as unknown as Record<string, unknown>).secret, undefined);
  });

  it('returns null for junk', () => {
    for (const junk of [null, 42, 'str', [], {}, { partner: null }, { partner: {} }]) {
      assert.equal(resolveQuestPartnerConfig(junk as never), null);
    }
  });
});
