import { TELEGRAM_CAPTION_LIMIT } from '../broadcast.constants';

/**
 * How long the Telegram caption of a media broadcast actually is, and whether
 * Telegram will take it.
 *
 * ── One implementation, deliberately ──────────────────────────────────────
 *
 * Two callers need this answer: composing (refuse the operator's edit while
 * they are still looking at it) and staging (refuse a draft written before the
 * check existed, before it costs one rejection per recipient). Writing it twice
 * is how the email renderer ended up with a live copy and a tested copy that
 * were not the same function, so the reported bug stayed fixed only in the
 * tests. Both callers import this.
 */

interface CaptionSource {
  readonly mediaType?: unknown;
  readonly mediaFileId?: unknown;
  readonly text?: unknown;
  readonly title?: unknown;
}

/**
 * Whether this payload goes out as a CAPTION rather than as a message.
 *
 * The file id is part of the question, and it must be NON-EMPTY. Delivery asks
 * through this same function now; while it kept its own version the two
 * disagreed in both directions. Testing `mediaType` alone here refused a
 * broadcast with no attachment as an over-long caption and dropped its
 * schedule; testing `mediaFileId !== null` there accepted the empty string the
 * panel writes for "no media" and sent `sendPhoto` with an empty `photo`.
 */
export function isMediaPayload(payload: unknown): boolean {
  const source = (payload ?? {}) as CaptionSource;
  const hasFile = typeof source.mediaFileId === 'string' && source.mediaFileId.length > 0;
  return (source.mediaType === 'photo' || source.mediaType === 'video') && hasFile;
}

/**
 * The composed caption length — title and body together, since the delivery
 * path joins them into the single string Telegram counts.
 */
export function captionLengthOf(payload: unknown): number {
  const source = (payload ?? {}) as CaptionSource;
  const title = typeof source.title === 'string' ? source.title.trim() : '';
  const text = typeof source.text === 'string' ? source.text : '';
  // The `+ 2` is the blank line the composer puts between them; it is part of
  // what Telegram counts, and leaving it out let a caption two characters over
  // the limit pass a check that then failed at the API.
  return (title.length > 0 ? title.length + 2 : 0) + text.length;
}

/**
 * The caption length when it exceeds Telegram's limit, `null` when it fits or
 * when the broadcast carries no media (a plain message gets four times as many
 * characters and is validated elsewhere).
 */
export function captionOverflowOf(payload: unknown): number | null {
  // NO "measure it without the title" option any more. It existed because
  // `editBatch` sent the new body alone, so charging the title looked like a
  // false rejection — but the real fault was that the edit composed differently
  // from delivery. A retry after such an edit went through `deliverBatch`,
  // which DOES join the title, so a correction accepted at exactly the limit
  // became limit-plus-title on the wire and Telegram refused every retried
  // recipient. The edit composes with the title now, so one measurement is
  // correct everywhere and the option would only be a way to disagree again.
  if (!isMediaPayload(payload)) return null;
  const length = captionLengthOf(payload);
  return length > TELEGRAM_CAPTION_LIMIT ? length : null;
}
