import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma, SupportTicketStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildUserReferenceWhere } from '../../internal-user/utils/user-reference.util';
import { SettingsService } from '../../settings/services/settings.service';

import { SupportAttachmentService, type AttachmentStream } from './support-attachment.service';
import { SupportTicketsService } from './support-tickets.service';

const TOKEN_BYTES = 32;

export interface GuestResolution {
  readonly guestId: string;
  readonly ticketId: string;
  readonly status: SupportTicketStatus;
}

/**
 * SupportGuestService
 * ───────────────────
 * Server-bound identity + lifecycle for anonymous (guest) support
 * conversations. The raw token is high-entropy (32 random bytes,
 * base64url) and is shown to the visitor exactly once (cookie + resume
 * code); only its SHA-256 hash is persisted, so a conversation can be
 * neither enumerated nor resolved from any client-supplied id.
 *
 * Authorization is derived ONLY from `sha256(presentedToken)` matching a
 * stored `SupportGuest.secret_hash`. Any miss — unknown token, expired
 * TTL, or a CLOSED (archived) conversation — yields the SAME `null`
 * result (no distinguishing oracle). Once closed, the token grants
 * neither read nor write.
 */
@Injectable()
export class SupportGuestService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly supportTicketsService: SupportTicketsService,
    private readonly supportAttachmentService: SupportAttachmentService,
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * Open a new guest conversation. Returns the raw token (caller sets the
   * cookie / shows the resume code — it is never recoverable afterwards)
   * and the new ticket id.
   */
  public async createConversation(input: {
    readonly subject: string;
    readonly message: string;
    readonly email?: string | null;
    readonly ipHash?: string | null;
  }): Promise<{ readonly token: string; readonly ticketId: string }> {
    const token = generateToken();
    const limits = await this.settingsService.getSupportLimits();
    const expiresAt = new Date(Date.now() + limits.guestTokenTtlHours * 3_600_000);
    const guest = await this.prismaService.supportGuest.create({
      data: {
        secretHash: hashToken(token),
        email: input.email ?? null,
        ipHash: input.ipHash ?? null,
        expiresAt,
      },
      select: { id: true },
    });
    const ticket = await this.supportTicketsService.createGuest({
      guestId: guest.id,
      subject: input.subject,
    });
    await this.supportTicketsService.addMessage({
      ticketId: ticket.id,
      authorType: 'USER',
      authorId: null,
      content: input.message,
    });
    return { token, ticketId: ticket.id };
  }

  /** Full conversation thread for the bound token, or `null` (uniform). */
  public async getConversation(token: string): Promise<unknown | null> {
    const resolution = await this.resolve(token);
    if (resolution === null) return null;
    return this.supportTicketsService.getById(resolution.ticketId);
  }

  /** Append a guest reply to the bound, still-open conversation. */
  public async reply(token: string, content: string): Promise<unknown | null> {
    const resolution = await this.resolve(token);
    if (resolution === null) return null;
    await this.supportTicketsService.addMessage({
      ticketId: resolution.ticketId,
      authorType: 'USER',
      authorId: null,
      content,
    });
    return this.supportTicketsService.getById(resolution.ticketId);
  }

  /** Visitor closes (archives) their own conversation. */
  public async close(token: string): Promise<boolean> {
    const resolution = await this.resolve(token);
    if (resolution === null) return false;
    await this.supportTicketsService.close({
      ticketId: resolution.ticketId,
      closedBy: `guest:${resolution.guestId}`,
    });
    return true;
  }

  /**
   * Explicitly attach a guest conversation to a logged-in account (R11.4).
   * Never implicit — the caller proves ownership of BOTH the guest token
   * (server-bound) and the account (resolved upstream). Transfers the ticket
   * to the user (channel→CABINET, guestId cleared) and expires the guest
   * token so it can no longer resolve. Returns false for an unresolved token
   * or unknown user (no partial transfer).
   */
  public async attachToUser(token: string, userRef: string): Promise<boolean> {
    const resolution = await this.resolve(token);
    if (resolution === null) return false;
    const where = safeUserWhere(userRef);
    if (where === null) return false;
    const user = await this.prismaService.user.findUnique({ where, select: { id: true } });
    if (user === null) return false;

    await this.prismaService.$transaction([
      this.prismaService.supportTicket.update({
        where: { id: resolution.ticketId },
        data: { userId: user.id, channel: 'CABINET', guestId: null },
      }),
      // Expire the guest identity so the old token (cookie/email) is inert.
      this.prismaService.supportGuest.update({
        where: { id: resolution.guestId },
        data: { expiresAt: new Date(0), emailResumeHash: null },
      }),
    ]);
    return true;
  }
  public async issueEmailResumeToken(guestId: string): Promise<string | null> {
    const token = generateToken();
    try {
      await this.prismaService.supportGuest.update({
        where: { id: guestId },
        data: { emailResumeHash: hashToken(token) },
      });
      return token;
    } catch {
      return null;
    }
  }

  /**
   * Attach a file to the bound, still-open conversation. Returns the
   * refreshed thread, or `null` for an unresolved token. Validation
   * failures from the attachment service propagate to the caller (mapped
   * to 415/413) — they never leak which conversation was targeted.
   */
  public async addAttachment(
    token: string,
    input: {
      readonly filename: string;
      readonly mimeType?: string;
      readonly content?: string;
      readonly dataBase64: string;
    },
  ): Promise<unknown | null> {
    const resolution = await this.resolve(token);
    if (resolution === null) return null;
    await this.supportAttachmentService.storeForMessage({
      ticketId: resolution.ticketId,
      authorType: 'USER',
      authorId: null,
      content: input.content,
      filename: input.filename,
      declaredMime: input.mimeType,
      dataBase64: input.dataBase64,
    });
    return this.supportTicketsService.getById(resolution.ticketId);
  }

  /**
   * Open a read stream for an attachment on the bound conversation, or
   * `null` (uniform negative) when the token or attachment does not resolve.
   */
  public async streamAttachment(
    token: string,
    attachmentId: string,
  ): Promise<AttachmentStream | null> {
    const resolution = await this.resolve(token);
    if (resolution === null) return null;
    return this.supportAttachmentService.streamForTicket(resolution.ticketId, attachmentId);
  }

  /**
   * Resolve a presented token to its open conversation. Returns `null`
   * for an unknown token, an expired guest, a missing ticket, OR a closed
   * conversation — the single uniform negative (Property 2 & 3 & 6).
   * Touches `lastSeenAt` best-effort on a hit.
   */
  private async resolve(token: string): Promise<GuestResolution | null> {
    if (typeof token !== 'string' || token.length === 0) return null;
    const hashed = hashToken(token);
    const guest = await this.prismaService.supportGuest.findFirst({
      where: { OR: [{ secretHash: hashed }, { emailResumeHash: hashed }] },
      select: {
        id: true,
        expiresAt: true,
        ticket: { select: { id: true, status: true } },
      },
    });
    if (guest === null) return null;
    if (guest.expiresAt.getTime() < Date.now()) return null;
    if (guest.ticket === null) return null;
    if (guest.ticket.status === SupportTicketStatus.CLOSED) return null;

    // Best-effort liveness touch — never fail resolution on a write hiccup.
    await this.prismaService.supportGuest
      .update({ where: { id: guest.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);

    return { guestId: guest.id, ticketId: guest.ticket.id, status: guest.ticket.status };
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Resolve a user reference to a Prisma where, or null when malformed. */
function safeUserWhere(userRef: string): Prisma.UserWhereUniqueInput | null {
  try {
    return buildUserReferenceWhere(userRef);
  } catch {
    return null;
  }
}

function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}
