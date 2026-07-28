import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Currency, PaymentGatewayType, PlanType, Prisma, PurchaseChannel, PurchaseType, TariffConstructorModuleType, TrafficLimitStrategy, TransactionStatus } from '@prisma/client';

import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PaymentCheckoutExecutorService } from '../src/modules/payments/services/payment-checkout-executor.service';
import { TariffConstructorCheckoutService } from '../src/modules/tariff-constructor/tariff-constructor-checkout.service';
import { decodeTariffConstructorSnapshot, TARIFF_CONSTRUCTOR_SNAPSHOT_SOURCE } from '../src/modules/tariff-constructor/tariff-constructor-snapshot';

const snapshot = {
  snapshotSource: TARIFF_CONSTRUCTOR_SNAPSHOT_SOURCE, snapshotVersion: 1, revisionId: 'revision-1', revision: 3,
  selections: [{ type: TariffConstructorModuleType.DEVICES, value: 4 }, { type: TariffConstructorModuleType.TRAFFIC, value: 75 }],
  lines: [{ kind: 'BASE', module: null, value: null, steps: null, perStepAmount: null, amount: '100' }, { kind: 'MODULE', module: TariffConstructorModuleType.DEVICES, value: 4, steps: 3, perStepAmount: '5', amount: '15' }, { kind: 'MODULE', module: TariffConstructorModuleType.TRAFFIC, value: 75, steps: 5, perStepAmount: '10', amount: '50' }],
  amount: '165', currency: Currency.RUB,
  basePlan: { id: 'plan-1', name: 'Frozen custom', description: 'Frozen description', tag: 'custom', type: PlanType.BOTH, icon: null, trafficLimitStrategy: TrafficLimitStrategy.MONTH, internalSquads: ['squad-1'], externalSquad: 'external-1' },
  trafficLimit: 75, deviceLimit: 4, durationDays: 30, channel: PurchaseChannel.WEB, gatewayType: PaymentGatewayType.YOOKASSA, purchaseType: PurchaseType.NEW,
};

describe('tariff constructor snapshot', () => {
  it('strictly decodes a complete versioned snapshot', () => {
    assert.deepEqual(decodeTariffConstructorSnapshot(snapshot), snapshot);
  });

  it('rejects malformed commercial evidence rather than falling back to a live plan', () => {
    assert.throws(() => decodeTariffConstructorSnapshot({ ...snapshot, trafficLimit: 0 }), { name: 'ConflictException' });
    assert.throws(() => decodeTariffConstructorSnapshot({ ...snapshot, snapshotVersion: 2 }), { name: 'ConflictException' });
    assert.throws(() => decodeTariffConstructorSnapshot({ ...snapshot, selections: snapshot.selections.slice(0, 1) }), { name: 'ConflictException' });
    assert.throws(() => decodeTariffConstructorSnapshot({ ...snapshot, trafficLimit: 76 }), { name: 'ConflictException' });
    assert.throws(() => decodeTariffConstructorSnapshot({ ...snapshot, lines: snapshot.lines.slice(0, 2) }), { name: 'ConflictException' });
    assert.throws(() => decodeTariffConstructorSnapshot({ ...snapshot, amount: '166' }), { name: 'ConflictException' });
  });
});

