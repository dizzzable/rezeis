import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TrafficResetService } from '../src/modules/add-ons/services/traffic-reset.service';

/**
 * The traffic-reset add-on: an ACTION, and a free allowance counted per term.
 *
 * The assertion that protects a customer is the ORDER one: the history row is
 * written only after the panel has zeroed the counter, because that same row is
 * what the free allowance is counted from. Writing it first would let a panel
 * failure both lie about a reset that never happened and burn one of their free
 * uses.
 */

function build(options: {
  readonly resets?: ReadonlyArray<{
    subscriptionId: string;
    termId: string | null;
    transactionId?: string | null;
  }>;
  readonly subscription?: Record<string, unknown> | null;
  readonly panelAnswer?: 'ok' | 'refused';
  readonly noPanel?: boolean;
  readonly addOn?: Record<string, unknown> | null;
  readonly termId?: { id: string } | null;
}) {
  const rows: Array<{ subscriptionId: string; termId: string | null; transactionId?: string | null }> =
    [...(options.resets ?? [])];
  const created: Array<Record<string, unknown>> = [];
  const resetCalls: number[] = [];

  const counts: Array<Record<string, unknown>> = []
  const prisma = {
    subscriptionTrafficReset: {
      count: async ({ where }: { where: Record<string, unknown> }) => (
        counts.push(where),
        rows.filter(
          (r) =>
            r.subscriptionId === where.subscriptionId &&
            (where.termId === undefined || r.termId === where.termId) &&
            // Obeyed, not ignored: the allowance counts only the FREE ones, and
            // a stub that dropped this would let a purchase eat the free use
            // with every test still green.
            (where.transactionId === undefined ||
              (r.transactionId ?? null) === where.transactionId),
        ).length
      ),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        rows.push({
          subscriptionId: String(data.subscriptionId),
          termId: (data.termId as string | null) ?? null,
          transactionId: (data.transactionId as string | null) ?? null,
        });
        return data;
      },
    },
    addOn: {
      findUnique: async () => options.addOn ?? {
        id: 'a-1',
        type: 'RESET_TRAFFIC',
        isActive: true,
        freeUsesPerTerm: 1,
      },
    },
    subscriptionTerm: {
      // OBEYS the status it is handed. Answering regardless let the query be
      // changed from ACTIVE to ENDED with every test still green — and the
      // allowance would then have been counted against a term the customer had
      // already finished, handing out a fresh set of free resets on a stale
      // row.
      findFirst: async ({ where }: { where: { status: string } }) => {
        if (where.status !== 'ACTIVE') return null;
        return options.termId === undefined ? { id: 't-1' } : options.termId;
      },
    },
    subscription: {
      findUnique: async () =>
        options.subscription === undefined
          ? { id: 'sub-1', remnawaveId: '42', configUrl: null }
          : options.subscription,
    },
  };

  const panelUsers =
    options.noPanel === true
      ? undefined
      : {
          resetTraffic: async (userId: number) => {
            resetCalls.push(userId);
            return options.panelAnswer === 'refused'
              ? { kind: 'rejected' as const, status: 500, code: null, detail: null }
              : { kind: 'ok' as const, data: {} };
          },
        };

  return {
    service: new TrafficResetService(prisma as never, panelUsers as never),
    created,
    resetCalls,
    counts,
  };
}

