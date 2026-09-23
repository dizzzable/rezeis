import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { Logger } from '@nestjs/common';
import { PaymentGatewayType, ProviderSubscriptionStatus } from '@prisma/client';
import { of, throwError } from 'rxjs';

import {
  ProviderSubscriptionService,
  STRANDED_SWEEP_PAGE,
} from '../src/modules/payments/services/provider-subscription.service';

/**
 * The stranded sweep reads EVERY live provider subscription (R3-support-money
 * laterList 1).
 *
 * It read the oldest 500 once. The oldest are exactly the rows that stay: the
 * healthy ones it leaves alone, and the stranded ones the provider will not
 * cancel. Once 500 of those piled up, nothing behind them was looked at again,
 * and a blocked customer's autopay went on charging. The store below honours
 * the query the way PostgreSQL does — status filter, the (`createdAt`, `id`)
 * cursor, the order and `take` — so it cannot read more than it is asked for.
 * `provider-subscriptions-postgres.spec.ts` repeats this on PostgreSQL.
 */

interface Row {
  id: string;
  userId: string | null;
  gatewayType: PaymentGatewayType;
  providerSubscriptionId: string;
  status: ProviderSubscriptionStatus;
  subscriptionId: string | null;
  firstTransactionId: string;
  planId: string;
  createdAt: Date;
}

const OLDEST = new Date('2026-01-01T00:00:00.000Z');

type Cursor = { createdAt?: { gt?: Date } | Date; id?: { gt: string } };

function afterCursor(row: Row, branches: readonly Cursor[] | undefined): boolean {
  if (branches === undefined) return true;
  return branches.some((branch) => {
    if (branch.createdAt instanceof Date) {
      return row.createdAt.getTime() === branch.createdAt.getTime() && row.id > (branch.id?.gt ?? '');
    }
    return branch.createdAt?.gt !== undefined && row.createdAt.getTime() > branch.createdAt.gt.getTime();
  });
}

function world(rows: Row[]) {
  const blocked = new Set(['blocked-user']);
  const reads: number[] = [];
  const prisma = {
    providerSubscription: {
      findMany: async (query: {
        where: { status: { in: ProviderSubscriptionStatus[] }; OR?: Cursor[] };
        orderBy: Array<Record<string, 'asc' | 'desc'>>;
        take: number;
      }) => {
        assert.deepEqual(query.orderBy, [{ createdAt: 'asc' }, { id: 'asc' }], 'a cursor needs a total order');
        const page = rows
          .filter((row) => query.where.status.in.includes(row.status) && afterCursor(row, query.where.OR))
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || (left.id < right.id ? -1 : 1))
          .slice(0, query.take)
          .map((row) => ({ ...row, user: row.userId === null ? null : { isBlocked: blocked.has(row.userId) } }));
        reads.push(page.length);
        return page;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((candidate) => candidate.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    subscription: { findMany: async () => [] },
    transaction: { findMany: async () => [] },
    paymentGateway: {
      findUnique: async () => ({ type: PaymentGatewayType.PLATEGA, settings: { merchantId: 'm-1', secret: 's-1' } }),
    },
  };
  // A provider that refuses to cancel the stuck ones, for good.
  const http = {
    post: (url: string) =>
      url.includes('/stuck-') ? throwError(() => new Error('provider refused')) : of({ data: { status: 'cancelled' } }),
  };
  const service = new ProviderSubscriptionService(prisma as never, http as never, {} as never, {} as never);
  return { service, rows, reads };
}

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    userId: 'blocked-user',
    gatewayType: PaymentGatewayType.PLATEGA,
    providerSubscriptionId: id,
    status: ProviderSubscriptionStatus.ACTIVE,
    subscriptionId: null,
    firstTransactionId: `${id}-first`,
    planId: 'plan-1',
    createdAt: OLDEST,
    ...overrides,
  };
}

describe('the stranded sweep', () => {
  it('reaches a stranded row behind more than a page of rows it cannot change', async () => {
    mock.method(Logger.prototype, 'error', () => undefined);
    mock.method(Logger.prototype, 'log', () => undefined);
    const stuck = Array.from({ length: STRANDED_SWEEP_PAGE + 20 }, (_, index) =>
      row(`stuck-${String(index).padStart(4, '0')}`),
    );
    // Healthy: a live customer whose sign-up has not been paid yet, which the
    // sweep leaves alone — the other kind of row that stays in the head.
    const healthy = Array.from({ length: 30 }, (_, index) =>
      row(`healthy-${String(index).padStart(4, '0')}`, { userId: 'live-user' }),
    );
    // Created in the same instant as every stuck row: the page boundary falls
    // inside one `createdAt`, and only the id carries the cursor past it.
    const last = row('zz-last');
    const w = world([...stuck, ...healthy, last]);

    const cancelled = await w.service.cancelStranded();

    assert.equal(cancelled, 1);
    assert.equal(last.status, ProviderSubscriptionStatus.CANCELLED, 'the row behind the stuck ones was never reached');
    assert.ok(stuck.every((candidate) => candidate.status === ProviderSubscriptionStatus.ACTIVE));
    assert.ok(healthy.every((candidate) => candidate.status === ProviderSubscriptionStatus.ACTIVE));
    // Every row read once: two pages, the second one short.
    assert.deepEqual(w.reads, [STRANDED_SWEEP_PAGE, stuck.length + healthy.length + 1 - STRANDED_SWEEP_PAGE]);
    mock.restoreAll();
  });

  it('asks once when everything fits in a page', async () => {
    mock.method(Logger.prototype, 'log', () => undefined);
    const w = world([row('blocked-1')]);

    assert.equal(await w.service.cancelStranded(), 1);
    assert.deepEqual(w.reads, [1]);
    mock.restoreAll();
  });

  it('reads a page it has already filled once more, and stops on the empty one', async () => {
    // Exactly a page: the only way to know nothing follows is to ask.
    mock.method(Logger.prototype, 'error', () => undefined);
    const w = world(Array.from({ length: STRANDED_SWEEP_PAGE }, (_, index) => row(`stuck-${String(index).padStart(4, '0')}`)));

    assert.equal(await w.service.cancelStranded(), 0);
    assert.deepEqual(w.reads, [STRANDED_SWEEP_PAGE, 0]);
    mock.restoreAll();
  });
});
