import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as zlib from 'node:zlib';

import { BadRequestException } from '@nestjs/common';

import { BackupService } from '../src/modules/backup/services/backup.service';
import {
  PROVENANCE_MARKER,
  buildProvenanceTrailer,
  deriveProvenanceKey,
  readArchiveProvenance,
} from '../src/modules/backup/utils/backup-provenance.util';

/**
 * Restore validated two bytes and then ran whatever SQL it was given
 * ─────────────────────────────────────────────────────────────────
 * `restoreFromUpload` checked the gzip magic — `1f 8b`, two bytes — and then
 * `runRestore` piped the decompressed stream into `psql --single-transaction`
 * as the application's database role. A holder of `backups:run` could upload a
 * gzipped
 *
 *     INSERT INTO admin_users (login, role, …) VALUES ('mallory', 'DEV', …);
 *
 * and own the panel; or `DELETE FROM admin_audit_log`; or
 * `UPDATE admin_ip_allowlist SET is_active = false`. The `checksum` column was
 * computed FROM the uploaded file, so it attested to nothing.
 *
 * The control is admission: an archive must carry a provenance stamp this
 * deployment signed, or the caller must explicitly acknowledge a foreign
 * archive — and the controller only accepts that acknowledgement from an admin
 * who also holds `admins:edit` (asserted in
 * `backup-foreign-archive-consent.spec.ts`).
 *
 * Restoring another deployment's archive is a legitimate workflow — a server
 * migration — so the last two tests here exist to make sure the fix did not
 * quietly forbid it.
 */

const CRYPT_KEY = 'test-crypt-key-for-provenance';

/** The exact payload from the finding: valid gzip, hostile SQL. */
const MALICIOUS_SQL =
  "INSERT INTO admin_users (id, login, password_hash, role) "
  + "VALUES ('x', 'mallory', 'x', 'DEV');\n"
  + 'DELETE FROM admin_audit_log;\n'
  + 'UPDATE admin_ip_allowlist SET is_active = false;\n';

const HONEST_SQL = '-- pg_dump output\nCREATE TABLE public.plans (id text);\n';

let directory: string;
let previousLocation: string | undefined;
let previousKey: string | undefined;

before(async () => {
  previousLocation = process.env.BACKUP_LOCATION;
  previousKey = process.env.REZEIS_CRYPT_KEY;
  directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'rezeis-backup-provenance-'));
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

/** A `.sql.gz` with no stamp — what a foreign deployment (or an attacker) produces. */
async function writeUnstamped(name: string, sql: string): Promise<string> {
  const full = path.join(directory, name);
  await fsp.writeFile(full, zlib.gzipSync(Buffer.from(sql, 'utf8')));
  return full;
}

/** A `.sql.gz` stamped exactly the way `runDump` stamps one. */
async function writeStamped(name: string, sql: string, key = CRYPT_KEY): Promise<string> {
  const full = await writeUnstamped(name, sql);
  const payloadSha256 = createHash('sha256').update(await fsp.readFile(full)).digest('hex');
  await fsp.appendFile(full, buildProvenanceTrailer(payloadSha256, key));
  return full;
}

/**
 * The same trailer, but MAC'd with an HMAC key handed in from outside instead
 * of the one `deriveProvenanceKey` produces.
 *
 * This is how a stamp gets forged under a DIFFERENT derivation of the same
 * master key — the thing domain separation exists to stop. The trailer bytes
 * are built here rather than by `buildProvenanceTrailer` so the key is the only
 * variable; the first test below stamps through this helper with the genuine
 * derivation to prove the helper itself produces a verifiable trailer, so a
 * `signature_mismatch` from the others is the key and not a broken fixture.
 */
async function writeStampedWithHmacKey(
  name: string,
  sql: string,
  hmacKey: Buffer,
): Promise<string> {
  const full = await writeUnstamped(name, sql);
  const payloadSha256 = createHash('sha256').update(await fsp.readFile(full)).digest('hex');
  const body = `${PROVENANCE_MARKER} v1 ${payloadSha256}`;
  const mac = createHmac('sha256', hmacKey).update(body).digest('hex');
  await fsp.appendFile(full, zlib.gzipSync(Buffer.from(`\n${body} ${mac}\n`, 'utf8')));
  return full;
}

