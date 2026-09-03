/**
 * BullMQ queue name for durable reiwa webhook relay jobs.
 *
 * One queue for every panel → cabinet webhook EXCEPT `reiwa.backup.document`,
 * which already owns a retry loop on the backup queue (it has to: the retry
 * decision there is entangled with the backup record's delivery bookkeeping,
 * and a second attempt re-uploads a whole file).
 */
export const REIWA_RELAY_QUEUE = 'reiwa-relay';

/**
 * Single job name. The event kind travels in the payload rather than the job
 * name so the retry policy can be looked up from data — a job name per event
 * would put nine near-identical branches in the processor and still need the
 * lookup.
 */
export const REIWA_RELAY_JOB = 'reiwa.relay';

/**
 * The ten events this queue owns, in the order the audit listed them.
 *
 * `reiwa.backup.document` is deliberately absent — see `REIWA_RELAY_QUEUE`.
 */
export const REIWA_RELAY_EVENTS = [
  'reiwa.user.notify',
  'reiwa.channel.broadcast',
  'reiwa.channel.broadcast.document',
  'reiwa.dev.notify',
  'reiwa.dev.notify.document',
  'reiwa.bot.invalidate',
  'reiwa.platform.policy_invalidated',
  'reiwa.branding.invalidate',
  'reiwa.landing.invalidate',
  'reiwa.connect-page.invalidate',
] as const;

export type ReiwaRelayEvent = (typeof REIWA_RELAY_EVENTS)[number];

/**
 * Who may reach the cabinet WITHOUT the queue
 * ═══════════════════════════════════════════
 * `BotNotifierClient` still exposes the one-shot delivery methods the queue is
 * built on, and nothing in the type system stops the next caller from quietly
 * going around it. That is not hypothetical: `BroadcastDeliveryService` posted
 * the operator-channel copy of every broadcast through `notifyBroadcast`,
 * which gave a `durable` event exactly one attempt and — because that method
 * returns `Promise<void>` and `deliver()` never throws — wrapped it in a
 * `catch` that could not fire on a delivery failure. Nothing distinguished a
 * refused post from a delivered one.
 *
 * This is the list of source files allowed to call those methods directly, and
 * the reason each one is on it. `test/reiwa-relay-bypass-invariant.spec.ts`
 * reads this list, enumerates the real callers from the tree, and fails on any
 * caller that is not here. Adding an entry is a deliberate act with a written
 * reason; it is not a place to quiet a failing test.
 */
export const RELAY_DIRECT_DELIVERY_EXCEPTIONS: Readonly<Record<string, string>> = {
  'src/modules/notifications/reiwa-relay.processor.ts':
    'The consumer half of the queue. This call IS the attempt a queued job makes.',
  'src/modules/notifications/services/reiwa-relay-queue.service.ts':
    'Producer fallback when Redis refuses the enqueue — one direct attempt keeps ' +
    'the floor at the pre-queue behaviour instead of turning a Redis blip into a ' +
    'silently dropped notification.',
  'src/common/services/system-events.service.ts':
    'The relay-exhausted alert (`reiwa.relay_undelivered`) must not re-enter the ' +
    'queue it is reporting on, or the failure feeds itself for as long as the ' +
    'cabinet is down. See `isRelayLoopGuardedEvent`.',
  'src/modules/backup/services/backup.service.ts':
    '`reiwa.backup.document` is not on this queue at all (see `REIWA_RELAY_QUEUE`): ' +
    'it owns a retry loop on the backup queue, and it consumes the returned ' +
    'outcome rather than dropping it.',
  'src/modules/broadcast/services/broadcast-delivery.service.ts':
    'Two paths that need the answer in hand, both of which read the outcome they ' +
    'get: per-recipient `notifyUser`, whose returned Telegram message id decides ' +
    'SENT vs FAILED and is persisted for later edit/delete; and the operator ' +
    '"send test" button, which shows a human `{ ok }` and so has to make an ' +
    'attempt whose result it can show — the same reasoning as ' +
    '`ReiwaCacheInvalidatorService.invalidateNow`. The broadcast\'s channel post ' +
    'is NOT among them: it goes through the queue.',
};

/** Payload of a `reiwa.relay` job. Must stay JSON-serialisable. */
export interface ReiwaRelayJobData {
  readonly event: ReiwaRelayEvent;
  readonly metadata: Record<string, unknown>;
}
