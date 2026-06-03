import { createHash, randomBytes } from 'node:crypto';

import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EmailService } from '../../email/services/email.service';
import {
  LinkEmailInitiateDto,
  LinkEmailVerifyDto,
  LinkTelegramConsumeDto,
  LinkTelegramGenerateDto,
} from '../dto/linking.dto';
import {
  LinkEmailInitiateResultInterface,
  LinkEmailVerifyResultInterface,
  LinkTelegramConsumeResultInterface,
  LinkTelegramGenerateResultInterface,
} from '../interfaces/linking.interface';

/**
 * LinkingService
 * ──────────────
 * Owns the *opt-in* identity-channel attachments for an existing
 * `reiwa_id` (`User.id`):
 *
 *  - **Telegram link**: the SPA settings page generates a 6-digit code
 *    and instructs the user to type it into the bot. The bot calls
 *    `consume` on behalf of the receiving Telegram identity. On
 *    success, `User.telegramId` is set on the *web-first* User row.
 *
 *  - **Email link / verification**: the SPA settings page asks for an
 *    email; we issue a 6-digit code via `EmailService` and persist its
 *    hash. `verify` consumes the challenge and stamps
 *    `WebAccount.email` + `emailVerifiedAt`. We deliberately do NOT
 *    migrate the email onto `User.email` — keeping it on `WebAccount`
 *    matches the recovery / login lookup paths.
 *
 * Storage:
 *   We reuse the `AuthChallenge` table (`auth_challenges`) for both
 *   purposes. The `purpose` discriminator is `telegram_link` /
 *   `email_link`; `destination` carries the email address (or the
 *   user-id sentinel for telegram). TTL defaults to 10 min.
 *
 * Security:
 *   - Codes are stored as `sha256(code)` — we never persist the raw
 *     value beyond the response payload returned to the web caller.
 *   - We decrement `attemptsLeft` on bad guesses and refuse codes once
 *     the counter hits zero.
 *   - All mutations run inside a `$transaction` so a partial failure
 *     never leaves a half-linked state.
 */
@Injectable()
export class LinkingService {
  private readonly logger = new Logger(LinkingService.name);
  private static readonly CODE_TTL_MS = 10 * 60 * 1000;
  private static readonly DEFAULT_ATTEMPTS_LEFT = 5;
  private static readonly TELEGRAM_PURPOSE = 'telegram_link';
  private static readonly EMAIL_PURPOSE = 'email_link';

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  // ── Telegram ─────────────────────────────────────────────────────────

  public async telegramGenerate(
    input: LinkTelegramGenerateDto,
  ): Promise<LinkTelegramGenerateResultInterface> {
    const webAccount = await this.prismaService.webAccount.findUnique({
      where: { userId: input.userId },
      select: { id: true },
    });
    if (webAccount === null) {
      throw new NotFoundException('Web account not found for this userId');
    }
    const code = this.makeNumericCode(6);
    const codeHash = this.hash(code);
    const expiresAt = new Date(Date.now() + LinkingService.CODE_TTL_MS);

    await this.prismaService.$transaction(async (tx) => {
      // Invalidate any prior pending telegram_link challenges for this
      // web-account so the user always gets a single live code.
      await tx.authChallenge.updateMany({
        where: {
          webAccountId: webAccount.id,
          purpose: LinkingService.TELEGRAM_PURPOSE,
          consumedAt: null,
        },
        data: { consumedAt: new Date() },
      });
      await tx.authChallenge.create({
        data: {
          webAccountId: webAccount.id,
          purpose: LinkingService.TELEGRAM_PURPOSE,
          channel: 'telegram',
          // The destination for telegram-link challenges is the userId
          // because we don't have a Telegram address yet — that's the
          // whole point of the flow. Lookup happens by `userId` plus
          // `purpose`, never by destination, so this stays consistent.
          destination: input.userId,
          codeHash,
          attemptsLeft: LinkingService.DEFAULT_ATTEMPTS_LEFT,
          expiresAt,
        },
      });
    });

    return { code, expiresAt: expiresAt.toISOString() };
  }

