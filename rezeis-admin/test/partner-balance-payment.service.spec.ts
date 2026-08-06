import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PurchaseType, TransactionStatus } from '@prisma/client';

import { PartnerBalancePaymentService } from '../src/modules/payments/services/partner-balance-payment.service';

/**
 * A compensating action that failed silently
 * ──────────────────────────────────────────
 * `pay()` debits the partner's balance and then fulfils. When fulfillment
 * throws, the debit is unwound — and that unwind can throw too. It used to be
 * written `catch { return false; }` into two callers that awaited the boolean
 * and threw the *fulfillment* error away over it, so the outcome was: balance
 * debited, nothing delivered, no operator told, and nothing that would ever
 * re-check. The only log line named the fulfillment failure, which is a
 * different event entirely.
 *
 * The tests below hold the three properties that make that outcome impossible:
 *
 *   1. a failed refund is written down where a restart cannot lose it
 *      (`gatewayData.partnerBalanceRefund`), and an operator is told at ERROR;
 *   2. the sweep actually re-drives that record and the money comes back —
 *      proven by feeding the sweep the EXACT bytes `pay()` wrote, not a
 *      hand-built fixture that could agree with a drifted writer forever;
 *   3. the success path is untouched.
 *
 * The prisma double below is a small real store rather than a call recorder:
 * `$transaction` rolls its writes back on throw and the JSON-path filter is
 * evaluated for real. Both matter — "the marker is still OWED after a failed
 * retry" and "the sweep found the row" are only worth asserting if the double
 * could have produced the other answer.
 */

interface Overrides {
  readonly allowBalancePayment?: boolean;
  readonly partner?: { id: string; isActive: boolean; balance: number } | null;
  readonly draftAmount?: string;
  readonly accessRejection?: { code: string; status: 403 | 503; message: string } | null;
  /** Make `applyCompletedTransaction` throw — the trigger for compensation. */
  readonly fulfillThrows?: boolean;
  /** Fail the balance increment (i.e. the refund) for its first N attempts. */
  readonly refundFailsForFirst?: number;
  /**
   * Fail the standalone owed-marker write — the one made OUTSIDE a transaction
   * when the debt is being filed. The marker the restore writes inside its own
   * transaction is untouched, so "the refund failed AND the debt could not be
   * written down" stays reachable as two independent failures.
   */
  readonly markerWriteThrows?: boolean;
  /** Force the sweep's conditional claim to match nothing (lost the race). */
  readonly claimAlwaysLost?: boolean;
  /**
   * The first N transactions COMMIT and then lose their acknowledgement: the
   * writes stay, the client throws anyway. Indistinguishable from a rollback
   * to anything except a marker written inside the transaction itself.
   */
  readonly commitAckLostForFirst?: number;
  /**
   * A concurrent tick settled the debt between our read and our claim: reads
   * inside the transaction return the stale `OWED` snapshot this tick started
   * with, while the committed row already says `RESTORED`. Only a claim whose
   * `where` re-checks the state can notice.
   */
  readonly staleOwedRead?: Record<string, unknown>;
  /** Seed `gatewayData` — used to hand the sweep a row `pay()` already marked. */
  readonly gatewayData?: Record<string, unknown> | null;
  /**
   * Further PARTNER_BALANCE rows, each already OWED to its own partner. One
   * row can never show whether the sweep's claim is scoped to the row it is
   * settling or is an unbounded `updateMany` over every open debt.
   */
  readonly extraOwedRows?: ReadonlyArray<{
    readonly id: string;
    readonly partnerId: string;
    readonly amountMinor: number;
    readonly balance: number;
  }>;
  /** Draft row is missing when looked up (pre-debit NotFound branch). */
  readonly draftRowMissing?: boolean;
}

/**
 * A commit that reached the database and an acknowledgement that did not.
 * Thrown by `$transaction` AFTER the callback's writes have been kept, which
 * is the one failure a rollback-on-throw double cannot otherwise express.
 */
class LostCommitAck extends Error {}

/** One row in the double's transaction table. */
interface StoredTransactionRow {
  gatewayData: Record<string, unknown> | null;
  readonly userId: string;
  readonly paymentId: string;
  readonly currency: string;
  readonly gatewayType: string;
  readonly createdAt: Date;
}

