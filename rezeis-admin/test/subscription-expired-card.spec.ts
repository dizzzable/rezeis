import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { AutoRenewService } from '../src/modules/auto-renew/auto-renew.service';

/**
 * «⌛ Подписка истекла» — registered, titled, tick-boxed, and raised by nobody
 * until 20.09.2026. It is raised HERE, where a row stops being ACTIVE, because
 * this is the only place that knows the moment: the customer's own «подписка
 * закончилась» notice is deduplicated per USER, so somebody whose two
 * subscriptions end the same night would have cost the operator one card for
 * two expiries.
 */

const PAST_DUE = new Date(Date.now() - 60 * 60 * 1000);

interface Raised {
  readonly type: string;
  readonly metadata: Record<string, unknown>;
}

function harness(rows: Array<{ id: string; userId: string; planSnapshot: unknown }>) {
  const statuses = new Map(rows.map((row) => [row.id, SubscriptionStatus.ACTIVE as SubscriptionStatus]));
  const raised: Raised[] = [];
  const reads: string[] = [];

  const prisma = {
    subscription: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        const where = args.where as {
          status?: SubscriptionStatus | { in?: SubscriptionStatus[] };
          id?: { in?: string[] };
        };
        // The read-back after the flip asks by id AND for EXPIRED rows; the
        // candidate read asks for ACTIVE rows with a past date.
        if (where.id?.in !== undefined) {
          reads.push('read-back');
          return rows
            .filter((row) => where.id?.in?.includes(row.id) === true)
            .filter((row) => statuses.get(row.id) === where.status)
            .map((row) => ({
              ...row,
              isTrial: false,
              expiresAt: PAST_DUE,
              remnawaveId: `rw-${row.id}`,
            }));
        }
        reads.push('candidates');
        return rows
          .filter((row) => statuses.get(row.id) === SubscriptionStatus.ACTIVE)
          .map((row) => ({ id: row.id, userId: row.userId, expiresAt: PAST_DUE, isTrial: false }));
      },
      updateMany: async (args: { where: { id: { in: string[] }; status: SubscriptionStatus } }) => {
        let count = 0;
        for (const id of args.where.id.in) {
          if (statuses.get(id) === args.where.status) {
            statuses.set(id, SubscriptionStatus.EXPIRED);
            count += 1;
          }
        }
        return { count };
      },
    },
    // No attempt rows: nothing was ever charged for this expiry epoch.
    transaction: { findMany: async () => [] },
  };

  const service = new AutoRenewService(
    prisma as never,
    { create: async () => undefined } as never,
    { renewalCheckout: async () => ({}) } as never,
    // No saved card, so the row expires rather than waiting for a retry.
    { findPreferredForCharge: async () => null } as never,
    {} as never,
    { requiresPlanSelection: async () => false } as never,
    {
      info: (type: string, _category: string, _message: string, metadata: Record<string, unknown>) => {
        raised.push({ type, metadata });
      },
    } as never,
  );

  return { service, raised, reads, statuses };
}

describe('«Подписка истекла»', () => {
  it('raises one card per subscription, with its plan', async () => {
    const { service, raised } = harness([
      { id: 'sub-1', userId: 'user-1', planSnapshot: { id: 'plan-1', name: 'Базовый' } },
      // The same owner, a second subscription: TWO cards, because the operator
      // is being told about subscriptions, not about people.
      { id: 'sub-2', userId: 'user-1', planSnapshot: { id: 'plan-2', name: 'Про' } },
    ]);

    const count = await service.markExpiredSubscriptions();

    assert.equal(count, 2);
    assert.deepStrictEqual(
      raised.map((event) => [event.type, event.metadata['subscriptionId'], event.metadata['planName']]),
      [
        ['subscription.expired', 'sub-1', 'Базовый'],
        ['subscription.expired', 'sub-2', 'Про'],
      ],
    );
    assert.equal(raised[0].metadata['userId'], 'user-1');
    assert.equal(raised[0].metadata['source'], 'AUTO_RENEW_SWEEP');
  });

  it('says nothing when nothing expired', async () => {
    const { service, raised, reads } = harness([]);

    assert.equal(await service.markExpiredSubscriptions(), 0);
    assert.deepStrictEqual(raised, []);
    // And no read-back either: an empty sweep costs one query, as before.
    assert.deepStrictEqual(reads, ['candidates']);
  });

  it('announces only what it actually flipped', async () => {
    // Somebody else expired the row between the candidate read and the write —
    // the `updateMany` counts it out, and the read-back must not hand the
    // operator a card for an expiry this sweep did not perform.
    const { service, raised, statuses } = harness([
      { id: 'sub-1', userId: 'user-1', planSnapshot: { name: 'Базовый' } },
    ]);
    statuses.set('sub-1', SubscriptionStatus.EXPIRED);

    assert.equal(await service.markExpiredSubscriptions(), 0);
    assert.deepStrictEqual(raised, []);
  });
});
