import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GuestGateService } from '../src/modules/support-tickets/services/guest-gate.service';

/**
 * Anonymous support, and the person who came back
 * ═══════════════════════════════════════════════
 *
 * Guest support is the one surface with no identity at all, and that is the
 * point: it is how somebody appeals a ban, or reaches us when their account is
 * broken. It is also, for the same reason, where a banned person returns — a
 * fresh incognito window is a fresh visitor, the per-IP limiter is a speed bump
 * and a captcha stops robots rather than a motivated human.
 *
 * ── The distinction this file exists to protect ───────────────────────────
 *
 * MARK is automatic; SILENCE is always a person's decision.
 *
 * They must not collapse into one. `UserBlockService` copies every blocked
 * account's device fingerprints into the blocklist automatically, so a gate
 * that refused on any of them would make every ban close the appeal door
 * behind it — and a ban issued by mistake, or by a rule at three in the
 * morning over a failed payment, would be unappealable. A noisy queue is
 * visible; that would not be.
 */

const FP = 'a1b2c3d4e5f6a7b8';
const OTHER = 'ffffffffffffffff';

function build(options: {
  readonly entries?: ReadonlyArray<{ source: string }>;
  readonly observedOnBlocked?: boolean;
} = {}) {
  const queries: Array<Record<string, unknown>> = [];
  const prisma = {
    blockedIdentity: {
      findMany: async (args: Record<string, unknown>) => {
        queries.push(args);
        return (options.entries ?? []).map((entry) => ({ ...entry, reason: null }));
      },
    },
    deviceObservation: {
      findFirst: async () => (options.observedOnBlocked === true ? { userId: 'u-1' } : null),
    },
  };
  return { service: new GuestGateService(prisma as never), queries };
}

describe('a device an operator silenced by hand', () => {
  it('is turned away', async () => {
    const { service } = build({ entries: [{ source: 'manual' }] });

    const verdict = await service.evaluate({ deviceHash: FP });

    assert.equal(verdict.kind, 'silenced');
  });

  it('is still silenced when a cascade row sits beside the manual one', async () => {
    // A device carrying both is one the operator already judged; the explicit
    // decision outranks the automatic mark.
    const { service } = build({ entries: [{ source: 'cascade' }, { source: 'manual' }] });

    assert.equal((await service.evaluate({ installId: FP })).kind, 'silenced');
  });
});

describe('a device merely belonging to a blocked account', () => {
  it('is let through, and marked', async () => {
    // THE case the whole design turns on. `UserBlockService` writes a cascade
    // row for every blocked account, so refusing here would silence support for
    // everybody who was ever banned — including whoever was banned wrongly.
    const { service } = build({ entries: [{ source: 'cascade' }] });

    const verdict = await service.evaluate({ deviceHash: FP });

    assert.equal(verdict.kind, 'allow');
    assert.notEqual((verdict as { flaggedReason: string | null }).flaggedReason, null);
  });

  it('is let through and marked when only an observation matches', async () => {
    // An account can be blocked without its devices ever having been readable,
    // so the observation table catches what the blocklist copy missed.
    const { service } = build({ entries: [], observedOnBlocked: true });

    const verdict = await service.evaluate({ deviceHash: FP });

    assert.equal(verdict.kind, 'allow');
    assert.match(String((verdict as { flaggedReason: string }).flaggedReason), /blocked account/);
  });

  it('is let through UNMARKED when nothing matches', async () => {
    // The positive control: the mark means something only if most visitors do
    // not carry it.
    const { service } = build({ entries: [], observedOnBlocked: false });

    const verdict = await service.evaluate({ deviceHash: OTHER });

    assert.deepStrictEqual(verdict, { kind: 'allow', flaggedReason: null });
  });
});

describe('what it does with signals it cannot use', () => {
  it('lets a visitor with no signals through, unmarked', async () => {
    // Somebody who blocks them gets exactly what an unrecognised visitor gets.
    // Refusing here would turn a privacy setting into a support ban.
    const { service, queries } = build({ entries: [{ source: 'manual' }] });

    const verdict = await service.evaluate({});

    assert.deepStrictEqual(verdict, { kind: 'allow', flaggedReason: null });
    assert.deepStrictEqual(queries, [], 'and asks the database nothing');
  });

  it('treats a malformed signal as absent rather than as a miss', async () => {
    // `x` is too short to identify anything; it is a bad input, not evidence.
    const { service, queries } = build({ entries: [{ source: 'manual' }] });

    const verdict = await service.evaluate({ installId: 'x', deviceHash: '  ' });

    assert.equal(verdict.kind, 'allow');
    assert.deepStrictEqual(queries, []);
  });

  it('normalises before looking, so case cannot slip past an entry', async () => {
    const { service, queries } = build({ entries: [] });

    await service.evaluate({ deviceHash: FP.toUpperCase() });

    const where = queries[0].where as { value: { in: string[] } };
    assert.deepStrictEqual(where.value.in, [FP]);
  });

  it('looks up both signals in one query', async () => {
    const { service, queries } = build({ entries: [] });

    await service.evaluate({ installId: FP, deviceHash: OTHER });

    const where = queries[0].where as { value: { in: string[] } };
    assert.deepStrictEqual(where.value.in, [FP, OTHER]);
  });
});
