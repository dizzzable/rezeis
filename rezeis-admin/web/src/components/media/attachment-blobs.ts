import type { ViewableAttachmentSource, ViewableMessage } from './kit/support-attachments'
import { collectViewableAttachments } from './kit/support-attachments'

/**
 * Object-URL bookkeeping for ticket attachments in the panel.
 *
 * ── Why the panel needs this and the cabinet does not ─────────────────────
 * The cabinet's attachment endpoint is same-origin and session-cookied, so an
 * `<img src>` just works. The panel's admin API authenticates with a header,
 * which an `<img>` cannot send — so every preview has to be fetched as a blob
 * and handed to the DOM as an object URL.
 *
 * That turns a preview into something with a lifetime, and object URLs that are
 * never revoked hold their blobs in memory for as long as the tab lives. An
 * operator working a queue opens a lot of tickets. So the fetching, the map and
 * the revoking live here, in one place, rather than inside each preview
 * component where "revoke on unmount" is one forgotten cleanup away from a leak.
 */

export interface AttachmentBlobPlan {
  /** Attachments worth fetching, in thread order. */
  readonly wanted: readonly ViewableAttachmentSource[]
  /** Object URLs to release: held for attachments no longer in the thread. */
  readonly stale: readonly string[]
}

/**
 * Works out what to fetch and what to release for a thread.
 *
 * Separate from the fetching so the decision can be tested: the leak and the
 * broken-image bug are both decisions, not network calls.
 */
export function planAttachmentBlobs(
  messages: readonly ViewableMessage[] | null | undefined,
  held: ReadonlyMap<string, string>,
): AttachmentBlobPlan {
  const viewable = collectViewableAttachments(messages, (attachment) => attachment.id)
  const wantedIds = new Set(viewable.map((item) => item.id))

  const stale: string[] = []
  for (const [id, url] of held) {
    if (!wantedIds.has(id)) stale.push(url)
  }

  const wanted: ViewableAttachmentSource[] = []
  const seen = new Set<string>()
  for (const message of messages ?? []) {
    for (const attachment of message.attachments ?? []) {
      // Already fetched, or already queued: a thread that repeats an attachment
      // id must not be fetched twice, and a poll that re-delivers the same
      // messages must not refetch everything on every tick.
      if (!wantedIds.has(attachment.id)) continue
      if (held.has(attachment.id) || seen.has(attachment.id)) continue
      seen.add(attachment.id)
      wanted.push(attachment)
    }
  }

  return { wanted, stale }
}
