/** BullMQ queue name for broadcast delivery jobs. */
export const BROADCAST_DELIVERY_QUEUE = 'broadcast-delivery';

/** Job names within the broadcast queue. */
export const BROADCAST_JOBS = {
  /** Stage recipients and kick off batch delivery. */
  START: 'broadcast.start',
  /** Deliver a single batch of messages (text or media). */
  DELIVER_BATCH: 'broadcast.deliver-batch',
  /** Edit already-sent messages (editMessageText / editMessageCaption). */
  EDIT_BATCH: 'broadcast.edit-batch',
  /** Delete already-sent messages (deleteMessage). */
  DELETE_BATCH: 'broadcast.delete-batch',
  /** Retry failed messages from a previous delivery attempt. */
  RETRY_FAILED: 'broadcast.retry-failed',
} as const;

/** Batch size for splitting message arrays into jobs. */
export const BROADCAST_BATCH_SIZE = 50;

/**
 * Consecutive relay transport failures that open the delivery circuit.
 *
 * `deliverBatch` awaits one relay call per recipient, so an unreachable
 * cabinet costs `recipients x timeout` — 10 000 recipients times a 10s
 * abort is over a day of a worker slot spent proving the same thing 10 000
 * times. Five in a row is not bad luck, it is the link being down.
 *
 * Five rather than one, because a single timeout genuinely does happen to
 * an otherwise healthy link, and tripping on it would turn every hiccup
 * into a batch-wide retry.
 */
export const RELAY_CIRCUIT_BREAKER_THRESHOLD = 5;

/**
 * `UserNotificationEvent.type` every cabinet-feed row a broadcast writes
 * carries — the delivery fanout's rows and the dev preview's alike.
 *
 * Named because delivery now READS these rows back ("has this recipient
 * already been given this broadcast?") as well as writing them, and a reader
 * that disagrees with the writer about the type string finds nothing and
 * silently answers "no" — which is precisely the duplicate this lookup
 * exists to prevent. `BroadcastService` matches the same rows when it deletes
 * or edits a broadcast.
 */
export const BROADCAST_FEED_NOTIFICATION_TYPE = 'broadcast';

/** Delay between Telegram API calls (ms). ~30 msg/sec limit. */
export const TELEGRAM_RATE_LIMIT_MS = 50;

/**
 * Telegram's caption limit for a photo or video.
 *
 * A quarter of the 4096 a text message allows, and nothing checked it: a
 * 1500-character photo announcement was refused by Telegram for EVERY
 * recipient, one row at a time, so one length mistake read as four hundred
 * independent delivery failures.
 */
export const TELEGRAM_CAPTION_LIMIT = 1024;

/**
 * Event-id prefix of a broadcast's one-shot operator-channel post.
 *
 * Shared, because it is a contract between two modules: the delivery
 * service mints the id and the relay processor reads the broadcast id back
 * out of it to store where the post landed. Written out twice they would
 * drift, and the only symptom would be channel posts quietly becoming
 * uneditable again.
 */
export const BROADCAST_CHANNEL_EVENT_PREFIX = 'broadcast-channel:';

/**
 * The reason recorded when a recipient has blocked the bot.
 *
 * ── Why this is not just another failure string ───────────────────────────
 *
 * It is the single most common reason a broadcast does not arrive, and it was
 * indistinguishable from a transient one: the bot answers a bodiless 204 for a
 * blocked user (deliberately — the delivery decision is final), the relay reads
 * that as `unconfirmed`, and the row was written FAILED with
 * `telegram_relay_unconfirmed`. So the panel showed "N ошибок" and a retry
 * button that could never clear them — the relay deduplicates the retry by the
 * same event id, it comes back `unconfirmed` again, and the count does not
 * move. The operator learns nothing and presses it for ever.
 *
 * The fact itself is already known: the bot calls back to rezeis on a Telegram
 * 403 and `User.isBotBlocked` is set. Nothing in the broadcast module read it.
 * Recorded under its own reason, these recipients are counted apart, named on
 * screen, and left out of what "retry failed" offers to retry.
 */
export const BROADCAST_BLOCKED_REASON = 'telegram_blocked_by_user';

/**
 * Label for the auto-appended promo "activate" button on promo-tagged
 * broadcasts. Russian by default — consistent with the built-in notification
 * button labels (broadcasts are operator-authored single-language).
 */
export const BROADCAST_PROMO_BUTTON_LABEL = '🎁 Активировать промокод';