describe('backup archive provenance — the stamp survives what it is meant to survive', () => {
  it('accepts an archive this deployment stamped', async () => {
    const full = await writeStamped('stamped-ok.sql.gz', HONEST_SQL);
    const verdict = await readArchiveProvenance(full, CRYPT_KEY);
    assert.equal(verdict.status, 'native');
  });

  it('still gunzips to the original SQL, so psql reads the stamp as a comment', async () => {
    const full = await writeStamped('stamped-readable.sql.gz', HONEST_SQL);
    const text = zlib.gunzipSync(await fsp.readFile(full)).toString('utf8');
    assert.ok(text.startsWith(HONEST_SQL), 'the dump must be byte-identical up front');
    const trailer = text.slice(HONEST_SQL.length);
    assert.match(trailer, /^\n-- rezeis-backup-provenance v1 [0-9a-f]{64} [0-9a-f]{64}\n$/);
  });

  it('rejects an unstamped archive', async () => {
    const full = await writeUnstamped('unstamped.sql.gz', MALICIOUS_SQL);
    const verdict = await readArchiveProvenance(full, CRYPT_KEY);
    assert.deepEqual(verdict, { status: 'foreign', reason: 'unstamped' });
  });

  it('rejects an archive stamped with another deployment key', async () => {
    const full = await writeStamped('other-key.sql.gz', HONEST_SQL, 'a-different-deployment-key');
    const verdict = await readArchiveProvenance(full, CRYPT_KEY);
    assert.deepEqual(verdict, { status: 'foreign', reason: 'signature_mismatch' });
  });

  it('rejects a genuine stamp spliced onto somebody else s SQL', async () => {
    // The obvious forgery: take a stamp this deployment really did produce and
    // put it on a file of your own. The stamp covers the content, so it fails.
    const genuine = await writeStamped('genuine.sql.gz', HONEST_SQL);
    const genuineBytes = await fsp.readFile(genuine);
    const stampOnly = genuineBytes.subarray(
      zlib.gzipSync(Buffer.from(HONEST_SQL, 'utf8')).length,
    );
    const spliced = path.join(directory, 'spliced.sql.gz');
    await fsp.writeFile(spliced, Buffer.concat([
      zlib.gzipSync(Buffer.from(MALICIOUS_SQL, 'utf8')),
      stampOnly,
    ]));

    const verdict = await readArchiveProvenance(spliced, CRYPT_KEY);
    assert.deepEqual(verdict, { status: 'foreign', reason: 'content_mismatch' });
  });

  it('rejects SQL appended AFTER a genuine stamp', async () => {
    // The other half of the splice: leave the stamped file alone and add your
    // own member behind it, hoping the parser stops reading at the stamp.
    const full = await writeStamped('appended.sql.gz', HONEST_SQL);
    await fsp.appendFile(full, zlib.gzipSync(Buffer.from(MALICIOUS_SQL, 'utf8')));
    const verdict = await readArchiveProvenance(full, CRYPT_KEY);
    assert.equal(verdict.status, 'foreign');
  });

  it('rejects a stamped archive whose dump was edited afterwards', async () => {
    const full = await writeStamped('edited.sql.gz', HONEST_SQL);
    const bytes = await fsp.readFile(full);
    // Flip a byte inside the compressed dump, well clear of the trailer.
    const target = 20;
    bytes[target] = (bytes[target] ?? 0) ^ 0xff;
    await fsp.writeFile(full, bytes);
    const verdict = await readArchiveProvenance(full, CRYPT_KEY);
    assert.equal(verdict.status, 'foreign');
    assert.notEqual(verdict.status === 'foreign' ? verdict.reason : '', 'unstamped');
  });

  it('calls everything foreign when there is no crypt key to verify with', async () => {
    const full = await writeStamped('no-key.sql.gz', HONEST_SQL);
    const verdict = await readArchiveProvenance(full, '');
    assert.deepEqual(verdict, { status: 'foreign', reason: 'no_crypt_key' });
  });

  it('does not blow up on a file that is not gzip at all', async () => {
    const full = path.join(directory, 'garbage.sql.gz');
    await fsp.writeFile(full, randomBytes(2048));
    const verdict = await readArchiveProvenance(full, CRYPT_KEY);
    assert.equal(verdict.status, 'foreign');
  });
});

// ── Domain separation ───────────────────────────────────────────────────────

