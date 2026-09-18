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
  'reiwa.connect-page.invalidate': { ...BOUNDED, botDedupKeyed: false },
};

/**
 * Did this attempt deliver?
 * ─────────────────────────
 * The backup relay demands `status === 'confirmed'`, and copying that rule
 * verbatim onto every event on this queue would hang most of them: the cabinet
 * answers `200 { messageId }` for three events — `reiwa.user.notify`,
 * `reiwa.backup.document` (not on this queue) and `reiwa.channel.broadcast`,
 * whose id `rememberRelayedChannelPost` stores so the post can be edited or
 * recalled — and a bodiless `204` for everything else (`api/routes/webhooks.ts`,
 * "Response contract"). `deliver()` maps a 204 to `unconfirmed`, so for the
 * rest `confirmed` is unreachable by construction and "retry until confirmed"
 * means "retry until the attempts run out", every time, forever.
 *
 * So the bar is per event, and it is the strongest evidence that event can
 * actually produce:
 *
 *  - `reiwa.user.notify` -> a Telegram message id. The bot returns one on a
 *    real send. What still yields `unconfirmed` here — `200 { messageId:
 *    null }` or a 204 — means the message did NOT reach the user through this
 *    attempt: the recipient blocked the bot or never started it (the cabinet
 *    keeps those a quiet 2xx on purpose), or the bot replayed a duplicate it
 *    had already delivered. Only the last is a delivery, and it is one this
 *    attempt did not make. A payload Telegram REFUSES is no longer among
 *    them: the cabinet answers that 422, which `deliver()` files as
 *    `rejected`, and a flood-wait is a 503 carrying `Retry-After`.
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
 * facts is an alert the operator learns to scroll past. It is also coalesced:
 * whatever this predicate lets through reaches the operator once per cause per
 * cooldown, not once per message (`undelivered-alert-gate.ts`).
 *
 * Two exclusions, and both are facts about who is at the far end rather than
 * about the link between the two hosts:
 *
 *  - `reiwa.user.notify` + `unconfirmed` — a fact about ONE subscriber
 *    relationship with the bot, overwhelmingly "this person blocked the bot",
 *    which the bot already reports out of band by flipping `User.isBotBlocked`
 *    (after which the fanout stops trying), and which leaves the notification
 *    sitting in the cabinet feed regardless. On a platform with any churn that
 *    is a steady drip of alerts nobody can act on.
 *
 *  - a dev relay that reached nobody — see `isDevRelayDeadEnd`.
 *
 * Every other undelivered outcome — a timeout that burned through its
 * attempts, a rejected signature, a message Telegram refused, a relay that was
 * never configured — is something the operator can act on and has no other way
 * to see.
 *
 * Whether the JOB fails is a separate question with a narrower answer — see
 * `shouldFailRelayJob`.
 */
export function shouldAlertOperator(
  event: ReiwaRelayEvent,
  outcome: NotifyDeliveryResult,
): boolean {
  if (event === 'reiwa.user.notify' && outcome.status === 'unconfirmed') return false;
  return !isDevRelayDeadEnd(event, outcome);
}

/**
 * Does a terminal undelivered outcome belong in BullMQ's retained failed set?
 *
 * That set is bounded (`removeOnFail`), so it is only useful as a bin of LINK
 * failures: a relay that burned its attempts while the cabinet was down, a
 * signature the cabinet refuses, a route it does not know. Anything else that
 * lands there evicts one of those.
 *
 * Two kinds of outcome complete instead, carrying `delivered: false`:
 *
 *  - everything `shouldAlertOperator` excludes — per-recipient and dead-end
 *    facts, which are not incidents at all;
 *  - a message Telegram refused (`isTelegramRefusal`). That one IS alerted, but
 *    it is a verdict on one message, not on the link, and it arrives in
 *    volume: a template Telegram will not parse is refused once per subscriber,
 *    and — with the operator mirror on — once more per mirror copy. Failing
 *    those put a thousand refusals of one template into a bin of a hundred.
 *    What they share is recorded once, as the coalesced alert, with the reason.
 */
export function shouldFailRelayJob(
  event: ReiwaRelayEvent,
  outcome: NotifyDeliveryResult,
): boolean {
  return shouldAlertOperator(event, outcome) && !isTelegramRefusal(outcome);
}

