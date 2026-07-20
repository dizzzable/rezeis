import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PrismaService } from '../src/common/prisma/prisma.service';
import { RegistrationSnapshotService } from '../src/modules/web-auth/services/registration-snapshot.service';

describe('RegistrationSnapshotService', () => {
  it('write-once: only updates when registrationChannel is null', async () => {
    const calls: unknown[] = [];
    const prisma = {
      user: {
        updateMany: async (args: unknown) => {
          calls.push(args);
          return { count: 1 };
        },
      },
    } as unknown as PrismaService;

    const svc = new RegistrationSnapshotService(prisma);
    await svc.captureBestEffort({
      userId: 'u1',
      channel: 'web',
      ip: ' 176.119.1.2 ',
      userAgent: 'Mozilla/5.0',
      referer: 'https://4pda.to/forum/index.php?showtopic=1&sid=secret',
      utm: { source: 'tg_channel_1', medium: 'cpc', campaign: 'summer_sale_2026' },
    });

    assert.equal(calls.length, 1);
    const args = calls[0] as {
      where: { id: string; registrationChannel: null };
      data: {
        registrationIp: string;
        registrationReferer: string;
        registrationUtm: Record<string, string>;
        registrationChannel: string;
      };
    };
    assert.equal(args.where.id, 'u1');
    assert.equal(args.where.registrationChannel, null);
    assert.equal(args.data.registrationIp, '176.119.1.2');
    // Query stripped from referer
    assert.equal(args.data.registrationReferer, 'https://4pda.to/forum/index.php');
    assert.equal(args.data.registrationUtm.source, 'tg_channel_1');
    assert.equal(args.data.registrationChannel, 'web');
  });

  it('swallows prisma errors (best-effort)', async () => {
    const prisma = {
      user: {
        updateMany: async () => {
          throw new Error('db down');
        },
      },
    } as unknown as PrismaService;
    const svc = new RegistrationSnapshotService(prisma);
    await assert.doesNotReject(() =>
      svc.captureBestEffort({ userId: 'u1', channel: 'web', ip: '1.1.1.1' }),
    );
  });
});