/**
 * Six things in this tree derive a key from the SAME master secret,
 * `REZEIS_CRYPT_KEY`, and they stay apart only because each one hashes it
 * behind its own literal prefix:
 *
 *     rezeis-admin:ai-config:         AES key   — ai-secret-cipher.ts
 *     rezeis-admin:backup-download:   HMAC key  — backup-download-token.util.ts
 *     rezeis-admin:backup-provenance: HMAC key  — this module
 *     rezeis-admin:oauth:             AES key   — oauth/crypto.service.ts
 *     rezeis-admin:payment-gateway:   AES key   — payment-gateway-secret-cipher.ts
 *     rezeis-admin:totp:              AES key   — two-factor/secret-cipher.ts
 *
 * Take the prefix out of `deriveProvenanceKey` and it returns the bare
 * `sha256(REZEIS_CRYPT_KEY)`: the value any module that forgot its own prefix
 * would also compute, and the value this construction had before separation
 * was added. `backup-download` is the one that matters most — same master key,
 * same module, same HMAC-SHA256 primitive — so a collision there means one key
 * signs both a download-URL bearer token and an "this archive may be piped
 * into psql" attestation.
 *
 * Every test above signs AND verifies through the same derivation, so all of
 * them agree with whatever that derivation happens to be; removing the prefix
 * leaves them green. These name the key from outside it.
 */
describe('deriveProvenanceKey — the stamp key belongs to the stamp and to nothing else', () => {
  it('is a fixed value, not merely whatever the module derives today', () => {
    // Hand-written. Recomputing the expectation from the same prefix string
    // the module uses would agree with any prefix at all, including none.
    assert.equal(
      deriveProvenanceKey(CRYPT_KEY).toString('hex'),
      '0d6d43e710318b61ecbd6f5d6ad9f3984332ff7be17c2ed3939839317e4bb9f6',
      'the stamp key changed; every archive this deployment ever stamped now reads as foreign',
    );
    assert.notEqual(
      deriveProvenanceKey(CRYPT_KEY).toString('hex'),
      // sha256(CRYPT_KEY), the un-separated derivation.
      '0125f6de19a0ea8bfbc3beed0ba38139e0f9cdd25bb42e03dee6248695101c8e',
      'the stamp key is the bare master key hash, shared with anything else that skips its prefix',
    );
    assert.notEqual(
      deriveProvenanceKey(CRYPT_KEY).toString('hex'),
      // sha256('rezeis-admin:backup-download:' + CRYPT_KEY), the sibling.
      'b9121b485b9b074690a20d6f09ed1c5a804f04e96e540d9a9c97672a24e7ebfd',
      'the stamp and the download token are signed with one key',
    );
  });

  it('accepts a stamp the fixture built with the genuine key — the fixture is sound', async () => {
    // Control. Without it a `signature_mismatch` below could just as well mean
    // `writeStampedWithHmacKey` builds a trailer nothing could ever verify.
    const full = await writeStampedWithHmacKey(
      'hand-stamped-genuine.sql.gz',
      HONEST_SQL,
      deriveProvenanceKey(CRYPT_KEY),
    );
    const verdict = await readArchiveProvenance(full, CRYPT_KEY);
    assert.equal(verdict.status, 'native');
  });

  it('refuses a stamp signed with the bare master key', async () => {
    const full = await writeStampedWithHmacKey(
      'hand-stamped-raw-key.sql.gz',
      MALICIOUS_SQL,
      createHash('sha256').update(CRYPT_KEY).digest(),
    );
    const verdict = await readArchiveProvenance(full, CRYPT_KEY);
    assert.deepEqual(
      verdict,
      { status: 'foreign', reason: 'signature_mismatch' },
      'a stamp made with the undomained key verified, so the separator is gone and any '
        + 'other holder of a bare sha256 of REZEIS_CRYPT_KEY can stamp SQL that restore will run',
    );
  });

  it('refuses a stamp signed with the sibling backup-download key', async () => {
    const full = await writeStampedWithHmacKey(
      'hand-stamped-sibling-key.sql.gz',
      MALICIOUS_SQL,
      createHash('sha256').update(`rezeis-admin:backup-download:${CRYPT_KEY}`).digest(),
    );
    const verdict = await readArchiveProvenance(full, CRYPT_KEY);
    assert.deepEqual(
      verdict,
      { status: 'foreign', reason: 'signature_mismatch' },
      'the download-token key also stamps archives — two purposes, one key',
    );
  });
});

// ── Admission ───────────────────────────────────────────────────────────────

interface Recorded {
  readonly created: unknown[];
  readonly enqueued: unknown[];
}

function createService(recorded: Recorded): BackupService {
  const prisma = {
    backupRecord: {
      create: async (input: unknown) => {
        recorded.created.push(input);
        return { id: 'rec-1' };
      },
      findMany: async () => [],
      delete: async () => undefined,
    },
    settings: { findFirst: async () => ({ systemNotifications: {} }) },
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
    {
      add: async (...args: unknown[]) => {
        recorded.enqueued.push(args);
        return { id: 'job-1' };
      },
    } as never,
  );
}

