import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import {
  Currency,
  PaymentGatewayType,
  PlanAvailability,
  PurchaseChannel,
  PurchaseType,
  SubscriptionStatus,
  TransactionStatus,
} from '@prisma/client';

import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import { CreateTransactionDraftDto } from '../src/modules/payments/dto/create-transaction-draft.dto';
import { PaymentsTransactionsService } from '../src/modules/payments/services/payments-transactions.service';

describe('PaymentsTransactionsService', () => {
  it('lists transactions with user search, filters, and mapped user fields', async () => {
    const { service, state } = createService({
      matchingUsers: [{ id: 'user-1' }, { id: 'user-2' }],
      listTransactions: [
        createStoredTransaction({
          id: 'transaction-1',
          paymentId: 'payment-1',
          userId: 'user-1',
          amount: '12.50',
          user: {
            id: 'user-1',
            telegramId: 12345n,
            username: 'alice',
            name: 'Alice',
            email: 'alice@example.test',
          },
        }),
      ],
      listTotal: 1,
    });

    const result = await service.listTransactions({
      userSearch: 'alice',
      status: TransactionStatus.PENDING,
      gatewayType: PaymentGatewayType.YOOKASSA,
      purchaseType: PurchaseType.NEW,
      dateFrom: '2026-04-01T00:00:00.000Z',
      dateTo: '2026-04-30T23:59:59.999Z',
      limit: 25,
      offset: 5,
    });

    assert.equal(result.total, 1);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.id, 'transaction-1');
    assert.equal(result.items[0]?.userTelegramId, '12345');
    assert.equal(result.items[0]?.userUsername, 'alice');
    assert.equal(result.items[0]?.amount, '12.50');
    assert.deepStrictEqual(state.userFindManyCalls[0], {
      where: {
        OR: [
          { id: 'alice' },
          { email: { equals: 'alice', mode: 'insensitive' } },
          { username: { equals: 'alice', mode: 'insensitive' } },
        ],
      },
      select: { id: true },
      take: 50,
    });
    assert.deepStrictEqual(state.transactionCountCalls[0], {
      where: {
        userId: { in: ['user-1', 'user-2'] },
        status: TransactionStatus.PENDING,
        gatewayType: PaymentGatewayType.YOOKASSA,
        purchaseType: PurchaseType.NEW,
        createdAt: {
          gte: new Date('2026-04-01T00:00:00.000Z'),
          lte: new Date('2026-04-30T23:59:59.999Z'),
        },
      },
    });
    assert.equal(state.transactionListCalls[0]?.take, 25);
    assert.equal(state.transactionListCalls[0]?.skip, 5);
  });

  it('returns an empty list without querying transactions when user search has no match', async () => {
    const { service, state } = createService({ matchingUsers: [] });

    const result = await service.listTransactions({ userSearch: 'missing-user' });

    assert.deepStrictEqual(result, { items: [], total: 0 });
    assert.equal(state.transactionListCalls.length, 0);
    assert.equal(state.transactionCountCalls.length, 0);
  });

  it('creates pending transaction draft from eligible quote', async () => {
    const { service, state } = createService({
      quoteResult: createEligibleQuote(),
    });

    const transaction = await service.createDraft({
      userId: 'user-1',
      purchaseType: PurchaseType.NEW,
      planId: 'plan-1',
      durationDays: 30,
      gatewayType: PaymentGatewayType.YOOKASSA,
      channel: PurchaseChannel.WEB,
      deviceType: 'ANDROID',
    });

    assert.equal(transaction.status, TransactionStatus.PENDING);
    assert.equal(transaction.purchaseType, PurchaseType.NEW);
    assert.equal(transaction.gatewayType, PaymentGatewayType.YOOKASSA);
    assert.equal(transaction.currency, Currency.USD);
    assert.equal(transaction.amount, '8');
    assert.equal(state.transactionCreateCalls.length, 1);
    assert.deepStrictEqual(state.transactionCreateCalls[0], {
      userId: 'user-1',
      subscriptionId: null,
      status: TransactionStatus.PENDING,
      purchaseType: PurchaseType.NEW,
      channel: PurchaseChannel.WEB,
      gatewayType: PaymentGatewayType.YOOKASSA,
      currency: Currency.USD,
      amount: '8',
      planSnapshot: createDraftSnapshot(PurchaseType.NEW),
      deviceTypes: ['ANDROID'],
    });
  });

  it('rejects ineligible quotes and does not create transaction', async () => {
    const { service, state } = createService({
      quoteResult: {
        ...createEligibleQuote(),
        isEligible: false,
        warnings: [{ code: 'GATEWAY_NOT_AVAILABLE', message: 'Gateway not available' }],
      },
    });

    await assert.rejects(async () => {
      await service.createDraft({
        userId: 'user-1',
        purchaseType: PurchaseType.NEW,
        planId: 'plan-1',
        durationDays: 30,
        gatewayType: PaymentGatewayType.YOOKASSA,
        channel: PurchaseChannel.WEB,
      });
    }, (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.deepStrictEqual(error.getResponse(), {
        code: 'PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE',
        message: 'Quote is not eligible for transaction draft creation.',
        warnings: [{ code: 'GATEWAY_NOT_AVAILABLE', message: 'Gateway not available' }],
      });
      return true;
    });

    assert.equal(state.transactionCreateCalls.length, 0);
  });

  // ── A plan that is no longer offered is named apart from other refusals ────
  //
  // Every ineligible quote used to leave as PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE,
  // and the safe filter strips the `warnings` that told the cases apart. The
  // cabinet answers a withdrawn plan by dropping its catalogue and sending the
  // subscriber back to it: right when the plan is gone, a loop when it is not —
  // a paid trial the buyer cannot claim is still listed, so "no longer
  // available" sent them back to the same trial. Checked through the real filter,
  // because a code the filter strips is no code at all.
  for (const scenario of [
    {
      name: 'the plan is no longer offered',
      quote: { selectedPlan: null, selectedDuration: null },
      warnings: [{ code: 'PLAN_NOT_AVAILABLE', message: 'The selected plan is not available for this action.' }],
    },
    {
      name: 'the term is no longer offered',
      quote: { selectedDuration: null },
      warnings: [{ code: 'DURATION_NOT_AVAILABLE', message: 'The selected duration is not available for this plan.' }],
    },
    {
      name: 'an upgrade target is no longer offered',
      quote: { purchaseType: PurchaseType.UPGRADE, selectedPlan: null, selectedDuration: null },
      warnings: [
        { code: 'UPGRADE_RESETS_EXPIRY', message: 'Upgrade starts immediately and resets the expiration date.' },
        { code: 'PLAN_NOT_AVAILABLE', message: 'The selected plan is not available for this action.' },
      ],
    },
  ]) {
    it(`answers PAYMENT_DRAFT_PLAN_NOT_AVAILABLE when ${scenario.name}, through the safe filter`, async () => {
      const { service, state } = createService({
        quoteResult: {
          ...createEligibleQuote(),
          ...scenario.quote,
          isEligible: false,
          price: null,
          warnings: scenario.warnings,
        },
      });

      const error = await captureRejection(() =>
        service.createDraft({
          userId: 'user-1',
          purchaseType: scenario.quote.purchaseType ?? PurchaseType.NEW,
          planId: 'plan-1',
          durationDays: 30,
          gatewayType: PaymentGatewayType.YOOKASSA,
          channel: PurchaseChannel.WEB,
        }),
      );

      assert.ok(error instanceof BadRequestException);
      assert.equal((error.getResponse() as { code?: unknown }).code, 'PAYMENT_DRAFT_PLAN_NOT_AVAILABLE');
      const wire = runSafeFilter(error);
      assert.equal(wire.statusCode, 400);
      assert.equal(wire.body['code'], 'PAYMENT_DRAFT_PLAN_NOT_AVAILABLE', 'the safe filter stripped the code');
      assert.equal(state.transactionCreateCalls.length, 0);
    });
  }

  // The owner, 24.09.2026: a subscription with no end date is never renewed.
  // The quote closes it (`SUBSCRIPTION_IS_LIFETIME`, with the PLAN_NOT_AVAILABLE
  // an empty plan list adds), and the draft names it — for a gateway and the
  // partner balance alike — so the cabinet can say why instead of "could not pay".
  it('answers SUBSCRIPTION_IS_LIFETIME for the renewal of a subscription with no end date, through the safe filter', async () => {
    const { service, state } = createService({
      quoteResult: {
        ...createEligibleQuote(),
        isEligible: false,
        selectedPlan: null,
        selectedDuration: null,
        price: null,
        warnings: [
          { code: 'SUBSCRIPTION_IS_LIFETIME', message: 'The subscription has no end date: there is nothing to renew.' },
          { code: 'PLAN_NOT_AVAILABLE', message: 'The selected plan is not available for this action.' },
        ],
      },
    });

    const error = await captureRejection(() =>
      service.createDraft({
        userId: 'user-1',
        purchaseType: PurchaseType.RENEW,
        planId: 'plan-1',
        durationDays: 30,
        gatewayType: PaymentGatewayType.YOOKASSA,
        channel: PurchaseChannel.WEB,
      }),
    );

    assert.ok(error instanceof BadRequestException);
    assert.equal((error.getResponse() as { code?: unknown }).code, 'SUBSCRIPTION_IS_LIFETIME');
    const wire = runSafeFilter(error);
    assert.equal(wire.statusCode, 400, 'a 409 would read as QUOTE_CHANGED to a cabinet that does not know the code');
    assert.equal(wire.body['code'], 'SUBSCRIPTION_IS_LIFETIME', 'the safe filter stripped the code');
    assert.equal(state.transactionCreateCalls.length, 0);
  });

  for (const scenario of [
    {
      name: 'a paid trial the buyer cannot claim, which is still on sale',
      warnings: [
        {
          code: 'TRIAL_REQUIRES_TELEGRAM',
          message: 'This trial requires a linked Telegram account. Link Telegram in the cabinet first.',
        },
        { code: 'PLAN_NOT_AVAILABLE', message: 'The selected plan is not available for this action.' },
      ],
    },
    {
      name: 'a source subscription with no plan to act on',
      warnings: [
        { code: 'SOURCE_PLAN_MISSING', message: 'The source subscription plan is no longer available.' },
        { code: 'PLAN_NOT_AVAILABLE', message: 'The selected plan is not available for this action.' },
      ],
    },
  ]) {
    it(`keeps PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE for ${scenario.name}`, async () => {
      const { service } = createService({
        quoteResult: {
          ...createEligibleQuote(),
          isEligible: false,
          selectedPlan: null,
          selectedDuration: null,
          price: null,
          warnings: scenario.warnings,
        },
      });

      const error = await captureRejection(() =>
        service.createDraft({
          userId: 'user-1',
          purchaseType: PurchaseType.NEW,
          planId: 'plan-1',
          durationDays: 30,
          gatewayType: PaymentGatewayType.YOOKASSA,
          channel: PurchaseChannel.WEB,
        }),
      );

      assert.ok(error instanceof BadRequestException);
      assert.equal((error.getResponse() as { code?: unknown }).code, 'PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE');
    });
  }

  it('rejects TRIAL transaction draft payloads before quoting', async () => {
    const { service, state } = createService({
      quoteResult: createEligibleQuote(),
    });
    const input = new CreateTransactionDraftDto();
    input.userId = 'user-1';
    input.purchaseType = PurchaseType.NEW;
    input.planId = 'plan-1';
    input.durationDays = 30;
    input.gatewayType = PaymentGatewayType.YOOKASSA;
    input.channel = PurchaseChannel.WEB;
    Reflect.set(input, 'purchaseType', 'TRIAL');

    await assert.rejects(async () => {
      await service.createDraft(input);
    }, (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.deepStrictEqual(error.getResponse(), {
        code: 'PAYMENT_DRAFT_TRIAL_UNSUPPORTED',
        message: 'Trial purchases cannot be converted to transaction drafts.',
      });
      return true;
    });
    assert.equal(state.quoteCalls, 0);
  });

  it('rejects a NEW draft when the subscription cap is reached', async () => {
    const { service, state } = createService({
      quoteResult: createEligibleQuote(),
      capacityAvailable: false,
    });

    await assert.rejects(async () => {
      await service.createDraft({
        userId: 'user-1',
        purchaseType: PurchaseType.NEW,
        planId: 'plan-1',
        durationDays: 30,
        gatewayType: PaymentGatewayType.YOOKASSA,
        channel: PurchaseChannel.WEB,
      });
    }, (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.deepStrictEqual(error.getResponse(), {
        code: 'SUBSCRIPTION_LIMIT_REACHED',
        message: 'The user has reached the maximum number of active subscriptions.',
      });
      return true;
    });

    // The cap guard must short-circuit BEFORE quoting or writing anything.
    assert.equal(state.quoteCalls, 0);
    assert.equal(state.transactionCreateCalls.length, 0);
  });

  // A purchase beside a trial converts the trial. Multi-subscription left
  // ADDITIONAL open, so the buyer who pressed «Купить» next to it came away with
  // the trial and a second subscription — a second link — instead.
  for (const purchaseType of [PurchaseType.NEW, PurchaseType.ADDITIONAL]) {
    it(`refuses a ${purchaseType} draft while the buyer holds a trial, before the cap and with a code of its own`, async () => {
      const { service, state } = createService({
        quoteResult: createEligibleQuote(),
        convertibleTrialId: 'trial-sub',
        // Full as well: converting takes no slot, so the trial is the answer.
        capacityAvailable: false,
      });

      const error = await captureRejection(() =>
        service.createDraft({
          userId: 'user-1',
          purchaseType,
          planId: 'plan-1',
          durationDays: 30,
          gatewayType: PaymentGatewayType.YOOKASSA,
          channel: PurchaseChannel.WEB,
        }),
      );

      assert.ok(error instanceof BadRequestException);
      assert.equal((error.getResponse() as { code?: unknown }).code, 'TRIAL_UPGRADE_REQUIRED');
      const wire = runSafeFilter(error);
      assert.equal(wire.statusCode, 400);
      assert.equal(wire.body['code'], 'TRIAL_UPGRADE_REQUIRED', 'the safe filter stripped the code');
      assert.equal(state.quoteCalls, 0);
      assert.equal(state.transactionCreateCalls.length, 0);
    });
  }

  it('lets the UPGRADE of that trial through', async () => {
    const { service, state } = createService({
      quoteResult: { ...createEligibleQuote(), purchaseType: PurchaseType.UPGRADE },
      convertibleTrialId: 'trial-sub',
      capacityAvailable: false,
    });

    const transaction = await service.createDraft({
      userId: 'user-1',
      purchaseType: PurchaseType.UPGRADE,
      sourceSubscriptionId: 'trial-sub',
      planId: 'plan-1',
      durationDays: 30,
      gatewayType: PaymentGatewayType.YOOKASSA,
      channel: PurchaseChannel.WEB,
    });

    assert.equal(transaction.id, 'transaction-1');
    assert.equal(state.transactionCreateCalls.length, 1);
  });

  // «для автоматического списания» on Platega/RollyPay: the provider repeats
  // the first charge's sum every period, and every later charge renews one
  // subscription. A trial's conversion is priced like a new purchase — the
  // plan's full price, the term from payment — so the provider may repeat it,
  // and the later charges renew the converted trial. A change of a paid plan
  // is still refused.
  describe('a provider subscription on an UPGRADE', () => {
    const upgradeToPlanOne = (sourceSubscriptionId: string) =>
      ({
        userId: 'user-1',
        purchaseType: PurchaseType.UPGRADE,
        sourceSubscriptionId,
        planId: 'plan-1',
        durationDays: 30,
        gatewayType: PaymentGatewayType.PLATEGA,
        channel: PurchaseChannel.WEB,
      }) satisfies CreateTransactionDraftDto;

    it("is made on a trial's conversion, for the trial it converts", async () => {
      const { service, state } = createService({
        quoteResult: createProviderSubscriptionQuote('trial-sub'),
        convertibleTrialId: 'trial-sub',
        subscriptions: [{ id: 'trial-sub', userId: 'user-1', isTrial: true, status: SubscriptionStatus.EXPIRED }],
      });

      const draft = await service.createCheckoutDraft(upgradeToPlanOne('trial-sub'), { providerSubscription: true });

      assert.equal(draft.purchaseType, PurchaseType.UPGRADE);
      assert.equal(state.transactionCreateCalls.length, 1);
      const created = state.transactionCreateCalls[0]!;
      assert.equal(created.subscriptionId, 'trial-sub');
      assert.equal(created.amount, '299');
      // What the provider will repeat: the whole price for the whole term, and
      // the subscription each later charge renews — the trial, from the start.
      assert.deepStrictEqual((created.planSnapshot as Record<string, unknown>)['providerSubscription'], {
        unit: 'month',
        count: 1,
        amount: 299,
        durationDays: 30,
        planId: 'plan-1',
        subscriptionId: 'trial-sub',
      });
    });

    const refused: ReadonlyArray<{
      readonly name: string;
      readonly subscriptions: ReadonlyArray<{ id: string; userId: string; isTrial: boolean; status: SubscriptionStatus }>;
    }> = [
      {
        name: 'a change of a paid plan',
        subscriptions: [{ id: 'source-sub', userId: 'user-1', isTrial: false, status: SubscriptionStatus.ACTIVE }],
      },
      {
        name: 'a trial the operator froze, which the upgrade would lift',
        subscriptions: [{ id: 'source-sub', userId: 'user-1', isTrial: true, status: SubscriptionStatus.DISABLED }],
      },
      {
        name: "somebody else's trial",
        subscriptions: [{ id: 'source-sub', userId: 'user-2', isTrial: true, status: SubscriptionStatus.ACTIVE }],
      },
    ];
    for (const scenario of refused) {
      it(`is refused on ${scenario.name}, before anything is written`, async () => {
        const { service, state } = createService({
          quoteResult: createProviderSubscriptionQuote('source-sub'),
          subscriptions: scenario.subscriptions,
        });

        const error = await captureRejection(() =>
          service.createCheckoutDraft(upgradeToPlanOne('source-sub'), { providerSubscription: true }),
        );

        assert.ok(error instanceof BadRequestException);
        assert.deepStrictEqual(
          [
            (error.getResponse() as { code?: unknown }).code,
            (error.getResponse() as { reason?: unknown }).reason,
          ],
          ['AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE', 'PURCHASE_TYPE'],
        );
        assert.equal(state.transactionCreateCalls.length, 0);
      });
    }

    it('leaves the ordinary payment of a paid plan change as it was', async () => {
      const { service, state } = createService({
        quoteResult: createProviderSubscriptionQuote('source-sub'),
        subscriptions: [{ id: 'source-sub', userId: 'user-1', isTrial: false, status: SubscriptionStatus.ACTIVE }],
      });

      await service.createCheckoutDraft(upgradeToPlanOne('source-sub'));

      assert.equal(state.transactionCreateCalls.length, 1);
      assert.equal(
        (state.transactionCreateCalls[0]!.planSnapshot as Record<string, unknown>)['providerSubscription'],
        undefined,
      );
    });
  });

  it('allows an ADDITIONAL draft when capacity remains', async () => {
    const { service, state } = createService({
      quoteResult: createEligibleQuote(),
      capacityAvailable: true,
    });

    const transaction = await service.createDraft({
      userId: 'user-1',
      purchaseType: PurchaseType.ADDITIONAL,
      planId: 'plan-1',
      durationDays: 30,
      gatewayType: PaymentGatewayType.YOOKASSA,
      channel: PurchaseChannel.WEB,
    });

    assert.equal(transaction.id, 'transaction-1');
    assert.equal(state.transactionCreateCalls.length, 1);
  });

  it('reuses an existing pending draft for the same quote context', async () => {
    const { service, state } = createService({
      quoteResult: createEligibleQuote(),
      existingDrafts: [
        createStoredTransaction({
          id: 'transaction-existing',
          paymentId: 'payment-existing',
          planSnapshot: {
            snapshotSource: 'ADMIN_TRANSACTION_DRAFT',
            purchaseType: PurchaseType.NEW,
            selectedDurationDays: 30,
            trafficLimitStrategy: 'NO_RESET',
            deviceLimit: 1,
            trafficLimit: 1024,
            type: 'BOTH',
            tag: null,
            name: 'Starter',
            availability: PlanAvailability.ALL,
            id: 'plan-1',
          },
        }),
      ],
    });

    const transaction = await service.createDraft({
      userId: 'user-1',
      purchaseType: PurchaseType.NEW,
      planId: 'plan-1',
      durationDays: 30,
      gatewayType: PaymentGatewayType.YOOKASSA,
      channel: PurchaseChannel.WEB,
    });

    assert.equal(transaction.id, 'transaction-existing');
    assert.equal(transaction.paymentId, 'payment-existing');
    assert.equal(state.transactionCreateCalls.length, 0);
  });
});

