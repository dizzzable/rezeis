import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ImportStatus } from '@prisma/client';

import { ImportsService } from '../src/modules/imports/services/imports.service';

describe('ImportsService', () => {
  it('lists import records through the current ImportRecord store', async () => {
    const calls: unknown[] = [];
    const service = new ImportsService({
      importRecord: {
        findMany: async (input: unknown) => {
          calls.push(input);
          return [createImportRecord({ id: 'import-1' })];
        },
      },
    } as never);

    const records = await service.list({ limit: 25, offset: 5 });

    assert.deepStrictEqual(calls, [
      {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 25,
        skip: 5,
      },
    ]);
    assert.equal(records[0]?.id, 'import-1');
  });

  it('loads an import by id and rejects missing records', async () => {
    const service = new ImportsService({
      importRecord: {
        findUnique: async (input: unknown) => {
          assert.deepStrictEqual(input, { where: { id: 'missing-import' } });
          return null;
        },
      },
    } as never);

    await assert.rejects(() => service.getById('missing-import'), /Import record not found/);
  });

  it('creates a persisted dry-run import record with a bounded result payload', async () => {
    const calls: unknown[] = [];
    const service = new ImportsService({
      importRecord: {
        create: async (input: unknown) => {
          calls.push(input);
          return createImportRecord({ id: 'dry-run-1', status: ImportStatus.DRY_RUN });
        },
      },
    } as never);

    const record = await service.createDryRun({
      filename: 'remnawave-export.json',
      sourceType: 'remnawave',
      createdBy: 'admin-1',
      result: { mode: 'dry-run', created: 0, updated: 2 },
      recordsTotal: 2,
      recordsOk: 2,
      recordsFailed: 0,
    });

    assert.equal(record.id, 'dry-run-1');
    assert.deepStrictEqual(calls, [
      {
        data: {
          filename: 'remnawave-export.json',
          sourceType: 'remnawave',
          status: ImportStatus.DRY_RUN,
          recordsTotal: 2,
          recordsOk: 2,
          recordsFailed: 0,
          result: { mode: 'dry-run', created: 0, updated: 2 },
          createdBy: 'admin-1',
        },
      },
    ]);
  });

  it('commits only DRY_RUN imports', async () => {
    const calls: unknown[] = [];
    const service = new ImportsService({
      importRecord: {
        findUnique: async () => createImportRecord({ id: 'import-1', status: ImportStatus.DRY_RUN }),
        update: async (input: unknown) => {
          calls.push(input);
          return createImportRecord({ id: 'import-1', status: ImportStatus.COMMITTED });
        },
      },
    } as never);

    const record = await service.commit('import-1');

    assert.equal(record.status, ImportStatus.COMMITTED);
    assert.equal(JSON.stringify(calls).includes('committedAt'), true);
    assert.deepStrictEqual((calls[0] as { readonly where: unknown }).where, { id: 'import-1' });
  });

  it('blocks rollback for imports that are not committed', async () => {
    const service = new ImportsService({
      importRecord: {
        findUnique: async () => createImportRecord({ id: 'import-1', status: ImportStatus.DRY_RUN }),
      },
    } as never);

    await assert.rejects(() => service.rollback('import-1'), /Only COMMITTED imports can be rolled back/);
  });
});

function createImportRecord(input: {
  readonly id?: string;
  readonly status?: ImportStatus;
}) {
  return {
    id: input.id ?? 'import-1',
    filename: 'import.json',
    sourceType: 'remnawave',
    status: input.status ?? ImportStatus.DRAFT,
    recordsTotal: 0,
    recordsOk: 0,
    recordsFailed: 0,
    errorMessage: null,
    result: null,
    createdBy: 'admin-1',
    committedAt: null,
    rolledBackAt: null,
    createdAt: new Date('2026-04-24T12:00:00.000Z'),
    updatedAt: new Date('2026-04-24T12:00:00.000Z'),
  };
}
