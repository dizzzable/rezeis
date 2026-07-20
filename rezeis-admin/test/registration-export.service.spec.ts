import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PrismaService } from '../src/common/prisma/prisma.service';
import { RegistrationExportService } from '../src/modules/users/services/registration-export.service';

describe('RegistrationExportService', () => {
  it('exports bounded rows as CSV and applies max limit', async () => {
    let takeArg: number | undefined;
    const prisma = {
      user: {
        findMany: async (args: { take: number }) => {
          takeArg = args.take;
          return [
            {
              id: 'u1',
              telegramId: 1n,
              username: 'bob',
              createdAt: new Date('2026-07-01T00:00:00.000Z'),
              registrationIp: '1.2.3.4',
              registrationUserAgent: 'ua',
              registrationReferer: null,
              registrationUtm: { source: 'x' },
              registrationChannel: 'web',
              acquisitionPlacementId: null,
              acquisitionAt: null,
            },
          ];
        },
      },
    } as unknown as PrismaService;

    const svc = new RegistrationExportService(prisma);
    const result = await svc.exportCsv({ limit: 99999 });
    assert.equal(takeArg, 5000);
    assert.equal(result.limit, 5000);
    assert.equal(result.rowCount, 1);
    assert.ok(result.csv.includes('1.2.3.4'));
    assert.ok(result.csv.includes('user_id'));
  });

  it('builds createdAt filter from from/to query', async () => {
    let whereArg: Record<string, unknown> | undefined;
    const prisma = {
      user: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          whereArg = args.where;
          return [];
        },
      },
    } as unknown as PrismaService;

    const svc = new RegistrationExportService(prisma);
    const result = await svc.exportCsv({ from: '2026-07-01', to: '2026-07-20', limit: 10 });
    assert.ok(whereArg);
    assert.ok(whereArg!.createdAt);
    const createdAt = whereArg!.createdAt as { gte: Date; lte: Date };
    assert.ok(createdAt.gte instanceof Date);
    assert.ok(createdAt.lte instanceof Date);
    assert.ok(result.from);
    assert.ok(result.to);
  });

  it('rejects invalid or inverted date ranges', async () => {
    const prisma = {
      user: { findMany: async () => [] },
    } as unknown as PrismaService;
    const svc = new RegistrationExportService(prisma);
    await assert.rejects(() => svc.exportCsv({ from: 'not-a-date' }), /Invalid "from"/i);
    await assert.rejects(() => svc.exportCsv({ from: '2026-02-31' }), /Invalid "from"/i);
    await assert.rejects(() => svc.exportCsv({ from: 'July 1, 2026' }), /Invalid "from"/i);
    await assert.rejects(
      () => svc.exportCsv({ from: '2026-07-20', to: '2026-07-01' }),
      /earlier than/i,
    );
  });

  it('includes channel-only snapshots in the export predicate', async () => {
    let whereArg: { OR?: Array<Record<string, unknown>> } | undefined;
    const prisma = {
      user: {
        findMany: async (args: { where: { OR?: Array<Record<string, unknown>> } }) => {
          whereArg = args.where;
          return [];
        },
      },
    } as unknown as PrismaService;
    const svc = new RegistrationExportService(prisma);
    await svc.exportCsv({ limit: 5 });
    assert.ok(whereArg?.OR?.some((clause) => 'registrationChannel' in clause));
  });

  it('includes registration snapshot columns for fixture users with registration*', async () => {
    const prisma = {
      user: {
        findMany: async () => [
          {
            id: 'u-seed',
            telegramId: 42n,
            username: 'seed',
            createdAt: new Date('2026-07-05T00:00:00.000Z'),
            registrationIp: '10.0.0.9',
            registrationUserAgent: 'UA-SEED',
            registrationReferer: 'https://example/ref',
            registrationUtm: { source: 'ads', medium: 'cpc' },
            registrationChannel: 'web',
            acquisitionPlacementId: 'plc-1',
            acquisitionAt: new Date('2026-07-04T00:00:00.000Z'),
          },
        ],
      },
    } as unknown as PrismaService;
    const svc = new RegistrationExportService(prisma);
    const a = await svc.exportCsv({ limit: 10 });
    const b = await svc.exportCsv({ limit: 10 });
    for (const result of [a, b]) {
      assert.equal(result.rowCount, 1);
      assert.ok(result.csv.includes('registration_ip'));
      assert.ok(result.csv.includes('10.0.0.9'));
      assert.ok(result.csv.includes('registration_user_agent'));
      assert.ok(result.csv.includes('UA-SEED'));
      assert.ok(result.csv.includes('registration_referer'));
      assert.ok(result.csv.includes('registration_utm_json'));
      assert.ok(result.csv.includes('ads'));
    }
  });
});
