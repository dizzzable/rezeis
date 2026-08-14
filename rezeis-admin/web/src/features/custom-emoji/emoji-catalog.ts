/**
 * The one place the panel asks what a `:slug:` and a `{{KEY}}` resolve to.
 *
 * `emoji-field-render.ts` holds the RULES — which token becomes a picture, a
 * carrier glyph or marked raw text — and both surfaces already shared it. What
 * they did not share was the WIRING: the in-field layer and the copy preview
 * each declared the same three query keys, the same two lenient schemas and the
 * same `default true` premium fallback, in their own files. Nothing enforced
 * that the two copies stayed equal, so changing a query key in one of them
 * would have quietly given the same screen two different catalogs — the field
 * saying one thing about a token and the preview a centimetre below it saying
 * another. The `ready` gate below had exactly that history: it was added to the
 * layer and the preview's copy never got it.
 *
 * So the queries live here once and both import them. The preview also needs
 * the animated forms, which the layer deliberately never draws (a still is what
 * belongs behind a caret), so `art` is built here too and simply ignored by the
 * caller that has no use for it — one fetch, one parse, one answer.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'

import { api } from '@/lib/api'
import { expectArray } from '@/lib/api-utils'

import type { FieldPackEmoji, FieldSlotEmoji } from './emoji-field-render'

/** Shared with the pack manager and the studio, so nothing refetches. */
export const EMOJI_PACKS_KEY = ['admin', 'custom-emoji', 'packs'] as const
export const EMOJI_SLOTS_KEY = ['admin', 'bot-config', 'emojis'] as const
export const EMOJI_OWNER_PREMIUM_KEY = [
  'admin',
  'bot-config',
  'emoji-studio',
  'owner-premium',
] as const

/**
 * Lenient on purpose. A surface that cannot read the catalog must fall back to
 * showing the raw token — which is honest, since raw text is what an
 * unresolvable token delivers — never to an error boundary over a text field or
 * a broadcast composer.
 */
const packSchema = z.object({
  emojis: z
    .array(
      z.object({
        slug: z.string(),
        imageUrl: z.string(),
        lottieUrl: z.string().nullable().catch(null),
        videoUrl: z.string().nullable().catch(null),
        fallback: z.string().nullable().catch(null),
        customEmojiId: z.string().nullable().catch(null),
      }),
    )
    .catch([]),
})
const slotSchema = z.object({
  key: z.string(),
  unicode: z.string(),
  tgEmojiId: z.string().nullable().catch(null),
})
const ownerPremiumSchema = z.object({ ownerHasPremium: z.boolean() })

/**
 * Mirrors the backend's own default (`readOwnerHasPremium`, default `true`) and
 * reiwa's default parameter, so an unreadable settings row degrades the same
 * way on every side instead of inventing a third answer.
 */
export function readOwnerHasPremium(payload: unknown): boolean {
  const parsed = ownerPremiumSchema.safeParse(payload)
  return parsed.success ? parsed.data.ownerHasPremium : true
}

/** The animated forms of a pack entry. Panel-only — they never reach Telegram. */
export interface EmojiArt {
  readonly lottieUrl: string | null
  readonly videoUrl: string | null
}

export interface EmojiCatalog {
  readonly slugs: ReadonlyMap<string, FieldPackEmoji>
  readonly slots: ReadonlyMap<string, FieldSlotEmoji>
  /** Keyed by the raw `:slug:` token, so a rendered part looks itself back up. */
  readonly art: ReadonlyMap<string, EmojiArt>
  readonly ownerHasPremium: boolean
  /**
   * Whether the answer above is an answer at all.
   *
   * Until the queries land every map is empty — and an empty catalog does not
   * read as "still loading" downstream, it reads as "no pack defines this
   * slug", which surfaces mark in destructive styling as "sent as raw text". So
   * a field or a preview would accuse its own correct content of being broken
   * for as long as the fetch took, then quietly correct itself.
   *
   * A false alarm on good content is worse than no alarm: it is how operators
   * learn to read past the red, and the same red flags genuinely dead tokens.
   * Callers therefore draw nothing until this is true. `false` means "nothing
   * to say yet", NOT "nothing is wrong".
   *
   * An error counts as settled — the schemas above are deliberately lenient,
   * and a surface that cannot read the catalog is meant to fall back to raw
   * tokens rather than hide its own content forever.
   */
  readonly ready: boolean
}

export function useEmojiCatalog(): EmojiCatalog {
  const { data: packs, isPending: packsPending } = useQuery<ReadonlyArray<unknown>>({
    queryKey: EMOJI_PACKS_KEY,
    queryFn: async () => expectArray<unknown>((await api.get('/admin/custom-emoji/packs')).data),
    staleTime: 60_000,
  })
  const { data: slots, isPending: slotsPending } = useQuery<ReadonlyArray<unknown>>({
    queryKey: EMOJI_SLOTS_KEY,
    queryFn: async () => expectArray<unknown>((await api.get('/admin/bot-config/emojis')).data),
    staleTime: 60_000,
  })
  const { data: ownerHasPremium, isPending: premiumPending } = useQuery<boolean>({
    queryKey: EMOJI_OWNER_PREMIUM_KEY,
    queryFn: async () =>
      readOwnerHasPremium((await api.get('/admin/bot-config/emoji-studio')).data),
    staleTime: 5 * 60_000,
  })

  // All three are gated, not just the packs: the premium flag decides picture
  // versus carrier glyph, so answering it early draws the wrong one and then
  // corrects itself. The three run in parallel off one cache, so waiting for
  // all of them costs the slowest, not the sum.
  const ready = !packsPending && !slotsPending && !premiumPending

  return useMemo(() => {
    const slugMap = new Map<string, FieldPackEmoji>()
    const artMap = new Map<string, EmojiArt>()
    for (const pack of packs ?? []) {
      const parsed = packSchema.safeParse(pack)
      if (!parsed.success) continue
      for (const emoji of parsed.data.emojis) {
        slugMap.set(emoji.slug, emoji)
        artMap.set(`:${emoji.slug}:`, { lottieUrl: emoji.lottieUrl, videoUrl: emoji.videoUrl })
      }
    }
    const slotMap = new Map<string, FieldSlotEmoji>()
    for (const slot of slots ?? []) {
      const parsed = slotSchema.safeParse(slot)
      if (parsed.success) slotMap.set(parsed.data.key, parsed.data)
    }
    return {
      slugs: slugMap,
      slots: slotMap,
      art: artMap,
      ownerHasPremium: ownerHasPremium ?? true,
      ready,
    }
  }, [packs, slots, ownerHasPremium, ready])
}