describe('constructor payment fulfillment', () => {
  it('uses frozen selected limits and operational fields and creates one profile-sync job', async () => {
    const createdSubscriptions: Array<Record<string, unknown>> = [];
    const createdJobs: Array<Record<string, unknown>> = [];
    const userUpdates: Array<Record<string, unknown>> = [];
    const tx = {
      $executeRaw: async () => 1,
      transaction: { findUnique: async () => ({ subscriptionId: null }), update: async () => ({}) },
      subscription: { count: async () => 0, create: async ({ data }: { data: Record<string, unknown> }) => { createdSubscriptions.push(data); return { id: 'sub-1', remnawaveId: null, ...data }; }, findUnique: async () => null },
      profileSyncJob: { create: async ({ data }: { data: Record<string, unknown> }) => { createdJobs.push(data); return { id: 'job-1', ...data }; }, findFirst: async () => null },
      user: { findUnique: async () => ({ maxSubscriptions: 1 }), updateMany: async (args: Record<string, unknown>) => { userUpdates.push(args); return { count: 1 }; } },
      settings: { findFirst: async () => null },
    };
    const prisma = { transactionItem: { findMany: async () => [] }, $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx), user: { updateMany: async () => ({ count: 0 }) } };
    const events: Array<Record<string, unknown>> = [];
    const service = new PaymentSubscriptionMutationService(prisma as never, { info: (_type: string, _category: string, _message: string, data: Record<string, unknown>) => events.push(data) } as never, {} as never, {} as never, {} as never);
    const transaction = { id: 'tx-1', paymentId: 'payment-1', userId: 'user-1', subscriptionId: null, status: TransactionStatus.COMPLETED, purchaseType: PurchaseType.NEW, channel: PurchaseChannel.WEB, gatewayType: PaymentGatewayType.YOOKASSA, gatewayId: null, gatewayData: null, currency: Currency.RUB, paymentAsset: null, amount: new Prisma.Decimal('165'), planSnapshot: snapshot, deviceTypes: [], idempotencyKey: 'key-1', checkoutFingerprint: 'hash', checkoutUrl: null, fulfilledAt: new Date(), createdAt: new Date(), updatedAt: new Date() };

    const result = await service.applyCompletedTransaction(transaction);
    assert.equal(createdSubscriptions.length, 1);
    assert.equal(createdSubscriptions[0]?.['trafficLimit'], 75);
    assert.equal(createdSubscriptions[0]?.['deviceLimit'], 4);
    assert.deepEqual(createdSubscriptions[0]?.['internalSquads'], ['squad-1']);
    assert.equal(createdSubscriptions[0]?.['externalSquad'], 'external-1');
    const planSnapshot = createdSubscriptions[0]?.['planSnapshot'] as Record<string, unknown>;
    assert.equal(planSnapshot['tag'], 'custom');
    assert.equal(planSnapshot['trafficLimitStrategy'], TrafficLimitStrategy.MONTH);
    assert.equal(planSnapshot['trafficLimit'], 75);
    assert.equal(planSnapshot['deviceLimit'], 4);
    assert.equal(planSnapshot['selectedDurationDays'], 30);
    assert.deepEqual(planSnapshot['tariffConstructor'], snapshot);
    assert.equal(createdJobs.length, 1);
    assert.deepEqual(createdJobs[0]?.['payload'], { source: 'PAYMENT_COMPLETION', paymentId: 'payment-1', tariffConstructorRevisionId: 'revision-1', trafficLimit: 75, deviceLimit: 4 });
    assert.equal(result.syncJobs.length, 1);
    assert.equal(events[0]?.['trafficLimitBytes'], 75 * 1024 * 1024 * 1024);
    assert.equal(userUpdates.length, 1);
    assert.deepEqual(userUpdates[0], { where: { id: 'user-1', currentSubscriptionId: null }, data: { currentSubscriptionId: 'sub-1' } });
  });

  it('serializes fulfillment and rejects creation after capacity is exhausted', async () => {
    let lockCalls = 0;
    const tx = {
      $executeRaw: async () => { lockCalls += 1; return 1; },
      transaction: { findUnique: async () => ({ subscriptionId: null }) },
      subscription: { count: async () => 1, findUnique: async () => null },
      user: { findUnique: async () => ({ maxSubscriptions: 1 }) },
      settings: { findFirst: async () => null },
    };
    const prisma = { transactionItem: { findMany: async () => [] }, $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx) };
    const service = new PaymentSubscriptionMutationService(prisma as never, { info: () => undefined } as never, {} as never, {} as never, {} as never);
    const transaction = transactionRow({ status: TransactionStatus.COMPLETED, amount: new Prisma.Decimal('165'), planSnapshot: snapshot });
    await assert.rejects(service.applyCompletedTransaction(transaction), (error: unknown) => String((error as { response?: { code?: string } }).response?.code) === 'SUBSCRIPTION_LIMIT_REACHED');
    assert.equal(lockCalls, 1);
  });
});

const checkoutInput = {
  userId: 'user-1', purchaseType: PurchaseType.NEW, revisionId: 'revision-1', durationDays: 30,
  currency: Currency.RUB, selections: snapshot.selections, gatewayType: PaymentGatewayType.YOOKASSA,
  channel: PurchaseChannel.WEB, idempotencyKey: 'key-1', expectedAmount: '165', expectedCurrency: Currency.RUB,
};

function createCheckoutHarness(options: { existing?: ReturnType<typeof transactionRow> | null; revision?: typeof revision | null; quoteTotal?: string; gateway?: Omit<typeof gateway, 'settings'> & { settings: Record<string, unknown> } } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const revisionValue = options.revision === undefined ? revision : options.revision;
  const prisma = {
    user: { findUnique: async () => ({ id: 'user-1' }) },
    paymentGateway: { findUnique: async () => options.gateway ?? gateway },
    plan: { findFirst: async () => basePlan },
    transaction: {
      findFirst: async () => options.existing ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return transactionRow(data); },
    },
  };
  const executorCalls: Array<Record<string, unknown>> = [];
  const service = new TariffConstructorCheckoutService(
    prisma as never,
    { getEffectiveRevision: async () => revisionValue, quote: async () => ({ contractVersion: 1, revisionId: 'revision-1', durationDays: 30, currency: Currency.RUB, lines: snapshot.lines, total: options.quoteTotal ?? '165' }) } as never,
    { execute: async (input: Record<string, unknown>) => { executorCalls.push(input); return response(input['transaction'] as ReturnType<typeof transactionRow>); } } as never,
    { getInternalPlatformPolicy: async () => ({ accessMode: 'OPEN' }) } as never,
    { evaluate: () => null } as never,
    { getSubscriptionCapacity: async () => ({ capacityAvailable: true }) } as never,
  );
  return { service, created, executorCalls };
}

