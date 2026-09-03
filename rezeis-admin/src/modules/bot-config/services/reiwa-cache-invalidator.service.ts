import { Injectable, Logger } from '@nestjs/common';

import { buildWebhookSignature } from '../../../common/http/webhook-signature.util';
import { ReiwaRelayQueueService } from '../../notifications/services/reiwa-relay-queue.service';

/**
 * ReiwaCacheInvalidatorService
 * ────────────────────────────
 * Tells reiwa that the bot-config changed so the running reiwa-bot drops
 * its in-memory cache and re-pulls within ~50ms instead of waiting up to
 * 5 minutes for the periodic refresh.
 *
 * Delivery model (snoups/Remnawave-style webhook — NOT a direct bot push):
 *   admin → POST <REIWA_URL>/api/v1/webhooks/rezeis
 *           body   { event: "reiwa.bot.invalidate", metadata: { reason } }
 *           header X-Rezeis-Signature: t=<sec>,v1=<hmac>  (keyed by
 *                  WEBHOOK_SECRET_HEADER, same scheme as the webhook system)
 *
 * reiwa-api verifies the signature against `REZEIS_WEBHOOK_SECRET` and
 * relays the bust to the bot over its private docker hop. The bot is never
 * exposed publicly and admin only ever knows reiwa's public domain
 * (`REIWA_URL`).
 *
 * Enabled only when BOTH `REIWA_URL` and `WEBHOOK_SECRET_HEADER` are set.
 * All calls are best-effort and fire-and-forget: a save in admin must NEVER
 * fail because reiwa is down.
 */
@Injectable()
export class ReiwaCacheInvalidatorService {
  private readonly logger = new Logger(ReiwaCacheInvalidatorService.name);
  private readonly endpoint: string | null;
  private readonly secret: string | null;
  /**
   * Budget for the ONE path that is still synchronous: the operator pressing
   * "refresh bot" and waiting for a true/false. Raised from 3s because that is
   * the only caller left holding the answer — every automatic invalidation now
   * goes to the queue, where `BotNotifierClient`'s own 10s budget applies.
   */
  private readonly timeoutMs = 5_000;

  public constructor(private readonly relayQueue: ReiwaRelayQueueService) {
    const baseUrl = (process.env.REIWA_URL ?? '').trim().replace(/\/+$/, '');
    this.secret = (process.env.WEBHOOK_SECRET_HEADER ?? '').trim() || null;
    this.endpoint = baseUrl.length > 0 ? `${baseUrl}/api/v1/webhooks/rezeis` : null;
    if (this.endpoint === null || this.secret === null) {
      this.logger.log(
        'Reiwa cache invalidation disabled (set REIWA_URL and WEBHOOK_SECRET_HEADER)',
      );
    }
  }

  /**
   * Notify reiwa that the cached bot-config is stale. Queued: this is called
   * from mutation interceptors that discard the result, so a single dropped
   * `fetch` used to mean the bot served stale config for up to five minutes
   * with nothing recorded anywhere.
   *
   * Bounded retries — see `RELAY_EVENT_POLICY`. The bot's own 5-minute refresh
   * heals this anyway, so the queue's job is to win the race, not to win it
   * eventually.
   */
  public async invalidate(reason: string): Promise<void> {
    await this.relayQueue.enqueue('reiwa.bot.invalidate', { reason });
  }

  /**
   * The one invalidation that stays synchronous: the operator's manual
   * "refresh bot" button, which shows them `{ ok }`.
   *
   * Routing it through the queue would turn that answer into "we wrote it
   * down" — the same species of lie this whole change is removing from the
   * broadcast status. A button that reports what an actual attempt proved has
   * to make an actual attempt.
   */
  public async invalidateNow(reason: string): Promise<boolean> {
    return this.dispatch('reiwa.bot.invalidate', { reason });
  }

  /**
   * Notify reiwa that the cached platform policy (incl. `accessMode`)
   * has changed. The reiwa edge drops its cached value so the next
   * gated request refetches the current mode immediately. Queued;
   * every caller `void`s this, and the policy cache TTL is 60s.
   */
  public async invalidatePolicy(reason: string): Promise<void> {
    await this.relayQueue.enqueue('reiwa.platform.policy_invalidated', { reason });
  }

  /**
   * Notify reiwa that branding / appearance settings changed so the reiwa
   * edge drops its cached `public-config` (palette, backgrounds, card +
   * app effects, icons). The next cabinet fetch then returns the fresh
   * theme without waiting for the HTTP cache TTL (~60s). Queued, bounded.
   */
  public async invalidateBranding(reason: string): Promise<void> {
    await this.relayQueue.enqueue('reiwa.branding.invalidate', { reason });
  }

  /**
   * Notify reiwa that the published web-landing config changed so the reiwa
   * edge drops its cached `/api/v1/landing` payload and the next visitor sees
   * the freshly-published landing without waiting for the HTTP cache TTL.
   * Called explicitly on publish/rollback (never on draft save). Queued,
   * bounded.
   */
  public async invalidateLanding(reason: string): Promise<void> {
    await this.relayQueue.enqueue('reiwa.landing.invalidate', { reason });
  }

  /**
   * Notify reiwa that the connect-screen catalog changed so the cabinet drops
   * its cached copy and the next customer to tap "Подключить" sees the apps the
   * operator just edited, instead of waiting out the HTTP cache TTL. Queued,
   * bounded, and fired only after the write has actually landed.
   */
  public async invalidateConnectPage(reason: string): Promise<void> {
    await this.relayQueue.enqueue('reiwa.connect-page.invalidate', { reason });
  }

  private async dispatch(
    event:
      | 'reiwa.bot.invalidate'
      | 'reiwa.platform.policy_invalidated'
      | 'reiwa.branding.invalidate'
      | 'reiwa.landing.invalidate'
      | 'reiwa.connect-page.invalidate',
    metadata: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.endpoint === null || this.secret === null) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const body = JSON.stringify({
        event,
        category: 'REIWA',
        severity: 'INFO',
        message: event,
        metadata,
        timestamp: new Date().toISOString(),
      });
      const { header } = buildWebhookSignature({ secret: this.secret, body });
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Rezeis-Event': event,
          'X-Rezeis-Signature': header,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok && response.status !== 204) {
        this.logger.warn(
          `Cache invalidate non-2xx: ${response.status} ${response.statusText} (event=${event})`,
        );
        return false;
      }
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Cache invalidate request failed (event=${event}): ${message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
