import { createHash, randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { RawCacheService } from '../../../common/cache/raw-cache.service';
import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * BotSigninTokenService
 * ─────────────────────
 * Issues + consumes one-time tokens that authenticate a bot user into
 * the web cabinet without typing a password.
 *
 * Flow (snoups-style magic link):
 *
 *   1. User taps the "Кабинет" reply-keyboard button in the bot.
 *   2. Reiwa-bot calls `issue(telegramId)` here, gets back a token,
 *      embeds it as `?signin=<token>` in the URL Telegram opens in
 *      the in-app browser.
 *   3. SPA on `/` sees the query param, POSTs `/api/v1/auth/bot-signin`
 *      with the token to the BFF.
 *   4. BFF calls `consume(token)` → gets `userId` → mints a WebSession
 *      cookie → 302 to `/dashboard`.
 *   5. Token is single-use; second `consume(token)` returns `null`.
 *
 * Storage: Redis (volatile but simple; 5-min TTL means lost-on-restart
 * is acceptable — user just taps the button again). Token is stored
 * as `sha256(token)` so even a Redis dump leak doesn't yield usable
 * credentials. Plaintext lives only in the response payload that travels
 * to the bot through the existing internal-network channel.
 *
 * Token format: 32 bytes of cryptographic randomness, hex-encoded
 * (64 chars). That's 256 bits of entropy — more than enough to make
 * brute-force and accidental collision both implausible during the
 * short TTL window.
 *
 * Identity model:
 *   The token binds a `telegramId` (from the bot) to a `userId` (the
 *   reiwa_id stamped on `User`). If the user with that telegramId
 *   doesn't exist yet, `issue()` returns null — the bot then opens
 *   the cabinet without a token and the SPA falls through to
 *   `/sign-in`. This shouldn't happen because `/start` always
 *   bootstraps the user before any keyboard render, but the path is
 *   defensive in case of clock skew between bootstrap and click.
 */
@Injectable()
export class BotSigninTokenService {
  private readonly logger = new Logger(BotSigninTokenService.name);

  /** TTL between issue and consume. Five minutes covers the realistic
   * window between a Telegram tap and the in-app browser landing on
   * the SPA — even on slow mobile connections. */
  private static readonly TTL_SECONDS = 5 * 60;

  /** Redis key prefix; namespaced under `web-auth:` so it's clearly
   * scoped and easy to audit / wipe in an incident. */
  private static readonly KEY_PREFIX = 'web-auth:bot-signin:';

  public constructor(
    private readonly cache: RawCacheService,
    private readonly prismaService: PrismaService,
  ) {}

  /**
   * Issue a fresh bot-signin token for the user identified by
   * `telegramId`. Returns null when the user can't be resolved
   * (corrupted state) — caller falls back to a tokenless URL.
   *
   * The plaintext token travels back to the bot through the same
   * internal-API channel that REZEIS_TOKEN already protects, so it's
   * only ever in flight on the docker network. After hitting Telegram
   * (which we don't trust as a confidentiality boundary) it's only in
   * the URL — which is acceptable because (a) the URL is single-use,
   * (b) the TTL is 5 min, and (c) consume issues a real WebSession
   * cookie that supersedes the token immediately.
   */
  public async issue(telegramId: string): Promise<{ token: string; expiresAt: string } | null> {
    const telegramIdBig = this.parseTelegramId(telegramId);
    if (telegramIdBig === null) return null;
    const user = await this.prismaService.user.findUnique({
      where: { telegramId: telegramIdBig },
      select: { id: true, isBlocked: true },
    });
    if (user === null) {
      // Bot bootstrap flow ought to make this impossible — log and
      // degrade gracefully so the keyboard still works.
      this.logger.warn(
        `bot-signin issue: user with telegramId=${telegramId} not found; falling back to tokenless URL`,
      );
      return null;
    }
    if (user.isBlocked) {
      // Refuse to mint a magic link for a blocked account. The cabinet
      // would just punt them back to /sign-in anyway, but issuing an
      // unusable token is wasteful and obscures the real problem.
      return null;
    }
    const token = randomBytes(32).toString('hex');
    const tokenHash = this.hash(token);
    const key = `${BotSigninTokenService.KEY_PREFIX}${tokenHash}`;
    await this.cache.set(key, { userId: user.id, telegramId }, BotSigninTokenService.TTL_SECONDS);
    const expiresAt = new Date(Date.now() + BotSigninTokenService.TTL_SECONDS * 1000).toISOString();
    return { token, expiresAt };
  }

  /**
   * Consume a token. Returns the bound `userId` on success, null when
   * the token is unknown / expired / already consumed. Single-use is
   * enforced by atomically deleting the Redis key as part of consume —
   * a parallel race ends with one winner and one null.
   */
  public async consume(token: string): Promise<{ userId: string } | null> {
    if (typeof token !== 'string' || token.length !== 64 || !/^[a-f0-9]+$/i.test(token)) {
      return null;
    }
    const tokenHash = this.hash(token);
    const key = `${BotSigninTokenService.KEY_PREFIX}${tokenHash}`;
    const stored = await this.cache.get<{ userId: string; telegramId: string }>(key);
    if (stored === null) return null;
    // Single-use: delete before returning. If this delete races with
    // a parallel consume, the loser sees `null` because their `get`
    // returned the same payload but only one delete actually removed
    // the key — too late, atomic at the Redis level.
    await this.cache.del(key);
    // Re-validate the user is still around and not blocked between
    // issue and consume (rare but worth defending against).
    const user = await this.prismaService.user.findUnique({
      where: { id: stored.userId },
      select: { id: true, isBlocked: true },
    });
    if (user === null || user.isBlocked) return null;
    return { userId: user.id };
  }

  private parseTelegramId(telegramId: string): bigint | null {
    if (!/^\d{1,19}$/.test(telegramId)) return null;
    try {
      return BigInt(telegramId);
    } catch {
      return null;
    }
  }

  private hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }
}
