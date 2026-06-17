import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BackupScope } from '@prisma/client';

import { BackupService } from '../src/modules/backup/services/backup.service';

describe('BackupService', () => {
  it('lists backup records through the current persisted backup store', async () => {
    const calls: unknown[] = [];
    const service = createService({
      backupRecord: {
        findMany: async (input: unknown) => {
          calls.push(['findMany', input]);
          return [createBackupRecord({ id: 'backup-1', filename: 'rezeis-db.sql.gz' })];
        },
        count: async () => {
          calls.push(['count']);
          return 1;
        },
      },
    });

    const result = await service.list({ limit: 500, offset: -5 });

    assert.deepStrictEqual(calls, [
      [
        'findMany',
        {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 200,
          skip: 0,
        },
      ],
      ['count'],
    ]);
    assert.deepStrictEqual(result, {
      items: [
        {
          id: 'backup-1',
          filename: 'rezeis-db.sql.gz',
          scope: BackupScope.DB,
          sizeBytes: '4096',
          checksum: 'sha256-checksum',
          deliveryChannel: 'local',
          deliveryRecipient: null,
          deliveredAt: null,
          errorMessage: null,
          createdAt: '2026-04-24T12:00:00.000Z',
        },
      ],
      total: 1,
      limit: 200,
      offset: 0,
    });
  });

  it('creates a DB backup record and enqueues the dump job instead of running pg_dump inline', async () => {
    const queueAdds: unknown[] = [];
    const service = createService(
      {
        backupRecord: {
          create: async (input: unknown) => {
            assert.equal('sizeBytes' in (input as { readonly data: Record<string, unknown> }).data, true);
            return createBackupRecord({ id: 'backup-2', filename: 'rezeis-db-2026.sql.gz' });
          },
        },
      },
      {
        add: async (...args: unknown[]) => {
          queueAdds.push(args);
          return { id: 'job-1' };
        },
      },
    );

    const result = await service.createBackup({ scope: BackupScope.DB, initiatedBy: 'admin-1' });

    assert.equal(result.id, 'backup-2');
    assert.equal(result.filename, 'rezeis-db-2026.sql.gz');
    assert.equal(queueAdds.length, 1);
    assert.equal(JSON.stringify(queueAdds[0]).includes('create'), true);
    assert.equal(JSON.stringify(queueAdds[0]).includes('backup-2'), true);
    assert.equal(JSON.stringify(queueAdds[0]).includes('admin-1'), true);
  });

  it('keeps unimplemented asset backups out of the queue', async () => {
    const queueAdds: unknown[] = [];
    const service = createService(
      { backupRecord: { create: async () => createBackupRecord({}) } },
      { add: async (...args: unknown[]) => queueAdds.push(args) },
    );

    await assert.rejects(
      () => service.createBackup({ scope: BackupScope.ASSETS, initiatedBy: null }),
      /ASSETS scope is not implemented yet/,
    );
    assert.deepStrictEqual(queueAdds, []);
  });

  it('reports Telegram delivery availability from settings without exposing tokens', async () => {
    const service = createService(
      {
        settings: {
          findFirst: async (input: unknown) => {
            assert.deepStrictEqual(input, { select: { systemNotifications: true } });
            return {
              systemNotifications: {
                backup: {
                  telegram: { enabled: true, chatId: '12345', topicId: 10 },
                },
              },
            };
          },
        },
      },
      {},
      'secret-bot-token',
    );

    assert.equal(await service.shouldDeliverToTelegram(), true);
  });

  it('does not deliver to Telegram when no bot token is available', async () => {
    const service = createService(
      {
        settings: {
          findFirst: async () => ({
            systemNotifications: { backup: { telegram: { enabled: true, chatId: '12345' } } },
          }),
        },
      },
      {},
      null,
    );

    assert.equal(await service.shouldDeliverToTelegram(), false);
  });

  it('persists backup settings (coercing the topic id) and reports token status', async () => {
    const state: { systemNotifications: Record<string, unknown> } = {
      systemNotifications: { other: 'keep' },
    };
    const service = createService(
      {
        settings: {
          findFirst: async () => ({ id: 's1', systemNotifications: state.systemNotifications }),
          update: async (args: { data: { systemNotifications: Record<string, unknown> } }) => {
            state.systemNotifications = args.data.systemNotifications;
            return args;
          },
        },
      },
      {},
      'tok',
    );

    const view = await service.updateSettings({
      autoEnabled: false,
      intervalHours: 12,
      maxKeep: 5,
      telegram: { enabled: true, chatId: '-100999', topicId: '10' },
    });

    // Persisted: backup sub-object merged, siblings preserved, topic coerced to number.
    const backup = (state.systemNotifications as { backup: Record<string, unknown> }).backup as {
      autoEnabled: boolean; intervalHours: number; maxKeep: number;
      telegram: { enabled: boolean; chatId: string; topicId: number };
    };
    assert.equal((state.systemNotifications as { other: string }).other, 'keep');
    assert.equal(backup.autoEnabled, false);
    assert.equal(backup.intervalHours, 12);
    assert.equal(backup.telegram.chatId, '-100999');
    assert.equal(backup.telegram.topicId, 10);

    // The returned view reflects token availability + the persisted values.
    assert.equal(view.botTokenConfigured, true);
    assert.equal(view.telegram.topicId, 10);
  });
});

function createService(
  prisma: Record<string, unknown>,
  queue: { readonly add?: (...args: unknown[]) => Promise<unknown> | unknown } = {},
  settingsToken: string | null = null,
): BackupService {
  return new BackupService(
    {
      host: 'postgres',
      port: 5432,
      user: 'rezeis',
      password: 'not-a-real-password',
      name: 'rezeis',
    } as never,
    prisma as never,
    { info: () => undefined, error: () => undefined } as never,
    { getDecryptedBotToken: async () => settingsToken } as never,
    { add: queue.add ?? (async () => ({ id: 'job-1' })) } as never,
  );
}

function createBackupRecord(input: {
  readonly id?: string;
  readonly filename?: string;
  readonly scope?: BackupScope;
}) {
  return {
    id: input.id ?? 'backup-1',
    filename: input.filename ?? 'rezeis-db.sql.gz',
    scope: input.scope ?? BackupScope.DB,
    sizeBytes: 4096n,
    checksum: 'sha256-checksum',
    deliveryChannel: 'local',
    deliveryRecipient: null,
    deliveredAt: null,
    errorMessage: null,
    createdAt: new Date('2026-04-24T12:00:00.000Z'),
  };
}
