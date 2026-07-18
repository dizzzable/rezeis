import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import {
  Currency,
  PaymentGatewayType,
  PurchaseChannel,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';

import { PaymentsCheckoutService } from '../src/modules/payments/services/payments-checkout.service';
import { AccessModeGuard } from '../src/modules/settings/services/access-mode-guard.service';

describe('PaymentsCheckoutService', () => {
  it('creates checkout for an active and configured gateway', async () => {
    const { service, state } = createService()

    const checkout = await service.checkout({
      userId: 'user-1',
      purchaseType: PurchaseType.NEW,
      planId: 'plan-1',
      durationDays: 30,
      gatewayType: PaymentGatewayType.YOOKASSA,
      channel: PurchaseChannel.WEB,
    })

    assert.equal(checkout.paymentId, 'payment-1')
    assert.equal(checkout.checkoutUrl, 'https://checkout.example.com')
    assert.equal(state.transactionUpdates.length, 1)
  })

  // ── Access-mode wiring (real AccessModeGuard) ──────────────────────────────
  // Integration coverage for Task 36: checkout consults the platform access
  // mode through the wired guard, branching on purchaseType.

  it('NEW purchase rejects under PURCHASE_BLOCKED with 403 PURCHASES_DISABLED', async () => {
    const { service, state } = createService({ accessMode: 'PURCHASE_BLOCKED' })
    await assert.rejects(
      () =>
        service.checkout({
          userId: 'user-1',
          purchaseType: PurchaseType.NEW,
          planId: 'plan-1',
          durationDays: 30,
          gatewayType: PaymentGatewayType.YOOKASSA,
          channel: PurchaseChannel.WEB,
        }),
      (error: unknown) =>
        error instanceof ForbiddenException &&
        (error.getResponse() as { code?: string }).code === 'PURCHASES_DISABLED',
    )
    // Gate fires before the transaction draft — nothing persisted.
    assert.equal(state.transactionUpdates.length, 0)
    assert.equal(state.providerCreateCalls, 0)
  })

  it('UPGRADE purchase rejects under PURCHASE_BLOCKED', async () => {
    const { service } = createService({ accessMode: 'PURCHASE_BLOCKED' })
    await assert.rejects(
      () =>
        service.checkout({
          userId: 'user-1',
          purchaseType: PurchaseType.UPGRADE,
          planId: 'plan-1',
          durationDays: 30,
          gatewayType: PaymentGatewayType.YOOKASSA,
          channel: PurchaseChannel.WEB,
          subscriptionId: 'sub-1',
        }),
      (error: unknown) =>
        error instanceof ForbiddenException &&
        (error.getResponse() as { code?: string }).code === 'PURCHASES_DISABLED',
    )
  })

  it('NEW purchase rejects under RESTRICTED with 503 SERVICE_RESTRICTED', async () => {
    const { service } = createService({ accessMode: 'RESTRICTED' })
    await assert.rejects(
      () =>
        service.checkout({
          userId: 'user-1',
          purchaseType: PurchaseType.NEW,
          planId: 'plan-1',
          durationDays: 30,
          gatewayType: PaymentGatewayType.YOOKASSA,
          channel: PurchaseChannel.WEB,
        }),
      (error: unknown) =>
        error instanceof ServiceUnavailableException &&
        (error.getResponse() as { code?: string }).code === 'SERVICE_RESTRICTED',
    )
  })

  it('NEW purchase passes under INVITED / REG_BLOCKED (purchases unaffected)', async () => {
    for (const accessMode of ['INVITED', 'REG_BLOCKED'] as const) {
      const { service } = createService({ accessMode })
      const checkout = await service.checkout({
        userId: 'user-1',
        purchaseType: PurchaseType.NEW,
        planId: 'plan-1',
        durationDays: 30,
        gatewayType: PaymentGatewayType.YOOKASSA,
        channel: PurchaseChannel.WEB,
      })
      assert.equal(checkout.paymentId, 'payment-1')
    }
  })

  it('rejects Telegram Stars checkout on WEB channel', async () => {
    const { service } = createService({
      gatewayType: PaymentGatewayType.TELEGRAM_STARS,
      gatewayCurrency: Currency.XTR,
      gatewaySettings: { webhookSecret: 'telegram-secret' },
    })

    await assert.rejects(
      async () => {
        await service.checkout({
          userId: 'user-1',
          purchaseType: PurchaseType.NEW,
          planId: 'plan-1',
          durationDays: 30,
          gatewayType: PaymentGatewayType.TELEGRAM_STARS,
          channel: PurchaseChannel.WEB,
        })
      },
      {
        name: 'BadRequestException',
        message: 'PAYMENT_GATEWAY_CHANNEL_UNSUPPORTED',
      },
    )
  })

  it('reuses existing checkout url when provider execution already ran for the draft', async () => {
    const { service, state } = createService({
      transactionGatewayData: {
        checkoutUrl: 'https://existing-checkout.example.com',
        providerMode: 'REDIRECT',
      },
    })

    const checkout = await service.checkout({
      userId: 'user-1',
      purchaseType: PurchaseType.NEW,
      planId: 'plan-1',
      durationDays: 30,
      gatewayType: PaymentGatewayType.YOOKASSA,
      channel: PurchaseChannel.WEB,
    })

    assert.equal(checkout.checkoutUrl, 'https://existing-checkout.example.com')
    assert.equal(state.providerCreateCalls, 0)
  })

  it('completes a zero-total checkout without calling the payment provider', async () => {
    const { service, state } = createService({ amount: '0' })

    const checkout = await service.checkout({
      userId: 'user-1',
      purchaseType: PurchaseType.NEW,
      planId: 'plan-1',
      durationDays: 30,
      gatewayType: PaymentGatewayType.YOOKASSA,
      channel: PurchaseChannel.WEB,
    })

    // No real payment to create — the provider is never touched and the
    // subscription is provisioned directly (mirrors the free-add-on path).
    assert.equal(checkout.checkoutUrl, null)
    assert.equal(checkout.providerMode, 'NONE')
    assert.equal(state.providerCreateCalls, 0)
    assert.equal(state.applyCompletedCalls, 1)
    assert.equal(state.enqueueCalls, 1)
  })

  it('propagates entitlement deny from transaction draft creation', async () => {
    const { service, state } = createService({
      draftError: new BadRequestException({
        code: 'PAYMENT_DRAFT_ENTITLEMENT_DENIED',
        message: 'Entitlement policy denied transaction draft creation.',
      }),
    })

    await assert.rejects(
      async () => {
        await service.checkout({
          userId: 'user-1',
          purchaseType: PurchaseType.NEW,
          planId: 'plan-1',
          durationDays: 30,
          gatewayType: PaymentGatewayType.YOOKASSA,
          channel: PurchaseChannel.WEB,
        })
      },
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException)
        const response = error.getResponse() as {
          readonly code: string
          readonly message: string
        }
        assert.equal(response.code, 'PAYMENT_DRAFT_ENTITLEMENT_DENIED')
        assert.equal(response.message, 'Entitlement policy denied transaction draft creation.')
        return true
      },
    )

    assert.equal(state.providerCreateCalls, 0)
    assert.equal(state.transactionUpdates.length, 0)
  })

  it('normalizes provider failure diagnostics in payment status responses', async () => {
    const rawFailureReason =
      'provider failed https://pay.example/checkout/0194f4b6-7cc7-7ecb-9f62-123456789abc?token=raw-provider-token-secret providerUuid=provider-id-123 auth cookie subscriptionUrl configUrl'
    const { service } = createService({
      transactionGatewayData: {
        failureReason: rawFailureReason,
      },
    })

    const status = await service.getPaymentStatus({
      paymentId: 'payment-1',
      userId: 'user-1',
    })
    const serialized = JSON.stringify(status)

    assert.equal(status.failureReason, 'PAYMENT_PROVIDER_ERROR')
    assert.equal(serialized.includes('https://pay.example'), false)
    assert.equal(serialized.includes('raw-provider-token-secret'), false)
    assert.equal(serialized.includes('0194f4b6-7cc7-7ecb-9f62-123456789abc'), false)
    assert.equal(serialized.includes('provider-id-123'), false)
    assert.equal(serialized.includes('subscriptionUrl'), false)
    assert.equal(serialized.includes('configUrl'), false)
    assert.equal(serialized.includes('auth'), false)
    assert.equal(serialized.includes('cookie'), false)
  })

  it('preserves bounded provider failure codes in payment status responses', async () => {
    const { service } = createService({
      transactionGatewayData: {
        lastError: 'PAYMENT_PROVIDER_TIMEOUT',
      },
    })

    const status = await service.getPaymentStatus({
      paymentId: 'payment-1',
      userId: 'user-1',
    })

    assert.equal(status.failureReason, 'PAYMENT_PROVIDER_TIMEOUT')
  })
})

