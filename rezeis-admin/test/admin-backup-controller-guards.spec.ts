import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ForbiddenException } from '@nestjs/common';
import { BackupScope } from '@prisma/client';
import type { Request, Response } from 'express';

import { AdminBackupController } from '../src/modules/backup/controllers/admin-backup.controller';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { effectiveRoutePermissions } from './helpers/controller-routes';

/**
 * An unencrypted full-database dump released by a "view" permission, and a
 * module that audited none of it
 * ──────────────────────────────────────────────────────────────────────────
 * Two findings, one controller.
 *
 *   * `GET /admin/backup/download/:filename` required `backups:view`. There is
 *     no encryption anywhere in the backup module — the file is
 *     `pg_dump | gzip` and inside it sits every customer, every transaction,
 *     admin password hashes, the SMTP password in the clear and every webhook
 *     secret. A permission whose name promises "may see the list" handed over
 *     the database.
 *   * Nothing in `src/modules/backup/**` or `src/modules/config-portability/**`
 *     wrote an `adminAuditLog` row. Not export, not import, not download, not
 *     delete, not restore. An incident responder asking "who took a copy of
 *     the database, and when" had nothing to read.
 *
 * The actor for every row comes from `@CurrentAdmin()` — the JWT-proved
 * principal — and never from the request body, which is asserted below by
 * sending a body that names somebody else.
 */

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

interface AuditRow {
  readonly action: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly metadata: Record<string, unknown>;
  readonly adminUser: { connect: { id: string } };
}

function fakeRequest(body: Record<string, unknown> = {}): Request {
  return {
    body,
    ip: '198.51.100.9',
    headers: { 'user-agent': 'curl/8', 'x-request-id': 'req-42' },
    socket: { remoteAddress: '198.51.100.9' },
  } as unknown as Request;
}

function fakeResponse(): { response: Response; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const response = {
    setHeader: (key: string, value: string) => {
      headers[key] = value;
    },
  } as unknown as Response;
  return { response, headers };
}

interface Harness {
  readonly controller: AdminBackupController;
  readonly audits: AuditRow[];
  readonly calls: string[];
}

function buildHarness(options: { readonly heldPermissions?: readonly string[] } = {}): Harness {
  const audits: AuditRow[] = [];
  const calls: string[] = [];

  const backupService = {
    createBackup: async () => {
      calls.push('createBackup');
      return { id: 'rec-1', filename: 'rezeis-db.sql.gz', scope: BackupScope.DB };
    },
    deleteBackup: async () => {
      calls.push('deleteBackup');
    },
    updateSettings: async () => {
      calls.push('updateSettings');
      return {
        autoEnabled: true,
        intervalHours: 24,
        maxKeep: 7,
        telegram: { enabled: true, chatId: '-100999', topicId: 3 },
        botTokenConfigured: true,
      };
    },
    restoreBackup: async (_filename: string, _by: string | null, opts: { allowForeignArchive?: boolean }) => {
      calls.push(`restoreBackup:${opts?.allowForeignArchive === true}`);
      return { jobId: 'job-1', provenance: { status: 'native', payloadSha256: 'a'.repeat(64) } };
    },
    restoreFromUpload: async (
      _file: unknown,
      _by: string | null,
      opts: { allowForeignArchive?: boolean },
    ) => {
      calls.push(`restoreFromUpload:${opts?.allowForeignArchive === true}`);
      return { jobId: 'job-2', provenance: { status: 'foreign', reason: 'unstamped' } };
    },
    resolveDownloadStream: async () => {
      calls.push('resolveDownloadStream');
      return {
        stream: { pipe: () => calls.push('piped') },
        mimeType: 'application/gzip',
        filename: 'rezeis-db.sql.gz',
      };
    },
  };

  const prismaService = {
    adminAuditLog: {
      create: async (input: { data: AuditRow }) => {
        // Recorded in `calls` as well as `audits`, so the audit write can be
        // ORDERED against the other doubles. `audits` on its own can only ever
        // answer "did a row appear", never "did it appear before the bytes
        // left" — and the two are different facts.
        calls.push(`audit:${input.data.action}`);
        audits.push(input.data);
        return {};
      },
    },
  };

  const rbacService = {
    getEffectivePermissions: async () =>
      (options.heldPermissions ?? []).map((token) => {
        const separator = token.indexOf(':');
        return { resource: token.slice(0, separator), action: token.slice(separator + 1) };
      }),
  };

  return {
    controller: new AdminBackupController(
      backupService as never,
      prismaService as never,
      rbacService as never,
    ),
    audits,
    calls,
  };
}