interface EmittedEvent {
  readonly type: string;
  readonly severity: 'INFO' | 'WARNING' | 'ERROR';
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

/** Reads a JSON-path filter the way Postgres does, so a wrong path finds nothing. */
function matchesJsonPath(
  value: unknown,
  filter: { path: readonly string[]; equals: unknown },
): boolean {
  let cursor: unknown = value;
  for (const segment of filter.path) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return false;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor === filter.equals;
}

function build(overrides: Overrides = {}) {
  const calls: string[] = [];
  const events: EmittedEvent[] = [];
  const trialReleases: Array<{ transactionId: string; reason: string }> = [];
  const refundAttempts: number[] = [];
  /** Which partner was credited how much — one row cannot show misdirection. */
  const refundLedger: Array<{ partnerId: string; amountMinor: number }> = [];
  /** Every `where` the sweep scanned with, so a missing filter is visible. */
  const sweepFilters: Array<Record<string, unknown>> = [];
  const partner = overrides.partner === undefined
    ? { id: 'partner-1', isActive: true, balance: 1000 }
    : overrides.partner;
  const draftAmount = overrides.draftAmount ?? '5.00';

  // The mutable world the doubles read and write. Keyed rather than flat: a
  // claim that forgets `id: row.id` is an unbounded `updateMany`, and a store
  // holding one row agrees with it forever.
  const balances = new Map<string, number>([
    ['partner-1', partner === null ? 0 : partner.balance],
  ]);
  const txRows = new Map<string, StoredTransactionRow>([
    ['tx-1', {
      gatewayData: (overrides.gatewayData ?? null) as Record<string, unknown> | null,
      userId: 'user-1',
      paymentId: 'pay-1',
      currency: 'RUB',
      gatewayType: 'PARTNER_BALANCE',
      createdAt: new Date('2026-06-24T00:00:00.000Z'),
    }],
  ]);
  const reservedTrialClaims = new Set<string>(['tx-1']);
  (overrides.extraOwedRows ?? []).forEach((extra, index) => {
    balances.set(extra.partnerId, extra.balance);
    reservedTrialClaims.add(extra.id);
    txRows.set(extra.id, {
      gatewayData: {
        partnerBalanceRefund: {
          state: 'OWED',
          partnerId: extra.partnerId,
          amountMinor: extra.amountMinor,
          releaseReason: 'PARTNER_BALANCE_FULFILLMENT_ROLLED_BACK',
          attempts: 1,
        },
        paymentNeedsManualReview: true,
      },
      userId: `user-${extra.partnerId}`,
      paymentId: `pay-${extra.id}`,
      currency: 'RUB',
      gatewayType: 'PARTNER_BALANCE',
      createdAt: new Date(Date.parse('2026-06-24T00:00:00.000Z') + index + 1),
    });
  });

  /** The row `pay()` operates on, kept as a facade so tests read one thing. */
  const store = {
    get balance(): number {
      return balances.get('partner-1') ?? 0;
    },
    get gatewayData(): Record<string, unknown> | null {
      return txRows.get('tx-1')!.gatewayData;
    },
  };
  let refundCalls = 0;
  let commits = 0;
  /** Depth, so "inside the restore transaction" is distinguishable. */
  let txDepth = 0;

  /** What a read of `id` returns — the stale snapshot when one is configured. */
  const visibleGatewayData = (id: string): Record<string, unknown> | null =>
    id === 'tx-1' && overrides.staleOwedRead !== undefined
      ? overrides.staleOwedRead
      : (txRows.get(id)?.gatewayData ?? null);

  const txRow = (id: string) => {
    const row = txRows.get(id);
    if (row === undefined) return null;
    return {
      id,
      paymentId: row.paymentId,
      userId: row.userId,
      status: TransactionStatus.COMPLETED,
      gatewayType: row.gatewayType,
      purchaseType: PurchaseType.NEW,
      amount: { toString: () => draftAmount },
      currency: row.currency,
      // A stale snapshot when one is configured — reads lag, the claim must not.
      gatewayData: visibleGatewayData(id),
      createdAt: row.createdAt,
    };
  };

  const prismaService = {
    user: {
      findUnique: async () => ({ id: 'user-1', partnerBalanceCurrencyOverride: null }),
      findFirst: async () => ({ id: 'user-1', partnerBalanceCurrencyOverride: null }),
    },
    partner: {
      findUnique: async () => partner,
      updateMany: async (args: { where: { id: string; balance: { gte: number } } }) => {
        calls.push(`debit:${args.where.balance.gte}`);
        const held = balances.get(args.where.id) ?? 0;
        if (held < args.where.balance.gte) return { count: 0 };
        balances.set(args.where.id, held - args.where.balance.gte);
        return { count: 1 };
      },
      // The refund. Fails for the first `refundFailsForFirst` attempts so a
      // compensation can fail while a later sweep succeeds.
      update: async (args: { where: { id: string }; data: { balance: { increment: number } } }) => {
        refundCalls += 1;
        const amount = args.data.balance.increment;
        if (refundCalls <= (overrides.refundFailsForFirst ?? 0)) {
          calls.push(`restore-failed:${amount}`);
          throw new Error('balance restore failed: connection terminated');
        }
        calls.push(`restore:${amount}`);
        refundAttempts.push(amount);
        refundLedger.push({ partnerId: args.where.id, amountMinor: amount });
        balances.set(args.where.id, (balances.get(args.where.id) ?? 0) + amount);
        return { id: args.where.id, balance: balances.get(args.where.id) };
      },
    },
    transaction: {
      findUnique: async (args: { where: { id: string } }) =>
        (overrides.draftRowMissing === true ? null : txRow(args.where.id)),
      findMany: async (args: {
        where: {
          gatewayType?: unknown;
          gatewayData?: { path: readonly string[]; equals: unknown };
        };
        take?: number;
      }) => {
        sweepFilters.push(args.where);
        return [...txRows.entries()]
          .filter(([id, row]) => {
            // Evaluated for real. A sweep aimed at the wrong gateway must find
            // nothing — otherwise `{restored: 0, stillOwed: 0}` reads as health
            // over a table full of unpaid debts.
            if (
              args.where.gatewayType !== undefined
              && args.where.gatewayType !== row.gatewayType
            ) {
              return false;
            }
            const filter = args.where.gatewayData;
            return filter === undefined || matchesJsonPath(visibleGatewayData(id), filter);
          })
          .sort(([, a], [, b]) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, args.take ?? Number.MAX_SAFE_INTEGER)
          .map(([id, row]) => ({
            id,
            userId: row.userId,
            paymentId: row.paymentId,
            currency: row.currency,
          }));
      },
      update: async (args: {
        where: { id: string };
        data: { gatewayData: Record<string, unknown> };
      }) => {
        // Only the standalone debt write fails: the marker the restore writes
        // inside its transaction is a different write with a different job.
        if (overrides.markerWriteThrows === true && txDepth === 0) {
          calls.push('marker-write-failed');
          throw new Error('gatewayData write failed');
        }
        const row = txRows.get(args.where.id);
        if (row === undefined) throw new Error(`no transaction ${args.where.id}`);
        calls.push('marker-write');
        row.gatewayData = args.data.gatewayData;
        return txRow(args.where.id);
      },
      updateMany: async (args: {
        where: { id?: string; gatewayData?: { path: readonly string[]; equals: unknown } };
        data: { gatewayData: Record<string, unknown> };
      }) => {
        if (overrides.claimAlwaysLost === true) return { count: 0 };
        let count = 0;
        for (const [id, row] of txRows) {
          // `where.id` is honoured, and its ABSENCE matches every row — which
          // is exactly what an unscoped claim would do in Postgres.
          if (args.where.id !== undefined && args.where.id !== id) continue;
          if (
            args.where.gatewayData !== undefined
            && !matchesJsonPath(row.gatewayData, args.where.gatewayData)
          ) {
            continue;
          }
          row.gatewayData = args.data.gatewayData;
          count += 1;
        }
        if (count > 0) calls.push('marker-claim');
        return { count };
      },
    },
    trialClaim: {
      updateMany: async (args: { where: { transactionId: string }; data: { releaseReason: string } }) => {
        if (!reservedTrialClaims.has(args.where.transactionId)) return { count: 0 };
        reservedTrialClaims.delete(args.where.transactionId);
        trialReleases.push({
          transactionId: args.where.transactionId,
          reason: args.data.releaseReason,
        });
        return { count: 1 };
      },
    },
  };
  Object.assign(prismaService, {
    // Rolls back on throw, like the real thing: a claim flipped inside a
    // transaction whose refund then failed must not survive.
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const snapshot = {
        balances: new Map(balances),
        gatewayData: new Map([...txRows].map(([id, row]) => [id, row.gatewayData] as const)),
        reserved: new Set(reservedTrialClaims),
        releases: trialReleases.length,
      };
      txDepth += 1;
      try {
        const result = await callback(prismaService);
        commits += 1;
        if (commits <= (overrides.commitAckLostForFirst ?? 0)) {
          calls.push('commit-ack-lost');
          // COMMIT reached the server; the reply did not. The writes above
          // stay exactly where they are, and the caller still sees a throw.
          throw new LostCommitAck('Server has closed the connection.');
        }
        return result;
      } catch (error) {
        if (!(error instanceof LostCommitAck)) {
          for (const [id, value] of snapshot.balances) balances.set(id, value);
          for (const [id, value] of snapshot.gatewayData) txRows.get(id)!.gatewayData = value;
          reservedTrialClaims.clear();
          for (const id of snapshot.reserved) reservedTrialClaims.add(id);
          trialReleases.length = snapshot.releases;
        }
        throw error;
      } finally {
        txDepth -= 1;
      }
    },
  });

