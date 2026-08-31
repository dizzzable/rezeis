import { useEffect, useRef, useState } from 'react'

import { api } from '@/lib/api'
import type { ViewableMessage } from './kit/support-attachments'
import { planAttachmentBlobs } from './attachment-blobs'

/**
 * Fetches every image attachment in a thread and hands back `id → object URL`.
 *
 * One hook for the whole thread rather than one fetch per preview component, so
 * that the inline preview and the full-screen viewer show the same bytes and
 * every URL has exactly one owner to revoke it. See `attachment-blobs.ts` for
 * why the panel needs object URLs at all.
 */
export function useAttachmentBlobs(
  ticketId: string,
  messages: readonly ViewableMessage[] | null | undefined,
): ReadonlyMap<string, string> {
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map())
  const held = useRef(new Map<string, string>())

  useEffect(() => {
    let cancelled = false
    const { wanted, stale } = planAttachmentBlobs(messages, held.current)

    for (const url of stale) URL.revokeObjectURL(url)
    if (stale.length > 0) {
      for (const [id, url] of [...held.current]) {
        if (stale.includes(url)) held.current.delete(id)
      }
      setUrls(new Map(held.current))
    }
    if (wanted.length === 0) return

    void (async () => {
      for (const attachment of wanted) {
        try {
          const response = await api.get<Blob>(
            `/admin/support-tickets/${ticketId}/attachments/${attachment.id}`,
            { responseType: 'blob' },
          )
          if (cancelled) return
          held.current.set(attachment.id, URL.createObjectURL(response.data))
          setUrls(new Map(held.current))
        } catch {
          // One attachment the server will not hand over must not take the
          // thread down with it; its chip simply stays a chip.
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [ticketId, messages])

  // Release everything when the operator leaves this ticket. Without it, a
  // shift spent working a queue accumulates every screenshot it ever showed.
  useEffect(() => {
    const map = held.current
    return () => {
      for (const url of map.values()) URL.revokeObjectURL(url)
      map.clear()
    }
  }, [ticketId])

  return urls
}