  public async telegramConsume(
    input: LinkTelegramConsumeDto,
  ): Promise<LinkTelegramConsumeResultInterface> {
    const codeHash = this.hash(input.code);
    const telegramIdBig = BigInt(input.telegramId);

    return this.prismaService.$transaction(async (tx) => {
      // Find the latest non-consumed challenge for this code hash. Done
      // upfront so we can early-reject before touching any User rows.
      const challenge = await tx.authChallenge.findFirst({
        where: {
          purpose: LinkingService.TELEGRAM_PURPOSE,
          codeHash,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (challenge === null) {
        return { success: false, reason: 'INVALID_OR_EXPIRED_CODE' as const };
      }
      if (challenge.attemptsLeft <= 0) {
        return { success: false, reason: 'INVALID_OR_EXPIRED_CODE' as const };
      }

      // Resolve the WebAccount → User behind the challenge.
      const webAccount = await tx.webAccount.findUnique({
        where: { id: challenge.webAccountId },
        select: { userId: true, user: { select: { telegramId: true } } },
      });
      if (webAccount === null) {
        return { success: false, reason: 'USER_NOT_FOUND' as const };
      }

      // Refuse silent merges: if the incoming Telegram id already owns a
      // *different* User, we cannot move history without explicit operator
      // intervention. The bot user can register web credentials directly
      // via the Mini App instead.
      const conflicting = await tx.user.findUnique({
        where: { telegramId: telegramIdBig },
        select: { id: true },
      });
      if (conflicting !== null && conflicting.id !== webAccount.userId) {
        return { success: false, reason: 'TELEGRAM_ALREADY_LINKED' as const };
      }

      // Already linked to the same user — idempotent success.
      if (webAccount.user.telegramId === telegramIdBig) {
        await tx.authChallenge.update({
          where: { id: challenge.id },
          data: { consumedAt: new Date() },
        });
        return { success: true, userId: webAccount.userId };
      }

      // Attach the telegram id and consume the challenge.
      await tx.user.update({
        where: { id: webAccount.userId },
        data: { telegramId: telegramIdBig },
      });
      await tx.authChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      });
      return { success: true, userId: webAccount.userId };
    });
  }

  // ── Email ────────────────────────────────────────────────────────────

  public async emailInitiate(
    input: LinkEmailInitiateDto,
  ): Promise<LinkEmailInitiateResultInterface> {
    const webAccount = await this.prismaService.webAccount.findUnique({
      where: { userId: input.userId },
      select: { id: true, emailVerifiedAt: true },
    });
    if (webAccount === null) {
      throw new NotFoundException('Web account not found for this userId');
    }
    const emailNormalized = input.email.trim().toLowerCase();
    const existingEmailOwner = await this.prismaService.webAccount.findFirst({
      where: {
        emailNormalized,
        userId: { not: input.userId },
      },
      select: { id: true },
    });
    if (existingEmailOwner !== null) {
      throw new ConflictException('Email is already linked to another web account');
    }
    const code = this.makeNumericCode(6);
    const codeHash = this.hash(code);
    const expiresAt = new Date(Date.now() + LinkingService.CODE_TTL_MS);

    await this.prismaService.$transaction(async (tx) => {
      await tx.authChallenge.updateMany({
        where: {
          webAccountId: webAccount.id,
          purpose: LinkingService.EMAIL_PURPOSE,
          consumedAt: null,
        },
        data: { consumedAt: new Date() },
      });
      await tx.authChallenge.create({
        data: {
          webAccountId: webAccount.id,
          purpose: LinkingService.EMAIL_PURPOSE,
          channel: 'email',
          destination: emailNormalized,
          codeHash,
          attemptsLeft: LinkingService.DEFAULT_ATTEMPTS_LEFT,
          expiresAt,
        },
      });
      // Stash the candidate email on the WebAccount but leave
      // `emailVerifiedAt` untouched until `verify` succeeds.
      await tx.webAccount.update({
        where: { id: webAccount.id },
        data: {
          email: input.email,
          emailNormalized,
          emailVerifiedAt: null,
        },
      });
    });

    try {
      await this.emailService.sendLinkedAccountVerificationCode({
        emailAddress: input.email,
        code,
        expiresAt,
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Email link delivery failed for ${input.userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { success: false, message: 'Failed to send verification email' };
    }
    return { success: true, message: 'Verification code sent' };
  }

  public async emailVerify(
    input: LinkEmailVerifyDto,
  ): Promise<LinkEmailVerifyResultInterface> {
    const codeHash = this.hash(input.code);
    return this.prismaService.$transaction(async (tx) => {
      const webAccount = await tx.webAccount.findUnique({
        where: { userId: input.userId },
        select: { id: true },
      });
      if (webAccount === null) {
        return { success: false, verified: false };
      }
      const challenge = await tx.authChallenge.findFirst({
        where: {
          webAccountId: webAccount.id,
          purpose: LinkingService.EMAIL_PURPOSE,
          consumedAt: null,
          expiresAt: { gt: new Date() },
          attemptsLeft: { gt: 0 },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (challenge === null) {
        return { success: false, verified: false };
      }
      if (challenge.codeHash !== codeHash) {
        const now = new Date();
        const attemptsLeft = Math.max(challenge.attemptsLeft - 1, 0);
        await tx.authChallenge.update({
          where: { id: challenge.id },
          data: {
            attemptsLeft: { decrement: 1 },
            consumedAt: attemptsLeft === 0 ? now : null,
          },
        });
        return { success: false, verified: false };
      }
      const now = new Date();
      await tx.authChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: now },
      });
      await tx.webAccount.update({
        where: { id: webAccount.id },
        data: { emailVerifiedAt: now },
      });
      return { success: true, verified: true };
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private makeNumericCode(length: number): string {
    const buf = randomBytes(length);
    let code = '';
    for (let i = 0; i < length; i += 1) {
      code += String(buf[i] % 10);
    }
    return code;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }
}
