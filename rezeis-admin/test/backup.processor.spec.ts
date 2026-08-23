import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BACKUP_JOBS } from '../src/modules/backup/backup.constants';
import { BackupProcessor } from '../src/modules/backup/backup.processor';

describe('BackupProcessor restore', () => {
  it('rehydrates custom emoji files after restoring the database and applying migrations', async () => {
    const stages: unknown[] = [];
    const events: unknown[][] = [];
    const processor = new BackupProcessor(
      {
        runRestore: async () => true,
        runMigrateDeploy: async () => true,
      } as never,
      // `emit` as well as `info`: the restore-completed event moved to `emit`
      // so it can carry `adminId`, which `info` cannot — before that every
      // restore was attributed to "system" in the audit log.
      {
        info: (...args: unknown[]) => events.push(args),
        emit: (...args: unknown[]) => events.push(args),
      } as never,
      {
        rehydrateMissingAssets: async () => ({ recoveredEmojiCount: 12, skippedPacks: 1 }),
      } as never,
    );

    const result = await processor.process({
      name: BACKUP_JOBS.RESTORE,
      data: { filename: 'rezeis-restore.sql.gz', initiatedBy: 'admin-1' },
      updateProgress: async (stage: unknown) => stages.push(stage),
    } as never);

    assert.deepStrictEqual(result, {
      success: true,
      migrationsApplied: true,
      customEmojiAssets: { recoveredEmojiCount: 12, skippedPacks: 1 },
    });
    assert.deepStrictEqual(stages, [
      { stage: 'restoring', percent: 10 },
      { stage: 'migrating', percent: 70 },
      { stage: 'recovering-custom-emoji-assets', percent: 85 },
      { stage: 'completed', percent: 100 },
    ]);
    assert.equal(JSON.stringify(events).includes('recoveredEmojiCount'), true);
  });

  it('does not roll back a successful database restore when emoji recovery fails', async () => {
    const processor = new BackupProcessor(
      {
        runRestore: async () => true,
        runMigrateDeploy: async () => false,
      } as never,
      { info: () => undefined, emit: () => undefined } as never,
      { rehydrateMissingAssets: async () => { throw new Error('Telegram unavailable') } } as never,
    );

    const result = await processor.process({
      name: BACKUP_JOBS.RESTORE,
      data: { filename: 'rezeis-restore.sql.gz', initiatedBy: null },
      updateProgress: async () => undefined,
    } as never);

    assert.deepStrictEqual(result, {
      success: true,
      migrationsApplied: false,
      customEmojiAssets: null,
    });
  });
});
