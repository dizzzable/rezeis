import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SavedPaymentMethodService } from '../src/modules/payments/services/saved-payment-method.service';

describe('SavedPaymentMethodService.upsertFromYookassaPayment ownership', () => {
  it('refuses to rebind a provider method owned by another user', async () => {
    const updates: unknown[] = [];
    const creates: unknown[] = [];
    const existing = {
      id: 'method-1',
      userId: 'user-owner',
      sourceTransactionId: 'tx-old',
      sourceGatewayId: 'gw-old',
    };
    const prisma = {
      savedPaymentMethod: {
        findUnique: async () => existing,
        update: async (args: unknown) => {
          updates.push(args);
          return existing;
        },
        create: async (args: unknown) => {
          creates.push(args);
          return args;
        },
      },
    };
    const service = new SavedPaymentMethodService(
      prisma as never,
      { info: () => undefined } as never,
    );

    await service.upsertFromYookassaPayment({
      userId: 'user-other',
      transactionId: 'tx-new',
      gatewayId: 'gw-new',
      rawPayload: {
        object: {
          payment_method: {
            id: 'pm-shared',
            saved: true,
            type: 'bank_card',
            title: 'Card',
            card: { last4: '4242' },
          },
        },
      },
    });

    assert.equal(updates.length, 0);
    assert.equal(creates.length, 0);
  });

  it('reactivates the same user method after unbind', async () => {
    const updates: Array<{ data: Record<string, unknown> }> = [];
    const existing = {
      id: 'method-1',
      userId: 'user-1',
      sourceTransactionId: 'tx-old',
      sourceGatewayId: 'gw-old',
    };
    const prisma = {
      savedPaymentMethod: {
        findUnique: async () => existing,
        update: async (args: { data: Record<string, unknown> }) => {
          updates.push(args);
          return { ...existing, ...args.data };
        },
        create: async () => {
          throw new Error('create must not be called');
        },
      },
    };
    const service = new SavedPaymentMethodService(
      prisma as never,
      { info: () => undefined } as never,
    );

    await service.upsertFromYookassaPayment({
      userId: 'user-1',
      transactionId: 'tx-new',
      gatewayId: 'gw-new',
      rawPayload: {
        object: {
          payment_method: {
            id: 'pm-1',
            saved: true,
            type: 'bank_card',
            title: 'Card',
            card: { last4: '1111' },
          },
        },
      },
    });

    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.data.isActive, true);
    assert.equal(updates[0]?.data.unboundAt, null);
    assert.equal(updates[0]?.data.userId, undefined);
  });
});
