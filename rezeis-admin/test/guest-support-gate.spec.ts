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
  readonly entries?: ReadonlyArray<{ readonly source: string; readonly kind?: string; readonly value?: string; readonly expiresAt?: Date | null; }>;
  readonly observedOnBlocked?: boolean;
  /** Prior guest conversations from the same machine, inside the window. */
  readonly priorConversations?: number;
  /** Blocked accounts previously seen from the visitor's address. */
  readonly ipMatches?: ReadonlyArray<{ userId: string; hits: number; lastSeenAt: Date }>;
} = {}) {
  const queries: Array<Record<string, unknown>> = [];
  const prisma = {
    blockedIdentity: {
      /**
       * OBEYS the `where` it is handed rather than answering everything.
       *
       * It used to return `options.entries` whatever was asked, which left two
       * of this file's own fixes untestable: delete the expiry filter, or the
       * `(kind, value)` keying, and every test here stayed green — while a
       * thirty-day entry went on silencing guest support for ever and the query
       * fell back to a sequential scan on an unauthenticated endpoint.
       *
       * It applies only what the caller asked for. A stub that enforces a
       * constraint of its own makes "the service dropped it" look exactly like
       * "the service kept it", which is the failure it is here to prevent.
       */
      findMany: async (args: Record<string, unknown>) => {
        queries.push(args);
        const where = (args.where ?? {}) as {
          kind?: string;
          value?: { in?: readonly string[] };
          OR?: ReadonlyArray<{ expiresAt: null | { gt: Date } }>;
        };
        return (options.entries ?? [])
          .filter((e) => where.kind === undefined || (e.kind ?? where.kind) === where.kind)
          .filter((e) => where.value?.in === undefined || e.value === undefined || where.value.in.includes(e.value))
          .filter((e) => {
            if (where.OR === undefined) return true;
            const expiresAt = e.expiresAt ?? null;
            return where.OR.some((arm) =>
              arm.expiresAt === null
                ? expiresAt === null
                : expiresAt !== null && expiresAt > arm.expiresAt.gt,
            );
          })
          .map((e) => ({ ...e, reason: null }));
      },
    },
    deviceObservation: {
      findFirst: async () => (options.observedOnBlocked === true ? { userId: 'u-1' } : null),
    },
    supportGuest: {
      count: async (args: Record<string, unknown>) => {
        queries.push(args);
        return options.priorConversations ?? 0;
      },
    },
  };
  const ipObservations = {
    blockedMatches: async () => options.ipMatches ?? [],
  };
  return {
    service: new GuestGateService(prisma as never, ipObservations as never),
    queries,
  };
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

  it('stops being silenced once the entry has lapsed', async () => {
    // The expiry arm of the query, exercised rather than assumed. An operator
    // may list an identity with an end date, and every other read path honours
    // it — so without this filter a thirty-day entry kept refusing support for
    // ever while reading "not blocked" on every screen. A support ban outliving
    // the ban it came from, and invisible, because the refusal is silent by
    // design.
    const { service } = build({
      entries: [{ source: 'manual', expiresAt: new Date('2020-01-01T00:00:00.000Z') }],
    });

    assert.equal((await service.evaluate({ deviceHash: FP })).kind, 'allow');
  });

  it('is still silenced while the entry is live', async () => {
    // The other half: an end date in the future must not read as lapsed, or the
    // filter would quietly disarm every timed entry instead of just the old ones.
    const { service } = build({
      entries: [{ source: 'manual', expiresAt: new Date('2099-01-01T00:00:00.000Z') }],
    });

    assert.equal((await service.evaluate({ deviceHash: FP })).kind, 'silenced');
  });

  it('ignores a row of another kind that happens to share the value', async () => {
    // The `(kind, value)` keying. Without it the query matched on value alone —
    // an e-mail or a Telegram id equal to a fingerprint string would silence a
    // device, and the read stopped using the index on an endpoint anyone can
    // reach without signing in.
    const { service } = build({
      entries: [{ source: 'manual', kind: 'EMAIL', value: FP }],
    });

    assert.equal((await service.evaluate({ deviceHash: FP })).kind, 'allow');
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

    assert.equal(verdict.kind, 'allow');
    assert.equal((verdict as { flaggedReason: string | null }).flaggedReason, null);
  });
});

