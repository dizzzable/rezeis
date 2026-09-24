/** BullMQ queue that tells customers a dated add-on is about to end, or has. */
export const ADD_ON_EXPIRY_NOTICE_QUEUE = 'add-on-expiry-notice';

/** The only job on the queue: one pass over both moments. */
export const ADD_ON_EXPIRY_NOTICE_TICK_JOB = 'add-on-expiry-notice.tick';

/**
 * The tick's FIXED job id: one pass at a time across every process that
 * attaches a worker — the same device as the cutover's (`ADD_ON_CUTOVER_JOB_ID`).
 * Enqueued with `removeOnComplete` / `removeOnFail`, so the id is free again
 * the moment a pass ends.
 *
 * No `:` and not an integer: BullMQ refuses a custom id containing `:` unless it
 * splits into exactly three parts, and one that reads as an integer.
 */
export const ADD_ON_EXPIRY_NOTICE_JOB_ID = 'add-on-expiry-notice-tick';

/** How far ahead «ends in 3 days» looks, and how long an ended add-on stays a candidate for «has ended». */
export const ADD_ON_NOTICE_LEAD_MS = 3 * 24 * 60 * 60 * 1000;

/** Add-ons looked at per moment in one pass; the next pass carries on. */
export const ADD_ON_NOTICE_BATCH = 200;

/**
 * The durable record that a moment's notice was decided, on the add-on's own
 * event log (`add_on_entitlement_events`, unique per entitlement and key): a
 * retry, a restart or a second worker finds it and writes no second feed row.
 */
export const ADD_ON_NOTICE_COMMAND_KEY = {
  endsSoon: 'customer-notice:ends-soon',
  ended: 'customer-notice:ended',
} as const;

/**
 * The record that a decided notice's channels ran — the bot, web push, the
 * letter — written once they have. A decision to send with no such record is a
 * notice a crash may have cut off between its commit and its channels; a later
 * pass sends them again (`AddOnExpiryNoticeService`, the outbox).
 */
export const ADD_ON_NOTICE_DELIVERED_KEY = {
  endsSoon: 'customer-notice:ends-soon:delivered',
  ended: 'customer-notice:ended:delivered',
} as const;

/**
 * How long a decided notice waits for its channels before a pass sends them
 * again: far longer than a pass takes, so one still delivering is never raced.
 */
export const ADD_ON_NOTICE_REDELIVER_AFTER_MS = 15 * 60 * 1000;
