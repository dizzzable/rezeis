import { createHash, randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { appConfig } from '../../../common/config/app.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { decryptTotpSecret, encryptTotpSecret } from '../utils/secret-cipher';
import { base32Decode } from '../utils/base32';
import { buildOtpAuthUri, generateTotpSecret, verifyTotpCode } from '../utils/totp';

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 5; // 5 bytes --> 10 hex chars

export interface TwoFactorEnrollmentInterface {
  readonly secret: string;
  readonly otpauthUri: string;
  readonly recoveryCodes: readonly string[];
}

export interface TwoFactorStatusInterface {
  readonly enabled: boolean;
  readonly enrolledAt: string | null;
  readonly recoveryCodesRemaining: number;
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
 *      password check. Accepts either a 6-digit TOTP or a 10-char recovery
 *      code. Recovery codes are single-use (consumed on success).
 *   4. `disable(adminId, code)` — admin must present a valid code to turn
 *      off 2FA, preventing a hijacked session from disabling the second
 *      factor.
 *
 * The recovery codes are SHA-256-hashed in DB; the plaintext list is
 * displayed exactly once during enrollment.
 */
@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    @Inject(appConfig.KEY)
    private readonly applicationConfiguration: ConfigType<typeof appConfig>,
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
    };
  }

  /**
   * Begins (or restarts) the 2FA enrollment for an admin. The secret is
   * persisted immediately so the operator can confirm it from a different
   * tab; until `confirmEnrollment()` is called, `totpEnabled` stays
   * `false` and the secret has no effect on login.
   */
  public async beginEnrollment(adminId: string): Promise<TwoFactorEnrollmentInterface> {
    const admin = await this.prismaService.adminUser.findUniqueOrThrow({
      where: { id: adminId },
      select: { id: true, login: true, totpEnabled: true },
    });
    if (admin.totpEnabled) {
      throw new ConflictException('2FA is already enabled. Disable it first to re-enroll.');
    }
    const cryptKey = this.applicationConfiguration.cryptKey;
    if (!cryptKey) {
      throw new BadRequestException('REZEIS_CRYPT_KEY is required to enroll 2FA');
    }
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret, cryptKey);
    const recoveryCodes = generateRecoveryCodes();
    const recoveryHashes = recoveryCodes.map(hashRecoveryCode);

    await this.prismaService.adminUser.update({
      where: { id: adminId },
      data: {
        totpSecretEncrypted: encrypted,
        totpRecoveryCodes: recoveryHashes,
      },
    });

    const otpauthUri = buildOtpAuthUri({
      secret,
      accountName: admin.login,
      issuer: this.applicationConfiguration.serviceName ?? 'Rezeis Admin',
    });

    return { secret, otpauthUri, recoveryCodes };
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
    return {
      enabled: updated.totpEnabled,
      enrolledAt: updated.totpEnrolledAt?.toISOString() ?? null,
      recoveryCodesRemaining: updated.totpRecoveryCodes.length,
    };
  }

  /**
   * Verifies a TOTP code (or recovery code) for an authenticated admin.
   * Used at login and for re-prompting on privileged actions.
   *
   * Accepts:
   *   - 6-digit TOTP: validated against the stored secret with ±1 step drift.
   *   - 10-char recovery code: SHA-256-hashed and compared against the
   *     stored array. On success, the matching hash is removed.
   *
   * Returns `false` for any malformed or invalid code; never throws.
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
      try {
        const cryptKey = this.applicationConfiguration.cryptKey;
        const secret = decryptTotpSecret(admin.totpSecretEncrypted, cryptKey);
        return verifyTotpCode(base32Decode(secret), code);
      } catch (err) {
        this.logger.warn(`TOTP verify failed for ${adminId}: ${(err as Error).message}`);
        return false;
      }
    }

    // Recovery code (10 hex chars)
    if (/^[0-9a-f]{10}$/i.test(code)) {
      const hash = hashRecoveryCode(code.toLowerCase());
      const idx = admin.totpRecoveryCodes.indexOf(hash);
      if (idx === -1) return false;
      const remaining = admin.totpRecoveryCodes.filter((_, i) => i !== idx);
      await this.prismaService.adminUser.update({
        where: { id: adminId },
        data: { totpRecoveryCodes: remaining },
      });
      this.logger.log(`Admin ${adminId} consumed a 2FA recovery code (${remaining.length} left)`);
      return true;
    }

    return false;
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
    const recoveryCodes = generateRecoveryCodes();
    const recoveryHashes = recoveryCodes.map(hashRecoveryCode);
    await this.prismaService.adminUser.update({
      where: { id: adminId },
      data: { totpRecoveryCodes: recoveryHashes },
    });
    return recoveryCodes;
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

function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    randomBytes(RECOVERY_CODE_BYTES).toString('hex'),
  );
}

function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