async function captureRejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  assert.fail('expected a refusal');
}

/** What the BFF receives: the exception as `AdminSafeExceptionFilter` writes it. */
function runSafeFilter(exception: unknown): {
  readonly statusCode: number | undefined;
  readonly body: Record<string, unknown>;
} {
  let statusCode: number | undefined;
  let body: Record<string, unknown> = {};
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(payload: Record<string, unknown>) {
      body = payload;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ originalUrl: '/api/internal/payments/checkout', headers: {} }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  new AdminSafeExceptionFilter().catch(exception, host);
  return { statusCode, body };
}

function createService(input: {
  readonly quoteResult?: QuoteResult;
  readonly existingDrafts?: readonly StoredTransaction[];
  readonly listTransactions?: readonly StoredTransaction[];
  readonly listTotal?: number;
  readonly matchingUsers?: readonly { readonly id: string }[];
  /** Subscription-cap mock: capacityAvailable defaults to true. */
  readonly capacityAvailable?: boolean;
  readonly capacityMax?: number;
  /** The trial a purchase must convert; none by default. */
  readonly convertibleTrialId?: string;
  /** Subscription rows, as `subscription.findFirst` finds them by id and owner. */
  readonly subscriptions?: ReadonlyArray<{
    readonly id: string;
    readonly userId: string;
    readonly isTrial: boolean;
    readonly status: SubscriptionStatus;
  }>;
}): {
  readonly service: PaymentsTransactionsService;
  readonly state: {
    readonly quoteCalls: number;
    readonly userFindManyCalls: unknown[];
    readonly transactionListCalls: Array<Record<string, unknown>>;
    readonly transactionCountCalls: unknown[];
    readonly transactionCreateCalls: Record<string, unknown>[];
  };
} {
  const transactionCreateCalls: Record<string, unknown>[] = [];
  const transactionListCalls: Array<Record<string, unknown>> = [];
  const transactionCountCalls: unknown[] = [];
  const userFindManyCalls: unknown[] = [];
  let quoteCalls = 0;
  const existingDrafts = [...(input.existingDrafts ?? [])];
  const listTransactions = [...(input.listTransactions ?? [])];
  const state = {
    get quoteCalls(): number {
      return quoteCalls;
    },
    userFindManyCalls,
    transactionListCalls,
    transactionCountCalls,
    transactionCreateCalls,
  };
  const prismaService = {
    transaction: {
      findMany: async (args: Record<string, unknown>) => {
        if (args.include) {
          transactionListCalls.push(args);
          return listTransactions;
        }
        return existingDrafts;
      },
      count: async (args: unknown) => {
        transactionCountCalls.push(args);
        return input.listTotal ?? listTransactions.length;
      },
      create: async (args: { readonly data: Record<string, unknown> }) => {
        transactionCreateCalls.push(args.data);
        return createStoredTransaction({
          id: 'transaction-1',
          paymentId: 'payment-1',
          userId: String(args.data.userId),
          subscriptionId: (args.data.subscriptionId as string | null) ?? null,
          status: args.data.status as TransactionStatus,
          purchaseType: args.data.purchaseType as PurchaseType,
          channel: args.data.channel as PurchaseChannel,
          gatewayType: args.data.gatewayType as PaymentGatewayType,
          currency: args.data.currency as Currency,
          amount: String(args.data.amount),
          planSnapshot: args.data.planSnapshot as Record<string, unknown>,
          deviceTypes: args.data.deviceTypes as string[],
        });
      },
    },
    user: {
      findMany: async (args: unknown) => {
        userFindManyCalls.push(args);
        return input.matchingUsers ?? [];
      },
    },
    subscription: {
      findFirst: async (args: { readonly where: { readonly id?: string; readonly userId?: string } }) =>
        (input.subscriptions ?? []).find(
          (subscription) =>
            subscription.id === args.where.id &&
            (args.where.userId === undefined || subscription.userId === args.where.userId),
        ) ?? null,
    },
  };
  const quoteService = {
    getQuote: async () => {
      quoteCalls += 1;
      if (!input.quoteResult) {
        throw new Error('Unexpected quote request');
      }
      return input.quoteResult;
    },
    getSubscriptionCapacity: async () => ({
      activeSubscriptionCount: 0,
      effectiveMaxSubscriptions: input.capacityMax ?? 1,
      capacityAvailable: input.capacityAvailable ?? true,
      convertibleTrialId: input.convertibleTrialId ?? null,
    }),
  };
  return {
    service: new PaymentsTransactionsService(prismaService as never, quoteService as never),
    state,
  };
}

