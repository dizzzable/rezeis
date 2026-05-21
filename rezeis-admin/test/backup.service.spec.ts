import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BackupService } from '../src/modules/backup/backup.service';

describe('BackupService', () => {
  it('returns read-only manifest with export and restore disabled', async () => {
    const prisma = {
      user: { count: async () => 10 },
      subscription: { count: async () => 4 },
      transaction: { count: async () => 3 },
      adminAuditLog: { count: async () => 8 },
      broadcast: { count: async () => 2 },
      adminImportBatch: { count: async () => 1 },
      promoCode: { count: async () => 5 },
      partner: { count: async () => 6 },
    };
    const service = new BackupService(prisma as never);

    const manifest = await service.getManifest();

    assert.equal(manifest.exportEnabled, false);
    assert.equal(manifest.restoreEnabled, false);
    assert.equal(manifest.domains.find((domain) => domain.domain === 'users')?.rowCount, 10);
    assert.equal(manifest.domains.some((domain) => domain.containsSensitiveData), true);
  });

  it('returns field-level export redaction policy with export endpoint disabled', () => {
    const service = new BackupService({} as never);

    const policy = service.getExportPolicy();

    assert.equal(policy.exportEndpointEnabled, false);
    assert.equal(policy.restoreEnabled, false);
    assert.equal(policy.domains.find((domain) => domain.domain === 'imports')?.exportAllowed, true);
    assert.equal(policy.domains.some((domain) => domain.redactedFields.includes('email')), true);
    assert.equal(JSON.stringify(policy).includes('passwordHash'), true);
  });

  it('exports sanitized imports data without raw content', async () => {
    const service = new BackupService({
      adminImportBatch: {
        findMany: async () => [
          {
            id: 'batch-1',
            sourceType: 'CSV',
            status: 'COMMITTED',
            totalRows: 1,
            acceptedRows: 1,
            rejectedRows: 0,
            writesPerformed: true,
            createdAt: new Date('2026-04-24T12:00:00.000Z'),
            stagingRows: [
              {
                rowNumber: 1,
                status: 'ACCEPTED',
                fields: ['email'],
                identifiers: { email: 'user@example.com' },
                errors: [],
              },
            ],
            rollbackItems: [
              {
                userId: 'user-1',
                email: 'user@example.com',
                status: 'PENDING',
                rolledBackAt: null,
              },
            ],
          },
        ],
      },
    } as never);

    const exported = await service.exportImports();

    assert.equal(exported.domain, 'imports');
    assert.equal(exported.rawContentIncluded, false);
    assert.equal(exported.batches[0]?.stagingRows[0]?.identifierKeys.includes('email'), true);
    assert.equal(JSON.stringify(exported).includes('raw uploaded content'), false);
  });

  it('records imports export downloads without storing payload data', async () => {
    const calls: unknown[] = [];
    const service = new BackupService({
      adminAuditLog: {
        create: async (input: unknown) => {
          calls.push(input);
        },
      },
    } as never);

    await service.recordImportsExportDownload({
      adminUserId: 'admin-1',
      exportPayload: {
        generatedAt: '2026-04-24T12:00:00.000Z',
        domain: 'imports',
        restoreEnabled: false,
        rawContentIncluded: false,
        batches: [
          {
            id: 'batch-1',
            sourceType: 'CSV',
            status: 'COMMITTED',
            totalRows: 1,
            acceptedRows: 1,
            rejectedRows: 0,
            writesPerformed: true,
            createdAt: '2026-04-24T12:00:00.000Z',
            stagingRows: [],
            rollbackItems: [],
          },
        ],
      },
    });

    assert.equal(JSON.stringify(calls).includes('DOWNLOAD_IMPORTS_BACKUP_EXPORT'), true);
    assert.equal(JSON.stringify(calls).includes('batch-1'), false);
    assert.equal(JSON.stringify(calls).includes('raw uploaded content'), false);
  });
});
