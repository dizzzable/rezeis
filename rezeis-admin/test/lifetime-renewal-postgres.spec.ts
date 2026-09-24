import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';

import { Logger } from '@nestjs/common';
import {
  AddOnEntitlementState,
  AddOnLifetime,
  AddOnType,
  Currency,
  PaymentGatewayType,
  Prisma,
  ProviderSubscriptionStatus,
  PurchaseChannel,
  PurchaseType,
  SubscriptionStatus,
  SubscriptionTermStatus,
  TransactionStatus,
  type Transaction,
  UserRole,
} from '@prisma/client';
import { of, throwError } from 'rxjs';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { SystemEventsService } from '../src/common/services/system-events.service';
import type { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { AutoRenewService } from '../src/modules/auto-renew/auto-renew.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import { PaymentRefundService } from '../src/modules/payments/services/payment-refund.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PaymentsTransactionsService } from '../src/modules/payments/services/payments-transactions.service';
import { ProviderSubscriptionService } from '../src/modules/payments/services/provider-subscription.service';
import {
  LIFETIME_RENEWAL_NOT_APPLIED_CODE,
  LIFETIME_RENEWAL_NOT_APPLIED_KEY,
  SUBSCRIPTION_IS_LIFETIME_CODE,
  subscriptionIsLifetime,
} from '../src/modules/payments/utils/lifetime-renewal.util';
import { readWithheldConversion } from '../src/modules/payments/utils/trial-conversion.util';
import { PlanCatalogService } from '../src/modules/plans/services/plan-catalog.service';
import { PricingService } from '../src/modules/plans/services/pricing.service';
import { SubscriptionQuoteService } from '../src/modules/subscriptions/services/subscription-quote.service';
import { SubscriptionRenewalService } from '../src/modules/subscriptions/services/subscription-renewal.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';

/**
 * A SUBSCRIPTION WITH NO END DATE IS NEITHER RENEWED NOR UPGRADED BY A PURCHASE
 * (the owner, 24.09.2026), on PostgreSQL, through the real quote, the real
 * renewal pricing, the real draft, the real fulfilment, the real term services,
 * the real post-payment hooks door, «Отметить возврат», autopay's real queries
 * and the provider sweep's real pass.
 *
 *  1. Nothing offers a renewal or an upgrade, and every checkout refuses both
 *     before money is asked: the quote, the action policy, the renewal list,
 *     the combined pricing, its keyed replay and the single draft (gateway and
 *     partner balance alike) — with a subscription that has a date beside it,
 *     priced, so the refusals are about the date and nothing else. A trial is
 *     still upgraded. The same for a subscription with a date whose paid
 *     periods end in a queued one without an end (R1-08).
 *  2. A renewal or an upgrade paid anyway changes nothing and is WITHHELD, as a
 *     trial's second conversion is: settled, no post-payment hook, «Не
 *     применён» with «Отметить возврат», and the operator's «Платёж получен,
 *     но не применён» asking for the refund — never «Платёж получен» for a
 *     sale. A combined renewal whose other lines renewed stands, and its card
 *     names the lifetime line's part to return. From the partner balance the
 *     fulfilment refuses instead, so the balance goes back.
 *  3. ЮKassa autopay never charges one, and a charge refused because the
 *     subscription became lifetime meanwhile does not expire it.
 *  4. A Platega or RollyPay subscription left on one is cancelled by the sweep.
 *
 * Every instant is anchored to now. Skipped without TEST_DATABASE_URL; listed
 * in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `w5life-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;
const GIB = 1024n * 1024n * 1024n;
const FLAGS = ['ADDON_ENTITLEMENT_SHADOW', 'ADDON_ENTITLEMENT_DIRECT_PURCHASE'] as const;

interface Emitted {
  readonly severity: string;
  readonly type: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

interface Owner {
  readonly userId: string;
  readonly subscriptionId: string;
}

let prisma: PrismaService;
let fulfilment: PaymentSubscriptionMutationService;
let cutover: EntitlementCutoverService;
let terms: SubscriptionTermService;
let quotes: SubscriptionQuoteService;
let renewals: SubscriptionRenewalService;
let drafts: PaymentsTransactionsService;
let reconciliation: PaymentReconciliationService;
let refunds: PaymentRefundService;
const emitted: Emitted[] = [];
/** The post-payment hooks, by the payment they were asked about. */
const hooks = { referral: [] as string[], partner: [] as string[], cashback: [] as string[], moyNalog: [] as string[], ads: [] as string[] };
const created = { plans: [] as string[], users: [] as string[], admins: [] as string[] };
let gatewaysBefore: ReadonlyArray<{ type: PaymentGatewayType; isActive: boolean; currency: Currency }> = [];
let createdGateway = false;
let counter = 0;
const next = (): number => ++counter;
const inDays = (days: number): Date => new Date(Date.now() + days * DAY_MS);

// ── Fixtures ───────────────────────────────────────────────────────────────

async function createPlan(options: { readonly upgradeTo?: readonly string[]; readonly trial?: boolean } = {}): Promise<string> {
  const id = `${prefix}-plan-${next()}`;
  await prisma.plan.create({
    data: {
      id,
      name: id,
      orderIndex: 910_000 + next(),
      trafficLimit: 100,
      deviceLimit: 3,
      internalSquads: [],
      externalSquad: null,
      trafficLimitStrategy: 'NO_RESET',
      availability: options.trial === true ? 'TRIAL' : 'ALL',
      upgradeToPlanIds: [...(options.upgradeTo ?? [])],
      durations: { create: [{ days: 30, prices: { create: [{ currency: 'RUB', price: '299' }] } }] },
    },
  });
  created.plans.push(id);
  return id;
}

async function newUser(): Promise<string> {
  const id = `${prefix}-user-${next()}`;
  await prisma.user.create({ data: { id, referralCode: `${id}-ref`, name: id } });
  created.users.push(id);
  return id;
}

/** A subscription on `planId`, the plan's limits in its snapshot and columns; lifetime unless given a date. */
async function subscriptionOn(
  planId: string,
  options: {
    readonly userId?: string;
    readonly expiresAt?: Date | null;
    readonly status?: SubscriptionStatus;
    readonly isTrial?: boolean;
  } = {},
): Promise<Owner> {
  const userId = options.userId ?? (await newUser());
  const panelId = 840_000 + next();
  const subscription = await prisma.subscription.create({
    data: {
      userId,
      status: options.status ?? SubscriptionStatus.ACTIVE,
      isTrial: options.isTrial ?? false,
      planSnapshot: {
        id: planId,
        name: planId,
        trafficLimit: 100,
        deviceLimit: 3,
        trafficLimitStrategy: 'NO_RESET',
        internalSquads: [],
        externalSquad: null,
        selectedDurationDays: 30,
      } as Prisma.InputJsonValue,
      trafficLimit: 100,
      deviceLimit: 3,
      remnawaveId: String(panelId),
      remnawavePanelId: panelId,
      createdAt: inDays(-10),
      startedAt: inDays(-10),
      expiresAt: options.expiresAt === undefined ? null : options.expiresAt,
    },
    select: { id: true },
  });
  return { userId, subscriptionId: subscription.id };
}