function createEligibleQuote(): QuoteResult {
  return {
    userId: 'user-1',
    purchaseType: PurchaseType.NEW,
    channel: PurchaseChannel.WEB,
    isEligible: true,
    selectedSubscriptionId: null,
    selectedPlan: {
      id: 'plan-1',
      name: 'Starter',
      availability: PlanAvailability.ALL,
      tag: null,
      type: 'BOTH',
      trafficLimit: 1024,
      deviceLimit: 1,
      trafficLimitStrategy: 'NO_RESET',
      durations: [],
    },
    selectedDuration: {
      id: 'duration-1',
      days: 30,
    },
    availablePlans: [],
    price: {
      gatewayType: PaymentGatewayType.YOOKASSA,
      currency: Currency.USD,
      originalPrice: '10',
      price: '8',
      discountPercent: 20,
      discountSource: 'PURCHASE',
    },
    warnings: [],
  };
}

/**
 * An UPGRADE of `subscriptionId` onto plan-1 for 30 days through Platega:
 * 299 RUB, the plan's own price with no one-time promo — a sum the provider
 * can repeat.
 */
function createProviderSubscriptionQuote(subscriptionId: string): QuoteResult {
  const quote = createEligibleQuote();
  return {
    ...quote,
    purchaseType: PurchaseType.UPGRADE,
    selectedSubscriptionId: subscriptionId,
    price: {
      gatewayType: PaymentGatewayType.PLATEGA,
      currency: Currency.RUB,
      originalPrice: '299',
      price: '299',
      discountPercent: 0,
      discountSource: 'NONE',
    },
    warnings: [{ code: 'UPGRADE_RESETS_EXPIRY', message: 'Upgrade starts immediately and resets the expiration date.' }],
  };
}

