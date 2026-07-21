import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PaymentGatewayType } from '@prisma/client';

import { SavedPaymentMethodService } from '../src/modules/payments/services/saved-payment-method.service';

describe('SavedPaymentMethodService.disableAutopayForProviderMethod', () => {
  it('disables autopay for a matching active method', async () => {
    const updates: Array<{ data: Record<string, unknown> }> = [];
    const method = {
      id: 'spm-1',
      userId: 'user-1',
      gatewayType: PaymentGatewayType.YOOKASSA,
      methodType: 'bank_card',
      cardLast4: '4444',
      providerMethodId: 'pm-revoked',
      isActive: true,
      autopayEnabled: true,
    };
    const prisma = {
      savedPaymentMethod: {
        findFirst: async () => method,
        update: async (args: { data: Record<string, unknown> }) => {
          updates.push(args);
          return { ...method, ...args.data };
        },
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          $queryRaw: async () => [{ id: method.id }],
          savedPaymentMethod: {
            findFirst: async () => method,
            update: async (args: { data: Record<string, unknown> }) => {
              updates.push(args);
              return { ...method, ...args.data };
            },
          },
        }),
    };
    const events: unknown[] = [];
    const service = new SavedPaymentMethodService(prisma as never, {
      warn: (...args: unknown[]) => {
        events.push(args);
      },
      info: () => undefined,
    } as never);

    const result = await service.disableAutopayForProviderMethod({
      providerMethodId: 'pm-revoked',
      reason: 'permission_revoked',
      userId: 'user-1',
    });

    assert.deepStrictEqual(result, { id: 'spm-1', autopayEnabled: false });
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.data['autopayEnabled'], false);
    assert.equal(events.length, 1);
  });

  it('returns null when method is already disabled or missing', async () => {
    const prisma = {
      savedPaymentMethod: {
        findFirst: async () => null,
      },
      $transaction: async () => {
        throw new Error('should not open a transaction');
      },
    };
    const service = new SavedPaymentMethodService(prisma as never, {
      warn: () => undefined,
      info: () => undefined,
    } as never);

    const result = await service.disableAutopayForProviderMethod({
      providerMethodId: 'pm-missing',
      reason: 'permission_revoked',
    });

    assert.equal(result, null);
  });
});