  const settingsService = {
    getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC', defaultCurrency: 'RUB' }),
    getPartnerSettings: async () => ({ allowBalancePayment: overrides.allowBalancePayment ?? true }),
  };
  const accessModeGuard = {
    evaluate: () => overrides.accessRejection ?? null,
  };
  const paymentsTransactionsService = {
    createCheckoutDraft: async () => {
      calls.push('createDraft');
      return { id: 'tx-1', paymentId: 'pay-1', amount: draftAmount };
    },
  };
  const paymentSubscriptionMutationService = {
    applyCompletedTransaction: async () => {
      calls.push('fulfill');
      if (overrides.fulfillThrows === true) {
        throw new Error('remnawave provisioning refused the request');
      }
      return { syncJobs: [{ id: 'job-1' }] };
    },
  };
  const profileSyncQueueService = { enqueue: async (id: string) => calls.push(`enqueue:${id}`) };
  const record = (severity: EmittedEvent['severity']) =>
    (type: string, _category: string, message: string, metadata?: Record<string, unknown>) => {
      events.push({ type, severity, message, metadata: metadata ?? {} });
    };
  const events_ = {
    info: record('INFO'),
    warn: record('WARNING'),
    error: record('ERROR'),
  };

  const service = new PartnerBalancePaymentService(
    prismaService as never,
    settingsService as never,
    accessModeGuard as never,
    paymentsTransactionsService as never,
    paymentSubscriptionMutationService as never,
    profileSyncQueueService as never,
    events_ as never,
  );
  return {
    service,
    calls,
    events,
    store,
    trialReleases,
    refundAttempts,
    refundLedger,
    sweepFilters,
    balanceOf: (partnerId: string): number => balances.get(partnerId) ?? 0,
    gatewayDataOf: (transactionId: string): Record<string, unknown> | null =>
      txRows.get(transactionId)?.gatewayData ?? null,
  };
}