describe('the free allowance', () => {
  it('is never free when the operator configured no free uses', async () => {
    const { service, counts } = build({});

    const allowance = await service.describeAllowance({
      subscriptionId: 'sub-1',
      termId: 't-1',
      freeUsesPerTerm: 0,
    });

    assert.equal(allowance.isFree, false);
    assert.equal(allowance.freeRemaining, 0);
    // …AND DOES NOT ASK THE DATABASE. "Always paid" is the common case, and the
    // answer needs no count: the early return is what keeps a listing of many
    // add-ons from issuing one query each to learn nothing.
    assert.deepStrictEqual(counts, [], 'counted resets for an add-on that is never free');
  });

  it('is free while uses remain on this term', async () => {
    const { service } = build({ resets: [{ subscriptionId: 'sub-1', termId: 't-1' }] });

    const allowance = await service.describeAllowance({
      subscriptionId: 'sub-1',
      termId: 't-1',
      freeUsesPerTerm: 2,
    });

    assert.equal(allowance.usedThisTerm, 1);
    assert.equal(allowance.freeRemaining, 1);
    assert.equal(allowance.isFree, true);
  });

  it('stops being free once the allowance is spent', async () => {
    const { service } = build({
      resets: [
        { subscriptionId: 'sub-1', termId: 't-1' },
        { subscriptionId: 'sub-1', termId: 't-1' },
      ],
    });

    const allowance = await service.describeAllowance({
      subscriptionId: 'sub-1',
      termId: 't-1',
      freeUsesPerTerm: 2,
    });

    assert.equal(allowance.freeRemaining, 0);
    assert.equal(allowance.isFree, false);
  });

  it('refreshes on a new term — that is what "per term" means', async () => {
    // The whole point of counting per term rather than for all time: the
    // allowance comes back when the customer renews.
    const { service } = build({
      resets: [
        { subscriptionId: 'sub-1', termId: 'old-term' },
        { subscriptionId: 'sub-1', termId: 'old-term' },
      ],
    });

    const allowance = await service.describeAllowance({
      subscriptionId: 'sub-1',
      termId: 'new-term',
      freeUsesPerTerm: 1,
    });

    assert.equal(allowance.usedThisTerm, 0);
    assert.equal(allowance.isFree, true);
  });

  it('does not let a PAID reset eat the free one', async () => {
    // The defect this guards: a customer who buys a reset before ever taking
    // their free one would find it gone — having paid for the privilege of
    // losing it. Only spending the allowance spends it.
    const { service } = build({
      resets: [{ subscriptionId: 'sub-1', termId: 't-1', transactionId: 'tx-9' }],
    });

    const allowance = await service.describeAllowance({
      subscriptionId: 'sub-1',
      termId: 't-1',
      freeUsesPerTerm: 1,
    });

    assert.equal(allowance.usedThisTerm, 0, 'a purchase consumed the free allowance');
    assert.equal(allowance.isFree, true);
  });

  it('does not count another subscription’s resets', async () => {
    const { service } = build({ resets: [{ subscriptionId: 'other', termId: 't-1' }] });

    const allowance = await service.describeAllowance({
      subscriptionId: 'sub-1',
      termId: 't-1',
      freeUsesPerTerm: 1,
    });

    assert.equal(allowance.usedThisTerm, 0);
  });

  it('counts every reset ever for a subscription with no term', async () => {
    // A row that predates the term ledger. Counting all of them can only make
    // the allowance run out sooner — never hand out more free resets than the
    // operator configured, which is the safe direction to be wrong in.
    const { service } = build({
      resets: [
        { subscriptionId: 'sub-1', termId: 'a' },
        { subscriptionId: 'sub-1', termId: 'b' },
      ],
    });

    const allowance = await service.describeAllowance({
      subscriptionId: 'sub-1',
      termId: null,
      freeUsesPerTerm: 2,
    });

    assert.equal(allowance.usedThisTerm, 2);
    assert.equal(allowance.isFree, false);
  });
});