/**
 * Did this undelivered outcome certainly leave nothing in Telegram?
 *
 * Asked about a broadcast's channel post, whose page must not offer to recall —
 * or tell the operator to delete by hand — a post that never went up, and must
 * not hide one that may have.
 *
 *  - `rejected` with a 4xx: refused before anything was sent — by the cabinet
 *    (signature, route, body) or by Telegram itself (422).
 *  - `failed`: no response at all. Overwhelmingly a connection that was never
 *    made — the cabinet down, DNS, TLS. (A socket reset after the cabinet had
 *    the whole request is the exception this cannot see.)
 *  - `disabled`: no attempt.
 *
 * NOT a `timeout` — the cabinet and the bot may have finished after the panel
 * stopped waiting — and not a 5xx: a 502 includes the cabinet's own deadline on
 * the bot, and a 503 a replay of a send that is still out.
 */
export function isCertainlyUnsent(outcome: NotifyDeliveryResult): boolean {
  switch (outcome.status) {
    case 'rejected':
      return outcome.httpStatus !== null && outcome.httpStatus >= 400 && outcome.httpStatus < 500;
    case 'failed':
    case 'disabled':
      return true;
    default:
      return false;
  }
}

/** The cabinet's answer when Telegram refused THIS message: chat not found, bad markup, too long. */
export const RELAY_TELEGRAM_REFUSED_STATUS = 422;

/** The cabinet's answer on a dev route when its bot has no `BOT_DEV_ID`. */
export const RELAY_DEV_RECIPIENT_MISSING_STATUS = 424;

/**
 * Telegram refused the message itself. Permanent: the same payload is refused
 * again, so `isRetryableRelayOutcome` does not retry it, and the cabinet names
 * the reason in the body (`BotNotifierClient` carries it in `detail`).
 */
export function isTelegramRefusal(outcome: NotifyDeliveryResult): boolean {
  return outcome.status === 'rejected' && outcome.httpStatus === RELAY_TELEGRAM_REFUSED_STATUS;
}

/**
 * A dev relay that reached nobody.
 * ───────────────────────────────
 * The dev relays (`reiwa.dev.notify`, `…document`) are the FALLBACK route: a
 * system event takes it when the operator configured no chat at all, and the
 * cabinet hands it to the bot's `BOT_DEV_ID`. Two answers mean that route is a
 * dead end:
 *
 *  - 424: the bot has no `BOT_DEV_ID`. Nobody on either end — a deployment
 *    shape, not an incident: Telegram delivery was never set up.
 *  - 422 for the RECIPIENT (`isRecipientRefusal`): Telegram will not deliver
 *    anything to that `BOT_DEV_ID` — an account that never started the bot,
 *    blocked it, or does not exist.
 *
 * Alerting on either is not an alert, it is an echo. The alert is itself a
 * system event, with no chat to go to it takes the same dev route to the same
 * dead end — so every system event on such an install wrote a second one,
 * `reiwa.relay_undelivered`, delivered to no one. The remedy is a setting, and
 * an alert sent down the route that is broken cannot ask for it.
 *
 * So both are terminal and quiet — no alert, and the job completes, keeping
 * them out of the retained failed set. Narrow on purpose: only the dev routes,
 * and only a refusal of the recipient.
 *
 * A 422 for the PAYLOAD is not a dead end. "can't parse entities", "message is
 * too long": Telegram refused THIS card to a recipient who takes others, and
 * the alert about it is a different card that goes through. On an install
 * whose only channel is the dev DM that card is the operator's one trace of the
 * lost error report, so it is recorded like any other refusal — through the
 * gate, and the job completes (`shouldFailRelayJob`). A 424 or 422 on an
 * operator or subscriber route always alerts.
 */
export function isDevRelayDeadEnd(event: ReiwaRelayEvent, outcome: NotifyDeliveryResult): boolean {
  if (event !== 'reiwa.dev.notify' && event !== 'reiwa.dev.notify.document') return false;
  if (outcome.status !== 'rejected') return false;
  if (outcome.httpStatus === RELAY_DEV_RECIPIENT_MISSING_STATUS) return true;
  return outcome.httpStatus === RELAY_TELEGRAM_REFUSED_STATUS && isRecipientRefusal(outcome.detail);
}

/**
 * Telegram's words for "this chat cannot be written to", as the cabinet passes
 * them on in a 422's `detail` (`BotNotifierClient` keeps them in the outcome's
 * `detail`, after the HTTP status).
 *
 * Every "Forbidden: …" is one — blocked by the user, cannot initiate a
 * conversation, user deactivated, kicked, not a member, no rights — and so are
 * the "Bad Request: …" answers that name the chat or user rather than the
 * message. Everything else — markup Telegram cannot parse, a text or caption too
 * long, a button it rejects, a file it cannot read — is about the payload.
 *
 * Unknown words, or none (a refusal without a reason), are read as the payload:
 * that is the reading that leaves a trace. The opposite default would make any
 * refusal Telegram rewords into silence.
 */