const baseInput = {
  userId: 'user-1',
  purchaseType: PurchaseType.NEW,
  planId: 'plan-1',
  durationDays: 30,
};

/** The owed-refund marker `pay()` writes, or `null`. */
function owedMarker(gatewayData: Record<string, unknown> | null): Record<string, unknown> | null {
  const marker = gatewayData?.['partnerBalanceRefund'];
  return typeof marker === 'object' && marker !== null
    ? (marker as Record<string, unknown>)
    : null;
}

describe('PartnerBalancePaymentService', () => {
  it('rejects when the operator disabled balance payment', async () => {
    const { service } = build({ allowBalancePayment: false });
    await assert.rejects(service.pay(baseInput), ForbiddenException);
  });

  it('rejects when the user is not an active partner', async () => {
    const { service } = build({ partner: null });
    await assert.rejects(service.pay(baseInput), ForbiddenException);
  });

  it('rejects when the balance is insufficient', async () => {
    const { service } = build({ partner: { id: 'partner-1', isActive: true, balance: 100 } });
    await assert.rejects(service.pay(baseInput), BadRequestException);
  });

  it('debits the balance, fulfils the transaction and completes it', async () => {
    const { service, calls, events, store } = build();
    const result = await service.pay(baseInput);

    assert.equal(result.transactionStatus, TransactionStatus.COMPLETED);
    assert.equal(result.checkoutUrl, null);
    assert.equal(result.amount, '5.00');
    // Order: price → debit (500 minor) → fulfil → mark completed → enqueue sync.
    assert.deepStrictEqual(calls, [
      'createDraft',
      'debit:500',
      'fulfill',
      'enqueue:job-1',
    ]);
    // …and nothing about the failure machinery fired on the way through.
    assert.equal(store.balance, 500, 'balance stays debited on success');
    assert.equal(owedMarker(store.gatewayData), null, 'a successful purchase owes nothing');
    assert.deepStrictEqual(
      events.filter((event) => event.severity === 'ERROR'),
      [],
      'the success path raises no operator alert',
    );
  });
});

