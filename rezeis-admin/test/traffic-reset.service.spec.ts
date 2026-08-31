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
    id?: string;
    subscriptionId: string;
    termId: string | null;
    addOnId?: string | null;
    transactionId?: string | null;
  }>;
  readonly ownerUserId?: string;
  readonly subscription?: Record<string, unknown> | null;
  readonly panelAnswer?: 'ok' | 'refused';
  readonly noPanel?: boolean;
  readonly addOn?: Record<string, unknown> | null;
  readonly termId?: { id: string } | null;
}) {
  const rows: Array<{
    id?: string;
    subscriptionId: string;
    termId: string | null;
    addOnId?: string | null;
    transactionId?: string | null;
  }> = [...(options.resets ?? [])];
  const created: Array<Record<string, unknown>> = [];
  const resetCalls: number[] = [];

  const counts: Array<Record<string, unknown>> = []
  const deleted: string[] = [];
  const rowsWhenPanelCalled: number[] = [];
  const owner = options.ownerUserId ?? 'user-1';
  let nextRowId = 1;
  const prisma: Record<string, unknown> = {
    // A FREE claim runs inside one of these. The fake hands the SAME object
    // back, so every read and write the claim performs is the fake's own — a
    // `$transaction` that ignored its callback would make the reservation
    // invisible and the race test meaningless.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    // The `SELECT … FOR UPDATE` on the subscription row. Answers with the
    // OWNER, because that is what the claim compares against: a fake that
    // returned a row with no `user_id` would make the ownership check
    // untestable and an IDOR invisible.
    $queryRaw: async () =>
      options.subscription === null ? [] : [{ id: 'sub-1', user_id: owner }],
    user: {
      findFirst: async ({ where }: { where: { telegramId: bigint } }) =>
        String(where.telegramId) === '777' ? { id: owner } : null,
    },
    subscriptionTrafficReset: {
      count: async ({ where }: { where: Record<string, unknown> }) => (
        counts.push(where),
        rows.filter(
          (r) =>
            r.subscriptionId === where.subscriptionId &&
            (where.termId === undefined || r.termId === where.termId) &&
            // Obeyed for the same reason: the pool is per add-on, so a stub
            // that ignored this would let two reset options silently share one
            // allowance with every test still green.
            (where.addOnId === undefined || (r.addOnId ?? null) === where.addOnId) &&
            // Obeyed, not ignored: the allowance counts only the FREE ones, and
            // a stub that dropped this would let a purchase eat the free use
            // with every test still green.
            (where.transactionId === undefined ||
              (r.transactionId ?? null) === where.transactionId),
        ).length
      ),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = `row-${nextRowId++}`;
        created.push(data);
        rows.push({
          id,
          subscriptionId: String(data.subscriptionId),
          termId: (data.termId as string | null) ?? null,
          addOnId: (data.addOnId as string | null) ?? null,
          transactionId: (data.transactionId as string | null) ?? null,
        });
        return { ...data, id };
      },
      delete: async ({ where }: { where: { id: string } }) => {
        deleted.push(where.id);
        const at = rows.findIndex((r) => r.id === where.id);
        if (at >= 0) rows.splice(at, 1);
        return {};
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
          ? {
              id: 'sub-1',
              remnawaveId: '42',
              remnawavePanelId: null,
              remnawavePanelUsername: null,
              configUrl: null,
            }
          : options.subscription,
    },
  };

  const panelUsers =
    options.noPanel === true
      ? undefined
      : {
          resetTraffic: async (userId: number) => {
            resetCalls.push(userId);
            // How many rows existed AT THE MOMENT the panel was called. This is
            // the whole ordering assertion: a reservation written first is
            // visible here, and the count-then-reset order that shipped is not.
            rowsWhenPanelCalled.push(rows.length);
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
    deleted,
    rows,
    rowsWhenPanelCalled,
  };
}

describe('the free allowance', () => {
  it('is never free when the operator configured no free uses', async () => {
    const { service, counts } = build({});

    const allowance = await service.describeAllowance({
      subscriptionId: 'sub-1',
      termId: 't-1',
      addOnId: 'a-1',
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
    const { service } = build({ resets: [{ subscriptionId: 'sub-1', termId: 't-1', addOnId: 'a-1' }] });

    const allowance = await service.describeAllowance({
      subscriptionId: 'sub-1',
      termId: 't-1',
      addOnId: 'a-1',
      freeUsesPerTerm: 2,
    });

    assert.equal(allowance.usedThisTerm, 1);
    assert.equal(allowance.freeRemaining, 1);
    assert.equal(allowance.isFree, true);
  });

  it('stops being free once the allowance is spent', async () => {
    const { service } = build({
      resets: [
        { subscriptionId: 'sub-1', termId: 't-1', addOnId: 'a-1' },
        { subscriptionId: 'sub-1', termId: 't-1', addOnId: 'a-1' },
      ],
    });

    const allowance = await service.describeAllowance({
      subscriptionId: 'sub-1',
      termId: 't-1',
      addOnId: 'a-1',
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
      addOnId: 'a-1',
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
      resets: [{ subscriptionId: 'sub-1', termId: 't-1', addOnId: 'a-1', transactionId: 'tx-9' }],
    });

    const allowance = await service.describeAllowance({
      subscriptionId: 'sub-1',
      termId: 't-1',
      addOnId: 'a-1',
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
      addOnId: 'a-1',
      freeUsesPerTerm: 1,
    });

    assert.equal(allowance.usedThisTerm, 0);
  });

  it('treats the empty-string term the offer uses as no term at all', async () => {
    // `AddOnEligibilityService` says `''` for "no term row" while the reset
    // rows store `null`. Unnormalised, the offer counted `termId: ''`, matched
    // nothing, and told every term-less subscription its next reset was free —
    // which the claim, reading `null`, then refused.
    const { service } = build({
      resets: [{ subscriptionId: 'sub-1', termId: null, addOnId: 'a-1' }],
    });

    const allowance = await service.describeAllowance({
      subscriptionId: 'sub-1',
      termId: '',
      addOnId: 'a-1',
      freeUsesPerTerm: 1,
    });

    assert.equal(allowance.usedThisTerm, 1);
    assert.equal(allowance.isFree, false, 'offered a free reset the claim would refuse');
  });

  it('counts every reset ever for a subscription with no term', async () => {
    // A row that predates the term ledger. Counting all of them can only make
    // the allowance run out sooner — never hand out more free resets than the
    // operator configured, which is the safe direction to be wrong in.
    const { service } = build({
      resets: [
        { subscriptionId: 'sub-1', termId: 'a', addOnId: 'a-1' },
        { subscriptionId: 'sub-1', termId: 'b', addOnId: 'a-1' },
      ],
    });

    const allowance = await service.describeAllowance({
      subscriptionId: 'sub-1',
      termId: null,
      addOnId: 'a-1',
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

const OWNER = { userId: 'user-1' } as const;

describe('claiming a FREE reset', () => {
  it('performs it and records it with no transaction', async () => {
    const { service, created, resetCalls } = build({});

    const outcome = await service.claimFree({
      subscriptionId: 'sub-1',
      addOnId: 'a-1',
      owner: OWNER,
    });

    assert.equal(outcome.ok, true);
    assert.deepStrictEqual(resetCalls, [42]);
    assert.equal(created[0]?.transactionId, null);
    assert.equal(created[0]?.termId, 't-1');
    assert.equal(created[0]?.addOnId, 'a-1');
  });

  it('REFUSES once the allowance is spent — it does not fall through to charging', async () => {
    // Falling through to a paid purchase would take money from somebody who
    // pressed a button that said the word "free".
    const { service, created, resetCalls } = build({
      resets: [{ subscriptionId: 'sub-1', termId: 't-1', addOnId: 'a-1' }],
    });

    const outcome = await service.claimFree({
      subscriptionId: 'sub-1',
      addOnId: 'a-1',
      owner: OWNER,
    });

    assert.equal(outcome.ok, false);
    assert.match(String(outcome.reason), /used up/i);
    assert.deepStrictEqual(resetCalls, [], 'reset a counter it had just refused to reset');
    assert.deepStrictEqual(created, []);
  });

  it('re-checks the allowance itself rather than trusting the offer', async () => {
    // Two tabs, a double tap or a replayed request each read "free" from the
    // same stale offer. The second call must find the row the first one wrote.
    const { service, created } = build({});

    const first = await service.claimFree({ subscriptionId: 'sub-1', addOnId: 'a-1', owner: OWNER });
    const second = await service.claimFree({ subscriptionId: 'sub-1', addOnId: 'a-1', owner: OWNER });

    assert.equal(first.ok, true);
    assert.equal(second.ok, false, 'spent an allowance of one twice');
    assert.equal(created.length, 1);
  });

  it('RESERVES before calling the panel, so a second claim cannot read nought used', async () => {
    // The defect this replaces: count, then a panel round trip, then insert.
    // Two tabs both read nought inside that window and both reset.
    const { service, created, rowsWhenPanelCalled } = build({});

    const outcome = await service.claimFree({
      subscriptionId: 'sub-1',
      addOnId: 'a-1',
      owner: OWNER,
    });

    assert.equal(outcome.ok, true);
    assert.equal(created.length, 1);
    assert.deepStrictEqual(
      rowsWhenPanelCalled,
      [1],
      'the panel was called before the reservation existed — the window two tabs raced through',
    );
  });

  it('gives the free use BACK when the panel refuses', async () => {
    // A reservation is not a charge. The panel said no, so the customer must
    // still have the free reset they started with.
    const { service, deleted, rows } = build({ panelAnswer: 'refused' });

    const outcome = await service.claimFree({
      subscriptionId: 'sub-1',
      addOnId: 'a-1',
      owner: OWNER,
    });

    assert.equal(outcome.ok, false);
    assert.equal(deleted.length, 1, 'kept a reservation for a reset that never happened');
    assert.deepStrictEqual(rows, [], 'burned a free use on a refusal');
  });

  it('refuses a subscription that belongs to somebody else', async () => {
    // The endpoint took a subscription id from the path and reset whatever it
    // named. Anyone with a session could zero a stranger's traffic and spend
    // their allowance.
    const { service, resetCalls, created } = build({ ownerUserId: 'someone-else' });

    const outcome = await service.claimFree({
      subscriptionId: 'sub-1',
      addOnId: 'a-1',
      owner: OWNER,
    });

    assert.equal(outcome.ok, false);
    assert.match(String(outcome.reason), /not found/i, 'told the caller the id exists');
    assert.deepStrictEqual(resetCalls, [], 'reset a stranger subscription');
    assert.deepStrictEqual(created, []);
  });

  it('refuses when the caller has no identity at all', async () => {
    const { service, resetCalls } = build({});

    const outcome = await service.claimFree({
      subscriptionId: 'sub-1',
      addOnId: 'a-1',
      owner: {},
    });

    assert.equal(outcome.ok, false);
    assert.deepStrictEqual(resetCalls, []);
  });

  it('accepts a telegram identity, resolved to the same owner', async () => {
    const { service, resetCalls } = build({});

    const outcome = await service.claimFree({
      subscriptionId: 'sub-1',
      addOnId: 'a-1',
      owner: { telegramId: '777' },
    });

    assert.equal(outcome.ok, true);
    assert.deepStrictEqual(resetCalls, [42]);
  });

  it('counts a DIFFERENT reset option separately', async () => {
    // The setting lives on the add-on, so the pool does too. Shared, spending
    // the allowance on one option would silently take the other one's.
    const { service } = build({
      resets: [{ subscriptionId: 'sub-1', termId: 't-1', addOnId: 'other-option' }],
    });

    const outcome = await service.claimFree({
      subscriptionId: 'sub-1',
      addOnId: 'a-1',
      owner: OWNER,
    });

    assert.equal(outcome.ok, true, "another option's free use was counted against this one");
  });

  it('refuses an add-on that is not a reset', async () => {
    const { service, resetCalls } = build({
      addOn: { id: 'a-1', type: 'EXTRA_TRAFFIC', isActive: true, freeUsesPerTerm: 5 },
    });

    const outcome = await service.claimFree({
      subscriptionId: 'sub-1',
      addOnId: 'a-1',
      owner: OWNER,
    });

    assert.equal(outcome.ok, false);
    assert.deepStrictEqual(resetCalls, []);
  });

  it('refuses a disabled add-on', async () => {
    const { service } = build({
      addOn: { id: 'a-1', type: 'RESET_TRAFFIC', isActive: false, freeUsesPerTerm: 1 },
    });

    assert.equal(
      (await service.claimFree({ subscriptionId: 'sub-1', addOnId: 'a-1', owner: OWNER })).ok,
      false,
    );
  });

  it('refuses when the operator configured no free uses', async () => {
    const { service } = build({
      addOn: { id: 'a-1', type: 'RESET_TRAFFIC', isActive: true, freeUsesPerTerm: 0 },
    });

    assert.equal(
      (await service.claimFree({ subscriptionId: 'sub-1', addOnId: 'a-1', owner: OWNER })).ok,
      false,
    );
  });
});
