import type { NotifyDeliveryResult } from './services/bot-notifier.client';
import type { ReiwaRelayEvent } from './reiwa-relay.constants';

/**
 * How hard the queue tries, per event
 * ═══════════════════════════════════
 * The nine relayed events are not equally worth retrying, and the difference
 * is not importance — it is whether a retry can still change the outcome by
 * the time it fires.
 *
 *  - `durable` — nothing else will deliver this. A lost `reiwa.user.notify` is
 *    a message a subscriber never gets; a lost `reiwa.dev.notify` is the
 *    operator error firehose going quiet exactly when something is wrong.
 *    Neither has a second mechanism behind it, so the queue keeps trying
 *    across a cabinet restart or deploy (four attempts, ~105s of window).
 *
 *  - `bounded` — the cabinet heals itself. Every invalidation is a hint that
 *    a cache is stale, and each of those caches expires on its own anyway:
 *    the policy and legal-document caches at 60s
 *    (`infrastructure/admin-client/policy-cache.ts`,
 *    `legal-documents-cache.ts`), the bot-config cache at 5 min
 *    (`infrastructure/bot-config/cache.ts`). The webhook value is "~50ms
 *    instead of the TTL". A retry that lands after the TTL has already
 *    refreshed the cache busts a cache that is no longer stale — work, log
 *    lines and an operator alert, for a state that fixed itself. So: one
 *    extra attempt, fixed 10s, comfortably inside the shortest TTL. Then stop.
 *
 * Nothing on this queue stays fire-and-forget. Exactly one path does, and it
 * is not an event kind but a specific system event — see
 * `isRelayLoopGuardedEvent`.
 */
export type RelayDurability = 'durable' | 'bounded';

export interface RelayEventPolicy {
  readonly durability: RelayDurability;
  /** Total BullMQ attempts, including the first. */
  readonly attempts: number;
  readonly backoff: { readonly type: 'exponential' | 'fixed'; readonly delay: number };
  /**
   * Whether the envelope carries an `eventId` the reiwa-bot dedups on
   * (`IdempotencyCache.claim` in `bot/listeners/internal-http-listener.ts`).
   *
   * `false` means a retry of this event CAN produce a duplicate Telegram
   * message. It is recorded here rather than assumed, and it is a fact about
   * the PRODUCER first: a key the panel does not stamp is a key the bot cannot
   * dedup on, however ready the cabinet is to accept one. The two dev events
   * were `false` for exactly that reason — the cabinet grew an optional
   * `eventId` for `/notify-dev` and `/notify-dev-document` and the panel went
   * on sending neither, so the cabinet's dedup had nothing to key on. They are
   * `true` now because `SystemEventsService.deliverToReiwaDev` mints one.
   *
   * The four cache busts stay `false` deliberately, and it costs nothing:
   * replaying a cache bust is idempotent by construction — the second bust
   * drops an already-dropped cache — so there is no duplicate for a key to
   * prevent.
   */
  readonly botDedupKeyed: boolean;
}

const DURABLE: Omit<RelayEventPolicy, 'botDedupKeyed'> = {
  durability: 'durable',
  attempts: 4,
  // 15s -> 30s -> 60s. Long enough to cross a cabinet restart or a deploy,
  // short enough that a user notification is not stale when it lands.
  backoff: { type: 'exponential', delay: 15_000 },
};

const BOUNDED: Omit<RelayEventPolicy, 'botDedupKeyed'> = {
  durability: 'bounded',
  attempts: 2,
  // One extra attempt at a fixed 10s — inside the 60s cache TTL that would
  // otherwise heal this, so the retry can still be the thing that fixes it.
  backoff: { type: 'fixed', delay: 10_000 },
};

export const RELAY_EVENT_POLICY: Readonly<Record<ReiwaRelayEvent, RelayEventPolicy>> = {
  // A subscriber-facing message. Loss is invisible to everyone: the cabinet
  // feed row still exists, so nothing looks broken, and the user simply never
  // hears about their expiring subscription.
  'reiwa.user.notify': { ...DURABLE, botDedupKeyed: true },
  // Operator mirror of a user notification, and the system-event card when an
  // operator group/topic IS configured but rezeis holds no bot token.
  'reiwa.channel.broadcast': { ...DURABLE, botDedupKeyed: true },
  'reiwa.channel.broadcast.document': { ...DURABLE, botDedupKeyed: true },
  // The dev firehose. Silent exactly when things break, which is the only
  // time it matters — the strongest case on the list for retrying, and for a
  // while the only two events whose retries the bot could not dedup. It can
  // now: the panel stamps an `eventId` on both (`deliverToReiwaDev`) and the
  // cabinet keys `claimDevEvent` on it, scoped per endpoint. The field is
  // OPTIONAL cabinet-side (`optionalEventIdSchema`, `.catch(undefined)`) so a
  // panel that predates it still gets its alert through — it just gets the old
  // behaviour, which is why the honest reading of this flag is "the panel
  // shipped with it", not "the cabinet accepts it".
  'reiwa.dev.notify': { ...DURABLE, botDedupKeyed: true },
  'reiwa.dev.notify.document': { ...DURABLE, botDedupKeyed: true },
  // Cache hints. All four self-heal; see the `bounded` note above.
  'reiwa.bot.invalidate': { ...BOUNDED, botDedupKeyed: false },
  'reiwa.platform.policy_invalidated': { ...BOUNDED, botDedupKeyed: false },
  'reiwa.branding.invalidate': { ...BOUNDED, botDedupKeyed: false },
  'reiwa.landing.invalidate': { ...BOUNDED, botDedupKeyed: false },
};