function createDraftSnapshot(purchaseType: PurchaseType): Record<string, unknown> {
  return {
    id: 'plan-1',
    name: 'Starter',
    availability: PlanAvailability.ALL,
    tag: null,
    type: 'BOTH',
    trafficLimit: 1024,
    deviceLimit: 1,
    trafficLimitStrategy: 'NO_RESET',
    selectedDurationDays: 30,
    purchaseType,
    snapshotSource: 'ADMIN_TRANSACTION_DRAFT',
  };
}

interface QuoteResult {
  userId: string;
  purchaseType: PurchaseType;
  channel: PurchaseChannel;
  isEligible: boolean;
  selectedSubscriptionId: string | null;
  selectedPlan: {
    id: string;
    name: string;
    availability: PlanAvailability;
    tag: string | null;
    type: string;
    trafficLimit: number | null;
    deviceLimit: number;
    trafficLimitStrategy: string;
    durations: readonly unknown[];
  } | null;
  selectedDuration: {
    id: string;
    days: number;
  } | null;
  availablePlans: readonly unknown[];
  price: {
    gatewayType: PaymentGatewayType;
    currency: Currency;
    originalPrice: string;
    price: string;
    discountPercent: number;
    discountSource: string;
  } | null;
  warnings: { code: string; message: string }[];
}