describe('AdminBackupController — downloading the database is not a "view"', () => {
  it('gates the download route on backups:export, not backups:view', () => {
    const permissions = effectiveRoutePermissions(
      AdminBackupController,
      AdminBackupController.prototype.download,
    );
    assert.deepStrictEqual(permissions, [{ resource: 'backups', action: 'export' }]);
  });

  it('keeps listing on backups:view, so the split is a split and not a rename', () => {
    assert.deepStrictEqual(
      effectiveRoutePermissions(AdminBackupController, AdminBackupController.prototype.list),
      [{ resource: 'backups', action: 'view' }],
    );
    assert.deepStrictEqual(
      effectiveRoutePermissions(AdminBackupController, AdminBackupController.prototype.getSettings),
      [{ resource: 'backups', action: 'view' }],
    );
  });
});

describe('AdminBackupController — every backup action leaves an audit row', () => {
  it('records who triggered a dump', async () => {
    const harness = buildHarness();
    await harness.controller.create({ scope: BackupScope.DB }, ADMIN, fakeRequest());

    assert.equal(harness.audits.length, 1);
    const row = harness.audits[0]!;
    assert.equal(row.action, 'backup.created');
    assert.equal(row.adminUser.connect.id, 'admin-7');
    assert.equal(row.ipAddress, '198.51.100.9');
    assert.equal(row.userAgent, 'curl/8');
    assert.equal(row.metadata.requestId, 'req-42');
  });

  it('records a download BEFORE the first byte leaves', async () => {
    const harness = buildHarness();
    const { response } = fakeResponse();
    await harness.controller.download('rezeis-db.sql.gz', ADMIN, fakeRequest(), response);

    const row = harness.audits.find((entry) => entry.action === 'backup.downloaded');
    assert.ok(row, 'a download must be audited');
    assert.equal(row.adminUser.connect.id, 'admin-7');
    assert.equal(row.metadata.filename, 'rezeis-db.sql.gz');
    // An aborted transfer still copied whatever was already on the wire, so
    // the row has to exist before the pipe, not after it completes.
    //
    // Asserted as the whole SEQUENCE, because "the row exists and the stream
    // was piped" is equally true of the order that loses the evidence: pipe
    // first, and a process that dies — or a `prisma.adminAuditLog.create` that
    // throws, or a database that is momentarily unreachable — leaves a copy of
    // the entire database on the wire and nothing at all in the audit log.
    // Swapping the two lines in the controller used to keep this file green.
    assert.deepStrictEqual(
      harness.calls,
      ['resolveDownloadStream', 'audit:backup.downloaded', 'piped'],
      'a download must be audited between resolving the file and the first byte leaving',
    );
  });

  it('records a delete', async () => {
    const harness = buildHarness();
    await harness.controller.delete('rec-1', ADMIN, fakeRequest());
    const row = harness.audits.find((entry) => entry.action === 'backup.deleted');
    assert.ok(row);
    assert.equal(row.metadata.backupId, 'rec-1');
  });

  it('records a restore, naming the provenance verdict', async () => {
    const harness = buildHarness();
    await harness.controller.restore('rezeis-db.sql.gz', ADMIN, fakeRequest());
    const row = harness.audits.find((entry) => entry.action === 'backup.restore_started');
    assert.ok(row);
    assert.equal(row.metadata.source, 'stored');
    assert.equal(row.metadata.provenance, 'native');
    assert.equal(row.metadata.acknowledgedForeignArchive, false);
  });

  it('records an upload-and-restore, including WHY the archive was foreign', async () => {
    const harness = buildHarness({ heldPermissions: ['admins:edit'] });
    await harness.controller.restoreUpload(
      { filename: 'uploaded.sql.gz', path: '/tmp/uploaded.sql.gz', size: 4096 } as never,
      ADMIN,
      fakeRequest(),
      'true',
    );
    const row = harness.audits.find((entry) => entry.action === 'backup.restore_started');
    assert.ok(row);
    assert.equal(row.metadata.source, 'upload');
    assert.equal(row.metadata.provenance, 'foreign');
    assert.equal(row.metadata.provenanceReason, 'unstamped');
    assert.equal(row.metadata.acknowledgedForeignArchive, true);
  });

  it('records a settings write, which chooses where dumps get delivered', async () => {
    const harness = buildHarness();
    await harness.controller.updateSettings(
      { telegram: { enabled: true, chatId: '-100999' } },
      ADMIN,
      fakeRequest(),
    );
    const row = harness.audits.find((entry) => entry.action === 'backup.settings_updated');
    assert.ok(row, 'repointing the delivery chat and then dumping is the documented exfil path');
    assert.equal(row.metadata.telegramChatId, '-100999');
  });

  it('takes the actor from the token, never from the body', async () => {
    const harness = buildHarness();
    await harness.controller.delete(
      'rec-1',
      ADMIN,
      fakeRequest({ adminId: 'someone-else', actorId: 'someone-else' }),
    );
    assert.equal(harness.audits[0]?.adminUser.connect.id, 'admin-7');
  });
});

