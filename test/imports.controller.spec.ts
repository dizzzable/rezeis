import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { DryRunImportSourceType } from '../src/modules/imports/dto/dry-run-import.dto';
import { ImportsController } from '../src/modules/imports/imports.controller';
import { ImportsService } from '../src/modules/imports/imports.service';

describe('ImportsController', () => {
  it('is guarded by admin jwt guard', () => {
    const guards = Reflect.getMetadata('__guards__', ImportsController) as unknown[] | undefined;
    assert.equal(guards?.some((guard) => guard === AdminJwtAuthGuard), true);
  });

  it('delegates dry-run calls and wraps the safe response', async () => {
    const calls: unknown[] = [];
    const controller = new ImportsController({
      createDryRunBatch: (input: { readonly dto: unknown; readonly adminUserId: string | undefined }) => {
        calls.push(input);
        return {
          batch: {
            id: 'batch-1',
            adminUserId: input.adminUserId ?? null,
            sourceType: DryRunImportSourceType.CSV,
            status: 'DRY_RUN',
            totalRows: 1,
            acceptedRows: 1,
            rejectedRows: 0,
            writesPerformed: false,
            createdAt: '2026-04-24T12:00:00.000Z',
          },
          result: {
            sourceType: DryRunImportSourceType.CSV,
            totalRows: 1,
            acceptedRows: 1,
            rejectedRows: 0,
            validationErrors: [],
            previewRows: [{ rowNumber: 1, fields: ['email'], identifierPresent: true }],
            writesPerformed: false,
          },
        };
      },
    } as unknown as ImportsService);

    const actual = await controller.dryRun({ id: 'admin-1' } as Parameters<ImportsController['dryRun']>[0], {
      sourceType: DryRunImportSourceType.CSV,
      content: 'email\nuser@example.com',
    });

    assert.deepStrictEqual(calls, [
      {
        adminUserId: 'admin-1',
        dto: { sourceType: DryRunImportSourceType.CSV, content: 'email\nuser@example.com' },
      },
    ]);
    assert.equal(actual.data.result.writesPerformed, false);
    assert.equal(JSON.stringify(actual).includes('user@example.com'), false);
  });

  it('delegates rollback calls with admin context', async () => {
    const calls: unknown[] = [];
    const controller = new ImportsController({
      rollbackBatch: async (input: unknown) => {
        calls.push(input);
        return {
          batchId: 'batch-1',
          status: 'ROLLED_BACK',
          rolledBack: true,
          deletedUsers: 2,
          checkedAt: '2026-04-24T12:00:00.000Z',
        };
      },
    } as unknown as ImportsService);

    const actual = await controller.rollbackBatch({ id: 'admin-1' } as Parameters<ImportsController['rollbackBatch']>[0], 'batch-1');

    assert.deepStrictEqual(calls, [{ batchId: 'batch-1', adminUserId: 'admin-1' }]);
    assert.deepStrictEqual(actual, {
      data: {
        batchId: 'batch-1',
        status: 'ROLLED_BACK',
        rolledBack: true,
        deletedUsers: 2,
        checkedAt: '2026-04-24T12:00:00.000Z',
      },
    });
  });
});