const revision = { id: 'revision-1', version: 3, basePlanId: 'plan-1' };
const gateway = { id: 'gateway-1', type: PaymentGatewayType.YOOKASSA, currency: Currency.RUB, isActive: true, settings: { shopId: 'configured', secretKey: 'configured' } };
const basePlan = { id: 'plan-1', name: 'Frozen custom', description: 'Frozen description', tag: 'custom', type: PlanType.BOTH, icon: null, trafficLimitStrategy: TrafficLimitStrategy.MONTH, internalSquads: ['squad-1'], externalSquad: 'external-1', isActive: true, isArchived: false };

function transactionRow(overrides: Record<string, unknown> = {}) {
  return { id: 'tx-1', paymentId: 'payment-1', userId: 'user-1', subscriptionId: null, status: TransactionStatus.PENDING, purchaseType: PurchaseType.NEW, channel: PurchaseChannel.WEB, gatewayType: PaymentGatewayType.YOOKASSA, gatewayId: null, gatewayData: null, currency: Currency.RUB, paymentAsset: null, amount: new Prisma.Decimal('165'), planSnapshot: snapshot, deviceTypes: [], idempotencyKey: 'key-1', checkoutFingerprint: null, checkoutUrl: null, fulfilledAt: null, createdAt: new Date('2026-07-28T00:00:00Z'), updatedAt: new Date('2026-07-28T00:00:00Z'), ...overrides };
}

function response(transaction: ReturnType<typeof transactionRow>) {
  return { paymentId: transaction.paymentId, transactionStatus: transaction.status, gatewayType: transaction.gatewayType, purchaseType: transaction.purchaseType, amount: transaction.amount.toString(), currency: transaction.currency, checkoutUrl: transaction.checkoutUrl, providerMode: 'REDIRECT', createdAt: transaction.createdAt.toISOString() };
}

describe('TariffConstructorCheckoutService', () => {
  it('rejects a server-side quote mismatch before creating a transaction', async () => {
    const harness = createCheckoutHarness({ quoteTotal: '166' });
    await assert.rejects(harness.service.checkout(checkoutInput), (error: unknown) => String((error as { response?: { code?: string } }).response?.code) === 'TARIFF_CONSTRUCTOR_QUOTE_MISMATCH');
    assert.equal(harness.created.length, 0);
  });

  it('rejects gateways outside the conservative YooKassa allowlist', async () => {
    const harness = createCheckoutHarness();
    await assert.rejects(harness.service.checkout({ ...checkoutInput, gatewayType: PaymentGatewayType.CRYPTOPAY }), { message: 'TARIFF_CONSTRUCTOR_GATEWAY_UNSUPPORTED' });
    assert.equal(harness.created.length, 0);
  });

  it('replays the same key and fingerprint without invoking quote or provider', async () => {
    const seed = createCheckoutHarness();
    await seed.service.checkout(checkoutInput);
    const persisted = transactionRow({ checkoutFingerprint: seed.created[0]?.['checkoutFingerprint'], checkoutUrl: 'https://provider.test/pay' });
    const replay = createCheckoutHarness({ existing: persisted });
    const result = await replay.service.checkout(checkoutInput);
    assert.equal(result.paymentId, 'payment-1');
    assert.equal(result.checkoutUrl, 'https://provider.test/pay');
    assert.equal(replay.created.length, 0);
    assert.equal(replay.executorCalls.length, 0);
  });

  it('conflicts when the same key has a changed fingerprint', async () => {
    const harness = createCheckoutHarness({ existing: transactionRow({ checkoutFingerprint: 'different', checkoutUrl: 'https://provider.test/pay' }) });
    await assert.rejects(harness.service.checkout(checkoutInput), (error: unknown) => String((error as { response?: { code?: string } }).response?.code) === 'IDEMPOTENCY_KEY_CONFLICT');
  });

  it('rejects disabled and stale revisions', async () => {
    await assert.rejects(createCheckoutHarness({ revision: null }).service.checkout(checkoutInput), { name: 'NotFoundException' });
    await assert.rejects(createCheckoutHarness({ revision: { ...revision, id: 'revision-2' } }).service.checkout(checkoutInput), { name: 'ConflictException' });
  });

  it('persists the recomputed immutable snapshot and canonical fingerprint', async () => {
    const harness = createCheckoutHarness();
    await harness.service.checkout(checkoutInput);
    assert.equal(harness.created.length, 1);
    assert.match(String(harness.created[0]?.['checkoutFingerprint']), /^[a-f0-9]{64}$/);
    const persisted = harness.created[0]?.['planSnapshot'] as Record<string, unknown>;
    assert.equal(persisted['amount'], '165');
    assert.equal(persisted['revisionId'], 'revision-1');
    assert.deepEqual(persisted['selections'], snapshot.selections);
    assert.equal(harness.executorCalls.length, 1);
  });

  it('allows a zero-price checkout without an active configured gateway', async () => {
    const harness = createCheckoutHarness({ quoteTotal: '0', gateway: { ...gateway, isActive: false, settings: {} } });
    await harness.service.checkout({ ...checkoutInput, expectedAmount: '0' });
    assert.equal(harness.created.length, 1);
    assert.equal(harness.executorCalls.length, 1);
  });

  it('returns unresolved-provider semantics for a paid pending replay without a URL', async () => {
    const seed = createCheckoutHarness();
    await seed.service.checkout(checkoutInput);
    const harness = createCheckoutHarness({ existing: transactionRow({ checkoutFingerprint: seed.created[0]?.['checkoutFingerprint'] }) });
    await assert.rejects(harness.service.checkout(checkoutInput), (error: unknown) => String((error as { response?: { code?: string } }).response?.code) === 'PROVIDER_CHECKOUT_CREATION_UNRESOLVED');
  });
});

