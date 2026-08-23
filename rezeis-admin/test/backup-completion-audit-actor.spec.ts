import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BACKUP_JOBS } from '../src/modules/backup/backup.constants';
import { BackupProcessor } from '../src/modules/backup/backup.processor';
import { EVENT_TYPES } from '../src/common/services/system-events.service';

/**
 * Every restore was attributed to "system"
 * ────────────────────────────────────────
 * Backup and restore COMPLETION events were persisted through
 * `SystemEventsService.info`, which cannot carry `adminId` — so
 * `persistEvent` wrote `adminUserId: null` and `ipAddress: 'system'`, and the
 * audit page showed "system" as the actor for the single most destructive
 * operation the panel has. The admin who pressed the button survived only as a
 * `metadata.initiatedBy` string, which nothing filters on.
 *
 * The job payload has carried the admin all along. It just never reached the
 * column an incident responder queries.
 */

interface EmittedEvent {
  readonly type: string;
  readonly adminId?: string | null;
  readonly metadata?: Record<string, unknown>;
}

function buildProcessor(emitted: EmittedEvent[]): BackupProcessor {
  return new BackupProcessor(
    {
      runRestore: async () => true,
      runMigrateDeploy: async () => true,
    } as never,
    {
      info: () => undefined,
      emit: (event: EmittedEvent) => emitted.push(event),
    } as never,
    { rehydrateMissingAssets: async () => null } as never,
  );
}

describe('restore completion — the audit row names the admin who started it', () => {
  it('carries the initiating admin into adminId, not only into metadata', async () => {
    const emitted: EmittedEvent[] = [];
    await buildProcessor(emitted).process({
      name: BACKUP_JOBS.RESTORE,
      data: { filename: 'rezeis-db.sql.gz', initiatedBy: 'admin-42' },
      updateProgress: async () => undefined,
    } as never);

    const event = emitted.find((entry) => entry.type === EVENT_TYPES.SYSTEM_RESTORE_COMPLETED);
    assert.ok(event, 'a restore must emit a completion event');
    assert.equal(
      event.adminId,
      'admin-42',
      'without this the audit page shows "system" as the actor for every restore',
    );
    assert.equal(event.metadata?.initiatedBy, 'admin-42');
  });

  it('leaves adminId null for a restore nobody initiated', async () => {
    // A scheduled or system-driven job genuinely has no admin. "system" is the
    // right answer there; it was only ever wrong as the answer for everything.
    const emitted: EmittedEvent[] = [];
    await buildProcessor(emitted).process({
      name: BACKUP_JOBS.RESTORE,
      data: { filename: 'rezeis-db.sql.gz', initiatedBy: null },
      updateProgress: async () => undefined,
    } as never);

    const event = emitted.find((entry) => entry.type === EVENT_TYPES.SYSTEM_RESTORE_COMPLETED);
    assert.ok(event);
    assert.equal(event.adminId, null);
  });

  it('records whether the archive was restored on an acknowledgement', async () => {
    const emitted: EmittedEvent[] = [];
    await buildProcessor(emitted).process({
      name: BACKUP_JOBS.RESTORE,
      data: { filename: 'foreign.sql.gz', initiatedBy: 'admin-42', allowForeignArchive: true },
      updateProgress: async () => undefined,
    } as never);

    const event = emitted.find((entry) => entry.type === EVENT_TYPES.SYSTEM_RESTORE_COMPLETED);
    assert.equal(event?.metadata?.allowForeignArchive, true);
  });
});