describe('performing the reset', () => {
  it('zeroes the panel counter and records it', async () => {
    const { service, created, resetCalls } = build({});

    const outcome = await service.perform({
      subscriptionId: 'sub-1',
      termId: 't-1',
      addOnId: 'a-1',
      transactionId: 'tx-1',
    });

    assert.equal(outcome.ok, true);
    assert.deepStrictEqual(resetCalls, [42]);
    assert.equal(created.length, 1);
    assert.equal(created[0]?.transactionId, 'tx-1');
  });

  it('records a FREE reset with no transaction', async () => {
    const { service, created } = build({});

    await service.perform({
      subscriptionId: 'sub-1',
      termId: 't-1',
      addOnId: 'a-1',
      transactionId: null,
    });

    assert.equal(created[0]?.transactionId, null);
  });

  it('writes NOTHING when the panel refuses', async () => {
    // The row is the allowance counter. Writing it for a reset that never
    // happened would tell the customer it did AND spend one of their free uses.
    const { service, created } = build({ panelAnswer: 'refused' });

    const outcome = await service.perform({
      subscriptionId: 'sub-1',
      termId: 't-1',
      addOnId: 'a-1',
      transactionId: null,
    });

    assert.equal(outcome.ok, false);
    assert.deepStrictEqual(created, [], 'burned a free use on a reset that did not happen');
  });

  it('refuses a subscription with no panel profile, without calling the panel', async () => {
    const { service, resetCalls, created } = build({
      subscription: { id: 'sub-1', remnawaveId: null, configUrl: null },
    });

    const outcome = await service.perform({
      subscriptionId: 'sub-1',
      termId: null,
      addOnId: null,
      transactionId: null,
    });

    assert.equal(outcome.ok, false);
    assert.deepStrictEqual(resetCalls, []);
    assert.deepStrictEqual(created, []);
  });

  it('refuses when the integration is not configured', async () => {
    const { service, created } = build({ noPanel: true });

    const outcome = await service.perform({
      subscriptionId: 'sub-1',
      termId: null,
      addOnId: null,
      transactionId: null,
    });

    assert.equal(outcome.ok, false);
    assert.deepStrictEqual(created, []);
  });

  it('refuses a subscription that does not exist', async () => {
    const { service, created } = build({ subscription: null });

    const outcome = await service.perform({
      subscriptionId: 'ghost',
      termId: null,
      addOnId: null,
      transactionId: null,
    });

    assert.equal(outcome.ok, false);
    assert.deepStrictEqual(created, []);
  });
});

describe('claiming a FREE reset', () => {
  it('performs it and records it with no transaction', async () => {
    const { service, created, resetCalls } = build({});

    const outcome = await service.claimFree({ subscriptionId: 'sub-1', addOnId: 'a-1' });

    assert.equal(outcome.ok, true);
    assert.deepStrictEqual(resetCalls, [42]);
    assert.equal(created[0]?.transactionId, null);
    assert.equal(created[0]?.termId, 't-1');
  });

  it('REFUSES once the allowance is spent — it does not fall through to charging', async () => {
    // Falling through to a paid purchase would take money from somebody who
    // pressed a button that said the word "free".
    const { service, created, resetCalls } = build({
      resets: [{ subscriptionId: 'sub-1', termId: 't-1' }],
    });

    const outcome = await service.claimFree({ subscriptionId: 'sub-1', addOnId: 'a-1' });

    assert.equal(outcome.ok, false);
    assert.match(String(outcome.reason), /used up/i);
    assert.deepStrictEqual(resetCalls, [], 'reset a counter it had just refused to reset');
    assert.deepStrictEqual(created, []);
  });

  it('re-checks the allowance itself rather than trusting the offer', async () => {
    // Two tabs, a double tap or a replayed request each read "free" from the
    // same stale offer. The second call must find the row the first one wrote.
    const { service, created } = build({});

    const first = await service.claimFree({ subscriptionId: 'sub-1', addOnId: 'a-1' });
    const second = await service.claimFree({ subscriptionId: 'sub-1', addOnId: 'a-1' });

    assert.equal(first.ok, true);
    assert.equal(second.ok, false, 'spent an allowance of one twice');
    assert.equal(created.length, 1);
  });

  it('refuses an add-on that is not a reset', async () => {
    const { service, resetCalls } = build({
      addOn: { id: 'a-1', type: 'EXTRA_TRAFFIC', isActive: true, freeUsesPerTerm: 5 },
    });

    const outcome = await service.claimFree({ subscriptionId: 'sub-1', addOnId: 'a-1' });

    assert.equal(outcome.ok, false);
    assert.deepStrictEqual(resetCalls, []);
  });

  it('refuses a disabled add-on', async () => {
    const { service } = build({
      addOn: { id: 'a-1', type: 'RESET_TRAFFIC', isActive: false, freeUsesPerTerm: 1 },
    });

    assert.equal((await service.claimFree({ subscriptionId: 'sub-1', addOnId: 'a-1' })).ok, false);
  });

  it('refuses when the operator configured no free uses', async () => {
    const { service } = build({
      addOn: { id: 'a-1', type: 'RESET_TRAFFIC', isActive: true, freeUsesPerTerm: 0 },
    });

    assert.equal((await service.claimFree({ subscriptionId: 'sub-1', addOnId: 'a-1' })).ok, false);
  });
});