describe('a partner-balance debit whose fulfillment failed', () => {
  it('refunds the balance and releases the trial reservation', async () => {
    // The baseline the rest of this block is measured against: when the
    // compensation itself works, the partner is whole and no debt is recorded.
    const { service, store, trialReleases } = build({ fulfillThrows: true });

    await assert.rejects(service.pay(baseInput), /provisioning refused/);

    assert.equal(store.balance, 1000, 'debit fully reversed');
    // The restore records its own outcome on the row it unwound, in the same
    // transaction as the increment. Nothing is OWED — but "no marker at all"
    // is not what that looks like any more, and must not be: an absent marker
    // is precisely what leaves a lost commit acknowledgement unanswerable.
    assert.equal(
      owedMarker(store.gatewayData)?.['state'],
      'RESTORED',
      'the committed restore must leave the evidence that it committed',
    );
    assert.equal(
      store.gatewayData?.['paymentNeedsManualReview'],
      undefined,
      'a restore that worked puts nothing on the operator’s desk',
    );
    assert.deepStrictEqual(trialReleases, [
      { transactionId: 'tx-1', reason: 'PARTNER_BALANCE_FULFILLMENT_ROLLED_BACK' },
    ]);
  });

  it('does not record a debt when the restore committed and only its acknowledgement was lost', async () => {
    // The failure a bare `increment` cannot see. COMMIT reached the database
    // and the connection died before the reply, so the client throws the same
    // error a rollback throws. Reading that throw as "the money never moved"
    // files a debt against a partner who is already whole, and the five-minute
    // sweep then pays it: balance 130.00 on a 100.00 account, no subscription,
    // and nothing anywhere recording the extra 30.00.
    const harness = build({ fulfillThrows: true, commitAckLostForFirst: 1 });

    await assert.rejects(harness.service.pay(baseInput), /provisioning refused/);

    // Premise, both halves: the restore really landed, and it really did
    // present itself as a failure. Without these the rest proves nothing.
    assert.ok(
      harness.calls.includes('commit-ack-lost'),
      'the acknowledgement must have been lost, or this is just the happy path',
    );
    assert.equal(harness.store.balance, 1000, 'the restore committed — the partner is whole');

    // So there is no debt: not on the row, and not on the operator's desk.
    assert.notEqual(
      owedMarker(harness.store.gatewayData)?.['state'],
      'OWED',
      'a committed restore is not a debt',
    );
    assert.deepStrictEqual(
      harness.events.filter((event) => event.type === 'partner.balance_refund_failed'),
      [],
      'nothing is owed, so no alert may tell an operator to refund by hand',
    );

    // And the sweep — the thing that would actually spend the money — agrees.
    const sweep = await harness.service.recoverOwedBalanceRestores();

    assert.deepStrictEqual(sweep, { restored: 0, stillOwed: 0 });
    assert.equal(
      harness.store.balance,
      1000,
      'the sweep must not credit a second 500 the partner never lost',
    );
    assert.deepStrictEqual(harness.refundAttempts, [500], 'exactly one refund, ever');
  });

  it('records the debt durably and alerts an operator when the refund also fails', async () => {
    const { service, calls, events, store } = build({
      fulfillThrows: true,
      refundFailsForFirst: 1,
    });

    // The caller still gets the fulfillment error — the contract is unchanged.
    await assert.rejects(service.pay(baseInput), /provisioning refused/);

    // Self-check: the refund really was attempted and really did fail. Without
    // this, everything below would also hold if compensation never ran.
    assert.ok(
      calls.includes('restore-failed:500'),
      'the refund must have been attempted and failed, or this test proves nothing',
    );
    assert.equal(store.balance, 500, 'the partner is genuinely short — that is the premise');

    // 1. Durable: on the row itself, so a restart cannot lose it.
    const marker = owedMarker(store.gatewayData);
    assert.ok(marker !== null, 'a failed refund must be written down');
    assert.equal(marker['state'], 'OWED');
    assert.equal(marker['partnerId'], 'partner-1');
    assert.equal(marker['amountMinor'], 500, 'the recorded debt is the amount debited');
    assert.equal(marker['releaseReason'], 'PARTNER_BALANCE_FULFILLMENT_ROLLED_BACK');
    assert.equal(
      store.gatewayData?.['paymentNeedsManualReview'],
      true,
      'the row must not be filed as an abandoned cart while money is owed',
    );

    // 2. Operator-visible, at ERROR, naming partner, amount and both failures.
    const alert = events.find((event) => event.type === 'partner.balance_refund_failed');
    assert.ok(alert !== undefined, 'an operator who is not told cannot refund by hand');
    assert.equal(alert.severity, 'ERROR');
    assert.equal(alert.metadata.partnerId, 'partner-1');
    assert.equal(alert.metadata.amountMinor, 500);
    assert.equal(alert.metadata.currency, 'RUB');
    assert.equal(alert.metadata.transactionId, 'tx-1');
    assert.equal(alert.metadata.durablyRecorded, true);
    assert.match(
      String(alert.metadata.cause),
      /provisioning refused/,
      'the alert must carry the original fulfillment failure',
    );
  });

  it('still alerts when the debt itself cannot be written down', async () => {
    // Both durable channels are independent on purpose: the audit-log entry
    // `emit` produces is the only record left when the row write dies too.
    const { service, calls, events, store } = build({
      fulfillThrows: true,
      refundFailsForFirst: 1,
      markerWriteThrows: true,
    });

    await assert.rejects(service.pay(baseInput), /provisioning refused/);

    assert.ok(calls.includes('marker-write-failed'), 'the marker write must have been attempted');
    assert.equal(owedMarker(store.gatewayData), null, 'nothing was recorded — the premise');

    const alert = events.find((event) => event.type === 'partner.balance_refund_failed');
    assert.ok(alert !== undefined, 'losing the row write must not also lose the alert');
    assert.equal(alert.severity, 'ERROR');
    assert.equal(
      alert.metadata.durablyRecorded,
      false,
      'the alert must say the debt is NOT recorded, so an operator knows nothing will retry',
    );
  });

  it('never reaches the refund when the draft row is missing — the debit has not happened yet', async () => {
    // Ordering, not compensation: the draft lookup moved ahead of the debit, so
    // this branch has nothing to unwind. Reading it after the debit is what
    // made it a compensating action in the first place.
    const { service, calls, store, trialReleases } = build({ draftRowMissing: true });

    await assert.rejects(service.pay(baseInput), /Transaction draft not found/);

    assert.equal(store.balance, 1000, 'the balance was never touched');
    assert.ok(!calls.some((call) => call.startsWith('debit:')), 'no debit was issued');
    assert.ok(
      !calls.some((call) => call.startsWith('restore')),
      'and therefore no refund was needed',
    );
    assert.deepStrictEqual(trialReleases, [
      { transactionId: 'tx-1', reason: 'PARTNER_BALANCE_DRAFT_MISSING_PRE_DEBIT' },
    ]);
  });
});

