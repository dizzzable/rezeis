/**
 * DashboardIconsSection — the cabinet's dashboard header controls.
 *
 * Three knobs per icon, and each answers a thing an operator asked for:
 *   - **glyph** — swap the shipped picture (the quests sparkle for a gift box);
 *   - **effect** — pulse, wiggle or glow, to make one icon ask for attention;
 *   - **colour** — the accent that glyph and effect are drawn in.
 *
 * All three are optional per icon and an untouched icon stores nothing, so an
 * install that never opens this block looks exactly as it did.
 *
 * Reordering and hiding icons are deliberately absent: that is the "one
 * console for every icon" idea, which the owner put explicitly after this.
 */

import { useTranslation } from 'react-i18next'
import {
  Bell,
  CircleDot,
  Crown,
  Flame,
  Gem,
  Gift,
  Heart,
  Rocket,
  ShoppingCart,
  Sparkles,
  Star,
  Target,
  TicketPercent,
  Trophy,
  Zap,
} from 'lucide-react'
import type { ComponentType, CSSProperties, SVGProps } from 'react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { BrandingIconDecorDraft } from './branding-form-schema'

// The cabinet's own rules, mirrored byte for byte so this preview shows what
// the subscriber will see rather than something like it. See the file's own
// header, and `icon-effect-css-parity.test.ts` in reiwa, which fails on drift.
import './icon-effects-preview.css'

type Glyph = ComponentType<SVGProps<SVGSVGElement>>

/**
 * The header row, in the order the cabinet renders it. `Icon` is what the
 * cabinet ships for that position — the swatch a `default` glyph shows.
 */
export const DASHBOARD_ICONS: ReadonlyArray<{ key: string; Icon: Glyph; accent: string }> = [
  { key: 'quests', Icon: Sparkles, accent: '#f59e0b' },
  { key: 'wheel', Icon: CircleDot, accent: '#a78bfa' },
  { key: 'bell', Icon: Bell, accent: '#60a5fa' },
  { key: 'buy', Icon: ShoppingCart, accent: '#22c55e' },
  { key: 'promo', Icon: TicketPercent, accent: '#fb7185' },
]

/** Kept in step with `ICON_GLYPHS` in the panel API's branding interface. */
export const GLYPHS: ReadonlyArray<{ key: string; Icon: Glyph | null }> = [
  { key: 'default', Icon: null },
  { key: 'sparkles', Icon: Sparkles },
  { key: 'gift', Icon: Gift },
  { key: 'star', Icon: Star },
  { key: 'trophy', Icon: Trophy },
  { key: 'crown', Icon: Crown },
  { key: 'flame', Icon: Flame },
  { key: 'zap', Icon: Zap },
  { key: 'rocket', Icon: Rocket },
  { key: 'heart', Icon: Heart },
  { key: 'gem', Icon: Gem },
  { key: 'target', Icon: Target },
  { key: 'bell', Icon: Bell },
  { key: 'cart', Icon: ShoppingCart },
  { key: 'ticket', Icon: TicketPercent },
]

/** Kept in step with `ICON_EFFECTS`. */
const EFFECTS = ['none', 'pulse', 'shake', 'glow', 'glint', 'iridescent'] as const

/**
 * Effect name to the class the mirrored CSS defines.
 *
 * The cabinet has the same map in `lib/icon-decor.ts`. Two copies, and the
 * parity test over the CSS covers the rules but not this — so the safety here
 * is that a name with no entry simply previews as no effect, which is visible
 * on screen the moment an operator clicks it.
 */
export const EFFECT_CLASS: Readonly<Record<string, string>> = {
  pulse: 'icon-effect-pulse',
  shake: 'icon-effect-shake',
  glow: 'icon-effect-glow',
  glint: 'icon-effect-glint',
  iridescent: 'icon-effect-iridescent',
}

interface DashboardIconsSectionProps {
  decor: Record<string, BrandingIconDecorDraft>
  onChange: (next: Record<string, BrandingIconDecorDraft>) => void
}

