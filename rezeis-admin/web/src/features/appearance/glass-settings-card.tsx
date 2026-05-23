/**
 * Glass Settings Card — two-column Liquid Glass configuration UI.
 *
 * Left column:  Liquid Glass toggle + Per-element frost + Glass properties
 * Right column: Background Studio — dropdown, dynamic controls, live preview, apply
 */
import { useMemo, useState, useCallback } from 'react'
import { Suspense } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import {
  useGlassStore,
  type BackgroundId,
} from '@/lib/theme/glass-store'
import { BG_COMPONENTS } from '@/components/glass/backgrounds'
import {
  BACKGROUND_REGISTRY,
  getBackgroundDef,
  getDefaultProps,
  type ControlDef,
} from '@/features/appearance/background-controls'

// ── Main component ───────────────────────────────────────────────────────────

export function GlassSettingsCard() {
  const { t } = useTranslation()
  const glassEnabled = useGlassStore((s) => s.glassEnabled)
  const setGlassEnabled = useGlassStore((s) => s.setGlassEnabled)
  const reset = useGlassStore((s) => s.reset)

  return (
    <div className="space-y-4">
      {/* Master toggle */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t('glassSettings.title')}</CardTitle>
              <CardDescription>{t('glassSettings.description')}</CardDescription>
            </div>
            <Switch
              id="glass-master-toggle"
              checked={glassEnabled}
              onCheckedChange={setGlassEnabled}
              aria-label={t('glassSettings.masterToggle')}
            />
          </div>
        </CardHeader>
      </Card>

      {glassEnabled && (
        <>
          {/* Two-column layout */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {/* Left column: frost + glass properties */}
            <div className="space-y-4">
              <ElementFrostCard />
              <GlassPropertiesCard />
            </div>

            {/* Right column: Background Studio */}
            <div className="space-y-4">
              <BackgroundStudioCard />
            </div>
          </div>

          {/* Reset */}
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={reset}>
              {t('glassSettings.resetAll')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

// ── Per-element frost ────────────────────────────────────────────────────────

function ElementFrostCard() {
  const { t } = useTranslation()
  const sidebar = useGlassStore((s) => s.sidebar)
  const header = useGlassStore((s) => s.header)
  const cards = useGlassStore((s) => s.cards)
  const modals = useGlassStore((s) => s.modals)
  const tabs = useGlassStore((s) => s.tabs)
  const buttons = useGlassStore((s) => s.buttons)
  const popover = useGlassStore((s) => s.popover)
  const setElementGlass = useGlassStore((s) => s.setElementGlass)

  const elements = [
    { key: 'sidebar' as const, settings: sidebar, label: t('glassSettings.elements.sidebar') },
    { key: 'header' as const, settings: header, label: t('glassSettings.elements.header') },
    { key: 'cards' as const, settings: cards, label: t('glassSettings.elements.cards') },
    { key: 'modals' as const, settings: modals, label: t('glassSettings.elements.modals') },
    { key: 'tabs' as const, settings: tabs, label: t('glassSettings.elements.tabs') },
    { key: 'buttons' as const, settings: buttons, label: t('glassSettings.elements.buttons') },
    { key: 'popover' as const, settings: popover, label: t('glassSettings.elements.popover') },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('glassSettings.frost.title')}</CardTitle>
        <CardDescription>{t('glassSettings.frost.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {elements.map((el, idx) => (
          <div key={el.key}>
            {idx > 0 && <Separator className="mb-5" />}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="font-medium">{el.label}</Label>
                <Switch
                  checked={el.settings.enabled}
                  onCheckedChange={(enabled) => setElementGlass(el.key, { enabled })}
                  aria-label={el.label}
                />
              </div>
              {el.settings.enabled && (
                <div className="space-y-2 pl-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">
                      {t('glassSettings.frost.blurLabel')}
                    </Label>
                    <span className="font-mono text-xs text-muted-foreground">
                      {(el.settings.blur * 100).toFixed(0)}%
                    </span>
                  </div>
                  <Slider
                    value={[el.settings.blur]}
                    min={0}
                    max={0.5}
                    step={0.01}
                    onValueChange={(v: number[]) => setElementGlass(el.key, { blur: v[0] ?? 0.15 })}
                  />
                </div>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

// ── Global glass properties ──────────────────────────────────────────────────

function GlassPropertiesCard() {
  const { t } = useTranslation()
  const displacementScale = useGlassStore((s) => s.displacementScale)
  const aberrationIntensity = useGlassStore((s) => s.aberrationIntensity)
  const elasticity = useGlassStore((s) => s.elasticity)
  const saturation = useGlassStore((s) => s.saturation)
  const setDisplacementScale = useGlassStore((s) => s.setDisplacementScale)
  const setAberrationIntensity = useGlassStore((s) => s.setAberrationIntensity)
  const setElasticity = useGlassStore((s) => s.setElasticity)
  const setSaturation = useGlassStore((s) => s.setSaturation)

  const sliders = [
    {
      label: t('glassSettings.properties.displacement'),
      value: displacementScale,
      setter: setDisplacementScale,
      min: 0, max: 150, step: 5,
      display: `${displacementScale}`,
    },
    {
      label: t('glassSettings.properties.aberration'),
      value: aberrationIntensity,
      setter: setAberrationIntensity,
      min: 0, max: 10, step: 0.5,
      display: `${aberrationIntensity}`,
    },
    {
      label: t('glassSettings.properties.elasticity'),
      value: elasticity,
      setter: setElasticity,
      min: 0, max: 0.5, step: 0.01,
      display: `${(elasticity * 100).toFixed(0)}%`,
    },
    {
      label: t('glassSettings.properties.saturation'),
      value: saturation,
      setter: setSaturation,
      min: 100, max: 200, step: 5,
      display: `${saturation}%`,
    },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('glassSettings.properties.title')}</CardTitle>
        <CardDescription>{t('glassSettings.properties.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {sliders.map((s) => (
          <div key={s.label} className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{s.label}</Label>
              <span className="font-mono text-sm text-muted-foreground">{s.display}</span>
            </div>
            <Slider
              value={[s.value]}
              min={s.min}
              max={s.max}
              step={s.step}
              onValueChange={(v: number[]) => s.setter(v[0] ?? s.value)}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

// ── Background Studio ────────────────────────────────────────────────────────

function BackgroundStudioCard() {
  const { t } = useTranslation()
  const background = useGlassStore((s) => s.background)
  const setBackgroundId = useGlassStore((s) => s.setBackgroundId)
  const setBackgroundOpacity = useGlassStore((s) => s.setBackgroundOpacity)
  const setBackgroundProp = useGlassStore((s) => s.setBackgroundProp)

  // Local draft state for preview before applying
  const [draftId, setDraftId] = useState<BackgroundId>(background.id)
  const [draftOpacity, setDraftOpacity] = useState(background.opacity)
  const [draftProps, setDraftProps] = useState<Record<string, unknown>>(background.props)

  // When store background changes externally, sync draft
  const storeId = background.id
  const syncDraft = useCallback(() => {
    setDraftId(storeId)
    setDraftOpacity(background.opacity)
    setDraftProps(background.props)
  }, [storeId, background.opacity, background.props])

  // Handle background selection change
  const handleBgChange = (id: string) => {
    const newId = id as BackgroundId
    setDraftId(newId)
    setDraftOpacity(0.3)
    setDraftProps(getDefaultProps(newId))
  }

  // Handle draft prop change
  const handleDraftProp = (prop: string, value: unknown) => {
    setDraftProps((prev) => ({ ...prev, [prop]: value }))
  }

  // Apply draft to store
  const handleApply = () => {
    // Zustand `set` is synchronous — do all writes inline, no setTimeout.
    if (draftId !== background.id) {
      setBackgroundId(draftId)
    }
    // Override props (setBackgroundProps merges; we want full replacement
    // of the per-bg keys, so set them directly).
    for (const [k, v] of Object.entries(draftProps)) {
      setBackgroundProp(k, v)
    }
    setBackgroundOpacity(draftOpacity)
  }

  // Quick-apply: same as apply (simplified now that handleApply is synchronous).
  const handleQuickApply = handleApply

  // Get controls for current draft background
  const bgDef = getBackgroundDef(draftId)

  // Check if draft differs from store (memoized to avoid JSON.stringify
  // on every render).
  const isDirty = useMemo(() => {
    if (draftId !== background.id) return true
    if (draftOpacity !== background.opacity) return true
    return JSON.stringify(draftProps) !== JSON.stringify(background.props)
  }, [draftId, draftOpacity, draftProps, background.id, background.opacity, background.props])

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle className="text-base">{t('glassSettings.studio.title')}</CardTitle>
        <CardDescription>{t('glassSettings.studio.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col space-y-4">
        {/* Background selector dropdown */}
        <div className="space-y-2">
          <Label>{t('glassSettings.studio.selectBackground')}</Label>
          <Select value={draftId} onValueChange={handleBgChange}>
            <SelectTrigger aria-label={t('glassSettings.studio.selectBackground')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('glassSettings.backgrounds.none')}</SelectItem>
              {BACKGROUND_REGISTRY.map((bg) => (
                <SelectItem key={bg.id} value={bg.id}>
                  {t(`glassSettings.backgrounds.${bg.id}`, { defaultValue: bg.name })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {draftId !== 'none' && (
          <>
            <Separator />

            {/* Opacity control */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t('glassSettings.studio.opacity')}</Label>
                <span className="font-mono text-xs text-muted-foreground">
                  {(draftOpacity * 100).toFixed(0)}%
                </span>
              </div>
              <Slider
                value={[draftOpacity]}
                min={0.05}
                max={1}
                step={0.05}
                onValueChange={(v: number[]) => setDraftOpacity(v[0] ?? 0.3)}
              />
            </div>

            {/* Dynamic controls from registry */}
            {bgDef && bgDef.controls.length > 0 && (
              <>
                <Separator />
                <div className="space-y-3">
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('glassSettings.studio.parameters')}
                  </Label>
                  {bgDef.controls.map((ctrl) => (
                    <DynamicControl
                      key={ctrl.prop}
                      control={ctrl}
                      value={draftProps[ctrl.prop] ?? ctrl.default}
                      onChange={(v) => handleDraftProp(ctrl.prop, v)}
                    />
                  ))}
                </div>
              </>
            )}

            <Separator />

            {/* Live preview */}
            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('glassSettings.studio.preview')}
              </Label>
              <div
                className="relative h-[200px] w-full overflow-hidden rounded-lg border bg-black/50"
                aria-label={t('glassSettings.studio.previewAria')}
              >
                <LivePreview id={draftId} props={draftProps} opacity={draftOpacity} />
              </div>
            </div>

            {/* Apply button */}
            <div className="flex gap-2 pt-2">
              <Button
                variant="default"
                size="sm"
                className="flex-1"
                onClick={handleApply}
                disabled={!isDirty}
              >
                {t('glassSettings.studio.apply')}
              </Button>
              {isDirty && (
                <Button variant="outline" size="sm" onClick={syncDraft}>
                  {t('glassSettings.studio.discard')}
                </Button>
              )}
            </div>
          </>
        )}

        {/* If none selected and store has a bg, show quick-clear */}
        {draftId === 'none' && background.id !== 'none' && (
          <div className="pt-2">
            <Button variant="outline" size="sm" className="w-full" onClick={handleQuickApply}>
              {t('glassSettings.studio.removeBackground')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Dynamic Control Renderer ─────────────────────────────────────────────────

interface DynamicControlProps {
  control: ControlDef
  value: unknown
  onChange: (value: unknown) => void
}

function DynamicControl({ control, value, onChange }: DynamicControlProps) {
  switch (control.type) {
    case 'slider':
      return <SliderControl control={control} value={value as number} onChange={onChange} />
    case 'color':
      return <ColorControl control={control} value={value as string} onChange={onChange} />
    case 'rgbColor':
      return <RgbColorControl control={control} value={value as number[]} onChange={onChange} />
    case 'toggle':
      return <ToggleControl control={control} value={value as boolean} onChange={onChange} />
    case 'colorArray':
      return <ColorArrayControl control={control} value={value as string[]} onChange={onChange} />
    case 'select':
      return <SelectControl control={control} value={value as string} onChange={onChange} />
    default:
      return null
  }
}

function SliderControl({ control, value, onChange }: { control: ControlDef; value: number; onChange: (v: unknown) => void }) {
  const numValue = typeof value === 'number' ? value : (control.default as number)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{control.label}</Label>
        <span className="font-mono text-[10px] text-muted-foreground">
          {numValue.toFixed(control.step && control.step < 1 ? 2 : 0)}
        </span>
      </div>
      <Slider
        value={[numValue]}
        min={control.min ?? 0}
        max={control.max ?? 10}
        step={control.step ?? 0.1}
        onValueChange={(v: number[]) => onChange(v[0] ?? numValue)}
      />
    </div>
  )
}

function ColorControl({ control, value, onChange }: { control: ControlDef; value: string; onChange: (v: unknown) => void }) {
  const hexValue = typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : (control.default as string)
  return (
    <div className="flex items-center justify-between">
      <Label className="text-xs">{control.label}</Label>
      <input
        type="color"
        value={hexValue}
        onChange={(e) => {
          if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
            onChange(e.target.value)
          }
        }}
        className="h-7 w-10 cursor-pointer rounded border"
        aria-label={control.label}
      />
    </div>
  )
}

function RgbColorControl({ control, value, onChange }: { control: ControlDef; value: number[]; onChange: (v: unknown) => void }) {
  // Convert [r,g,b] (0-1) to hex for the picker, and back
  const rgb = Array.isArray(value) && value.length === 3 ? value : (control.default as number[])
  const toHex = (c: number[]) =>
    '#' + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')
  const fromHex = (hex: string): number[] => {
    const h = hex.replace('#', '')
    return [
      parseInt(h.slice(0, 2), 16) / 255,
      parseInt(h.slice(2, 4), 16) / 255,
      parseInt(h.slice(4, 6), 16) / 255,
    ]
  }

  return (
    <div className="flex items-center justify-between">
      <Label className="text-xs">{control.label}</Label>
      <input
        type="color"
        value={toHex(rgb)}
        onChange={(e) => {
          if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
            onChange(fromHex(e.target.value))
          }
        }}
        className="h-7 w-10 cursor-pointer rounded border"
        aria-label={control.label}
      />
    </div>
  )
}

function ToggleControl({ control, value, onChange }: { control: ControlDef; value: boolean; onChange: (v: unknown) => void }) {
  const boolValue = typeof value === 'boolean' ? value : (control.default as boolean)
  return (
    <div className="flex items-center justify-between">
      <Label className="text-xs">{control.label}</Label>
      <Switch
        checked={boolValue}
        onCheckedChange={(v) => onChange(v)}
        aria-label={control.label}
      />
    </div>
  )
}

function ColorArrayControl({ control, value, onChange }: { control: ControlDef; value: string[]; onChange: (v: unknown) => void }) {
  const colors = Array.isArray(value) ? value : (control.default as string[])
  const count = control.count ?? colors.length

  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{control.label}</Label>
      <div className="flex gap-2">
        {Array.from({ length: count }).map((_, i) => (
          <input
            key={i}
            type="color"
            value={colors[i] && /^#[0-9a-fA-F]{6}$/.test(colors[i]) ? colors[i] : '#ffffff'}
            onChange={(e) => {
              if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
                const next = [...colors]
                next[i] = e.target.value
                onChange(next)
              }
            }}
            className="h-7 w-10 cursor-pointer rounded border"
            aria-label={`${control.label} ${i + 1}`}
          />
        ))}
      </div>
    </div>
  )
}

function SelectControl({ control, value, onChange }: { control: ControlDef; value: string; onChange: (v: unknown) => void }) {
  const strValue = typeof value === 'string' ? value : (control.default as string)
  const options = control.options ?? []

  return (
    <div className="flex items-center justify-between">
      <Label className="text-xs">{control.label}</Label>
      <Select value={strValue} onValueChange={(v) => onChange(v)}>
        <SelectTrigger className="h-8 w-32" aria-label={control.label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt} value={opt}>{opt}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

// ── Live Preview ─────────────────────────────────────────────────────────────

interface LivePreviewProps {
  id: BackgroundId
  props: Record<string, unknown>
  opacity: number
}

function LivePreview({ id, props, opacity }: LivePreviewProps) {
  if (id === 'none') return null

  const BgComponent = BG_COMPONENTS[id]
  if (!BgComponent) return null

  return (
    <div style={{ position: 'absolute', inset: 0, opacity }}>
      <Suspense fallback={
        <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
          Loading…
        </div>
      }>
        <BgComponent {...props} />
      </Suspense>
    </div>
  )
}
