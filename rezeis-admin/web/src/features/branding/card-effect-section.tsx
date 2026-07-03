/**
 * CardEffectSection — WEB Reiwa configurator block for the animated card
 * background. Lets the operator pick a ReactBits effect to render behind the
 * subscription card, tune its parameters, set the layer opacity, and preview
 * it live inside a mini card frame.
 *
 * Controlled via three props mirrored from the branding form:
 *   - effect: CardEffectId | 'NONE'
 *   - props: per-effect parameters (merged over defaults)
 *   - opacity: 0.05–1
 */

import { Suspense, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Check } from 'lucide-react'

import {
  CARD_EFFECT_COMPONENTS,
  CARD_EFFECT_REGISTRY,
  getCardEffectDef,
  getCardEffectDefaults,
} from './card-effect-registry'
import type { ControlDef } from '@/features/appearance/background-controls'

interface CardEffectSectionProps {
  effect: string
  props: Record<string, unknown>
  opacity: number
  onEffectChange: (effect: string) => void
  onPropsChange: (props: Record<string, unknown>) => void
  onOpacityChange: (opacity: number) => void
}

export function CardEffectSection(props: CardEffectSectionProps) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('brandingPage.sections.cardEffect.title')}</CardTitle>
        <CardDescription>{t('brandingPage.sections.cardEffect.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <CardEffectPicker {...props} />
      </CardContent>
    </Card>
  )
}

/**
 * CardEffectPicker — the picker body (effect grid + opacity + per-effect
 * controls) WITHOUT the surrounding Card/title. Reused both by the global
 * `CardEffectSection` and by each per-position slot in the slots section.
 */
