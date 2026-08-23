import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { RawCacheService } from '../../../common/cache/raw-cache.service';
import { appConfig } from '../../../common/config/app.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { PasswordHashService } from '../../auth/services/password-hash.service';
import { decryptTotpSecret, encryptTotpSecret } from '../utils/secret-cipher';
import { base32Decode } from '../utils/base32';
import {
  countLegacyRecoveryEntries,
  generateRecoveryCodeSet,
  verifyRecoveryCode,
} from '../utils/recovery-code';
import {
  buildOtpAuthUri,
  computeTotpCode,
  generateTotpSecret,
  verifyTotpCode,
} from '../utils/totp';

/**
 * TOTP parameters mirrored from `utils/totp.ts`, whose `DEFAULT_PERIOD_SEC` and
 * `DEFAULT_WINDOW` are module-private. They are used for ONE thing: naming the
 * time step a verified code belongs to, so the step can be claimed once.
 * `verifyTotpCode()` stays the only authority on whether a code is valid.
 *
 * `test/two-factor-totp-single-use.spec.ts` pins the mirror against the real
 * util, so a change to the util's defaults fails there rather than quietly
 * turning `resolveMatchedTimeStep()` into a function that never matches.
 */
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DRIFT_STEPS = 1;
/**
 * How long a consumed step stays claimed. A code minted for step `S` is
 * accepted while the current step is `S-1 .. S+1`, so counting from the
 * earliest moment it can be presented the band is
 * `period * (2 * window + 1)` = 90s. A shorter TTL would re-open the tail of
 * that band to replay.
 */
const TOTP_REPLAY_TTL_SECONDS = TOTP_PERIOD_SECONDS * (2 * TOTP_DRIFT_STEPS + 1);

export interface TwoFactorEnrollmentInterface {
  readonly secret: string;
  readonly otpauthUri: string;
  readonly recoveryCodes: readonly string[];
}

export interface TwoFactorStatusInterface {
  readonly enabled: boolean;
  readonly enrolledAt: string | null;
  readonly recoveryCodesRemaining: number;
  /**
   * How many of the remaining codes are still stored as the old unsalted
   * SHA-256 digest of a 40-bit code.
   *
   * These cannot be upgraded in place: a recovery code is single-use, so the
   * one moment its plain text is in hand is the moment it is consumed and
   * deleted. Honouring them is a deliberate choice (see `matchLegacy()` in
   * `utils/recovery-code.ts`), and this field is what stops the choice from
   * being invisible — a non-zero value means "regenerate to actually fix it".
   */
  readonly recoveryCodesLegacy: number;
}

/**
 * 2FA (TOTP) service for admin operators.
 *
 * Lifecycle
 *   1. `beginEnrollment(adminId)` — generates a fresh secret, encrypts it
 *      with REZEIS_CRYPT_KEY, stores it in `totpSecretEncrypted`, and
 *      returns the `otpauth://` URI so the UI can render a QR code.
 *      `totpEnabled` stays `false` until the operator confirms a code.
 *   2. `confirmEnrollment(adminId, code)` — verifies the code against the
 *      stored secret. On success, flips `totpEnabled` to `true` and
 *      generates one-time recovery codes (returned plaintext, hashed in DB).
 *   3. `verifyForLogin(adminId, code)` — called by AdminAuthService after
 *      password check. Accepts either a 6-digit TOTP or a recovery
 *      code. BOTH are single-use: a recovery code is deleted from the stored
 *      set, and a TOTP code's time step is claimed in the shared cache
 *      (RFC 6238 s5.2). See `claimTotpTimeStep()` for why that claim is
 *      fail-closed.
 *   4. `disable(adminId, code)` — admin must present a valid code to turn
 *      off 2FA, preventing a hijacked session from disabling the second
 *      factor.
 *
 * Recovery codes are 80-bit secrets stored salted and memory-hardened by
 * `utils/recovery-code.ts`; the plaintext list is displayed exactly once during
 * enrollment. Codes minted before that change are 40 bits behind an unsalted
 * single-round SHA-256 and are still accepted — read `matchLegacy()` there for
 * why, and `getStatus().recoveryCodesLegacy` for how an operator finds out.
 */
