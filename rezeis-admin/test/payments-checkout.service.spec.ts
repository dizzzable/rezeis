import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import {
  Currency,
  PaymentGatewayType,
  PurchaseChannel,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';

import { PaymentsCheckoutService } from '../src/modules/payments/services/payments-checkout.service';

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
} = {}) {
  const transactionUpdates: Record<string, unknown>[] = []
  const state = {
    transactionUpdates,
    providerCreateCalls: 0,
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
    amount: { toString: () => '9.99' },
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
    ),
    state,
  }
}
