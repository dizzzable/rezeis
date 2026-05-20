import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DryRunImportSourceType } from '../src/modules/imports/dto/dry-run-import.dto';
import { CommitImportBatchTarget } from '../src/modules/imports/dto/commit-import-batch.dto';
import { ImportsService } from '../src/modules/imports/imports.service';

describe('ImportsService', () => {
  it('dry-runs CSV content without writes and reports accepted/rejected rows', () => {
    const service = new ImportsService();

    const result = service.dryRun({
      sourceType: DryRunImportSourceType.CSV,
      content: 'email,username\nuser@example.com,user\n,',
    });

    assert.deepStrictEqual(result, {
      sourceType: DryRunImportSourceType.CSV,
      totalRows: 2,
      acceptedRows: 1,
      rejectedRows: 1,
      validationErrors: [
        {
          rowNumber: 2,
          code: 'MISSING_IDENTIFIER',
          message: 'Row does not contain a supported identifier field.',
        },
      ],
      previewRows: [
        {
          rowNumber: 1,
          fields: ['email', 'username'],
          identifierPresent: true,
        },
        {
          rowNumber: 2,
          fields: ['email', 'username'],
          identifierPresent: false,
        },
      ],
      writesPerformed: false,
    });
  });

  it('dry-runs JSON arrays and never exposes raw content in the response', () => {
    const service = new ImportsService();

    const result = service.dryRun({
      sourceType: DryRunImportSourceType.JSON,
      content: JSON.stringify([{ telegramId: '123' }, { plan: 'premium' }]),
    });

    assert.equal(result.totalRows, 2);
    assert.equal(result.acceptedRows, 1);
    assert.equal(result.rejectedRows, 1);
    assert.equal(result.writesPerformed, false);
    assert.equal(JSON.stringify(result).includes('premium'), false);
  });

  it('reports invalid JSON as validation error', () => {
    const service = new ImportsService();

    const result = service.dryRun({
      sourceType: DryRunImportSourceType.JSON,
      content: '{invalid',
    });

    assert.equal(result.totalRows, 1);
    assert.equal(result.acceptedRows, 0);
    assert.equal(result.rejectedRows, 1);
    assert.deepStrictEqual(result.validationErrors, [
      {
        rowNumber: 1,
        code: 'INVALID_JSON',
        message: 'JSON content could not be parsed.',
      },
    ]);
  });

  it('reports unsupported top-level JSON shapes instead of dropping them', () => {
    const service = new ImportsService();

    const result = service.dryRun({
      sourceType: DryRunImportSourceType.JSON,
      content: JSON.stringify('not-a-row'),
    });

    assert.equal(result.totalRows, 1);
    assert.equal(result.acceptedRows, 0);
    assert.equal(result.rejectedRows, 1);
    assert.deepStrictEqual(result.validationErrors, [
      {
        rowNumber: 1,
        code: 'UNSUPPORTED_SHAPE',
        message: 'Import row must be an object with supported identifier fields.',
      },
    ]);
  });

  it('reports unsupported mixed JSON array rows instead of filtering them out', () => {
    const service = new ImportsService();

    const result = service.dryRun({
      sourceType: DryRunImportSourceType.JSON,
      content: JSON.stringify([{ email: 'user@example.com' }, 'bad-row']),
    });

    assert.equal(result.totalRows, 2);
    assert.equal(result.acceptedRows, 1);
    assert.equal(result.rejectedRows, 1);
    assert.deepStrictEqual(result.validationErrors, [
      {
        rowNumber: 2,
        code: 'UNSUPPORTED_SHAPE',
        message: 'Import row must be an object with supported identifier fields.',
      },
    ]);
  });

  it('persists dry-run batch and staging rows in one transaction', async () => {
    const calls: unknown[] = [];
    const transactionClient = {
      adminImportBatch: {
        create: async (input: unknown) => {
          calls.push(['tx.batch.create', input]);
          return {
            id: 'batch-1',
            adminUserId: 'admin-1',
            sourceType: DryRunImportSourceType.CSV,
            status: 'DRY_RUN',
            totalRows: 2,
            acceptedRows: 1,
            rejectedRows: 1,
            validationErrors: [],
            previewRows: [],
            writesPerformed: false,
            createdAt: new Date('2026-04-24T12:00:00.000Z'),
          };
        },
      },
      adminImportStagingRow: {
        createMany: async (input: unknown) => {
          calls.push(['tx.staging.createMany', input]);
          return { count: 2 };
        },
      },
    };
    const service = new ImportsService({
      adminImportBatch: {
        create: async (input: unknown) => {
          calls.push(['root.batch.create', input]);
          throw new Error('root batch create must not run');
        },
      },
      adminImportStagingRow: {
        createMany: async (input: unknown) => {
          calls.push(['root.staging.createMany', input]);
          throw new Error('root staging createMany must not run');
        },
      },
      $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) => {
        calls.push('transaction.begin');
        const result = await callback(transactionClient);
        calls.push('transaction.commit');
        return result;
      },
    } as never);

    const result = await service.createDryRunBatch({
      adminUserId: 'admin-1',
      dto: {
        sourceType: DryRunImportSourceType.CSV,
        content: 'email,username\nnew@example.com,new\n,missing',
      },
    });

    assert.equal(result.batch.id, 'batch-1');
    assert.equal(result.result.totalRows, 2);
    assert.equal(result.result.writesPerformed, false);
    assert.deepStrictEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), [
      'transaction.begin',
      'tx.batch.create',
      'tx.staging.createMany',
      'transaction.commit',
    ]);
    assert.equal(JSON.stringify(calls).includes('batch-1'), true);
    assert.equal(JSON.stringify(calls).includes('root.batch.create'), false);
    assert.equal(JSON.stringify(calls).includes('root.staging.createMany'), false);
  });

  it('loads saved batch details without raw import content', async () => {
    const service = new ImportsService({
      adminImportBatch: {
        findUnique: async (args: unknown) => {
          assert.deepStrictEqual(args, {
            where: { id: 'batch-1' },
            include: { stagingRows: { orderBy: { rowNumber: 'asc' }, take: 50 } },
          });
          return {
            id: 'batch-1',
            adminUserId: 'admin-1',
            sourceType: DryRunImportSourceType.CSV,
            status: 'DRY_RUN',
            totalRows: 1,
            acceptedRows: 1,
            rejectedRows: 0,
            validationErrors: [],
            previewRows: [{ rowNumber: 1, fields: ['email'], identifierPresent: true }],
            stagingRows: [
              {
                id: 'row-1',
                batchId: 'batch-1',
                rowNumber: 1,
                status: 'ACCEPTED',
                identifiers: { email: 'masked@example.com' },
                fields: ['email'],
                errors: [],
                createdAt: new Date('2026-04-24T12:00:00.000Z'),
              },
            ],
            writesPerformed: false,
            createdAt: new Date('2026-04-24T12:00:00.000Z'),
          };
        },
      },
    } as never);

    const result = await service.getBatch('batch-1');

    assert.deepStrictEqual(result, {
      id: 'batch-1',
      adminUserId: 'admin-1',
      sourceType: DryRunImportSourceType.CSV,
      status: 'DRY_RUN',
      totalRows: 1,
      acceptedRows: 1,
      rejectedRows: 0,
      validationErrors: [],
      previewRows: [{ rowNumber: 1, fields: ['email'], identifierPresent: true }],
      stagingRows: [
        {
          rowNumber: 1,
          status: 'ACCEPTED',
          identifiers: { email: 'masked@example.com' },
          fields: ['email'],
          errors: [],
        },
      ],
      writesPerformed: false,
      createdAt: '2026-04-24T12:00:00.000Z',
    });
    assert.equal(JSON.stringify(result).includes('user@example.com'), false);
  });

  it('builds commit readiness checklist without enabling commit', async () => {
    const service = new ImportsService({
      adminImportBatch: {
        findUnique: async () => ({
          id: 'batch-1',
          adminUserId: 'admin-1',
          sourceType: DryRunImportSourceType.CSV,
          status: 'DRY_RUN',
          totalRows: 2,
          acceptedRows: 2,
          rejectedRows: 0,
          validationErrors: [],
          previewRows: [],
          writesPerformed: false,
          createdAt: new Date('2026-04-24T12:00:00.000Z'),
        }),
      },
    } as never);

    const readiness = await service.getBatchCommitReadiness('batch-1');

    assert.equal(readiness.isReady, true);
    assert.equal(readiness.commitEnabled, true);
    assert.deepStrictEqual(readiness.checks.map((check) => [check.code, check.passed]), [
      ['BATCH_STATUS_DRY_RUN', true],
      ['NO_WRITES_PERFORMED', true],
      ['HAS_ROWS', true],
      ['HAS_ACCEPTED_ROWS', true],
      ['NO_REJECTED_ROWS', true],
    ]);
  });

  it('commits accepted email staging rows into users and records summary', async () => {
    const calls: unknown[] = [];
    let userFindManyCalls = 0;
    const transactionClient = {
      adminImportBatch: {
        update: async (input: unknown) => {
          calls.push(['tx.batch.update', input]);
          return {
            id: 'batch-1',
            status: 'COMMITTED',
            writesPerformed: true,
            sourceType: DryRunImportSourceType.CSV,
            totalRows: 2,
            acceptedRows: 2,
            rejectedRows: 0,
          };
        },
      },
      user: {
        findMany: async (input: unknown) => {
          calls.push(['tx.user.findMany', input]);
          userFindManyCalls += 1;
          if (userFindManyCalls === 2) {
            return [{ id: 'created-user-1', email: 'new@example.com' }];
          }
          return [{ email: 'existing@example.com' }];
        },
        createMany: async (input: unknown) => {
          calls.push(['tx.user.createMany', input]);
          return { count: 1 };
        },
      },
      adminAuditLog: { create: async (input: unknown) => calls.push(['tx.audit.create', input]) },
      adminImportRollbackItem: {
        createMany: async (input: unknown) => {
          calls.push(['tx.rollback.createMany', input]);
          return { count: 1 };
        },
      },
    };
    const service = new ImportsService({
      adminImportBatch: {
        findUnique: async () => ({
          id: 'batch-1',
          adminUserId: 'admin-1',
          sourceType: DryRunImportSourceType.CSV,
          status: 'DRY_RUN',
          totalRows: 2,
          acceptedRows: 2,
          rejectedRows: 0,
          validationErrors: [],
          previewRows: [],
          writesPerformed: false,
          createdAt: new Date('2026-04-24T12:00:00.000Z'),
          stagingRows: [
            { status: 'ACCEPTED', identifiers: { email: 'new@example.com' } },
            { status: 'ACCEPTED', identifiers: { email: 'existing@example.com' } },
          ],
        }),
        update: async (input: unknown) => {
          calls.push(['root.batch.update', input]);
          throw new Error('root batch update must not run');
        },
      },
      user: {
        findMany: async (input: unknown) => {
          calls.push(['root.user.findMany', input]);
          throw new Error('root user findMany must not run');
        },
        createMany: async (input: unknown) => {
          calls.push(['root.user.createMany', input]);
          throw new Error('root user createMany must not run');
        },
      },
      adminAuditLog: {
        create: async (input: unknown) => {
          calls.push(['root.audit.create', input]);
          throw new Error('root audit create must not run');
        },
      },
      adminImportRollbackItem: {
        createMany: async (input: unknown) => {
          calls.push(['root.rollback.createMany', input]);
          throw new Error('root rollback createMany must not run');
        },
      },
      $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
    } as never);

    const result = await service.commitBatch({
      batchId: 'batch-1',
      adminUserId: 'admin-1',
      target: CommitImportBatchTarget.CREATE_EMAIL_USERS,
    });

    assert.equal(result.target, CommitImportBatchTarget.CREATE_EMAIL_USERS);
    assert.equal(result.createdUsers, 1);
    assert.equal(result.skippedExistingUsers, 1);
    assert.equal(result.writesPerformed, true);
    assert.equal(JSON.stringify(calls).includes('new@example.com'), true);
    assert.deepStrictEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), [
      'tx.user.findMany',
      'tx.user.createMany',
      'tx.user.findMany',
      'tx.rollback.createMany',
      'tx.batch.update',
      'tx.audit.create',
    ]);
  });

  it('blocks rollback when readiness is false', async () => {
    const service = new ImportsService({
      adminImportBatch: {
        findUnique: async () => ({
          id: 'batch-1',
          status: 'DRY_RUN',
          writesPerformed: false,
          rollbackItems: [],
        }),
      },
      adminAuditLog: {
        findMany: async () => [],
      },
    } as never);

    const result = await service.rollbackBatch({ batchId: 'batch-1', adminUserId: 'admin-1' });

    assert.deepStrictEqual(
      {
        batchId: result.batchId,
        status: result.status,
        rolledBack: result.rolledBack,
        deletedUsers: result.deletedUsers,
      },
      {
        batchId: 'batch-1',
        status: 'ROLLBACK_BLOCKED',
        rolledBack: false,
        deletedUsers: 0,
      },
    );
  });

  it('rolls back only users recorded in rollback ledger and writes audit', async () => {
    const calls: unknown[] = [];
    const transactionClient = {
      adminImportBatch: {
        findUnique: async (input: unknown) => {
          calls.push(['tx.batch.findUnique', input]);
          return {
            id: 'batch-1',
            status: 'COMMITTED',
            writesPerformed: true,
            rollbackItems: [
              { id: 'rollback-1', userId: 'created-user-1' },
              { id: 'rollback-2', userId: 'created-user-2' },
            ],
          };
        },
        update: async (input: unknown) => {
          calls.push(['tx.batch.update', input]);
          return { id: 'batch-1', status: 'ROLLED_BACK' };
        },
      },
      adminAuditLog: {
        create: async (input: unknown) => {
          calls.push(['tx.audit.create', input]);
        },
      },
      user: {
        deleteMany: async (input: unknown) => {
          calls.push(['tx.user.deleteMany', input]);
          return { count: 2 };
        },
      },
      adminImportRollbackItem: {
        updateMany: async (input: unknown) => {
          calls.push(['tx.rollback.updateMany', input]);
          return { count: 2 };
        },
      },
    };
    const service = new ImportsService({
      adminImportBatch: {
        findUnique: async (_input: unknown) => ({
          id: 'batch-1',
          status: 'COMMITTED',
          writesPerformed: true,
          rollbackItems: [
            { id: 'rollback-1', userId: 'created-user-1' },
            { id: 'rollback-2', userId: 'created-user-2' },
          ],
        }),
        update: async (input: unknown) => {
          calls.push(['root.batch.update', input]);
          throw new Error('root batch update must not run');
        },
      },
      adminAuditLog: {
        findMany: async () => [{ id: 'audit-1' }],
        create: async (input: unknown) => {
          calls.push(['root.audit.create', input]);
          throw new Error('root audit create must not run');
        },
      },
      user: {
        deleteMany: async (input: unknown) => {
          calls.push(['root.user.deleteMany', input]);
          throw new Error('root user deleteMany must not run');
        },
      },
      adminImportRollbackItem: {
        updateMany: async (input: unknown) => {
          calls.push(['root.rollback.updateMany', input]);
          throw new Error('root rollback updateMany must not run');
        },
      },
      $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
    } as never);

    const result = await service.rollbackBatch({ batchId: 'batch-1', adminUserId: 'admin-1' });

    assert.equal(result.status, 'ROLLED_BACK');
    assert.equal(result.rolledBack, true);
    assert.equal(result.deletedUsers, 2);
    assert.deepStrictEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), [
      'tx.batch.findUnique',
      'tx.user.deleteMany',
      'tx.rollback.updateMany',
      'tx.batch.update',
      'tx.audit.create',
    ]);
    assert.deepStrictEqual(calls[1], [
      'tx.user.deleteMany',
      { where: { id: { in: ['created-user-1', 'created-user-2'] } } },
    ]);
    assert.equal(JSON.stringify(calls).includes('ROLLBACK_IMPORT_BATCH'), true);
    assert.equal(JSON.stringify(calls).includes('created-user-1'), true);
  });
});