@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    @Inject(appConfig.KEY)
    private readonly applicationConfiguration: ConfigType<typeof appConfig>,
    /**
     * Backs the one-time claim that makes a TOTP code unusable twice.
     * `RawCacheModule` is `@Global()`, so Nest always supplies it in
     * production; `@Optional()` exists only so specs that build this service
     * by hand keep compiling. When it is missing the TOTP branch refuses
     * rather than degrades — see `claimTotpTimeStep()`.
     */
    @Optional()
    private readonly rawCacheService?: RawCacheService,
    /**
     * Verifies the current password before a NEW second factor is minted.
     *
     * `@Optional()` and last for the same reason as `rawCacheService` directly
     * above — so the many specs that construct this service positionally keep
     * compiling — and it fails the same way: when it is missing,
     * `beginEnrollment` REFUSES. An unresolvable verifier is not a reason to
     * mint a credential unverified, and this parameter exists precisely
     * because minting one unverified was a full account takeover.
     */
    @Optional()
    private readonly passwordHashService?: PasswordHashService,
  ) {}

  public async getStatus(adminId: string): Promise<TwoFactorStatusInterface> {
    const admin = await this.prismaService.adminUser.findUniqueOrThrow({
      where: { id: adminId },
      select: { totpEnabled: true, totpEnrolledAt: true, totpRecoveryCodes: true },
    });
    return {
      enabled: admin.totpEnabled,
      enrolledAt: admin.totpEnrolledAt?.toISOString() ?? null,
      recoveryCodesRemaining: admin.totpRecoveryCodes.length,
      recoveryCodesLegacy: countLegacyRecoveryEntries(admin.totpRecoveryCodes),
    };
  }

  /**
   * Begins (or restarts) the 2FA enrollment for an admin. The secret is
   * persisted immediately so the operator can confirm it from a different
   * tab; until `confirmEnrollment()` is called, `totpEnabled` stays
   * `false` and the secret has no effect on login.
   */
  public async beginEnrollment(
    adminId: string,
    password?: string,
  ): Promise<TwoFactorEnrollmentInterface> {
    const admin = await this.prismaService.adminUser.findUniqueOrThrow({
      where: { id: adminId },
      select: { id: true, login: true, totpEnabled: true, passwordHash: true },
    });
    if (admin.totpEnabled) {
      throw new ConflictException('2FA is already enabled. Disable it first to re-enroll.');
    }
    await this.assertPasswordBeforeEnrollment(admin.id, admin.passwordHash, password);
    const cryptKey = this.applicationConfiguration.cryptKey;
    if (!cryptKey) {
      throw new BadRequestException('REZEIS_CRYPT_KEY is required to enroll 2FA');
    }
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret, cryptKey);
    const recoverySet = await generateRecoveryCodeSet();

    await this.prismaService.adminUser.update({
      where: { id: adminId },
      data: {
        totpSecretEncrypted: encrypted,
        totpRecoveryCodes: [...recoverySet.stored],
      },
    });

    const otpauthUri = buildOtpAuthUri({
      secret,
      accountName: admin.login,
      issuer: this.applicationConfiguration.serviceName ?? 'Rezeis Admin',
    });

    return { secret, otpauthUri, recoveryCodes: recoverySet.codes };
  }

  /**
   * The current password, demanded before a NEW second factor is minted.
   *
   * Without this, a stolen bearer token was a complete account takeover, and
   * `enroll` was the whole attack: it hands the caller a fresh TOTP secret and
   * a fresh set of recovery codes, `confirm` turns them on, and from that
   * moment the account's second factor belongs to the attacker while the
   * legitimate operator's password stops being sufficient. Neither step asked
   * for anything the session did not already carry.
   *
   * It also repairs a premise something else depends on.
   * `PasskeyService.assertFreshFactor` picks the password when an account has
   * no 2FA, reasoning that it is "the only factor left that a hijacked session
   * does not hold" — which was false precisely because this route would sell
   * the session a second factor of its own. Two requests converted the
   * password branch into the TOTP branch and satisfied it.
   *
   * `confirm` is deliberately NOT gated the same way: it needs a code derived
   * from the secret this method returns, and that secret reaches only the
   * caller who got past this check. Gating the mint gates the pair.
   */
  private async assertPasswordBeforeEnrollment(
    adminId: string,
    passwordHash: string,
    password?: string,
  ): Promise<void> {
    const supplied = password ?? '';
    if (supplied.trim().length === 0) {
      // The prompt, not an error. `factor` tells the SPA which credential to
      // ask for; the filter forwards both fields for this code.
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'totp_enroll_reauth_required',
        factor: 'password',
        message: 'Confirm it is you before adding a second factor',
      });
    }
    if (!this.passwordHashService) {
      this.logger.error(
        `2FA enrollment refused for admin ${adminId}: no password verifier is available`,
      );
      throw new UnauthorizedException('Re-authentication is unavailable');
    }
    const accepted = await this.passwordHashService.verifyPassword({
      plainTextPassword: supplied,
      passwordHash,
    });
    if (!accepted) {
      this.logger.warn(`2FA enrollment refused for admin ${adminId}: password re-auth failed`);
      await this.recordEnrollmentAudit(adminId, 'admin.2fa.enrollment_rejected');
      throw new UnauthorizedException('Re-authentication failed');
    }
  }

  /**
   * Enrolment and its refusals were previously invisible: the module wrote no
   * `AdminAuditLog` row at all, only a logger line, so an account whose second
   * factor had been seized left nothing for an incident responder to find.
   *
   * Audit writes must never be able to fail the action they describe — a
   * refusal that throws from its own bookkeeping would answer 500 and read as
   * a server fault rather than a rejected credential.
   */
  private async recordEnrollmentAudit(adminUserId: string, action: string): Promise<void> {
    try {
      await this.prismaService.adminAuditLog.create({
        data: { adminUserId, action },
      });
    } catch (err) {
      this.logger.warn(`Failed to write ${action} audit row: ${(err as Error).message}`);
    }
  }

  /**
   * Verifies the supplied 6-digit code against the pending enrollment
   * secret and, on success, finalises the activation.
   */
  public async confirmEnrollment(adminId: string, code: string): Promise<TwoFactorStatusInterface> {
    const admin = await this.prismaService.adminUser.findUniqueOrThrow({
      where: { id: adminId },
      select: { totpEnabled: true, totpSecretEncrypted: true, totpRecoveryCodes: true },
    });
    if (admin.totpEnabled) {
      throw new ConflictException('2FA is already enabled');
    }
    if (!admin.totpSecretEncrypted) {
      throw new BadRequestException('Enrollment was not started — request a new secret first');
    }
    const cryptKey = this.applicationConfiguration.cryptKey;
    const secret = decryptTotpSecret(admin.totpSecretEncrypted, cryptKey);
    if (!verifyTotpCode(base32Decode(secret), code)) {
      throw new UnauthorizedException('Invalid verification code');
    }
    const updated = await this.prismaService.adminUser.update({
      where: { id: adminId },
      data: {
        totpEnabled: true,
        totpEnrolledAt: new Date(),
      },
      select: { totpEnabled: true, totpEnrolledAt: true, totpRecoveryCodes: true },
    });
    this.logger.log(`Admin ${adminId} enabled 2FA`);
    await this.recordEnrollmentAudit(adminId, 'admin.2fa.enabled');
    return {
      enabled: updated.totpEnabled,
      enrolledAt: updated.totpEnrolledAt?.toISOString() ?? null,
      recoveryCodesRemaining: updated.totpRecoveryCodes.length,
      recoveryCodesLegacy: countLegacyRecoveryEntries(updated.totpRecoveryCodes),
    };
  }

  /**
   * Verifies a TOTP code (or recovery code) for an authenticated admin.
   * Used at login and for re-prompting on privileged actions.
   *
   * Accepts:
   *   - 6-digit TOTP: validated against the stored secret with ±1 step drift,
   *     then consumed — the matched time step is claimed once per admin, so
   *     the same digits cannot be presented a second time inside the drift
   *     band.
   *   - recovery code: derived under the salt and cost recorded in each stored
   *     entry and compared with `timingSafeEqual`. On success the matching
   *     entry is removed, which is the single-use guarantee NIST SP 800-63B
   *     s3.1.2.2 requires ("a secret from a look-up secret authenticator SHALL
   *     be used successfully only once").
   *
   * Returns `false` for any malformed, invalid, or already-used code; never
   * throws.
   */
  public async verifyForLogin(adminId: string, codeRaw: string): Promise<boolean> {
    const code = codeRaw.trim().replace(/\s+/g, '');
    if (code.length === 0) return false;
    const admin = await this.prismaService.adminUser.findUnique({
      where: { id: adminId },
      select: { totpEnabled: true, totpSecretEncrypted: true, totpRecoveryCodes: true },
    });
    if (!admin || !admin.totpEnabled || !admin.totpSecretEncrypted) return false;

    // 6-digit TOTP
    if (/^\d{6}$/.test(code)) {
      let secret: Buffer;
      try {
        const cryptKey = this.applicationConfiguration.cryptKey;
        secret = base32Decode(decryptTotpSecret(admin.totpSecretEncrypted, cryptKey));
      } catch (err) {
        this.logger.warn(`TOTP verify failed for ${adminId}: ${(err as Error).message}`);
        return false;
      }
      if (!verifyTotpCode(secret, code)) return false;
      return this.claimTotpTimeStep(adminId, secret, code);
    }

    // Recovery code. `verifyRecoveryCode` decides the shape and spends no
    // derivation on a string that could not have been issued.
    const match = await verifyRecoveryCode(code, admin.totpRecoveryCodes);
    if (match.index === -1) return false;
    const remaining = admin.totpRecoveryCodes.filter((_, i) => i !== match.index);
    await this.prismaService.adminUser.update({
      where: { id: adminId },
      data: { totpRecoveryCodes: remaining },
    });
    this.logger.log(`Admin ${adminId} consumed a 2FA recovery code (${remaining.length} left)`);
    if (match.legacy) {
      // The one place the weakness of an already-issued code becomes visible in
      // an incident timeline. A code minted before salting is 40 bits behind an
      // unsalted digest, so a database dump plus minutes of GPU time produces
      // it; a responder needs to be able to see that this sign-in used one.
      this.logger.warn(
        `Admin ${adminId} signed in with a LEGACY (unsalted, 40-bit) 2FA recovery code — ` +
          'regenerate the set to replace the remaining ones',
      );
      await this.recordEnrollmentAudit(adminId, 'admin.2fa.legacy_recovery_code_used');
    }
    return true;
  }

  /**
   * Consumes the time step a just-verified TOTP code belongs to. Returns
   * `true` only for the FIRST presentation of that step.
   *
   * Why this is not optional. `verifyTotpCode()` is a pure function: with
   * `period = 30` and `window = 1` the same six digits stay valid across a
   * 90-second band, and before this claim existed they could be replayed an
   * unlimited number of times inside it. RFC 6238 s5.2 requires one-time use,
   * and the reason is concrete here — one captured code buys a 24h admin
   * session via `/admin/auth/login`, PERMANENT removal of the second factor
   * via `/admin/2fa/disable` (which asks for a code and not for the password),
   * and a fresh recovery-code set via `/admin/2fa/recovery-codes/regenerate`.
   *
   * `claimOnce()` is a single `SET key val NX EX ttl`, so two logins racing
   * with the same code cannot both win.
   *
   * FAIL-CLOSED, deliberately. `claimOnce()` returns `false` when the cache is
   * unreachable, and an unverifiable single-use claim is exactly the condition
   * a replay needs, so we refuse instead of granting. That means a Redis
   * outage takes TOTP logins down; recovery codes and the password-only path
   * for admins without 2FA are unaffected. The two refusals carry DIFFERENT
   * log lines on purpose: the operator reading "my code is rejected" reports
   * has to be able to tell "already used" from "the panel cannot reach the
   * cache", and from a plain wrong code (which logs nothing here at all).
   */
  private async claimTotpTimeStep(
    adminId: string,
    secret: Buffer,
    code: string,
  ): Promise<boolean> {
    if (!this.rawCacheService) {
      // Unreachable under Nest DI (`RawCacheModule` is `@Global()`); only a
      // hand-built instance lands here. Still closed: no claim store means no
      // single-use guarantee, and this method exists to provide one.
      this.logger.error(
        `TOTP rejected for ${adminId}: no cache service available to enforce single use`,
      );
      return false;
    }
    const step = resolveMatchedTimeStep(secret, code);
    if (step === null) {
      // `verifyTotpCode()` accepted a step this file cannot name, which can
      // only mean TOTP_PERIOD_SECONDS / TOTP_DRIFT_STEPS no longer mirror
      // `utils/totp.ts`. Refusing keeps single use intact; the mirror spec
      // names the constant to update.
      this.logger.error(
        `TOTP rejected for ${adminId}: the accepted code maps to no known time step — ` +
          'TOTP_PERIOD_SECONDS / TOTP_DRIFT_STEPS are out of sync with utils/totp.ts',
      );
      return false;
    }
    const key = totpStepClaimKey(adminId, step);
    try {
      if (await this.rawCacheService.claimOnce(key, TOTP_REPLAY_TTL_SECONDS)) {
        return true;
      }
      // `claimOnce()` collapses "already claimed" and "cache down" into one
      // `false`. Re-reading the key separates them. Failure path only, so the
      // successful login still costs a single round trip. A key that expired
      // in the gap between the two calls would be logged as an outage; that
      // changes the wording, never the decision.
      if (await this.rawCacheService.exists(key)) {
        this.logger.warn(
          `TOTP replay rejected for ${adminId}: the code for time step ${step} was already used`,
        );
      } else {
        this.logger.error(
          `TOTP rejected for ${adminId}: the single-use claim store is unavailable — ` +
            'failing closed. This is a cache outage, not a wrong code.',
        );
      }
      return false;
    } catch (err) {
      // `verifyForLogin` promises never to throw. A cache command that rejects
      // mid-flight is the outage case again, so it refuses the same way.
      this.logger.error(
        `TOTP rejected for ${adminId}: single-use claim failed (${(err as Error).message}) — ` +
          'failing closed',
      );
      return false;
    }
  }

  /**
   * Disables 2FA for an admin. Requires a valid code (TOTP or recovery)
   * so a hijacked session cannot turn off the second factor unilaterally.
   */
  public async disable(adminId: string, code: string): Promise<TwoFactorStatusInterface> {
    const admin = await this.prismaService.adminUser.findUniqueOrThrow({
      where: { id: adminId },
      select: { totpEnabled: true },
    });
    if (!admin.totpEnabled) {
      throw new NotFoundException('2FA is not enabled for this admin');
    }
    const ok = await this.verifyForLogin(adminId, code);
    if (!ok) {
      throw new UnauthorizedException('Invalid verification code');
    }
    await this.prismaService.adminUser.update({
      where: { id: adminId },
      data: {
        totpEnabled: false,
        totpSecretEncrypted: null,
        totpRecoveryCodes: [],
        totpEnrolledAt: null,
      },
    });
    this.logger.warn(`Admin ${adminId} disabled 2FA`);
    return {
      enabled: false,
      enrolledAt: null,
      recoveryCodesRemaining: 0,
      recoveryCodesLegacy: 0,
    };
  }

  /**
   * Regenerates the recovery code set. Useful when the operator believes
   * the original list has been compromised.
   */
  public async regenerateRecoveryCodes(adminId: string, code: string): Promise<readonly string[]> {
    const ok = await this.verifyForLogin(adminId, code);
    if (!ok) {
      throw new UnauthorizedException('Invalid verification code');
    }
    const recoverySet = await generateRecoveryCodeSet();
    await this.prismaService.adminUser.update({
      where: { id: adminId },
      data: { totpRecoveryCodes: [...recoverySet.stored] },
    });
    return recoverySet.codes;
  }

  /**
   * Lightweight existence check used by the login flow before issuing a
   * JWT — saves a round-trip to fetch unrelated columns.
   */
  public async isEnabled(adminId: string): Promise<boolean> {
    const admin = await this.prismaService.adminUser.findUnique({
      where: { id: adminId },
      select: { totpEnabled: true },
    });
    return admin?.totpEnabled === true;
  }
}

/**
 * Names the time step a verified code belongs to, without needing anything
 * `utils/totp.ts` does not export. Runs only AFTER `verifyTotpCode()` has
 * already returned true through its own constant-time comparison, so the plain
 * `===` below decides which of the three candidate steps matched and nothing
 * about validity.
 */
function resolveMatchedTimeStep(
  secret: Buffer,
  code: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): number | null {
  const currentStep = Math.floor(nowSeconds / TOTP_PERIOD_SECONDS);
  for (let offset = -TOTP_DRIFT_STEPS; offset <= TOTP_DRIFT_STEPS; offset += 1) {
    const step = currentStep + offset;
    if (computeTotpCode(secret, step * TOTP_PERIOD_SECONDS) === code) return step;
  }
  return null;
}

/**
 * Cache key for a consumed step. Scoped per admin so one operator's login
 * never blocks another's, and per step so the claim expires with the code.
 */
function totpStepClaimKey(adminId: string, step: number): string {
  return `admin:2fa:totp-step:${adminId}:${step}`;
}
