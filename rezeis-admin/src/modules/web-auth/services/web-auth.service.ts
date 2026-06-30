import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { RawCacheService } from '../../../common/cache/raw-cache.service';
import {
  EVENT_TYPES,
  SystemEventsService,
} from '../../../common/services/system-events.service';
import { PasswordHashService } from '../../auth/services/password-hash.service';
import { EmailDeliveryService } from '../../email/services/email-delivery.service';
import { loginPolicy } from '../../auth/utils/login-policy.util';
import { readInviteBypassFlag } from '../../referrals/services/referral-invite-limits.service';
import { ReferralManualAttachService } from '../../referrals/services/referral-manual-attach.service';
import { AccessModeGuard } from '../../settings/services/access-mode-guard.service';
import { SettingsService } from '../../settings/services/settings.service';
import { tempPasswordCacheKey } from '../../users/utils/temp-password-cache.util';
import { WebAuthChangePasswordDto } from '../dto/web-auth-change-password.dto';
import { WebAuthClaimDto } from '../dto/web-auth-claim.dto';
import { WebAuthLoginDto } from '../dto/web-auth-login.dto';
import { WebAuthRecoverDto } from '../dto/web-auth-recover.dto';
import { WebAuthRegisterDto } from '../dto/web-auth-register.dto';
import { WebAuthTelegramClaimDto } from '../dto/web-auth-telegram-claim.dto';
import {
  WebAuthChangePasswordResultInterface,
  WebAuthLoginResultInterface,
  WebAuthRecoverResultInterface,
  WebAuthRegisterResultInterface,
  WebAuthTelegramClaimResultInterface,
} from '../interfaces/web-auth.interface';

/**
 * WebAuthService
 * ──────────────
 * Owns the four credential flows reiwa exposes to its SPA / Mini App:
 *
 *  - **register**: create a `WebAccount` either against an existing
 *    Telegram-first `User` (the bot flow that asks the user to set up
 *    credentials inside the Mini App) or against a brand-new web-first
 *    `User`. The canonical `reiwa_id` is the `User.id` CUID either way.
 *  - **login**: verify login + password and return a session payload.
 *  - **recover**: pick the recovery channel based on what the user has
 *    linked. Implementations of the actual delivery (email / telegram)
 *    live in `EmailModule` / future telegram realtime stream — this
 *    method only signals which channel the SPA should advertise.
 *  - **change-password**: rotates the stored hash after verifying the
 *    current password.
 *
 * Threat model:
 *  - Plain text passwords land here through the JWT-authenticated
 *    internal API on the closed `remnawave-network`. The wire is hashed
 *    on TLS by the reverse proxy that fronts reiwa; admin always stores
 *    the scrypt digest emitted by `PasswordHashService`.
 *  - Login lookups go through `loginPolicy.normalizeLogin` so trailing
 *    whitespace / case differences cannot create duplicate accounts.
 *  - Failed login responses are intentionally generic (`Invalid login or
 *    password`) to avoid user-enumeration via timing or message.
 */
@Injectable()
export class WebAuthService {
  private readonly logger = new Logger(WebAuthService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly passwordHashService: PasswordHashService,
    private readonly referralManualAttachService: ReferralManualAttachService,
    private readonly settingsService: SettingsService,
    private readonly accessModeGuard: AccessModeGuard,
    private readonly cacheService: RawCacheService,
    private readonly systemEventsService: SystemEventsService,
    private readonly emailDeliveryService: EmailDeliveryService,
  ) {}

