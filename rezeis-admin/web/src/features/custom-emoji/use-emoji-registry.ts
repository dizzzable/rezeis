import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'

/** A single emoji in the central custom-emoji registry. */
export interface RegistryEmoji {
  readonly slug: string
  readonly name: string
  readonly imageUrl: string
  readonly lottieUrl: string | null
  readonly videoUrl: string | null
  readonly fallback: string | null
  readonly customEmojiId: string | null
}

/** A named group of registry emojis. */
export interface RegistryPack {
  readonly id: string
  readonly name: string
  readonly builtin?: boolean
  readonly emojis: readonly RegistryEmoji[]
}

export const EMOJI_REGISTRY_KEY = ['admin', 'custom-emoji', 'packs'] as const

/**
 * useEmojiRegistry
 * ────────────────
 * Single source of truth for every admin emoji surface (broadcast picker, bot
 * button icon, bot text slots). Loads the operator's custom-emoji packs and
 * exposes both the pack list and a flat `customEmojiId → emoji` index so a
 * stored id can be resolved back to its preview image/animation.
 *
 * `enabled` lets callers defer the fetch until a popover opens.
 */
export function useEmojiRegistry(options?: { readonly enabled?: boolean }) {
  const query = useQuery<ReadonlyArray<RegistryPack>>({
    queryKey: EMOJI_REGISTRY_KEY,
    queryFn: async () => (await api.get<ReadonlyArray<RegistryPack>>('/admin/custom-emoji/packs')).data,
    staleTime: 60_000,
    enabled: options?.enabled ?? true,
  })

  const byCustomEmojiId = useMemo(() => {
    const map = new Map<string, RegistryEmoji>()
    for (const pack of query.data ?? []) {
      for (const emoji of pack.emojis) {
        if (emoji.customEmojiId) map.set(emoji.customEmojiId, emoji)
      }
    }
    return map
  }, [query.data])

  return {
    packs: query.data ?? [],
    isLoading: query.isLoading,
    byCustomEmojiId,
  }
}
