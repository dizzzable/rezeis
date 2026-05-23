import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from 'recharts'
import {
  Check,
  Clipboard,
  Monitor,
  Moon,
  Palette,
  RotateCcw,
  Sparkles,
  Sun,
} from 'lucide-react'
import { toast } from 'sonner'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { cn } from '@/lib/utils'
import { FadeIn, HoverLift } from '@/lib/motion'

import {
  TOKEN_LABELS,
  TOKEN_SECTIONS,
  useThemeStore,
  type ColorMode,
  type ThemeToken,
} from '@/lib/theme/theme-store'
import { useTheme } from '@/lib/theme/theme-provider'
import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { THEME_PRESETS } from '@/lib/theme/presets'

import { SavedThemesCard } from './saved-themes-card'
import { GlassSettingsCard } from './glass-settings-card'
import { EffectsSettingsCard } from './effects-settings-card'

// ──────────────────────────────────────────────────────────────────────────────
// AppearancePage
// ──────────────────────────────────────────────────────────────────────────────
export default function AppearancePage() {
  const { t } = useTranslation()
  const reset = useThemeStore((s) => s.reset)

  const handleReset = (): void => {
    reset()
    toast.success(t('appearancePage.resetSuccess'))
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
              <Palette className="h-6 w-6" /> {t('appearancePage.title')}
            </h1>
            <p className="text-muted-foreground">{t('appearancePage.subtitle')}</p>
          </div>
          <Button variant="outline" size="sm" onClick={handleReset}>
            <RotateCcw className="mr-2 h-4 w-4" /> {t('appearancePage.reset')}
          </Button>
        </div>
      </FadeIn>

      <Tabs defaultValue="presets" className="space-y-4">
        <TabsList className="flex-wrap">
          <TabsTrigger value="presets">{t('appearancePage.tabs.presets')}</TabsTrigger>
          <TabsTrigger value="customize">{t('appearancePage.tabs.customize')}</TabsTrigger>
          <TabsTrigger value="saved">{t('appearancePage.tabs.saved')}</TabsTrigger>
          <TabsTrigger value="paste">{t('appearancePage.tabs.paste')}</TabsTrigger>
          <TabsTrigger value="layout">{t('appearancePage.tabs.layout')}</TabsTrigger>
          <TabsTrigger value="effects">{t('appearancePage.tabs.effects')}</TabsTrigger>
          <TabsTrigger value="preview">{t('appearancePage.tabs.preview')}</TabsTrigger>
        </TabsList>

        <TabsContent value="presets" className="space-y-4">
          <ModeCard />
          <PresetsCard />
          <RadiusCard />
        </TabsContent>

        <TabsContent value="customize" className="space-y-4">
          <ModeCard />
          <ColorEditorCard />
          <RadiusCard />
        </TabsContent>

        <TabsContent value="saved" className="space-y-4">
          <SavedThemesCard />
        </TabsContent>

        <TabsContent value="paste" className="space-y-4">
          <PasteThemeCard />
        </TabsContent>

        <TabsContent value="layout" className="space-y-4">
          <LayoutTabContent />
        </TabsContent>

        <TabsContent value="effects" className="space-y-4">
          <GlassSettingsCard />
          <EffectsSettingsCard />
        </TabsContent>

        <TabsContent value="preview" className="space-y-4">
          <PreviewCard />
          <ChartPreviewCard />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Mode card — light / dark / system
// ──────────────────────────────────────────────────────────────────────────────
function ModeCard() {
  const { t } = useTranslation()
  const mode = useThemeStore((s) => s.mode)
  const setMode = useThemeStore((s) => s.setMode)

  const options: Array<{ id: ColorMode; labelKey: string; icon: typeof Sun }> = [
    { id: 'light', labelKey: 'appearancePage.mode.light', icon: Sun },
    { id: 'dark', labelKey: 'appearancePage.mode.dark', icon: Moon },
    { id: 'system', labelKey: 'appearancePage.mode.system', icon: Monitor },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('appearancePage.mode.title')}</CardTitle>
        <CardDescription>{t('appearancePage.mode.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-3">
          {options.map((opt) => {
            const selected = mode === opt.id
            return (
              <HoverLift key={opt.id}>
                <button
                  type="button"
                  onClick={(): void => setMode(opt.id)}
                  className={cn(
                    'flex w-full flex-col items-center gap-2 rounded-lg border p-4 transition-colors',
                    selected
                      ? 'border-primary bg-primary/5'
                      : 'hover:border-primary/40',
                  )}
                >
                  <opt.icon
                    className={cn('h-5 w-5', selected && 'text-primary')}
                  />
                  <span className="text-sm font-medium">{t(opt.labelKey)}</span>
                  {selected && (
                    <Badge variant="default" className="text-xs">
                      {t('appearancePage.mode.selected')}
                    </Badge>
                  )}
                </button>
              </HoverLift>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Presets card — choose a curated palette
// ──────────────────────────────────────────────────────────────────────────────
function PresetsCard() {
  const { t } = useTranslation()
  const presetId = useThemeStore((s) => s.presetId)
  const setPreset = useThemeStore((s) => s.setPreset)
  const clearOverrides = useThemeStore((s) => s.clearOverrides)

  const handlePick = (id: string): void => {
    setPreset(id)
    // Clear overrides when switching presets so the new preset shows pure.
    clearOverrides('light')
    clearOverrides('dark')
    toast.success(t('appearancePage.presets.applied', { id }))
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('appearancePage.presets.title')}</CardTitle>
        <CardDescription>{t('appearancePage.presets.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {THEME_PRESETS.map((preset) => {
            const selected = presetId === preset.id
            return (
              <HoverLift key={preset.id}>
                <button
                  type="button"
                  onClick={(): void => handlePick(preset.id)}
                  className={cn(
                    'w-full rounded-lg border p-4 text-left transition-colors',
                    selected
                      ? 'border-primary bg-primary/5'
                      : 'hover:border-primary/40',
                  )}
                >
                  <div className="mb-3 flex items-center justify-between">
                    <div
                      className="h-8 w-8 rounded-full border"
                      style={{ backgroundColor: preset.swatch }}
                    />
                    {selected && <Check className="h-4 w-4 text-primary" />}
                  </div>
                  <p className="text-sm font-semibold">{preset.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {preset.description}
                  </p>
                </button>
              </HoverLift>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Radius card
// ──────────────────────────────────────────────────────────────────────────────
function RadiusCard() {
  const { t } = useTranslation()
  const radius = useThemeStore((s) => s.radius)
  const setRadius = useThemeStore((s) => s.setRadius)

  const presets = [0, 0.25, 0.5, 0.625, 1]

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('appearancePage.radius.title')}</CardTitle>
        <CardDescription>{t('appearancePage.radius.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <Label>{t('appearancePage.radius.label')}</Label>
          <span className="font-mono text-sm text-muted-foreground">
            {radius.toFixed(3)}rem
          </span>
        </div>
        <Slider
          value={[radius]}
          min={0}
          max={1.5}
          step={0.025}
          onValueChange={(v: number[]): void => setRadius(v[0] ?? 0.5)}
        />
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <Button
              key={p}
              size="sm"
              variant={Math.abs(radius - p) < 0.01 ? 'default' : 'outline'}
              onClick={(): void => setRadius(p)}
            >
              {p === 0 ? '0' : `${p}rem`}
            </Button>
          ))}
        </div>
        <Separator />
        <div className="flex items-center gap-3">
          <span className="w-20 text-sm text-muted-foreground">
            {t('appearancePage.radius.previewLabel')}
          </span>
          <div
            className="h-10 w-10 bg-primary"
            style={{ borderRadius: `${radius}rem` }}
          />
          <div
            className="h-10 w-24 border"
            style={{ borderRadius: `${radius}rem` }}
          />
          <div
            className="flex h-10 items-center bg-secondary px-4 text-sm font-medium"
            style={{ borderRadius: `${radius}rem` }}
          >
            {t('appearancePage.radius.previewButton')}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Color editor
// ──────────────────────────────────────────────────────────────────────────────
function ColorEditorCard() {
  const { t } = useTranslation()
  const { resolvedMode } = useTheme()
  const setMode = useThemeStore((s) => s.setMode)
  const overridesLight = useThemeStore((s) => s.overridesLight)
  const overridesDark = useThemeStore((s) => s.overridesDark)
  const setOverride = useThemeStore((s) => s.setOverride)
  const clearOverrides = useThemeStore((s) => s.clearOverrides)

  const [editorMode, setEditorMode] = useState<'light' | 'dark'>(resolvedMode)

  // Keep the edited mode in sync with the active mode the first time the
  // user lands on this tab so the picker always shows what they see.
  useEffect((): void => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- TODO: refactor to derive state
    setEditorMode(resolvedMode)
  }, [resolvedMode])

  const overrides =
    editorMode === 'dark' ? overridesDark : overridesLight

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5" /> {t('appearancePage.customize.title')}
              <Badge variant="outline" className="ml-1">
                {t('appearancePage.customize.modeBadge', {
                  mode:
                    editorMode === 'dark'
                      ? t('appearancePage.customize.modeDark')
                      : t('appearancePage.customize.modeLight'),
                })}
              </Badge>
            </CardTitle>
            <CardDescription>
              {t('appearancePage.customize.description')}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md border p-0.5">
              <button
                type="button"
                onClick={(): void => {
                  setEditorMode('light')
                  // Switch the live theme too so previews match what we edit.
                  setMode('light')
                }}
                className={cn(
                  'rounded-sm px-3 py-1 text-xs font-medium transition-colors',
                  editorMode === 'light'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Sun className="mr-1 inline h-3 w-3" /> {t('appearancePage.customize.modeLight')}
              </button>
              <button
                type="button"
                onClick={(): void => {
                  setEditorMode('dark')
                  setMode('dark')
                }}
                className={cn(
                  'rounded-sm px-3 py-1 text-xs font-medium transition-colors',
                  editorMode === 'dark'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Moon className="mr-1 inline h-3 w-3" /> {t('appearancePage.customize.modeDark')}
              </button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={(): void => clearOverrides(editorMode)}
            >
              <RotateCcw className="mr-2 h-4 w-4" /> {t('appearancePage.customize.clear')}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {TOKEN_SECTIONS.map((section) => (
          <div key={section.id} className="space-y-3">
            <div>
              <p className="text-sm font-semibold">
                {t(`appearancePage.sections.${section.id}.label`, section.label)}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(
                  `appearancePage.sections.${section.id}.description`,
                  section.description,
                )}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {section.tokens.map((token) => (
                <ColorField
                  key={token}
                  token={token}
                  override={overrides[token]}
                  onChange={(value: string | undefined): void =>
                    setOverride(editorMode, token, value)
                  }
                />
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

interface ColorFieldProps {
  readonly token: ThemeToken
  readonly override: string | undefined
  readonly onChange: (value: string | undefined) => void
}

function ColorField({ token, override, onChange }: ColorFieldProps) {
  const { t } = useTranslation()
  const computed = useComputedColor(token)
  const displayValue = override ?? computed
  const label = t(`appearancePage.tokens.${token}`, TOKEN_LABELS[token])

  // The live preview swatch always shows the *effective* color via
  // `var(--token)` so users see exactly what the rest of the app sees.
  return (
    <div className="flex items-center gap-3 rounded-md border p-3">
      <label className="relative flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded border">
        <span
          className="absolute inset-0"
          style={{ backgroundColor: `var(--${token})` }}
        />
        <input
          type="color"
          value={cssColorToHex(displayValue)}
          onChange={(e): void => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label={label}
        />
      </label>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{label}</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {displayValue || '—'}
        </p>
      </div>
      {override !== undefined && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={t('appearancePage.customize.reset', { name: label })}
          onClick={(): void => onChange(undefined)}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}

/**
 * Read the resolved value of a CSS variable from the document so users
 * can see what the active preset assigns to a token even when no
 * override is set.
 */
function useComputedColor(token: ThemeToken): string {
  const presetId = useThemeStore((s) => s.presetId)
  const customCss = useThemeStore((s) => s.customCss)
  const overridesLight = useThemeStore((s) => s.overridesLight)
  const overridesDark = useThemeStore((s) => s.overridesDark)
  const radius = useThemeStore((s) => s.radius)
  const [value, setValue] = useState<string>('')

  useEffect((): (() => void) | void => {
    if (typeof window === 'undefined') return
    // Defer one frame so the runtime stylesheet has been written first.
    const id = window.requestAnimationFrame((): void => {
      const computed = window
        .getComputedStyle(document.documentElement)
        .getPropertyValue(`--${token}`)
        .trim()
      setValue(computed)
    })
    return (): void => window.cancelAnimationFrame(id)
    // We deliberately re-read on any theme-store change.
  }, [token, presetId, customCss, overridesLight, overridesDark, radius])

  return value
}

/**
 * Best-effort conversion of any CSS color (oklch / rgb / hsl / hex /
 * named) to a `#RRGGBB` hex string the native color picker can show.
 *
 * Uses a hidden DOM element + getComputedStyle so the browser does the
 * heavy lifting — works for every CSS color format the platform
 * understands, including oklch().
 */
function cssColorToHex(value: string): string {
  if (typeof window === 'undefined') return '#000000'
  const trimmed = (value ?? '').trim()
  if (trimmed.length === 0) return '#000000'
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed
  const probe = document.createElement('div')
  probe.style.color = trimmed
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const computed = window.getComputedStyle(probe).color
  document.body.removeChild(probe)
  const match = computed.match(/rgba?\(([^)]+)\)/i)
  if (!match) return '#000000'
  const parts = match[1].split(',').map((p) => p.trim())
  const r = Math.max(0, Math.min(255, Math.round(Number(parts[0] ?? 0))))
  const g = Math.max(0, Math.min(255, Math.round(Number(parts[1] ?? 0))))
  const b = Math.max(0, Math.min(255, Math.round(Number(parts[2] ?? 0))))
  return `#${[r, g, b]
    .map((n): string => n.toString(16).padStart(2, '0'))
    .join('')}`
}

// ──────────────────────────────────────────────────────────────────────────────
// Paste theme card
// ──────────────────────────────────────────────────────────────────────────────
function PasteThemeCard() {
  const { t } = useTranslation()
  const customCss = useThemeStore((s) => s.customCss)
  const setCustomCss = useThemeStore((s) => s.setCustomCss)

  const onPasteFromClipboard = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText()
      if (text.trim().length === 0) {
        toast.error(t('appearancePage.paste.clipboardEmpty'))
        return
      }
      setCustomCss(text)
      toast.success(t('appearancePage.paste.pasted'))
    } catch {
      toast.error(t('appearancePage.paste.clipboardError'))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('appearancePage.paste.title')}</CardTitle>
        <CardDescription>{t('appearancePage.paste.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <textarea
          spellCheck={false}
          rows={16}
          value={customCss}
          onChange={(e): void => setCustomCss(e.target.value)}
          placeholder={`:root {\n  --background: oklch(1 0 0);\n  --primary: oklch(0.205 0 0);\n  /* … */\n}\n\n.dark {\n  --background: oklch(0.145 0 0);\n  /* … */\n}`}
          className="block w-full rounded-md border border-input bg-background p-3 font-mono text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
        <div className="flex flex-wrap gap-2">
          <Button onClick={onPasteFromClipboard}>
            <Clipboard className="mr-2 h-4 w-4" /> {t('appearancePage.paste.pasteFromClipboard')}
          </Button>
          <Button
            variant="outline"
            onClick={(): void => {
              setCustomCss('')
              toast.success(t('appearancePage.paste.cleared'))
            }}
            disabled={customCss.length === 0}
          >
            <RotateCcw className="mr-2 h-4 w-4" /> {t('appearancePage.paste.clear')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('appearancePage.paste.footer')}
        </p>
      </CardContent>
    </Card>
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Layout — density / font size / animations
// ──────────────────────────────────────────────────────────────────────────────
function LayoutTabContent() {
  const { t } = useTranslation()
  const density = useAppearanceStore((s) => s.density)
  const fontSize = useAppearanceStore((s) => s.fontSize)
  const animationsEnabled = useAppearanceStore((s) => s.animationsEnabled)
  const setDensity = useAppearanceStore((s) => s.setDensity)
  const setFontSize = useAppearanceStore((s) => s.setFontSize)
  const setAnimationsEnabled = useAppearanceStore(
    (s) => s.setAnimationsEnabled,
  )

  const densityOptions: ReadonlyArray<{ id: 'compact' | 'comfortable' | 'spacious'; key: string }> = [
    { id: 'compact', key: 'appearancePage.layout.density.compact' },
    { id: 'comfortable', key: 'appearancePage.layout.density.comfortable' },
    { id: 'spacious', key: 'appearancePage.layout.density.spacious' },
  ]

  const fontOptions: ReadonlyArray<{ id: 'small' | 'default' | 'large'; key: string }> = [
    { id: 'small', key: 'appearancePage.layout.fontSize.small' },
    { id: 'default', key: 'appearancePage.layout.fontSize.default' },
    { id: 'large', key: 'appearancePage.layout.fontSize.large' },
  ]

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('appearancePage.layout.density.title')}</CardTitle>
          <CardDescription>{t('appearancePage.layout.density.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3">
            {densityOptions.map((opt) => {
              const selected = density === opt.id
              return (
                <HoverLift key={opt.id}>
                  <button
                    type="button"
                    onClick={(): void => setDensity(opt.id)}
                    className={cn(
                      'flex w-full flex-col items-center gap-2 rounded-lg border p-4 capitalize transition-colors',
                      selected
                        ? 'border-primary bg-primary/5'
                        : 'hover:border-primary/40',
                    )}
                  >
                    <span className="text-sm font-medium">{t(opt.key)}</span>
                    {selected && (
                      <Badge variant="default" className="text-xs">
                        {t('appearancePage.layout.selected')}
                      </Badge>
                    )}
                  </button>
                </HoverLift>
              )
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('appearancePage.layout.fontSize.title')}</CardTitle>
          <CardDescription>{t('appearancePage.layout.fontSize.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3">
            {fontOptions.map((opt) => {
              const selected = fontSize === opt.id
              return (
                <HoverLift key={opt.id}>
                  <button
                    type="button"
                    onClick={(): void => setFontSize(opt.id)}
                    className={cn(
                      'flex w-full flex-col items-center gap-2 rounded-lg border p-4 capitalize transition-colors',
                      selected
                        ? 'border-primary bg-primary/5'
                        : 'hover:border-primary/40',
                    )}
                  >
                    <span className="text-sm font-medium">{t(opt.key)}</span>
                    {selected && (
                      <Badge variant="default" className="text-xs">
                        {t('appearancePage.layout.selected')}
                      </Badge>
                    )}
                  </button>
                </HoverLift>
              )
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('appearancePage.layout.motion.title')}</CardTitle>
          <CardDescription>{t('appearancePage.layout.motion.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <Label htmlFor="animations-toggle" className="cursor-pointer">
            {t('appearancePage.layout.motion.toggleLabel')}
          </Label>
          <Switch
            id="animations-toggle"
            checked={animationsEnabled}
            onCheckedChange={setAnimationsEnabled}
          />
        </CardContent>
      </Card>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Component preview
// ──────────────────────────────────────────────────────────────────────────────
function PreviewCard() {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('appearancePage.preview.title')}</CardTitle>
        <CardDescription>{t('appearancePage.preview.description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <p className="text-sm font-semibold">{t('appearancePage.preview.buttons')}</p>
          <div className="flex flex-wrap gap-2">
            <Button>{t('appearancePage.preview.buttonPrimary')}</Button>
            <Button variant="secondary">{t('appearancePage.preview.buttonSecondary')}</Button>
            <Button variant="outline">{t('appearancePage.preview.buttonOutline')}</Button>
            <Button variant="ghost">{t('appearancePage.preview.buttonGhost')}</Button>
            <Button variant="destructive">{t('appearancePage.preview.buttonDestructive')}</Button>
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-sm font-semibold">{t('appearancePage.preview.badges')}</p>
          <div className="flex flex-wrap gap-2">
            <Badge>{t('appearancePage.preview.badgeDefault')}</Badge>
            <Badge variant="secondary">{t('appearancePage.preview.badgeSecondary')}</Badge>
            <Badge variant="outline">{t('appearancePage.preview.badgeOutline')}</Badge>
            <Badge variant="destructive">{t('appearancePage.preview.badgeDestructive')}</Badge>
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-sm font-semibold">{t('appearancePage.preview.card')}</p>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('appearancePage.preview.cardSampleTitle')}</CardTitle>
              <CardDescription>
                {t('appearancePage.preview.cardSampleDescription')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {t('appearancePage.preview.cardSampleBody')}
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-3">
          <p className="text-sm font-semibold">{t('appearancePage.preview.formControls')}</p>
          <div className="space-y-2">
            <Label>{t('appearancePage.preview.emailLabel')}</Label>
            <input
              type="email"
              placeholder={t('appearancePage.preview.emailPlaceholder')}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          <div className="flex gap-2">
            <Button className="flex-1">{t('appearancePage.preview.submit')}</Button>
            <Button variant="outline">{t('appearancePage.preview.cancel')}</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Chart preview — uses the chart-1 ... chart-5 tokens from the active theme
// ──────────────────────────────────────────────────────────────────────────────
const CHART_DATA = [
  { name: 'Mon', a: 12, b: 8, c: 5 },
  { name: 'Tue', a: 18, b: 11, c: 7 },
  { name: 'Wed', a: 9, b: 14, c: 4 },
  { name: 'Thu', a: 21, b: 9, c: 11 },
  { name: 'Fri', a: 16, b: 18, c: 8 },
  { name: 'Sat', a: 24, b: 22, c: 13 },
  { name: 'Sun', a: 30, b: 17, c: 16 },
]

function ChartPreviewCard() {
  const { t } = useTranslation()
  const barConfig: ChartConfig = {
    a: { label: t('appearancePage.chartPreview.seriesA'), color: 'var(--chart-1)' },
    b: { label: t('appearancePage.chartPreview.seriesB'), color: 'var(--chart-2)' },
    c: { label: t('appearancePage.chartPreview.seriesC'), color: 'var(--chart-3)' },
  }
  const lineConfig: ChartConfig = {
    a: { label: t('appearancePage.chartPreview.activeUsers'), color: 'var(--chart-4)' },
    b: { label: t('appearancePage.chartPreview.newSignups'), color: 'var(--chart-5)' },
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('appearancePage.chartPreview.title')}</CardTitle>
        <CardDescription>{t('appearancePage.chartPreview.description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <p className="text-sm font-semibold">{t('appearancePage.chartPreview.bar')}</p>
          <ChartContainer
            config={barConfig}
            className="aspect-video w-full min-h-[220px]"
          >
            <BarChart data={CHART_DATA} accessibilityLayer>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="name"
                tickLine={false}
                axisLine={false}
                stroke="var(--muted-foreground)"
                fontSize={12}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                stroke="var(--muted-foreground)"
                fontSize={12}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="a" fill="var(--color-a)" radius={4} />
              <Bar dataKey="b" fill="var(--color-b)" radius={4} />
              <Bar dataKey="c" fill="var(--color-c)" radius={4} />
            </BarChart>
          </ChartContainer>
        </div>

        <div className="space-y-3">
          <p className="text-sm font-semibold">{t('appearancePage.chartPreview.line')}</p>
          <ChartContainer
            config={lineConfig}
            className="aspect-video w-full min-h-[220px]"
          >
            <LineChart data={CHART_DATA} accessibilityLayer>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="name"
                tickLine={false}
                axisLine={false}
                stroke="var(--muted-foreground)"
                fontSize={12}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                stroke="var(--muted-foreground)"
                fontSize={12}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Line
                dataKey="a"
                type="monotone"
                stroke="var(--color-a)"
                strokeWidth={2}
                dot={false}
              />
              <Line
                dataKey="b"
                type="monotone"
                stroke="var(--color-b)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ChartContainer>
        </div>
      </CardContent>
    </Card>
  )
}
