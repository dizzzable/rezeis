import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import 'reflect-metadata';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';

/**
 * The paid line an operator would otherwise never hear about
 * ─────────────────────────────────────────────────────────
 *
 * `applyCombinedRenewal` re-asks the eligibility question at CAPTURE time,
 * because eligibility itself only ran at QUOTE time and an operator can lift
 * this one customer's limit to unlimited in between. When the answer has
 * changed the deliberate outcome is CAPTURE AND FLAG — the entitlement is
 * created as quoted and the verdict is written into its immutable
 * `applicabilitySnapshot` — and that reasoning is settled elsewhere
 * (`add-on-capture-time-baseline.spec.ts`) and is not re-litigated here.
 *
 * What it lacked was a READER. The only other trace was a `logger.warn` in a
 * container, which from the operator's seat is indistinguishable from a renewal
 * that delivered everything it sold. These cases pin the three things that make
 * the card trustworthy rather than merely present:
 *
 *   1. It is raised for a line that will add nothing, and NOT for one that
 *      delivers — a signal that fires on everything is not a signal.
 *   2. It is raised only AFTER the fulfillment transaction commits. The verdict
 *      is reached inside the `$transaction`; `SystemEventsService.emit` is
 *      fire-and-forget and lands the instant it is called, so a card written
 *      there announces a capture that a rollback then undoes.
 *   3. It collapses to one card per `subscriptionId:termId:addOnType` per hour,
 *      and the signature really is per-subscription: a bulk renewal is many
 *      lines, but two different subscriptions are two things to look at.
 *
 * Severity is WARNING, not ERROR, and that is asserted rather than assumed: the
 * entitlement is PENDING until the renewed term starts, so this is a prediction
 * an operator can still make right — and `isErrorEvent` routes ERROR through the
 * incident-card formatter, which is the shape for a system fault.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

type Emitted = {
  readonly severity: 'INFO' | 'WARNING' | 'ERROR';
  readonly type: string;
  readonly category: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
};

interface RenewalLine {
  readonly type: 'EXTRA_TRAFFIC' | 'EXTRA_DEVICES';
  readonly value: number;
  readonly sourceLineKey: string;
}

interface RenewalTarget {
  readonly subscriptionId: string;
  /** `0` / `null` is the product's unlimited, which absorbs the paid line. */
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly lines: readonly RenewalLine[];
}

/** What the plan gave this subscription AT ASSIGNMENT — a decidable snapshot. */
function assignedSnapshot(): Record<string, unknown> {
  return {
    id: 'plan-1',
    trafficLimitStrategy: 'NO_RESET',
    trafficLimit: 100,
    deviceLimit: 3,
    internalSquads: [],
    externalSquad: null,
  };
}

function itemSnapshot(): Record<string, unknown> {
  return {
    snapshotVersion: 1,
    snapshotSource: 'RENEWAL_DRAFT',
    purchaseType: 'RENEW',
    id: 'plan-1',
    name: 'P',
    description: null,
    tag: null,
    type: 'BOTH',
    trafficLimit: 100,
    deviceLimit: 3,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: [],
    externalSquad: null,
    selectedDurationDays: 30,
    gatewayType: 'YOOKASSA',
    amount: '10',
    currency: 'USD',
  };
}

/**
 * Drives the REAL `applyCombinedRenewal` over a staged store holding one item
 * per target subscription. `failAtCommit` makes the last write of the
 * transaction throw, which is how a rollback is expressed here: the callback
 * rejects, so nothing the transaction staged survives.
 */
