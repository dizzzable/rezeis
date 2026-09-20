import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PaymentGatewayType, SubscriptionStatus, TransactionStatus } from '@prisma/client';

import { AutoRenewService } from '../src/modules/auto-renew/auto-renew.service';
import { renewalItemNotPriceable } from '../src/modules/subscriptions/services/subscription-renewal.service';

/**
 * Regression coverage for the createExpiryWarnings dedup after the N+1 removal:
 * the per-subscription `findFirst` was replaced by a single `findMany` + Set.
 * These tests pin the exact behavior — one notification per user per run,
 * users with a recent event skipped, and the dedup query fired ONCE.
 */

interface SubRow {
  id: string;
  userId: string;
  expiresAt: Date;
  planSnapshot: unknown;
}

/**
 * Every system event the service under test raised, across all four harnesses
 * in this file. Module-scoped because each harness builds its own service and
 * the assertions read it right after the call that filled it.
 */
const raisedEvents: Array<{ readonly type: string; readonly metadata: Record<string, unknown> }> = [];

function createHarness(opts: {
  expiring: SubRow[];
  alreadyNotifiedUserIds: string[];
  /**
   * Deadlines as they are when the warning is about to be WRITTEN, keyed by
   * subscription id — i.e. after anything that happened while the loop ran.
   * Absent means unchanged. `null` means "this one was renewed", which is the
   * case the guard exists for.
   */
  renewedDuringBatch?: Record<string, Date | null>;
}): {
  service: AutoRenewService;
  createdFor: string[];
  counters: { eventFindMany: number };
} {
  const createdFor: string[] = [];
  // Object (not a primitive) so the closure's increments are visible via the
  // returned reference.
  const counters = { eventFindMany: 0 };

  const prisma = {
    subscription: {
      // HONOURS `userId.notIn`. The already-notified customers are now excluded
      // in the QUERY rather than dropped from the batch afterwards, which is
      // what stops a full batch of people who have all been told from coming
      // back every tick and starving the ones behind it. A double that ignored
      // the term would make that fix untestable.
      findMany: async (args: {
        where?: { userId?: { notIn?: string[] } };
        take?: number;
      }) => {
        const excluded = new Set(args.where?.userId?.notIn ?? []);
        const matching = opts.expiring.filter((row) => !excluded.has(row.userId));
        // `take` IS honoured, and it has to be: the starvation this fix is
        // about only appears at the batch boundary. A double that returned
        // everything would make the batch-full case unreachable and the test
        // below would pass against the defect.
        return args.take === undefined ? matching : matching.slice(0, args.take);
      },
      // The re-read the service does immediately before each send. It is not
      // decoration in this double: the batch is one query and the sends are a
      // loop, so a renewal that lands between them is invisible to `findMany`
      // and visible only here. A double without it would let the guard be
      // deleted with every test still green.
      findUnique: async (args: { where: { id: string } }) => {
        const row = opts.expiring.find((candidate) => candidate.id === args.where.id);
        if (!row) return null;
        const moved = opts.renewedDuringBatch?.[row.id];
        return {
          status: SubscriptionStatus.ACTIVE,
          expiresAt: moved === undefined ? row.expiresAt : moved,
        };
      },
    },
    userNotificationEvent: {
      // Asked by type and recency only — every customer told inside the window,
      // not just the ones in some batch we happened to read first.
      findMany: async () => {
        counters.eventFindMany += 1;
        return opts.alreadyNotifiedUserIds.map((userId) => ({ userId }));
      },
    },
  };

  const userNotifications = {
    create: async (input: { userId: string }) => {
      createdFor.push(input.userId);
    },
  };

  const service = new AutoRenewService(
    prisma as never,
    userNotifications as never,
    { createCheckout: async () => ({}) } as never,
    { findPreferredForCharge: async () => null } as never,
    // The shared notice-payload builder. Inert here: what these cases are
    // about is who gets notified and how often, not what the message says.
    { build: async () => ({}) } as never,
    // Renewal plan selection. Not reached by the warning emitters.
    { requiresPlanSelection: async () => false } as never,
    { info: (type: string, _c: string, _m: string, metadata: Record<string, unknown>) => { raisedEvents.push({ type, metadata }) } } as never,
  );
  return { service, createdFor, counters };
}

