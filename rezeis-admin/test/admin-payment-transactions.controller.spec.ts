import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AdminPaymentTransactionsController } from '../src/modules/payments/controllers/admin-payment-transactions.controller';
import { CreateRefundRequestDto } from '../src/modules/payments/dto/create-refund-request.dto';
import { PaymentsCheckoutService } from '../src/modules/payments/services/payments-checkout.service';
import { PaymentsTransactionsService } from '../src/modules/payments/services/payments-transactions.service';

describe('AdminPaymentTransactionsController refund routes', () => {
  it('delegates refund lifecycle endpoints with bounded params and admin context', async () => {
    const calls: unknown[] = [];
    const transactionsService = {
      getRefundReadiness: async (transactionId: string) => {
        calls.push(['readiness', transactionId]);
        return { transactionId };
      },
      createRefundRequest: async (input: unknown) => {
        calls.push(['create', input]);
        return { requestId: 'request-1' };
      },
      listRefundRequests: async (transactionId: string) => {
        calls.push(['list', transactionId]);
        return { transactionId, items: [] };
      },
      getRefundRequestDetail: async (transactionId: string, requestId: string) => {
        calls.push(['detail', transactionId, requestId]);
        return { requestId };
      },
      getRefundRequestPreflight: async (transactionId: string, requestId: string) => {
        calls.push(['preflight', transactionId, requestId]);
        return { requestId, preflightReady: true };
      },
      executeRefundRequest: async (input: unknown) => {
        calls.push(['execute', input]);
        return { requestId: 'request-1', status: 'REFUNDED' };
      },
      listRefundExecutionHistory: async (transactionId: string, requestId: string) => {
        calls.push(['executions', transactionId, requestId]);
        return { transactionId, requestId, items: [] };
      },
    } as unknown as PaymentsTransactionsService;
    const controller = new AdminPaymentTransactionsController(transactionsService, {} as PaymentsCheckoutService);
    const currentAdmin = { id: 'admin-1' } as Parameters<AdminPaymentTransactionsController['createRefundRequest']>[0];
    const dto = { reason: 'customer request', idempotencyKey: 'refund-1' } as CreateRefundRequestDto;

    await controller.getRefundReadiness('transaction-1');
    await controller.createRefundRequest(currentAdmin, 'transaction-1', dto);
    await controller.listRefundRequests('transaction-1');
    await controller.getRefundRequestDetail('transaction-1', 'request-1');
    await controller.getRefundRequestPreflight('transaction-1', 'request-1');
    await controller.executeRefundRequest(currentAdmin, 'transaction-1', 'request-1');
    await controller.listRefundExecutionHistory('transaction-1', 'request-1');

    assert.deepStrictEqual(calls, [
      ['readiness', 'transaction-1'],
      ['create', { transactionId: 'transaction-1', adminUserId: 'admin-1', dto }],
      ['list', 'transaction-1'],
      ['detail', 'transaction-1', 'request-1'],
      ['preflight', 'transaction-1', 'request-1'],
      ['execute', { transactionId: 'transaction-1', requestId: 'request-1', adminUserId: 'admin-1' }],
      ['executions', 'transaction-1', 'request-1'],
    ]);
  });

  it('delegates manual correction policy and note endpoints', async () => {
    const calls: unknown[] = [];
    const transactionsService = {
      getManualCorrectionPolicy: () => {
        calls.push(['manual-policy']);
        return { mutationEnabled: false, correctionTypes: [] };
      },
      createCorrectionNote: async (input: unknown) => {
        calls.push(['create-note', input]);
        return { id: 'note-1' };
      },
      listCorrectionNotes: async (transactionId: string) => {
        calls.push(['list-notes', transactionId]);
        return { transactionId, items: [] };
      },
    } as unknown as PaymentsTransactionsService;
    const controller = new AdminPaymentTransactionsController(transactionsService, {} as PaymentsCheckoutService);
    const currentAdmin = { id: 'admin-1' } as Parameters<AdminPaymentTransactionsController['createCorrectionNote']>[0];

    await controller.getManualCorrectionPolicy();
    await controller.createCorrectionNote(currentAdmin, 'transaction-1', { note: 'finance note', idempotencyKey: 'note-1' });
    await controller.listCorrectionNotes('transaction-1');

    assert.deepStrictEqual(calls, [
      ['manual-policy'],
      ['create-note', { transactionId: 'transaction-1', adminUserId: 'admin-1', dto: { note: 'finance note', idempotencyKey: 'note-1' } }],
      ['list-notes', 'transaction-1'],
    ]);
  });

  it('delegates dispute record endpoints with admin context', async () => {
    const calls: unknown[] = [];
    const transactionsService = {
      createDisputeRecord: async (input: unknown) => {
        calls.push(['create-dispute', input]);
        return { id: 'dispute-1' };
      },
      listDisputeRecords: async (transactionId: string) => {
        calls.push(['list-disputes', transactionId]);
        return { transactionId, items: [] };
      },
    } as unknown as PaymentsTransactionsService;
    const controller = new AdminPaymentTransactionsController(transactionsService, {} as PaymentsCheckoutService);
    const currentAdmin = { id: 'admin-1' } as Parameters<AdminPaymentTransactionsController['createDisputeRecord']>[0];

    await controller.createDisputeRecord(currentAdmin, 'transaction-1', { reason: 'chargeback', providerCaseId: 'case-1', idempotencyKey: 'dispute-1' });
    await controller.listDisputeRecords('transaction-1');

    assert.deepStrictEqual(calls, [
      ['create-dispute', { transactionId: 'transaction-1', adminUserId: 'admin-1', dto: { reason: 'chargeback', providerCaseId: 'case-1', idempotencyKey: 'dispute-1' } }],
      ['list-disputes', 'transaction-1'],
    ]);
  });

  it('delegates reconciliation exception endpoints with admin context', async () => {
    const calls: unknown[] = [];
    const transactionsService = {
      createReconciliationException: async (input: unknown) => {
        calls.push(['create-reconciliation', input]);
        return { id: 'reconciliation-1' };
      },
      listReconciliationExceptions: async (transactionId: string) => {
        calls.push(['list-reconciliations', transactionId]);
        return { transactionId, items: [] };
      },
    } as unknown as PaymentsTransactionsService;
    const controller = new AdminPaymentTransactionsController(transactionsService, {} as PaymentsCheckoutService);
    const currentAdmin = { id: 'admin-1' } as Parameters<AdminPaymentTransactionsController['createReconciliationException']>[0];

    await controller.createReconciliationException(currentAdmin, 'transaction-1', { type: 'AMOUNT_MISMATCH', reason: 'amount differs', evidenceNote: 'provider note', idempotencyKey: 'recon-1' } as Parameters<AdminPaymentTransactionsController['createReconciliationException']>[2]);
    await controller.listReconciliationExceptions('transaction-1');

    assert.deepStrictEqual(calls, [
      ['create-reconciliation', { transactionId: 'transaction-1', adminUserId: 'admin-1', dto: { type: 'AMOUNT_MISMATCH', reason: 'amount differs', evidenceNote: 'provider note', idempotencyKey: 'recon-1' } }],
      ['list-reconciliations', 'transaction-1'],
    ]);
  });

  it('delegates amount/status correction request endpoints with admin context', async () => {
    const calls: unknown[] = [];
    const transactionsService = {
      createCorrectionRequest: async (input: unknown) => {
        calls.push(['create-correction-request', input]);
        return { id: 'correction-request-1' };
      },
      listCorrectionRequests: async (transactionId: string) => {
        calls.push(['list-correction-requests', transactionId]);
        return { transactionId, items: [] };
      },
      getCorrectionRequestReadiness: async (transactionId: string, requestId: string) => {
        calls.push(['correction-readiness', transactionId, requestId]);
        return { requestId, checks: [] };
      },
      executeCorrectionRequest: async (input: unknown) => {
        calls.push(['execute-correction-request', input]);
        return { status: 'EXECUTED' };
      },
    } as unknown as PaymentsTransactionsService;
    const controller = new AdminPaymentTransactionsController(transactionsService, {} as PaymentsCheckoutService);
    const currentAdmin = { id: 'admin-1' } as Parameters<AdminPaymentTransactionsController['createCorrectionRequest']>[0];

    await controller.createCorrectionRequest(currentAdmin, 'transaction-1', { type: 'ADJUST_AMOUNT', requestedAmount: '12.50', reason: 'amount mismatch', idempotencyKey: 'correction-1' } as Parameters<AdminPaymentTransactionsController['createCorrectionRequest']>[2]);
    await controller.listCorrectionRequests('transaction-1');
    await controller.getCorrectionRequestReadiness('transaction-1', 'correction-request-1');
    await controller.executeCorrectionRequest(currentAdmin, 'transaction-1', 'correction-request-1');

    assert.deepStrictEqual(calls, [
      ['create-correction-request', { transactionId: 'transaction-1', adminUserId: 'admin-1', dto: { type: 'ADJUST_AMOUNT', requestedAmount: '12.50', reason: 'amount mismatch', idempotencyKey: 'correction-1' } }],
      ['list-correction-requests', 'transaction-1'],
      ['correction-readiness', 'transaction-1', 'correction-request-1'],
      ['execute-correction-request', { transactionId: 'transaction-1', requestId: 'correction-request-1', adminUserId: 'admin-1' }],
    ]);
  });
});
