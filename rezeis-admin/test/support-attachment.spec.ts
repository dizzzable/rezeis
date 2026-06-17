import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  AttachmentValidationError,
  buildStoredName,
  validateUpload,
} from '../src/modules/support-tickets/utils/support-attachment.util';
import { SupportAttachmentService } from '../src/modules/support-tickets/services/support-attachment.service';

/**
 * Attachment safety (Phase 3 / Correctness Property 7). The decoded bytes
 * must match an allow-listed type (magic-byte sniff), respect the size cap,
 * and never escape `<dir>/<ticketId>/`. Serving re-checks ticket ownership.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x10, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
  Buffer.from([0x00, 0x00]),
]);
const PDF = Buffer.from('%PDF-1.4\n%binary\n');
const b64 = (b: Buffer): string => b.toString('base64');

describe('validateUpload', () => {
  it('accepts each allow-listed type by magic bytes', () => {
    assert.equal(validateUpload({ dataBase64: b64(PNG), filename: 'a.png' }).type.mime, 'image/png');
    assert.equal(validateUpload({ dataBase64: b64(JPEG), filename: 'a.jpg' }).type.mime, 'image/jpeg');
    assert.equal(validateUpload({ dataBase64: b64(WEBP), filename: 'a.webp' }).type.mime, 'image/webp');
    assert.equal(validateUpload({ dataBase64: b64(PDF), filename: 'a.pdf' }).type.mime, 'application/pdf');
  });

  it('rejects empty input', () => {
    assert.throws(
      () => validateUpload({ dataBase64: '', filename: 'a.png' }),
      (e: unknown) => e instanceof AttachmentValidationError && e.reason === 'empty',
    );
  });

  it('rejects content whose bytes match no allow-listed type', () => {
    const txt = Buffer.from('hello world this is not an allowed file');
    assert.throws(
      () => validateUpload({ dataBase64: b64(txt), filename: 'a.txt' }),
      (e: unknown) => e instanceof AttachmentValidationError && e.reason === 'content-mismatch',
    );
  });

  it('rejects when the declared MIME disagrees with the sniffed type', () => {
    assert.throws(
      () => validateUpload({ dataBase64: b64(PNG), filename: 'a.png', declaredMime: 'application/pdf' }),
      (e: unknown) => e instanceof AttachmentValidationError && e.reason === 'type-not-allowed',
    );
  });

  it('rejects oversize payloads', () => {
    const prev = process.env.SUPPORT_ATTACHMENT_MAX_MB;
    process.env.SUPPORT_ATTACHMENT_MAX_MB = '1';
    try {
      const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024, 0)]);
      assert.throws(
        () => validateUpload({ dataBase64: b64(big), filename: 'big.png' }),
        (e: unknown) => e instanceof AttachmentValidationError && e.reason === 'too-large',
      );
    } finally {
      process.env.SUPPORT_ATTACHMENT_MAX_MB = prev;
    }
  });

  it('strips path separators from the display name', () => {
    const v = validateUpload({ dataBase64: b64(PNG), filename: '../../etc/passwd.png' });
    assert.ok(!v.displayName.includes('/'));
    assert.ok(!v.displayName.includes('\\'));
  });
});

describe('buildStoredName', () => {
  it('produces a separator-free `<id>.<ext>` name', () => {
    const name = buildStoredName('abc123', 'png');
    assert.equal(name, 'abc123.png');
    assert.ok(!name.includes('/') && !name.includes('\\') && !name.includes('..'));
  });
});

describe('SupportAttachmentService', () => {
  let dir: string;
  let prevDir: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'support-att-'));
    prevDir = process.env.SUPPORT_ATTACHMENTS_DIR;
    process.env.SUPPORT_ATTACHMENTS_DIR = dir;
  });

  afterEach(async () => {
    process.env.SUPPORT_ATTACHMENTS_DIR = prevDir;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  function build() {
    const created: Array<Record<string, unknown>> = [];
    const prisma = {
      supportAttachment: {
        create: async ({ data, select: _select }: { data: Record<string, unknown>; select: unknown }) => {
          const row = { id: `att-${created.length + 1}`, ...data };
          created.push(row);
          return {
            id: row.id,
            messageId: data.messageId,
            filename: data.filename,
            mimeType: data.mimeType,
            sizeBytes: data.sizeBytes,
          };
        },
        findFirst: async ({ where }: { where: { id: string; message: { ticketId: string } } }) => {
          const row = created.find(
            (r) => r.id === where.id && (r.messageId as string).startsWith(`m-${where.message.ticketId}`),
          );
          if (!row) return null;
          return {
            storedName: row.storedName,
            mimeType: row.mimeType,
            filename: row.filename,
            sizeBytes: row.sizeBytes,
          };
        },
      },
    };
    const tickets = {
      addMessage: async (input: { ticketId: string }) => ({ id: `m-${input.ticketId}-1` }),
    };
    const settings = {
      getSupportLimits: async () => ({
        enabled: true,
        guestTokenTtlHours: 72,
        attachmentMaxBytes: 10 * 1024 * 1024,
        attachmentMaxPerMsg: 5,
      }),
    };
    const service = new SupportAttachmentService(prisma as never, tickets as never, settings as never);
    return { service, created };
  }

  it('stores a valid file on disk under the ticket dir and persists a row', async () => {
    const { service, created } = build();
    const stored = await service.storeForMessage({
      ticketId: 'tkt1',
      authorType: 'USER',
      authorId: null,
      filename: 'proof.png',
      dataBase64: b64(PNG),
    });
    assert.equal(stored.mimeType, 'image/png');
    assert.equal(created.length, 1);
    const onDisk = path.join(dir, 'tkt1', created[0].storedName as string);
    const bytes = await fs.readFile(onDisk);
    assert.deepEqual(bytes, PNG);
  });

  it('streams an attachment only for its owning ticket (access control)', async () => {
    const { service } = build();
    const stored = await service.storeForMessage({
      ticketId: 'tkt1',
      authorType: 'USER',
      authorId: null,
      filename: 'proof.png',
      dataBase64: b64(PNG),
    });
    // Right ticket → stream.
    const ok = await service.streamForTicket('tkt1', stored.id);
    assert.notEqual(ok, null);
    ok?.stream.destroy();
    // Wrong ticket → null (no cross-ticket access).
    const denied = await service.streamForTicket('other-ticket', stored.id);
    assert.equal(denied, null);
  });

  it('rejects an invalid upload before touching disk', async () => {
    const { service, created } = build();
    await assert.rejects(
      service.storeForMessage({
        ticketId: 'tkt1',
        authorType: 'USER',
        authorId: null,
        filename: 'note.txt',
        dataBase64: b64(Buffer.from('plain text, not allowed')),
      }),
      (e: unknown) => e instanceof AttachmentValidationError,
    );
    assert.equal(created.length, 0);
    const entries = await fs.readdir(dir).catch(() => []);
    assert.equal(entries.length, 0);
  });
});
