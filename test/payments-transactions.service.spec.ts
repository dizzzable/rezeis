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

import { CreateTransactionDraftDto } from '../src/modules/payments/dto/create-transaction-draft.dto';
import { CreatePaymentCorrectionNoteDto } from '../src/modules/payments/dto/create-payment-correction-note.dto';
import { CreatePaymentDisputeRecordDto } from '../src/modules/payments/dto/create-payment-dispute-record.dto';
import { CreatePaymentReconciliationExceptionDto } from '../src/modules/payments/dto/create-payment-reconciliation-exception.dto';
import { PaymentsTransactionsService } from '../src/modules/payments/services/payments-transactions.service';

describe('PaymentsTransactionsService', () => {
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
    });

    assert.equal(transaction.status, TransactionStatus.PENDING);
    assert.equal(transaction.purchaseType, PurchaseType.NEW);
    assert.equal(transaction.gatewayType, PaymentGatewayType.YOOKASSA);
    assert.equal(transaction.currency, Currency.USD);
    assert.equal(transaction.amount, '8.00');
    assert.equal(state.transactionCreateCalls.length, 1);
  });

  it('applies purchase discount before personal discount when creating transaction drafts', async () => {
    const { service, state } = createService({ quoteResult: { ...createEligibleQuote(), price: { ...createEligibleQuote().price, price: '100' } }, userDiscounts: { purchaseDiscount: 20, personalDiscount: 50 } });

    const transaction = await service.createDraft({ userId: 'user-1', purchaseType: PurchaseType.NEW, planId: 'plan-1', durationDays: 30, gatewayType: PaymentGatewayType.YOOKASSA, channel: PurchaseChannel.WEB });

    assert.equal(transaction.amount, '80.00');
    assert.equal(state.transactionCreateCalls[0]?.amount, '80.00');
    assert.deepStrictEqual((state.transactionCreateCalls[0]?.planSnapshot as { readonly pricing: unknown }).pricing, { originalAmount: '100.00', finalAmount: '80.00', discountPercent: 20, discountSource: 'PURCHASE' });
  });

  it('rejects ineligible quotes and does not create transaction', async () => {
    const { service, state } = createService({
      quoteResult: {
        ...createEligibleQuote(),
        isEligible: false,
        warnings: [{ code: 'GATEWAY_NOT_AVAILABLE', message: 'Gateway not available' }],
      },
    });

    await assert.rejects(
      async () => {
        await service.createDraft({
          userId: 'user-1',
          purchaseType: PurchaseType.NEW,
          planId: 'plan-1',
          durationDays: 30,
          gatewayType: PaymentGatewayType.YOOKASSA,
          channel: PurchaseChannel.WEB,
        });
      },
      {
        name: 'BadRequestException',
        message: 'Quote is not eligible for transaction draft creation.',
      },
    );

    assert.equal(state.transactionCreateCalls.length, 0);
  });

  it('executes a planned YooKassa refund request through provider adapter and audit log', async () => {
    const calls: unknown[] = [];
    const transaction = {
      id: 'transaction-1',
      status: TransactionStatus.COMPLETED,
      gatewayType: PaymentGatewayType.YOOKASSA,
      gatewayId: 'payment-1',
      amount: { toString: (): string => '10.00' },
      currency: Currency.USD,
    };
    const service = new PaymentsTransactionsService(
      {
        $transaction: async <T>(callback: (transactionClient: unknown) => Promise<T>) =>
          callback({
            transaction: {
              update: async (input: unknown) => {
                calls.push(['transaction.update', input]);
              },
            },
            adminAuditLog: {
              create: async (input: unknown) => {
                calls.push(['audit.create', input]);
              },
            },
          }),
        transaction: {
          findUnique: async () => transaction,
        },
        paymentGateway: {
          findUnique: async () => ({ id: 'gateway-1', type: PaymentGatewayType.YOOKASSA, settings: {} }),
        },
        adminAuditLog: {
          findMany: async () => [
            {
              id: 'request-1',
              action: 'CREATE_REFUND_REQUEST',
              metadata: {
                requestId: 'request-1',
                transactionId: 'transaction-1',
                gatewayType: PaymentGatewayType.YOOKASSA,
                transactionStatus: TransactionStatus.COMPLETED,
                amount: '10.00',
                currency: Currency.USD,
                reason: 'duplicate payment',
                idempotencyKey: 'refund-1',
              },
              createdAt: new Date('2026-04-24T12:00:00.000Z'),
            },
          ],
        },
      } as never,
      {} as never,
      {} as never,
      {
        createRefund: async (input: unknown) => {
          calls.push(['provider.createRefund', input]);
          return { gatewayRefundId: 'refund-remote-1', providerStatus: 'succeeded', gatewayData: {} };
        },
      } as never,
    );

    const result = await service.executeRefundRequest({ transactionId: 'transaction-1', requestId: 'request-1', adminUserId: 'admin-1' });

    assert.equal(result.status, 'REFUNDED');
    assert.equal(result.gatewayRefundId, 'refund-remote-1');
    assert.equal(calls.some((call) => Array.isArray(call) && call[0] === 'provider.createRefund'), true);
    assert.equal(calls.some((call) => Array.isArray(call) && call[0] === 'transaction.update'), true);
    assert.equal(calls.some((call) => Array.isArray(call) && call[0] === 'audit.create'), true);
    assert.deepStrictEqual(calls.map((call) => (Array.isArray(call) ? call[0] : 'unknown')), [
      'provider.createRefund',
      'transaction.update',
      'audit.create',
    ]);
  });

  it('executes a planned Heleket refund request with stored provider parameters', async () => {
    const calls: unknown[] = [];
    const transaction = {
      id: 'transaction-1',
      status: TransactionStatus.COMPLETED,
      gatewayType: PaymentGatewayType.HELEKET,
      gatewayId: 'payment-heleket-1',
      amount: { toString: (): string => '10.00' },
      currency: Currency.USD,
    };
    const service = new PaymentsTransactionsService(
      {
        $transaction: async <T>(callback: (transactionClient: unknown) => Promise<T>) =>
          callback({
            transaction: {
              update: async (input: unknown) => {
                calls.push(['transaction.update', input]);
              },
            },
            adminAuditLog: {
              create: async (input: unknown) => {
                calls.push(['audit.create', input]);
              },
            },
          }),
        transaction: {
          findUnique: async () => transaction,
        },
        paymentGateway: {
          findUnique: async () => ({ id: 'gateway-1', type: PaymentGatewayType.HELEKET, settings: {} }),
        },
        adminAuditLog: {
          findMany: async () => [
            {
              id: 'request-1',
              action: 'CREATE_REFUND_REQUEST',
              metadata: {
                requestId: 'request-1',
                transactionId: 'transaction-1',
                gatewayType: PaymentGatewayType.HELEKET,
                transactionStatus: TransactionStatus.COMPLETED,
                amount: '10.00',
                currency: Currency.USD,
                reason: 'duplicate payment',
                idempotencyKey: 'refund-heleket-1',
                refundAddress: 'TRON-wallet-address',
                refundAddressProvided: true,
                isSubtract: true,
              },
              createdAt: new Date('2026-04-24T12:00:00.000Z'),
            },
          ],
        },
      } as never,
      {} as never,
      {} as never,
      {
        createRefund: async (input: unknown) => {
          calls.push(['provider.createRefund', input]);
          assert.deepStrictEqual(input, {
            gateway: { id: 'gateway-1', type: PaymentGatewayType.HELEKET, settings: {} },
            transaction,
            idempotencyKey: 'refund-heleket-1',
            refundAddress: 'TRON-wallet-address',
            isSubtract: true,
          });
          return { gatewayRefundId: 'heleket-refund-1', providerStatus: 'paid', gatewayData: {} };
        },
      } as never,
    );

    const result = await service.executeRefundRequest({ transactionId: 'transaction-1', requestId: 'request-1', adminUserId: 'admin-1' });

    assert.equal(result.status, 'REFUNDED');
    assert.equal(result.gatewayRefundId, 'heleket-refund-1');
    assert.equal(calls.some((call) => Array.isArray(call) && call[0] === 'provider.createRefund'), true);
    assert.equal(calls.some((call) => Array.isArray(call) && call[0] === 'transaction.update'), true);
    assert.equal(calls.some((call) => Array.isArray(call) && call[0] === 'audit.create'), true);
    assert.deepStrictEqual(calls.map((call) => (Array.isArray(call) ? call[0] : 'unknown')), [
      'provider.createRefund',
      'transaction.update',
      'audit.create',
    ]);
  });

  it('keeps refund status update and execution audit in one database transaction after provider refund succeeds', async () => {
    const calls: unknown[] = [];
    const transaction = {
      id: 'transaction-1',
      status: TransactionStatus.COMPLETED,
      gatewayType: PaymentGatewayType.YOOKASSA,
      gatewayId: 'payment-1',
      amount: { toString: (): string => '10.00' },
      currency: Currency.USD,
    };
    const service = new PaymentsTransactionsService(
      {
        $transaction: async <T>(callback: (transactionClient: unknown) => Promise<T>) => {
          calls.push(['db.transaction.begin']);
          const result = await callback({
            transaction: {
              update: async (input: unknown) => {
                calls.push(['tx.transaction.update', input]);
              },
            },
            adminAuditLog: {
              create: async (input: unknown) => {
                calls.push(['tx.audit.create', input]);
              },
            },
          });
          calls.push(['db.transaction.commit']);
          return result;
        },
        transaction: {
          findUnique: async () => transaction,
          update: async () => {
            throw new Error('non-transactional transaction.update should not be used');
          },
        },
        paymentGateway: {
          findUnique: async () => ({ id: 'gateway-1', type: PaymentGatewayType.YOOKASSA, settings: {} }),
        },
        adminAuditLog: {
          findMany: async () => [
            {
              id: 'request-1',
              action: 'CREATE_REFUND_REQUEST',
              metadata: {
                requestId: 'request-1',
                transactionId: 'transaction-1',
                gatewayType: PaymentGatewayType.YOOKASSA,
                transactionStatus: TransactionStatus.COMPLETED,
                amount: '10.00',
                currency: Currency.USD,
                reason: 'duplicate payment',
                idempotencyKey: 'refund-1',
              },
              createdAt: new Date('2026-04-24T12:00:00.000Z'),
            },
          ],
          create: async () => {
            throw new Error('non-transactional adminAuditLog.create should not be used');
          },
        },
      } as never,
      {} as never,
      {} as never,
      {
        createRefund: async () => {
          calls.push(['provider.createRefund']);
          return { gatewayRefundId: 'refund-remote-1', providerStatus: 'succeeded', gatewayData: {} };
        },
      } as never,
    );

    const result = await service.executeRefundRequest({ transactionId: 'transaction-1', requestId: 'request-1', adminUserId: 'admin-1' });

    assert.equal(result.status, 'REFUNDED');
    assert.deepStrictEqual(calls.map((call) => (Array.isArray(call) ? call[0] : 'unknown')), [
      'provider.createRefund',
      'db.transaction.begin',
      'tx.transaction.update',
      'tx.audit.create',
      'db.transaction.commit',
    ]);
  });

  it('keeps gateway ineligibility as quote-not-eligible instead of entitlement denied', async () => {
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
      const response = error.getResponse() as {
        readonly code: string;
        readonly message: string;
        readonly warnings: readonly { readonly code: string }[];
      };
      assert.equal(response.code, 'PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE');
      assert.equal(response.message, 'Quote is not eligible for transaction draft creation.');
      assert.deepStrictEqual(response.warnings.map((warning) => warning.code), [
        'GATEWAY_NOT_AVAILABLE',
      ]);
      return true;
    });

    assert.equal(state.transactionCreateCalls.length, 0);
  });

  it('rejects entitlement-denied quotes with specific error payload', async () => {
    const { service, state } = createService({
      quoteResult: {
        ...createEligibleQuote(),
        isEligible: false,
        warnings: [{ code: 'SOURCE_SUBSCRIPTION_REQUIRED', message: 'Source subscription is required' }],
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
      const response = error.getResponse() as {
        readonly code: string;
        readonly message: string;
        readonly warnings: readonly { readonly code: string }[];
      };
      assert.equal(response.code, 'PAYMENT_DRAFT_ENTITLEMENT_DENIED');
      assert.equal(response.message, 'Entitlement policy denied transaction draft creation.');
      assert.deepStrictEqual(response.warnings.map((warning) => warning.code), [
        'SOURCE_SUBSCRIPTION_REQUIRED',
      ]);
      return true;
    });

    assert.equal(state.transactionCreateCalls.length, 0);
  });

  it('rejects TRIAL transaction draft payloads', async () => {
    const { service } = createService({
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

    await assert.rejects(
      async () => {
        await service.createDraft(input);
      },
      {
        name: 'BadRequestException',
        message: 'Trial purchases cannot be converted to transaction drafts.',
      },
    );
  });

  it('stores plan snapshot and final quote amount without creating subscriptions or provider calls', async () => {
    const { service, state } = createService({
      quoteResult: createEligibleQuote(),
    });

    await service.createDraft({
      userId: 'user-1',
      purchaseType: PurchaseType.UPGRADE,
      planId: 'plan-1',
      durationDays: 30,
      gatewayType: PaymentGatewayType.YOOKASSA,
      sourceSubscriptionId: 'subscription-1',
      channel: PurchaseChannel.WEB,
    });

    assert.equal(state.transactionCreateCalls.length, 1);
    assert.deepStrictEqual(state.transactionCreateCalls[0], {
      userId: 'user-1',
      subscriptionId: 'subscription-1',
      status: TransactionStatus.PENDING,
      purchaseType: PurchaseType.UPGRADE,
      channel: PurchaseChannel.WEB,
      gatewayType: PaymentGatewayType.YOOKASSA,
      currency: Currency.USD,
      amount: '8.00',
      planSnapshot: {
        id: 'plan-1',
        name: 'Starter',
        tag: null,
        type: 'BOTH',
        trafficLimit: 1024,
        deviceLimit: 1,
        trafficLimitStrategy: 'NO_RESET',
        selectedDurationDays: 30,
        purchaseType: PurchaseType.UPGRADE,
        snapshotSource: 'ADMIN_TRANSACTION_DRAFT',
        pricing: { originalAmount: '8.00', finalAmount: '8.00', discountPercent: 0, discountSource: 'NONE' },
      },
      deviceTypes: [],
    });
    assert.equal(state.subscriptionCreateCalls, 0);
    assert.equal(state.providerCalls, 0);
  });

  it('reuses an existing pending draft for the same quote context', async () => {
    const existingPlanSnapshot = {
      id: 'plan-1',
      name: 'Starter',
      tag: null,
      type: 'BOTH',
      trafficLimit: 1024,
      deviceLimit: 1,
      trafficLimitStrategy: 'NO_RESET',
      selectedDurationDays: 30,
      purchaseType: PurchaseType.NEW,
      snapshotSource: 'ADMIN_TRANSACTION_DRAFT',
      pricing: { originalAmount: '8.00', finalAmount: '8.00', discountPercent: 0, discountSource: 'NONE' },
    };
    const { service, state } = createService({
      quoteResult: createEligibleQuote(),
      existingTransactions: [
        createStoredTransaction({
          id: 'transaction-existing',
          paymentId: 'payment-existing',
          purchaseType: PurchaseType.NEW,
          channel: PurchaseChannel.WEB,
          gatewayType: PaymentGatewayType.YOOKASSA,
          currency: Currency.USD,
          amount: '8.00',
          planSnapshot: existingPlanSnapshot,
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
    assert.equal(state.transactionCreateCalls.length, 0);
  });

  it('creates and lists finance correction notes with bounded audit metadata', async () => {
    const auditCalls: unknown[] = [];
    const noteRows = [
      {
        id: 'note-1',
        transactionId: 'transaction-1',
        note: 'finance note',
        idempotencyKey: 'note-key-1',
        createdAt: new Date('2026-04-24T12:00:00.000Z'),
      },
    ];
    const service = new PaymentsTransactionsService(
      {
        $transaction: async <T>(callback: (transactionClient: unknown) => Promise<T>) => callback({
          adminPaymentCorrectionNote: {
            create: async (input: { readonly data: Record<string, unknown> }) => {
              assert.equal(input.data.note, 'finance note');
              assert.equal(input.data.idempotencyKey, 'note-key-1');
              return noteRows[0];
            },
          },
          adminAuditLog: {
            create: async (input: unknown) => {
              auditCalls.push(input);
            },
          },
        }),
        transaction: {
          findUnique: async () => ({ id: 'transaction-1' }),
        },
        adminPaymentCorrectionNote: {
          create: async () => { throw new Error('non-transactional adminPaymentCorrectionNote.create should not be used'); },
          findMany: async () => noteRows,
        },
        adminAuditLog: {
          create: async () => { throw new Error('non-transactional adminAuditLog.create should not be used'); },
        },
      } as never,
      {} as never,
      {} as never,
    );

    const created = await service.createCorrectionNote({
      transactionId: 'transaction-1',
      adminUserId: 'admin-1',
      dto: { note: ' finance note ', idempotencyKey: 'note-key-1' } as CreatePaymentCorrectionNoteDto,
    });
    const history = await service.listCorrectionNotes('transaction-1');

    assert.equal(created.id, 'note-1');
    assert.equal(history.items.length, 1);
    assert.equal(auditCalls.length, 1);
    assert.equal(JSON.stringify(auditCalls).includes('CREATE_PAYMENT_CORRECTION_NOTE'), true);
    assert.equal(JSON.stringify(auditCalls).includes('finance note'), false);
  });

  it('creates and lists dispute records with bounded audit metadata', async () => {
    const auditCalls: unknown[] = [];
    const disputeRows = [
      {
        id: 'dispute-1',
        transactionId: 'transaction-1',
        status: 'OPEN',
        reason: 'chargeback opened',
        providerCaseId: 'case-1',
        idempotencyKey: 'dispute-key-1',
        createdAt: new Date('2026-04-24T12:00:00.000Z'),
      },
    ];
    const service = new PaymentsTransactionsService(
      {
        $transaction: async <T>(callback: (transactionClient: unknown) => Promise<T>) => callback({
          adminPaymentDisputeRecord: {
            create: async (input: { readonly data: Record<string, unknown> }) => {
              assert.equal(input.data.reason, 'chargeback opened');
              assert.equal(input.data.providerCaseId, 'case-1');
              return disputeRows[0];
            },
          },
          adminAuditLog: { create: async (input: unknown) => auditCalls.push(input) },
        }),
        transaction: { findUnique: async () => ({ id: 'transaction-1' }) },
        adminPaymentDisputeRecord: {
          create: async () => { throw new Error('non-transactional adminPaymentDisputeRecord.create should not be used'); },
          findMany: async () => disputeRows,
        },
        adminAuditLog: { create: async () => { throw new Error('non-transactional adminAuditLog.create should not be used'); } },
      } as never,
      {} as never,
      {} as never,
    );

    const created = await service.createDisputeRecord({
      transactionId: 'transaction-1',
      adminUserId: 'admin-1',
      dto: { reason: ' chargeback opened ', providerCaseId: 'case-1', idempotencyKey: 'dispute-key-1' } as CreatePaymentDisputeRecordDto,
    });
    const history = await service.listDisputeRecords('transaction-1');

    assert.equal(created.id, 'dispute-1');
    assert.equal(history.items.length, 1);
    assert.equal(auditCalls.length, 1);
    assert.equal(JSON.stringify(auditCalls).includes('CREATE_PAYMENT_DISPUTE_RECORD'), true);
    assert.equal(JSON.stringify(auditCalls).includes('chargeback opened'), false);
  });

  it('creates and lists reconciliation exceptions with bounded audit metadata', async () => {
    const auditCalls: unknown[] = [];
    const rows = [
      {
        id: 'reconciliation-1',
        transactionId: 'transaction-1',
        type: 'AMOUNT_MISMATCH',
        status: 'OPEN',
        reason: 'amount differs',
        evidence: { noteProvided: true },
        idempotencyKey: 'recon-key-1',
        createdAt: new Date('2026-04-24T12:00:00.000Z'),
      },
    ];
    const service = new PaymentsTransactionsService(
      {
        $transaction: async <T>(callback: (transactionClient: unknown) => Promise<T>) => callback({
          adminPaymentReconciliationException: {
            create: async (input: { readonly data: Record<string, unknown> }) => {
              assert.equal(input.data.type, 'AMOUNT_MISMATCH');
              assert.equal(input.data.reason, 'amount differs');
              assert.deepEqual(input.data.evidence, { noteProvided: true });
              return rows[0];
            },
          },
          adminAuditLog: { create: async (input: unknown) => auditCalls.push(input) },
        }),
        transaction: { findUnique: async () => ({ id: 'transaction-1' }) },
        adminPaymentReconciliationException: {
          create: async () => { throw new Error('non-transactional adminPaymentReconciliationException.create should not be used'); },
          findMany: async () => rows,
        },
        adminAuditLog: { create: async () => { throw new Error('non-transactional adminAuditLog.create should not be used'); } },
      } as never,
      {} as never,
      {} as never,
    );

    const created = await service.createReconciliationException({
      transactionId: 'transaction-1',
      adminUserId: 'admin-1',
      dto: { type: 'AMOUNT_MISMATCH', reason: ' amount differs ', evidence: 'provider says 10', idempotencyKey: 'recon-key-1' } as CreatePaymentReconciliationExceptionDto,
    });
    const history = await service.listReconciliationExceptions('transaction-1');

    assert.equal(created.id, 'reconciliation-1');
    assert.equal(history.items.length, 1);
    assert.equal(auditCalls.length, 1);
    assert.equal(JSON.stringify(auditCalls).includes('CREATE_PAYMENT_RECONCILIATION_EXCEPTION'), true);
    assert.equal(JSON.stringify(auditCalls).includes('"evidenceProvided":true'), true);
    assert.equal(JSON.stringify(auditCalls).includes('amount differs'), false);
  });

  it('creates and lists planned amount/status correction requests without executing them', async () => {
    const auditCalls: unknown[] = [];
    const rows = [
      {
        id: 'correction-request-1',
        transactionId: 'transaction-1',
        type: 'ADJUST_AMOUNT',
        requestedAmount: '12.50',
        requestedStatus: null,
        reason: 'amount mismatch',
        idempotencyKey: 'correction-1',
        status: 'PLANNED',
        executionEnabled: false,
        createdAt: new Date('2026-04-24T12:00:00.000Z'),
      },
    ];
    const service = new PaymentsTransactionsService(
      {
        $transaction: async <T>(callback: (transactionClient: unknown) => Promise<T>) => callback({
          adminPaymentCorrectionRequest: {
            create: async (input: { readonly data: Record<string, unknown> }) => {
              assert.equal(input.data.type, 'ADJUST_AMOUNT');
              assert.equal(String(input.data.requestedAmount), '12.5');
              return rows[0];
            },
          },
          adminAuditLog: { create: async (input: unknown) => auditCalls.push(input) },
        }),
        transaction: { findUnique: async () => ({ id: 'transaction-1' }) },
        adminPaymentCorrectionRequest: {
          create: async () => { throw new Error('non-transactional adminPaymentCorrectionRequest.create should not be used'); },
          findMany: async () => rows,
        },
        adminAuditLog: { create: async () => { throw new Error('non-transactional adminAuditLog.create should not be used'); } },
      } as never,
      {} as never,
      {} as never,
    );

    const created = await service.createCorrectionRequest({
      transactionId: 'transaction-1',
      adminUserId: 'admin-1',
      dto: { type: 'ADJUST_AMOUNT', requestedAmount: '12.50', reason: ' amount mismatch ', idempotencyKey: 'correction-1' } as never,
    });
    const history = await service.listCorrectionRequests('transaction-1');

    assert.equal(created.id, 'correction-request-1');
    assert.equal(created.executionEnabled, false);
    assert.equal(history.items.length, 1);
    assert.equal(auditCalls.length, 1);
    assert.equal(JSON.stringify(auditCalls).includes('CREATE_PAYMENT_CORRECTION_REQUEST'), true);
    assert.equal(JSON.stringify(auditCalls).includes('amount mismatch'), false);
  });

  it('builds correction request readiness without enabling execution', async () => {
    const row = {
      id: 'correction-request-1',
      transactionId: 'transaction-1',
      type: 'ADJUST_AMOUNT',
      requestedAmount: '12.50',
      requestedStatus: null,
      reason: 'amount mismatch',
      idempotencyKey: 'correction-1',
      status: 'PLANNED',
      executionEnabled: false,
      createdAt: new Date('2026-04-24T12:00:00.000Z'),
    };
    const service = new PaymentsTransactionsService(
      {
        adminPaymentCorrectionRequest: {
          findFirst: async (input: unknown) => {
            assert.deepStrictEqual(input, { where: { id: 'correction-request-1', transactionId: 'transaction-1' } });
            return row;
          },
        },
      } as never,
      {} as never,
      {} as never,
    );

    const readiness = await service.getCorrectionRequestReadiness('transaction-1', 'correction-request-1');

    assert.equal(readiness.id, 'correction-request-1');
    assert.equal(readiness.executionEnabled, false);
    assert.deepStrictEqual(readiness.checks.map((check) => check.code), ['REQUEST_PLANNED', 'REASON_CAPTURED', 'ADJUST_AMOUNT_TARGET_CAPTURED', 'EXECUTOR_NOT_IMPLEMENTED']);
  });

  it('executes ADJUST_AMOUNT correction requests and records audit', async () => {
    const auditCalls: unknown[] = [];
    const updateCalls: unknown[] = [];
    const service = new PaymentsTransactionsService(
      {
        $transaction: async <T>(callback: (transactionClient: unknown) => Promise<T>) =>
          callback({
            transaction: {
              update: async (input: unknown) => {
                updateCalls.push(['transaction.update', input]);
              },
            },
            adminPaymentCorrectionRequest: {
              update: async (input: unknown) => {
                updateCalls.push(['request.update', input]);
              },
            },
            adminAuditLog: { create: async (input: unknown) => auditCalls.push(input) },
          }),
        adminPaymentCorrectionRequest: {
          findFirst: async () => ({
            id: 'correction-request-1',
            transactionId: 'transaction-1',
            type: 'ADJUST_AMOUNT',
            requestedAmount: { toString: () => '12.50' },
            requestedStatus: null,
            reason: 'amount mismatch',
            idempotencyKey: 'correction-1',
            status: 'PLANNED',
            executionEnabled: false,
            createdAt: new Date('2026-04-24T12:00:00.000Z'),
          }),
          update: async () => {
            throw new Error('non-transactional correction request update should not be used');
          },
        },
        transaction: {
          findUnique: async () => ({ id: 'transaction-1', amount: { toString: () => '10.00' } }),
          update: async () => {
            throw new Error('non-transactional transaction update should not be used');
          },
        },
        adminAuditLog: {
          create: async () => {
            throw new Error('non-transactional audit create should not be used');
          },
        },
      } as never,
      {} as never,
      {} as never,
    );

    const result = await service.executeCorrectionRequest({ transactionId: 'transaction-1', requestId: 'correction-request-1', adminUserId: 'admin-1' });

    assert.equal(result.status, 'EXECUTED');
    assert.equal(result.previousAmount, '10.00');
    assert.equal(result.newAmount, '12.50');
    assert.equal(updateCalls.length, 2);
    assert.equal(auditCalls.length, 1);
    assert.equal(JSON.stringify(auditCalls).includes('EXECUTE_PAYMENT_CORRECTION_REQUEST'), true);
  });

  it('keeps correction execution update, request status, and audit in one database transaction', async () => {
    const calls: unknown[] = [];
    const service = new PaymentsTransactionsService(
      {
        $transaction: async <T>(callback: (transactionClient: unknown) => Promise<T>) => {
          calls.push(['db.transaction.begin']);
          const result = await callback({
            transaction: {
              update: async (input: unknown) => {
                calls.push(['tx.transaction.update', input]);
              },
            },
            adminPaymentCorrectionRequest: {
              update: async (input: unknown) => {
                calls.push(['tx.request.update', input]);
              },
            },
            adminAuditLog: {
              create: async (input: unknown) => {
                calls.push(['tx.audit.create', input]);
              },
            },
          });
          calls.push(['db.transaction.commit']);
          return result;
        },
        adminPaymentCorrectionRequest: {
          findFirst: async () => ({
            id: 'correction-request-1',
            transactionId: 'transaction-1',
            type: 'ADJUST_AMOUNT',
            requestedAmount: { toString: () => '12.50' },
            requestedStatus: null,
            reason: 'amount mismatch',
            idempotencyKey: 'correction-1',
            status: 'PLANNED',
            executionEnabled: false,
            createdAt: new Date('2026-04-24T12:00:00.000Z'),
          }),
          update: async () => {
            throw new Error('root correction request update should not be used');
          },
        },
        transaction: {
          findUnique: async () => ({ id: 'transaction-1', amount: { toString: () => '10.00' } }),
          update: async () => {
            throw new Error('root transaction update should not be used');
          },
        },
        adminAuditLog: {
          create: async () => {
            throw new Error('root audit create should not be used');
          },
        },
      } as never,
      {} as never,
      {} as never,
    );

    const result = await service.executeCorrectionRequest({ transactionId: 'transaction-1', requestId: 'correction-request-1', adminUserId: 'admin-1' });

    assert.equal(result.status, 'EXECUTED');
    assert.deepStrictEqual(calls.map((call) => (Array.isArray(call) ? call[0] : 'unknown')), [
      'db.transaction.begin',
      'tx.transaction.update',
      'tx.request.update',
      'tx.audit.create',
      'db.transaction.commit',
    ]);
  });

  it('blocks non-ADJUST_AMOUNT correction execution', async () => {
    const service = new PaymentsTransactionsService(
      {
        adminPaymentCorrectionRequest: {
          findFirst: async () => ({
            id: 'correction-request-2',
            transactionId: 'transaction-1',
            type: 'MARK_COMPLETED',
            requestedAmount: null,
            requestedStatus: 'COMPLETED',
            reason: 'manual completion',
            idempotencyKey: 'correction-2',
            status: 'PLANNED',
            executionEnabled: false,
            createdAt: new Date('2026-04-24T12:00:00.000Z'),
          }),
        },
      } as never,
      {} as never,
      {} as never,
    );

    const result = await service.executeCorrectionRequest({ transactionId: 'transaction-1', requestId: 'correction-request-2', adminUserId: 'admin-1' });

    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.previousAmount, null);
    assert.equal(result.newAmount, null);
  });
});

function createService(input: {
  readonly quoteResult: QuoteResult;
  readonly existingTransactions?: readonly ReturnType<typeof createStoredTransaction>[];
  readonly userDiscounts?: { readonly purchaseDiscount: number; readonly personalDiscount: number };
}): {
  readonly service: PaymentsTransactionsService;
  readonly state: {
    readonly transactionCreateCalls: Record<string, unknown>[];
    readonly subscriptionCreateCalls: number;
    readonly providerCalls: number;
  };
} {
  const transactionCreateCalls: Record<string, unknown>[] = [];
  const existingTransactions = [...(input.existingTransactions ?? [])];
  const state = {
    transactionCreateCalls,
    subscriptionCreateCalls: 0,
    providerCalls: 0,
  };
  const prismaService = {
    transaction: {
      findMany: async () => existingTransactions,
      create: async (args: { readonly data: Record<string, unknown> }) => {
        transactionCreateCalls.push(args.data);
        return {
          id: 'transaction-1',
          paymentId: 'payment-1',
          userId: args.data.userId,
          subscriptionId: args.data.subscriptionId,
          status: args.data.status,
          purchaseType: args.data.purchaseType,
          channel: args.data.channel,
          gatewayType: args.data.gatewayType,
          currency: args.data.currency,
          amount: { toString: (): string => String(args.data.amount) },
          paymentAsset: null,
          gatewayId: null,
          planSnapshot: args.data.planSnapshot,
          createdAt: new Date('2026-04-19T12:00:00.000Z'),
          updatedAt: new Date('2026-04-19T12:00:00.000Z'),
        };
      },
    },
    user: {
      findUnique: async () => input.userDiscounts ?? { purchaseDiscount: 0, personalDiscount: 0 },
    },
  };
  const quoteService = {
    getQuote: async () => input.quoteResult,
  };
  const paymentDraftEntitlementGateService = {
    evaluateCheckoutDraftEntitlement: (quote: QuoteResult) => {
      const blockingWarnings = quote.warnings.filter((warning) =>
        [
          'SOURCE_SUBSCRIPTION_REQUIRED',
          'SOURCE_PLAN_MISSING',
          'TRIAL_UPGRADE_REQUIRED',
        ].includes(warning.code),
      );
      return {
        isAllowed: blockingWarnings.length === 0,
        blockingWarnings,
      };
    },
  };
  return {
    service: new PaymentsTransactionsService(
      prismaService as never,
      quoteService as never,
      paymentDraftEntitlementGateService as never,
    ),
    state,
  };
}

function createEligibleQuote() {
  return {
    userId: 'user-1',
    purchaseType: PurchaseType.NEW,
    channel: PurchaseChannel.WEB,
    isEligible: true,
    selectedSubscriptionId: null,
    selectedPlan: {
      id: 'plan-1',
      name: 'Starter',
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

interface QuoteResult {
  userId: string;
  purchaseType: PurchaseType;
  channel: PurchaseChannel;
  isEligible: boolean;
  selectedSubscriptionId: string | null;
  selectedPlan: {
    id: string;
    name: string;
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

function createStoredTransaction(input: {
  readonly id: string;
  readonly paymentId: string;
  readonly purchaseType: PurchaseType;
  readonly channel: PurchaseChannel;
  readonly gatewayType: PaymentGatewayType;
  readonly currency: Currency;
  readonly amount: string;
  readonly planSnapshot: Record<string, unknown>;
}) {
  return {
    id: input.id,
    paymentId: input.paymentId,
    userId: 'user-1',
    subscriptionId: null,
    status: TransactionStatus.PENDING,
    purchaseType: input.purchaseType,
    channel: input.channel,
    gatewayType: input.gatewayType,
    currency: input.currency,
    amount: { toString: (): string => input.amount },
    paymentAsset: null,
    gatewayId: null,
    planSnapshot: input.planSnapshot,
    createdAt: new Date('2026-04-19T12:00:00.000Z'),
    updatedAt: new Date('2026-04-19T12:00:00.000Z'),
  };
}