function renewalEnv(input: {
  readonly targets: readonly RenewalTarget[];
  readonly failAtCommit?: boolean;
  readonly service?: PaymentSubscriptionMutationService;
  readonly events?: Emitted[];
  readonly paymentId?: string;
}) {
  const currentExpiry = new Date(Date.now() + 10 * DAY_MS);
  const events: Emitted[] = input.events ?? [];
  const captured: Array<{ readonly sourceLineKey: string; readonly subscriptionId: string }> = [];

  const items = input.targets.map((target, index) => ({
    id: `it-${index + 1}`,
    subscriptionId: target.subscriptionId,
    planId: 'plan-1',
    durationDays: 30,
    appliedAt: null as Date | null,
    amount: '10',
    currency: 'USD',
    planSnapshot: itemSnapshot(),
    addOnLines: target.lines.map((line) => ({
      addOnId: `addon-${line.type}`,
      catalogRevision: 1,
      type: line.type,
      value: line.value,
      lifetime: 'UNTIL_SUBSCRIPTION_END',
      activation: 'TERM_START',
      sourceLineKey: line.sourceLineKey,
      unitAmount: '2.50',
      receiptName: `Paid ${line.type}`,
    })),
  }));

  const subscriptions = new Map(
    input.targets.map((target) => [
      target.subscriptionId,
      {
        id: target.subscriptionId,
        status: 'ACTIVE',
        isTrial: false,
        expiresAt: currentExpiry,
        remnawaveId: 'rw-1',
        internalSquads: [] as string[],
        externalSquad: null as string | null,
        trafficLimit: target.trafficLimit,
        deviceLimit: target.deviceLimit,
        planSnapshot: assignedSnapshot(),
      } as Record<string, unknown>,
    ]),
  );

  const prismaService = {
    transactionItem: { findMany: async () => items },
    user: { updateMany: async () => ({ count: 0 }) },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      // Staging layer: the callback mutates copies, so a rejection leaves the
      // committed store untouched — exactly what a rollback does.
      const staged = new Map(
        [...subscriptions].map(([id, row]) => [id, { ...row }] as const),
      );
      const txClient = {
        $queryRaw: async () => [{ id: 'sub', status: 'ACTIVE' }],
        subscriptionTerm: {
          findFirst: async (query: { where: { status?: unknown } }) =>
            query.where.status === 'ACTIVE'
              ? { id: 'term-active' }
              : { id: 'term-active', status: 'ACTIVE', generation: 1, endsAt: currentExpiry },
        },
        plan: {
          findUnique: async () => ({
            id: 'plan-1',
            name: 'P',
            description: null,
            tag: null,
            type: 'BOTH',
            availability: 'ALL',
            trafficLimit: 100,
            deviceLimit: 3,
            trafficLimitStrategy: 'NO_RESET',
            internalSquads: [],
            externalSquad: null,
          }),
        },
        subscription: {
          findUnique: async ({ where }: { where: { id: string } }) => {
            const row = staged.get(where.id);
            return row === undefined ? null : { ...row };
          },
          update: async ({
            where,
            data,
          }: {
            where: { id: string };
            data: Record<string, unknown>;
          }) => {
            const next = { ...staged.get(where.id)!, ...data };
            staged.set(where.id, next);
            return { ...next };
          },
        },
        subscriptionEffectiveProjection: { findUnique: async () => null },
        profileSyncJob: { create: async ({ data }: { data: object }) => ({ id: 'job', ...data }) },
        transactionItem: {
          updateMany: async () => ({ count: 1 }),
          findUnique: async ({ where }: { where: { id: string } }) =>
            items.find((entry) => entry.id === where.id) ?? null,
        },
        transaction: {
          update: async () => {
            // The fulfillment stamp is the last write of the transaction, so
            // failing it is a commit that never happened.
            if (input.failAtCommit === true) throw new Error('commit failed');
            return {};
          },
        },
      };
      return cb(txClient);
    },
  };

  const entitlements = {
    createPendingInTransaction: async (
      _tx: unknown,
      created: { readonly sourceLineKey: string; readonly subscriptionId: string },
    ) => {
      captured.push({ sourceLineKey: created.sourceLineKey, subscriptionId: created.subscriptionId });
      return {
        entitlementId: `ent-${captured.length}`,
        state: 'PENDING_ACTIVATION',
        created: true,
        eventId: 'ev',
      };
    },
  };
  const terms = {
    createScheduledInTransaction: async (_tx: unknown, termInput: { readonly subscriptionId: string }) => ({
      id: `term-${termInput.subscriptionId}`,
      generation: 2,
      status: 'SCHEDULED',
    }),
  };

  const record =
    (severity: Emitted['severity']) =>
    (type: string, category: string, message: string, metadata: Record<string, unknown>) => {
      events.push({ severity, type, category, message, metadata: metadata ?? {} });
    };

  const service =
    input.service ??
    new PaymentSubscriptionMutationService(
      prismaService as never,
      {
        info: record('INFO'),
        warn: record('WARNING'),
        error: record('ERROR'),
      } as never,
      entitlements as never,
      {} as never,
      terms as never,
    );

  // A service handed in from a previous run keeps its cooldown window, but its
  // prisma double is the OLD one. Re-point it so the second run drives this
  // store — the window is the only state that must survive between runs.
  (service as unknown as { prismaService: unknown }).prismaService = prismaService;
  (service as unknown as { events: unknown }).events = {
    info: record('INFO'),
    warn: record('WARNING'),
    error: record('ERROR'),
  };
  (service as unknown as { addOnEntitlementService: unknown }).addOnEntitlementService = entitlements;
  (service as unknown as { subscriptionTermService: unknown }).subscriptionTermService = terms;

  const transaction = {
    id: 'tx-1',
    paymentId: input.paymentId ?? 'pay-1',
    userId: 'user-1',
    subscriptionId: null,
    purchaseType: 'RENEW',
    gatewayType: 'YOOKASSA',
    currency: 'USD',
    amount: { toString: () => '15' },
    createdAt: new Date(Date.now() - DAY_MS),
    planSnapshot: { combinedRenewal: true, snapshotVersion: 1 },
  };

  return { service, transaction, events, captured };
}

