import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AuthProviderType } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { OAuthUserProfile } from '../interfaces/oauth-provider.interface';

/**
 * Telegram Login Widget verification.
 *
 * Telegram uses HMAC-SHA256 to sign the login data. The verification flow:
 *   1. Frontend embeds the Telegram Login Widget
 *   2. User authenticates via Telegram
 *   3. Widget redirects with signed data (id, first_name, username, photo_url, auth_date, hash)
 *   4. Backend verifies the hash using SHA256(bot_token) as the HMAC key
 *   5. Checks auth_date is not older than 5 minutes (replay protection)
 *
 * Reference: https://core.telegram.org/widgets/login#checking-authorization
 */
@Injectable()
export class TelegramAuthService {
  private readonly logger = new Logger(TelegramAuthService.name);

  /** Maximum age of auth_date in seconds (5 minutes). */
  private static readonly MAX_AUTH_AGE_SECONDS = 300;

  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Verifies Telegram Login Widget data and returns a normalized profile.
   *
   * @param data - The query parameters from the Telegram widget callback
   */
  public async verifyTelegramLogin(
    data: Record<string, string>,
  ): Promise<OAuthUserProfile> {
    const config = await this.prismaService.authProviderConfig.findUnique({
      where: { type: AuthProviderType.TELEGRAM },
      select: { clientId: true, isEnabled: true },
    });

    if (!config || !config.isEnabled || !config.clientId) {
      throw new UnauthorizedException('Telegram login is not configured');
    }

    // clientId stores the bot token for Telegram
    const botToken = config.clientId;

    // Verify the hash
    this.verifyHash(data, botToken);

    // Check auth_date freshness
    this.verifyAuthDate(data['auth_date']);

    const telegramId = data['id'];
    if (!telegramId) {
      throw new UnauthorizedException('Invalid Telegram login data: missing id');
    }

    return {
      providerId: telegramId,
      providerType: AuthProviderType.TELEGRAM,
      email: null, // Telegram doesn't provide email
      name: [data['first_name'], data['last_name']].filter(Boolean).join(' ') || null,
      avatarUrl: data['photo_url'] || null,
      rawProfile: {
        id: telegramId,
        username: data['username'] || null,
        firstName: data['first_name'] || null,
        lastName: data['last_name'] || null,
        photoUrl: data['photo_url'] || null,
      },
    };
  }

  /**
   * Verifies the HMAC-SHA256 hash of the Telegram login data.
   *
   * Algorithm:
   *   1. Sort all fields except 'hash' alphabetically
   *   2. Join as "key=value\n" (data-check-string)
   *   3. Compute SHA256(bot_token) as the secret key
   *   4. Compute HMAC-SHA256(data-check-string, secret_key)
   *   5. Compare with the provided hash
   */
  private verifyHash(data: Record<string, string>, botToken: string): void {
    const hash = data['hash'];
    if (!hash) {
      throw new UnauthorizedException('Invalid Telegram login data: missing hash');
    }

    // Build data-check-string
    const checkString = Object.keys(data)
      .filter((key) => key !== 'hash')
      .sort()
      .map((key) => `${key}=${data[key]}`)
      .join('\n');

    // Secret key = SHA256(bot_token)
    const secretKey = createHash('sha256').update(botToken).digest();

    // Compute HMAC
    const computedHash = createHmac('sha256', secretKey)
      .update(checkString)
      .digest();

    // Timing-safe comparison to prevent side-channel attacks
    const providedHash = Buffer.from(hash, 'hex');
    if (computedHash.length !== providedHash.length || !timingSafeEqual(computedHash, providedHash)) {
      this.logger.warn('Telegram login hash verification failed');
      throw new UnauthorizedException('Telegram login verification failed');
    }
  }

  /**
   * Verifies that auth_date is not older than MAX_AUTH_AGE_SECONDS.
   */
  private verifyAuthDate(authDateStr: string | undefined): void {
    if (!authDateStr) {
      throw new UnauthorizedException('Invalid Telegram login data: missing auth_date');
    }

    const authDate = parseInt(authDateStr, 10);
    if (isNaN(authDate)) {
      throw new UnauthorizedException('Invalid Telegram login data: invalid auth_date');
    }

    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > TelegramAuthService.MAX_AUTH_AGE_SECONDS) {
      throw new UnauthorizedException('Telegram login data has expired');
    }
  }
}
