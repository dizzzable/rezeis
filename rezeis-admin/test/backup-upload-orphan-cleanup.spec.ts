import 'reflect-metadata';

import assert from 'node:assert/strict';
import { mkdtempSync, promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import * as zlib from 'node:zlib';
import { after, beforeEach, describe, it } from 'node:test';

import {
  BadRequestException,
  ForbiddenException,
  PayloadTooLargeException,
  ValidationPipe,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { INTERCEPTORS_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import type { Request } from 'express';

/**
 * A refused upload stayed on disk forever, and nothing could ever see it
 * ─────────────────────────────────────────────────────────────────────
 * `restoreUploadInterceptor` uses multer DISK storage, so the whole archive —
 * default cap 1 GiB, hard cap 2 GiB — is written into the backup directory
 * before the handler's first line runs. `restoreFromUpload` knows this: every
 * refusal it makes unlinks the file first. The legs that throw BEFORE it did
 * not.
 *
 * `resolveForeignArchiveConsent` is called on the line above the service, and
 * it throws `ForbiddenException` for an admin who acknowledges a foreign
 * archive without holding `admins:edit`. Nothing deleted the upload, and
 * nothing ever could:
 *
 *   * no `BackupRecord` row is written, so `GET /admin/backup` cannot list it
 *     and `DELETE /admin/backup/:id` has no id to target;
 *   * `applyRetention` iterates `backupRecord.findMany` and there is no
 *     `readdir` anywhere in `src/modules/backup`, so nothing reclaims it.
 *
 * One gigabyte per refused attempt, invisible and permanent, on the volume the
 * next dump needs space on. The asymmetry between the two legs is the tell:
 * the 400 was written with cleanup in mind and the 403 was not.
 *
 * Every assertion below is on the FILE — present or absent at a captured,
 * real path — never on "a cleanup helper was called". A helper called with the
 * wrong path leaves exactly the orphan this file exists to prevent, and would
 * satisfy any assertion phrased about the call.
 */

// `restoreUploadInterceptor` is built at module load: `limits.fileSize` is
// baked in by `resolveUploadMaxBytes()` while the controller module is being
// required. Both variables are therefore set BEFORE that import below.
// TypeScript emits `require` calls positionally, so an assignment written
// between two imports really does run between them — checked against the
// emitted JS rather than assumed.
//
// Neither variable is new: `BACKUP_LOCATION` and `BACKUP_MAX_UPLOAD_BYTES` are
// both already read by production code, and the sibling backup specs set the
// first one the same way. Nothing here adds configuration.
const UPLOAD_DIR = mkdtempSync(path.join(os.tmpdir(), 'rezeis-upload-orphan-'));
/** Small enough to exceed with a few hundred bytes rather than a gigabyte. */
const UPLOAD_LIMIT_BYTES = 512;
process.env.BACKUP_LOCATION = UPLOAD_DIR;
process.env.BACKUP_MAX_UPLOAD_BYTES = String(UPLOAD_LIMIT_BYTES);

import { AdminBackupController } from '../src/modules/backup/controllers/admin-backup.controller';
import type { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { BackupService } from '../src/modules/backup/services/backup.service';

after(async () => {
  await fsp.rm(UPLOAD_DIR, { recursive: true, force: true }).catch(() => undefined);
});

const ADMIN: CurrentAdminInterface = {
  id: 'admin-7',
  login: 'ops',
  email: null,
  name: null,
  role: 'ADMIN' as CurrentAdminInterface['role'],
  isActive: true,
  tokenVersion: 1,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  lastLoginAt: null,
  lastLoginIp: null,
  rbacRoleId: 'role-ops',
  mustChangePassword: false,
};

function fakeRequest(): Request {
  return {
    body: {},
    ip: '198.51.100.9',
    headers: { 'user-agent': 'curl/8', 'x-request-id': 'req-42' },
    socket: { remoteAddress: '198.51.100.9' },
  } as unknown as Request;
}

async function exists(target: string): Promise<boolean> {
  return fsp.access(target).then(
    () => true,
    () => false,
  );
}

/** A real file where multer would really have put one. */
async function landUpload(filename: string, bytes = 'gzip-ish payload'): Promise<{
  filename: string;
  path: string;
  size: number;
}> {
  const full = path.join(UPLOAD_DIR, filename);
  await fsp.writeFile(full, bytes);
  return { filename, path: full, size: Buffer.byteLength(bytes) };
}

interface Harness {
  readonly controller: AdminBackupController;
  /** Ordered log across every double, so ordering is assertable. */
  readonly calls: string[];
  /** The `file` argument `restoreFromUpload` was handed, if it was reached. */
  readonly adopted: Array<{ filename?: string; path?: string }>;
}

function buildHarness(options: {
  readonly heldPermissions?: readonly string[];
  readonly rbacError?: unknown;
} = {}): Harness {
  const calls: string[] = [];
  const adopted: Array<{ filename?: string; path?: string }> = [];

  const backupService = {
    restoreFromUpload: async (file: { filename?: string; path?: string }) => {
      calls.push('restoreFromUpload');
      adopted.push(file);
      return { jobId: 'job-1', provenance: { status: 'foreign', reason: 'unstamped' } };
    },
  };

  const prismaService = {
    adminAuditLog: {
      create: async (input: { data: { action: string } }) => {
        calls.push(`audit:${input.data.action}`);
        return {};
      },
    },
  };

  const rbacService = {
    getEffectivePermissions: async () => {
      calls.push('rbac:getEffectivePermissions');
      if (options.rbacError !== undefined) throw options.rbacError;
      return (options.heldPermissions ?? []).map((token) => {
        const separator = token.indexOf(':');
        return { resource: token.slice(0, separator), action: token.slice(separator + 1) };
      });
    },
  };

  return {
    controller: new AdminBackupController(
      backupService as never,
      prismaService as never,
      rbacService as never,
    ),
    calls,
    adopted,
  };
}

describe('POST admin/backup/restore-upload — a refused upload does not stay on disk', () => {
  it('deletes the archive when the acknowledgement is refused for want of admins:edit', async () => {
    const harness = buildHarness({ heldPermissions: ['backups:run'] });
    const file = await landUpload('uploaded-db-refused.sql.gz');
    assert.ok(await exists(file.path), 'fixture: the upload must be on disk to begin with');

    await assert.rejects(
      () => harness.controller.restoreUpload(file as never, ADMIN, fakeRequest(), 'true'),
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenException, `expected 403, got ${String(err)}`);
        return true;
      },
    );

    assert.equal(
      await exists(file.path),
      false,
      'the refused upload is still in the backup directory. No BackupRecord names it, so it '
        + 'cannot be listed, deleted or reclaimed by retention — it is there until someone '
        + 'logs into the host',
    );
  });

  it('deletes the file that was uploaded and nothing else', async () => {
    // The assertion a `safeUnlink`-was-called test cannot make. Handed the
    // wrong path — the filename instead of the full path, the directory, a
    // stale variable — cleanup "runs" and the orphan survives untouched.
    const harness = buildHarness({ heldPermissions: [] });
    const bystander = await landUpload('rezeis-db-2026-01-01.sql.gz', 'a real backup');
    const file = await landUpload('uploaded-db-targeted.sql.gz');

    await assert.rejects(
      () => harness.controller.restoreUpload(file as never, ADMIN, fakeRequest(), 'true'),
      ForbiddenException,
    );

    assert.equal(await exists(file.path), false, 'the uploaded archive survived the refusal');
    assert.equal(
      await exists(bystander.path),
      true,
      'cleanup deleted a file it was not given — an existing backup was destroyed by a '
        + 'permission refusal',
    );
  });

  it('never hands a refused upload to the service, and cleans up in that order', async () => {
    const harness = buildHarness({ heldPermissions: [] });
    const file = await landUpload('uploaded-db-order.sql.gz');

    await assert.rejects(
      () => harness.controller.restoreUpload(file as never, ADMIN, fakeRequest(), 'true'),
      ForbiddenException,
    );

    assert.deepStrictEqual(
      harness.calls,
      ['rbac:getEffectivePermissions'],
      'the refusal must happen before the service is involved and must not audit a restore '
        + 'that never started',
    );
    assert.deepStrictEqual(harness.adopted, [], 'the service was handed a file it must not see');
    assert.equal(await exists(file.path), false);
  });

  it('deletes the archive when the permission lookup itself fails', async () => {
    // The same line, a different cause, and the one that hits a legitimate
    // operator: `getEffectivePermissions` reaching a database that is briefly
    // unavailable strands the upload of an admin who DOES hold `admins:edit`.
    const harness = buildHarness({ rbacError: new Error('connection terminated unexpectedly') });
    const file = await landUpload('uploaded-db-rbac-down.sql.gz');

    await assert.rejects(
      () => harness.controller.restoreUpload(file as never, ADMIN, fakeRequest(), 'true'),
      /connection terminated/u,
    );

    assert.equal(
      await exists(file.path),
      false,
      'only the ForbiddenException leg was cleaned up; any other throw from the same call '
        + 'strands the upload exactly as before',
    );
  });
});

describe('POST admin/backup/restore-upload — an accepted upload is left alone', () => {
  it('keeps the archive when the acknowledgement is granted', async () => {
    // The other half of the fix. Cleanup that fires on the success path deletes
    // the archive out from under the restore job that was just enqueued.
    const harness = buildHarness({ heldPermissions: ['admins:edit'] });
    const file = await landUpload('uploaded-db-accepted.sql.gz');

    await harness.controller.restoreUpload(file as never, ADMIN, fakeRequest(), 'true');

    assert.equal(
      await exists(file.path),
      true,
      'an accepted upload was deleted; the enqueued restore job has nothing left to read',
    );
    assert.deepStrictEqual(harness.adopted.map((entry) => entry.path), [file.path]);
  });

  it('keeps the archive when no acknowledgement was sent at all', async () => {
    // No acknowledgement means RBAC is never consulted and nothing throws, so
    // the file goes to the service untouched — where its own refusal path, if
    // the archive turns out to be foreign, does the unlinking.
    const harness = buildHarness({ heldPermissions: [] });
    const file = await landUpload('uploaded-db-no-ack.sql.gz');

    await harness.controller.restoreUpload(file as never, ADMIN, fakeRequest());

    assert.equal(await exists(file.path), true);
    assert.deepStrictEqual(
      harness.calls,
      ['restoreFromUpload', 'audit:backup.restore_started'],
      'the permission lookup ran for a request that carried no acknowledgement',
    );
  });

  it('has nothing to discard when no file part arrived', async () => {
    const harness = buildHarness();
    await assert.rejects(
      () => harness.controller.restoreUpload(undefined, ADMIN, fakeRequest(), 'true'),
      BadRequestException,
    );
    assert.deepStrictEqual(harness.calls, []);
  });
});

// ── The interceptor's own refusals ──────────────────────────────────────────

/**
 * Does multer strand a partial file when the upload exceeds `limits.fileSize`?
 *
 * Reported as a sibling of the defect above. It is NOT true on multer 2.2.0
 * (pinned by the `overrides` block in `package.json`), and these tests exist to
 * keep it untrue rather than to fix anything: `fileStream.on('limit')` sets
 * `aborting`, `storage._handleFile`'s callback then pushes the partially
 * written file into `uploadedFiles`, and `finishAbort` unlinks everything in
 * that list through `DiskStorage._removeFile`. Reading that is not proof, so
 * the real interceptor is driven with a real oversized multipart body here.
 *
 * The interceptor is taken off the route's own metadata rather than exported
 * for the test, which also pins the fact that `restoreUpload` still carries it
 * — an upload route that lost its interceptor would fail these instead of
 * silently accepting unbounded bodies.
 */
function routeInterceptor(): NestInterceptor {
  const interceptors = Reflect.getMetadata(
    INTERCEPTORS_METADATA,
    AdminBackupController.prototype.restoreUpload,
  ) as Array<new () => NestInterceptor> | undefined;
  assert.ok(
    interceptors !== undefined && interceptors.length === 1,
    'restoreUpload no longer carries exactly one @UseInterceptors entry',
  );
  return new interceptors[0]!();
}

const BOUNDARY = '----rezeisUploadOrphanBoundary';

function multipartBody(field: string, filename: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\n`
        + `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n`
        + 'Content-Type: application/gzip\r\n\r\n',
      'utf8',
    ),
    payload,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'utf8'),
  ]);
}

/** Runs the real interceptor over a real multipart request. */
async function runInterceptor(body: Buffer): Promise<Request> {
  const request = Readable.from([body]) as unknown as Request;
  (request as unknown as { headers: Record<string, string> }).headers = {
    'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    'content-length': String(body.length),
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
  const next = { handle: () => null } as unknown as CallHandler;
  await routeInterceptor().intercept(context, next);
  return request;
}

async function directoryEntries(): Promise<string[]> {
  return (await fsp.readdir(UPLOAD_DIR)).sort();
}

describe('restoreUploadInterceptor — multer cleans up after its own refusals', () => {
  beforeEach(async () => {
    for (const entry of await directoryEntries()) {
      await fsp.rm(path.join(UPLOAD_DIR, entry), { force: true });
    }
  });

  it('writes the file when it is within the limit — the control', async () => {
    // Without this the size test below would pass just as happily if the
    // harness never managed to write anything at all, which is the failure
    // mode that makes a cleanup test worthless.
    const request = await runInterceptor(
      multipartBody('file', 'small.sql.gz', Buffer.alloc(UPLOAD_LIMIT_BYTES - 64, 0x41)),
    );

    const stored = (request as unknown as { file?: { path: string; size: number } }).file;
    assert.ok(stored, 'multer stored no file, so nothing below is testing cleanup');
    assert.equal(stored.size, UPLOAD_LIMIT_BYTES - 64);
    assert.deepStrictEqual(await directoryEntries(), [path.basename(stored.path)]);
  });

  it('leaves nothing behind when the upload exceeds limits.fileSize', async () => {
    await assert.rejects(
      () => runInterceptor(multipartBody('file', 'huge.sql.gz', Buffer.alloc(UPLOAD_LIMIT_BYTES * 4, 0x42))),
      (err: unknown) => {
        assert.ok(err instanceof PayloadTooLargeException, `expected 413, got ${String(err)}`);
        return true;
      },
    );

    assert.deepStrictEqual(
      await directoryEntries(),
      [],
      'multer kept the bytes it had already written when the limit tripped, so an oversized '
        + 'upload strands a partial archive the same way a refused one used to',
    );
  });

  it('leaves nothing behind when the file part carries an unexpected field name', async () => {
    await assert.rejects(
      () => runInterceptor(multipartBody('archive', 'wrong-field.sql.gz', Buffer.alloc(64, 0x43))),
      BadRequestException,
    );

    assert.deepStrictEqual(await directoryEntries(), []);
  });
});

// ── The pipe leg the handler's try/catch cannot reach ───────────────────────

/**
 * Inert today, strands tomorrow, and nothing would notice.
 *
 * Pipes run inside the interceptor chain and BEFORE the method body
 * (`router-execution-context.js:36-46`), so the archive is already on disk and
 * the handler's `try` has not started when a pipe throws. No cleanup in the
 * method body can cover it, and a route-level filter or interceptor that
 * unlinked on any downstream error would also fire AFTER the service adopted
 * the file — deleting an archive a queued restore job is about to read, which
 * is the worse bug. So the leg is left open deliberately and pinned here
 * instead, next to a comment on the parameter that names the trap.
 *
 * These two assertions are the pin. They are not decorative: each drives the
 * real thing (the real global pipe configuration, the route's own recorded
 * metadata) and fails on the exact edit that would open the leg.
 */
describe('POST admin/backup/restore-upload — nothing on this route validates before the body runs', () => {
  function bodyParamIndex(): number {
    const routeArgs = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      AdminBackupController,
      'restoreUpload',
    ) as Record<string, { index: number; data?: unknown }> | undefined;
    assert.ok(routeArgs, 'restoreUpload records no parameter metadata at all');
    const entry = Object.values(routeArgs).find(
      (candidate) => candidate.data === 'acknowledgeForeignArchive',
    );
    assert.ok(entry, 'the acknowledgement is no longer read with @Body(...)');
    return entry.index;
  }

  it('passes the acknowledgement through the real global ValidationPipe untouched', async () => {
    const paramtypes = Reflect.getMetadata(
      'design:paramtypes',
      AdminBackupController.prototype,
      'restoreUpload',
    ) as unknown[];
    const metatype = paramtypes[bodyParamIndex()];

    assert.equal(
      metatype,
      Object,
      'the acknowledgement now has a class metatype, so the global ValidationPipe will '
        + 'validate it — and it runs BEFORE the handler body, with the upload already on '
        + 'disk and outside the try/catch that cleans up. A rejected DTO now strands up to '
        + '2 GiB permanently. Move the cleanup before adding the DTO',
    );

    // Constructed exactly as `main.ts` constructs it.
    const pipe = new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    });
    const passedThrough = await pipe.transform('true', {
      type: 'body',
      data: 'acknowledgeForeignArchive',
      metatype: metatype as never,
    });

    assert.equal(
      passedThrough,
      'true',
      'the global pipe now rewrites or rejects this parameter, which it does before the '
        + 'handler body and therefore outside its cleanup',
    );
  });

  it('carries no parameter-level pipe on any argument', async () => {
    // `@UploadedFile(new ParseFilePipe(...))` is the likely future addition on
    // an upload route, and it throws in exactly the same place: after multer
    // wrote the file, before the handler can clean anything up.
    const routeArgs = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      AdminBackupController,
      'restoreUpload',
    ) as Record<string, { index: number; pipes?: unknown[] }>;

    const withPipes = Object.entries(routeArgs)
      .filter(([, entry]) => (entry.pipes ?? []).length > 0)
      .map(([key]) => key);

    assert.deepStrictEqual(
      withPipes,
      [],
      'a parameter pipe was added to restoreUpload. It runs before the method body, so it '
        + 'throws with the upload on disk and outside the cleanup — the stranded-archive bug, '
        + 'reintroduced through a door the handler cannot reach',
    );
  });
});

// ── The other side of the same gap, inside the service ──────────────────────

/**
 * `restoreFromUpload` unlinked on every refusal it made, and on none of its
 * failures.
 *
 * `admitArchiveForRestore` cleans up when it says no. After it, three things
 * ran with the archive on disk and still nameless — `fsp.stat`,
 * `sha256OfFile` (a full read of up to 2 GiB) and `backupRecord.create` — and
 * a throw from any of them left the same permanent orphan the controller's
 * 403 used to: no row to list it, no id to delete it, no `readdir` to reclaim
 * it.
 *
 * The boundary is the successful `create`, and the tests below assert BOTH
 * sides of it. `backupQueue.add` runs after that row exists and can fail on
 * its own (Redis down); cleaning up there would delete a disaster-recovery
 * upload that the operator can otherwise restore again from the list, and
 * leave a BackupRecord pointing at nothing. That test is this file's
 * surviving-bystander: it is what makes "unlink slightly too late" a failure
 * rather than a nicety.
 */
interface ServiceHarness {
  readonly service: BackupService;
  readonly calls: string[];
}

function createService(options: {
  readonly createError?: unknown;
  readonly enqueueError?: unknown;
} = {}): ServiceHarness {
  const calls: string[] = [];
  const prisma = {
    backupRecord: {
      create: async () => {
        calls.push('backupRecord.create');
        if (options.createError !== undefined) throw options.createError;
        return { id: 'rec-1' };
      },
      findMany: async () => [],
      delete: async () => undefined,
    },
    settings: { findFirst: async () => ({ systemNotifications: {} }) },
  };
  const service = new BackupService(
    {
      host: 'postgres',
      port: 5432,
      user: 'rezeis',
      password: 'not-a-real-password',
      name: 'rezeis',
    } as never,
    prisma as never,
    {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      emit: () => undefined,
    } as never,
    { getDecryptedBotToken: async () => null } as never,
    {
      add: async () => {
        calls.push('backupQueue.add');
        if (options.enqueueError !== undefined) throw options.enqueueError;
        return { id: 'job-1' };
      },
    } as never,
  );
  return { service, calls };
}

/** A valid gzip, admitted only because the caller acknowledged it. */
async function landGzipUpload(filename: string): Promise<{ filename: string; path: string }> {
  const full = path.join(UPLOAD_DIR, filename);
  await fsp.writeFile(full, zlib.gzipSync(Buffer.from('-- pg_dump output\n', 'utf8')));
  return { filename, path: full };
}

describe('restoreFromUpload — the archive is an orphan until a BackupRecord names it', () => {
  it('deletes the upload when the BackupRecord cannot be written', async () => {
    const harness = createService({ createError: new Error('connection terminated unexpectedly') });
    const bystander = await landGzipUpload('rezeis-db-existing.sql.gz');
    const file = await landGzipUpload('uploaded-db-create-fails.sql.gz');

    await assert.rejects(
      () =>
        harness.service.restoreFromUpload(
          { filename: file.filename, path: file.path, size: 64 },
          'admin-1',
          { allowForeignArchive: true },
        ),
      /connection terminated/u,
    );

    assert.equal(
      await exists(file.path),
      false,
      'the archive was admitted, the row failed, and the file stayed. Nothing names it, so it '
        + 'cannot be listed, deleted or reclaimed by retention',
    );
    assert.equal(
      await exists(bystander.path),
      true,
      'cleanup deleted a file it was not given — an existing backup was destroyed by a '
        + 'failed insert',
    );
    assert.deepStrictEqual(
      harness.calls,
      ['backupRecord.create'],
      'the restore job must not be enqueued for an upload that was never recorded',
    );
  });

  it('KEEPS the upload once the BackupRecord exists, even when the queue is down', async () => {
    // The boundary, asserted from the far side. Once the row exists the file is
    // listed, deletable and inside retention — it is not an orphan, and the
    // operator can restore it again from the list. Unlinking here would delete
    // a disaster-recovery upload and leave a record pointing at nothing.
    const harness = createService({ enqueueError: new Error('ECONNREFUSED 127.0.0.1:6379') });
    const file = await landGzipUpload('uploaded-db-queue-down.sql.gz');

    await assert.rejects(
      () =>
        harness.service.restoreFromUpload(
          { filename: file.filename, path: file.path, size: 64 },
          'admin-1',
          { allowForeignArchive: true },
        ),
      /ECONNREFUSED/u,
    );

    assert.equal(
      await exists(file.path),
      true,
      'cleanup reached past the BackupRecord and deleted an adopted archive — the row now '
        + 'points at a file that is gone, and a disaster-recovery upload was destroyed by a '
        + 'Redis outage',
    );
    assert.deepStrictEqual(harness.calls, ['backupRecord.create', 'backupQueue.add']);
  });

  it('keeps the upload on the happy path — the control', async () => {
    // Without this, every assertion above would read the same on a
    // `restoreFromUpload` that deletes unconditionally and never records
    // anything.
    const harness = createService();
    const file = await landGzipUpload('uploaded-db-happy.sql.gz');

    const result = await harness.service.restoreFromUpload(
      { filename: file.filename, path: file.path, size: 64 },
      'admin-1',
      { allowForeignArchive: true },
    );

    assert.equal(result.provenance.status, 'foreign');
    assert.equal(await exists(file.path), true, 'a successful upload was deleted');
    assert.deepStrictEqual(harness.calls, ['backupRecord.create', 'backupQueue.add']);
  });
});
