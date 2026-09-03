import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { ImportProcessor } from '../src/modules/imports/import.processor';

/**
 * Post-import "sync to panel" opt-in: when the operator enables it, a successful
 * file import enqueues a profile-sync for every subscription it touched (UPDATE
 * for linked profiles, CREATE for unlinked). When off, imports stay read-only.
 */
describe('ImportProcessor post-import sync', () => {
  it('enqueues profile-sync jobs for imported subscriptions when syncToPanel is on', async () => {
    const createdJobs: unknown[] = [];
    const enqueuedJobIds: string[] = [];
    let subscriptionWhere: unknown;

    const processor = buildProcessor({
      onSubscriptionFindMany: (args) => {
        subscriptionWhere = args.where;
        return [
          { id: 'sub-linked', remnawaveId: 'rem-uuid-1' },
          { id: 'sub-unlinked', remnawaveId: null },
        ];
      },
      onProfileSyncCreate: (args) => {
        createdJobs.push(args.data);
        return { id: `job-${createdJobs.length}` };
      },
      onEnqueue: (jobId) => { enqueuedJobIds.push(jobId); },
    });

    await processor.process(remnawaveJob({ syncToPanel: true }) as never);

    // Targeted EXACTLY this import's rows via the durable importRecordId stamp,
    // excluding soft-deleted subscriptions.
    assert.deepStrictEqual(subscriptionWhere, {
      planSnapshot: { path: ['importRecordId'], equals: 'import-1' },
      NOT: { status: SubscriptionStatus.DELETED },
    });
    // Linked → UPDATE, unlinked → CREATE.
    assert.deepStrictEqual(createdJobs, [
      {
        subscriptionId: 'sub-linked',
        action: SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        payload: { source: 'IMPORT_SYNC', importRecordId: 'import-1' },
      },
      {
        subscriptionId: 'sub-unlinked',
        action: SyncAction.CREATE,
        status: SyncJobStatus.PENDING,
        payload: { source: 'IMPORT_SYNC', importRecordId: 'import-1' },
      },
    ]);
    assert.deepStrictEqual(enqueuedJobIds, ['job-1', 'job-2']);
  });

  it('does NOT enqueue any profile-sync jobs when syncToPanel is off (default)', async () => {
    let findManyCalled = false;
    const enqueuedJobIds: string[] = [];

    const processor = buildProcessor({
      onSubscriptionFindMany: () => { findManyCalled = true; return []; },
      onProfileSyncCreate: () => ({ id: 'should-not-happen' }),
      onEnqueue: (jobId) => { enqueuedJobIds.push(jobId); },
    });

    await processor.process(remnawaveJob({}) as never);

    assert.equal(findManyCalled, false, 'must not scan subscriptions when sync is off');
    assert.deepStrictEqual(enqueuedJobIds, []);
  });

  it('skips subscriptions that already have an in-flight sync job (no duplicate CREATE, e.g. 3x-ui)', async () => {
    const createdJobs: Array<Record<string, unknown>> = [];
    const enqueuedJobIds: string[] = [];

    const processor = buildProcessor({
      onSubscriptionFindMany: () => [
        { id: 'sub-already-queued', remnawaveId: null }, // importer already enqueued a CREATE
        { id: 'sub-fresh', remnawaveId: null },
      ],
      // Only the first subscription has an un-finished job pending.
      onProfileSyncFindFirst: (subscriptionId) =>
        subscriptionId === 'sub-already-queued' ? { id: 'pre-existing-job' } : null,
      onProfileSyncCreate: (args) => {
        createdJobs.push(args.data);
        return { id: `job-${createdJobs.length}` };
      },
      onEnqueue: (jobId) => { enqueuedJobIds.push(jobId); },
    });

    await processor.process(remnawaveJob({ syncToPanel: true }) as never);

    // Only the fresh subscription gets a new job; the already-queued one is left alone.
    assert.deepStrictEqual(createdJobs.map((d) => d.subscriptionId), ['sub-fresh']);
    assert.deepStrictEqual(enqueuedJobIds, ['job-1']);
  });
});

// ── Harness ──────────────────────────────────────────────────────────────────

interface Hooks {
  readonly onSubscriptionFindMany: (args: { where: unknown }) => Array<{ id: string; remnawaveId: string | null }>;
  readonly onProfileSyncCreate: (args: { data: Record<string, unknown> }) => { id: string };
  readonly onEnqueue: (jobId: string) => void;
  // Returns an existing un-finished sync job for the given subscription, or null.
  readonly onProfileSyncFindFirst?: (subscriptionId: string) => { id: string } | null;
}

function buildProcessor(hooks: Hooks): ImportProcessor {
  const prisma = {
    importRecord: { update: async () => undefined },
    subscription: { findMany: async (args: { where: unknown }) => hooks.onSubscriptionFindMany(args) },
    profileSyncJob: {
      findFirst: async (args: { where: { subscriptionId: string } }) =>
        hooks.onProfileSyncFindFirst?.(args.where.subscriptionId) ?? null,
      create: async (args: { data: Record<string, unknown> }) => hooks.onProfileSyncCreate(args),
    },
  };
  const systemEvents = { info: () => undefined, error: () => undefined };
  const remnawaveImporter = {
    run: async () => ({
      importRecordId: 'import-1',
      fetched: 2,
      created: 2,
      updated: 0,
      skipped: 0,
      subscriptionsCreated: 2,
      subscriptionsUpdated: 0,
      errors: [],
    }),
  };
  const profileSyncQueue = { enqueue: async (jobId: string) => { hooks.onEnqueue(jobId); } };

  return new ImportProcessor(
    prisma as never,
    systemEvents as never,
    remnawaveImporter as never,
    {} as never, // threexui
    {} as never, // remnashop
    {} as never, // altshop
    {} as never, // stealthnet
    {} as never, // bedolaga
    {} as never, // bulkPlanAssignment
    profileSyncQueue as never,
  );
}

function remnawaveJob(data: { syncToPanel?: boolean }): unknown {
  return {
    name: 'import.run',
    data: {
      importRecordId: 'import-1',
      sourceType: 'remnawave',
      mode: 'import',
      createdBy: 'admin-1',
      stagedFilePath: null,
      ...data,
    },
    updateProgress: async () => undefined,
  };
}