  public async register(input: WebAuthRegisterDto): Promise<WebAuthRegisterResultInterface> {
    // Two-layer enforcement (Property 2): the reiwa edge runs the same
    // check, but a direct internal API call would otherwise bypass the
    // platform access mode. See `.kiro/specs/access-mode-enforcement`.
    const policy = await this.settingsService.getInternalPlatformPolicy();
    const hasInviteCode =
      typeof input.referralCode === 'string' && input.referralCode.trim().length > 0;
    const rejection = this.accessModeGuard.evaluate({
      gate: 'register',
      mode: policy.accessMode,
      hasInvite: hasInviteCode,
    });
    if (rejection !== null) {
      throw rejection.status === 503
        ? new ServiceUnavailableException({ code: rejection.code, message: rejection.message })
        : new ForbiddenException({ code: rejection.code, message: rejection.message });
    }

    // Under `INVITED` mode the referral code must actually resolve to a
    // valid referrer. We also read the inviter's per-user
    // `bypassInviteGate` flag (Property 8) — when true, the referrer is
    // exempt from any future global TTL / slot caps applied at sign-up.
    if (policy.accessMode === 'INVITED' && hasInviteCode) {
      const referrer = await this.resolveReferrerWithBypass(input.referralCode!.trim());
      if (referrer === null) {
        throw new ForbiddenException({
          code: 'INVITE_REQUIRED',
          message: 'Referral code is invalid or has expired',
        });
      }
      this.logger.log(
        `INVITED registration accepted via referrer=${referrer.id} bypass=${referrer.bypass}`,
      );
    }

    if (!loginPolicy.isValidLogin(input.login)) {
      throw new BadRequestException('login is invalid');
    }
    const login = loginPolicy.sanitizeLogin(input.login);
    const loginNormalized = loginPolicy.normalizeLogin(input.login);
    const passwordHash = await this.passwordHashService.hashPassword({
      plainTextPassword: input.password,
    });
    const emailNormalized = input.email ? input.email.trim().toLowerCase() : null;

    const result = await this.prismaService.$transaction(async (tx) => {
      // Phase 1 — pick or create the User row that owns this credential.
      const user = await this.resolveOrCreateUser(tx, {
        telegramIdToLink: input.telegramIdToLink ?? null,
        email: emailNormalized,
      });

      // Phase 2 — guard against duplicate WebAccount on the same User.
      const existingWebAccount = await tx.webAccount.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });
      if (existingWebAccount !== null) {
        throw new ConflictException('User already has a web account');
      }

      // Phase 3 — guard against login conflicts (case-insensitive).
      const loginConflict = await tx.webAccount.findUnique({
        where: { loginNormalized },
        select: { id: true },
      });
      if (loginConflict !== null) {
        throw new ConflictException('login is already taken');
      }

      // Phase 4 — create the WebAccount.
      const webAccount = await tx.webAccount.create({
        data: {
          userId: user.id,
          login,
          loginNormalized,
          email: input.email ?? null,
          emailNormalized,
          passwordHash,
          requiresPasswordChange: false,
          credentialsBootstrappedAt: new Date(),
        },
        select: { id: true },
      });

      return {
        userId: user.id,
        webAccountId: webAccount.id,
      };
    });

    // Emit the web-registration event. Previously `USER_WEB_REGISTERED` was
    // defined but never emitted, so a web sign-up notified no one. Fires once
    // per successful registration; `linkedTelegram` distinguishes a brand-new
    // web-first user from a Telegram-first user adding credentials.
    this.systemEventsService.info(
      EVENT_TYPES.USER_WEB_REGISTERED,
      'USER',
      `New web registration: ${login}`,
      {
        reiwaId: result.userId,
        webAccountId: result.webAccountId,
        login,
        hasEmail: emailNormalized !== null,
        linkedTelegram: input.telegramIdToLink != null,
        usedReferral: typeof input.referralCode === 'string' && input.referralCode.trim().length > 0,
        source: 'web',
      },
    );

    // Phase 5 — consume the referral invite link (best-effort, outside the
    // credential transaction so a referral hiccup never blocks sign-up).
    // The `?ref=<code>` carries the referrer's identity (reiwa_id / telegramId
    // / username / referralCode); attaching creates the Referral edge that the
    // "invited-only" gating and partner chain rely on.
    if (input.referralCode) {
      await this.consumeReferralCode(result.userId, input.referralCode);
    }

    return result;
  }

  /**
   * Claim: attach a `WebAccount` (login + password) to an ALREADY-EXISTING
   * `User` identified by its canonical reiwa_id. Used by the mandatory
   * first-entry onboarding for Telegram-first users (who have a `User` but no
   * `WebAccount`). Mirrors `register` phases 2-4 but the user is known, so it
   * never creates a new `User` and never resolves by Telegram id — the caller
   * (reiwa BFF) passes the userId from the authenticated WebSession, so it can
   * only ever attach credentials to the caller's own account.
   */
  public async claim(input: WebAuthClaimDto): Promise<WebAuthRegisterResultInterface> {
    if (!loginPolicy.isValidLogin(input.login)) {
      throw new BadRequestException('login is invalid');
    }
    const login = loginPolicy.sanitizeLogin(input.login);
    const loginNormalized = loginPolicy.normalizeLogin(input.login);
    const passwordHash = await this.passwordHashService.hashPassword({
      plainTextPassword: input.password,
    });

    return this.prismaService.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: input.userId },
        select: { id: true },
      });
      if (user === null) {
        throw new NotFoundException('User not found');
      }

      const existingWebAccount = await tx.webAccount.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });
      if (existingWebAccount !== null) {
        throw new ConflictException('User already has a web account');
      }

      const loginConflict = await tx.webAccount.findUnique({
        where: { loginNormalized },
        select: { id: true },
      });
      if (loginConflict !== null) {
        throw new ConflictException('login is already taken');
      }

      const webAccount = await tx.webAccount.create({
        data: {
          userId: user.id,
          login,
          loginNormalized,
          passwordHash,
          requiresPasswordChange: false,
          credentialsBootstrappedAt: new Date(),
        },
        select: { id: true },
      });

      return { userId: user.id, webAccountId: webAccount.id };
    });
  }

  /**
   * Self-service Telegram link from the Mini App. The reiwa BFF has already
   * proven control of the Telegram id `T` (via `initData`); the user proves
   * ownership of their existing web account with login + password. We then bind
   * `T` to that account when it is SAFE:
   *
   *   - `T` is unlinked            → set `target.telegramId = T` (`linked`).
   *   - `T` already → target       → idempotent (`already_linked`).
   *   - `T` → a different EMPTY     → retire the empty shell, then link
   *     shell account B               (`linked`).
   *   - `T` → a different account   → refuse (`needs_admin_merge`); the
   *     with material data            operator merges via the admin panel.
   *   - target already has a        → refuse (`web_account_has_other_telegram`).
   *     different Telegram linked
   *
   * Invalid credentials yield the same generic failure as `login` (no
   * enumeration). Runs in one transaction; re-pointing/retiring is atomic.
   */
  public async telegramClaim(
    input: WebAuthTelegramClaimDto,
  ): Promise<WebAuthTelegramClaimResultInterface> {
    if (!loginPolicy.isValidLogin(input.login)) {
      throw new UnauthorizedException('Invalid login or password');
    }
    const loginNormalized = loginPolicy.normalizeLogin(input.login);
    const telegramIdBig = BigInt(input.telegramId);

    const outcome = await this.prismaService.$transaction(async (tx) => {
      // 1. Verify credentials → resolve the target web account / user.
      const webAccount = await tx.webAccount.findUnique({
        where: { loginNormalized },
        select: { userId: true, passwordHash: true },
      });
      if (webAccount === null || webAccount.passwordHash === null) {
        throw new UnauthorizedException('Invalid login or password');
      }
      const ok = await this.passwordHashService.verifyPassword({
        plainTextPassword: input.password,
        passwordHash: webAccount.passwordHash,
      });
      if (!ok) {
        throw new UnauthorizedException('Invalid login or password');
      }

      const target = await tx.user.findUnique({
        where: { id: webAccount.userId },
        select: { id: true, telegramId: true },
      });
      if (target === null) {
        // WebAccount.userId is an FK, so this is unreachable in practice; treat
        // as a generic failure rather than leaking internal state.
        throw new UnauthorizedException('Invalid login or password');
      }

      // 2. Reconcile the target's current Telegram binding.
      if (target.telegramId === telegramIdBig) {
        return { status: 'already_linked' as const, userId: target.id };
      }
      if (target.telegramId !== null) {
        return { status: 'web_account_has_other_telegram' as const };
      }

      // 3. Who currently owns Telegram id T?
      const owner = await tx.user.findUnique({
        where: { telegramId: telegramIdBig },
        select: { id: true },
      });
      if (owner === null) {
        await tx.user.update({ where: { id: target.id }, data: { telegramId: telegramIdBig } });
        return { status: 'linked' as const, userId: target.id, retiredShell: false };
      }
      if (owner.id === target.id) {
        return { status: 'already_linked' as const, userId: target.id };
      }

      // 4. A different account B owns T. Only an EMPTY shell may be retired.
      if (!(await this.isEmptyShell(tx, owner.id))) {
        return { status: 'needs_admin_merge' as const };
      }
      // Clear the unique telegram id off B before deleting so the subsequent
      // set on the target can never transiently collide; then retire B and
      // bind T to the target.
      await tx.user.update({ where: { id: owner.id }, data: { telegramId: null } });
      await tx.user.delete({ where: { id: owner.id } });
      await tx.user.update({ where: { id: target.id }, data: { telegramId: telegramIdBig } });
      return { status: 'linked' as const, userId: target.id, retiredShell: true };
    });

    if (outcome.status === 'linked') {
      this.systemEventsService.info(
        EVENT_TYPES.USER_TELEGRAM_LINKED,
        'USER',
        'Telegram linked via Mini App login',
        {
          userId: outcome.userId,
          telegramId: input.telegramId,
          source: 'miniapp_link_existing',
          retiredShell: outcome.retiredShell === true,
        },
      );
      return { status: 'linked', userId: outcome.userId };
    }
    if (outcome.status === 'already_linked') {
      return { status: 'already_linked', userId: outcome.userId };
    }
    return { status: outcome.status };
  }

  /**
   * True when `userId` is an EMPTY Telegram shell that is safe to retire during
   * a self-service link: it carries no material data. A trial-only shell IS
   * empty (its trial subscription / grant are discarded with it). Anything that
   * would block the `User` delete (`onDelete: Restrict` rows) or that belongs
   * to someone else's ledger (partner chain) makes it non-empty → the operator
   * must merge instead.
   */
  private async isEmptyShell(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<boolean> {
    const [
      webAccount,
      transactions,
      partner,
      nonTrialSubscriptions,
      referralRewards,
      promocodeActivations,
      partnerLedgerEntries,
      partnerReferralEdges,
      referralsGiven,
    ] = await Promise.all([
      tx.webAccount.findUnique({ where: { userId }, select: { id: true } }),
      tx.transaction.count({ where: { userId } }),
      tx.partner.findUnique({ where: { userId }, select: { id: true } }),
      tx.subscription.count({ where: { userId, isTrial: false } }),
      tx.referralReward.count({ where: { userId } }),
      tx.promocodeActivation.count({ where: { userId } }),
      tx.partnerTransaction.count({ where: { referralUserId: userId } }),
      tx.partnerReferral.count({ where: { referralUserId: userId } }),
      tx.referral.count({ where: { referrerId: userId } }),
    ]);
    return (
      webAccount === null &&
      transactions === 0 &&
      partner === null &&
      nonTrialSubscriptions === 0 &&
      referralRewards === 0 &&
      promocodeActivations === 0 &&
      partnerLedgerEntries === 0 &&
      partnerReferralEdges === 0 &&
      referralsGiven === 0
    );
  }

  /**
   * Resolves a referral code to a referrer user and attaches the new user as
   * their referral. Silently no-ops on self-referral, unknown codes, or an
   * already-attributed user — registration must never fail because of a bad
   * or duplicate referral link.
   */
  private async consumeReferralCode(newUserId: string, rawCode: string): Promise<void> {
    try {
      const code = rawCode.trim();
      if (code.length === 0) {
        return;
      }
      const referrer = await this.resolveReferrer(code);
      if (referrer === null || referrer.id === newUserId) {
        return;
      }
      await this.referralManualAttachService.attachReferrerManually({
        userId: newUserId,
        referrerId: referrer.id,
      });
    } catch (error) {
      // Duplicate attribution / self-referral throw BadRequest — these are
      // expected and must not break the registration response.
      this.logger.warn(
        `Referral consume skipped for user ${newUserId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Resolves a referral code into a referrer `User`. Accepts the canonical
   * reiwa_id (CUID), a numeric telegramId, a username, or the user's
   * `referralCode`. Returns `null` when nothing matches.
   */
  private async resolveReferrer(code: string): Promise<{ id: string } | null> {
    const orConditions: Prisma.UserWhereInput[] = [
      { id: code },
      { username: code },
      { referralCode: code },
    ];
    if (/^\d{1,19}$/.test(code)) {
      orConditions.push({ telegramId: BigInt(code) });
    }
    return this.prismaService.user.findFirst({
      where: { OR: orConditions },
      select: { id: true },
    });
  }

  /**
   * Like {@link resolveReferrer}, but also returns the inviter's
   * per-user `bypassInviteGate` flag from `User.referralInviteSettings`.
   * Used by the platform `INVITED` access-mode gate (Requirement 7,
   * Property 8) so a VIP referrer admits new sign-ups regardless of
   * future global TTL / slot caps.
   */
  private async resolveReferrerWithBypass(
    code: string,
  ): Promise<{ id: string; bypass: boolean } | null> {
    const orConditions: Prisma.UserWhereInput[] = [
      { id: code },
      { username: code },
      { referralCode: code },
    ];
    if (/^\d{1,19}$/.test(code)) {
      orConditions.push({ telegramId: BigInt(code) });
    }
    const referrer = await this.prismaService.user.findFirst({
      where: { OR: orConditions },
      select: { id: true, referralInviteSettings: true },
    });
    if (referrer === null) return null;
    return { id: referrer.id, bypass: readInviteBypassFlag(referrer.referralInviteSettings) };
  }

  /**
   * Non-mutating availability probe for a login. Used by the SPA's
   * register form to give live "username taken" feedback **without**
   * creating an account or burning the registration rate limit (the old
   * behaviour fired a real `register` per keystroke with a dummy hash).
   *
   * Returns `{ available: false }` for malformed logins too, so the UI
   * doesn't advertise an invalid handle as free.
   */
  public async checkLoginAvailable(login: string): Promise<{ available: boolean }> {
    if (!loginPolicy.isValidLogin(login)) {
      return { available: false };
    }
    const loginNormalized = loginPolicy.normalizeLogin(login);
    const existing = await this.prismaService.webAccount.findUnique({
      where: { loginNormalized },
      select: { id: true },
    });
    return { available: existing === null };
  }

  public async login(input: WebAuthLoginDto): Promise<WebAuthLoginResultInterface> {
    if (!loginPolicy.isValidLogin(input.login)) {
      throw new UnauthorizedException('Invalid login or password');
    }
    const loginNormalized = loginPolicy.normalizeLogin(input.login);
    const webAccount = await this.prismaService.webAccount.findUnique({
      where: { loginNormalized },
      include: { user: { select: { telegramId: true } } },
    });
    if (webAccount === null) {
      throw new UnauthorizedException('Invalid login or password');
    }
    // Claim-on-first-login: a migrated web-only account (importer-flagged) has
    // no password yet. Adopt whatever password the user submits, clear the
    // pending flag, and force a reset on entry. Confined to the explicit flag
    // so no ordinary null-hash account is claimable.
    if (webAccount.passwordHash === null) {
      if (!webAccount.passwordBootstrapPending) {
        throw new UnauthorizedException('Invalid login or password');
      }
      const claimedHash = await this.passwordHashService.hashPassword({
        plainTextPassword: input.password,
      });
      await this.prismaService.webAccount.update({
        where: { id: webAccount.id },
        data: {
          passwordHash: claimedHash,
          passwordBootstrapPending: false,
          requiresPasswordChange: true,
          credentialsBootstrappedAt: webAccount.credentialsBootstrappedAt ?? new Date(),
        },
      });
      return {
        userId: webAccount.userId,
        requiresPasswordChange: true,
        telegramLinked: webAccount.user.telegramId !== null,
        emailVerified: webAccount.emailVerifiedAt !== null,
      };
    }
    const ok = await this.passwordHashService.verifyPassword({
      plainTextPassword: input.password,
      passwordHash: webAccount.passwordHash,
    });
    if (!ok) {
      throw new UnauthorizedException('Invalid login or password');
    }
    return {
      userId: webAccount.userId,
      requiresPasswordChange: webAccount.requiresPasswordChange,
      telegramLinked: webAccount.user.telegramId !== null,
      emailVerified: webAccount.emailVerifiedAt !== null,
    };
  }

  public async recover(input: WebAuthRecoverDto): Promise<WebAuthRecoverResultInterface> {
    const loginNormalized = loginPolicy.normalizeLogin(input.login);
    const webAccount = await this.prismaService.webAccount.findUnique({
      where: { loginNormalized },
      include: { user: { select: { telegramId: true } } },
    });
    if (webAccount === null) {
      // Do not leak existence — pretend the recovery flow is "none".
      return { method: 'none' };
    }
    if (webAccount.user.telegramId !== null) {
      // Telegram-first: the actual delivery is handled by the bot's
      // recovery handler, which polls / streams for pending challenges.
      // Recovery code persistence (and TTL) is covered by the linking
      // module's `auth_challenges` rows when the SPA initiates flow.
      return { method: 'telegram' };
    }
    if (webAccount.email !== null && webAccount.emailVerifiedAt !== null) {
      // Only advertise email recovery when platform email delivery is actually
      // configured + enabled — otherwise the code can't be delivered and the
      // SPA would show a dead-end "check your email" screen.
      const smtp = await this.emailDeliveryService.getSmtpSettings();
      const emailEnabled =
        smtp.enabled === true && typeof smtp.host === 'string' && smtp.host.trim().length > 0;
      if (emailEnabled) {
        return { method: 'email' };
      }
    }
    return { method: 'none' };
  }

  public async changePassword(
    input: WebAuthChangePasswordDto,
  ): Promise<WebAuthChangePasswordResultInterface> {
    const webAccount = await this.prismaService.webAccount.findUnique({
      where: { userId: input.userId },
    });
    if (webAccount === null || webAccount.passwordHash === null) {
      throw new NotFoundException('Web account not found');
    }
    const ok = await this.passwordHashService.verifyPassword({
      plainTextPassword: input.currentPassword,
      passwordHash: webAccount.passwordHash,
    });
    if (!ok) {
      throw new UnauthorizedException('Invalid current password');
    }
    const newPasswordHash = await this.passwordHashService.hashPassword({
      plainTextPassword: input.newPassword,
    });
    await this.prismaService.webAccount.update({
      where: { id: webAccount.id },
      data: {
        passwordHash: newPasswordHash,
        requiresPasswordChange: false,
        temporaryPasswordExpiresAt: null,
      },
    });
    // Clear the operator-viewable temporary password — the user has set their
    // own, so it must no longer be retrievable from the admin panel.
    await this.cacheService.del(tempPasswordCacheKey(webAccount.id));
    return { success: true };
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private async resolveOrCreateUser(
    tx: Prisma.TransactionClient,
    input: { telegramIdToLink: string | null; email: string | null },
  ): Promise<{ id: string }> {
    if (input.telegramIdToLink !== null) {
      const telegramIdBig = BigInt(input.telegramIdToLink);
      const existing = await tx.user.findUnique({
        where: { telegramId: telegramIdBig },
        select: { id: true },
      });
      if (existing === null) {
        throw new NotFoundException(
          `User with telegramId=${input.telegramIdToLink} not found — bot must call bootstrap first`,
        );
      }
      // Optionally surface the email on the canonical `User` row for
      // recovery flows. Keep idempotent: only set when missing.
      if (input.email !== null) {
        await tx.user.updateMany({
          where: { id: existing.id, email: null },
          data: { email: input.email },
        });
      }
      return existing;
    }
    return tx.user.create({
      data: {
        name: '',
        email: input.email,
      },
      select: { id: true },
    });
  }
}
