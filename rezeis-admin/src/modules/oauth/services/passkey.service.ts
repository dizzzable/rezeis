import { Inject, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

import { authConfig } from '../../../common/config/auth.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { RawCacheService } from '../../../common/cache/raw-cache.service';
import type { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import {
  PasskeyCredentialInfo,
  PasskeyReauthFactor,
  PasskeyReauthInput,
  PasskeyRemovalResult,
} from '../interfaces/passkey.interface';

type TwoFactorServiceLike = import('../../two-factor/services/two-factor.service').TwoFactorService;
type LoginGuardServiceLike = import('../../two-factor/services/login-guard.service').LoginGuardService;
type PasswordHashServiceLike = import('../../auth/services/password-hash.service').PasswordHashService;

/** What `generateRegistrationOptions` parks in Redis for its own verify half. */
interface StoredRegistrationChallenge {
  readonly challenge: string;
  /**
   * When the fresh factor was accepted, epoch ms. Its PRESENCE is the contract,
   * not its value: a challenge record without it was minted by something that
   * did not run `assertFreshFactor`, and `verifyRegistration` refuses it. The
   * window itself is Redis's — the key carries `CHALLENGE_TTL_SECONDS`.
   */
  readonly reauthAt: number;
}

/** What `generateAuthenticationOptions` parks in Redis, keyed by challenge. */
interface StoredAuthenticationChallenge {
  readonly challenge: string;
  readonly adminId: string | null;
}

const EMPTY_REQUEST_METADATA: RequestMetadataInterface = {
  requestId: null,
  remoteAddress: null,
  userAgent: null,
};

/**
 * WebAuthn/Passkey service using @simplewebauthn/server.
 *
 * Supports:
 *   - Registration: prove a fresh factor -> generate options -> verify response
 *     -> store credential
 *   - Authentication: generate options -> verify response -> issue JWT
 *   - Management: list, rename, delete credentials
 *
 * Challenges are stored in Redis with a 5-minute TTL to prevent replay.
 * The RP ID is derived from the frontend domain configuration.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DECISION, 2026-08-19 — passkey LOGIN does not additionally demand a TOTP code
 * when the admin has 2FA enabled, and that is a choice rather than an omission.
 *
 * The reasoning, so the next reader can re-open it on evidence rather than on
 * unease. A WebAuthn assertion verified with user verification is already two
 * factors: possession of the authenticator, plus the PIN or biometric that
 * unlocked it. `verifyAuthenticationResponse` enforces that — its
 * `requireUserVerification` option defaults to `true`
 * (`@simplewebauthn/server/esm/authentication/verifyAuthenticationResponse.js:24,137`)
 * and this file never passes it, so an assertion whose `uv` flag is clear is
 * rejected outright. Stacking TOTP on top would therefore be a third factor on
 * a login that already has two, while the password path — one factor plus TOTP
 * — has two. Demanding it here would make the STRONGER credential the more
 * annoying one, which is how operators get talked into turning 2FA off.
 *
 * What this rests on, and what would overturn it:
 *   - It rests on `requireUserVerification` staying at its default. Passing
 *     `requireUserVerification: false` to make some authenticator work would
 *     silently reduce passkey login to a single factor, and this decision with
 *     it. `test/passkey-login-second-factor.spec.ts` pins the default so that
 *     change cannot be made quietly.
 *   - Note the asymmetry with `userVerification: 'preferred'` in the options
 *     below: that is a HINT to the browser, and the verifier is what binds. A
 *     'preferred' hint under an enforcing verifier is safe — a non-UV
 *     authenticator fails at verification rather than logging in weakly.
 *   - It does NOT extend to registration. Enrolling a new authenticator is not
 *     a login: the assertion that would be the second factor does not exist
 *     yet, and the only thing the request carries is the bearer token. Hence
 *     `assertFreshFactor` below.
 * ─────────────────────────────────────────────────────────────────────────────
 */
@Injectable()
export class PasskeyService {
  private readonly logger = new Logger(PasskeyService.name);
  private static readonly CHALLENGE_TTL_SECONDS = 300;
  private static readonly RP_NAME = 'Rezeis Admin';

  /**
   * Lazily-resolved 2FA / login-guard / password handles.
   *
   * Deliberately kept out of the constructor signature and out of
   * `OAuthModule`'s imports, exactly as `AdminAuthService` does it
   * (`admin-auth.service.ts:132-181`) and for the same reason: `TwoFactorModule`
   * imports `AuthModule`, so wiring those providers in statically would close
   * the graph. `ModuleRef.get(..., { strict: false })` looks them up in the
   * whole container at call time instead.
   *
   * Every consumer below treats "not resolved" as a FAILED check, never as a
   * skipped one. A missing verifier must not become a way to enrol a passkey.
   */
  private twoFactorServiceCache: TwoFactorServiceLike | null = null;
  private loginGuardServiceCache: LoginGuardServiceLike | null = null;
  private passwordHashServiceCache: PasswordHashServiceLike | null = null;
  private securityServicesResolved = false;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly cacheService: RawCacheService,
    private readonly jwtService: JwtService,
    @Inject(authConfig.KEY)
    private readonly authConfiguration: ConfigType<typeof authConfig>,
    @Optional()
    private readonly moduleRef?: ModuleRef,
  ) {}

  /**
   * Lazily-resolved realtime gateway.
   *
   * Kept OUT of the constructor and out of this module's imports on purpose:
   * `RealtimeModule` imports `AuthModule`, so naming the gateway as a
   * dependency here would close the graph. `ModuleRef.get(..., { strict:
   * false })` is the escape hatch `SystemEventsService` already uses to reach
   * the same gateway (its private `resolveRealtimeGateway()`), and it degrades
   * the way this call has to degrade: in a runtime with no gateway (the worker)
   * the lookup returns `null` and revocation is simply skipped, rather than an
   * absent realtime feature breaking authentication.
   */
  private realtimeGatewayCache: import('../../realtime/realtime.gateway').RealtimeGateway | null = null;
  private realtimeGatewayResolved = false;

  /**
   * Drops every open admin socket bound to `adminId`.
   *
   * `tokenVersion` is checked on the HTTP side by `AdminJwtStrategy.validate`
   * on every request, but on the realtime side ONLY in
   * `RealtimeGateway.handleConnection` — at handshake time. `broadcast()`
   * re-checks RBAC and nothing else (`realtime.gateway.ts`), so a socket that
   * was authenticated before the bump keeps receiving admin events for as long
   * as it stays open. For a credential the operator believes is
   * compromised, that is the same "revocation that does not revoke" this
   * method's docblock was written to close, one surface further out.
   *
   * `disconnectAdmin()` was written for exactly this and had no callers at
   * all; this is one of them. Deliberately best-effort and never rethrown —
   * a realtime failure must not turn a completed credential change into an
   * error response, because the durable half (the `tokenVersion` bump) has
   * already committed by the time we get here.
   */
  private revokeRealtimeSessions(adminId: string, reason: string): void {
    const gateway = this.resolveRealtimeGateway();
    if (!gateway) return;
    try {
      const dropped = gateway.disconnectAdmin(adminId, reason);
      if (dropped > 0) {
        this.logger.log(
          `Realtime sessions revoked for admin ${adminId}: ${dropped} socket(s) (${reason})`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Realtime session revocation failed for admin ${adminId}: ${(err as Error).message}`,
      );
    }
  }

  private resolveRealtimeGateway(): import('../../realtime/realtime.gateway').RealtimeGateway | null {
    if (this.realtimeGatewayResolved) return this.realtimeGatewayCache;
    this.realtimeGatewayResolved = true;
    if (!this.moduleRef) return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { RealtimeGateway } = require('../../realtime/realtime.gateway');
      this.realtimeGatewayCache = this.moduleRef.get(RealtimeGateway, { strict: false });
    } catch {
      this.realtimeGatewayCache = null;
    }
    if (!this.realtimeGatewayCache) {
      this.logger.warn(
        'RealtimeGateway not available — realtime sessions will not be revoked',
      );
    }
    return this.realtimeGatewayCache;
  }

  // ── Registration ─────────────────────────────────────────────────────────

  /**
   * Generates WebAuthn registration options for an admin — after the admin has
   * proved a factor the request's bearer token does not already carry.
   *
   * The gate is HERE rather than on `register/verify` because the challenge is
   * what binds the two halves: `verifyRegistration` only accepts a response
   * against a challenge this method parked in Redis, so a caller that cannot
   * get past this check cannot enrol at all. Prompting first is also the honest
   * order for the operator — the code is asked for before the authenticator
   * lights up, not after.
   */
  public async generateRegistrationOptions(
    adminId: string,
    rpId: string,
    reauth: PasskeyReauthInput = {},
    metadata: RequestMetadataInterface = EMPTY_REQUEST_METADATA,
  ): Promise<Record<string, unknown>> {
    const admin = await this.prismaService.adminUser.findUnique({
      where: { id: adminId },
      select: {
        id: true,
        login: true,
        // `loginNormalized`, not `login`: it is the key
        // `admin_login_attempts` is written and counted under everywhere else
        // (`AdminAuthService.loginAdmin`), and a differently-cased spelling
        // here would open a second budget beside the operator's real one.
        loginNormalized: true,
        name: true,
        totpEnabled: true,
        passwordHash: true,
      },
    });
    if (!admin) throw new UnauthorizedException('Admin not found');

    await this.assertFreshFactor(admin, reauth, metadata);

    // Get existing credentials to exclude
    const existingCredentials = await this.prismaService.adminPasskey.findMany({
      where: { adminUserId: adminId },
      select: { credentialId: true, transports: true },
    });

    const options = await generateRegistrationOptions({
      rpName: PasskeyService.RP_NAME,
      rpID: rpId,
      userName: admin.login,
      userDisplayName: admin.name ?? admin.login,
      attestationType: 'none',
      excludeCredentials: existingCredentials.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransport[],
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    // Store challenge in Redis for verification, carrying the proof that the
    // fresh factor was accepted for THIS challenge.
    const record: StoredRegistrationChallenge = {
      challenge: options.challenge,
      reauthAt: Date.now(),
    };
    await this.cacheService.set(
      `passkey:reg:${adminId}`,
      record,
      PasskeyService.CHALLENGE_TTL_SECONDS,
    );

    return options as unknown as Record<string, unknown>;
  }

  /**
   * Verifies a registration response and stores the new credential.
   */
  public async verifyRegistration(
    adminId: string,
    rpId: string,
    origin: string,
    response: RegistrationResponseJSON,
    credentialName: string,
    metadata: RequestMetadataInterface = EMPTY_REQUEST_METADATA,
  ): Promise<PasskeyCredentialInfo> {
    // Single use, on EVERY outcome. This used to be deleted only after a
    // successful `create()` further down, so a challenge that failed
    // verification stayed live for the rest of its 300 s TTL and could be
    // retried at leisure. The authentication path has always consumed on
    // lookup (`findChallengeForResponse`); this is the same rule.
    const stored = await this.cacheService.get<StoredRegistrationChallenge | string>(
      `passkey:reg:${adminId}`,
    );
    await this.cacheService.del(`passkey:reg:${adminId}`);

    const expectedChallenge = typeof stored === 'string' ? stored : stored?.challenge;
    if (!expectedChallenge) {
      throw new UnauthorizedException('Registration challenge expired');
    }
    // A record with no `reauthAt` was not minted by `generateRegistrationOptions`
    // in its gated form — either it predates the gate (an enrolment in flight
    // across a deploy) or some future path skipped it. Both refuse here: the
    // freshness proof has to survive the round trip, not merely be asked for
    // once and forgotten.
    if (typeof stored === 'string' || typeof stored?.reauthAt !== 'number') {
      this.logger.warn(
        `Passkey registration refused for admin ${adminId}: challenge carries no re-authentication proof`,
      );
      throw new UnauthorizedException('Registration challenge expired');
    }

    // Same throwing behaviour as the authentication path — see the note there.
    // Registration is the supervised half (the admin already holds a session),
    // so the failure is recoverable, but it used to be a 500 as well.
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Passkey registration rejected for admin ${adminId} (rpId=${rpId}, origin=${origin}): ${reason}`,
      );
      await this.recordAudit({
        adminUserId: adminId,
        action: 'admin.passkey.registration_rejected',
        metadata,
        extra: { reason: 'verification_failed' },
      });
      throw new UnauthorizedException('Passkey registration verification failed');
    }

    if (!verification.verified || !verification.registrationInfo) {
      this.logger.warn(
        `Passkey registration unverified for admin ${adminId} (rpId=${rpId}, origin=${origin})`,
      );
      await this.recordAudit({
        adminUserId: adminId,
        action: 'admin.passkey.registration_rejected',
        metadata,
        extra: { reason: 'unverified' },
      });
      throw new UnauthorizedException('Passkey registration verification failed');
    }

    const { credential, credentialBackedUp, aaguid } = verification.registrationInfo;

    // Store the credential. `aaguid` names the authenticator make and model and
    // is the only thing that lets an operator reviewing the list tell "my
    // phone" from "a key someone plugged in". The column has existed since the
    // table was created and was NULL on every row that has ever existed — the
    // library returns the value and nothing read it.
    const passkey = await this.prismaService.adminPasskey.create({
      data: {
        adminUserId: adminId,
        name: credentialName || 'Passkey',
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: BigInt(credential.counter),
        transports: response.response.transports ?? [],
        backedUp: credentialBackedUp,
        aaguid: aaguid || null,
      },
    });

    this.logger.log(`Passkey registered for admin ${adminId}: ${passkey.id}`);
    await this.recordAudit({
      adminUserId: adminId,
      action: 'admin.passkey.registered',
      metadata,
      extra: { passkeyId: passkey.id, passkeyName: passkey.name, aaguid: aaguid || null },
    });

    // Deliberately NOT bumping `tokenVersion` here, and the asymmetry with
    // `deletePasskey` is the point. A bump revokes authority already handed
    // out; enrolling GRANTS authority to a credential that did not exist a
    // moment ago and changes nothing about what an outstanding session can do.
    // The one case where a bump would help — an attacker with a stolen token
    // enrolling their own authenticator — is closed upstream by
    // `assertFreshFactor`, which is the right place for it: refuse the
    // enrolment, rather than sign every legitimate admin out for performing one.
    return {
      id: passkey.id,
      name: passkey.name,
      credentialId: passkey.credentialId,
      transports: passkey.transports,
      backedUp: passkey.backedUp,
      registeredAt: passkey.registeredAt.toISOString(),
      lastUsedAt: null,
    };
  }

  // ── Authentication ───────────────────────────────────────────────────────

  /**
   * Generates WebAuthn authentication options.
   * If adminId is provided, limits to that admin's credentials.
   * If null, allows any registered credential (discoverable/resident key).
   */
  public async generateAuthenticationOptions(
    rpId: string,
    adminId?: string | null,
  ): Promise<Record<string, unknown>> {
    let allowCredentials: { id: string; transports?: AuthenticatorTransport[] }[] = [];

    if (adminId) {
      const credentials = await this.prismaService.adminPasskey.findMany({
        where: { adminUserId: adminId },
        select: { credentialId: true, transports: true },
      });
      allowCredentials = credentials.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransport[],
      }));
    }

    const options = await generateAuthenticationOptions({
      rpID: rpId,
      userVerification: 'preferred',
      allowCredentials: allowCredentials.length > 0 ? allowCredentials : undefined,
    });

    // Store challenge — use a random key since we don't know the admin yet
    const challengeKey = `passkey:auth:${options.challenge}`;
    const record: StoredAuthenticationChallenge = {
      challenge: options.challenge,
      adminId: adminId ?? null,
    };
    await this.cacheService.set(challengeKey, record, PasskeyService.CHALLENGE_TTL_SECONDS);

    return options as unknown as Record<string, unknown>;
  }

  /**
   * Verifies an authentication response and issues a JWT.
   */
  public async verifyAuthentication(
    rpId: string,
    origin: string,
    response: AuthenticationResponseJSON,
    metadata: RequestMetadataInterface = EMPTY_REQUEST_METADATA,
  ): Promise<{ accessToken: string; tokenType: 'Bearer'; expiresIn: string }> {
    const ipAddress = metadata.remoteAddress ?? '';
    const loginGuard = this.resolveSecurityServices().loginGuard;

    // The same fail2ban counter the password login sits behind. The login is
    // not known at this point — usernameless is the whole shape of passkey
    // sign-in — so only the per-IP half of the check can run, which is exactly
    // the half that matters for an unauthenticated flood.
    if (loginGuard && (await loginGuard.isRateLimited(ipAddress, ''))) {
      await this.recordAudit({
        adminUserId: null,
        action: 'admin.login.failed',
        metadata,
        extra: { method: 'passkey', reason: 'rate_limited' },
      });
      throw new UnauthorizedException('Too many login attempts. Try again later.');
    }

    // Find the credential
    const credentialId = response.id;
    const passkey = await this.prismaService.adminPasskey.findUnique({
      where: { credentialId },
    });

    if (!passkey) {
      await this.recordFailedLogin(null, '', 'credential_not_found', metadata);
      throw new UnauthorizedException('Passkey not found');
    }

    // Decode clientDataJSON to extract the challenge for verification
    const storedChallenge = await this.findChallengeForResponse(response);
    if (!storedChallenge) {
      await this.recordFailedLogin(passkey.adminUserId, '', 'challenge_expired', metadata);
      throw new UnauthorizedException('Authentication challenge expired or invalid');
    }

    // The challenge may have been issued FOR a specific admin — that is what
    // the `adminId` argument of `generateAuthenticationOptions` means. Today no
    // caller passes it and every challenge is unbound, so this branch is inert;
    // it is wired anyway because the alternative is a stored field that reads
    // like a binding and is not. The moment a username-first login is added,
    // whoever adds it will reasonably believe the challenge is bound to the
    // account they asked for — and without this it would not be, because the
    // credential-id lookup above would happily resolve somebody else's key.
    if (storedChallenge.adminId !== null && storedChallenge.adminId !== passkey.adminUserId) {
      this.logger.warn(
        `Passkey authentication rejected for credential ${credentialId}: ` +
          'challenge was issued for a different admin',
      );
      await this.recordFailedLogin(
        passkey.adminUserId,
        '',
        'challenge_admin_mismatch',
        metadata,
      );
      throw new UnauthorizedException('Passkey authentication failed');
    }

    // `verifyAuthenticationResponse` THROWS on an rpId/origin mismatch rather
    // than returning `verified: false` — so without this catch the commonest
    // real failure (a passkey registered while reaching the panel by a
    // different hostname than the one being used now) surfaced as a 500 with
    // nothing in the log. The two values it compared are precisely the ones an
    // operator cannot see from the browser, so they are recorded here; the
    // response stays generic on purpose, since this route is public and must
    // not narrate why a login attempt failed.
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: storedChallenge.challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        credential: {
          id: passkey.credentialId,
          publicKey: Buffer.from(passkey.publicKey, 'base64url'),
          counter: Number(passkey.counter),
          transports: passkey.transports as AuthenticatorTransport[],
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Passkey authentication rejected for credential ${credentialId} ` +
          `(rpId=${rpId}, origin=${origin}): ${reason}`,
      );
      await this.recordFailedLogin(passkey.adminUserId, '', 'assertion_rejected', metadata);
      throw new UnauthorizedException('Passkey authentication failed');
    }

    if (!verification.verified) {
      this.logger.warn(
        `Passkey authentication unverified for credential ${credentialId} ` +
          `(rpId=${rpId}, origin=${origin})`,
      );
      await this.recordFailedLogin(passkey.adminUserId, '', 'assertion_unverified', metadata);
      throw new UnauthorizedException('Passkey authentication failed');
    }

    // Update counter and last used
    await this.prismaService.adminPasskey.update({
      where: { id: passkey.id },
      data: {
        counter: BigInt(verification.authenticationInfo.newCounter),
        lastUsedAt: new Date(),
      },
    });

    // Issue JWT
    const admin = await this.prismaService.adminUser.findUnique({
      where: { id: passkey.adminUserId },
      select: {
        id: true,
        login: true,
        loginNormalized: true,
        role: true,
        tokenVersion: true,
        isActive: true,
        rbacRoleId: true,
      },
    });

    if (!admin || !admin.isActive) {
      await this.recordFailedLogin(
        admin?.id ?? passkey.adminUserId,
        admin?.loginNormalized ?? '',
        'admin_inactive',
        metadata,
      );
      throw new UnauthorizedException('Admin account is inactive');
    }

    // `lastLoginIp` alongside `lastLoginAt`: the password login writes both
    // (`admin-auth.service.ts` `loginAdmin`), and an operator reading "last
    // seen from" on their own account should not be told the IP of the last
    // time they happened to use a password.
    await this.prismaService.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date(), lastLoginIp: metadata.remoteAddress },
    });

    // The same two actions the password login writes, so the audit view and
    // every query built on it show a passkey sign-in beside a password one
    // instead of showing nothing at all. `method` is what tells them apart.
    await this.recordAudit({
      adminUserId: admin.id,
      action: 'admin.login.succeeded',
      metadata,
      login: admin.loginNormalized,
      extra: { method: 'passkey', passkeyId: passkey.id },
    });
    if (loginGuard) {
      await loginGuard.recordAttempt({
        loginNormalized: admin.loginNormalized,
        ipAddress,
        success: true,
        reason: null,
        userAgent: metadata.userAgent,
      });
    }

    const accessToken = await this.jwtService.signAsync({
      sub: admin.id,
      login: admin.login,
      role: admin.role,
      tokenVersion: admin.tokenVersion,
      rbacRoleId: admin.rbacRoleId,
    });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.authConfiguration.jwtExpiresIn,
    };
  }

  // ── Management ───────────────────────────────────────────────────────────

  /**
   * Lists all passkeys for an admin.
   */
  public async listPasskeys(adminId: string): Promise<PasskeyCredentialInfo[]> {
    const passkeys = await this.prismaService.adminPasskey.findMany({
      where: { adminUserId: adminId },
      orderBy: { registeredAt: 'desc' },
    });
    return passkeys.map((p) => ({
      id: p.id,
      name: p.name,
      credentialId: p.credentialId,
      transports: p.transports,
      backedUp: p.backedUp,
      registeredAt: p.registeredAt.toISOString(),
      lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
    }));
  }

  /**
   * Renames a passkey.
   */
  public async renamePasskey(adminId: string, passkeyId: string, name: string): Promise<void> {
    await this.prismaService.adminPasskey.updateMany({
      where: { id: passkeyId, adminUserId: adminId },
      data: { name },
    });
  }

  /**
   * Deletes a passkey — and ends the sessions it created.
   *
   * Removing the row alone left a hole shaped exactly like the feature: an
   * admin who revokes a passkey because they believe it is compromised is told
   * the credential is gone, while every JWT that credential already minted
   * stays valid for the rest of its 24 h life and nothing in the panel can
   * shorten it. Revocation that does not revoke.
   *
   * `tokenVersion` is the lever — `AdminJwtStrategy.validate` compares it on
   * every request (`admin-jwt.strategy.ts:64`) — and it is per-ADMIN, not
   * per-credential, so bumping it invalidates the caller's own session too.
   * That is why a fresh token comes back: the operator stays signed in on the
   * tab they revoked from, and every other session — including the attacker's —
   * dies at its next request.
   */
  public async deletePasskey(
    adminId: string,
    passkeyId: string,
    metadata: RequestMetadataInterface = EMPTY_REQUEST_METADATA,
  ): Promise<PasskeyRemovalResult> {
    const deleted = await this.prismaService.adminPasskey.deleteMany({
      where: { id: passkeyId, adminUserId: adminId },
    });
    // Nothing matched — someone else's id, or already gone. No credential was
    // revoked, so revoking sessions here would let a stranger's id log an admin
    // out of their own panel.
    if (deleted.count === 0) {
      return { removed: false, accessToken: null };
    }

    const admin = await this.prismaService.adminUser.update({
      where: { id: adminId },
      data: { tokenVersion: { increment: 1 } },
      select: { id: true, login: true, role: true, tokenVersion: true, rbacRoleId: true },
    });

    // HTTP sessions die at their next request via `AdminJwtStrategy`. The
    // realtime stream does not: the gateway compares `tokenVersion` only at
    // handshake, so the socket the revoked credential opened stays live.
    this.revokeRealtimeSessions(adminId, 'passkey_removed');

    this.logger.warn(`Passkey ${passkeyId} removed for admin ${adminId}; sessions revoked`);
    await this.recordAudit({
      adminUserId: adminId,
      action: 'admin.passkey.removed',
      metadata,
      extra: { passkeyId, tokenVersion: admin.tokenVersion },
    });

    const accessToken = await this.jwtService.signAsync({
      sub: admin.id,
      login: admin.login,
      role: admin.role,
      tokenVersion: admin.tokenVersion,
      rbacRoleId: admin.rbacRoleId,
    });
    return { removed: true, accessToken };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Demands a factor the request's bearer token does not already carry.
   *
   * The hole this closes: `PasskeyProtectedController` is guarded by
   * `AdminJwtAuthGuard` and nothing else, so a stolen JWT was enough to enrol
   * an authenticator — and a passkey login then mints fresh 24 h sessions
   * forever after, WITHOUT the password and WITHOUT the TOTP code. Changing the
   * password does not close it: `tokenVersion` rises, the stolen token dies,
   * and the attacker's next passkey login carries the new `tokenVersion`.
   *
   * The contract is copied from the two comparable operations rather than
   * invented, because both already refuse a bare session:
   *   - changing the password requires the CURRENT password
   *     (`admin-auth.service.ts` `changePassword`);
   *   - disabling 2FA requires a live TOTP or recovery code
   *     (`two-factor.service.ts` `disable`).
   * So: a TOTP or recovery code when the admin has 2FA on — the strongest
   * factor the account holds, and the one `disable` already asks for — and the
   * current password when they do not, since it is then the only factor left
   * that a hijacked session does not hold.
   *
   * Which one is required is chosen from the ACCOUNT, never from the caller. A
   * request allowed to nominate its own factor would nominate the one it has.
   *
   * EVERY VERDICT IS CHARGED TO THE LOGIN GUARD. This is a credential-checking
   * route, and until now it was the only one in this file that spent nothing:
   * the sign-in path calls `recordFailedLogin` at six places, while a failed
   * enrolment factor wrote an audit row and left `admin_login_attempts`
   * untouched. A stolen bearer token could therefore guess the TOTP code or the
   * password here forever and the fail2ban counter never saw a single attempt.
   *
   * Keyed on the REAL login, unlike the sign-in path, which passes `''`. That
   * empty login is a limitation there, not a preference — passkey sign-in is
   * usernameless, so the account is unknown until the credential resolves. Here
   * the caller is authenticated and the account is known, and:
   *   - `admin_login_attempts` is the forensic record of WHICH account was
   *     being guessed at; `evaluateAndBlock` even formats
   *     `login=${loginNormalized || 'unknown'}` into the block reason.
   *   - it spends the tighter of the two budgets — `MAX_FAILURES_PER_LOGIN` (5)
   *     rather than only `MAX_FAILURES_PER_WINDOW` (10) — which is the side to
   *     err on for a route that checks a credential.
   *   - an attacker cannot weaponise it against the operator: the tight budget
   *     is per-(login, IP), so guesses from the attacker's address cannot
   *     consume the operator's own.
   * The cost, stated plainly because it is the documented complaint at
   * `login-guard.service.ts:34-43`: five fumbled enrolment codes from the
   * operator's OWN address now 429 their own password sign-in for the rest of
   * the 15-minute window. The auto-block threshold is unaffected either way —
   * `evaluateAndBlock` counts per-IP only and ignores the login entirely.
   *
   * What is deliberately NOT here: an `isRateLimited` pre-check like the one
   * `verifyAuthentication` opens with. Refusing this route outright after N
   * failures is an account lockout policy, and a lockout needs an answer to
   * "how does the operator get back in" that is the owner's to give. The
   * attempt is recorded so the EXISTING policy (per-IP auto-block) applies; no
   * new refusal is invented here.
   */
  private async assertFreshFactor(
    admin: {
      readonly id: string;
      readonly loginNormalized: string;
      readonly totpEnabled: boolean;
      readonly passwordHash: string;
    },
    reauth: PasskeyReauthInput,
    metadata: RequestMetadataInterface,
  ): Promise<void> {
    const factor: PasskeyReauthFactor = admin.totpEnabled ? 'totp' : 'password';
    const supplied = (factor === 'totp' ? reauth.code : reauth.password) ?? '';

    if (supplied.trim().length === 0) {
      // Not a mistake the operator made — it is the prompt. The `factor` field
      // tells the SPA which of the two to render. Nothing is charged here: this
      // is the SPA's expected first round-trip, and billing it would spend the
      // operator's budget for opening the dialog.
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'passkey_reauth_required',
        factor,
        message: 'Confirm it is you before adding a passkey',
      });
    }

    const accepted =
      factor === 'totp'
        ? await this.verifyTotpFactor(admin.id, supplied)
        : await this.verifyPasswordFactor(supplied, admin.passwordHash);

    if (!accepted) {
      this.logger.warn(
        `Passkey enrolment refused for admin ${admin.id}: ${factor} re-authentication failed`,
      );
      await this.recordAudit({
        adminUserId: admin.id,
        action: 'admin.passkey.registration_rejected',
        metadata,
        extra: { reason: `invalid_${factor}` },
      });
      await this.recordEnrolmentFactor(
        admin.loginNormalized,
        metadata,
        false,
        `passkey_enrolment_invalid_${factor}`,
      );
      throw new UnauthorizedException(
        factor === 'totp' ? 'Invalid verification code' : 'Re-authentication failed',
      );
    }

    // The success row too, for the same reason `verifyAuthentication` writes one
    // (`:594`): a burst of failures with no resolution beside it is a misleading
    // trail. It costs nothing today — `recordAttempt` returns immediately on
    // success and no query in `LoginGuardService` reads a `success: true` row —
    // and it is the row a future "failures since the last success" lookup, which
    // that file's header explicitly contemplates, would need in order to treat a
    // proven factor here the way it treats a proven factor at sign-in.
    await this.recordEnrolmentFactor(admin.loginNormalized, metadata, true, 'passkey_enrolment');
  }

  /** TOTP or recovery code, verified by the service that owns them. */
  private async verifyTotpFactor(adminId: string, code: string): Promise<boolean> {
    const twoFactor = this.resolveSecurityServices().twoFactor;
    if (!twoFactor) {
      // Fail CLOSED. An unresolvable verifier is not a reason to let the
      // enrolment through — that would make a wiring mistake indistinguishable
      // from a valid code.
      this.logger.error(
        'TwoFactorService could not be resolved — refusing passkey enrolment rather than skipping the check',
      );
      return false;
    }
    return twoFactor.verifyForLogin(adminId, code);
  }

  /** The account's current password, verified by the service that owns hashing. */
  private async verifyPasswordFactor(supplied: string, passwordHash: string): Promise<boolean> {
    const passwordHashService = this.resolveSecurityServices().passwordHash;
    if (!passwordHashService) {
      this.logger.error(
        'PasswordHashService could not be resolved — refusing passkey enrolment rather than skipping the check',
      );
      return false;
    }
    return passwordHashService.verifyPassword({
      plainTextPassword: supplied,
      passwordHash,
    });
  }

  private resolveSecurityServices(): {
    readonly twoFactor: TwoFactorServiceLike | null;
    readonly loginGuard: LoginGuardServiceLike | null;
    readonly passwordHash: PasswordHashServiceLike | null;
  } {
    if (!this.securityServicesResolved) {
      this.securityServicesResolved = true;
      if (this.moduleRef) {
        try {
          // Dynamic require for the same reason `AdminAuthService` uses one: a
          // static import of these providers would create the very import cycle
          // the lazy lookup exists to avoid.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { TwoFactorService } = require('../../two-factor/services/two-factor.service');
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { LoginGuardService } = require('../../two-factor/services/login-guard.service');
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { PasswordHashService } = require('../../auth/services/password-hash.service');
          this.twoFactorServiceCache = this.moduleRef.get(TwoFactorService, { strict: false });
          this.loginGuardServiceCache = this.moduleRef.get(LoginGuardService, { strict: false });
          this.passwordHashServiceCache = this.moduleRef.get(PasswordHashService, {
            strict: false,
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.logger.error(`Passkey security services unavailable: ${reason}`);
          this.twoFactorServiceCache = null;
          this.loginGuardServiceCache = null;
          this.passwordHashServiceCache = null;
        }
      }
    }
    return {
      twoFactor: this.twoFactorServiceCache,
      loginGuard: this.loginGuardServiceCache,
      passwordHash: this.passwordHashServiceCache,
    };
  }

  /**
   * Charges one enrolment re-authentication verdict to the fail2ban counter.
   *
   * `LoginGuardService.recordAttempt` is the same single mechanism the sign-in
   * path spends through — `recordFailedLogin` below is just its two-in-one
   * wrapper, and reusing that wrapper here would write a second audit row
   * claiming `admin.login.failed` about a request that was not a login and has
   * already logged `admin.passkey.registration_rejected`. So the counter call is
   * made directly, exactly as the successful sign-in makes it at `:594`.
   *
   * `reason` carries the `passkey_enrolment` prefix because
   * `admin_login_attempts` has no `method` column: the prefix is the only thing
   * that tells an enrolment row apart from a sign-in row when the table is read
   * back.
   */
  private async recordEnrolmentFactor(
    loginNormalized: string,
    metadata: RequestMetadataInterface,
    success: boolean,
    reason: string,
  ): Promise<void> {
    const loginGuard = this.resolveSecurityServices().loginGuard;
    if (!loginGuard) return;
    await loginGuard.recordAttempt({
      loginNormalized,
      ipAddress: metadata.remoteAddress ?? '',
      success,
      reason,
      userAgent: metadata.userAgent,
    });
  }

  /** Audit row + fail2ban counter for one rejected passkey sign-in. */
  private async recordFailedLogin(
    adminUserId: string | null,
    loginNormalized: string,
    reason: string,
    metadata: RequestMetadataInterface,
  ): Promise<void> {
    await this.recordAudit({
      adminUserId,
      action: 'admin.login.failed',
      metadata,
      login: loginNormalized,
      extra: { method: 'passkey', reason },
    });
    const loginGuard = this.resolveSecurityServices().loginGuard;
    if (loginGuard) {
      await loginGuard.recordAttempt({
        loginNormalized,
        ipAddress: metadata.remoteAddress ?? '',
        success: false,
        reason,
        userAgent: metadata.userAgent,
      });
    }
  }

  /**
   * One audit row, shaped like the ones `AdminAuthService` writes so both end
   * up in the same view: action, IP, user agent, and a metadata blob carrying
   * the login and the request id.
   */
  private async recordAudit(input: {
    readonly adminUserId: string | null;
    readonly action: string;
    readonly metadata: RequestMetadataInterface;
    readonly login?: string;
    readonly extra?: Record<string, string | number | null>;
  }): Promise<void> {
    await this.prismaService.adminAuditLog.create({
      data: {
        action: input.action,
        ipAddress: input.metadata.remoteAddress,
        userAgent: input.metadata.userAgent,
        metadata: {
          login: input.login ?? '',
          requestId: input.metadata.requestId,
          ...(input.extra ?? {}),
        },
        ...(input.adminUserId ? { adminUser: { connect: { id: input.adminUserId } } } : {}),
      },
    });
  }

  /**
   * Decodes the challenge from the response's clientDataJSON, looks it up in
   * Redis (where the matching auth-options call placed it), and returns the
   * stored record for verification. Single-use — the entry is deleted on lookup.
   */
  private async findChallengeForResponse(
    response: AuthenticationResponseJSON,
  ): Promise<StoredAuthenticationChallenge | null> {
    try {
      const clientDataBuffer = Buffer.from(response.response.clientDataJSON, 'base64url');
      const clientData = JSON.parse(clientDataBuffer.toString('utf8')) as { challenge?: string };
      if (clientData.challenge) {
        const stored = await this.cacheService.get<StoredAuthenticationChallenge>(
          `passkey:auth:${clientData.challenge}`,
        );
        if (stored) {
          await this.cacheService.del(`passkey:auth:${clientData.challenge}`);
          return { challenge: stored.challenge, adminId: stored.adminId ?? null };
        }
      }
    } catch {
      // clientDataJSON unparseable or cache miss — fall through to null
    }
    return null;
  }
}

type AuthenticatorTransport = 'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb';