/**
 * Did this attempt deliver?
 * ─────────────────────────
 * The backup relay demands `status === 'confirmed'`, and copying that rule
 * verbatim onto these nine would hang eight of them: the cabinet answers
 * `200 { messageId }` for exactly two events — `reiwa.user.notify` and
 * `reiwa.backup.document` — and a bodiless `204` for everything else
 * (`api/routes/webhooks.ts`, "Response contract"). `deliver()` maps a 204 to
 * `unconfirmed`, so for the other eight `confirmed` is unreachable by
 * construction and "retry until confirmed" means "retry until the attempts
 * run out", every time, forever.
 *
 * So the bar is per event, and it is the strongest evidence that event can
 * actually produce:
 *
 *  - `reiwa.user.notify` -> a Telegram message id. The bot returns one on a
 *    real send. Every path that yields `unconfirmed` here means the message
 *    did NOT reach the user: the recipient blocked the bot (403 -> 204), the
 *    telegramId is not a Telegram numeric id (dropped up front), the bot
 *    rejected the payload (4xx -> `200 { dropped: true }`), or the bot
 *    replayed a duplicate it had already delivered. Only the last of those is
 *    a delivery, and it is one this attempt did not make.
 *
 *  - the other eight -> a 2xx. That is the whole of what the cabinet promises
 *    for them, and demanding more would be demanding evidence that does not
 *    exist.
 */
/**
 * ── Why `reiwa.channel.broadcast` is NOT held to `confirmed` ──────────────
 *
 * It was, briefly, while fixing a channel post that reported success after
 * Telegram refused it. That refusal is fixed where it belongs: the bot used to
 * answer 204 on a Telegram 4xx, and a 204 means `unconfirmed`, which this
 * function counts as delivered. The bot now answers 422 for a refusal — a
 * non-2xx, so `rejected`, so undelivered and alerted — and echoes Telegram's
 * message id on success.
 *
 * Raising the bar HERE as well would have added nothing and cost something:
 * the panel and the bot ship as separate images, so a panel that demands a
 * message id while an older bot still answers a bodiless 204 would retry every
 * channel post to exhaustion and then report each one undelivered. The fix
 * belongs on the side that knows what happened.
 */
export function isRelayDelivered(event: ReiwaRelayEvent, outcome: NotifyDeliveryResult): boolean {
  if (event === 'reiwa.user.notify') return outcome.status === 'confirmed';
  return outcome.status === 'confirmed' || outcome.status === 'unconfirmed';
}

/**
 * Does an undelivered outcome deserve an operator alert, or only a record?
 *
 * The alert is narrow, because an alert that fires on routine per-subscriber
 * facts is an alert the operator learns to scroll past.
 *
 * This predicate now decides TWO things, and deliberately the same way: the
 * operator card, and whether `ReiwaRelayProcessor` fails or completes the job.
 * BullMQ's retained failed set is bounded (`removeOnFail`), so it is only
 * useful as a bin of incidents; letting the excluded outcome fail filled that
 * bin with the one thing in the set that is not one, evicting the jobs an
 * operator would go looking for. "Not worth an alert" and "not worth a slot
 * in the incident bin" are the same judgement, so they read from the same
 * line rather than drifting apart. The `!shouldAlertOperator` branch in
 * `ReiwaRelayProcessor.process` carries the rest of the reasoning.
 *
 * The one exclusion is `reiwa.user.notify` + `unconfirmed`. It is the only
 * outcome in the set that is a fact about ONE subscriber relationship with
 * the bot rather than about the link between the two hosts — overwhelmingly
 * "this person blocked the bot", which the bot already reports out of band by
 * flipping `User.isBotBlocked` (after which the fanout stops trying), and
 * which leaves the notification sitting in the cabinet feed regardless. On a
 * platform with any churn that is a steady drip of alerts nobody can act on.
 *
 * Every other undelivered outcome — a timeout that burned through its
 * attempts, a rejected signature, a relay that was never configured — is a
 * fact about the link, and the link is precisely what the operator has no way
 * to see today.
 */
export function shouldAlertOperator(
  event: ReiwaRelayEvent,
  outcome: NotifyDeliveryResult,
): boolean {
  return !(event === 'reiwa.user.notify' && outcome.status === 'unconfirmed');
}

/**
 * The one relay that must NOT be queued.
 * ──────────────────────────────────────
 * `SystemEventsService.emit` fans every event out to Telegram, and the relay
 * processor reports an exhausted job by emitting a system event. Put those two
 * together with a retrying queue and the failure feeds itself: job exhausts ->
 * `reiwa.relay_undelivered` -> deliverTelegram -> a new relay job -> exhausts
 * -> another alert, for as long as the cabinet stays down. Today the loop
 * terminates only because the dev firehose gets one attempt and drops the
 * outcome.
 *
 * So the alert about a relay keeps exactly the delivery model relays used to
 * have: one direct attempt, best-effort, outcome logged. The alert is not
 * relying on that attempt — it is already durable in `AdminAuditLog` and on
 * the realtime socket before Telegram is tried at all.
 */
export function isRelayLoopGuardedEvent(systemEventType: string): boolean {
  return systemEventType === 'reiwa.relay_undelivered';
}
