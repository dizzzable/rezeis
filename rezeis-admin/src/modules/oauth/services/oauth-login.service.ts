import {
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { AuthProviderType } from '@prisma/client';

import { authConfig } from '../../../common/config/auth.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { TwoFactorService } from '../../two-factor/services/two-factor.service';
import {
  OAuthLoginResult,
  OAuthUserProfile,
} from '../interfaces/oauth-provider.interface';

/** Structural handle on the fail2ban counter — see `resolveSecurityServices`. */
type LoginGuardServiceLike = import('../../two-factor/services/login-guard.service').LoginGuardService;

/**
 * What a caller supplies when it has no request to describe. Every field here
 * is telemetry — the key the failure counter groups by, the user agent on the
 * attempt row — so a missing request degrades to "unknown" rather than
 * throwing. Specs that call `processOAuthLogin` positionally land here.
 */
const UNKNOWN_REQUEST_METADATA: RequestMetadataInterface = {
  requestId: null,
  remoteAddress: null,
  userAgent: null,
};

/**
 * Options a caller may pass alongside a verified provider profile.
 */
export interface OAuthLoginOptionsInterface {
  /**
   * 6-digit TOTP or a recovery code, when the caller had somewhere to
   * collect one. Required whenever the linked admin has `totpEnabled = true`;
   * absent, the login is refused with the same `totp_required` signal the
   * password path uses.
   */
  readonly totpCode?: string | null;

  /**
   * Who is asking. Needed because a second-factor guess made here has to spend
   * the same budget a mistyped password spends, and that budget is keyed on
   * (login, ip). Optional so existing positional callers keep compiling; when
   * it is absent the attempt is still counted, under the empty IP, exactly as
   * `AdminAuthService` counts an attempt whose `remoteAddress` is null.
   */
  readonly requestMetadata?: RequestMetadataInterface;
}

/**
 * Handles the OAuth login flow after a provider returns a verified profile.
 *
 * Flow:
 *   1. Provider adapter verifies the OAuth callback and returns OAuthUserProfile
 *   2. This service looks up AdminOAuthLink by (providerType, providerId)
 *   3. If found → issue JWT for the linked admin
 *   4. If not found → check allowedEmails/allowedTelegramIds whitelist
 *   5. If whitelisted → auto-link to matching admin (by email) or reject
 *   6. Audit log the login
 *
 * A verified provider profile is ONE factor. `issueTokenForAdmin()` therefore
 * gates on `AdminUser.totpEnabled` exactly as the password path does — see the
 * comment there for what went wrong while it did not.
 *
 * Failures cost something, which they did not
 *   This file used to name `LoginGuardService` nowhere at all, so the OAuth
 *   sign-in path was the one credential-checking route in the panel with no
 *   fail2ban counter behind it: a rejected second factor was logged and
 *   forgotten, and 600 of them a minute left `admin_login_attempts` empty.
 *   `issueTokenForAdmin` now runs the same `isRateLimited` pre-flight
 *   `AdminAuthService.loginAdmin()` runs, and `assertSecondFactor` charges each
 *   rejection to the same per-(login, ip) budget with the same reason strings.
 *
 *   KNOWN COST, stated rather than discovered later: that budget is shared,
 *   and `login-guard.service.ts:34-43` already documents operators hitting it —
 *   five failures per (login, ip) per 15 minutes covers password mistakes AND
 *   code mistakes together, so three mistyped passwords plus two fumbled codes
 *   is a lockout. Adding this path widens the pool to a third surface: an
 *   operator who fumbles the sign-in form and then tries Telegram is now
 *   spending one budget across both, and can be locked out of every sign-in
 *   route at once. That is the price of the OAuth path counting at all, and
 *   the alternative — a private counter for this path — is worse, because an
 *   attacker with three surfaces would then get three times the guesses.
 *   Separating password failures from second-factor failures is the real fix
 *   and it lives in `AdminAuthService` and `LoginGuardService`, not here.
 */
@Injectable()
export class OAuthLoginService {
  private readonly logger = new Logger(OAuthLoginService.name);

  /**
   * Lazily-resolved 2FA handle, resolved through `ModuleRef` for the same
   * reason `AdminAuthService` does it: `OAuthModule` does not import
   * `TwoFactorModule`, and adding the import would tie two auth modules
   * together for one method call. `{ strict: false }` finds the provider
   * anywhere in the app graph.
   */
  private twoFactorServiceCache: TwoFactorService | null = null;
  private twoFactorResolved = false;

  /**
   * The fail2ban counter, resolved the same lazy way and for the same reason.
   *
   * It is reached through `require()` rather than a static import — the shape
   * `AdminAuthService.resolveSecurityServices()` and
   * `PasskeyService.resolveSecurityServices()` both use — so that
   * `OAuthModule` gains no load-time edge into the two-factor module graph.
   *
   * `null` here means "no counter available", and every consumer below treats
   * that as "do not count", never as "do not check". That asymmetry is
   * deliberate and it is the opposite of how `assertSecondFactor` treats a
   * missing verifier: a missing VERIFIER must refuse, because the alternative
   * is issuing a token on one factor; a missing COUNTER must not refuse,
   * because the alternative is a wiring fault locking every operator out of a
   * login that is otherwise perfectly valid.
   */
  private loginGuardServiceCache: LoginGuardServiceLike | null = null;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly jwtService: JwtService,
    @Inject(authConfig.KEY)
    private readonly authConfiguration: ConfigType<typeof authConfig>,
    @Optional()
    private readonly moduleRef?: ModuleRef,
  ) {}

  private resolveTwoFactorService(): TwoFactorService | null {
    this.resolveSecurityServices();
    return this.twoFactorServiceCache;
  }

  /** The fail2ban counter, or `null` when it cannot be reached. */
  private resolveLoginGuard(): LoginGuardServiceLike | null {
    this.resolveSecurityServices();
    return this.loginGuardServiceCache;
  }

  /**
   * Resolves both security handles once. The two lookups are independent: a
   * container that cannot supply the counter can still supply the verifier,
   * and losing one must not silently disarm the other.
   */
  private resolveSecurityServices(): void {
    if (this.twoFactorResolved) return;
    this.twoFactorResolved = true;
    if (!this.moduleRef) return;
    try {
      this.twoFactorServiceCache = this.moduleRef.get(TwoFactorService, { strict: false });
    } catch {
      this.twoFactorServiceCache = null;
    }
    try {
      // Dynamic require for the same reason `AdminAuthService` uses one: the
      // two-factor module imports `AuthModule`, so a static edge from here
      // risks closing the graph at load time.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { LoginGuardService } = require('../../two-factor/services/login-guard.service');
      this.loginGuardServiceCache = this.moduleRef.get(LoginGuardService, { strict: false });
    } catch {
      this.loginGuardServiceCache = null;
    }
  }

  /**
   * Processes a verified OAuth profile and returns a JWT if authorized.
   */
  public async processOAuthLogin(
    profile: OAuthUserProfile,
    options: OAuthLoginOptionsInterface = {},
  ): Promise<OAuthLoginResult> {
    // 1. Check if this provider identity is already linked to an admin
    const existingLink = await this.prismaService.adminOAuthLink.findUnique({
      where: {
        providerType_providerUserId: {
          providerType: profile.providerType,
          providerUserId: profile.providerId,
        },
      },
    });

    if (existingLink) {
      // Update last used timestamp
      await this.prismaService.adminOAuthLink.update({
        where: { id: existingLink.id },
        data: { lastUsedAt: new Date() },
      });
      return this.issueTokenForAdmin(
        existingLink.adminUserId,
        false,
        options.totpCode ?? null,
        options.requestMetadata ?? UNKNOWN_REQUEST_METADATA,
      );
    }

    // 2. No existing link — try to auto-link by email
    if (profile.email) {
      const admin = await this.prismaService.adminUser.findUnique({
        where: { email: profile.email },
        select: { id: true, isActive: true },
      });

      if (admin && admin.isActive) {
        // Validate whitelist — if whitelist is empty, auto-link is DENIED
        // (admins must manually link their accounts or populate the whitelist)
        const isWhitelisted = await this.isWhitelisted(profile);
        if (!isWhitelisted) {
          throw new UnauthorizedException(
            'Auto-linking is not allowed. Ask an administrator to link your account manually or add your email/ID to the provider whitelist.',
          );
        }

        // Create the link
        await this.prismaService.adminOAuthLink.create({
          data: {
            adminUserId: admin.id,
            providerType: profile.providerType,
            providerUserId: profile.providerId,
            providerEmail: profile.email,
            providerName: profile.name,
            profileData: JSON.parse(JSON.stringify(profile.rawProfile)),
          },
        });

        this.logger.log(
          `Auto-linked ${profile.providerType} user ${profile.providerId} to admin ${admin.id}`,
        );

        return this.issueTokenForAdmin(
          admin.id,
          true,
          options.totpCode ?? null,
          options.requestMetadata ?? UNKNOWN_REQUEST_METADATA,
        );
      }
    }

    // 3. For Telegram — validate whitelist
    if (profile.providerType === AuthProviderType.TELEGRAM) {
      const isWhitelisted = await this.isWhitelisted(profile);
      if (!isWhitelisted) {
        throw new UnauthorizedException(
          'Telegram ID is not in the allowed list. Ask an administrator to add your ID.',
        );
      }
    }

    throw new UnauthorizedException(
      'No admin account is linked to this identity. Ask an administrator to link your account.',
    );
  }

  /**
   * Links an OAuth identity to an existing admin (manual linking from settings).
   */
  public async linkProvider(
    adminUserId: string,
    profile: OAuthUserProfile,
  ): Promise<void> {
    await this.prismaService.adminOAuthLink.upsert({
      where: {
        providerType_providerUserId: {
          providerType: profile.providerType,
          providerUserId: profile.providerId,
        },
      },
      create: {
        adminUserId,
        providerType: profile.providerType,
        providerUserId: profile.providerId,
        providerEmail: profile.email,
        providerName: profile.name,
        profileData: JSON.parse(JSON.stringify(profile.rawProfile)),
      },
      update: {
        adminUserId,
        providerEmail: profile.email,
        providerName: profile.name,
        profileData: JSON.parse(JSON.stringify(profile.rawProfile)),
      },
    });
  }

  /**
   * Unlinks an OAuth identity from an admin.
   */
  public async unlinkProvider(
    adminUserId: string,
    providerType: AuthProviderType,
  ): Promise<void> {
    await this.prismaService.adminOAuthLink.deleteMany({
      where: { adminUserId, providerType },
    });
  }

  /**
   * Returns all linked providers for an admin.
   */
  public async getLinkedProviders(adminUserId: string) {
    return this.prismaService.adminOAuthLink.findMany({
      where: { adminUserId },
      select: {
        id: true,
        providerType: true,
        providerUserId: true,
        providerEmail: true,
        providerName: true,
        linkedAt: true,
        lastUsedAt: true,
      },
    });
  }

  private async issueTokenForAdmin(
    adminId: string,
    isNewLink: boolean,
    totpCode: string | null,
    requestMetadata: RequestMetadataInterface,
  ): Promise<OAuthLoginResult> {
    const admin = await this.prismaService.adminUser.findUnique({
      where: { id: adminId },
      select: {
        id: true,
        login: true,
        // The key `LoginGuardService` groups by. It must be the NORMALIZED
        // login and not `login`, or an OAuth failure and a password failure
        // for the same operator land in two different buckets and the shared
        // per-(login, ip) budget quietly stops being shared — which is the
        // entire point of wiring this path into that counter.
        loginNormalized: true,
        name: true,
        role: true,
        isActive: true,
        tokenVersion: true,
        rbacRoleId: true,
        totpEnabled: true,
      },
    });

    if (!admin || !admin.isActive) {
      throw new ForbiddenException('Admin account is inactive');
    }

    const loginGuard = this.resolveLoginGuard();
    const ipAddress = requestMetadata.remoteAddress ?? '';

    // The same pre-flight `AdminAuthService.loginAdmin()` runs, one step later
    // in the flow than it can run there. The password path knows the login from
    // the request body and checks before touching the password store; here the
    // login is only known after the provider identity has been resolved to an
    // admin, so the check lands after that lookup. What matters is preserved:
    // it runs BEFORE the guessable credential is consulted.
    //
    // Deliberately NOT counted or checked: the "no admin is linked to this
    // identity" refusals in `processOAuthLogin`. `AdminAuthService` counts its
    // `admin_not_found` because a login that does not exist is somebody probing
    // for one. There is no equivalent here — the profile reaching this service
    // was already authenticated BY the provider, so an unlinked arrival is a
    // real person who clicked the wrong button, and auto-blocking their address
    // for half an hour would be a control that only ever fires on the innocent.
    if (loginGuard && (await loginGuard.isRateLimited(ipAddress, admin.loginNormalized))) {
      this.logger.warn(
        `OAuth login refused for admin ${admin.id}: too many recent failures from ${ipAddress || 'unknown ip'}`,
      );
      throw new UnauthorizedException('Too many login attempts. Try again later.');
    }

    await this.assertSecondFactor(
      admin.id,
      admin.totpEnabled,
      totpCode,
      admin.loginNormalized,
      requestMetadata,
    );

    // Update last login
    await this.prismaService.adminUser.update({
      where: { id: adminId },
      data: { lastLoginAt: new Date() },
    });

    // Recorded for the same reason the password path records it: the attempts
    // table is what the login-attempts view reads, and an OAuth sign-in that
    // leaves no row there makes a real session indistinguishable from none at
    // all to whoever is reading that table during an incident. It does not
    // reset anything — no query in `LoginGuardService` reads a success row, as
    // its class header spells out.
    if (loginGuard) {
      await loginGuard.recordAttempt({
        loginNormalized: admin.loginNormalized,
        ipAddress,
        success: true,
        reason: null,
        userAgent: requestMetadata.userAgent,
      });
    }

    const payload = {
      sub: admin.id,
      login: admin.login,
      role: admin.role,
      tokenVersion: admin.tokenVersion,
      rbacRoleId: admin.rbacRoleId,
    };

    const accessToken = await this.jwtService.signAsync(payload);

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.authConfiguration.jwtExpiresIn,
      admin: {
        id: admin.id,
        login: admin.login,
        name: admin.name,
        role: admin.role,
      },
      isNewLink,
    };
  }

  /**
   * Enforces the second factor for an OAuth login.
   *
   * This gate did not exist, and its absence was the whole defect: a full 24h
   * admin JWT was signed after checking `isActive` and nothing else, so an
   * operator who switched 2FA on and believed every login now needed their
   * authenticator could still be signed in by whoever controlled their linked
   * Telegram or GitHub account — with neither password nor code. The panel's
   * own schema says the opposite: `AdminUser.totpEnabled` is documented as
   * "Operators with `totpEnabled = true` MUST present a valid 6-digit code on
   * every login" (`prisma/schema.prisma:502`).
   *
   * The refusal mirrors the password path byte for byte:
   * `AdminAuthService.loginAdmin()` throws `UnauthorizedException` whose
   * message is the bare string `totp_required`, and the controller turns that
   * into `401 { code: 'totp_required' }`. Both halves matter — the SPA
   * branches on that exact field (`web/src/features/auth/sign-in-page.tsx:158`)
   * and `AdminSafeExceptionFilter` only forwards a `code` that appears in
   * `SAFE_PRODUCT_CODES`, where `'totp_required'` is the single lower-case
   * entry. A new spelling would be stripped on the way out and the client
   * would see nothing.
   *
   * FAIL-CLOSED when `TwoFactorService` cannot be resolved. The password path
   * treats an unresolvable handle as "no 2FA configured" and lets the login
   * through, which is survivable there because the password was already
   * checked. Here the only other factor is the provider assertion, so a
   * missing verifier must refuse.
   *
   * Every refusal below now also SPENDS A BUDGET, which is the second half of
   * this method's job and was missing entirely. Before it, this file did not
   * mention `LoginGuardService` anywhere: a wrong code was rejected and then
   * forgotten, so the attempt cost the attacker nothing and left the operator's
   * account no closer to being defended. Measured on the Telegram route, 600
   * guesses a minute reached `verifyForLogin` and produced zero rows in
   * `admin_login_attempts`. The reason strings are `AdminAuthService`'s, spelled
   * identically on purpose — `totp_required` and `totp_invalid` — because the
   * two paths write into one table that gets read by one query.
   */
  private async assertSecondFactor(
    adminId: string,
    totpEnabled: boolean,
    totpCode: string | null,
    loginNormalized: string,
    requestMetadata: RequestMetadataInterface,
  ): Promise<void> {
    if (!totpEnabled) return;

    const code = (totpCode ?? '').trim();
    if (code.length === 0) {
      await this.recordFailedSecondFactor(loginNormalized, 'totp_required', requestMetadata);
      throw new UnauthorizedException('totp_required');
    }

    const twoFactor = this.resolveTwoFactorService();
    if (!twoFactor) {
      this.logger.error(
        `OAuth login refused for admin ${adminId}: 2FA is enabled but TwoFactorService ` +
          'could not be resolved — refusing rather than issuing a token on one factor',
      );
      // NOT counted. Nobody guessed anything: this branch fires for every
      // caller alike while the container is mis-wired, so counting it would
      // auto-block the address of every operator who tried to sign in during
      // an outage. A failure the attacker did not cause must not spend the
      // attacker's budget — or the victim's.
      throw new UnauthorizedException('Invalid verification code');
    }

    if (!(await twoFactor.verifyForLogin(adminId, code))) {
      this.logger.warn(`OAuth login refused for admin ${adminId}: invalid second factor`);
      await this.recordFailedSecondFactor(loginNormalized, 'totp_invalid', requestMetadata);
      throw new UnauthorizedException('Invalid verification code');
    }
  }

  /**
   * One rejected second factor, charged to the (login, ip) budget.
   *
   * Never allowed to fail the refusal it describes. `recordAttempt` writes a
   * row and may auto-insert a block, so a database hiccup inside it would
   * otherwise turn a correctly-rejected code into a 500 — which reads to the
   * caller as a server fault rather than a wrong code, and to an attacker as a
   * way to make the counter stop counting.
   */
  private async recordFailedSecondFactor(
    loginNormalized: string,
    reason: string,
    requestMetadata: RequestMetadataInterface,
  ): Promise<void> {
    const loginGuard = this.resolveLoginGuard();
    if (!loginGuard) return;
    try {
      await loginGuard.recordAttempt({
        loginNormalized,
        ipAddress: requestMetadata.remoteAddress ?? '',
        success: false,
        reason,
        userAgent: requestMetadata.userAgent,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to record an OAuth second-factor failure for ${loginNormalized}: ${(err as Error).message}`,
      );
    }
  }

  private async isWhitelisted(profile: OAuthUserProfile): Promise<boolean> {
    const config = await this.prismaService.authProviderConfig.findUnique({
      where: { type: profile.providerType },
      select: { allowedEmails: true, allowedTelegramIds: true },
    });

    if (!config) return false;

    // For Telegram: check Telegram ID whitelist
    if (profile.providerType === AuthProviderType.TELEGRAM) {
      if (config.allowedTelegramIds.length === 0) return false; // Empty = deny
      const tgId = BigInt(profile.providerId);
      return config.allowedTelegramIds.some((id) => id === tgId);
    }

    // For other providers: check email whitelist
    if (config.allowedEmails.length === 0) return false; // Empty = deny auto-link
    if (!profile.email) return false;
    const emailLower = profile.email.toLowerCase();
    return config.allowedEmails.some((e) => e.toLowerCase() === emailLower);
  }
}