export function CardEffectPicker({
  effect,
  props,
  opacity,
  onEffectChange,
  onPropsChange,
  onOpacityChange,
}: CardEffectSectionProps) {
  const { t } = useTranslation()
  const def = effect !== 'NONE' ? getCardEffectDef(effect) : undefined
  const mergedProps = useMemo(
    () => (def ? { ...getCardEffectDefaults(effect), ...props } : {}),
    [def, effect, props],
  )

  const handleSelect = (id: string) => {
    if (id === effect) return
    onEffectChange(id)
    // Load fresh defaults for the newly picked effect.
    onPropsChange(id === 'NONE' ? {} : getCardEffectDefaults(id))
  }

  const handleProp = (prop: string, value: unknown) => {
    onPropsChange({ ...mergedProps, [prop]: value })
  }

  return (
    <>
      {/* Effect grid: NONE + all effects */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        <button
          type="button"
          onClick={() => handleSelect('NONE')}
          aria-label={t('brandingPage.cardEffects.NONE')}
          className={`relative flex aspect-video items-center justify-center rounded-lg border bg-muted/30 text-[10px] font-medium text-muted-foreground transition-all hover:scale-[1.03] ${
            effect === 'NONE' ? 'border-primary ring-2 ring-primary/40' : 'border-border hover:border-primary/40'
          }`}
        >
          {t('brandingPage.cardEffects.NONE')}
          {effect === 'NONE' && (
            <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Check className="h-2.5 w-2.5" />
            </span>
          )}
        </button>
        {CARD_EFFECT_REGISTRY.map((e) => {
          const Eff = CARD_EFFECT_COMPONENTS[e.id]
          const isActive = effect === e.id
          return (
            <button
              key={e.id}
              type="button"
              onClick={() => handleSelect(e.id)}
              aria-label={t(`brandingPage.cardEffects.${e.id}`, { defaultValue: e.name })}
              title={t(`brandingPage.cardEffects.${e.id}`, { defaultValue: e.name })}
              className={`relative aspect-video overflow-hidden rounded-lg border bg-zinc-950 transition-all hover:scale-[1.03] ${
                isActive ? 'border-primary ring-2 ring-primary/40' : 'border-border hover:border-primary/40'
              }`}
            >
              {/* Static thumbnail: render the live effect at default props only
                  for the ACTIVE one (cheap) and a label otherwise. */}
              {isActive ? (
                <Suspense fallback={null}>
                  <div className="pointer-events-none absolute inset-0">
                    <Eff {...mergedProps} />
                  </div>
                </Suspense>
              ) : null}
              <span className="absolute inset-x-0 bottom-0 bg-black/55 px-1 py-0.5 text-center text-[9px] font-medium text-white">
                {t(`brandingPage.cardEffects.${e.id}`, { defaultValue: e.name })}
              </span>
              {isActive && (
                <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check className="h-2.5 w-2.5" />
                </span>
              )}
            </button>
          )
        })}
      </div>

      {def && (
        <>
          {/* Hint: the real effect renders in the live phone preview → */}
          <p className="text-[11px] text-muted-foreground">
            {t('brandingPage.sections.cardEffect.previewHint')}
          </p>

          {/* Opacity */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t('brandingPage.sections.cardEffect.opacity')}</Label>
              <span className="font-mono text-xs text-muted-foreground">{(opacity * 100).toFixed(0)}%</span>
            </div>
            <Slider
              value={[opacity]}
              min={0.05}
              max={1}
              step={0.05}
              onValueChange={(v: number[]) => onOpacityChange(v[0] ?? 1)}
              aria-label={t('brandingPage.sections.cardEffect.opacity')}
            />
          </div>

          {/* Dynamic per-effect controls */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {def.controls.map((control) => (
              <DynamicControl
                key={control.prop}
                control={control}
                value={mergedProps[control.prop]}
                onChange={(v) => handleProp(control.prop, v)}
              />
            ))}
          </div>
        </>
      )}
    </>
  )
}

// ── Control renderers (slider / color / colorArray / rgbColor / toggle) ───────

function DynamicControl({
  control,
  value,
  onChange,
}: {
  control: ControlDef
  value: unknown
  onChange: (v: unknown) => void
}) {
  switch (control.type) {
    case 'slider':
      return <SliderControl control={control} value={value as number} onChange={onChange} />
    case 'color':
      return <ColorControl control={control} value={value as string} onChange={onChange} />
    case 'colorArray':
      return <ColorArrayControl control={control} value={value as string[]} onChange={onChange} />
    case 'rgbColor':
      return <RgbColorControl control={control} value={value as number[]} onChange={onChange} />
    case 'toggle':
      return <ToggleControl control={control} value={value as boolean} onChange={onChange} />
    case 'select':
      return <SelectControl control={control} value={value as string} onChange={onChange} />
    default:
      return null
  }
}

function SelectControl({ control, value, onChange }: { control: ControlDef; value: string; onChange: (v: unknown) => void }) {
  const options = control.options ?? []
  const v = typeof value === 'string' && options.includes(value) ? value : (control.default as string)
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{control.label}</Label>
      <Select value={v} onValueChange={(next) => onChange(next)}>
        <SelectTrigger className="h-7 text-xs" aria-label={control.label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt} value={opt} className="text-xs">{opt}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function SliderControl({ control, value, onChange }: { control: ControlDef; value: number; onChange: (v: unknown) => void }) {
  const v = typeof value === 'number' ? value : (control.default as number)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{control.label}</Label>
        <span className="font-mono text-[10px] text-muted-foreground">{v}</span>
      </div>
      <Slider
        value={[v]}
        min={control.min ?? 0}
        max={control.max ?? 1}
        step={control.step ?? 0.1}
        onValueChange={(arr: number[]) => onChange(arr[0] ?? v)}
        aria-label={control.label}
      />
    </div>
  )
}

function ColorControl({ control, value, onChange }: { control: ControlDef; value: string; onChange: (v: unknown) => void }) {
  const v = typeof value === 'string' ? value : (control.default as string)
  return (
    <div className="flex items-center justify-between">
      <Label className="text-xs">{control.label}</Label>
      <input
        type="color"
        value={/^#[0-9a-fA-F]{6}$/.test(v) ? v : '#ffffff'}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-10 cursor-pointer rounded border"
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
              const next = [...colors]
              next[i] = e.target.value
              onChange(next)
            }}
            className="h-7 w-9 cursor-pointer rounded border"
            aria-label={`${control.label} ${i + 1}`}
          />
        ))}
      </div>
    </div>
  )
}

function RgbColorControl({ control, value, onChange }: { control: ControlDef; value: number[]; onChange: (v: unknown) => void }) {
  const rgb = Array.isArray(value) && value.length === 3 ? value : (control.default as number[])
  const toHex = (c: number[]) =>
    '#' + c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('')
  const fromHex = (hex: string): number[] => {
    const h = hex.replace('#', '')
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]
  }
  return (
    <div className="flex items-center justify-between">
      <Label className="text-xs">{control.label}</Label>
      <input
        type="color"
        value={toHex(rgb)}
        onChange={(e) => onChange(fromHex(e.target.value))}
        className="h-7 w-10 cursor-pointer rounded border"
        aria-label={control.label}
      />
    </div>
  )
}

function ToggleControl({ control, value, onChange }: { control: ControlDef; value: boolean; onChange: (v: unknown) => void }) {
  const v = typeof value === 'boolean' ? value : (control.default as boolean)
  return (
    <div className="flex items-center justify-between">
      <Label className="text-xs">{control.label}</Label>
      <Switch checked={v} onCheckedChange={(c) => onChange(c)} aria-label={control.label} />
    </div>
  )
}
