/**
 * Panel → Telegram, with nobody in between
 * ════════════════════════════════════════
 * Every operator-facing card used to leave this panel through the reiwa bot:
 * panel → cabinet HTTP → bot process → Bot API. Three hops and two other
 * services for a message the panel is perfectly able to send itself.
 *
 * It was never a design decision. `SystemEventsService` looked for its bot
 * token at a key nothing writes (`readAdminBotToken` has the full account),
 * concluded it had none, and took the split-deployment fallback — every time,
 * on every deployment, including the ones with a token sitting in the panel.
 *
 * With the lookup fixed the panel sends its own operator cards. This queue is
 * what keeps that from being a downgrade: the relay gave those events four
 * attempts across a restart, and one bare `fetch` in a `catch` would have
 * taken that away in exchange for the directness.
 *
 * WHAT STAYS ON THE BOT, and why it is not an oversight:
 *
 *  - `reiwa.user.notify` — subscriber messages. The panel does not know which
 *    subscribers have started the bot, does not hold the per-user delivery
 *    bookkeeping, and must not be the thing that discovers a blocked bot. That
 *    is the cabinet's relationship, and it stays there in full.
 *  - the dev-DM fallback (`reiwa.dev.notify*`) — it targets the bot's own
 *    `BOT_DEV_ID`. The panel has never known that id and there is no reason to
 *    teach it: the whole point of that route is "the operator configured
 *    nothing, so send it to whoever runs the bot".
 *  - the four cache invalidations — not Telegram at all.
 *
 * So the split is not panel-vs-bot by preference. It is: what the panel can
 * address by itself, it now sends by itself.
 */

/** BullMQ queue name for panel-owned Telegram sends. */
export const TELEGRAM_DIRECT_QUEUE = 'telegram-direct';

/** Single job name; the send kind travels in the payload. */
export const TELEGRAM_DIRECT_JOB = 'telegram.direct';

/**
 * Four attempts — deliberately the same number `RELAY_EVENT_POLICY` gives a
 * `durable` event, because these ARE those events. Moving them onto a shorter
 * leash would make "the panel sends it itself" mean "the panel tries less
 * hard", which is not what was asked for and not what anyone would want.
 */
export const TELEGRAM_DIRECT_ATTEMPTS = 4;

/** 15s → 30s → 60s, matching the relay's durable backoff. */
export const TELEGRAM_DIRECT_BACKOFF_BASE_MS = 15_000;

/**
 * How long a Telegram flood-wait may push a card back before we stop waiting
 * and tell the operator instead.
 *
 * A 429 carries `parameters.retry_after` in seconds, and it is not advisory:
 * sending again before it elapses earns a longer wait. So the backoff honours
 * it (`resolveTelegramDirectBackoff`) rather than retrying into a wall.
 *
 * But only up to a point, and the ceiling is a judgement about what these
 * messages ARE. They are alerts — a payment failed, a node dropped, a relay
 * gave up. An alert delivered an hour after the fact is not a late alert, it
 * is a log entry, and the operator would rather learn that Telegram is
 * throttling the panel than receive the card at 03:00 for something that
 * happened at 02:00. Past the ceiling the outcome is terminal: it fails now,
 * loudly, with `retry_after` in the metadata.
 */
export const TELEGRAM_FLOOD_WAIT_CEILING_SECONDS = 300;

/** Per-request deadlines, mirroring the relay's budgets for the same shapes. */
export const TELEGRAM_MESSAGE_TIMEOUT_MS = 10_000;
export const TELEGRAM_DOCUMENT_TIMEOUT_MS = 35_000;

/**
 * What one queued send carries. Must stay JSON-serialisable — BullMQ stores
 * this in Redis and replays it verbatim on every attempt.
 */
export interface TelegramDirectJobData {
  /** `message` → `sendMessage`; `document` → `sendDocument` with a caption. */
  readonly kind: 'message' | 'document';
  readonly chatId: string;
  /** Forum topic (`message_thread_id`), or null for the general topic. */
  readonly topicId: number | null;
  /** Message body, or the document's caption. */
  readonly text: string;
  readonly parseMode: 'HTML' | null;
  /** `document` only. */
  readonly filename?: string;
  readonly content?: string;
  /**
   * The system event that produced this card. Carried for the log line and
   * the undelivered alert, never sent to Telegram — an operator reading a
   * failed job needs to know WHICH event was lost, and the rendered HTML is a
   * poor way to find out.
   */
  readonly sourceEventType: string;
}

/**
 * The backoff for attempt N, honouring a flood-wait when one is attached.
 *
 * Registered as the worker's `custom` strategy so it can see the error — a
 * plain `exponential` backoff cannot, which is the whole reason a 429's
 * `retry_after` would otherwise be ignored.
 *
 * Pure, and separated from the worker for exactly that reason: the interesting
 * behaviour here is a two-line `Math.max` that decides whether a retry lands
 * inside or outside a flood-wait, and that is worth testing without a Redis.
 */
export function resolveTelegramDirectBackoff(
  attemptsMade: number,
  retryAfterSeconds: number | null,
): number {
  // `attemptsMade` counts attempts already finished, so the first retry is
  // computed with 1 and gets the base delay.
  const exponent = Math.max(0, attemptsMade - 1);
  const base = TELEGRAM_DIRECT_BACKOFF_BASE_MS * 2 ** exponent;
  if (retryAfterSeconds === null || retryAfterSeconds <= 0) return base;
  // One second of slack: `retry_after` is when the ban lifts, and landing on
  // the exact boundary is how you earn a second one.
  return Math.max(base, (retryAfterSeconds + 1) * 1_000);
}

/**
 * The one event that must NOT be queued here.
 * ───────────────────────────────────────────
 * Exact sibling of `isRelayLoopGuardedEvent`, and the same trap: `emit()` fans
 * every event out to Telegram, and this queue reports an exhausted job by
 * emitting a system event. Put those together and the failure feeds itself —
 * job exhausts → `telegram.direct_undelivered` → deliverTelegram → a new
 * direct job → exhausts → another alert, for as long as Telegram is refusing.
 *
 * So the alert about a failed send keeps the delivery model this path had
 * before it was durable: one attempt, best-effort, outcome logged. It loses
 * nothing — the event is already in `AdminAuditLog` and on the realtime socket
 * before Telegram is tried at all.
 *
 * The chain terminates in the other direction too, and it is worth spelling
 * out because two queues now exist. A relay that exhausts emits
 * `reiwa.relay_undelivered`; on a panel WITH a token that goes out through
 * this queue, which is fine — a different transport, not a loop. If it also
 * fails it emits `telegram.direct_undelivered`, which this guard catches. Two
 * hops, then silence rather than a spiral.
 */
export function isTelegramDirectLoopGuardedEvent(systemEventType: string): boolean {
  return systemEventType === 'telegram.direct_undelivered';
}