describe('PaymentCheckoutExecutorService provider claim', () => {
  it('submits to the provider once and leaves a paid failed attempt unresolved', async () => {
    let providerCalls = 0;
    let claimed = false;
    const prisma = {
      transaction: {
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          if ('gatewayId' in data) {
            if (claimed) return { count: 0 };
            claimed = true;
          }
          return { count: 1 };
        },
        findFirst: async () => claimed ? { id: 'tx-1' } : null,
      },
    };
    const executor = new PaymentCheckoutExecutorService(
      prisma as never,
      { createCheckout: async () => { providerCalls += 1; throw new Error('provider timeout'); } } as never,
      {} as never, {} as never, {} as never, {} as never,
      { warn: () => undefined } as never,
    );
    const transaction = transactionRow();
    await assert.rejects(executor.execute({ transaction, gateway: gateway as never, description: 'Custom plan' }), /provider timeout/);
    await assert.rejects(executor.execute({ transaction, gateway: gateway as never, description: 'Custom plan' }), (error: unknown) => String((error as { response?: { code?: string } }).response?.code) === 'PROVIDER_CHECKOUT_CREATION_UNRESOLVED');
    assert.equal(providerCalls, 1);
  });

  it('validates a saved method before claiming provider creation', async () => {
    let claims = 0;
    const executor = new PaymentCheckoutExecutorService(
      { transaction: { updateMany: async () => { claims += 1; return { count: 1 }; }, findFirst: async () => null } } as never,
      { createCheckout: async () => { throw new Error('must not submit'); } } as never,
      {} as never, {} as never,
      { withActiveForCharge: async () => { throw new Error('invalid saved method'); } } as never,
      {} as never, { warn: () => undefined } as never,
    );
    await assert.rejects(executor.execute({ transaction: transactionRow(), gateway: gateway as never, description: 'Custom plan', savedPaymentMethodId: 'method-1' }), /invalid saved method/);
    assert.equal(claims, 0);
  });

  it('marks the provider outcome unresolved when persisting a successful create fails', async () => {
    let unresolvedWrites = 0;
    const prisma = {
      transaction: {
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          if ('gatewayData' in data) unresolvedWrites += 1;
          return { count: 1 };
        },
        update: async () => { throw new Error('database unavailable'); },
        findFirst: async () => ({ id: 'tx-1' }),
      },
    };
    const executor = new PaymentCheckoutExecutorService(
      prisma as never,
      { createCheckout: async () => ({ gatewayId: 'provider-1', gatewayData: {}, checkoutUrl: 'https://provider.test/pay', providerMode: 'REDIRECT', providerStatus: 'pending' }) } as never,
      {} as never, {} as never, {} as never, {} as never, { warn: () => undefined } as never,
    );
    await assert.rejects(executor.execute({ transaction: transactionRow(), gateway: gateway as never, description: 'Custom plan' }), /database unavailable/);
    assert.equal(unresolvedWrites, 1);
  });
});