export function DashboardIconsSection({
  decor,
  onChange,
}: DashboardIconsSectionProps): React.JSX.Element {
  const { t } = useTranslation()

  /**
   * Writes one field, and DROPS the icon's entry when nothing is left on it.
   * An icon reset to its defaults must leave no row behind — a stored
   * `{}` would read as "configured" forever, and the operator would have no
   * way to see the difference.
   */
  const set = (key: string, field: keyof BrandingIconDecorDraft, value: string | null) => {
    const current = decor[key] ?? {}
    const next: BrandingIconDecorDraft = { ...current }
    if (value === null) {
      delete (next as Record<string, unknown>)[field]
    } else {
      ;(next as Record<string, unknown>)[field] = value
    }
    const rest = { ...decor }
    if (next.glyph === undefined && next.effect === undefined && next.color === undefined) {
      delete rest[key]
    } else {
      rest[key] = next
    }
    onChange(rest)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('brandingPage.sections.dashboardIcons.title')}</CardTitle>
        <CardDescription>{t('brandingPage.sections.dashboardIcons.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {DASHBOARD_ICONS.map((def) => {
          const entry = decor[def.key] ?? {}
          const chosen = GLYPHS.find((g) => g.key === entry.glyph)
          const Preview = chosen?.Icon ?? def.Icon
          const color = entry.color ?? def.accent
          const effect = entry.effect ?? 'none'
          const touched =
            entry.glyph !== undefined || entry.effect !== undefined || entry.color !== undefined

          return (
            <div key={def.key} className="rounded-lg border border-border/60 p-3">
              <div className="mb-3 flex items-center gap-3">
                {/* The effect runs HERE, live, with the operator's own colour.
                    Two boxes and not one, mirroring the cabinet exactly: the
                    class goes on a wrapper and the colour on the glyph,
                    because a class on the child sets `color` and would beat an
                    inline style on the parent — a tint applied to the wrapper
                    looks right here and does nothing in the cabinet.
                    `--icon-effect-color` rides on the wrapper because a
                    pseudo-element's halo can be handed a colour no other way. */}
                <span
                  className={cn('relative inline-flex shrink-0', EFFECT_CLASS[effect])}
                  style={
                    {
                      '--icon-effect-color': color,
                      // The cabinet's icons are pills; these tiles are squircles,
                      // and the glow would otherwise draw a pill-shaped halo
                      // around a rounded square.
                      '--icon-effect-radius': '0.75rem',
                    } as CSSProperties
                  }
                >
                  <span
                    className="flex h-10 w-10 items-center justify-center rounded-xl"
                    style={{
                      backgroundColor: `color-mix(in oklab, ${color} 12%, transparent)`,
                    }}
                  >
                    <Preview className="h-5 w-5" style={{ color }} />
                  </span>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {t(`brandingPage.sections.dashboardIcons.icons.${def.key}`)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t(`brandingPage.sections.dashboardIcons.effects.${effect}`)}
                  </p>
                </div>
                {touched && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const rest = { ...decor }
                      delete rest[def.key]
                      onChange(rest)
                    }}
                  >
                    {t('brandingPage.sections.dashboardIcons.reset')}
                  </Button>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {t('brandingPage.sections.dashboardIcons.glyphLabel')}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {GLYPHS.map((g) => {
                      const active = (entry.glyph ?? 'default') === g.key
                      const G = g.Icon ?? def.Icon
                      return (
                        <button
                          key={g.key}
                          type="button"
                          aria-pressed={active}
                          aria-label={t(`brandingPage.sections.dashboardIcons.glyphs.${g.key}`)}
                          onClick={() => set(def.key, 'glyph', g.key === 'default' ? null : g.key)}
                          className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-all ${
                            active
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-border text-muted-foreground hover:border-primary/40'
                          }`}
                        >
                          <G className="h-4 w-4" />
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {t('brandingPage.sections.dashboardIcons.effectLabel')}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {EFFECTS.map((e) => (
                      <button
                        key={e}
                        type="button"
                        aria-pressed={(entry.effect ?? 'none') === e}
                        onClick={() => set(def.key, 'effect', e === 'none' ? null : e)}
                        className={`rounded-lg border px-2 py-1.5 text-xs transition-all ${
                          (entry.effect ?? 'none') === e
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:border-primary/40'
                        }`}
                      >
                        {t(`brandingPage.sections.dashboardIcons.effects.${e}`)}
                      </button>
                    ))}
                    <input
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : '#ffffff'}
                      onChange={(ev) => set(def.key, 'color', ev.target.value)}
                      className="h-8 w-12 cursor-pointer rounded-lg border"
                      aria-label={t('brandingPage.sections.dashboardIcons.colorLabel', {
                        icon: t(`brandingPage.sections.dashboardIcons.icons.${def.key}`),
                      })}
                    />
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
