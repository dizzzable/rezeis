import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { _resetProcessRoleCacheForTests } from '../src/common/runtime/process-role.util';
import { PLAN_MIGRATION_BATCH_SIZE, PLAN_MIGRATION_IDLE_RETICK_MS } from '../src/modules/plans/migrations/plan-migration.constants';
import { describeMoveError } from '../src/modules/plans/migrations/plan-migration-move.service';
import { redactSyncError } from '../src/modules/plans/migrations/plan-migration-query.service';
import { PlanMigrationRunnerService } from '../src/modules/plans/migrations/plan-migration-runner.service';

/**
 * The runner's control flow without a database: batching, re-ticking, the
 * completion decision, restart recovery and the tolerated enqueue. The live
 * behaviour of the same paths is in `plan-migration-postgres.spec.ts`.
 */

interface FakeItem {
  id: string;
  status: 'PENDING' | 'MOVED' | 'SKIPPED' | 'FAILED';
}

function harness(options: {
  readonly items: FakeItem[];
  readonly runStatus?: 'QUEUED' | 'RUNNING' | 'COMPLETED';
  readonly outcomes?: (itemId: string) => 'MOVED' | 'NOOP';
  readonly staleRuns?: string[];
  readonly openRuns?: string[];
  readonly enqueueFails?: boolean;
}) {
  const run = { id: 'run-1', sourcePlanId: 'plan-p', status: options.runStatus ?? 'QUEUED', createdByAdminId: 'a', requestId: null, ipAddress: null, userAgent: null };
  const added: Array<{ readonly runId: string; readonly delay: number }> = [];
  const processed: string[] = [];
  const runUpdates: unknown[] = [];
  const prisma = {
    planMigrationRun: {
      findUnique: async () => ({ ...run }),
      updateMany: async (args: { where: { status?: unknown }; data: { status?: string } }) => {
        runUpdates.push(args);
        const wanted = args.where.status as string | { in?: string[]; not?: string } | undefined;
        const matches =
          wanted === undefined ||
          wanted === run.status ||
          (typeof wanted === 'object' && ((wanted.in?.includes(run.status) ?? false) || (wanted.not !== undefined && wanted.not !== run.status)));
        if (matches && args.data.status !== undefined) run.status = args.data.status as typeof run.status;
        return { count: matches ? 1 : 0 };
      },
      findMany: async (args: { where: { updatedAt?: unknown } }) =>
        (args.where.updatedAt === undefined ? options.openRuns ?? [] : options.staleRuns ?? []).map((id) => ({ id })),
    },
    planMigrationItem: {
      findMany: async (args: { take: number }) =>
        options.items.filter((item) => item.status === 'PENDING').slice(0, args.take).map((item) => ({ id: item.id })),
      count: async () => options.items.filter((item) => item.status === 'PENDING').length,
    },
    $queryRaw: async () => [],
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  const moveService = {
    processItem: async (_run: unknown, itemId: string) => {
      processed.push(itemId);
      const outcome = options.outcomes?.(itemId) ?? 'MOVED';
      if (outcome === 'MOVED') {
        const item = options.items.find((candidate) => candidate.id === itemId);
        if (item !== undefined) item.status = 'MOVED';
        return { kind: 'PROCESSED', moved: 1, syncJobIds: [] };
      }
      return { kind: 'NOOP' };
    },
  };
  const queue = {
    add: async (_name: string, data: { runId: string }, jobOptions: { delay: number }) => {
      if (options.enqueueFails === true) throw new Error('redis down');
      added.push({ runId: data.runId, delay: jobOptions.delay });
      return {};
    },
  };
  const runner = new PlanMigrationRunnerService(prisma as never, moveService as never, {} as never, queue as never);
  return { runner, run, added, processed, runUpdates };
}

const RETRY_CONTEXT = {
  currentAdmin: { id: 'admin-b' } as never,
  requestMetadata: { requestId: 'req-b', remoteAddress: '198.51.100.2', userAgent: 'retry' },
};

function items(count: number): FakeItem[] {
  return Array.from({ length: count }, (_, index) => ({ id: `item-${String(index).padStart(4, '0')}`, status: 'PENDING' as const }));
}

describe('a tick', () => {
  it('opens a QUEUED run, moves one batch and queues the next tick while items remain', async () => {
    const { runner, run, added, processed } = harness({ items: items(PLAN_MIGRATION_BATCH_SIZE + 3) });
    await runner.processTick('run-1');
    assert.equal(run.status, 'RUNNING');
    assert.equal(processed.length, PLAN_MIGRATION_BATCH_SIZE, 'one batch per tick');
    assert.deepEqual(added, [{ runId: 'run-1', delay: 0 }]);

    await runner.processTick('run-1');
    assert.equal(processed.length, PLAN_MIGRATION_BATCH_SIZE + 3);
    assert.equal(run.status, 'COMPLETED', 'no PENDING item left → COMPLETED');
    assert.equal(added.length, 1, 'a completed run queues nothing');
  });

  it('backs off when a batch made no progress — its items are being moved by another tick', async () => {
    const { runner, run, added } = harness({ items: items(2), runStatus: 'RUNNING', outcomes: () => 'NOOP' });
    await runner.processTick('run-1');
    assert.equal(run.status, 'RUNNING');
    assert.deepEqual(added, [{ runId: 'run-1', delay: PLAN_MIGRATION_IDLE_RETICK_MS }]);
  });

  it('does nothing for a COMPLETED run', async () => {
    const { runner, processed, added } = harness({ items: items(3), runStatus: 'COMPLETED' });
    await runner.processTick('run-1');
    assert.deepEqual(processed, []);
    assert.deepEqual(added, []);
  });

  it('survives a refused enqueue — the sweep resumes the run', async () => {
    const { runner, processed } = harness({ items: items(PLAN_MIGRATION_BATCH_SIZE + 1), enqueueFails: true });
    await runner.processTick('run-1');
    assert.equal(processed.length, PLAN_MIGRATION_BATCH_SIZE);
  });
});

describe('restart recovery', () => {
  const previousRole = process.env.RUID_PROCESS_ROLE;
  beforeEach(() => _resetProcessRoleCacheForTests());
  afterEach(() => {
    if (previousRole === undefined) delete process.env.RUID_PROCESS_ROLE;
    else process.env.RUID_PROCESS_ROLE = previousRole;
    _resetProcessRoleCacheForTests();
  });

  it('re-enqueues stale open runs in a scheduling process only', async () => {
    process.env.RUID_PROCESS_ROLE = 'worker';
    const worker = harness({ items: [], staleRuns: ['run-a', 'run-b'] });
    assert.equal(await worker.runner.sweepStaleRuns(), 2);
    assert.deepEqual(worker.added.map((entry) => entry.runId), ['run-a', 'run-b']);

    process.env.RUID_PROCESS_ROLE = 'api';
    _resetProcessRoleCacheForTests();
    const api = harness({ items: [], staleRuns: ['run-a'] });
    assert.equal(await api.runner.sweepStaleRuns(), 0);
    assert.deepEqual(api.added, []);
  });

  it('resumes every open run at bootstrap', async () => {
    process.env.RUID_PROCESS_ROLE = 'all';
    const { runner, added } = harness({ items: [], openRuns: ['run-x', 'run-y'] });
    await runner.onApplicationBootstrap();
    assert.deepEqual(added.map((entry) => entry.runId), ['run-x', 'run-y']);
  });
});

describe('the retry request', () => {
  it('answers 404 for a run of another plan', async () => {
    const prisma = { planMigrationRun: { findFirst: async () => null } };
    const runner = new PlanMigrationRunnerService(prisma as never, {} as never, {} as never, {} as never);
    await assert.rejects(() => runner.retry('plan-p', 'run-of-another-plan', 'failed', RETRY_CONTEXT), NotFoundException);
  });

  it('turns the open-run unique index into 409 MIGRATION_ALREADY_RUNNING', async () => {
    const violation = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { modelName: 'PlanMigrationRun', target: 'plan_migration_runs_open_source_plan_key' },
    });
    const prisma = {
      planMigrationRun: { findFirst: async () => ({ id: 'run-1' }) },
      $transaction: async () => {
        throw violation;
      },
    };
    const runner = new PlanMigrationRunnerService(prisma as never, {} as never, {} as never, {} as never);
    await assert.rejects(
      () => runner.retry('plan-p', 'run-1', 'failed', RETRY_CONTEXT),
      (error: unknown) =>
        error instanceof ConflictException && (error.getResponse() as { code: string }).code === 'MIGRATION_ALREADY_RUNNING',
    );
  });
});