/** Into the term model the way the background cutover brings it. */
async function enter(subscriptionId: string): Promise<void> {
  const entered = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, subscriptionId));
  assert.equal(entered.outcome, 'CREATED', 'fixture: entered the model');
}

/**
 * The incident R1-08 is about: a period bought without an end is queued after
 * the current one, and an operator then moved the date to `dated`, at or
 * before its start. Returns the queued term's id.
 */
async function queueOpenEndedPeriod(owner: Owner, input: { readonly startsAt: Date; readonly dated: Date }): Promise<string> {
  await enter(owner.subscriptionId);
  const queued = await prisma.$transaction((tx) =>
    terms.createScheduledInTransaction(tx, {
      subscriptionId: owner.subscriptionId,
      planSnapshot: {},
      startsAt: input.startsAt,
      endsAt: null,
      baseTrafficLimitBytes: 100n * GIB,
      baseDeviceLimit: 3,
      trafficResetStrategy: 'NO_RESET',
      resetAnchorAt: input.startsAt,
    }),
  );
  await prisma.subscription.update({ where: { id: owner.subscriptionId }, data: { expiresAt: input.dated } });
  return queued.id;
}

/** A live add-on bound to `termId` that ends with the subscription — none, for a lifetime one. */
async function addOnRow(owner: Owner, termId: string): Promise<string> {
  const payment = await prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${next()}`,
      userId: owner.userId,
      subscriptionId: owner.subscriptionId,
      status: 'COMPLETED',
      purchaseType: 'ADDITIONAL',
      channel: 'WEB',
      gatewayType: 'YOOKASSA',
      currency: 'RUB',
      amount: new Prisma.Decimal('99'),
      planSnapshot: { snapshotSource: 'ADDON_PURCHASE' } as Prisma.InputJsonValue,
      fulfilledAt: inDays(-2),
    },
  });
  const row = await prisma.addOnEntitlement.create({
    data: {
      subscriptionId: owner.subscriptionId,
      termId,
      sourceTransactionId: payment.id,
      sourceLineKey: 'line',
      catalogRevision: 1,
      receiptName: 'EXTRA_DEVICES +2',
      type: AddOnType.EXTRA_DEVICES,
      valuePerUnit: 2,
      totalValue: 2n,
      lifetime: AddOnLifetime.UNTIL_SUBSCRIPTION_END,
      unitAmount: new Prisma.Decimal('99'),
      totalAmount: new Prisma.Decimal('99'),
      currency: 'RUB',
      purchasedAt: inDays(-2),
      scheduledActivationAt: inDays(-2),
      activatedAt: inDays(-2),
      expiresAt: null,
      state: AddOnEntitlementState.ACTIVE,
    },
  });
  return row.id;
}

/** A single renewal or upgrade the provider confirmed, as the row stands before fulfilment. */
async function paidRow(
  owner: Owner,
  planId: string,
  options: { readonly purchaseType?: PurchaseType; readonly gatewayType?: PaymentGatewayType; readonly convertsTrial?: boolean } = {},
): Promise<Transaction> {
  return prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${next()}`,
      userId: owner.userId,
      subscriptionId: owner.subscriptionId,
      status: 'COMPLETED',
      purchaseType: options.purchaseType ?? PurchaseType.RENEW,
      channel: 'WEB',
      gatewayType: options.gatewayType ?? 'YOOKASSA',
      currency: 'RUB',
      amount: new Prisma.Decimal('299'),
      planSnapshot: {
        id: planId,
        selectedDurationDays: 30,
        ...(options.convertsTrial === true ? { convertsTrial: true } : {}),
      } as Prisma.InputJsonValue,
    },
  });
}

/** Fulfilled the way the webhook does it; the row as it is afterwards. */
async function fulfil(row: Transaction): Promise<Transaction> {
  await fulfilment.applyCompletedTransaction(row);
  return prisma.transaction.findUniqueOrThrow({ where: { id: row.id } });
}

async function payRenewal(owner: Owner, planId: string): Promise<Transaction> {
  return fulfil(await paidRow(owner, planId));
}