describe('AdminBackupController — acknowledging a foreign archive costs admins:edit', () => {
  it('refuses the acknowledgement from an admin without admins:edit', async () => {
    const harness = buildHarness({ heldPermissions: ['backups:run', 'backups:view'] });

    await assert.rejects(
      () =>
        harness.controller.restoreUpload(
          { filename: 'uploaded.sql.gz', path: '/tmp/uploaded.sql.gz', size: 4096 } as never,
          ADMIN,
          fakeRequest(),
          true,
        ),
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenException, `expected 403, got ${String(err)}`);
        assert.match(err.message, /admins:edit/);
        return true;
      },
    );
    assert.deepEqual(harness.calls, [], 'the service must not be reached at all');
  });

  it('accepts it from an admin who holds admins:edit', async () => {
    const harness = buildHarness({ heldPermissions: ['admins:edit'] });
    await harness.controller.restoreUpload(
      { filename: 'uploaded.sql.gz', path: '/tmp/uploaded.sql.gz', size: 4096 } as never,
      ADMIN,
      fakeRequest(),
      true,
    );
    assert.ok(harness.calls.includes('restoreFromUpload:true'));
  });

  it('reads a multipart text field, because that is how the upload route sends it', async () => {
    const harness = buildHarness({ heldPermissions: ['admins:edit'] });
    await harness.controller.restoreUpload(
      { filename: 'uploaded.sql.gz', path: '/tmp/uploaded.sql.gz', size: 4096 } as never,
      ADMIN,
      fakeRequest(),
      'true',
    );
    assert.ok(harness.calls.includes('restoreFromUpload:true'));
  });

  it('does not read the string "false" as consent', async () => {
    // Every multipart field arrives as a string, so a truthiness check would
    // turn an explicit refusal into an acknowledgement.
    const harness = buildHarness({ heldPermissions: ['admins:edit'] });
    await harness.controller.restoreUpload(
      { filename: 'uploaded.sql.gz', path: '/tmp/uploaded.sql.gz', size: 4096 } as never,
      ADMIN,
      fakeRequest(),
      'false',
    );
    assert.ok(harness.calls.includes('restoreFromUpload:false'));
  });

  it('does not consult RBAC when no acknowledgement was sent', async () => {
    // The ordinary path — restoring a stamped archive — must not depend on a
    // permission the operator does not need.
    const harness = buildHarness({ heldPermissions: [] });
    await harness.controller.restore('rezeis-db.sql.gz', ADMIN, fakeRequest());
    assert.ok(harness.calls.includes('restoreBackup:false'));
  });
});