type StoredTransaction = ReturnType<typeof createStoredTransaction>;

function createStoredTransaction(input: {
  readonly id: string;
  readonly paymentId: string;
  readonly userId?: string;
  readonly subscriptionId?: string | null;
  readonly status?: TransactionStatus;
  readonly purchaseType?: PurchaseType;
  readonly channel?: PurchaseChannel;
  readonly gatewayType?: PaymentGatewayType;
  readonly currency?: Currency;
  readonly amount?: string;
  readonly planSnapshot?: Record<string, unknown>;
  readonly deviceTypes?: readonly string[];
  readonly user?: {
    readonly id: string;
    readonly telegramId: bigint | null;
    readonly username: string | null;
    readonly name: string;
    readonly email: string | null;
  } | null;
}) {
  return {
    id: input.id,
    paymentId: input.paymentId,
    userId: input.userId ?? 'user-1',
    subscriptionId: input.subscriptionId ?? null,
    status: input.status ?? TransactionStatus.PENDING,
    purchaseType: input.purchaseType ?? PurchaseType.NEW,
    channel: input.channel ?? PurchaseChannel.WEB,
    gatewayType: input.gatewayType ?? PaymentGatewayType.YOOKASSA,
    currency: input.currency ?? Currency.USD,
    amount: { toString: (): string => input.amount ?? '8' },
    paymentAsset: null,
    gatewayId: null,
    planSnapshot: input.planSnapshot ?? createDraftSnapshot(input.purchaseType ?? PurchaseType.NEW),
    deviceTypes: [...(input.deviceTypes ?? [])],
    fulfilledAt: null,
    createdAt: new Date('2026-04-19T12:00:00.000Z'),
    updatedAt: new Date('2026-04-19T12:00:00.000Z'),
    user: input.user,
    // What the list query's `include: { items: … }` makes Prisma return for a
    // single-subscription payment.
    items: [],
  };
}
