/**
 * IconColorsSection — WEB Reiwa configurator block for the cabinet's menu/section
 * icon colours.
 *
 * Three modes:
 *   - default → each icon keeps its own distinct accent (current look).
 *   - theme   → every icon uses the brand primary colour.
 *   - custom  → operator picks a colour per icon.
 *
 * Controlled by the branding form via `mode` + `colors` props; emits changes
 * through `onModeChange` / `onColorsChange`, which the form persists to
 * `iconColorMode` / `iconColors`.
 */

import { useTranslation } from 'react-i18next'
import {
  Bell,
  BookOpen,
  CircleHelp,
  CreditCard,
  Download,
  Globe,
  MessageSquare,
  Puzzle,
  Shield,
  Tag,
  WalletCards,
} from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'

type IconColorMode = 'default' | 'theme' | 'custom'

interface IconDef {
  key: string
  Icon: ComponentType<SVGProps<SVGSVGElement>>
  /** Default accent (hex) used as the swatch seed in custom mode. */
  accent: string
}

/** Mirrors the cabinet's settings menu icons (settings-page.tsx). */
const ICONS: readonly IconDef[] = [
  { key: 'privacy', Icon: Shield, accent: '#34d399' },
  { key: 'notifications', Icon: Bell, accent: '#60a5fa' },
  { key: 'transactions', Icon: CreditCard, accent: '#fbbf24' },
  { key: 'promocodes', Icon: Tag, accent: '#a78bfa' },
  { key: 'language', Icon: Globe, accent: '#a78bfa' },
  { key: 'support', Icon: MessageSquare, accent: '#22c55e' },
  { key: 'faq', Icon: CircleHelp, accent: '#a1a1aa' },
  { key: 'paymentMethods', Icon: WalletCards, accent: '#38bdf8' },
  { key: 'addons', Icon: Puzzle, accent: '#fb7185' },
  { key: 'install', Icon: Download, accent: '#2dd4bf' },
  { key: 'tutorial', Icon: BookOpen, accent: '#f59e0b' },
]

interface IconColorsSectionProps {
  mode: IconColorMode
  colors: Record<string, string>
  primary: string
  onModeChange: (mode: IconColorMode) => void
  onColorsChange: (colors: Record<string, string>) => void
}

export function IconColorsSection({
  mode,
  colors,
  primary,
  onModeChange,
  onColorsChange,
}: IconColorsSectionProps) {
  const { t } = useTranslation()

  const resolve = (def: IconDef): string => {
    if (mode === 'theme') return primary
    if (mode === 'custom') return colors[def.key] ?? primary
    return def.accent
  }

  const setColor = (key: string, value: string) => {
    onColorsChange({ ...colors, [key]: value })
  }

  const MODES: readonly IconColorMode[] = ['default', 'theme', 'custom']

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('brandingPage.sections.iconColors.title')}</CardTitle>
        <CardDescription>{t('brandingPage.sections.iconColors.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Mode toggle */}
        <div className="grid grid-cols-3 gap-2">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onModeChange(m)}
              className={`rounded-lg border px-2 py-2 text-xs font-medium transition-all ${
                mode === m
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:border-primary/40'
              }`}
            >
              {t(`brandingPage.sections.iconColors.mode_${m}`)}
            </button>
          ))}
        </div>

        {/* Icon preview row (all modes) + per-icon pickers (custom only) */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {ICONS.map((def) => {
            const color = resolve(def)
            return (
              <div
                key={def.key}
                className="flex flex-col items-center gap-1.5 rounded-lg border border-border/60 bg-muted/20 p-2"
              >
                <div
                  className="flex h-9 w-9 items-center justify-center rounded-xl"
                  style={{
                    color,
                    backgroundColor: `color-mix(in oklab, ${color} 12%, transparent)`,
                  }}
                >
                  <def.Icon className="h-5 w-5" />
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {t(`brandingPage.sections.iconColors.icons.${def.key}`)}
                </span>
                {mode === 'custom' && (
                  <input
                    type="color"
                    value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : '#ffffff'}
                    onChange={(e) => setColor(def.key, e.target.value)}
                    className="h-6 w-full cursor-pointer rounded border"
                    aria-label={t(`brandingPage.sections.iconColors.icons.${def.key}`)}
                  />
                )}
              </div>
            )
          })}
        </div>

        {mode !== 'custom' && (
          <p className="text-[11px] text-muted-foreground">
            <Label className="text-[11px]">{t(`brandingPage.sections.iconColors.hint_${mode}`)}</Label>
          </p>
        )}
      </CardContent>
    </Card>
  )
}
