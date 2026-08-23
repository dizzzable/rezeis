import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as zlib from 'node:zlib';

import { BackupService } from '../src/modules/backup/services/backup.service';
import { buildProvenanceTrailer } from '../src/modules/backup/utils/backup-provenance.util';

/**
 * Retention never ran on the upload path, and dumps were world-readable
 * ────────────────────────────────────────────────────────────────────
 * `applyRetention()` had exactly one caller: the tail of a successful
 * `runDump`. Uploading a backup never triggered it, so N uploads of up to 1 GiB
 * each accumulated untouched on the same volume the next dump needs space on.
 *
 * And every backup file was written by `createWriteStream` with the default
 * mode — 0644 after a 0022 umask — on a volume shared with the worker. Both
 * services run as the same uid (1001, `rezeis`, via `su-exec` in
 * `docker-entrypoint.sh`), so 0600 costs the worker nothing.
 */

const CRYPT_KEY = 'housekeeping-crypt-key';

let directory: string;
let previousLocation: string | undefined;
let previousKey: string | undefined;

before(async () => {
  previousLocation = process.env.BACKUP_LOCATION;
  previousKey = process.env.REZEIS_CRYPT_KEY;
  directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'rezeis-backup-housekeeping-'));
  process.env.BACKUP_LOCATION = directory;
  process.env.REZEIS_CRYPT_KEY = CRYPT_KEY;
});

after(async () => {
  if (previousLocation === undefined) delete process.env.BACKUP_LOCATION;
  else process.env.BACKUP_LOCATION = previousLocation;
  if (previousKey === undefined) delete process.env.REZEIS_CRYPT_KEY;
  else process.env.REZEIS_CRYPT_KEY = previousKey;
  await fsp.rm(directory, { recursive: true, force: true }).catch(() => undefined);
});

async function writeStamped(name: string): Promise<string> {
  const full = path.join(directory, name);
  await fsp.writeFile(full, zlib.gzipSync(Buffer.from('-- dump\nSELECT 1;\n', 'utf8')), {
    mode: 0o644,
  });
  const payloadSha256 = createHash('sha256').update(await fsp.readFile(full)).digest('hex');
  await fsp.appendFile(full, buildProvenanceTrailer(payloadSha256, CRYPT_KEY));
  return full;
}

interface Recorded {
  readonly deleted: string[];
  readonly listed: number;
}

function createService(options: {
  readonly existing: { id: string; filename: string; deliveryChannel: string }[];
  readonly maxKeep: number;
  readonly recorded: { deleted: string[]; listed: number };
}): BackupService {
  const prisma = {
    backupRecord: {
      create: async () => ({ id: 'rec-new' }),
      findMany: async () => {
        options.recorded.listed += 1;
        return options.existing;
      },
      delete: async (input: { where: { id: string } }) => {
        options.recorded.deleted.push(input.where.id);
        return {};
      },
    },
    settings: {
      findFirst: async () => ({
        systemNotifications: { backup: { maxKeep: options.maxKeep, telegram: { enabled: false } } },
      }),
    },
  };
  return new BackupService(
    {
      host: 'postgres',
      port: 5432,
      user: 'rezeis',
      password: 'not-a-real-password',
      name: 'rezeis',
    } as never,
    prisma as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined } as never,
    { getDecryptedBotToken: async () => null } as never,
    { add: async () => ({ id: 'job-1' }) } as never,
  );
}

describe('restoreFromUpload — housekeeping runs on the path that fills the disk', () => {
  it('applies retention after registering an upload', async () => {
    const name = 'uploaded-retention.sql.gz';
    const full = await writeStamped(name);
    // Three older records against a maxKeep of 1: retention must prune.
    const recorded: Recorded & { deleted: string[]; listed: number } = { deleted: [], listed: 0 };
    const service = createService({
      maxKeep: 1,
      recorded,
      existing: [
        { id: 'old-1', filename: 'old-1.sql.gz', deliveryChannel: 'local' },
        { id: 'old-2', filename: 'old-2.sql.gz', deliveryChannel: 'local' },
        { id: 'old-3', filename: 'old-3.sql.gz', deliveryChannel: 'telegram' },
      ],
    });

    await service.restoreFromUpload({ filename: name, path: full, size: 128 }, 'admin-1');

    assert.ok(recorded.listed > 0, 'retention must have read the record list');
    assert.deepEqual(
      recorded.deleted.sort(),
      ['old-2', 'old-3'],
      'everything past maxKeep is pruned, newest first and sole copies last',
    );
  });

  it('does not let a retention failure block a disaster-recovery restore', async () => {
    const name = 'uploaded-retention-broken.sql.gz';
    const full = await writeStamped(name);
    const recorded = { deleted: [] as string[], listed: 0 };
    const service = createService({ maxKeep: 1, recorded, existing: [] });
    // Break the listing retention depends on, after the record write.
    (service as unknown as { prismaService: { backupRecord: { findMany: () => Promise<never> } } })
      .prismaService.backupRecord.findMany = async () => {
        throw new Error('connection reset');
      };

    const result = await service.restoreFromUpload(
      { filename: name, path: full, size: 128 },
      'admin-1',
    );

    assert.equal(result.jobId, 'job-1', 'the restore must still be enqueued');
  });
});

describe('uploaded backups are not left world-readable', () => {
  it('tightens the uploaded file to owner-only', async () => {
    // Asserted on the CALL, not on `stat().mode`. Windows has no POSIX mode
    // bits — `chmod` toggles the read-only attribute there and `stat` reports
    // 0666 — so a mode assertion would be a test that only runs on CI and is
    // skipped on every developer machine in this project, i.e. a test nobody
    // ever sees fail. `fsp.chmod` resolves off the shared `node:fs` promises
    // object at call time, so patching it observes the real call the service
    // makes.
    const fs = await import('node:fs');
    const original = fs.promises.chmod;
    const chmodCalls: { path: string; mode: number }[] = [];
    (fs.promises as { chmod: unknown }).chmod = async (target: string, mode: number) => {
      chmodCalls.push({ path: String(target), mode });
      return original(target, mode);
    };
    try {
      const name = 'uploaded-mode.sql.gz';
      const full = await writeStamped(name);
      const recorded = { deleted: [] as string[], listed: 0 };
      const service = createService({ maxKeep: 10, recorded, existing: [] });

      await service.restoreFromUpload({ filename: name, path: full, size: 128 }, 'admin-1');

      const call = chmodCalls.find((entry) => entry.path.endsWith(name));
      assert.ok(call, 'an uploaded dump must have its permissions tightened');
      assert.equal(
        (call.mode & 0o777).toString(8),
        '600',
        'a full-database dump must not stay group/world readable on the shared volume',
      );
      if (process.platform !== 'win32') {
        assert.equal(((await fsp.stat(full)).mode & 0o777).toString(8), '600');
      }
    } finally {
      (fs.promises as { chmod: unknown }).chmod = original;
    }
  });
});
