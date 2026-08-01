/**
 * PlanIconView — single source of truth for rendering a `Plan.icon` value.
 *
 * Mirrors the reiwa cabinet's tariff-card icon resolution (see reiwa
 * `plan-icons.tsx` / `tariff-card.tsx`) so admin previews render exactly what
 * the cabinet shows. A `Plan.icon` can be one of:
 *   • a built-in Lucide preset key (e.g. `zap`)           → the lucide glyph
 *   • a `custom:<id>` uploaded icon                       → CustomIconView
 *   • a `:slug:` custom-pack emoji OR a unicode glyph     → EmojiIconView
 *   • null / unknown                                      → the fallback glyph
 *
 * Centralising this prevents the call sites from drifting (one used a bare
 * `!!icon` check, the other a regex) and from rendering raw `:slug:` text.
 */

import { createElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Sparkles, type LucideIcon } from 'lucide-react'

import { EmojiIconView } from '@/features/custom-emoji/emoji-icon-view'
import { CustomIconView } from '@/features/settings/custom-icon-view'
import { CUSTOM_ICONS_QUERY_KEY, getCustomIcons } from '@/features/settings/custom-icons-api'

import { PLAN_ICON_OPTIONS } from './plan-icon-options'

const CUSTOM_ICON_PREFIX = 'custom:'
const PRESET_MAP = new Map<string, LucideIcon>(PLAN_ICON_OPTIONS.map((o) => [o.key, o.Icon]))

interface PlanIconViewProps {
  /** The stored `Plan.icon` value: lucide key, `custom:<id>`, emoji, or null. */
  readonly value: string | null | undefined
  /** Sizing/colour classes (lucide glyphs inherit `currentColor`). */
  readonly className?: string
  /** Glyph shown when the value is null / a not-yet-resolved custom icon. */
  readonly fallback?: LucideIcon
}

export function PlanIconView({ value, className, fallback: Fallback = Sparkles }: PlanIconViewProps) {
  const isCustom = typeof value === 'string' && value.startsWith(CUSTOM_ICON_PREFIX)
  // Custom icons resolve `custom:<id>` → asset URL. Shared react-query cache,
  // only fetched when an actual custom-icon value is present.
  const { data: customIcons } = useQuery({
    queryKey: CUSTOM_ICONS_QUERY_KEY,
    queryFn: getCustomIcons,
    staleTime: 60_000,
    enabled: isCustom,
  })

  if (typeof value === 'string' && value.length > 0) {
    // 1) Built-in Lucide preset key.
    const Preset = PRESET_MAP.get(value)
    if (Preset) return createElement(Preset, { className })
    // 2) Uploaded custom icon.
    if (isCustom) {
      const id = value.slice(CUSTOM_ICON_PREFIX.length)
      const custom = (customIcons ?? []).find((c) => c.id === id)
      if (custom) return <CustomIconView url={custom.url} color={custom.color} className={className} />
      return <Fallback className={className} />
    }
    // 3) Emoji — `:slug:` custom-pack (Lottie/img/video) or a unicode glyph.
    return <EmojiIconView value={value} className={className} />
  }

  // 4) No icon configured → fallback glyph (preview parity with the cabinet).
  return <Fallback className={className} />
}