const RECIPIENT_REFUSAL_PATTERNS: readonly RegExp[] = [
  /\bforbidden\b/,
  /\bchat not found\b/,
  /\buser not found\b/,
  /\bpeer_id_invalid\b/,
  /\bhave no rights\b/,
  /\bnot enough rights\b/,
  /\bchat_write_forbidden\b/,
  /\bchat_restricted\b/,
  /\bupgraded to a supergroup\b/,
];

export function isRecipientRefusal(detail: string | null): boolean {
  if (detail === null) return false;
  const words = detail.toLowerCase();
  return RECIPIENT_REFUSAL_PATTERNS.some((pattern) => pattern.test(words));
}

/**
 * The BullMQ backoff type relay jobs carry, resolved by the worker's custom
 * strategy (`relayBackoffStrategy`). A built-in type would never reach it:
 * BullMQ looks `fixed` and `exponential` up in its own table first, and those
 * strategies read the attempt number and nothing else — not the error, so no
 * `Retry-After`.
 *
 * The producer and the worker have to agree on it, and they ship in one image —
 * but a rolling deploy runs both images at once, and a worker from before this
 * type existed has no strategy for it. That worker does not fail the job. It
 * STALLS it: BullMQ computes the retry delay inside the worker's failure
 * handling (bullmq 5.81.5: `Job.moveToFailed` -> `shouldRetryJob` ->
 * `Backoffs.calculate`), the lookup throws "Unknown backoff strategy
 * reiwa-relay.", and the worker only emits that as an `error` event — which,
 * with no listener (the processor registers none), BullMQ prints through
 * `console.error` — and the job stays in `active` with a lock nobody renews:
 * the worker stops renewing it before the failure handling runs.
 * The stalled-job check moves it back to `wait` once the lock lapses — within
 * a minute of the failure with the defaults: the lock lapses at most
 * `lockDuration` (30s) after its last renewal, and the next check, every
 * `stalledInterval` (30s), moves it — and whichever worker takes it next
 * retries it: late, outside the event's backoff, and without counting an
 * attempt. If an OLD worker takes it again and stalls it a second time,
 * `maxStalledCount` (1) marks it, and the next worker to take it fails it as
 * "job stalled more than allowable limit" without running the processor, so
 * without an alert; only the processor's `failed` handler logs it (checked on
 * Valkey 9.1 with bullmq 5.81.5 and the defaults: the processor ran at 0s and
 * at 60s, the error was printed after each, and the job failed at 120s).
 * An attempt that computes no delay — the last one, or an `UnrecoverableError`
 * — is unaffected, and jobs queued before the type existed carry
 * `fixed`/`exponential` and work on both.
 */
export const RELAY_BACKOFF_TYPE = 'reiwa-relay';

/**
 * The longest wait a cabinet `Retry-After` may impose on one retry.
 *
 * The cabinet answers 503 with Telegram's flood-wait when the bot is being
 * throttled. Retrying inside that wait earns another 503 — and with the
 * durable backoff's 15s → 30s → 60s, a flood-wait longer than about 105s spent
 * every attempt inside it and ended in an alert for a message that only needed
 * patience. Honoured up to fifteen minutes: late for a notification, but
 * delivered, and a subscriber is better served by a late "your subscription
 * ends tomorrow" than by none. A longer wait is capped, not refused, so the
 * attempts still run out and alert if the throttling never lifts.
 */
export const RELAY_RETRY_AFTER_CEILING_SECONDS = 15 * 60;

/**
 * The delay before retry `attemptsMade` (1 for the first retry), honouring a
 * cabinet-named wait.
 *
 * Without a wait this is exactly what BullMQ's built-in strategy for the
 * event's policy returns — `fixed`: the delay; `exponential`:
 * `2^(attemptsMade-1) × delay` — so moving the jobs onto the custom type
 * changes nothing until a `Retry-After` arrives. With one, the later of the two
 * wins, plus a second of slack: `Retry-After` is when the wait ends, and landing
 * on the exact boundary is how a second one is earned. Same rule as
 * `resolveTelegramDirectBackoff`.
 */
export function resolveRelayBackoff(
  policy: Pick<RelayEventPolicy, 'backoff'>,
  attemptsMade: number,
  retryAfterSeconds: number | null,
): number {
  const base =
    policy.backoff.type === 'fixed'
      ? policy.backoff.delay
      : Math.round(2 ** (attemptsMade - 1) * policy.backoff.delay);
  if (retryAfterSeconds === null || retryAfterSeconds <= 0) return base;
  const wait = (Math.min(retryAfterSeconds, RELAY_RETRY_AFTER_CEILING_SECONDS) + 1) * 1_000;
  return Math.max(base, wait);
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
