import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { BlockedIdentityKind, Prisma, ReferralInviteSource } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { RawCacheService } from '../../../common/cache/raw-cache.service';
import {
  EVENT_TYPES,
  SystemEventsService,
} from '../../../common/services/system-events.service';
import { PasswordHashService } from '../../auth/services/password-hash.service';
import { BlockedIdentityService } from '../../blocked-identities/services/blocked-identity.service';
import { BlockedIpService } from '../../blocked-ips/services/blocked-ip.service';
import { EmailDeliveryService } from '../../email/services/email-delivery.service';
import { LegalDocumentsService } from '../../legal-documents/services/legal-documents.service';
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
import { RegistrationSnapshotService } from './registration-snapshot.service';

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
    private readonly registrationSnapshotService: RegistrationSnapshotService,
    private readonly legalDocumentsService: LegalDocumentsService,
    /**
     * Optional so every existing construction of this service keeps working.
     * An absent list reads as "nothing is pre-blocked", which is the safe
     * direction: a missing dependency must never refuse every registration.
     */
    @Optional() private readonly blockedIdentityService?: BlockedIdentityService,
    @Optional() private readonly blockedIpService?: BlockedIpService,
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

    // The identity blocklist, checked BEFORE the invite resolution and before
    // any row is written. This is the door `users.is_blocked` cannot guard:
    // that flag refuses a row that already exists, and somebody registering
    // again has no row yet. All three identities are asked about at once,
    // because a person banned by e-mail will simply pick a different login.
    //
    // The refusal is deliberately the SAME shape as the access-mode one and
    // says nothing about which identity matched: a distinguishable answer here
    // turns the sign-up form into an oracle for "is this e-mail banned".
    const listed = await this.blockedIdentityService?.findFirstMatch([
      {
        kind: BlockedIdentityKind.TELEGRAM_ID,
        value: input.telegramIdToLink?.toString() ?? null,
      },
      { kind: BlockedIdentityKind.EMAIL, value: input.email ?? null },
      { kind: BlockedIdentityKind.WEB_LOGIN, value: input.login },
    ]);
    if (listed !== null && listed !== undefined) {
      this.logger.warn(`Registration refused: identity is on the blocklist (entry ${listed.id})`);
      throw new ForbiddenException({
        code: 'REGISTRATION_DISABLED',
        message: 'Registration is currently disabled',
      });
    }

    // The address the sign-up came FROM, checked against the IP blocklist.
    //
    // WHY IT IS READ FROM THE PAYLOAD AND NOT FROM THE REQUEST. The global
    // `BlockedIpGuard` in front of this panel sees whoever called it, and the
    // caller here is the cabinet, not the customer: on a split deployment every
    // sign-up in the world arrives from one address. The customer address is
    // known only because the cabinet already sends it for the registration
    // snapshot a few lines below — so this is the ONE place in the panel where
    // an IP block can actually reach a subscriber.
    //
    // It is therefore not a general defence. A blocked address still reaches
    // login, the bot and the Mini App untouched; this closes the registration
    // door specifically, which is the door ban evasion has to come through.
    const snapshotIp = input.registrationSnapshot?.ip ?? null;
    if (typeof snapshotIp === 'string' && snapshotIp.trim().length > 0) {
      const verdict = await this.blockedIpService?.isBlocked(snapshotIp);
      if (verdict?.blocked === true) {
        this.logger.warn('Registration refused: address is on the IP blocklist');
        throw new ForbiddenException({
          code: 'REGISTRATION_DISABLED',
          message: 'Registration is currently disabled',
        });
      }
    }

    // Under `INVITED` mode the referral code must actually resolve to a
    // valid referrer. We also read the inviter's per-user
    // `bypassInviteGate` flag (Property 8) — when true, the referrer is
    // exempt from any future global TTL / slot caps applied at sign-up.
    if (policy.accessMode === 'INVITED' && hasInviteCode) {
      const referrer = await this.resolveReferrerWithBypass(input.referralCode!.trim());
      // Admission requires a real single-use invite. A permanent sharing code
      // still attributes the referral once registered, but it does not open the
      // gate — otherwise every existing user is an unlimited invite generator
      // and the whole INVITED mode is decorative.
      if (referrer === null || !referrer.viaInvite) {
        throw new ForbiddenException({
          code: 'INVITE_REQUIRED',
          message: 'Referral code is invalid or has expired',
        });
      }
      this.logger.log(
        `INVITED registration accepted via referrer=${referrer.id} bypass=${referrer.bypass}`,
      );
    }

    // Legal documents the operator has switched on. Checked HERE — before any
    // row is written — so a refusal costs nothing: there is no account to
    // delete, no referral edge to unwind, no audit line claiming a
    // registration that did not happen.
    //
    // Two-layer enforcement, same reasoning as the access-mode gate above: the
    // sign-up form disables its button until every box is ticked, but a direct
    // call to this internal API would sail straight past that.
    const requiredDocuments = await this.legalDocumentsService.listRequiredKeys();
    const acceptedDocuments = input.acceptedLegalDocuments ?? [];
    const missingDocuments = requiredDocuments.filter((key) => !acceptedDocuments.includes(key));
    if (missingDocuments.length > 0) {
      throw new ForbiddenException({
        code: 'LEGAL_CONSENT_REQUIRED',
        message: 'Registration requires accepting the current legal documents',
        documents: missingDocuments,
      });
    }

    if (!loginPolicy.isValidLogin(input.login)) {
      throw new BadRequestException('login is invalid');
    }
    const login = loginPolicy.sanitizeLogin(input.login);
    const loginNormalized = loginPolicy.normalizeLogin(input.login);
    const passwordHash = await this.passwordHashService.hashPassword({
      plainTextPassword: input.password,
      audience: 'subscriber',
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

      // Phase 5 — record the consent inside the same transaction that created
      // the account. Outside it, a rolled-back registration would leave a row
      // claiming someone agreed to something before they existed; and an
      // account could commit while the consent write failed, producing exactly
      // the state the gate exists to prevent.
      await this.legalDocumentsService.recordConsents(tx, user.id, requiredDocuments);

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
        // `userId` makes the admin-notification "user" block render; `userName`
        // carries the login so a web-first user (no name/username/telegram) is
        // identified by their login instead of a blank line.
        userId: result.userId,
        userName: login,
        reiwaId: result.userId,
        webAccountId: result.webAccountId,
        login,
        hasEmail: emailNormalized !== null,
        linkedTelegram: input.telegramIdToLink != null,
        usedReferral: typeof input.referralCode === 'string' && input.referralCode.trim().length > 0,
        source: 'web',
      },
    );

    // Write-once registration snapshot (IP/UA/Referer/UTM). Best-effort;
    // never blocks account creation. Bot-first users keep acquisition* from
    // the bot path; this only fills empty registration* fields once.
    const snap = input.registrationSnapshot;
    if (snap !== undefined) {
      await this.registrationSnapshotService.captureBestEffort({
        userId: result.userId,
        channel:
          snap.channel === 'tma' || snap.channel === 'bot' || snap.channel === 'oauth'
            ? snap.channel
            : 'web',
        ip: snap.ip ?? null,
        userAgent: snap.userAgent ?? null,
        referer: snap.referer ?? null,
        utm: snap.utm ?? null,
      });
    }

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
      audience: 'subscriber',
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
   * a self-service link. A trial claim is durable eligibility history, so a
   * trial-only shell is no longer empty. Anything that would block the `User`
   * delete (`onDelete: Restrict` rows) or that belongs to someone else's ledger
   * (partner chain) makes it non-empty → the operator must merge instead.
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
      referralPointsExchanges,
      partnerLedgerEntries,
      partnerReferralEdges,
      referralsGiven,
      trialClaims,
    ] = await Promise.all([
      tx.webAccount.findUnique({ where: { userId }, select: { id: true } }),
      tx.transaction.count({ where: { userId } }),
      tx.partner.findUnique({ where: { userId }, select: { id: true } }),
      tx.subscription.count({ where: { userId, isTrial: false } }),
      tx.referralReward.count({ where: { userId } }),
      tx.promocodeActivation.count({ where: { userId } }),
      tx.referralPointsExchange.count({ where: { userId } }),
      tx.partnerTransaction.count({ where: { referralUserId: userId } }),
      tx.partnerReferral.count({ where: { referralUserId: userId } }),
      tx.referral.count({ where: { referrerId: userId } }),
      tx.trialClaim.count({ where: { userId } }),
    ]);
    return (
      webAccount === null &&
      transactions === 0 &&
      partner === null &&
      nonTrialSubscriptions === 0 &&
      referralRewards === 0 &&
      promocodeActivations === 0 &&
      referralPointsExchanges === 0 &&
      partnerLedgerEntries === 0 &&
      partnerReferralEdges === 0 &&
      referralsGiven === 0 &&
      trialClaims === 0
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
      // Single-use invite: claim it atomically BEFORE attaching, so two
      // concurrent registrations can't both spend the same token (which would
      // give the inviter two referrals and two rewards). Mirrors the bot path.
      const inviteId = referrer.inviteId;
      const claimedAt = new Date();
      if (inviteId !== undefined) {
        const claimed = await this.prismaService.referralInvite.updateMany({
          where: { id: inviteId, consumedAt: null },
          data: { consumedAt: claimedAt },
        });
        if (claimed.count === 0) {
          return;
        }
      }
      try {
        await this.referralManualAttachService.attachReferrerManually({
          userId: newUserId,
          referrerId: referrer.id,
          // Reached only from a `?ref=<token>` web sign-up. A bot-issued token
          // redeemed on the web is still a WEB edge: the source records where
          // the referral was *taken up*, not who minted the token.
          inviteSource: ReferralInviteSource.WEB,
          // A customer redeemed their own invite link — no operator performed
          // this, so there is nothing to attribute. See the bot sign-up copy in
          // `internal-user-edge.service.ts`.
          operator: null,
        });
      } catch (attachError) {
        if (inviteId !== undefined) {
          await this.releaseInviteClaimBestEffort(inviteId, claimedAt, newUserId);
        }
        throw attachError;
      }
    } catch (error) {
      // Duplicate attribution / self-referral throw BadRequest — these are
      // expected and must not break the registration response.
      this.logger.warn(
        `Referral consume skipped for user ${newUserId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Resolves a referral code into a referrer `User`. Accepts a bot-issued
   * single-use `ReferralInvite.token`, the canonical reiwa_id (CUID), a numeric
   * telegramId, a username, or the user's `referralCode`. Returns `null` when
   * nothing matches. Mirrors `InternalUserEdgeService.resolveReferrer` so a
   * token shared from the bot works on the web sign-up too.
   */
  private async resolveReferrer(
    code: string,
  ): Promise<{ id: string; inviteId?: string } | null> {
    // Invite tokens first — they live in the narrower, server-generated
    // namespace, whereas `username` is user-controlled and could be squatted to
    // hijack a live invite link.
    const invite = await this.findLiveInvite(code);
    if (invite !== null) {
      const inviter = await this.prismaService.user.findFirst({
        where: { id: invite.inviterId, isBlocked: false },
        select: { id: true },
      });
      return inviter === null ? null : { id: inviter.id, inviteId: invite.id };
    }
    const user = await this.prismaService.user.findFirst({
      // A blocked user keeps their link but stops attributing referrals.
      where: { isBlocked: false, OR: this.buildReferrerConditions(code) },
      select: { id: true },
    });
    return user === null ? null : { id: user.id };
  }

  /**
   * Releases a single-use invite claim after a failed attach. Fenced on our own
   * claim timestamp so a concurrent sign-up's claim is never reopened, and
   * skipped entirely when the `Referral` edge already exists — the attach
   * service creates that edge before its later steps, so a partial failure
   * still means the invite was genuinely spent (releasing it would let a second
   * user redeem it and pay the inviter twice).
   */
  private async releaseInviteClaimBestEffort(
    inviteId: string,
    claimedAt: Date,
    newUserId: string,
  ): Promise<void> {
    try {
      const attributed = await this.prismaService.referral.findUnique({
        where: { referredId: newUserId },
        select: { id: true },
      });
      if (attributed !== null) {
        return;
      }
      await this.prismaService.referralInvite.updateMany({
        where: { id: inviteId, consumedAt: claimedAt },
        data: { consumedAt: null },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to release referral invite claim ${inviteId}: ${(error as Error).message}`,
      );
    }
  }

  /** Live (unrevoked, unconsumed, unexpired) invite for a raw token. */
  private async findLiveInvite(
    token: string,
  ): Promise<{ id: string; inviterId: string } | null> {
    return this.prismaService.referralInvite.findFirst({
      where: {
        token,
        revokedAt: null,
        consumedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true, inviterId: true },
    });
  }

  /** Shared `User` lookup shapes for a referral code. */
  private buildReferrerConditions(code: string): Prisma.UserWhereInput[] {
    const orConditions: Prisma.UserWhereInput[] = [
      { id: code },
      { username: code },
      { referralCode: code },
    ];
    if (/^\d{1,19}$/.test(code)) {
      orConditions.push({ telegramId: BigInt(code) });
    }
    return orConditions;
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
  ): Promise<{ id: string; bypass: boolean; viaInvite: boolean } | null> {
    // A bot-issued invite token must open the INVITED gate, and it is the ONLY
    // thing that may: `viaInvite` lets the caller reject a permanent sharing
    // code, which resolves to a referrer for attribution but must not act as an
    // unlimited pass into an invite-only platform.
    const invite = await this.findLiveInvite(code);
    const referrer = await this.prismaService.user.findFirst({
      where:
        invite !== null
          ? { id: invite.inviterId, isBlocked: false }
          : { isBlocked: false, OR: this.buildReferrerConditions(code) },
      select: { id: true, referralInviteSettings: true },
    });
    if (referrer === null) return null;
    return {
      id: referrer.id,
      bypass: readInviteBypassFlag(referrer.referralInviteSettings),
      viaInvite: invite !== null,
    };
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
      include: { user: { select: { telegramId: true, isBlocked: true } } },
    });
    if (webAccount === null) {
      throw new UnauthorizedException('Invalid login or password');
    }
    // A blocked user could log in here with their password.
    //
    // The sibling door, `InternalUserService.signInLinkedWebAccount`, has
    // always refused them — the two verify the SAME `WebAccount.passwordHash`
    // and disagreed about who may enter, and the cabinet uses this one. That
    // is drift, not a decision: every other sign-in route (magic link, OAuth,
    // Mini App bootstrap) refuses a blocked user too.
    //
    // Refused BEFORE the password is verified, unlike the sibling, which
    // checks after. Nothing here is a credential oracle either way — the
    // message is identical to "no such account" — and refusing first means a
    // blocked account cannot be used to test passwords at all.
    if (webAccount.user.isBlocked) {
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
        audience: 'subscriber',
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
    await this.upgradePasswordHashIfNeeded({
      webAccountId: webAccount.id,
      storedPasswordHash: webAccount.passwordHash,
      plainTextPassword: input.password,
    });
    return {
      userId: webAccount.userId,
      requiresPasswordChange: webAccount.requiresPasswordChange,
      telegramLinked: webAccount.user.telegramId !== null,
      emailVerified: webAccount.emailVerifiedAt !== null,
    };
  }

  /**
   * Re-hashes a subscriber password that was stored below the current
   * subscriber scrypt work factor.
   *
   * Raising the cost is only half a change. `PasswordHashService` verifies each
   * hash with the parameters recorded IN that hash, so nobody is locked out —
   * but on its own nobody is upgraded either: a subscriber who never changes
   * their password keeps a Node-default 2^14/r8/p1 hash forever, and subscribers
   * hold nearly every account in the system. A successful sign-in is the one
   * moment the plain text exists in memory, so it is the only moment the row can
   * be rewritten. OWASP's Password Storage Cheat Sheet names exactly this: "wait
   * until the user next authenticates, then re-hash their password with the new
   * work factor."
   *
   * This is the same shape as `AdminAuthService.upgradePasswordHashIfNeeded`,
   * deliberately, including the property that is easy to leave out:
   *
   *   - The write is CONDITIONAL on the hash still being the one that was just
   *     verified (`updateMany` with `passwordHash` in the filter). Between the
   *     verification and this call the user can have changed their password in
   *     another session — or an operator can have issued a temporary one — and
   *     an unconditional write would clobber the new hash with a re-derivation
   *     of the OLD password, silently restoring a credential that was just
   *     revoked.
   *   - It touches ONLY `passwordHash`. Not `requiresPasswordChange`, not
   *     `temporaryPasswordExpiresAt`, not `credentialsBootstrappedAt` — a
   *     re-hash is not a password change, and clearing the reset flag here would
   *     hand a user out of a forced reset they never completed.
   *   - The audience is `'subscriber'` on BOTH calls. Asking `needsRehash` about
   *     the admin row would mark every freshly-written subscriber hash as stale
   *     and rewrite the row on every single sign-in, forever.
   *
   * It can never fail the login. The user authenticated correctly; a database
   * hiccup while opportunistically improving storage is not their problem, and
   * the next sign-in tries again.
   */
  private async upgradePasswordHashIfNeeded(input: {
    readonly webAccountId: string;
    readonly storedPasswordHash: string;
    readonly plainTextPassword: string;
  }): Promise<void> {
    if (!this.passwordHashService.needsRehash(input.storedPasswordHash, 'subscriber')) {
      return;
    }
    try {
      const upgradedHash = await this.passwordHashService.hashPassword({
        plainTextPassword: input.plainTextPassword,
        audience: 'subscriber',
      });
      const { count } = await this.prismaService.webAccount.updateMany({
        where: { id: input.webAccountId, passwordHash: input.storedPasswordHash },
        data: { passwordHash: upgradedHash },
      });
      if (count > 0) {
        this.logger.log(
          `Re-hashed the password of web account ${input.webAccountId} at the current subscriber scrypt work factor`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not re-hash the password of web account ${input.webAccountId}: ${(error as Error).message}`,
      );
    }
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
      audience: 'subscriber',
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
