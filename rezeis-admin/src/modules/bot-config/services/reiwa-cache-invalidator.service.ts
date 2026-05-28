import { Injectable, Logger } from '@nestjs/common';

/**
 * ReiwaCacheInvalidatorService
 * ────────────────────────────
 * Pushes a synchronous cache-bust to the reiwa-bot process when the
 * operator saves bot-config changes (buttons, emojis, texts).
 *
 * Without this push, reiwa-bot would wait up to 5 minutes (the
 * `BotConfigCache` TTL) before picking up the change. With the push
 * the next user `/start` sees the new keyboard within ~50ms of the
 * operator clicking Save.
 *
 * Wire:
 *   admin (this service) → POST http://reiwa-bot:5100/invalidate
 *                          header X-Auth-Token: <REZEIS_INTERNAL_SHARED_SECRET>
 *
 * `reiwa-bot:5100` is resolved through docker DNS — both processes
 * share the `remnawave-network` so the call never leaves the host.
 *
 * The endpoint is only available when the operator has set
 * `REZEIS_INTERNAL_SHARED_SECRET` (same key reiwa uses for outbound
 * HMAC). When unset, this service short-circuits to a debug log and
 * the cache invalidation falls back to the 5-minute TTL refresh.
 *
 * All calls are best-effort and fire-and-forget: a save in admin must
 * NEVER fail because reiwa-bot is down or unreachable. Logged at warn
 * level on failure so an operator inspecting logs can spot a
 * misconfigured bot endpoint.
 */
@Injectable()
export class ReiwaCacheInvalidatorService {
  private readonly logger = new Logger(ReiwaCacheInvalidatorService.name);
  private readonly endpoint: string;
  private readonly secret: string;
  private readonly enabled: boolean;
  private readonly timeoutMs = 3_000;

  public constructor() {
    const host = (process.env.REIWA_BOT_HOST ?? 'reiwa-bot').trim();
    const port = Number.parseInt(process.env.REIWA_BOT_INVALIDATE_PORT ?? '5100', 10);
    this.endpoint = `http://${host}:${port}/invalidate`;
    this.secret = (process.env.REZEIS_INTERNAL_SHARED_SECRET ?? '').trim();
    this.enabled = this.secret.length >= 32;
    if (!this.enabled) {
      this.logger.log(
        'Reiwa cache invalidation disabled (REZEIS_INTERNAL_SHARED_SECRET not configured)',
      );
    }
  }

  /**
   * Notify reiwa-bot that the cached bot-config is stale. Returns
   * `true` when the push succeeded (HTTP 2xx), `false` otherwise.
   * Never throws — callers are free to ignore the return value.
   */
  public async invalidate(reason: string): Promise<boolean> {
    if (!this.enabled) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'X-Auth-Token': this.secret,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason }),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.warn(
          `Cache invalidate non-2xx: ${response.status} ${response.statusText} (reason=${reason})`,
        );
        return false;
      }
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Cache invalidate request failed (reason=${reason}): ${message}`,
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