describe('operator-safe error text', () => {
  it('never forwards driver text for an unexpected database error', () => {
    const error = new Prisma.PrismaClientKnownRequestError('insert into "subscriptions" values ($1) — secret', {
      code: 'P2010',
      clientVersion: 'test',
      meta: { driverAdapterError: { cause: { code: '23514' } } },
    });
    assert.equal(describeMoveError(error), 'Database error P2010.');
    assert.equal(describeMoveError(new Error('connection to postgres://u:p@db failed')), 'Unexpected error.');
    assert.equal(describeMoveError(new ConflictException('Subscription term is not the next scheduled generation')), 'Subscription term is not the next scheduled generation');
    const deadlock = new Prisma.PrismaClientKnownRequestError('deadlock', {
      code: 'P2039',
      clientVersion: 'test',
      meta: { driverAdapterError: { cause: { code: '40P01' } } },
    });
    assert.match(describeMoveError(deadlock), /another operation/);
    assert.ok(describeMoveError(new ConflictException('x'.repeat(900))).length <= 500);
  });

  it('redacts a sync job’s last error to one short line without URLs or secrets', () => {
    const text = redactSyncError(
      'Remnawave update failed:\n https://panel.example.com/api/users/1?token=x Authorization: Bearer abc.def token=s3cr3t ' +
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig — the panel does not know this squad: 0a000000-0000-4000-8000-000000000001',
    );
    assert.ok(text !== null);
    assert.equal(text.includes('panel.example.com'), false);
    assert.equal(text.includes('s3cr3t'), false);
    assert.equal(text.includes('eyJhbGciOiJIUzI1NiJ9'), false);
    assert.equal(text.includes('\n'), false);
    assert.ok(text.includes('0a000000-0000-4000-8000-000000000001'), 'the squad uuid is what the operator needs');
    assert.equal(redactSyncError(null), null);
    assert.ok((redactSyncError('x'.repeat(1000)) ?? '').length <= 300);
  });
});