/** A combined renewal of `lines` the provider confirmed, fulfilled the way the webhook does it. */
async function payCombined(userId: string, lines: ReadonlyArray<{ owner: Owner; planId: string }>): Promise<Transaction> {
  const row = await prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${next()}`,
      userId,
      subscriptionId: null,
      status: 'COMPLETED',
      purchaseType: PurchaseType.RENEW,
      channel: 'WEB',
      gatewayType: 'YOOKASSA',
      currency: 'RUB',
      amount: new Prisma.Decimal(299 * lines.length),
      planSnapshot: { combinedRenewal: true, snapshotVersion: 1, itemCount: lines.length } as Prisma.InputJsonValue,
    },
  });
  await prisma.transactionItem.createMany({
    data: lines.map((line) => ({
      transactionId: row.id,
      subscriptionId: line.owner.subscriptionId,
      planId: line.planId,
      durationDays: 30,
      amount: new Prisma.Decimal('299'),
      currency: 'RUB' as const,
    })),
  });
  return fulfil(row);
}

/** Everything a renewal could have written on the row, and nothing that moves on its own. */
async function rowState(subscriptionId: string): Promise<Record<string, unknown>> {
  const { updatedAt: _updatedAt, ...row } = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  return row;
}

async function termsOf(subscriptionId: string) {
  return prisma.subscriptionTerm.findMany({ where: { subscriptionId }, orderBy: { generation: 'asc' } });
}

async function syncJobsOf(subscriptionId: string): Promise<number> {
  return prisma.profileSyncJob.count({ where: { subscriptionId } });
}

function eventsOf(type: string, where: (metadata: Record<string, unknown>) => boolean): Emitted[] {
  return emitted.filter((event) => event.type === type && where(event.metadata));
}

function gatewayDataOf(row: Transaction): Record<string, unknown> {
  return (row.gatewayData ?? {}) as Record<string, unknown>;
}

/**
 * Withheld for refund, the way a trial's second conversion is: settled, marked
 * with the reason, told to the operator once as «Платёж получен, но не
 * применён» — never as a completed sale — and nothing the customer's
 * subscription would announce. Returns the operator's one card.
 */
function assertWithheld(paid: Transaction, subscriptionIds: readonly string[]): Emitted {
  assert.equal(paid.status, TransactionStatus.COMPLETED);
  assert.notEqual(paid.fulfilledAt, null, 'settled, not left for the webhook to retry');
  const gatewayData = gatewayDataOf(paid);
  assert.equal(typeof gatewayData['conversionWithheldAt'], 'string', 'not withheld: every hook would pay out on it');
  assert.equal(gatewayData['withheldReason'], SUBSCRIPTION_IS_LIFETIME_CODE);
  // What «Платежи» reads: «Не применён», in the lifetime wording — and no
  // `reason`, which the user card's schema knows only two values of.
  assert.deepEqual(readWithheldConversion(paid.gatewayData), {
    lifetimeSubscription: true,
    withheldAt: gatewayData['conversionWithheldAt'],
    convertedByPaymentId: null,
    refundedAt: null,
  });
  assert.deepEqual(
    eventsOf('payment.completed', (metadata) => metadata['paymentId'] === paid.paymentId),
    [],
    'a payment applied to nothing was announced as a completed sale',
  );
  for (const subscriptionId of subscriptionIds) {
    assert.deepEqual(
      eventsOf('subscription.renewed', (metadata) => metadata['subscriptionId'] === subscriptionId),
      [],
      '«Подписка продлена» for a renewal that renewed nothing',
    );
  }
  const notices = eventsOf('payment.withheld', (metadata) => metadata['paymentId'] === paid.paymentId);
  assert.equal(notices.length, 1, 'one operator card per payment');
  assert.equal(notices[0]!.severity, 'WARNING');
  assert.equal(notices[0]!.metadata['withheldReason'], SUBSCRIPTION_IS_LIFETIME_CODE);
  assert.equal(notices[0]!.metadata['needsManualReview'], true);
  const note = String(notices[0]!.metadata['note']);
  for (const subscriptionId of subscriptionIds) assert.match(note, new RegExp(subscriptionId));
  assert.match(note, /Верните деньги у платёжного провайдера \(YOOKASSA\), затем отметьте это в панели: «Платежи» → «Транзакции» → этот платёж → «Отметить возврат»\./);
  return notices[0]!;
}

async function withFlagsOn<T>(body: () => Promise<T>): Promise<T> {
  const previous = FLAGS.map((name) => [name, process.env[name]] as const);
  for (const name of FLAGS) process.env[name] = 'true';
  try {
    return await body();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** The refusal a call made, by its code: `SUBSCRIPTION_IS_LIFETIME` or whatever else it threw. */
async function refusalOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error: unknown) {
    const response = (error as { getResponse?: () => unknown }).getResponse?.();
    if (typeof response === 'object' && response !== null && typeof (response as { code?: unknown }).code === 'string') {
      return (response as { code: string }).code;
    }
    return error instanceof Error ? error.message : String(error);
  }
  return 'NOT_REFUSED';
}

/** The card an operator reads for `metadata`, through the real formatter. */
async function card(type: string, message: string, metadata: Record<string, unknown>): Promise<string> {
  let text: string | null = null;
  const capture = (event: string, meta: Record<string, unknown>): void => {
    if (event === 'reiwa.dev.notify') text = (meta['text'] as string | undefined) ?? null;
  };
  const renderer = new SystemEventsService(
    {
      settings: {
        findFirst: async () => ({
          systemNotifications: { telegram: { enabled: false, chatId: null, devChatId: null } },
          platformPolicy: {},
        }),
      },
      adminAuditLog: { create: async () => ({}) },
    } as never,
    { enabled: false, urls: [] } as never,
    {
      post: () => {
        throw new Error('no Bot API in this spec');
      },
    } as never,
    {
      get: (token: unknown) => {
        if (token === BotNotifierClient) {
          return {
            deliverRelayEvent: async (event: string, meta: Record<string, unknown>) => {
              capture(event, meta);
              return { status: 'unconfirmed', messageId: null, httpStatus: 204, detail: null };
            },
          };
        }
        if (token === ReiwaRelayQueueService) {
          return {
            enqueue: async (event: string, meta: Record<string, unknown>) => {
              capture(event, meta);
              return true;
            },
          };
        }
        throw new Error('not registered');
      },
    } as never,
  );
  const savedToken = process.env.BOT_TOKEN;
  delete process.env.BOT_TOKEN;
  try {
    renderer.warn(type, 'PAYMENT', message, metadata);
    for (let attempt = 0; attempt < 40 && text === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    if (savedToken !== undefined) process.env.BOT_TOKEN = savedToken;
  }
  assert.ok(text !== null, 'the card was rendered');
  return text;
}

const OPERATOR: CurrentAdminInterface = {
  id: '',
  login: 'operator',
  email: null,
  name: 'Operator',
  role: UserRole.ADMIN,
  isActive: true,
  tokenVersion: 1,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  lastLoginAt: null,
  lastLoginIp: null,
  rbacRoleId: null,
  mustChangePassword: false,
};

// ── The spec ───────────────────────────────────────────────────────────────

run('a subscription with no end date is neither renewed nor upgraded by a purchase (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    for (const name of FLAGS) process.env[name] = 'false';
    prisma = new PrismaService();
    await prisma.$connect();
    const record =
      (severity: string) =>
      (type: string, _category: string, message: string, metadata: Record<string, unknown> = {}) => {
        emitted.push({ severity, type, message, metadata });
      };
    const events = { info: record('INFO'), warn: record('WARNING'), error: record('ERROR'), emit: () => undefined };
    terms = new SubscriptionTermService();
    const projection = new EffectiveProjectionService();
    cutover = new EntitlementCutoverService(prisma, terms, projection);
    fulfilment = new PaymentSubscriptionMutationService(
      prisma,
      events as never,
      new AddOnEntitlementService(),
      projection,
      terms,
      {} as never,
      cutover,
    );
    const catalog = new PlanCatalogService(prisma, new PricingService(), {
      loadConfig: async () => ({ enabled: false, percent: 0, defaultCurrency: 'RUB' }),
    } as never);
    quotes = new SubscriptionQuoteService(prisma, catalog, new PricingService());
    renewals = new SubscriptionRenewalService(prisma, quotes);
    drafts = new PaymentsTransactionsService(prisma, quotes);
    // The post-payment hooks are spies; everything between them and the row is real.
    reconciliation = new PaymentReconciliationService(
      prisma,
      {} as never,
      fulfilment,
      {} as never,
      {
        processPartnerEarning: async (input: { readonly sourceTransactionId: string }) => {
          hooks.partner.push(input.sourceTransactionId);
        },
        reverseEarningsForTransaction: async () => 0,
      } as never,
      {
        qualifyReferralAfterPurchase: async (transactionId: string) => {
          hooks.referral.push(transactionId);
          return null;
        },
        reverseQualificationForTransaction: async () => undefined,
      } as never,
      { enqueue: async () => undefined } as never,
      events as never,
      {
        enqueueRegisterIncome: async (transactionId: string) => {
          hooks.moyNalog.push(transactionId);
        },
        enqueueCancelIncome: async () => undefined,
      } as never,
      {
        recordFirstPurchase: async (input: { readonly id: string }) => {
          hooks.ads.push(input.id);
        },
        revertConversion: async () => undefined,
      } as never,
      { upsertFromYookassaPayment: async () => undefined, disableAutopayForProviderMethod: async () => undefined } as never,
      { verifyCompletion: async () => ({ outcome: 'CONFIRMED' }) } as never,
      {
        creditForTransactionBestEffort: async (transaction: { readonly id: string }) => {
          hooks.cashback.push(transaction.id);
          return null;
        },
        reverseForTransactionBestEffort: async () => undefined,
      } as never,
      { create: async () => undefined } as never,
    );
    // «Отметить возврат» sends nothing to a provider: no HTTP client, no redaction.
    refunds = new PaymentRefundService(prisma, {} as never, {} as never, reconciliation);

    // One active RUB gateway and nothing else, so "priced" means one thing;
    // put back as it was in `after`.
    gatewaysBefore = (await prisma.paymentGateway.findMany({ select: { type: true, isActive: true, currency: true } })).map(
      (row) => ({ type: row.type, isActive: row.isActive, currency: row.currency }),
    );
    await prisma.paymentGateway.updateMany({ data: { isActive: false } });
    if (gatewaysBefore.some((row) => row.type === PaymentGatewayType.YOOKASSA)) {
      await prisma.paymentGateway.update({
        where: { type: PaymentGatewayType.YOOKASSA },
        data: { isActive: true, currency: 'RUB' },
      });
    } else {
      await prisma.paymentGateway.create({ data: { type: PaymentGatewayType.YOOKASSA, currency: 'RUB', isActive: true } });
      createdGateway = true;
    }
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.providerSubscription
      .deleteMany({ where: { providerSubscriptionId: { startsWith: prefix } } })
      .catch(() => undefined);
    await prisma.adminAuditLog.deleteMany({ where: { adminUserId: { in: created.admins } } }).catch(() => undefined);
    await prisma.adminUser.deleteMany({ where: { id: { in: created.admins } } }).catch(() => undefined);
    await removeDurableFixtures(prisma, created.users).catch((error: unknown) => {
      console.error('lifetime renewal cleanup failed', error);
    });
    await prisma.plan.deleteMany({ where: { id: { in: created.plans } } }).catch(() => undefined);
    if (createdGateway) {
      await prisma.paymentGateway.deleteMany({ where: { type: PaymentGatewayType.YOOKASSA } }).catch(() => undefined);
    }
    for (const row of gatewaysBefore) {
      await prisma.paymentGateway
        .update({ where: { type: row.type }, data: { isActive: row.isActive, currency: row.currency } })
        .catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  // ── 1 ─────────────────────────────────────────────────────────────────────

  describe('nothing offers a renewal or an upgrade, and every checkout refuses both before money is asked', () => {
    it('the quote and the action policy say it is lifetime; the dated subscription beside it is priced', async () => {
      const target = await createPlan();
      const plan = await createPlan({ upgradeTo: [target] });
      const lifetime = await subscriptionOn(plan);
      const dated = await subscriptionOn(plan, { userId: lifetime.userId, expiresAt: inDays(20) });
      const quote = (subscriptionId: string, purchaseType: PurchaseType, planId: string) =>
        quotes.getQuote({
          userId: lifetime.userId,
          purchaseType,
          subscriptionId,
          planId,
          durationDays: 30,
          channel: PurchaseChannel.WEB,
        });

      for (const [purchaseType, planId] of [
        [PurchaseType.RENEW, plan],
        [PurchaseType.UPGRADE, target],
      ] as const) {
        const refused = await quote(lifetime.subscriptionId, purchaseType, planId);
        assert.equal(refused.isEligible, false, purchaseType);
        assert.equal(refused.price, null, purchaseType);
        assert.equal(refused.warnings[0]?.code, SUBSCRIPTION_IS_LIFETIME_CODE, `${purchaseType}: named first`);
        const priced = await quote(dated.subscriptionId, purchaseType, planId);
        assert.equal(priced.isEligible, true, `control: the same ${purchaseType} of a subscription with a date`);
        assert.equal(priced.price?.price, '299');
      }

      const policy = await quotes.getActionPolicy({ userId: lifetime.userId, subscriptionId: lifetime.subscriptionId });
      assert.equal(policy.actions.RENEW, false);
      assert.equal(policy.actions.UPGRADE, false);
      assert.ok(policy.warnings.some((warning) => warning.code === SUBSCRIPTION_IS_LIFETIME_CODE));
      const datedPolicy = await quotes.getActionPolicy({ userId: lifetime.userId, subscriptionId: dated.subscriptionId });
      assert.equal(datedPolicy.actions.RENEW, true);
      assert.equal(datedPolicy.actions.UPGRADE, true);
    });

    it('a trial with no end date is still upgraded: that is how a trial is left', async () => {
      const target = await createPlan();
      const trialPlan = await createPlan({ upgradeTo: [target], trial: true });
      const trial = await subscriptionOn(trialPlan, { isTrial: true });

      const policy = await quotes.getActionPolicy({ userId: trial.userId, subscriptionId: trial.subscriptionId });
      assert.equal(policy.actions.UPGRADE, true);
      const quote = await quotes.getQuote({
        userId: trial.userId,
        purchaseType: PurchaseType.UPGRADE,
        subscriptionId: trial.subscriptionId,
        planId: target,
        durationDays: 30,
        channel: PurchaseChannel.WEB,
      });
      assert.equal(quote.isEligible, true);
    });

    it('the renewal list shows it not renewable, and why; the combined pricing and its keyed replay refuse it', async () => {
      const plan = await createPlan();
      const lifetime = await subscriptionOn(plan);
      const dated = await subscriptionOn(plan, { userId: lifetime.userId, expiresAt: inDays(20) });

      const options = await renewals.getRenewalOptions({ identity: { userId: lifetime.userId } });
      const byId = new Map(options.items.map((item) => [item.subscriptionId, item]));
      assert.equal(byId.get(lifetime.subscriptionId)?.renewable, false);
      assert.equal(byId.get(lifetime.subscriptionId)?.amount, null);
      assert.ok(byId.get(lifetime.subscriptionId)?.warnings.some((warning) => warning.code === SUBSCRIPTION_IS_LIFETIME_CODE));
      assert.equal(byId.get(dated.subscriptionId)?.renewable, true, 'control');
      assert.equal(options.total, '299', 'only the dated subscription counts towards the total');

      const price = (subscriptionIds: string[]) =>
        renewals.priceRenewalItems({
          identity: { userId: lifetime.userId },
          subscriptionIds,
          gatewayType: PaymentGatewayType.YOOKASSA,
        });
      assert.equal(await refusalOf(() => price([lifetime.subscriptionId])), SUBSCRIPTION_IS_LIFETIME_CODE);
      assert.equal(
        await refusalOf(() => price([dated.subscriptionId, lifetime.subscriptionId])),
        SUBSCRIPTION_IS_LIFETIME_CODE,
        'one lifetime line refuses the whole combined renewal',
      );
      assert.equal((await price([dated.subscriptionId])).total, '299', 'control');

      const replay = (subscriptionIds: string[]) =>
        renewals.assertRenewalPolicy({ identity: { userId: lifetime.userId }, subscriptionIds });
      assert.equal(await refusalOf(() => replay([dated.subscriptionId, lifetime.subscriptionId])), SUBSCRIPTION_IS_LIFETIME_CODE);
      assert.equal(await refusalOf(() => replay([dated.subscriptionId])), 'NOT_REFUSED', 'control');
    });

    it('the single draft of a renewal or an upgrade — a gateway or the partner balance — refuses it and writes no payment', async () => {
      const target = await createPlan();
      const plan = await createPlan({ upgradeTo: [target] });
      const lifetime = await subscriptionOn(plan);
      const dated = await subscriptionOn(plan, { userId: lifetime.userId, expiresAt: inDays(20) });
      const draft = (subscriptionId: string, purchaseType: PurchaseType, balance: boolean) =>
        drafts.createCheckoutDraft({
          userId: lifetime.userId,
          purchaseType,
          planId: purchaseType === PurchaseType.UPGRADE ? target : plan,
          durationDays: 30,
          gatewayType: balance ? PaymentGatewayType.PARTNER_BALANCE : PaymentGatewayType.YOOKASSA,
          sourceSubscriptionId: subscriptionId,
          channel: PurchaseChannel.WEB,
          ...(balance ? { currencyOverride: Currency.RUB } : {}),
        });

      for (const purchaseType of [PurchaseType.RENEW, PurchaseType.UPGRADE]) {
        for (const balance of [false, true]) {
          assert.equal(
            await refusalOf(() => draft(lifetime.subscriptionId, purchaseType, balance)),
            SUBSCRIPTION_IS_LIFETIME_CODE,
            `${purchaseType}${balance ? ' from the partner balance' : ''}`,
          );
        }
      }
      assert.equal(
        await prisma.transaction.count({ where: { userId: lifetime.userId } }),
        0,
        'a refused checkout wrote a payment',
      );
      for (const purchaseType of [PurchaseType.RENEW, PurchaseType.UPGRADE]) {
        const control = await draft(dated.subscriptionId, purchaseType, false);
        assert.equal(control.amount, '299', `control: the dated subscription gets its ${purchaseType} draft`);
      }
    });

    it('a date before a queued period without an end: every door refuses a renewal or an upgrade, by the lifetime name', async () => {
      const target = await createPlan();
      const plan = await createPlan({ upgradeTo: [target] });
      const owner = await subscriptionOn(plan, { expiresAt: inDays(20) });
      const dated = await subscriptionOn(plan, { userId: owner.userId, expiresAt: inDays(20) });
      await queueOpenEndedPeriod(owner, { startsAt: inDays(20), dated: inDays(5) });

      const policy = await quotes.getActionPolicy({ userId: owner.userId, subscriptionId: owner.subscriptionId });
      assert.equal(policy.actions.RENEW, false);
      assert.equal(policy.actions.UPGRADE, false, 'an upgrade would cancel the queued period');
      assert.ok(policy.warnings.some((warning) => warning.code === SUBSCRIPTION_IS_LIFETIME_CODE));

      const options = await renewals.getRenewalOptions({ identity: { userId: owner.userId } });
      const item = options.items.find((entry) => entry.subscriptionId === owner.subscriptionId);
      assert.equal(item?.renewable, false);
      assert.ok(item?.warnings.some((warning) => warning.code === SUBSCRIPTION_IS_LIFETIME_CODE));

      assert.equal(
        await refusalOf(() =>
          renewals.priceRenewalItems({
            identity: { userId: owner.userId },
            subscriptionIds: [dated.subscriptionId, owner.subscriptionId],
            gatewayType: PaymentGatewayType.YOOKASSA,
          }),
        ),
        SUBSCRIPTION_IS_LIFETIME_CODE,
        'not RENEWAL_ITEM_NOT_PRICEABLE, which the cabinet re-prices',
      );
      assert.equal(
        await refusalOf(() => renewals.assertRenewalPolicy({ identity: { userId: owner.userId }, subscriptionIds: [owner.subscriptionId] })),
        SUBSCRIPTION_IS_LIFETIME_CODE,
      );
      for (const [purchaseType, planId] of [
        [PurchaseType.RENEW, plan],
        [PurchaseType.UPGRADE, target],
      ] as const) {
        assert.equal(
          await refusalOf(() =>
            drafts.createCheckoutDraft({
              userId: owner.userId,
              purchaseType,
              planId,
              durationDays: 30,
              gatewayType: PaymentGatewayType.YOOKASSA,
              sourceSubscriptionId: owner.subscriptionId,
              channel: PurchaseChannel.WEB,
            }),
          ),
          SUBSCRIPTION_IS_LIFETIME_CODE,
          purchaseType,
        );
      }
      assert.equal(await prisma.transaction.count({ where: { userId: owner.userId } }), 0);

      // Control: a date after the queued start is renewed — the renewal's own
      // alignment ends the queued period at the date and follows it.
      await prisma.subscription.update({ where: { id: owner.subscriptionId }, data: { expiresAt: inDays(25) } });
      const renewable = await quotes.getActionPolicy({ userId: owner.userId, subscriptionId: owner.subscriptionId });
      assert.equal(renewable.actions.RENEW, true);
    });
  });

  // ── 2 ─────────────────────────────────────────────────────────────────────

  describe('a renewal or an upgrade paid anyway changes nothing and is withheld for refund', () => {
    it('single, outside the term model: the row stays as it was, and the operator is asked to refund it', async () => {
      const plan = await createPlan();
      const owner = await subscriptionOn(plan, { status: SubscriptionStatus.LIMITED });
      // A one-time discount the renewal would have spent: it stays unspent.
      const grant = await prisma.userPendingDiscount.create({ data: { userId: owner.userId, percent: 10 } });
      const before = await rowState(owner.subscriptionId);

      const row = await paidRow(owner, plan);
      const paid = await fulfil(row);

      assert.deepEqual(await rowState(owner.subscriptionId), before, 'the renewal wrote to a lifetime subscription');
      assert.equal((await rowState(owner.subscriptionId))['expiresAt'], null);
      assert.equal(await syncJobsOf(owner.subscriptionId), 0, 'a sync job for nothing that changed');
      assert.equal((await prisma.userPendingDiscount.findUniqueOrThrow({ where: { id: grant.id } })).consumedAt, null);
      const provenance = gatewayDataOf(paid)[LIFETIME_RENEWAL_NOT_APPLIED_KEY] as Record<string, unknown> | undefined;
      assert.deepEqual(provenance?.['subscriptionIds'], [owner.subscriptionId]);
      const notice = assertWithheld(paid, [owner.subscriptionId]);
      assert.match(String(notice.metadata['note']), /бессрочная: продление не применено/);

      const text = await card(notice.type, notice.message, notice.metadata);
      assert.match(text, /Платёж получен, но не применён/);
      assert.match(text, /♾ Продление бессрочной подписки не применено: деньги за него нужно вернуть\./);
      assert.match(text, /«Платежи» → «Транзакции» → этот платёж → «Отметить возврат»/);

      // Fulfilled again — a retry, a replay that got past the claim: nothing
      // changes, and the operator is not told twice.
      await fulfilment.applyCompletedTransaction(row);
      assert.equal(eventsOf('payment.withheld', (metadata) => metadata['paymentId'] === paid.paymentId).length, 1);
      assert.deepEqual(await rowState(owner.subscriptionId), before);
    });

    it('runs no post-payment hook: no commission, referral reward, cashback, «Мой налог» or ad conversion', async () => {
      const plan = await createPlan();
      const lifetime = await subscriptionOn(plan);
      const dated = await subscriptionOn(plan, { expiresAt: inDays(20) });
      const withheldRow = await paidRow(lifetime, plan);
      const soldRow = await paidRow(dated, plan);
      await fulfil(withheldRow);
      await fulfil(soldRow);

      // With the copy every caller holds: the row as it was before fulfilment.
      await reconciliation.runPostFulfillmentHooks(withheldRow);
      await reconciliation.runPostFulfillmentHooks(soldRow);

      for (const [name, list] of Object.entries(hooks)) {
        assert.equal(list.includes(withheldRow.id), false, `${name} ran for a payment withheld for refund`);
      }
      assert.ok(hooks.referral.includes(soldRow.id), 'control: the referral hook runs for a renewal that renewed');
      assert.ok(hooks.partner.includes(soldRow.id), 'control: the partner hook runs for a renewal that renewed');
    });

    it('«Отметить возврат» records its refund: reversed, told to the operator alone, the subscription left as it is', async () => {
      const plan = await createPlan();
      const owner = await subscriptionOn(plan);
      const paid = await payRenewal(owner, plan);
      const before = await rowState(owner.subscriptionId);
      const admin = await prisma.adminUser.create({
        data: { login: `${prefix}-admin-${next()}`, loginNormalized: `${prefix}-admin-${counter}`, passwordHash: 'not-a-hash' },
      });
      created.admins.push(admin.id);

      const recorded = await refunds.recordWithheldRefund({
        transactionId: paid.id,
        currentAdmin: { ...OPERATOR, id: admin.id },
        requestMetadata: { requestId: 'request-1', remoteAddress: '203.0.113.5', userAgent: 'spec' },
      });

      assert.equal(recorded.recorded, true, 'refused as PAYMENT_NOT_WITHHELD');
      const reversed = await prisma.transaction.findUniqueOrThrow({ where: { id: paid.id } });
      assert.equal(reversed.status, TransactionStatus.CANCELED);
      assert.equal(gatewayDataOf(reversed)['refundRevocationSkippedReason'], 'CONVERSION_NOT_APPLIED');
      assert.equal(readWithheldConversion(reversed.gatewayData)?.refundedAt, gatewayDataOf(reversed)['refundReversedAt']);
      assert.equal(eventsOf('payment.withheld_refunded', (metadata) => metadata['paymentId'] === paid.paymentId).length, 1);
      assert.deepEqual(eventsOf('payment.refunded', (metadata) => metadata['paymentId'] === paid.paymentId), []);
      assert.deepEqual(await rowState(owner.subscriptionId), before);
    });

    it('combined, every line lifetime: withheld, one card naming each subscription', async () => {
      const plan = await createPlan();
      const first = await subscriptionOn(plan);
      const second = await subscriptionOn(plan, { userId: first.userId });
      const before = [await rowState(first.subscriptionId), await rowState(second.subscriptionId)];

      const paid = await payCombined(first.userId, [
        { owner: first, planId: plan },
        { owner: second, planId: plan },
      ]);

      assert.deepEqual([await rowState(first.subscriptionId), await rowState(second.subscriptionId)], before);
      const items = await prisma.transactionItem.findMany({ where: { transactionId: paid.id } });
      assert.ok(items.every((item) => item.appliedAt !== null), 'every line is settled, so no later run applies one');
      assertWithheld(paid, [first.subscriptionId, second.subscriptionId]);
    });

    it('combined, a dated line beside: the payment stands, the dated line renews, and the card names the lifetime part to return', async () => {
      const plan = await createPlan();
      const lifetime = await subscriptionOn(plan);
      const datedUntil = inDays(20);
      const dated = await subscriptionOn(plan, { userId: lifetime.userId, expiresAt: datedUntil });
      const before = await rowState(lifetime.subscriptionId);

      const paid = await payCombined(lifetime.userId, [
        { owner: dated, planId: plan },
        { owner: lifetime, planId: plan },
      ]);

      assert.deepEqual(await rowState(lifetime.subscriptionId), before);
      assert.equal(await syncJobsOf(lifetime.subscriptionId), 0);
      const renewed = await rowState(dated.subscriptionId);
      assert.equal((renewed['expiresAt'] as Date).getTime(), datedUntil.getTime() + 30 * DAY_MS, 'control: the dated line renewed');
      assert.equal(await syncJobsOf(dated.subscriptionId), 1);
      assert.equal('conversionWithheldAt' in gatewayDataOf(paid), false, 'a payment that renewed a line is a sale');
      const provenance = gatewayDataOf(paid)[LIFETIME_RENEWAL_NOT_APPLIED_KEY] as Record<string, unknown> | undefined;
      assert.deepEqual(provenance?.['subscriptionIds'], [lifetime.subscriptionId]);

      const completion = eventsOf('payment.completed', (metadata) => metadata['paymentId'] === paid.paymentId);
      assert.equal(completion.length, 1);
      assert.equal(completion[0]!.severity, 'WARNING');
      assert.equal(completion[0]!.metadata['code'], LIFETIME_RENEWAL_NOT_APPLIED_CODE);
      const note = String(completion[0]!.metadata['note']);
      assert.match(note, new RegExp(`подписки ${lifetime.subscriptionId}, а она бессрочная`));
      assert.match(note, /Верните за эту позицию 299 RUB/);
      assert.match(note, /«Отметить возврат» здесь не нужен/);
      assert.doesNotMatch(note, new RegExp(dated.subscriptionId));
      assert.deepEqual(eventsOf('payment.withheld', (metadata) => metadata['paymentId'] === paid.paymentId), []);
      assert.deepEqual(
        eventsOf('subscription.renewed', (metadata) => metadata['paymentId'] === paid.paymentId).map(
          (event) => event.metadata['subscriptionId'],
        ),
        [dated.subscriptionId],
      );
    });

    it('in the term model: no term appended or closed, the add-on stays without an end, single and combined', async () => {
      const plan = await createPlan();
      const owner = await subscriptionOn(plan);
      await enter(owner.subscriptionId);
      const [open] = await termsOf(owner.subscriptionId);
      assert.equal(open!.endsAt, null, 'fixture: a lifetime term');
      const addOnId = await addOnRow(owner, open!.id);
      const termsBefore = await termsOf(owner.subscriptionId);
      const addOnBefore = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: addOnId } });
      const rowBefore = await rowState(owner.subscriptionId);
      // Neither payment bought anything, so neither spends the one-time discount.
      const grant = await prisma.userPendingDiscount.create({ data: { userId: owner.userId, percent: 10 } });

      const single = await withFlagsOn(() => payRenewal(owner, plan));
      const combined = await withFlagsOn(() => payCombined(owner.userId, [{ owner, planId: plan }]));
      assert.equal((await prisma.userPendingDiscount.findUniqueOrThrow({ where: { id: grant.id } })).consumedAt, null);
      assertWithheld(single, [owner.subscriptionId]);
      assertWithheld(combined, [owner.subscriptionId]);

      assert.deepEqual(
        (await termsOf(owner.subscriptionId)).map(({ updatedAt: _updatedAt, ...term }) => term),
        termsBefore.map(({ updatedAt: _updatedAt, ...term }) => term),
        'the term chain moved',
      );
      assert.equal((await termsOf(owner.subscriptionId))[0]!.status, SubscriptionTermStatus.ACTIVE);
      const addOn = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: addOnId } });
      assert.equal(addOn.expiresAt, null, 'the add-on was given an end');
      assert.equal(addOn.version, addOnBefore.version);
      assert.equal(await prisma.addOnEntitlementEvent.count({ where: { entitlementId: addOnId } }), 0);
      assert.deepEqual(await rowState(owner.subscriptionId), rowBefore);
      assert.equal(await syncJobsOf(owner.subscriptionId), 0);
      assert.equal(
        await prisma.subscriptionEffectiveProjection.count({ where: { subscriptionId: owner.subscriptionId } }),
        1,
      );
    });

    it('a renewal that meets a queued period without an end is withheld the same way, and closes nothing (R1-08)', async () => {
      // It used to fail closed: the webhook FAILED and retried, the money stayed
      // captured, and no card asked for the refund.
      const plan = await createPlan();
      const owner = await subscriptionOn(plan, { expiresAt: inDays(20) });
      const queuedStart = inDays(20);
      const queuedId = await queueOpenEndedPeriod(owner, { startsAt: queuedStart, dated: inDays(5) });
      const termsBefore = await termsOf(owner.subscriptionId);
      const rowBefore = await rowState(owner.subscriptionId);

      const paid = await withFlagsOn(() => payRenewal(owner, plan));

      assert.deepEqual(
        (await termsOf(owner.subscriptionId)).map(({ updatedAt: _updatedAt, ...term }) => term),
        termsBefore.map(({ updatedAt: _updatedAt, ...term }) => term),
      );
      assert.equal((await termsOf(owner.subscriptionId)).find((term) => term.id === queuedId)?.endsAt, null);
      assert.deepEqual(await rowState(owner.subscriptionId), rowBefore);
      const notice = assertWithheld(paid, [owner.subscriptionId]);
      assert.match(
        String(notice.metadata['note']),
        new RegExp(`уже запланирован бессрочный период \\(с ${queuedStart.toISOString().slice(0, 10)}\\)`),
      );
    });

    it('an upgrade: the plan, the date and the limits stay; withheld, and the card names the operator’s own way to another plan', async () => {
      const target = await createPlan();
      const plan = await createPlan({ upgradeTo: [target] });
      const owner = await subscriptionOn(plan);
      const before = await rowState(owner.subscriptionId);

      const paid = await fulfil(await paidRow(owner, target, { purchaseType: PurchaseType.UPGRADE }));

      assert.deepEqual(await rowState(owner.subscriptionId), before, 'the upgrade gave a lifetime subscription an end date');
      assert.equal(await syncJobsOf(owner.subscriptionId), 0);
      const notice = assertWithheld(paid, [owner.subscriptionId]);
      assert.equal(notice.metadata['purchaseType'], PurchaseType.UPGRADE);
      assert.deepEqual(eventsOf('subscription.upgraded', (metadata) => metadata['subscriptionId'] === owner.subscriptionId), []);
      const text = await card(notice.type, notice.message, notice.metadata);
      assert.match(text, /♾ Смена тарифа бессрочной подписки не применена: деньги за неё нужно вернуть\./);
      assert.match(text, /«Пользователи» → пользователь → «Быстрые действия» → «Назначить план»/);
    });

    it('from the partner balance, fulfilment refuses instead — its path puts the balance back — and writes nothing', async () => {
      const target = await createPlan();
      const plan = await createPlan({ upgradeTo: [target] });
      const owner = await subscriptionOn(plan);
      const before = await rowState(owner.subscriptionId);

      for (const [purchaseType, planId] of [
        [PurchaseType.RENEW, plan],
        [PurchaseType.UPGRADE, target],
      ] as const) {
        const row = await paidRow(owner, planId, { purchaseType, gatewayType: PaymentGatewayType.PARTNER_BALANCE });
        assert.equal(await refusalOf(() => fulfilment.applyCompletedTransaction(row)), SUBSCRIPTION_IS_LIFETIME_CODE, purchaseType);
        const after = await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } });
        assert.equal(after.fulfilledAt, null, `${purchaseType}: settled although refused`);
        assert.equal('conversionWithheldAt' in gatewayDataOf(after), false);
      }
      assert.deepEqual(await rowState(owner.subscriptionId), before);
      assert.deepEqual(eventsOf('payment.withheld', (metadata) => metadata['subscriptionId'] === owner.subscriptionId), []);
    });

    it('control: a trial with no end date is converted by its upgrade', async () => {
      const target = await createPlan();
      const trialPlan = await createPlan({ upgradeTo: [target], trial: true });
      const trial = await subscriptionOn(trialPlan, { isTrial: true });

      const paid = await fulfil(await paidRow(trial, target, { purchaseType: PurchaseType.UPGRADE, convertsTrial: true }));

      const row = await rowState(trial.subscriptionId);
      assert.equal(row['isTrial'], false);
      assert.equal(Math.round(((row['expiresAt'] as Date).getTime() - Date.now()) / DAY_MS), 30);
      assert.equal('conversionWithheldAt' in gatewayDataOf(paid), false);
    });

    it('control: a subscription with a date still renews in the model — the renewal appends its term', async () => {
      const plan = await createPlan();
      const until = inDays(20);
      const owner = await subscriptionOn(plan, { expiresAt: until });
      await enter(owner.subscriptionId);

      await withFlagsOn(() => payRenewal(owner, plan));

      const chain = await termsOf(owner.subscriptionId);
      assert.deepEqual(
        chain.map((term) => [term.generation, term.status]),
        [
          [1, SubscriptionTermStatus.ACTIVE],
          [2, SubscriptionTermStatus.SCHEDULED],
        ],
      );
      assert.equal(chain[1]!.startsAt.getTime(), until.getTime());
      assert.equal(chain[1]!.baseTrafficLimitBytes, 100n * GIB);
    });
  });

  // ── 3 ─────────────────────────────────────────────────────────────────────

  describe('ЮKassa autopay', () => {
    /** Autopay over PostgreSQL, narrowed to this spec's users so another spec's rows never enter a batch. */
    function autopay(onCharge: (subscriptionId: string) => Promise<unknown>) {
      const charged: string[] = [];
      const client = new Proxy(prisma, {
        get: (target, property) =>
          property === 'subscription'
            ? new Proxy(target.subscription, {
                get: (delegate, method) =>
                  method === 'findMany'
                    ? (args: { where: Prisma.SubscriptionWhereInput }) =>
                        delegate.findMany({ ...args, where: { AND: [args.where, { userId: { in: created.users } }] } } as never)
                    : Reflect.get(delegate, method, delegate),
              })
            : Reflect.get(target, property, target),
      });
      const service = new AutoRenewService(
        client as never,
        { create: async () => undefined } as never,
        {
          renewalCheckout: async (input: { readonly subscriptionIds: readonly string[] }) => {
            charged.push(...input.subscriptionIds);
            return onCharge(input.subscriptionIds[0]!);
          },
        } as never,
        {
          findPreferredForCharge: async (userId: string) =>
            created.users.includes(userId) ? { id: `${prefix}-method`, gatewayType: PaymentGatewayType.YOOKASSA } : null,
        } as never,
        { build: async () => ({}) } as never,
        { requiresPlanSelection: async () => false } as never,
        { info: () => undefined, warn: () => undefined } as never,
      );
      return { service, charged };
    }

    it('never charges a lifetime subscription, nor expires it; a dated one in the window is charged', async () => {
      const plan = await createPlan();
      const lifetime = await subscriptionOn(plan);
      const due = await subscriptionOn(plan, { userId: lifetime.userId, expiresAt: new Date(Date.now() + 60_000) });
      const { service, charged } = autopay(async () => ({ transactionStatus: 'PENDING', checkoutUrl: null, paymentId: 'p' }));

      await service.processAutopayCharges();
      await service.markExpiredSubscriptions();

      assert.ok(charged.includes(due.subscriptionId), 'control: the harness charges what is due');
      assert.ok(!charged.includes(lifetime.subscriptionId), 'autopay charged a lifetime subscription');
      assert.equal((await rowState(lifetime.subscriptionId))['status'], SubscriptionStatus.ACTIVE);
    });

    it('a past-due charge refused because the subscription became lifetime meanwhile does not expire it', async () => {
      const plan = await createPlan();
      const owner = await subscriptionOn(plan, { expiresAt: new Date(Date.now() - 60_000) });
      // An UPGRADE to a plan without an end lands between autopay's read and
      // its charge; the checkout then refuses, as it does for every lifetime
      // subscription.
      const { service, charged } = autopay(async (subscriptionId) => {
        await prisma.subscription.update({ where: { id: subscriptionId }, data: { expiresAt: null } });
        throw subscriptionIsLifetime();
      });

      await service.markExpiredSubscriptions();

      assert.deepEqual(charged, [owner.subscriptionId], 'fixture: the past-due pass asked for the charge');
      const row = await rowState(owner.subscriptionId);
      assert.equal(row['expiresAt'], null);
      assert.equal(row['status'], SubscriptionStatus.ACTIVE, 'a lifetime subscription was expired');
    });

    it('control: a past-due charge refused while the date stands still expires the subscription on schedule', async () => {
      const plan = await createPlan();
      const owner = await subscriptionOn(plan, { expiresAt: new Date(Date.now() - 60_000) });
      const { service } = autopay(async () => {
        throw subscriptionIsLifetime();
      });

      await service.markExpiredSubscriptions();

      assert.equal((await rowState(owner.subscriptionId))['status'], SubscriptionStatus.EXPIRED);
    });
  });

  // ── 4 ─────────────────────────────────────────────────────────────────────

  describe('Platega and RollyPay', () => {
    it('the sweep cancels a live provider subscription left on a lifetime subscription, and keeps the dated one', async () => {
      const plan = await createPlan();
      const lifetime = await subscriptionOn(plan);
      const dated = await subscriptionOn(plan, { userId: lifetime.userId, expiresAt: inDays(20) });
      const providerRow = (owner: Owner, gatewayType: PaymentGatewayType) =>
        prisma.providerSubscription.create({
          data: {
            userId: owner.userId,
            gatewayType,
            providerSubscriptionId: `${prefix}-psub-${next()}`,
            status: ProviderSubscriptionStatus.ACTIVE,
            subscriptionId: owner.subscriptionId,
            planId: plan,
            durationDays: 30,
            amount: new Prisma.Decimal('299'),
            currency: Currency.RUB,
            intervalUnit: 'month',
            intervalCount: 1,
            firstTransactionId: `${prefix}-first-${next()}`,
            consentVersion: 'provider-subscription-v1',
          },
        });
      const onLifetime = await providerRow(lifetime, PaymentGatewayType.PLATEGA);
      const onDated = await providerRow(dated, PaymentGatewayType.PLATEGA);

      mock.method(Logger.prototype, 'error', () => undefined);
      mock.method(Logger.prototype, 'log', () => undefined);
      const cancelled: string[] = [];
      const client = new Proxy(prisma, {
        get: (target, property) =>
          property === 'paymentGateway'
            ? { findUnique: async () => ({ type: PaymentGatewayType.PLATEGA, settings: { merchantId: 'm-1', secret: 's-1' } }) }
            : Reflect.get(target, property, target),
      });
      // Only this spec's rows are ever cancelled: another spec's live rows in the
      // same database are refused, and stay as they are.
      const http = {
        post: (url: string) => {
          if (!url.includes(prefix)) return throwError(() => new Error('not this spec’s row'));
          cancelled.push(url);
          return of({ data: { status: 'cancelled' } });
        },
      };
      try {
        await new ProviderSubscriptionService(client as never, http as never, {} as never, {} as never).cancelStranded();
      } finally {
        mock.restoreAll();
      }

      const ended = await prisma.providerSubscription.findUniqueOrThrow({ where: { id: onLifetime.id } });
      assert.equal(ended.status, ProviderSubscriptionStatus.CANCELLED);
      assert.equal(ended.cancelledBy, 'SYSTEM');
      assert.ok(cancelled.some((url) => url.includes(onLifetime.providerSubscriptionId)));
      const kept = await prisma.providerSubscription.findUniqueOrThrow({ where: { id: onDated.id } });
      assert.equal(kept.status, ProviderSubscriptionStatus.ACTIVE, 'control: the dated subscription keeps its autopay');
    });
  });
});
