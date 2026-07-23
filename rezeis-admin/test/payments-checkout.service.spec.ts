import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import {
  Currency,
  PaymentGatewayType,
  PurchaseChannel,
  PurchaseType,
  SubscriptionStatus,
  SyncJobStatus,
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

  it('does not apply profile provisioning to unfinished or non-creation payments', async () => {
    for (const fixture of [
      {
        initialStatus: TransactionStatus.PENDING,
        purchaseType: PurchaseType.NEW,
      },
      {
        initialStatus: TransactionStatus.COMPLETED,
        purchaseType: PurchaseType.RENEW,
      },
    ] as const) {
      const { service, state } = createService(fixture)

      const status = await service.getPaymentStatus({
        paymentId: 'payment-1',
        userId: 'user-1',
      })

      assert.equal(status.subscriptionProvisioningStatus, 'NOT_APPLICABLE')
      assert.equal(status.subscriptionProvisioningFailureCode, null)
      assert.equal(state.subscriptionQueries.length, 0)
    }
  })

  it('does not treat an ADDON_PURCHASE transaction as a new subscription', async () => {
    const { service, state } = createService({
      initialStatus: TransactionStatus.COMPLETED,
      purchaseType: PurchaseType.ADDITIONAL,
      subscriptionId: 'subscription-1',
      transactionPlanSnapshot: {
        snapshotSource: 'ADDON_PURCHASE',
        addOnId: 'addon-1',
        targetSubscriptionId: 'subscription-1',
      },
      subscription: {
        status: SubscriptionStatus.ACTIVE,
        remnawaveId: 'remnawave-1',
        configUrl: 'https://subscription.example.com/config',
      },
    })

    const status = await service.getPaymentStatus({
      paymentId: 'payment-1',
      userId: 'user-1',
    })

    assert.equal(status.subscriptionProvisioningStatus, 'NOT_APPLICABLE')
    assert.equal(status.subscriptionProvisioningFailureCode, null)
    assert.equal(state.subscriptionQueries.length, 0)
  })

  it('reports FULFILLING while a completed creation payment has no subscription id', async () => {
    const { service, state } = createService({
      initialStatus: TransactionStatus.COMPLETED,
      purchaseType: PurchaseType.ADDITIONAL,
    })

    const status = await service.getPaymentStatus({
      paymentId: 'payment-1',
      userId: 'user-1',
    })

    assert.equal(status.subscriptionProvisioningStatus, 'FULFILLING')
    assert.equal(status.subscriptionProvisioningFailureCode, null)
    assert.equal(state.subscriptionQueries.length, 0)
  })

  it('reports PROFILE_PENDING for a local subscription without a complete panel profile', async () => {
    const { service, state } = createService({
      initialStatus: TransactionStatus.COMPLETED,
      subscriptionId: 'subscription-1',
      subscription: {
        status: SubscriptionStatus.ACTIVE,
        remnawaveId: 'remnawave-1',
        configUrl: null,
      },
      syncJob: {
        status: SyncJobStatus.RUNNING,
        attempts: 1,
        recoveryData: {},
      },
    })

    const status = await service.getPaymentStatus({
      paymentId: 'payment-1',
      userId: 'user-1',
    })

    assert.equal(status.subscriptionProvisioningStatus, 'PROFILE_PENDING')
    assert.equal(status.subscriptionProvisioningFailureCode, null)
    assert.equal(state.subscriptionQueries.length, 1)
    assert.deepEqual(state.subscriptionQueries[0], {
      where: { id: 'subscription-1' },
      select: {
        status: true,
        remnawaveId: true,
        configUrl: true,
        syncJobs: {
          where: {
            action: 'CREATE',
            supersededAt: null,
          },
          select: {
            status: true,
            attempts: true,
            recoveryData: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    })
  })

  it('tracks an UPGRADE that must create a missing panel profile', async () => {
    for (const fixture of [
      {
        syncJob: {
          status: SyncJobStatus.RUNNING,
          attempts: 1,
          recoveryData: {},
        },
        expectedStatus: 'PROFILE_PENDING',
        expectedFailureCode: null,
      },
      {
        syncJob: {
          status: SyncJobStatus.FAILED,
          attempts: 5,
          recoveryData: { classification: 'TERMINAL' },
        },
        expectedStatus: 'FAILED',
        expectedFailureCode: 'PROFILE_SYNC_FAILED',
      },
    ] as const) {
      const { service, state } = createService({
        initialStatus: TransactionStatus.COMPLETED,
        purchaseType: PurchaseType.UPGRADE,
        subscriptionId: 'subscription-1',
        subscription: {
          status: SubscriptionStatus.ACTIVE,
          remnawaveId: null,
          configUrl: null,
        },
        syncJob: fixture.syncJob,
      })

      const status = await service.getPaymentStatus({
        paymentId: 'payment-1',
        userId: 'user-1',
      })

      assert.equal(status.subscriptionProvisioningStatus, fixture.expectedStatus)
      assert.equal(
        status.subscriptionProvisioningFailureCode,
        fixture.expectedFailureCode,
      )
      assert.equal(state.subscriptionQueries.length, 1)
    }
  })

  it('keeps exhausted transient CREATE failures retryable', async () => {
    const { service } = createService({
      initialStatus: TransactionStatus.COMPLETED,
      subscriptionId: 'subscription-1',
      subscription: {
        status: SubscriptionStatus.ACTIVE,
        remnawaveId: null,
        configUrl: null,
      },
      syncJob: {
        status: SyncJobStatus.FAILED,
        attempts: 5,
        recoveryData: { classification: 'TRANSIENT' },
      },
    })

    const status = await service.getPaymentStatus({
      paymentId: 'payment-1',
      userId: 'user-1',
    })

    assert.equal(status.subscriptionProvisioningStatus, 'PROFILE_PENDING')
    assert.equal(status.subscriptionProvisioningFailureCode, null)
  })

  it('reports READY only for a non-deleted exact subscription with both panel fields', async () => {
    const readyFixture = {
      initialStatus: TransactionStatus.COMPLETED,
      subscriptionId: 'subscription-1',
      subscription: {
        status: SubscriptionStatus.ACTIVE,
        remnawaveId: 'remnawave-1',
        configUrl: 'https://subscription.example.com/config',
      },
    } as const
    const { service } = createService(readyFixture)

    const readyStatus = await service.getPaymentStatus({
      paymentId: 'payment-1',
      userId: 'user-1',
    })

    assert.equal(readyStatus.subscriptionProvisioningStatus, 'READY')
    assert.equal(readyStatus.subscriptionProvisioningFailureCode, null)

    const { service: deletedService } = createService({
      ...readyFixture,
      subscription: {
        ...readyFixture.subscription,
        status: SubscriptionStatus.DELETED,
      },
    })
    const deletedStatus = await deletedService.getPaymentStatus({
      paymentId: 'payment-1',
      userId: 'user-1',
    })

    assert.equal(deletedStatus.subscriptionProvisioningStatus, 'PROFILE_PENDING')
    assert.equal(deletedStatus.subscriptionProvisioningFailureCode, null)
  })

  it('exposes only a stable failure code for a terminal exhausted CREATE job', async () => {
    const rawLastError =
      'Profile create failed https://panel.example/api/users?token=super-secret configUrl'
    const { service } = createService({
      initialStatus: TransactionStatus.COMPLETED,
      subscriptionId: 'subscription-1',
      subscription: {
        status: SubscriptionStatus.ACTIVE,
        remnawaveId: null,
        configUrl: null,
      },
      syncJob: {
        status: SyncJobStatus.FAILED,
        attempts: 5,
        recoveryData: { classification: 'TERMINAL' },
        lastError: rawLastError,
      },
    })

    const status = await service.getPaymentStatus({
      paymentId: 'payment-1',
      userId: 'user-1',
    })
    const serialized = JSON.stringify(status)

    assert.equal(status.subscriptionProvisioningStatus, 'FAILED')
    assert.equal(status.subscriptionProvisioningFailureCode, 'PROFILE_SYNC_FAILED')
    assert.equal(serialized.includes(rawLastError), false)
    assert.equal(serialized.includes('super-secret'), false)
    assert.equal(serialized.includes('panel.example'), false)
  })

  it('fulfills immediately when provider returns succeeded off-session', async () => {
    const { service, state } = createService({
      providerCheckout: {
        gatewayId: 'provider-succeeded-1',
        checkoutUrl: null,
        providerMode: 'IMMEDIATE',
        providerStatus: 'succeeded',
        gatewayData: { provider: 'YOOKASSA', providerStatus: 'succeeded', providerMode: 'IMMEDIATE' },
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

    assert.equal(checkout.transactionStatus, TransactionStatus.COMPLETED)
    assert.equal(checkout.checkoutUrl, null)
    assert.equal(state.applyCompletedCalls, 1)
    assert.equal(state.enqueueCalls, 1)
    assert.equal(state.transactionUpdateMany.some((data) => data.fulfilledAt instanceof Date), true)
  })

  it('does not provision twice when the immediate claim was already fulfilled', async () => {
    // Simulate race: reconciler already claimed fulfilledAt before create-response path.
    const alreadyFulfilledAt = new Date('2026-07-21T12:00:00.000Z')
    const { service, state } = createService({
      immediateClaimCount: 0,
      fulfilledAt: alreadyFulfilledAt,
      // Pre-mark COMPLETED so findUnique after a lost claim returns terminal state.
      initialStatus: TransactionStatus.COMPLETED,
      providerCheckout: {
        gatewayId: 'provider-succeeded-1',
        checkoutUrl: null,
        providerMode: 'IMMEDIATE',
        providerStatus: 'succeeded',
        gatewayData: { provider: 'YOOKASSA', providerStatus: 'succeeded' },
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
    assert.equal(checkout.transactionStatus, TransactionStatus.COMPLETED)
    assert.equal(state.applyCompletedCalls, 0)
    assert.equal(state.enqueueCalls, 0)
  })

  it('persists a canceled provider result without provisioning', async () => {
    const { service, state } = createService({ providerCheckout: { gatewayId: 'provider-canceled-1', checkoutUrl: null, providerMode: 'IMMEDIATE', providerStatus: 'CANCELLED', gatewayData: { provider: 'YOOKASSA', cancellation_details: { reason: 'permission_revoked' } } } })
    const checkout = await service.checkout({ userId: 'user-1', purchaseType: PurchaseType.NEW, planId: 'plan-1', durationDays: 30, gatewayType: PaymentGatewayType.YOOKASSA, channel: PurchaseChannel.WEB })
    assert.equal(checkout.transactionStatus, TransactionStatus.CANCELED)
    assert.equal(state.applyCompletedCalls, 0)
  })
})

function createService(input: {
  readonly gatewayType?: PaymentGatewayType
  readonly gatewayCurrency?: Currency
  readonly gatewaySettings?: Record<string, unknown>
  readonly transactionGatewayData?: Record<string, unknown>
  readonly transactionPlanSnapshot?: Record<string, unknown>
  readonly draftError?: Error
  readonly accessMode?: 'PUBLIC' | 'INVITED' | 'PURCHASE_BLOCKED' | 'REG_BLOCKED' | 'RESTRICTED'
  readonly amount?: string
  readonly immediateClaimCount?: number
  readonly fulfilledAt?: Date | null
  /** Optional starting status for race fixtures (default PENDING). */
  readonly initialStatus?: TransactionStatus
  readonly purchaseType?: PurchaseType
  readonly subscriptionId?: string | null
  readonly subscription?: null | {
    readonly status: SubscriptionStatus
    readonly remnawaveId: string | null
    readonly configUrl: string | null
  }
  readonly syncJob?: null | {
    readonly status: SyncJobStatus
    readonly attempts: number
    readonly recoveryData: Record<string, unknown>
    readonly lastError?: string | null
  }
  providerCheckout?: {
    gatewayId: string
    checkoutUrl: string | null
    providerMode: string
    providerStatus: string | null
    gatewayData: Record<string, unknown>
  }
} = {}) {
  const transactionUpdates: Record<string, unknown>[] = []
  const state = {
    transactionUpdates,
    transactionUpdateMany: [] as Record<string, unknown>[],
    providerCreateCalls: 0,
    applyCompletedCalls: 0,
    enqueueCalls: 0,
    subscriptionQueries: [] as unknown[],
  }
  const paymentId = 'payment-1'
  const gatewayType = input.gatewayType ?? PaymentGatewayType.YOOKASSA
  const transaction = {
    id: 'transaction-1',
    paymentId,
    userId: 'user-1',
    subscriptionId: input.subscriptionId ?? null,
    status: (input.initialStatus ?? TransactionStatus.PENDING) as TransactionStatus,
    purchaseType: input.purchaseType ?? PurchaseType.NEW,
    channel: PurchaseChannel.WEB,
    gatewayType,
    currency: input.gatewayCurrency ?? Currency.USD,
    amount: { toString: () => input.amount ?? '9.99' },
    paymentAsset: null,
    gatewayId: null,
    fulfilledAt: input.fulfilledAt ?? null,
    gatewayData: input.transactionGatewayData ?? null,
    planSnapshot:
      input.transactionPlanSnapshot ??
      {
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
        Object.assign(transaction, args.data)
        return {
          ...transaction,
        }
      },
      updateMany: async (args: { readonly data: Record<string, unknown> }) => {
        state.transactionUpdateMany.push(args.data)
        if (input.immediateClaimCount === 0) {
          transaction.status = TransactionStatus.COMPLETED
          transaction.fulfilledAt = input.fulfilledAt ?? new Date()
          return { count: 0 }
        }
        Object.assign(transaction, args.data)
        return { count: 1 }
      },
      findUniqueOrThrow: async () => transaction,
    },
    subscription: {
      findUnique: async (args: unknown) => {
        state.subscriptionQueries.push(args)
        if (input.subscription === null || input.subscription === undefined) {
          return null
        }
        return {
          ...input.subscription,
          syncJobs:
            input.syncJob === null || input.syncJob === undefined
              ? []
              : [
                  {
                    ...input.syncJob,
                  },
                ],
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
        status: TransactionStatus.PENDING as TransactionStatus,
        gatewayType,
        purchaseType: input.purchaseType ?? PurchaseType.NEW,
        channel: PurchaseChannel.WEB,
        currency: input.gatewayCurrency ?? Currency.USD,
        amount: '9.99',
      }
    },
  }
  const paymentProviderExecutionService = {
    createCheckout: async () => {
      state.providerCreateCalls += 1
      if (input.providerCheckout !== undefined) {
        return input.providerCheckout
      }
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
