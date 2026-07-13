import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConflictException, NotFoundException } from '@nestjs/common';

import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';

type Target = {
  id: string;
  subscriptionId: string;
  status: 'SCHEDULED' | 'ACTIVE' | 'ENDED';
  generation: number;
  startsAt: Date;
  subscriptionStatus?: 'ACTIVE' | 'DELETED';
};

function build(options?: {
  lockRows?: unknown[];
  latestGeneration?: number | null;
  target?: Target | null;
  nextScheduled?: { id: string; generation: number; startsAt: Date } | null;
  activeGeneration?: number | null;
  parentStatus?: 'ACTIVE' | 'DELETED';
  updateCounts?: number[];
}) {
  const order: string[] = [];
  const creates: unknown[] = [];
  const updates: unknown[] = [];
  const tx = {
    $queryRaw: async () => {
      order.push('lock');
      if (options?.lockRows !== undefined) return options.lockRows;
      if (options?.target !== undefined) return options.target === null ? [] : [{ ...options.target, subscriptionStatus: 'ACTIVE' }];
      return [{ id: 'sub-1', status: options?.parentStatus ?? 'ACTIVE' }];
    },
    subscriptionTerm: {
      findFirst: async (args: { where?: { status?: string } }) => {
        if (args.where?.status === 'SCHEDULED') {
          order.push('next');
          return options?.nextScheduled ?? null;
        }
        if (args.where?.status === 'ACTIVE') {
          order.push('active');
          return options?.activeGeneration == null ? null : { generation: options.activeGeneration };
        }
        order.push('latest');
        return options?.latestGeneration == null ? null : { generation: options.latestGeneration };
      },
      create: async (args: unknown) => {
        order.push('create');
        creates.push(args);
        const generation = (args as { data: { generation: number } }).data.generation;
        return { id: 'term-new', generation, status: 'SCHEDULED' };
      },
      updateMany: async (args: unknown) => {
        const where = (args as { where: Record<string, unknown> }).where;
        order.push(where.status === 'ACTIVE' ? 'end-old' : 'activate');
        updates.push(args);
        return { count: options?.updateCounts?.shift() ?? 1 };
      },
    },
  };

  return { service: new SubscriptionTermService(), tx, order, creates, updates };
}

const termInput = {
  subscriptionId: 'sub-1',
  planId: 'plan-1',
  planRevision: 7,
  planSnapshot: { name: 'Pro', trafficLimit: 100 },
  startsAt: new Date('2026-08-01T00:00:00.000Z'),
  endsAt: new Date('2026-09-01T00:00:00.000Z'),
  baseTrafficLimitBytes: 100_000n,
  baseDeviceLimit: 3,
  trafficResetStrategy: 'MONTH' as const,
  resetAnchorAt: new Date('2026-08-01T00:00:00.000Z'),
};
const dueAt = new Date('2026-08-01T00:00:00.000Z');
const target: Target = {
  id: 'term-2', subscriptionId: 'sub-1', status: 'SCHEDULED', generation: 2, startsAt: dueAt,
};

describe('SubscriptionTermService.createScheduledInTransaction', () => {
  it('locks the parent before allocating the next monotonic generation', async () => {
    const { service, tx, order, creates } = build({ latestGeneration: 2 });
    assert.deepEqual(await service.createScheduledInTransaction(tx as never, termInput), {
      id: 'term-new', generation: 3, status: 'SCHEDULED',
    });
    assert.deepEqual(order, ['lock', 'latest', 'create']);
    assert.equal((creates[0] as { data: { generation: number } }).data.generation, 3);
  });

  it('rejects scheduling a term for a deleted subscription', async () => {
    const fixture = build({ parentStatus: 'DELETED' });
    await assert.rejects(
      () => fixture.service.createScheduledInTransaction(fixture.tx as never, termInput),
      (error: unknown) => error instanceof ConflictException,
    );
  });

  it('starts at one and rejects a missing parent', async () => {
    const first = build({ latestGeneration: null });
    await first.service.createScheduledInTransaction(first.tx as never, termInput);
    assert.equal((first.creates[0] as { data: { generation: number } }).data.generation, 1);

    const missing = build({ lockRows: [] });
    await assert.rejects(
      () => missing.service.createScheduledInTransaction(missing.tx as never, termInput),
      (error: unknown) => error instanceof NotFoundException,
    );
  });
});