/**
 * A deadline that genuinely sits inside the window the service computes for
 * `daysAhead` — an hour before the horizon, in the three-hour band it selects.
 *
 * It used to be one fixed `now + 24h` shared by every case, including the one
 * that asks for a THREE-day warning, and that worked only because the
 * `findMany` double ignored the date term. The service now re-reads the
 * deadline before each send, so a row declared "expiring" has to actually be.
 */
const inWindow = (daysAhead: number): Date =>
  new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000 - 60 * 60 * 1000);
const soon = inWindow(1);
const soon3d = inWindow(3);

describe('AutoRenewService.createExpiryWarnings', () => {
  it('notifies each un-notified user exactly once and dedups the query to a single findMany', async () => {
    const h = createHarness({
      expiring: [
        { id: 's1', userId: 'userA', expiresAt: soon, planSnapshot: { name: 'Pro' } },
        { id: 's2', userId: 'userB', expiresAt: soon, planSnapshot: { name: 'Pro' } },
      ],
      alreadyNotifiedUserIds: [],
    });
    const created = await h.service.createExpiryWarnings({ daysAhead: 1, notificationType: 'expires_in_1_days' });
    assert.equal(created, 2);
    assert.deepEqual(h.createdFor.sort(), ['userA', 'userB']);
    assert.equal(h.counters.eventFindMany, 1); // no N+1
  });

  it('skips a user who already has a recent notification of this type', async () => {
    const h = createHarness({
      expiring: [
        { id: 's1', userId: 'userA', expiresAt: soon, planSnapshot: {} },
        { id: 's2', userId: 'userB', expiresAt: soon, planSnapshot: {} },
      ],
      alreadyNotifiedUserIds: ['userA'],
    });
    const created = await h.service.createExpiryWarnings({ daysAhead: 1, notificationType: 'expires_in_1_days' });
    assert.equal(created, 1);
    assert.deepEqual(h.createdFor, ['userB']);
  });

  it('sends only ONE notification to a user with multiple expiring subs (within-batch dedup)', async () => {
    const h = createHarness({
      expiring: [
        { id: 's1', userId: 'userA', expiresAt: soon3d, planSnapshot: {} },
        { id: 's2', userId: 'userA', expiresAt: soon3d, planSnapshot: {} },
        { id: 's3', userId: 'userA', expiresAt: soon3d, planSnapshot: {} },
      ],
      alreadyNotifiedUserIds: [],
    });
    const created = await h.service.createExpiryWarnings({ daysAhead: 3, notificationType: 'expires_in_3_days' });
    assert.equal(created, 1);
    assert.deepEqual(h.createdFor, ['userA']);
  });

  it('says nothing to a customer who renewed while the batch was being sent', async () => {
    // THE REPORT. A customer renewed and was told minutes later that their
    // subscription was about to end.
    //
    // The selector is right and the row does leave the window on renewal — but
    // the window is read ONCE, and the sends that follow are a loop of awaits,
    // one payload build and one fan-out per row, up to two hundred of them. A
    // renewal that lands inside that loop is invisible to the batch and visible
    // only to a re-read, which is what the service now does before each send.
    const h = createHarness({
      expiring: [
        { id: 's1', userId: 'userA', expiresAt: soon, planSnapshot: {} },
        { id: 's2', userId: 'userB', expiresAt: soon, planSnapshot: {} },
        { id: 's3', userId: 'userC', expiresAt: soon, planSnapshot: {} },
      ],
      alreadyNotifiedUserIds: [],
      // userB paid while the loop was on userA. Thirty days out: nowhere near
      // the window the batch was selected on.
      renewedDuringBatch: { s2: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
    });

    const created = await h.service.createExpiryWarnings({
      daysAhead: 1,
      notificationType: 'expires_in_1_days',
    });

    assert.equal(created, 2);
    assert.deepEqual(h.createdFor.sort(), ['userA', 'userC']);
  });

  it('still warns the customers whose deadline did not move', async () => {
    // The guard must not become a reason nobody is warned: same batch, nothing
    // renewed, everybody told.
    const h = createHarness({
      expiring: [
        { id: 's1', userId: 'userA', expiresAt: soon, planSnapshot: {} },
        { id: 's2', userId: 'userB', expiresAt: soon, planSnapshot: {} },
      ],
      alreadyNotifiedUserIds: [],
    });

    const created = await h.service.createExpiryWarnings({
      daysAhead: 1,
      notificationType: 'expires_in_1_days',
    });

    assert.equal(created, 2);
  });

  it('sends nothing, and asks for the notified set exactly once, when nothing is expiring', async () => {
    // The events query now runs FIRST and unconditionally, which reverses what
    // this test used to assert. It has to: the already-notified customers are
    // excluded in the subscription query rather than dropped from the batch
    // afterwards, and that is what stops a full batch of people who have all
    // been told from coming back every tick while the ones behind it are never
    // reached — a permanent miss, because a subscription sits in its window for
    // only three hours.
    //
    // The cost is one indexed read per family per tick on an idle install. The
    // thing it buys is that no customer silently goes untold.
    const h = createHarness({ expiring: [], alreadyNotifiedUserIds: [] });
    const created = await h.service.createExpiryWarnings({ daysAhead: 1, notificationType: 'expires_in_1_days' });
    assert.equal(created, 0);
    assert.equal(h.counters.eventFindMany, 1);
    assert.deepEqual(h.createdFor, []);
  });

  it('reaches the customers behind a batch full of already-notified ones', async () => {
    // THE starvation case. Under the old shape the batch was taken first and
    // filtered afterwards, so a window holding more expiries than one batch
    // served the same already-notified rows every tick and never advanced. The
    // rows it could not reach were the oldest — the ones that leave the window
    // first — so they were not delayed, they were never told at all, and
    // `created: 0` read exactly like a quiet night.
    // One batch (200) of customers who have all been told, plus five behind
    // them. Under the old shape the take returned the first 200, every one of
    // them was dropped in memory, and the five were never seen — on this tick
    // or any other, because the query is deterministic.
    const WARNING_BATCH = 200;
    const expiring = Array.from({ length: WARNING_BATCH + 5 }, (_, index) => ({
      id: `sub-${index}`,
      userId: `user-${index}`,
      expiresAt: inWindow(3),
      planSnapshot: null,
    })) as never[];
    const h = createHarness({
      expiring,
      alreadyNotifiedUserIds: Array.from(
        { length: WARNING_BATCH },
        (_, index) => `user-${index}`,
      ),
    });

    const created = await h.service.createExpiryWarnings({
      daysAhead: 3,
      notificationType: 'expires_in_3_days',
    });

    assert.equal(created, 5);
    assert.deepEqual(h.createdFor, [
      'user-200',
      'user-201',
      'user-202',
      'user-203',
      'user-204',
    ]);
  });
});

describe('AutoRenewService.processAutopayCharges', () => {
  it('does not create attempt a2 while the a1 provider outcome is unresolved', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    let renewalCalls = 0;
    const prisma = {
      subscription: {
        findMany: async () => [{ id: 'sub-1', userId: 'user-1', expiresAt }],
      },
      transaction: {
        findMany: async () => [
          {
            status: TransactionStatus.PENDING,
            idempotencyKey: `auto-renew:sub-1:${expiresAt.getTime()}:a1`,
            checkoutUrl: null,
            gatewayId: '__RENEWAL_PROVIDER_CREATE__:payment-a1',
          },
        ],
      },
    };
    const service = new AutoRenewService(
      prisma as never,
      { create: async () => undefined } as never,
      {
        renewalCheckout: async () => {
          renewalCalls += 1;
          throw new Error('attempt a2 must not be created');
        },
      } as never,
      {
        findPreferredForCharge: async () => ({
          id: 'method-1',
          gatewayType: PaymentGatewayType.YOOKASSA,
        }),
      } as never,
      // The shared notice-payload builder. Inert here: what these cases are
      // about is who gets notified and how often, not what the message says.
      { build: async () => ({}) } as never,
      // A renewal that needs no plan choice: the case is about the attempt key.
      { requiresPlanSelection: async () => false } as never,
      { info: (type: string, _c: string, _m: string, metadata: Record<string, unknown>) => { raisedEvents.push({ type, metadata }) } } as never,
    );

    const result = await service.processAutopayCharges();

    assert.equal(renewalCalls, 0);
    assert.deepEqual(result, { attempted: 0, succeeded: 0, failed: 0, skipped: 1 });
  });
});