describe('the sweep that re-drives an unpaid balance restore', () => {
  it('puts back money the live compensation could not, end to end', async () => {
    // The load-bearing test. The marker the sweep reads is the one `pay()`
    // actually wrote — not a fixture — so a writer and a reader that drift
    // apart go red here instead of agreeing with each other forever.
    const harness = build({ fulfillThrows: true, refundFailsForFirst: 1 });

    await assert.rejects(harness.service.pay(baseInput), /provisioning refused/);
    assert.equal(harness.store.balance, 500, 'premise: the partner is short 500');
    assert.equal(owedMarker(harness.store.gatewayData)?.['state'], 'OWED');

    // Same service instance, same row, one tick later — the fault has cleared.
    const outcome = await harness.service.recoverOwedBalanceRestores();

    assert.deepStrictEqual(outcome, { restored: 1, stillOwed: 0 });
    assert.equal(harness.store.balance, 1000, 'the money is actually back');
    assert.deepStrictEqual(harness.refundAttempts, [500], 'refunded exactly the amount debited');
    assert.deepStrictEqual(harness.trialReleases, [
      { transactionId: 'tx-1', reason: 'PARTNER_BALANCE_FULFILLMENT_ROLLED_BACK' },
    ]);

    const marker = owedMarker(harness.store.gatewayData);
    assert.equal(marker?.['state'], 'RESTORED', 'the debt is marked settled');
    assert.equal(
      harness.store.gatewayData?.['paymentNeedsManualReview'],
      false,
      'a settled row goes back to being an ordinary failed checkout',
    );
    const closure = harness.events.find(
      (event) => event.type === 'partner.balance_adjusted' && event.severity === 'WARNING',
    );
    assert.ok(closure !== undefined, 'the operator who got the alert must be told it resolved');
    assert.equal(closure.metadata.partnerId, 'partner-1');
    assert.equal(closure.metadata.amountMinor, 500);
  });

  it('does not pay a second time once the debt is settled', async () => {
    // Idempotency across ticks: the second pass must find nothing owed. Run
    // through the real marker again rather than asserting on a flag.
    const harness = build({ fulfillThrows: true, refundFailsForFirst: 1 });
    await assert.rejects(harness.service.pay(baseInput), /provisioning refused/);
    await harness.service.recoverOwedBalanceRestores();
    assert.equal(harness.store.balance, 1000);

    const second = await harness.service.recoverOwedBalanceRestores();

    assert.deepStrictEqual(second, { restored: 0, stillOwed: 0 });
    assert.equal(harness.store.balance, 1000, 'a second tick must not refund twice');
    assert.deepStrictEqual(harness.refundAttempts, [500], 'exactly one refund, ever');
  });

  it('does not pay twice when a concurrent tick settled the debt after this one read it', async () => {
    // The race the claim's `where` exists for, and the one a single-threaded
    // "run the sweep twice" test cannot reach. Two ticks both read OWED; the
    // first commits RESTORED + the increment; the second reaches its claim
    // holding a stale snapshot. Under READ COMMITTED the claim re-evaluates
    // its predicate against the row the winner just wrote — which is the only
    // thing standing between the partner and a second, unearned 500.
    const owedSnapshot = {
      partnerBalanceRefund: {
        state: 'OWED',
        partnerId: 'partner-1',
        amountMinor: 500,
        releaseReason: 'PARTNER_BALANCE_FULFILLMENT_ROLLED_BACK',
        attempts: 1,
      },
      paymentNeedsManualReview: true,
    };
    const harness = build({
      // Committed state: the winning tick already settled it.
      gatewayData: {
        partnerBalanceRefund: {
          state: 'RESTORED',
          partnerId: 'partner-1',
          amountMinor: 500,
          releaseReason: 'PARTNER_BALANCE_FULFILLMENT_ROLLED_BACK',
          attempts: 2,
        },
        paymentNeedsManualReview: false,
      },
      // What this (losing) tick's own reads still return.
      staleOwedRead: owedSnapshot,
    });

    const outcome = await harness.service.recoverOwedBalanceRestores();

    assert.deepStrictEqual(
      harness.refundAttempts,
      [],
      'the loser of the race must not refund a debt the winner already paid',
    );
    assert.equal(harness.store.balance, 1000, 'balance unchanged by the losing tick');
    assert.deepStrictEqual(outcome, { restored: 0, stillOwed: 0 }, 'skipped, not failed');
  });

  it('does not pay when it loses the claim race to a concurrent tick', async () => {
    const harness = build({
      claimAlwaysLost: true,
      gatewayData: {
        partnerBalanceRefund: {
          state: 'OWED',
          partnerId: 'partner-1',
          amountMinor: 500,
          releaseReason: 'PARTNER_BALANCE_FULFILLMENT_ROLLED_BACK',
          attempts: 1,
        },
        paymentNeedsManualReview: true,
      },
    });

    const outcome = await harness.service.recoverOwedBalanceRestores();

    assert.deepStrictEqual(outcome, { restored: 0, stillOwed: 0 }, 'skipped, not failed');
    assert.deepStrictEqual(harness.refundAttempts, [], 'the winner of the race pays, not both');
    assert.equal(harness.store.balance, 1000, 'balance untouched by the loser');
  });

  it('leaves the debt owed when the retry fails again', async () => {
    const harness = build({
      refundFailsForFirst: 1,
      gatewayData: {
        partnerBalanceRefund: {
          state: 'OWED',
          partnerId: 'partner-1',
          amountMinor: 500,
          releaseReason: 'PARTNER_BALANCE_FULFILLMENT_ROLLED_BACK',
          attempts: 1,
        },
        paymentNeedsManualReview: true,
      },
    });

    const first = await harness.service.recoverOwedBalanceRestores();

    assert.deepStrictEqual(first, { restored: 0, stillOwed: 1 });
    const marker = owedMarker(harness.store.gatewayData);
    assert.equal(marker?.['state'], 'OWED', 'a failed retry must not mark the debt settled');
    assert.equal(marker?.['attempts'], 2, 'the attempt was counted');
    assert.equal(
      harness.store.gatewayData?.['paymentNeedsManualReview'],
      true,
      'the row stays on the operator’s desk',
    );

    // Still re-drivable: the next tick (fault cleared) collects it.
    const second = await harness.service.recoverOwedBalanceRestores();
    assert.deepStrictEqual(second, { restored: 1, stillOwed: 0 });
    assert.equal(harness.store.balance, 1500, 'seeded 1000 + the 500 finally refunded');
  });

  it('refuses to spend against a marker it cannot trust, and stops re-reading it forever', async () => {
    // A malformed amount must not become a refund of NaN/0 or a crash that
    // aborts the whole sweep — it is left for a human.
    //
    // "Left for a human" used to mean left in place: skipped, counted in
    // neither total, re-selected on every tick, and holding one of the 100
    // slots in a `createdAt asc` window. A hundred of these at the head of
    // that window and no genuine refund created afterwards is ever reached,
    // while `{restored: 0, stillOwed: 0}` is reported as health throughout.
    const harness = build({
      gatewayData: {
        partnerBalanceRefund: {
          state: 'OWED',
          partnerId: '',
          amountMinor: '500',
          releaseReason: 'PARTNER_BALANCE_FULFILLMENT_ROLLED_BACK',
        },
      },
    });

    const outcome = await harness.service.recoverOwedBalanceRestores();

    assert.deepStrictEqual(harness.refundAttempts, [], 'nothing paid out on a bad marker');
    assert.deepStrictEqual(
      outcome,
      { restored: 0, stillOwed: 1 },
      'the money never went back, so the tick must not report itself as idle',
    );
    const alert = harness.events.find((event) => event.type === 'partner.balance_refund_failed');
    assert.ok(alert !== undefined, 'a debt only a human can settle must reach a human');
    assert.equal(alert.severity, 'ERROR');
    assert.equal(alert.metadata.transactionId, 'tx-1');
    assert.equal(
      harness.store.gatewayData?.['paymentNeedsManualReview'],
      true,
      'the row stays on the operator’s desk',
    );

    // The slot is freed: the next tick no longer sees it at all, so the alert
    // fires once rather than every five minutes forever.
    const second = await harness.service.recoverOwedBalanceRestores();

    assert.deepStrictEqual(
      second,
      { restored: 0, stillOwed: 0 },
      'a retired marker is out of the window — that is what stops the starvation',
    );
    assert.equal(
      harness.events.filter((event) => event.type === 'partner.balance_refund_failed').length,
      1,
      'and it is not re-alerted on every tick',
    );
    assert.deepStrictEqual(harness.refundAttempts, [], 'still nothing paid out');
  });

  it('settles each debt against its own row and its own partner', async () => {
    // The claim's `where` carries `id: row.id`. Drop it and the flip becomes an
    // unbounded `updateMany`: the first row's claim marks EVERY outstanding
    // debt RESTORED while exactly one partner is credited, and every other
    // partner is written off in silence. A store holding one row agrees with
    // that mutation forever, which is why there are two here.
    const harness = build({
      gatewayData: {
        partnerBalanceRefund: {
          state: 'OWED',
          partnerId: 'partner-1',
          amountMinor: 500,
          releaseReason: 'PARTNER_BALANCE_FULFILLMENT_ROLLED_BACK',
          attempts: 1,
        },
        paymentNeedsManualReview: true,
      },
      extraOwedRows: [
        { id: 'tx-2', partnerId: 'partner-2', amountMinor: 700, balance: 0 },
      ],
    });

    const outcome = await harness.service.recoverOwedBalanceRestores();

    assert.deepStrictEqual(outcome, { restored: 2, stillOwed: 0 }, 'both debts settled');
    assert.deepStrictEqual(
      harness.refundLedger,
      [
        { partnerId: 'partner-1', amountMinor: 500 },
        { partnerId: 'partner-2', amountMinor: 700 },
      ],
      'each partner is credited its own debt — not one partner credited for all of them',
    );
    assert.equal(harness.balanceOf('partner-1'), 1500, 'seeded 1000 + the 500 owed');
    assert.equal(harness.balanceOf('partner-2'), 700, 'seeded 0 + the 700 owed');
    assert.equal(
      owedMarker(harness.gatewayDataOf('tx-2'))?.['amountMinor'],
      700,
      'the second row keeps its own debt — an unscoped claim overwrites it with the first row’s',
    );
  });

  it('looks for rows by the marker it writes, on the gateway it wrote them for', async () => {
    // The scan half of the gate: the sweep is expected to find NOTHING on a
    // clean tree, so a query pointed at the wrong JSON path — or at the wrong
    // gateway — would agree with `{restored: 0}` forever. Prove both answers
    // are reachable, then pin the filter itself.
    const settled = build({
      gatewayData: {
        partnerBalanceRefund: { state: 'RESTORED', partnerId: 'partner-1', amountMinor: 500 },
      },
    });
    assert.deepStrictEqual(
      await settled.service.recoverOwedBalanceRestores(),
      { restored: 0, stillOwed: 0 },
      'a RESTORED marker is not a debt',
    );

    const clean = build({ gatewayData: null });
    assert.deepStrictEqual(
      await clean.service.recoverOwedBalanceRestores(),
      { restored: 0, stillOwed: 0 },
      'a row with no marker is not a debt',
    );

    const owed = build({
      gatewayData: {
        partnerBalanceRefund: {
          state: 'OWED',
          partnerId: 'partner-1',
          amountMinor: 500,
          releaseReason: 'PARTNER_BALANCE_FULFILLMENT_ROLLED_BACK',
        },
      },
    });
    assert.deepStrictEqual(
      await owed.service.recoverOwedBalanceRestores(),
      { restored: 1, stillOwed: 0 },
      'the same query MUST find an OWED row — otherwise the zeroes above mean nothing',
    );

    // The gateway filter is the half the three cases above cannot separate:
    // every row in this store is PARTNER_BALANCE, so a filter naming some
    // other gateway would make the sweep find nothing on a table full of
    // unpaid debts and still report `{restored: 0, stillOwed: 0}` as health.
    // Named explicitly so deleting the filter is as visible as mistyping it.
    const [scan] = owed.sweepFilters;
    assert.ok(scan !== undefined, 'the sweep must actually have queried');
    assert.equal(
      scan['gatewayType'],
      'PARTNER_BALANCE',
      'the scan is scoped to the gateway whose rows carry this marker',
    );
    assert.deepStrictEqual(
      scan['gatewayData'],
      { path: ['partnerBalanceRefund', 'state'], equals: 'OWED' },
      'and to the exact JSON path the writer uses',
    );
  });
});