/** Every card this run raised about a paid line that will add nothing. */
function cards(events: readonly Emitted[]): readonly Emitted[] {
  return events.filter((event) => event.type === EVENT_TYPES.PAYMENT_ADDON_ADDS_NOTHING);
}

/** An unlimited device baseline: `<= 0` is the product's canonical unlimited. */
const UNLIMITED_DEVICES = { trafficLimit: 100, deviceLimit: 0 } as const;

describe('a paid renewal add-on that will add nothing reaches an operator', () => {
  it('raises a card naming the subscription, the term and the line', async () => {
    const env = renewalEnv({
      targets: [
        {
          subscriptionId: 'sub-1',
          ...UNLIMITED_DEVICES,
          lines: [{ type: 'EXTRA_DEVICES', value: 2, sourceLineKey: 'renew:sub-1:devices' }],
        },
      ],
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    const raised = cards(env.events);
    assert.equal(
      raised.length,
      1,
      'a customer was charged for a line that will deliver nothing and the only record was a log ' +
        'line in a container. An operator has to be told while the term has not started and the ' +
        'prediction can still be made right.',
    );
    const card = raised[0]!;
    assert.equal(card.category, 'PAYMENT');
    assert.equal(card.metadata.subscriptionId, 'sub-1');
    assert.equal(card.metadata.termId, 'term-sub-1');
    assert.equal(card.metadata.addOnType, 'EXTRA_DEVICES');
    assert.equal(
      card.metadata.sourceLineKey,
      'renew:sub-1:devices',
      'the card must name the ledger key a refund decision is made against — the entitlement was ' +
        'still created, and this is what finds it',
    );
    assert.equal(card.metadata.paymentId, 'pay-1');
    assert.equal(card.metadata.baseDeviceLimit, null);
    assert.equal(
      env.captured.length,
      1,
      'the paid line is still captured; the card reports it, it does not replace it',
    );
  });

  it('raises it as a WARNING, never as an ERROR', async () => {
    // The entitlement is PENDING until the renewed term starts, so this is a
    // prediction an operator can still make right — nothing has failed.
    // `isErrorEvent` also routes ERROR through `formatErrorEventCardHtml`, the
    // fixed-header incident card with build info and a `.txt` attachment, which
    // is the shape for a fault in the system rather than a commercial fact
    // awaiting a human decision before a known deadline.
    const env = renewalEnv({
      targets: [
        {
          subscriptionId: 'sub-1',
          ...UNLIMITED_DEVICES,
          lines: [{ type: 'EXTRA_DEVICES', value: 2, sourceLineKey: 'renew:sub-1:devices' }],
        },
      ],
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.deepEqual(
      cards(env.events).map((event) => event.severity),
      ['WARNING'],
    );
    assert.equal(
      env.events.some((event) => event.severity === 'ERROR'),
      false,
      'no ERROR of any type may be raised for a line that is merely predicted to add nothing',
    );
  });

  it('says nothing about a line that delivers exactly what it sold', async () => {
    // The other direction, and it is not optional: a card raised for every
    // captured line satisfies the case above and is just as useless.
    const env = renewalEnv({
      targets: [
        {
          subscriptionId: 'sub-1',
          trafficLimit: 100,
          deviceLimit: 3,
          lines: [{ type: 'EXTRA_DEVICES', value: 2, sourceLineKey: 'renew:sub-1:devices' }],
        },
      ],
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(cards(env.events).length, 0);
    assert.equal(env.captured.length, 1, 'the line was still captured — the harness really ran');
  });

  it('announces nothing when the fulfillment transaction rolls back', async () => {
    // The verdict is reached INSIDE the `$transaction`. Announced there it
    // reports a capture that the rollback erases, and the webhook's retry
    // reports it a second time — an operator chasing a refund for an
    // entitlement that does not exist.
    const env = renewalEnv({
      targets: [
        {
          subscriptionId: 'sub-1',
          ...UNLIMITED_DEVICES,
          lines: [{ type: 'EXTRA_DEVICES', value: 2, sourceLineKey: 'renew:sub-1:devices' }],
        },
      ],
      failAtCommit: true,
    });

    await assert.rejects(
      () => env.service.applyCompletedTransaction(env.transaction as never),
      /commit failed/,
    );

    assert.equal(
      cards(env.events).length,
      0,
      'the transaction never committed, so there is no captured line to report',
    );
    assert.equal(
      env.events.length,
      0,
      'nothing at all may be announced for a fulfillment that did not happen',
    );
  });

  it('raises one card per subscription on the same bulk renewal', async () => {
    // The signature is `subscriptionId:termId:addOnType`. A GLOBAL window — or a
    // constant signature — would collapse these two into one and hide the
    // second customer entirely.
    const env = renewalEnv({
      targets: [
        {
          subscriptionId: 'sub-1',
          ...UNLIMITED_DEVICES,
          lines: [{ type: 'EXTRA_DEVICES', value: 2, sourceLineKey: 'renew:sub-1:devices' }],
        },
        {
          subscriptionId: 'sub-2',
          ...UNLIMITED_DEVICES,
          lines: [{ type: 'EXTRA_DEVICES', value: 2, sourceLineKey: 'renew:sub-2:devices' }],
        },
      ],
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.deepEqual(
      cards(env.events)
        .map((event) => event.metadata.subscriptionId)
        .sort(),
      ['sub-1', 'sub-2'],
      'two subscriptions are two things for an operator to look at',
    );
  });

  it('raises one card per resource on the same subscription and term', async () => {
    // Traffic and devices are separate products bought separately; a customer
    // can be charged for both and receive neither.
    const env = renewalEnv({
      targets: [
        {
          subscriptionId: 'sub-1',
          trafficLimit: null,
          deviceLimit: 0,
          lines: [
            { type: 'EXTRA_DEVICES', value: 2, sourceLineKey: 'renew:sub-1:devices' },
            { type: 'EXTRA_TRAFFIC', value: 50, sourceLineKey: 'renew:sub-1:traffic' },
          ],
        },
      ],
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.deepEqual(
      cards(env.events)
        .map((event) => event.metadata.addOnType)
        .sort(),
      ['EXTRA_DEVICES', 'EXTRA_TRAFFIC'],
    );
  });

  it('collapses a repeat of the same signature inside the hour to one card', async () => {
    // The same operator mistake on the same term is ONE thing to look at, and a
    // stream nobody can read is the same as no stream. The service instance is
    // reused because the window lives on it.
    const shared: Emitted[] = [];
    const first = renewalEnv({
      targets: [
        {
          subscriptionId: 'sub-1',
          ...UNLIMITED_DEVICES,
          lines: [{ type: 'EXTRA_DEVICES', value: 2, sourceLineKey: 'renew:sub-1:devices' }],
        },
      ],
      events: shared,
    });
    await first.service.applyCompletedTransaction(first.transaction as never);
    assert.equal(cards(shared).length, 1);

    const second = renewalEnv({
      targets: [
        {
          subscriptionId: 'sub-1',
          ...UNLIMITED_DEVICES,
          lines: [{ type: 'EXTRA_DEVICES', value: 2, sourceLineKey: 'renew:sub-1:devices' }],
        },
      ],
      events: shared,
      service: first.service,
      paymentId: 'pay-2',
    });
    await second.service.applyCompletedTransaction(second.transaction as never);

    assert.equal(
      cards(shared).length,
      1,
      'a second capture of the same subscription, term and resource inside the hour must not raise ' +
        'a second card',
    );
  });

  it('raises the card again once the hour has passed', async () => {
    // A WINDOW, not a permanent mute: the condition can still be live an hour
    // later, and an operator who missed the first card has to see it again.
    const shared: Emitted[] = [];
    const first = renewalEnv({
      targets: [
        {
          subscriptionId: 'sub-1',
          ...UNLIMITED_DEVICES,
          lines: [{ type: 'EXTRA_DEVICES', value: 2, sourceLineKey: 'renew:sub-1:devices' }],
        },
      ],
      events: shared,
    });
    await first.service.applyCompletedTransaction(first.transaction as never);
    assert.equal(cards(shared).length, 1);

    // Rewind the window rather than waiting an hour. White-box on purpose: the
    // alternative is a test that cannot distinguish "one card per hour" from
    // "one card ever", which is the failure this case exists to catch.
    const window = (first.service as unknown as { dormantAddOnCardWindow: Map<string, number> })
      .dormantAddOnCardWindow;
    for (const [signature, at] of window) window.set(signature, at - (HOUR_MS + 60_000));

    const second = renewalEnv({
      targets: [
        {
          subscriptionId: 'sub-1',
          ...UNLIMITED_DEVICES,
          lines: [{ type: 'EXTRA_DEVICES', value: 2, sourceLineKey: 'renew:sub-1:devices' }],
        },
      ],
      events: shared,
      service: first.service,
      paymentId: 'pay-2',
    });
    await second.service.applyCompletedTransaction(second.transaction as never);

    assert.equal(cards(shared).length, 2);
  });

  it('does not consume the hourly window on a transaction that rolled back', async () => {
    // The signature check is deferred WITH the card. Burning the window on an
    // attempt that never committed would suppress the card for the retry that
    // did — the worst outcome of the three, because it is silent.
    const shared: Emitted[] = [];
    const failed = renewalEnv({
      targets: [
        {
          subscriptionId: 'sub-1',
          ...UNLIMITED_DEVICES,
          lines: [{ type: 'EXTRA_DEVICES', value: 2, sourceLineKey: 'renew:sub-1:devices' }],
        },
      ],
      events: shared,
      failAtCommit: true,
    });
    await assert.rejects(() => failed.service.applyCompletedTransaction(failed.transaction as never));
    assert.equal(cards(shared).length, 0);

    const retried = renewalEnv({
      targets: [
        {
          subscriptionId: 'sub-1',
          ...UNLIMITED_DEVICES,
          lines: [{ type: 'EXTRA_DEVICES', value: 2, sourceLineKey: 'renew:sub-1:devices' }],
        },
      ],
      events: shared,
      service: failed.service,
    });
    await retried.service.applyCompletedTransaction(retried.transaction as never);

    assert.equal(
      cards(shared).length,
      1,
      'the retry that actually committed must still reach the operator',
    );
  });
});
