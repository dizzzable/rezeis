import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma, SupportTicketStatus } from '@prisma/client';

import { appConfig } from '../../../common/config/app.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildUserReferenceWhere } from '../../internal-user/utils/user-reference.util';
import { SettingsService } from '../../settings/services/settings.service';

import { guestLocaleMetadata, type GuestLetterLanguage } from '../utils/guest-letter-language.util';

import { SupportAttachmentService, type AttachmentStream } from './support-attachment.service';
import { SupportTicketsService } from './support-tickets.service';

const TOKEN_BYTES = 32;

/**
 * The `expiresAt` of a guest identity whose conversation was attached to an
 * account: the epoch, so it is expired for good and an operator reply never
 * revives it (`extendAccessOnOperatorReply`).
 */
const ATTACHED_GUEST_EXPIRY = new Date(0);

/**
 * A device credential: `gdv1.<guestId>.<mac>`, the MAC keyed from the panel's
 * crypt key. Neither of the random tokens (base64url, no dot) can look like one.
 */
const DEVICE_TOKEN_PREFIX = 'gdv1.';

export interface GuestResolution {
  readonly guestId: string;
  readonly ticketId: string;
  readonly status: SupportTicketStatus;
}

/**
 * How a token got in. `email` is the one way in that does not last: a reply
 * letter's token, overwritten by the next letter (`activateEmailResumeToken`).
 */
