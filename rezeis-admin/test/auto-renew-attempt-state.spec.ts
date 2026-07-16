import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PurchaseType, TransactionStatus } from '@prisma/client';

import { AutoRenewService } from '../src/modules/auto-renew/auto-renew.service';

/**
 * Pins attempt accounting for autopay:
 * - PENDING + real gateway settle blocks retries
 * - PENDING + __RENEWAL_PROVIDER_CREATE__ claim is NOT in-flight settle
 * - FAILED attempts count toward the 3-attempt budget
 */
describe('AutoRenewService attempt state (claim vs settle)', () => {
  it('does not treat provider-create claim as pending settle', async () => {
    const subId = 'sub1';
    const expiresAtMs = 1_700_000_000_000;
    const rows = [
      {
        status: TransactionStatus.PENDING,
        idempotencyKey: `auto-renew:${subId}:${expiresAtMs}:a1`,
        checkoutUrl: null,
        gatewayId: `__RENEWAL_PROVIDER_CREATE__:pay1`,
      },
    ];

    const prisma = {
      transaction: {
        findMany: async (args: {
          where: { purchaseType: PurchaseType; idempotencyKey: { startsWith: string } };
        }) => {
          assert.equal(args.where.purchaseType, PurchaseType.RENEW);
          assert.equal(args.where.idempotencyKey.startsWith, `auto-renew:${subId}:${expiresAtMs}:`);
          return rows;
        },
      },
    };

    const service = new AutoRenewService(
      prisma as never,
      { create: async () => undefined } as never,
      { renewalCheckout: async () => ({ transactionStatus: TransactionStatus.FAILED }) } as never,
      { findPreferredForCharge: async () => null } as never,
    );

    // private method — access via bracket for unit pin
    const state = await (
      service as unknown as {
        readAttemptState: (
          id: string,
          ms: number,
        ) => Promise<{ usedAttempts: number; pending: boolean; completed: boolean }>;
      }
    ).readAttemptState(subId, expiresAtMs);

    assert.equal(state.usedAttempts, 1);
    assert.equal(state.pending, false);
    assert.equal(state.completed, false);
  });

  it('treats real off-session PENDING (no claim prefix) as pending', async () => {
    const subId = 'sub2';
    const expiresAtMs = 1_700_000_000_111;
    const prisma = {
      transaction: {
        findMany: async () => [
          {
            status: TransactionStatus.PENDING,
            idempotencyKey: `auto-renew:${subId}:${expiresAtMs}:a1`,
            checkoutUrl: null,
            gatewayId: 'yoo_real_payment_id',
          },
        ],
      },
    };

    const service = new AutoRenewService(
      prisma as never,
      { create: async () => undefined } as never,
      { renewalCheckout: async () => ({}) } as never,
      { findPreferredForCharge: async () => null } as never,
    );

    const state = await (
      service as unknown as {
        readAttemptState: (
          id: string,
          ms: number,
        ) => Promise<{ usedAttempts: number; pending: boolean; completed: boolean }>;
      }
    ).readAttemptState(subId, expiresAtMs);

    assert.equal(state.usedAttempts, 1);
    assert.equal(state.pending, true);
    assert.equal(state.completed, false);
  });
});
