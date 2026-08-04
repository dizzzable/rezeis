import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

import type { LandingTheme } from './landing-builder-api'
import {
  LANDING_THEME_PRESETS,
  applyThemePreset,
  isPresetApplied,
  preserveFont,
  type LandingThemePreset,
} from './theme-presets'

/**
 * ThemeGallery — pick a look in one click, without touching the content.
 *
 * Two behaviours make browsing safe:
 *
 *  - **Applying a preset replaces only `theme`.** Sections are passed through
 *    untouched by the caller, so trying on a look can never eat the copy.
 *  - **Manual tweaks are remembered per preset for the session.** Apply a
 *    preset, hand-adjust a colour, wander off to compare another, come back —
 *    and the adjusted variant returns rather than the pristine one. Without
 *    this, "browse the gallery and come back" silently discards the tweak; it
 *    is the failure Squarespace shipped and had to document.
 *  - **Typography is not a look.** The font belongs to the landing, is set in
 *    Settings, and no preset names one — so it crosses every tile click
 *    untouched instead of being replaced by an empty value.
 *
 * The memory is deliberately session-scoped (a ref, not the config): persisting
 * per-preset variants would mean a schema change, and the scenario it protects
 * — comparing looks side by side — happens inside a single sitting. Undo still
 * covers everything else, so nothing here is a one-way door.
 */
interface Props {
  theme: LandingTheme
  onApply: (theme: LandingTheme) => void
}

export function ThemeGallery({ theme, onApply }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [mood, setMood] = useState<'all' | 'dark' | 'light'>('all')
  /**
   * presetId → the operator's edited variant of that preset, this session.
   * A ref rather than state: it is written and read only inside the click
   * handler, never during render, so it must not drive re-rendering.
   */
  const tweaks = useRef(new Map<string, LandingTheme>())
  /** Which tile stays lit once the theme has been hand-tweaked away from it. */
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null)

  // An exact match wins: it is derived from the theme itself and survives a
  // reload, where the selection state does not.
  const pristine = LANDING_THEME_PRESETS.find((preset) => isPresetApplied(theme, preset))
  const currentId = pristine?.id ?? selectedPresetId

  const apply = (preset: LandingThemePreset): void => {
    // Leaving a preset the operator has since hand-adjusted: keep their version
    // so coming back restores it instead of the catalog default.
    if (currentId !== null && currentId !== preset.id && pristine === undefined) {
      tweaks.current.set(currentId, structuredClone(theme))
    }
    const remembered = tweaks.current.get(preset.id)
    setSelectedPresetId(preset.id)
    // The font rides across every tile click: it is chosen in Settings, for the
    // landing rather than for a look, and the gallery has no opinion to replace
    // it with. Without this, browsing the catalog quietly reverted it.
    const next = remembered === undefined ? applyThemePreset(preset) : structuredClone(remembered)
    onApply(preserveFont(next, theme))
  }

  const visible = LANDING_THEME_PRESETS.filter((preset) => {
    if (mood !== 'all' && preset.mood !== mood) return false
    const q = query.trim().toLowerCase()
    return q.length === 0 || preset.name.toLowerCase().includes(q)
  })

  const label = (key: string): string =>
    t(`landingBuilderPage.gallery.${key}`, { defaultValue: key })

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={label('search')}
          aria-label={label('search')}
          className="h-8 w-44"
        />
        {(['all', 'dark', 'light'] as const).map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={mood === value ? 'default' : 'outline'}
            onClick={() => setMood(value)}
          >
            {label(`mood_${value}`)}
          </Button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="text-xs text-muted-foreground">{label('empty')}</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {visible.map((preset) => {
            const isCurrent = currentId === preset.id
            const colors = preset.theme.colors ?? {}
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => apply(preset)}
                aria-pressed={isCurrent}
                className={`group relative overflow-hidden rounded-md border p-0 text-left transition hover:border-primary ${
                  isCurrent ? 'border-primary ring-1 ring-primary' : 'border-border/60'
                }`}
              >
                <span
                  className="flex h-16 w-full items-end gap-1 p-2"
                  style={{ background: colors.bg ?? '#0a0a0a' }}
                  aria-hidden
                >
                  {(preset.theme.backgroundColors ?? []).slice(0, 4).map((swatch, index) => (
                    <span
                      key={index}
                      className="h-3 w-3 rounded-full border border-black/20"
                      style={{ background: swatch }}
                    />
                  ))}
                  <span
                    className="ml-auto h-5 w-5 rounded-full"
                    style={{ background: colors.primary ?? '#22c55e' }}
                  />
                </span>
                <span className="flex items-center gap-1 px-2 py-1.5">
                  <span className="truncate text-xs font-medium">{preset.name}</span>
                  {isCurrent && <Check className="ml-auto h-3 w-3 shrink-0 text-primary" aria-hidden />}
                </span>
              </button>
            )
          })}
        </div>
      )}

      <p className="text-xs text-muted-foreground">{label('hint')}</p>
    </div>
  )
}

