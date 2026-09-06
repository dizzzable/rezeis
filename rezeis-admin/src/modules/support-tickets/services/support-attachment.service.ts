import { Injectable, Logger } from '@nestjs/common';
import { createReadStream, promises as fs, type ReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SettingsService } from '../../settings/services/settings.service';
import {
  resolveAttachmentsDir,
  validateUpload,
  type ValidatedUpload,
} from '../utils/support-attachment.util';
import { SupportTicketsService } from './support-tickets.service';

export interface StoreAttachmentInput {
  readonly ticketId: string;
  readonly authorType: 'USER' | 'ADMIN' | 'SYSTEM';
  readonly authorId: string | null;
  /** Optional caption shown with the file. */
  readonly content?: string;
  readonly filename: string;
  readonly declaredMime?: string;
  readonly dataBase64: string;
}

export interface StoredAttachment {
  readonly id: string;
  readonly messageId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export interface AttachmentStream {
  readonly stream: ReadStream;
  readonly mimeType: string;
  readonly filename: string;
  readonly sizeBytes: number;
}

/**
 * SupportAttachmentService
 * ────────────────────────
 * Validates, stores and streams support-message attachments. The decoded
 * bytes are validated against an allow-list + magic-byte sniff before they
 * ever touch disk; the on-disk name is a random token (no caller bytes), so
 * an upload can never escape `<dir>/<ticketId>/`. Files are served only via
 * `streamForTicket`, which re-checks that the attachment belongs to the
 * given ticket — there is no static/path-based access.
 */
@Injectable()
export class SupportAttachmentService {
  private readonly logger = new Logger(SupportAttachmentService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly supportTicketsService: SupportTicketsService,
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * Validate + persist a single attachment as a new message on the ticket.
   * Throws `AttachmentValidationError` (caller maps to 415/413) on bad
   * input; on any disk/DB failure the on-disk file is removed.
   */
  public async storeForMessage(input: StoreAttachmentInput): Promise<StoredAttachment> {
    const limits = await this.settingsService.getSupportLimits();
    const validated: ValidatedUpload = validateUpload({
      dataBase64: input.dataBase64,
      filename: input.filename,
      declaredMime: input.declaredMime,
      maxBytes: limits.attachmentMaxBytes,
    });

    const storedName = `${randomBytes(16).toString('hex')}.${validated.type.ext}`;
    const dir = path.join(resolveAttachmentsDir(), sanitizeSegment(input.ticketId));
    const filePath = path.join(dir, storedName);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, validated.buffer, { flag: 'wx' });

    try {
      const message = await this.supportTicketsService.addMessage({
        ticketId: input.ticketId,
        authorType: input.authorType,
        authorId: input.authorId,
        content: (input.content ?? '').trim(),
      });
      const attachment = await this.prismaService.supportAttachment.create({
        data: {
          messageId: message.id,
          filename: validated.displayName,
          storedName,
          mimeType: validated.type.mime,
          sizeBytes: validated.sizeBytes,
        },
        select: { id: true, messageId: true, filename: true, mimeType: true, sizeBytes: true },
      });
      return attachment;
    } catch (err: unknown) {
      // Roll back the orphaned file; never leave bytes without a DB row.
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Delete the BYTES of every attachment on a ticket, keeping the rows.
   *
   * ── Why the rows survive ─────────────────────────────────────────────
   *
   * A chip that simply vanishes from a conversation reads as a bug, and the
   * facts worth keeping — what was sent, by whom, when, how big — cost
   * nothing to keep. `purgedAt` is what lets both surfaces say «файл удалён»
   * instead of showing a link that 404s. The disk, which is the whole point,
   * is freed either way.
   *
   * Idempotent: a second purge finds nothing left to unlink and stamps
   * nothing new. Files are removed one by one rather than by dropping the
   * directory, so a stray file that belongs to no row is left alone rather
   * than silently taken with them.
   */
  public async purgeForTicket(
    ticketId: string,
  ): Promise<{ readonly purged: number; readonly freedBytes: number }> {
    const attachments = await this.prismaService.supportAttachment.findMany({
      where: { message: { ticketId }, purgedAt: null },
      select: { id: true, storedName: true, sizeBytes: true },
    });
    if (attachments.length === 0) return { purged: 0, freedBytes: 0 };

    const base = path.resolve(resolveAttachmentsDir(), sanitizeSegment(ticketId));
    let freedBytes = 0;
    const purgedIds: string[] = [];

    for (const attachment of attachments) {
      const filePath = path.resolve(base, attachment.storedName);
      // The same containment check the stream path makes: a stored name is a
      // random token and cannot escape, but this is the one place that
      // DELETES, so it verifies rather than assumes.
      if (filePath !== base && !filePath.startsWith(base + path.sep)) continue;
      try {
        await fs.rm(filePath, { force: true });
        freedBytes += attachment.sizeBytes;
        purgedIds.push(attachment.id);
      } catch (err: unknown) {
        // One unlink that failed must not abandon the rest, and must not
        // stamp a row whose bytes are still on disk — the stamp is what tells
        // both surfaces the file is gone.
        this.logger.warn(
          `Could not remove attachment ${attachment.id} of ticket ${ticketId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (purgedIds.length > 0) {
      await this.prismaService.supportAttachment.updateMany({
        where: { id: { in: purgedIds } },
        data: { purgedAt: new Date() },
      });
    }
    // The ticket directory, only when it is empty. `rmdir` refuses a
    // non-empty one, which is the behaviour wanted: anything left belongs to
    // a row this purge did not touch.
    await fs.rmdir(base).catch(() => undefined);

    return { purged: purgedIds.length, freedBytes };
  }

  /**
   * Open a read stream for an attachment that belongs to `ticketId`.
   * Returns `null` when the attachment is unknown, not on this ticket, or
   * missing on disk — callers translate that to a uniform 404.
   */
  public async streamForTicket(
    ticketId: string,
    attachmentId: string,
  ): Promise<AttachmentStream | null> {
    const attachment = await this.prismaService.supportAttachment.findFirst({
      // `purgedAt: null` is part of the lookup, not a check after it: a purged
      // row keeps its name and size so the thread can say what was there, and
      // a stream that fell through to the disk would answer with whatever
      // happened to be written at that path next.
      where: { id: attachmentId, message: { ticketId }, purgedAt: null },
      select: { storedName: true, mimeType: true, filename: true, sizeBytes: true },
    });
    if (attachment === null) return null;

    const base = path.resolve(resolveAttachmentsDir(), sanitizeSegment(ticketId));
    const filePath = path.resolve(base, attachment.storedName);
    // Defense in depth: the resolved path must stay inside the ticket dir.
    if (filePath !== base && !filePath.startsWith(base + path.sep)) return null;

    try {
      await fs.access(filePath);
    } catch {
      this.logger.warn(`Attachment ${attachmentId} missing on disk for ticket ${ticketId}`);
      return null;
    }
    return {
      stream: createReadStream(filePath),
      mimeType: attachment.mimeType,
      filename: attachment.filename,
      sizeBytes: attachment.sizeBytes,
    };
  }
}

/** Keep a path segment to safe characters (ticket ids are CUIDs already). */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_-]/g, '');
}
