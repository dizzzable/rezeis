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

  // The completion event used to be INFO "Database restored" whatever
  // `migrate deploy` answered, with `migrationsApplied: false` only in the
  // metadata. In the published image that step failed on every restore (it
  // spawned npx, which the image does not have), so a restored older schema
  // kept serving the newer build and nothing an operator reads said so.
  it('reports a restore whose migrations were not applied as a WARNING that says what to do', async () => {
    const emitted: Array<{
      severity: string;
      message: string;
      adminId?: string | null;
      metadata?: Record<string, unknown>;
    }> = [];
    const restore = (migrationsApplied: boolean) =>
      new BackupProcessor(
        { runRestore: async () => true, runMigrateDeploy: async () => migrationsApplied } as never,
        { emit: (event: (typeof emitted)[number]) => emitted.push(event) } as never,
        { rehydrateMissingAssets: async () => ({ recoveredEmojiCount: 0, skippedPacks: 0 }) } as never,
      ).process({
        name: BACKUP_JOBS.RESTORE,
        data: { filename: 'rezeis-2026-08-01.sql.gz', initiatedBy: 'admin-1' },
        updateProgress: async () => undefined,
      } as never);

    await restore(false);
    await restore(true);

    assert.equal(emitted.length, 2);
    assert.equal(emitted[0]!.severity, 'WARNING');
    assert.match(emitted[0]!.message, /migrations/i);
    assert.match(emitted[0]!.message, /restart/i, 'the operator is told how the schema catches up');
    assert.equal(emitted[0]!.adminId, 'admin-1');
    // The operator card prints no message: the same instruction, in Russian, is its note.
    assert.match(String(emitted[0]!.metadata?.['note']), /перезапустите контейнер API/);
    // Control: a restore that brought the schema forward is still plain INFO.
    assert.equal(emitted[1]!.severity, 'INFO');
    assert.equal(emitted[1]!.metadata?.['note'], undefined);
  });
});

describe('BackupProcessor restore failure', () => {
  // A restore that fails — psql refusing a statement, an archive that no longer
  // verifies, a missing file — throws out of the job. `onFailed` alerted for
  // create and delivery jobs only, so a failed restore left nothing but a log
  // line: the operator, who was told "restore started", heard nothing more.
  function failedRestoreJob(): unknown {
    return {
      id: 'job-restore-1',
      name: BACKUP_JOBS.RESTORE,
      attemptsMade: 1,
      opts: { attempts: 1 },
      data: { filename: 'rezeis-2026-08-01.sql.gz', initiatedBy: 'admin-1' },
    };
  }

  it('alerts the operator with an ERROR naming the archive, the reason and the admin who started it', () => {
    const emitted: Array<{
      type: string;
      severity: string;
      message: string;
      adminId?: string | null;
      metadata?: Record<string, unknown>;
    }> = [];
    const processor = new BackupProcessor(
      {} as never,
      {
        emit: (event: (typeof emitted)[number]) => emitted.push(event),
        error: (type: string, _category: string, message: string, metadata?: Record<string, unknown>) =>
          emitted.push({ type, severity: 'ERROR', message, metadata }),
      } as never,
      {} as never,
    );

    processor.onFailed(
      failedRestoreJob() as never,
      new Error('psql exited 3: ERROR:  cannot drop constraint users_pkey on table public.users because other objects depend on it'),
    );

    assert.equal(emitted.length, 1, 'a failed restore must reach the operator');
    const [event] = emitted;
    assert.equal(event!.severity, 'ERROR');
    assert.match(event!.message, /rezeis-2026-08-01\.sql\.gz/);
    assert.match(event!.message, /other objects depend on it/);
    assert.equal(event!.adminId, 'admin-1');
    // The card says the data is untouched — `--single-transaction` — and
    // where to go next, not «Необработанная ошибка в панели».
    assert.equal(event!.metadata?.['reason'], 'restore_failed');
    assert.match(String(event!.metadata?.['why']), /База осталась как была/);
    assert.match(String(event!.metadata?.['nextSteps']), /«Бэкапы»/);
  });
});

describe('BackupProcessor backup failure — one card per backup, not per attempt', () => {
  // `runDump` used to send a card on each of the create job's two attempts,
  // and `onFailed` one more after the last: three cards for one backup.
  function processorRecording(): { processor: BackupProcessor; cards: Array<Record<string, unknown>> } {
    const cards: Array<Record<string, unknown>> = [];
    const processor = new BackupProcessor(
      {} as never,
      {
        emit: (event: { metadata?: Record<string, unknown> }) => cards.push(event.metadata ?? {}),
        error: (_type: string, _category: string, _message: string, metadata?: Record<string, unknown>) =>
          cards.push(metadata ?? {}),
      } as never,
      {} as never,
    );
    return { processor, cards };
  }

  function createJob(attemptsMade: number): unknown {
    return {
      id: 'job-create-1',
      name: BACKUP_JOBS.CREATE,
      attemptsMade,
      opts: { attempts: 2 },
      data: { recordId: 'backup-1', filename: 'rezeis-2026-09-23.sql.gz', scope: 'DB', initiatedBy: null },
    };
  }

  it('says nothing after the first attempt — the second may still succeed', () => {
    const { processor, cards } = processorRecording();
    processor.onFailed(createJob(1) as never, new Error('pg_dump: No space left on device'));
    assert.deepEqual(cards, []);
  });

  it('sends one card after the last, naming the file and what to press', () => {
    const { processor, cards } = processorRecording();
    processor.onFailed(createJob(2) as never, new Error('pg_dump: No space left on device'));
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!['reason'], 'backup_failed');
    assert.match(String(cards[0]!['why']), /rezeis-2026-09-23\.sql\.gz/);
    assert.match(String(cards[0]!['nextSteps']), /«Создать бэкап»/);
  });

  it('a delivery that failed for good is its own card: the backup itself exists', () => {
    const { processor, cards } = processorRecording();
    processor.onFailed(
      {
        id: 'job-deliver-1',
        name: BACKUP_JOBS.DELIVER_TELEGRAM,
        attemptsMade: 3,
        opts: { attempts: 3 },
        data: { recordId: 'backup-1', filename: 'rezeis-2026-09-23.sql.gz' },
      } as never,
      new Error('relay unreachable'),
    );
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!['reason'], 'backup_delivery_failed');
    assert.match(String(cards[0]!['why']), /цел и лежит на сервере/);
  });
});
