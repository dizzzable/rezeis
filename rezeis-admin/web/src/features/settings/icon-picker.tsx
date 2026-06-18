/**
 * IconPicker — reusable glyph picker used by the plan form and add-on form.
 *
 * Shows an "Auto" (null) option, the built-in lucide set, then the operator's
 * uploaded custom icons. A custom icon is stored on the entity's `icon` field
 * as `custom:<id>`; built-in icons store their lucide key; `null` falls back to
 * a type-derived default at render time.
 */

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { PLAN_ICON_OPTIONS } from '@/features/plans/plan-icon-options'
import { EmojiPicker } from '@/features/broadcast/emoji-picker'
import { EmojiIconView } from '@/features/custom-emoji/emoji-icon-view'

import { CUSTOM_ICONS_QUERY_KEY, getCustomIcons } from './custom-icons-api'
import { CustomIconView } from './custom-icon-view'

/** Prefix marking an `icon` value as a reference to a custom uploaded icon. */
export const CUSTOM_ICON_PREFIX = 'custom:'

/** Set of built-in Lucide preset keys, for fast emoji-vs-preset detection. */
const PRESET_KEYS = new Set(PLAN_ICON_OPTIONS.map((o) => o.key))

/**
 * `true` when an icon value is an emoji (a Unicode glyph or a `:slug:`
 * custom-pack shortcode) rather than a Lucide preset key, a `custom:<id>`
 * uploaded icon, or null ("Auto").
 */
export function isEmojiIcon(value: string | null): value is string {
  return value !== null && value.length > 0 && !value.startsWith(CUSTOM_ICON_PREFIX) && !PRESET_KEYS.has(value)
}

interface IconPickerProps {
  /** Current value: a lucide key, `custom:<id>`, or null ("Auto"). */
  value: string | null
  onChange: (value: string | null) => void
  /** Label for the "Auto" option (e.g. "type-derived default"). */
  autoLabel: string
}

export function IconPicker({ value, onChange, autoLabel }: IconPickerProps) {
  const { t } = useTranslation()
  const { data: customIcons } = useQuery({
    queryKey: CUSTOM_ICONS_QUERY_KEY,
    queryFn: getCustomIcons,
    staleTime: 60_000,
  })

  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() => onChange(null)}
        aria-label={autoLabel}
        title={autoLabel}
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-lg border text-[10px] font-medium text-muted-foreground transition-all',
          value === null ? 'border-primary ring-2 ring-primary/40' : 'border-border hover:border-primary/40',
        )}
      >
        {t('iconPicker.auto')}
      </button>
      {PLAN_ICON_OPTIONS.map(({ key, Icon }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          aria-label={key}
          title={key}
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-lg border transition-all',
            value === key
              ? 'border-primary bg-primary/10 text-primary ring-2 ring-primary/40'
              : 'border-border text-muted-foreground hover:border-primary/40',
          )}
        >
          <Icon className="h-4 w-4" />
        </button>
      ))}
      {(customIcons ?? []).map((custom) => {
        const iconValue = `${CUSTOM_ICON_PREFIX}${custom.id}`
        return (
          <button
            key={iconValue}
            type="button"
            onClick={() => onChange(iconValue)}
            aria-label={custom.name}
            title={custom.name}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-lg border transition-all',
              value === iconValue
                ? 'border-primary bg-primary/10 ring-2 ring-primary/40'
                : 'border-border hover:border-primary/40',
            )}
          >
            <CustomIconView url={custom.url} color={custom.color} className="h-4 w-4" />
          </button>
        )
      })}

      {/* Emoji cell — hosts the emoji picker (standard + custom packs). When an
          emoji is currently selected, its real glyph/animation overlays the
          trigger (pointer-events-none so a click still opens the picker). */}
      <div
        className={cn(
          'relative flex h-9 w-9 items-center justify-center rounded-lg border transition-all',
          isEmojiIcon(value) ? 'border-primary bg-primary/10 ring-2 ring-primary/40' : 'border-border hover:border-primary/40',
        )}
        title={t('iconPicker.emoji')}
      >
        <EmojiPicker onSelect={(emoji) => onChange(emoji)} ariaLabel={t('iconPicker.emoji')} />
        {isEmojiIcon(value) && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-lg">
            <EmojiIconView value={value} className="h-6 w-6" />
          </div>
        )}
      </div>
    </div>
  )
}