describe('restoreFromUpload — a gzip header is not a licence to run SQL', () => {
  let recorded: Recorded;

  beforeEach(() => {
    recorded = { created: [], enqueued: [] };
  });

  it('refuses a foreign archive that is a perfectly valid gzip', async () => {
    const name = 'uploaded-hostile.sql.gz';
    const full = await writeUnstamped(name, MALICIOUS_SQL);
    const service = createService(recorded);

    await assert.rejects(
      () => service.restoreFromUpload({ filename: name, path: full, size: 128 }, 'admin-1'),
      (err: unknown) => {
        assert.ok(err instanceof BadRequestException, `expected 400, got ${String(err)}`);
        assert.match(err.message, /cannot verify/i);
        return true;
      },
    );

    assert.deepEqual(recorded.enqueued, [], 'no restore job may be enqueued');
    assert.deepEqual(recorded.created, [], 'no BackupRecord may be left behind');
    // The file itself is gone, so it cannot be re-restored later through
    // `restore/:filename`, which would otherwise see a file the panel "knows".
    await assert.rejects(() => fsp.access(full));
  });

  it('accepts an archive this deployment produced, with no acknowledgement needed', async () => {
    const name = 'uploaded-native.sql.gz';
    const full = await writeStamped(name, HONEST_SQL);
    const service = createService(recorded);

    const result = await service.restoreFromUpload(
      { filename: name, path: full, size: 128 },
      'admin-1',
    );

    assert.equal(result.provenance.status, 'native');
    assert.equal(recorded.enqueued.length, 1);
    assert.equal(recorded.created.length, 1);
  });

  it('still allows a server migration — a foreign archive WITH the acknowledgement', async () => {
    // The workflow the fix must not break: an archive from the old server,
    // stamped with the old server's key, restored on the new one.
    const name = 'uploaded-migration.sql.gz';
    const full = await writeStamped(name, HONEST_SQL, 'the-old-servers-key');
    const service = createService(recorded);

    const result = await service.restoreFromUpload(
      { filename: name, path: full, size: 128 },
      'admin-1',
      { allowForeignArchive: true },
    );

    assert.equal(result.provenance.status, 'foreign');
    assert.equal(recorded.enqueued.length, 1);
    const jobData = (recorded.enqueued[0] as unknown[])[1] as Record<string, unknown>;
    assert.equal(
      jobData.allowForeignArchive,
      true,
      'the acknowledgement must travel to the worker, or the second check refuses it',
    );
  });
});

describe('restoreBackup / runRestore — the choke point checks again', () => {
  it('refuses a stored archive that cannot be verified', async () => {
    const name = 'stored-foreign.sql.gz';
    await writeUnstamped(name, MALICIOUS_SQL);
    const recorded: Recorded = { created: [], enqueued: [] };
    const service = createService(recorded);

    await assert.rejects(
      () => service.restoreBackup(name, 'admin-1'),
      (err: unknown) => err instanceof BadRequestException,
    );
    assert.deepEqual(recorded.enqueued, []);
  });

  it('refuses at runRestore too, so a file swapped after admission never reaches psql', async () => {
    // The job was queued against a verified file; the file changed since. The
    // worker must not trust the queue's opinion of a file it can re-check.
    const name = 'swapped.sql.gz';
    const full = await writeStamped(name, HONEST_SQL);
    const recorded: Recorded = { created: [], enqueued: [] };
    const service = createService(recorded);
    await service.restoreBackup(name, 'admin-1');

    await fsp.writeFile(full, zlib.gzipSync(Buffer.from(MALICIOUS_SQL, 'utf8')));

    await assert.rejects(
      () => service.runRestore(name),
      (err: unknown) => {
        assert.ok(err instanceof BadRequestException, `expected 400, got ${String(err)}`);
        return true;
      },
    );
  });

  it('lets the worker through when the operator acknowledged the archive', async () => {
    // Not asserted by running psql — that would need a database. The property
    // under test is that admission does not throw; `runRestore` gets as far as
    // spawning, and a spawn failure is a different error than a refusal.
    const name = 'ack-foreign.sql.gz';
    await writeUnstamped(name, HONEST_SQL);
    const recorded: Recorded = { created: [], enqueued: [] };
    const service = createService(recorded);

    const err = await service
      .runRestore(name, { allowForeignArchive: true })
      .then(() => null, (caught: unknown) => caught);

    assert.ok(
      !(err instanceof BadRequestException),
      `admission must not refuse an acknowledged archive, got: ${String(err)}`,
    );
  });
});
