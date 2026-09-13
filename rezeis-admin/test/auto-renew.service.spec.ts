import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentGatewayType, SubscriptionStatus, TransactionStatus } from '@prisma/client';

import { AutoRenewService } from '../src/modules/auto-renew/auto-renew.service';

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