/**
 * AUTOPAY NEVER CHARGES FOR A PLAN THE SUBSCRIBER DID NOT CHOOSE.
 *
 * The defect: a subscription whose plan had been deleted was quoted for renewal
 * onto `availablePlans[0]` — the FIRST catalogue plan — with no choice
 * required, and this service charged the saved card for it. The renewal quote
 * now asks the subscriber to choose instead (`SubscriptionRenewalService`), and
 * these cases pin what autopay does with that answer: it does not try, it does
 * not count the non-attempt as a failed payment, and it lets the subscription
 * lapse on time so the ordinary `expired` notice — with its "renew" button — is
 * what reaches the customer.
 *
 * The selection answer is stubbed here; the answer itself (missing plan,
 * soft-deleted plan, plan-less import) is pinned in
 * `test/subscription-renewal.service.spec.ts` and against PostgreSQL in
 * `test/plan-delete-postgres.spec.ts`.
 */
describe('autopay and a renewal that needs the subscriber’s choice', () => {
  function autopayHarness(options: {
    readonly needsChoice: ReadonlySet<string>;
    readonly expiresAt: Date;
    readonly status?: SubscriptionStatus;
  }) {
    const checkoutsFor: string[] = [];
    const asked: string[] = [];
    const expiredIds: string[][] = [];
    const prisma = {
      subscription: {
        findMany: async () => [
          { id: 'sub-needs-choice', userId: 'user-1', expiresAt: options.expiresAt },
          { id: 'sub-ordinary', userId: 'user-2', expiresAt: options.expiresAt },
        ],
        updateMany: async (args: { where: { id: { in: string[] } } }) => {
          expiredIds.push([...args.where.id.in]);
          return { count: args.where.id.in.length };
        },
      },
      // No attempts yet for either subscription in this expiry epoch.
      transaction: { findMany: async () => [] },
    };
    const service = new AutoRenewService(
      prisma as never,
      { create: async () => undefined } as never,
      {
        renewalCheckout: async (input: { subscriptionIds: string[] }) => {
          checkoutsFor.push(...input.subscriptionIds);
          return {
            paymentId: `pay-${input.subscriptionIds[0]}`,
            transactionStatus: TransactionStatus.PENDING,
            checkoutUrl: null,
          };
        },
      } as never,
      {
        findPreferredForCharge: async () => ({ id: 'method-1', gatewayType: PaymentGatewayType.YOOKASSA }),
      } as never,
      { build: async () => ({}) } as never,
      {
        requiresPlanSelection: async (subscriptionId: string) => {
          asked.push(subscriptionId);
          return options.needsChoice.has(subscriptionId);
        },
      } as never,
      { info: (type: string, _c: string, _m: string, metadata: Record<string, unknown>) => { raisedEvents.push({ type, metadata }) } } as never,
    );
    return { service, checkoutsFor, asked, expiredIds };
  }

  it('does not charge it, and still charges the ordinary one beside it', async () => {
    const h = autopayHarness({
      needsChoice: new Set(['sub-needs-choice']),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await h.service.processAutopayCharges();

    assert.deepEqual(h.checkoutsFor, ['sub-ordinary'], 'the card was charged for a plan nobody chose');
    assert.deepEqual(result, { attempted: 1, succeeded: 0, failed: 0, skipped: 2 });
  });

  it('counts it as skipped on every tick, never as a failed payment', async () => {
    const h = autopayHarness({
      needsChoice: new Set(['sub-needs-choice', 'sub-ordinary']),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const first = await h.service.processAutopayCharges();
    const second = await h.service.processAutopayCharges();

    assert.deepEqual(first, { attempted: 0, succeeded: 0, failed: 0, skipped: 2 });
    assert.deepEqual(second, first);
    assert.deepEqual(h.checkoutsFor, []);
  });

  it('lets it expire on time instead of holding it ACTIVE for a retry that cannot succeed', async () => {
    const h = autopayHarness({
      needsChoice: new Set(['sub-needs-choice']),
      expiresAt: new Date(Date.now() - 60_000),
    });

    await h.service.markExpiredSubscriptions();

    assert.deepEqual(h.expiredIds, [['sub-needs-choice']], 'the subscription needing a choice was not expired');
    // The ordinary one still has retries and a card: it is charged past due
    // and left ACTIVE — the non-vacuous half of the same case.
    assert.deepEqual(h.checkoutsFor, ['sub-ordinary']);
  });
});

/**
 * A RENEWAL REFUSED BEFORE ANY PAYMENT EXISTS IS NOT RETRIED FOR EVER.
 *
 * Attempts are counted from transaction rows (`auto-renew:{id}:{expiresAtMs}:aN`).
 * A renewal the checkout refuses BEFORE it writes a draft — a trial (never
 * renewable), a plan with no price in the gateway's currency, the gateway
 * switched off, a blocked owner — leaves no row, so the count never moved: the
 * subscription stayed ACTIVE past its date, the past-due pass asked again every
 * minute, and the `expired` notice (which selects EXPIRED rows) never went out.
 *
 * What these cases pin: a trial is not an autopay candidate at all; a refusal
 * like that is final for this expiry, so the subscription expires on schedule;
 * and a charge that really reached the provider and failed keeps its three
 * attempts, as does a failure that may pass (a restricted service, a network
 * error).
 *
 * The subscription double honours `status`, `isTrial` and the `expiresAt`
 * window, and `updateMany` really moves a row to EXPIRED, so "expired on the
 * first run" and "asked again on the second" are observable rather than
 * assumed. The transaction double answers the attempt-key prefix from the rows
 * a checkout actually wrote.
 */
describe('autopay and a renewal refused before any payment exists', () => {
  interface Row {
    readonly id: string;
    readonly userId: string;
    readonly expiresAt: Date;
    readonly isTrial: boolean;
    status: SubscriptionStatus;
  }
  interface AttemptRow {
    readonly idempotencyKey: string;
    readonly status: TransactionStatus;
  }
  type Checkout = (input: {
    readonly subscriptionId: string;
    readonly idempotencyKey: string;
    readonly writeAttempt: (status: TransactionStatus) => void;
  }) => Promise<{ paymentId: string; transactionStatus: TransactionStatus; checkoutUrl: null }>;

  const PAST_DUE = new Date(Date.now() - 60_000);
  const DUE_SOON = new Date(Date.now() + 60_000);

  function matchesDate(value: Date, condition: Record<string, unknown> | undefined): boolean {
    if (condition === undefined) return true;
    const at = value.getTime();
    if (condition.gt instanceof Date && !(at > condition.gt.getTime())) return false;
    if (condition.lte instanceof Date && !(at <= condition.lte.getTime())) return false;
    if (condition.lt instanceof Date && !(at < condition.lt.getTime())) return false;
    return true;
  }

  function refusalHarness(options: {
    readonly rows: ReadonlyArray<Omit<Row, 'status'>>;
    readonly checkout: Checkout;
  }) {
    const rows: Row[] = options.rows.map((row) => ({ ...row, status: SubscriptionStatus.ACTIVE }));
    const attempts: AttemptRow[] = [];
    const checkoutsFor: string[] = [];
    const expiredIds: string[][] = [];
    const prisma = {
      subscription: {
        findMany: async (args: {
          where: { status?: SubscriptionStatus; isTrial?: boolean; expiresAt?: Record<string, unknown> };
        }) =>
          rows
            .filter((row) => args.where.status === undefined || row.status === args.where.status)
            .filter((row) => args.where.isTrial === undefined || row.isTrial === args.where.isTrial)
            .filter((row) => matchesDate(row.expiresAt, args.where.expiresAt))
            .map((row) => ({ id: row.id, userId: row.userId, expiresAt: row.expiresAt, isTrial: row.isTrial })),
        updateMany: async (args: { where: { id: { in: string[] } } }) => {
          expiredIds.push([...args.where.id.in]);
          let count = 0;
          for (const row of rows) {
            if (args.where.id.in.includes(row.id) && row.status === SubscriptionStatus.ACTIVE) {
              row.status = SubscriptionStatus.EXPIRED;
              count += 1;
            }
          }
          return { count };
        },
      },
      transaction: {
        findMany: async (args: { where: { idempotencyKey: { startsWith: string } } }) =>
          attempts
            .filter((attempt) => attempt.idempotencyKey.startsWith(args.where.idempotencyKey.startsWith))
            .map((attempt) => ({ ...attempt, checkoutUrl: null, gatewayId: 'provider-id' })),
      },
    };
    const service = new AutoRenewService(
      prisma as never,
      { create: async () => undefined } as never,
      {
        renewalCheckout: async (input: { subscriptionIds: string[]; idempotencyKey: string }) => {
          const subscriptionId = input.subscriptionIds[0]!;
          checkoutsFor.push(subscriptionId);
          return options.checkout({
            subscriptionId,
            idempotencyKey: input.idempotencyKey,
            writeAttempt: (status) => attempts.push({ idempotencyKey: input.idempotencyKey, status }),
          });
        },
      } as never,
      {
        findPreferredForCharge: async () => ({ id: 'method-1', gatewayType: PaymentGatewayType.YOOKASSA }),
      } as never,
      { build: async () => ({}) } as never,
      // Not a plan-choice case: every plan here still exists.
      { requiresPlanSelection: async () => false } as never,
      { info: (type: string, _c: string, _m: string, metadata: Record<string, unknown>) => { raisedEvents.push({ type, metadata }) } } as never,
    );
    const statusOf = (id: string): SubscriptionStatus | undefined => rows.find((row) => row.id === id)?.status;
    return { service, checkoutsFor, expiredIds, statusOf };
  }

  const refuse = (error: Error): Checkout => async () => {
    throw error;
  };

  it('leaves a trial subscription out of the pre-expiry charge', async () => {
    const h = refusalHarness({
      rows: [
        { id: 'sub-trial', userId: 'user-1', expiresAt: DUE_SOON, isTrial: true },
        { id: 'sub-ordinary', userId: 'user-2', expiresAt: DUE_SOON, isTrial: false },
      ],
      checkout: async ({ subscriptionId }) => ({
        paymentId: `pay-${subscriptionId}`,
        transactionStatus: TransactionStatus.PENDING,
        checkoutUrl: null,
      }),
    });

    const result = await h.service.processAutopayCharges();

    // A trial is upgraded, never renewed (`TRIAL_NOT_RENEWABLE`): charging for
    // one can only be refused.
    assert.deepEqual(h.checkoutsFor, ['sub-ordinary'], 'a trial subscription was sent to the renewal checkout');
    assert.equal(result.attempted, 1);
  });

  it('expires a trial subscription on its date without asking the checkout at all', async () => {
    const h = refusalHarness({
      rows: [{ id: 'sub-trial', userId: 'user-1', expiresAt: PAST_DUE, isTrial: true }],
      checkout: refuse(renewalItemNotPriceable()),
    });

    await h.service.markExpiredSubscriptions();

    assert.equal(h.statusOf('sub-trial'), SubscriptionStatus.EXPIRED, 'the trial was held ACTIVE past its date');
    assert.deepEqual(h.checkoutsFor, [], 'a trial past its date was sent to the renewal checkout');
  });

  const refusedBeforeAnyPayment: ReadonlyArray<[string, () => Error]> = [
    ['no price in the gateway currency (RENEWAL_ITEM_NOT_PRICEABLE)', () => renewalItemNotPriceable()],
    ['the gateway switched off (PAYMENT_GATEWAY_NOT_ACTIVE)', () => new BadRequestException('PAYMENT_GATEWAY_NOT_ACTIVE')],
    ['a blocked owner (USER_BLOCKED)', () => new ForbiddenException({ code: 'USER_BLOCKED', message: 'This account is blocked' })],
  ];
  for (const [what, error] of refusedBeforeAnyPayment) {
    it(`expires on schedule, and asks once, when the renewal is refused for ${what}`, async () => {
      const h = refusalHarness({
        rows: [
          { id: 'sub-refused', userId: 'user-1', expiresAt: PAST_DUE, isTrial: false },
          { id: 'sub-failing-at-provider', userId: 'user-2', expiresAt: PAST_DUE, isTrial: false },
        ],
        checkout: async (input) => {
          if (input.subscriptionId === 'sub-refused') throw error();
          // The non-vacuous neighbour: a real charge that reached the provider
          // and failed. Its row exists, so it keeps its remaining attempts.
          input.writeAttempt(TransactionStatus.FAILED);
          return { paymentId: `pay-${input.idempotencyKey}`, transactionStatus: TransactionStatus.FAILED, checkoutUrl: null };
        },
      });

      await h.service.markExpiredSubscriptions();

      assert.equal(h.statusOf('sub-refused'), SubscriptionStatus.EXPIRED, 'held ACTIVE past its date waiting for a retry that cannot succeed');
      assert.equal(h.statusOf('sub-failing-at-provider'), SubscriptionStatus.ACTIVE, 'a real charge failure lost its remaining attempts');

      await h.service.markExpiredSubscriptions();

      assert.equal(
        h.checkoutsFor.filter((id) => id === 'sub-refused').length,
        1,
        'the refused renewal was asked for again on the next tick',
      );
    });
  }

  it('still gives a charge that failed at the provider all three attempts before expiring it', async () => {
    const h = refusalHarness({
      rows: [{ id: 'sub-failing', userId: 'user-1', expiresAt: PAST_DUE, isTrial: false }],
      checkout: async (input) => {
        input.writeAttempt(TransactionStatus.FAILED);
        return { paymentId: `pay-${input.idempotencyKey}`, transactionStatus: TransactionStatus.FAILED, checkoutUrl: null };
      },
    });

    await h.service.markExpiredSubscriptions();
    await h.service.markExpiredSubscriptions();
    assert.equal(h.statusOf('sub-failing'), SubscriptionStatus.ACTIVE, 'expired before its third attempt');

    await h.service.markExpiredSubscriptions();

    assert.deepEqual(h.checkoutsFor, ['sub-failing', 'sub-failing', 'sub-failing']);
    assert.equal(h.statusOf('sub-failing'), SubscriptionStatus.EXPIRED);
  });

  it('keeps the attempts of a charge refused AFTER its payment row was written', async () => {
    // e.g. the saved card was revoked between the draft and the provider call:
    // the attempt is on record, so it is an ordinary failed attempt, not a
    // refusal of the renewal itself.
    const h = refusalHarness({
      rows: [{ id: 'sub-card-refused', userId: 'user-1', expiresAt: PAST_DUE, isTrial: false }],
      checkout: async (input) => {
        input.writeAttempt(TransactionStatus.FAILED);
        throw new BadRequestException('SAVED_PAYMENT_METHOD_NOT_ACTIVE');
      },
    });

    await h.service.markExpiredSubscriptions();

    assert.equal(h.statusOf('sub-card-refused'), SubscriptionStatus.ACTIVE, 'a recorded attempt was treated as a final refusal');
    await h.service.markExpiredSubscriptions();
    assert.deepEqual(h.checkoutsFor, ['sub-card-refused', 'sub-card-refused']);
  });

  const mayPass: ReadonlyArray<[string, () => Error]> = [
    ['a restricted service (SERVICE_RESTRICTED)', () => new ServiceUnavailableException({ code: 'SERVICE_RESTRICTED', message: 'Service is temporarily unavailable' })],
    ['a network error', () => new Error('connect ECONNRESET')],
  ];
  for (const [what, error] of mayPass) {
    it(`keeps the subscription ACTIVE and asks again after ${what}`, async () => {
      const h = refusalHarness({
        rows: [{ id: 'sub-transient', userId: 'user-1', expiresAt: PAST_DUE, isTrial: false }],
        checkout: refuse(error()),
      });

      await h.service.markExpiredSubscriptions();
      await h.service.markExpiredSubscriptions();

      assert.equal(h.statusOf('sub-transient'), SubscriptionStatus.ACTIVE);
      assert.deepEqual(h.checkoutsFor, ['sub-transient', 'sub-transient']);
    });
  }
});