type ResolvedVia = 'secret' | 'email' | 'device';

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
    /** For the device-credential key; last and optional for positional construction in specs. */
    @Optional()
    @Inject(appConfig.KEY)
    private readonly applicationConfiguration?: ConfigType<typeof appConfig>,
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
    readonly installId?: string | null;
    readonly deviceHash?: string | null;
    /** Non-null when the gate found this device on a blocked account. */
    readonly flaggedReason?: string | null;
    /** The guest page's language, kept for the letters (`guest-letter-language.util.ts`). */
    readonly locale?: GuestLetterLanguage | null;
  }): Promise<{ readonly token: string; readonly ticketId: string }> {
    const token = generateToken();
    const limits = await this.settingsService.getSupportLimits();
    const expiresAt = new Date(Date.now() + limits.guestTokenTtlHours * 3_600_000);
    const guest = await this.prismaService.supportGuest.create({
      data: {
        secretHash: hashToken(token),
        email: input.email ?? null,
        ipHash: input.ipHash ?? null,
        installId: input.installId ?? null,
        deviceHash: input.deviceHash ?? null,
        flaggedReason: input.flaggedReason ?? null,
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
      metadata: guestLocaleMetadata(input.locale),
    });
    return { token, ticketId: ticket.id };
  }

  /** Full conversation thread for the bound token, or `null` (uniform). */
  public async getConversation(token: string): Promise<unknown | null> {
    const resolution = await this.resolve(token);
    if (resolution === null) return null;
    return this.supportTicketsService.getById(resolution.ticketId);
  }

  /**
   * The thread for a token, plus — when the token was a reply letter's link —
   * the conversation's durable device credential to keep in its place.
   *
   * A letter's token is a way IN, not a key: the next operator reply
   * overwrites it (`activateEmailResumeToken`), and a device that kept it as its
   * cookie fell out of the conversation at that very reply, into the "new
   * conversation" form — the device that started the thread included, once it
   * had followed a link. The credential does not rotate: it lives exactly as
   * long as the guest (`expiresAt`), an open ticket, and no attachment to an
   * account, because `resolve` checks all three for it like for any token.
   * The guest's own secret and a credential are durable already, so they are
   * not exchanged (`deviceToken: null`).
   */
  public async getConversationForDevice(
    token: string,
  ): Promise<{ readonly ticket: unknown; readonly deviceToken: string | null } | null> {
    const resolution = await this.resolve(token);
    if (resolution === null) return null;
    const ticket = await this.supportTicketsService.getById(resolution.ticketId);
    const deviceToken = resolution.via === 'email' ? this.deviceTokenFor(resolution.guestId) : null;
    return { ticket, deviceToken };
  }

  /**
   * Append a guest reply to the bound, still-open conversation. `locale` is the
   * guest page's language, when the cabinet sent it: the next letter follows
   * the language the guest last wrote in.
   */
  public async reply(
    token: string,
    content: string,
    locale?: GuestLetterLanguage | null,
  ): Promise<unknown | null> {
    const resolution = await this.resolve(token);
    if (resolution === null) return null;
    await this.supportTicketsService.addMessage({
      ticketId: resolution.ticketId,
      authorType: 'USER',
      authorId: null,
      content,
      metadata: guestLocaleMetadata(locale),
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
        data: { expiresAt: ATTACHED_GUEST_EXPIRY, emailResumeHash: null },
      }),
    ]);
    return true;
  }

  /**
   * An operator replied in this guest conversation: the guest can open it for
   * another `guestTokenTtlHours` from NOW.
   *
   * The owner's rule (23.09.2026): «каждый ответ оператора продлевает доступ
   * ещё на 72 часа». Access used to end the TTL after the conversation OPENED,
   * whatever happened in it: a reply on day 4 went out with no button and could
   * not be read anywhere. Called before the reply letter mints its link, so
   * that link opens.
   *
   * The later of the current end and now + TTL wins, in the one conditional
   * write, so it never shortens access (a TTL lowered since, a concurrent
   * reply). Not for a closed conversation — reopening it is the operator's
   * explicit act — and never for an identity attached to an account
   * (`ATTACHED_GUEST_EXPIRY`: expired for good). The guest's own messages do
   * not come here. `true` when the access end moved.
   */
  public async extendAccessOnOperatorReply(ticketId: string): Promise<boolean> {
    const ticket = await this.prismaService.supportTicket.findUnique({
      where: { id: ticketId },
      select: { status: true, guestId: true },
    });
    if (ticket === null || ticket.guestId === null || ticket.status === SupportTicketStatus.CLOSED) {
      return false;
    }
    const limits = await this.settingsService.getSupportLimits();
    const until = new Date(Date.now() + limits.guestTokenTtlHours * 3_600_000);
    const { count } = await this.prismaService.supportGuest.updateMany({
      where: { id: ticket.guestId, expiresAt: { gt: ATTACHED_GUEST_EXPIRY, lt: until } },
      data: { expiresAt: until },
    });
    return count === 1;
  }
  /**
   * A fresh way in for a reply letter's «Открыть переписку». Nothing is written:
   * the token opens nothing until {@link activateEmailResumeToken}, and the
   * previous letter's link keeps working until then.
   *
   * The token carries its letter's place in line (`<stamp>.<random>`, see
   * {@link nextLetterStamp}), decided here — before the letter is sent — so
   * the order in which letters happen to leave cannot reorder them.
   */
  public newEmailResumeToken(): string {
    return `${nextLetterStamp()}.${generateToken()}`;
  }

  /**
   * The moment a letter token was minted — its place in line as a date, to the
   * millisecond — or `null` for a token without a stamp. The letter carrying
   * the token is dated with it, so the order an inbox sorts letters in by
   * `Date` is the order of their links.
   */
  public letterTokenIssuedAt(token: string): Date | null {
    const stamp = LETTER_TOKEN_PATTERN.exec(token)?.[1];
    return stamp === undefined ? null : new Date(Math.floor(Number(stamp) / 1000));
  }

  /**
   * Makes `token` THE letter link of this guest — call it only once the letter
   * carrying it has gone out. There is one letter link per guest, so this is
   * also the moment the previous letter's link stops working: a letter that
   * never arrived must not retire the one the guest still has.
   *
   * MONOTONIC: it becomes the link only if no NEWER letter's link is live
   * already. Two replies close together send in parallel, and the first
   * reply's letter can be the slower one; activated last, it used to take the
   * link back, leaving the guest's newest letter dead. The stored value carries
   * the stamp, and the write is a compare-and-set on the value it replaces, so
   * a concurrent activation cannot slip in between the check and the write.
   *
   * `activated` — this letter's link is the live one; `superseded` — a newer
   * letter's already is, which is no failure; `failed` — the write failed, and
   * the previous link stays the live one.
   */
  public async activateEmailResumeToken(
    guestId: string,
    token: string,
  ): Promise<'activated' | 'superseded' | 'failed'> {
    const stored = storedLetterHash(token);
    const stamp = stampOfStoredLetterHash(stored);
    try {
      for (let attempt = 0; attempt < LETTER_ACTIVATION_ATTEMPTS; attempt += 1) {
        const guest = await this.prismaService.supportGuest.findUnique({
          where: { id: guestId },
          select: { emailResumeHash: true },
        });
        if (guest === null) return 'failed';
        const live = guest.emailResumeHash;
        if (live !== null && stampOfStoredLetterHash(live) >= stamp) return 'superseded';
        const { count } = await this.prismaService.supportGuest.updateMany({
          where: { id: guestId, emailResumeHash: live },
          data: { emailResumeHash: stored },
        });
        if (count === 1) return 'activated';
        // Another letter was activated between the read and the write: look again.
      }
      return 'failed';
    } catch {
      return 'failed';
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
  private async resolve(token: string): Promise<(GuestResolution & { readonly via: ResolvedVia }) | null> {
    if (typeof token !== 'string' || token.length === 0) return null;
    const select = {
      id: true,
      secretHash: true,
      expiresAt: true,
      ticket: { select: { id: true, status: true } },
    } as const;
    let guest;
    let via: ResolvedVia;
    if (token.startsWith(DEVICE_TOKEN_PREFIX)) {
      // A device credential names its guest and proves it with the MAC; the
      // rest of the checks below are the same as for any token.
      const guestId = this.guestIdOfDeviceToken(token);
      if (guestId === null) return null;
      guest = await this.prismaService.supportGuest.findUnique({ where: { id: guestId }, select });
      via = 'device';
    } else {
      const hashed = hashToken(token);
      guest = await this.prismaService.supportGuest.findFirst({
        where: { OR: [{ secretHash: hashed }, { emailResumeHash: storedLetterHash(token) }] },
        select,
      });
      via = guest?.secretHash === hashed ? 'secret' : 'email';
    }
    if (guest === null) return null;
    if (guest.expiresAt.getTime() < Date.now()) return null;
    if (guest.ticket === null) return null;
    if (guest.ticket.status === SupportTicketStatus.CLOSED) return null;

    // Best-effort liveness touch — never fail resolution on a write hiccup.
    await this.prismaService.supportGuest
      .update({ where: { id: guest.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);

    return { guestId: guest.id, ticketId: guest.ticket.id, status: guest.ticket.status, via };
  }

  /**
   * The conversation's durable device credential. Derived, never stored: a
   * MAC over the guest id with a key taken from `REZEIS_CRYPT_KEY`, so every
   * device that came in through a letter holds the same key to the same
   * conversation, and there is nothing to rotate. `null` without a crypt key
   * (the panel does not boot without one).
   */
  private deviceTokenFor(guestId: string): string | null {
    const key = this.deviceKey();
    if (key === null) return null;
    return `${DEVICE_TOKEN_PREFIX}${guestId}.${deviceMac(key, guestId)}`;
  }

  /** The guest a well-formed, genuine device credential names; otherwise `null`. */
  private guestIdOfDeviceToken(token: string): string | null {
    const key = this.deviceKey();
    if (key === null) return null;
    const body = token.slice(DEVICE_TOKEN_PREFIX.length);
    const dot = body.lastIndexOf('.');
    if (dot <= 0) return null;
    const guestId = body.slice(0, dot);
    const presented = Buffer.from(body.slice(dot + 1));
    const expected = Buffer.from(deviceMac(key, guestId));
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
    return guestId;
  }

  private deviceKey(): Buffer | null {
    const cryptKey = this.applicationConfiguration?.cryptKey ?? process.env.REZEIS_CRYPT_KEY ?? '';
    if (cryptKey.length === 0) return null;
    return createHash('sha256').update(`rezeis-admin:support-guest-device:${cryptKey}`).digest();
  }
}

function deviceMac(key: Buffer, guestId: string): string {
  return createHmac('sha256', key).update(`support-guest-device:v1:${guestId}`).digest('base64url');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** How many times an activation looks again after losing a race to another. */
const LETTER_ACTIVATION_ATTEMPTS = 5;

/** A letter token: `<16-digit stamp>.<random base64url>`. */
const LETTER_TOKEN_PATTERN = /^(\d{16})\.[A-Za-z0-9_-]+$/;

let lastLetterStamp = 0;

/**
 * The next letter's place in line: microseconds since the epoch, strictly
 * increasing within the process (two letters minted in one millisecond still
 * get two stamps), as 16 digits — a safe integer until the 23rd century.
 */
function nextLetterStamp(): string {
  lastLetterStamp = Math.max(Date.now() * 1000, lastLetterStamp + 1);
  return String(lastLetterStamp).padStart(16, '0');
}

/**
 * What `emailResumeHash` holds for a letter token: `<stamp>:<sha256>`, so a
 * later activation can tell which letter is newer. A token without a stamp —
 * one minted before stamps existed — is stored, and looked up, as its bare
 * hash, exactly as before.
 */
function storedLetterHash(token: string): string {
  const stamp = LETTER_TOKEN_PATTERN.exec(token)?.[1];
  return stamp === undefined ? hashToken(token) : `${stamp}:${hashToken(token)}`;
}

/** The stamp of a stored letter hash; `-1` for a bare, unstamped one (the oldest). */
function stampOfStoredLetterHash(stored: string): number {
  const match = /^(\d{16}):/.exec(stored);
  return match === null ? -1 : Number(match[1]);
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
