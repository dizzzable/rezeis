import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { AddOnsStatsService } from '../src/modules/add-ons/services/add-ons-stats.service';

function txRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    userId: `user-${id}`,
    amount: new Prisma.Decimal('2.50'),
    currency: 'USD',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    user: { name: `U${id}`, username: null, telegramId: null },
    ...overrides,
  };
}

function build(rows: Array<Record<string, unknown>>, entitlements: Array<{ sourceTransactionId: string; state: string }>) {
  const prisma = {
    transaction: { findMany: async () => rows },
    addOnEntitlement: { findMany: async () => entitlements },
  };
  return new AddOnsStatsService(prisma as never);
}

describe('AddOnsStatsService deliveryBreakdown (T-012)', () => {
  it('classifies each purchase by its linked entitlement state', async () => {
    const rows = [txRow('t1'), txRow('t2'), txRow('t3'), txRow('t4'), txRow('t5'), txRow('t6')];
    const entitlements = [
      { sourceTransactionId: 't1', state: 'PENDING_ACTIVATION' },
      { sourceTransactionId: 't2', state: 'ACTIVE' },
      { sourceTransactionId: 't3', state: 'EXPIRED' },
      { sourceTransactionId: 't4', state: 'REVERSED' },
      { sourceTransactionId: 't5', state: 'REMEDIATION_REQUIRED' },
      // t6 has no entitlement → UNKNOWN_ADDITIONAL (legacy top-up)
    ];
    const service = build(rows, entitlements);
    const result = await service.getStats({});
    assert.deepEqual(result.deliveryBreakdown, {
      UNKNOWN_ADDITIONAL: 1,
      COMMITTED: 1,
      ACTIVE: 1,
      EXPIRED: 1,
      REVERSED: 1,
      REMEDIATION_REQUIRED: 1,
    });
  });

  it('maps EXPIRING to the EXPIRED bucket', async () => {
    const service = build([txRow('t1')], [{ sourceTransactionId: 't1', state: 'EXPIRING' }]);
    const result = await service.getStats({});
    assert.equal(result.deliveryBreakdown.EXPIRED, 1);
  });

  it('returns an all-zero breakdown when there are no purchases', async () => {
    const service = build([], []);
    const result = await service.getStats({});
    assert.deepEqual(result.deliveryBreakdown, {
      UNKNOWN_ADDITIONAL: 0,
      COMMITTED: 0,
      ACTIVE: 0,
      EXPIRED: 0,
      REVERSED: 0,
      REMEDIATION_REQUIRED: 0,
    });
  });
});