describe('what it does with signals it cannot use', () => {
  it('lets a visitor with no signals through, unmarked', async () => {
    // Somebody who blocks them gets exactly what an unrecognised visitor gets.
    // Refusing here would turn a privacy setting into a support ban.
    const { service, queries } = build({ entries: [{ source: 'manual' }] });

    const verdict = await service.evaluate({});

    assert.equal(verdict.kind, 'allow');
    assert.equal((verdict as { flaggedReason: string | null }).flaggedReason, null);
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

describe('the pest who never had an account', () => {
  it('marks a device that keeps coming back', async () => {
    // Everything else here matches against a BLOCKED ACCOUNT, and somebody can
    // flood anonymous support without ever registering — no account, no ban,
    // nothing for those checks to find. What gives them away is the one thing
    // they cannot avoid while using the channel: coming back.
    const { service } = build({ entries: [], priorConversations: 2 });

    const verdict = await service.evaluate({ deviceHash: FP });

    assert.equal(verdict.kind, 'allow');
    assert.match(String((verdict as { flaggedReason: string }).flaggedReason), /3 conversations/);
  });

  it('leaves a second conversation alone', async () => {
    // Two is a person whose first answer did not help. Marking them would put
    // the queue's own regulars under suspicion.
    const { service } = build({ entries: [], priorConversations: 1 });

    const verdict = await service.evaluate({ deviceHash: FP });

    assert.equal(verdict.kind, 'allow');
    assert.equal((verdict as { flaggedReason: string | null }).flaggedReason, null);
  });

  it('counts only inside the window', async () => {
    // An unbounded count eventually marks a customer who has had three separate
    // problems across two years — a loyal customer, not a pest.
    const { service, queries } = build({ entries: [], priorConversations: 0 });

    await service.evaluate({ deviceHash: FP });

    const where = queries[queries.length - 1].where as { createdAt: { gte: Date } };
    const days = (Date.now() - where.createdAt.gte.getTime()) / (24 * 60 * 60 * 1000);
    assert.ok(days > 6.9 && days < 7.1, `window should be a week, got ${days} days`);
  });

  it('does not count when the blocked-account match already spoke', async () => {
    // The stronger reason wins and the count is not even taken — a conversation
    // carries one reason, and "device of a blocked account" is the one an
    // operator acts on.
    const { service } = build({ entries: [{ source: 'cascade' }], priorConversations: 99 });

    const verdict = await service.evaluate({ deviceHash: FP });

    assert.match(
      String((verdict as { flaggedReason: string }).flaggedReason),
      /blocklist from a blocked account/,
    );
  });
});

describe('the address, which on this product says more than the browser', () => {
  it('marks a visitor whose address was seen on a blocked account', async () => {
    // The stronger of the two signals here: it comes from the VPN connection
    // itself — the tunnel is established FROM the customer's real address —
    // rather than from a browser that can decline to answer.
    const { service } = build({
      entries: [],
      ipMatches: [{ userId: 'banned-1', hits: 14, lastSeenAt: new Date() }],
    });

    const verdict = await service.evaluate({ clientIp: '198.51.100.7' });

    assert.equal(verdict.kind, 'allow');
    assert.match(String((verdict as { flaggedReason: string }).flaggedReason), /blocked account/);
  });

  it('carries the sighting count, which is what an operator weighs first', async () => {
    // It separates a home connection from somewhere passed through once.
    const { service } = build({
      entries: [],
      ipMatches: [{ userId: 'banned-1', hits: 14, lastSeenAt: new Date() }],
    });

    const verdict = await service.evaluate({ clientIp: '198.51.100.7' });

    assert.match(String((verdict as { flaggedReason: string }).flaggedReason), /14 sighting/);
  });

  it('checks the address even when the browser reported nothing', async () => {
    // The case the address exists for. Somebody who suppresses device signals
    // still has to connect from somewhere.
    const { service } = build({
      entries: [],
      ipMatches: [{ userId: 'banned-1', hits: 2, lastSeenAt: new Date() }],
    });

    const verdict = await service.evaluate({ clientIp: '198.51.100.7' });

    assert.notEqual((verdict as { flaggedReason: string | null }).flaggedReason, null);
  });

  it('still lets a clean visitor through unmarked', async () => {
    const { service } = build({ entries: [], ipMatches: [] });

    const verdict = await service.evaluate({ clientIp: '198.51.100.7' });

    assert.equal(verdict.kind, 'allow');
    assert.equal((verdict as { flaggedReason: string | null }).flaggedReason, null);
  });

  it('does not let an address override a hand-silenced device', async () => {
    // The operator's explicit decision outranks every automatic signal.
    const { service } = build({
      entries: [{ source: 'manual' }],
      ipMatches: [{ userId: 'banned-1', hits: 2, lastSeenAt: new Date() }],
    });

    assert.equal((await service.evaluate({ deviceHash: FP, clientIp: '198.51.100.7' })).kind, 'silenced');
  });
});

describe('the verdict carries the values the caller must store', () => {
  /**
   * The controller writes `verdict.installId` / `verdict.deviceHash`, NOT the
   * raw body — that is the whole point of returning them, and the comment on
   * the controller says this regression has happened once already.
   *
   * Nothing pinned it: every `...normalised` spread could be deleted and all
   * twenty tests here stayed green, because they only ever asserted `kind` and
   * `flaggedReason`. A verdict without them stores NULL for every visitor, and
   * the whole device half of this feature goes quietly inert.
   */
  it('returns the NORMALISED signal, not what the browser sent', async () => {
    const { service } = build();

    const verdict = await service.evaluate({
      installId: `  ${FP.toUpperCase()}  `,
      deviceHash: undefined,
    });

    assert.equal(verdict.kind, 'allow');
    // Trimmed and lower-cased. Stored raw, this row never matches the
    // blocklist read, which normalises — so the block would be written and then
    // never found.
    assert.equal((verdict as { installId: string | null }).installId, FP);
    assert.equal((verdict as { deviceHash: string | null }).deviceHash, null);
  });

  it('carries them on a FLAGGED verdict too, not just a clean one', async () => {
    // The flagged path is the one that matters most: this is the conversation
    // an operator may press "silence" on, and the button reads the stored
    // fingerprint. A flagged verdict that forgot it leaves that button with
    // nothing to work from.
    const { service } = build({ entries: [{ source: 'cascade' }] });

    const verdict = await service.evaluate({ installId: FP });

    assert.equal(verdict.kind, 'allow');
    assert.notEqual((verdict as { flaggedReason: string | null }).flaggedReason, null);
    assert.equal((verdict as { installId: string | null }).installId, FP);
  });
});
