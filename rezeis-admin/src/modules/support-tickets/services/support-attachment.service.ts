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
   * Open a read stream for an attachment that belongs to `ticketId`.
   * Returns `null` when the attachment is unknown, not on this ticket, or
   * missing on disk — callers translate that to a uniform 404.
   */
  public async streamForTicket(
    ticketId: string,
    attachmentId: string,
  ): Promise<AttachmentStream | null> {
    const attachment = await this.prismaService.supportAttachment.findFirst({
      where: { id: attachmentId, message: { ticketId } },
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