describe('SubscriptionTermService.activateInTransaction', () => {
  it('locks, validates next generation, ends old active, then activates target', async () => {
    const fixture = build({
      target,
      nextScheduled: { id: 'term-2', generation: 2, startsAt: dueAt },
      activeGeneration: 1,
    });
    assert.deepEqual(
      await fixture.service.activateInTransaction(fixture.tx as never, 'term-2', dueAt),
      { id: 'term-2', status: 'ACTIVE', changed: true },
    );
    assert.deepEqual(fixture.order, ['lock', 'next', 'active', 'end-old', 'activate']);
    assert.deepEqual((fixture.updates[0] as { where: unknown }).where, {
      subscriptionId: 'sub-1', status: 'ACTIVE', id: { not: 'term-2' },
    });
  });

  it('is idempotent for an already active target', async () => {
    const fixture = build({ target: { ...target, id: 'term-1', status: 'ACTIVE', generation: 1 } });
    assert.deepEqual(
      await fixture.service.activateInTransaction(fixture.tx as never, 'term-1', dueAt),
      { id: 'term-1', status: 'ACTIVE', changed: false },
    );
    assert.deepEqual(fixture.order, ['lock']);
  });

  it('rejects activation when the locked subscription is deleted', async () => {
    const fixture = build({
      lockRows: [{ ...target, status: 'SCHEDULED', subscriptionStatus: 'DELETED' }],
    });
    await assert.rejects(
      () => fixture.service.activateInTransaction(fixture.tx as never, 'term-2', dueAt),
      (error: unknown) => error instanceof ConflictException,
    );
  });

  it('rejects missing, non-scheduled and stale-claim targets', async () => {
    const missing = build({ target: null });
    await assert.rejects(
      () => missing.service.activateInTransaction(missing.tx as never, 'missing', dueAt),
      (error: unknown) => error instanceof NotFoundException,
    );

    const ended = build({ target: { ...target, status: 'ENDED' } });
    await assert.rejects(
      () => ended.service.activateInTransaction(ended.tx as never, 'term-2', dueAt),
      (error: unknown) => error instanceof ConflictException,
    );

    const stale = build({
      target,
      nextScheduled: { id: 'term-2', generation: 2, startsAt: dueAt },
      activeGeneration: 1,
      updateCounts: [1, 0],
    });
    await assert.rejects(
      () => stale.service.activateInTransaction(stale.tx as never, 'term-2', dueAt),
      (error: unknown) => error instanceof ConflictException,
    );
  });

  it('rejects a future, skipped, or non-increasing generation', async () => {
    const futureAt = new Date('2026-08-02T00:00:00.000Z');
    const future = build({
      target: { ...target, startsAt: futureAt },
      nextScheduled: { id: 'term-2', generation: 2, startsAt: futureAt },
      activeGeneration: 1,
    });
    await assert.rejects(
      () => future.service.activateInTransaction(future.tx as never, 'term-2', dueAt),
      (error: unknown) => error instanceof ConflictException,
    );

    const skipped = build({
      target: { ...target, id: 'term-3', generation: 3 },
      nextScheduled: { id: 'term-2', generation: 2, startsAt: dueAt },
      activeGeneration: 1,
    });
    await assert.rejects(
      () => skipped.service.activateInTransaction(skipped.tx as never, 'term-3', dueAt),
      (error: unknown) => error instanceof ConflictException,
    );

    const nonIncreasing = build({
      target,
      nextScheduled: { id: 'term-2', generation: 2, startsAt: dueAt },
      activeGeneration: 2,
    });
    await assert.rejects(
      () => nonIncreasing.service.activateInTransaction(nonIncreasing.tx as never, 'term-2', dueAt),
      (error: unknown) => error instanceof ConflictException,
    );
  });
});