function createService(input: {
  readonly gatewayType?: PaymentGatewayType
  readonly gatewayCurrency?: Currency
  readonly gatewaySettings?: Record<string, unknown>
  readonly transactionGatewayData?: Record<string, unknown>
  readonly draftError?: Error
  readonly accessMode?: 'PUBLIC' | 'INVITED' | 'PURCHASE_BLOCKED' | 'REG_BLOCKED' | 'RESTRICTED'
  readonly amount?: string
} = {}) {
  const transactionUpdates: Record<string, unknown>[] = []
  const state = {
    transactionUpdates,
    providerCreateCalls: 0,
    applyCompletedCalls: 0,
    enqueueCalls: 0,
  }
  const paymentId = 'payment-1'
  const gatewayType = input.gatewayType ?? PaymentGatewayType.YOOKASSA
  const transaction = {
    id: 'transaction-1',
    paymentId,
    userId: 'user-1',
    subscriptionId: null,
    status: TransactionStatus.PENDING,
    purchaseType: PurchaseType.NEW,
    channel: PurchaseChannel.WEB,
    gatewayType,
    currency: input.gatewayCurrency ?? Currency.USD,
    amount: { toString: () => input.amount ?? '9.99' },
    paymentAsset: null,
    gatewayId: null,
    gatewayData: input.transactionGatewayData ?? null,
    planSnapshot: {
      id: 'plan-1',
      name: 'Starter',
      selectedDurationDays: 30,
    },
    createdAt: new Date('2026-04-19T12:00:00.000Z'),
    updatedAt: new Date('2026-04-19T12:00:00.000Z'),
  }
  const prismaService = {
    paymentGateway: {
      findUnique: async () => ({
        id: 'gateway-1',
        type: gatewayType,
        currency: input.gatewayCurrency ?? Currency.USD,
        isActive: true,
        settings: input.gatewaySettings ?? { shopId: 'shop-1', apiKey: 'secret-1' },
      }),
    },
    transaction: {
      findUnique: async () => transaction,
      update: async (args: { readonly data: Record<string, unknown> }) => {
        transactionUpdates.push(args.data)
        return {
          ...transaction,
          gatewayId: args.data.gatewayId,
          gatewayData: args.data.gatewayData,
        }
      },
      updateMany: async () => ({ count: 1 }),
      findUniqueOrThrow: async () => transaction,
    },
  }
  const paymentsTransactionsService = {
    createDraft: async () => {
      if (input.draftError !== undefined) {
        throw input.draftError
      }
      return {
        id: 'transaction-1',
        paymentId,
        status: TransactionStatus.PENDING,
        gatewayType,
        purchaseType: PurchaseType.NEW,
        channel: PurchaseChannel.WEB,
        currency: input.gatewayCurrency ?? Currency.USD,
        amount: '9.99',
      }
    },
  }
  const paymentProviderExecutionService = {
    createCheckout: async () => {
      state.providerCreateCalls += 1
      return {
        gatewayId: 'provider-1',
        checkoutUrl: 'https://checkout.example.com',
        providerMode: 'REDIRECT',
        providerStatus: 'pending',
        gatewayData: {
          checkoutUrl: 'https://checkout.example.com',
          providerMode: 'REDIRECT',
        },
      }
    },
  }

  return {
    service: new PaymentsCheckoutService(
      prismaService as never,
      paymentsTransactionsService as never,
      paymentProviderExecutionService as never,
      // PaymentSubscriptionMutationService + ProfileSyncQueueService — only
      // exercised by the zero-total (free) branch; plain stubs for the rest.
      {
        applyCompletedTransaction: async () => {
          state.applyCompletedCalls += 1
          return { syncJobs: [{ id: 'sync-1' }] }
        },
      } as never,
      {
        enqueue: async () => {
          state.enqueueCalls += 1
        },
      } as never,
      // SettingsService stub — returns the requested mode (PUBLIC default so
      // the access-mode gate is a no-op for the legacy tests).
      {
        getInternalPlatformPolicy: async () => ({ accessMode: (input.accessMode ?? 'PUBLIC') as never }),
      } as never,
      // AccessModeGuard — real guard when `accessMode` is supplied (wiring
      // test), no-op evaluator otherwise.
      (input.accessMode === undefined ? { evaluate: () => null } : new AccessModeGuard()) as never,
      // SavedPaymentMethodService — only used when savedPaymentMethodId is set.
      {
        resolveActiveForCharge: async () => null,
      } as never,
    ),
    state,
  }
}
