import { lazy, Suspense, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe2, Info } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

import {
  GLOBE_CATALOG,
  GLOBE_VARIANTS,
  defaultGlobeProps,
  isGlobeVariant,
  type GlobePropSpec,
  type GlobeVariant,
} from '@/components/reactbits/originkit/globe-preferences'
import type { BrandingServersGlobeDraft } from './branding-form-schema'

/**
 * The "Servers" tab: which planet a subscriber sees, and how it is set up.
 *
 * EVERY CONTROL IS DERIVED. The catalogue is vendored from the cabinet by
 * `scripts/sync-originkit.mjs` and frozen by a manifest test, so the ranges a
 * slider offers here are the ranges the cabinet clamps to — by construction,
 * not by two lists agreeing. A planet added over there grows its controls here
 * with no edit at all, and one whose range changes cannot leave this form
 * offering a value the cabinet would quietly discard.
 *
 * ONLY WHAT WAS CHANGED IS STORED. The draft's `props` holds the operator's
 * departures from the variant's defaults and nothing else. Writing the full set
 * would freeze today's defaults into every row: a later change to a shipped
 * value would then stop reaching every operator who had ever opened this tab,
 * including the ones who never touched that particular slider.
 */

/** The planet, drawn for real. Loaded only while this tab is open. */
const Globe = lazy(() => import('@/components/reactbits/originkit/Globe'))
const GlobeMesh = lazy(() => import('@/components/reactbits/originkit/GlobeMesh'))
const DitherGlobe = lazy(() => import('@/components/reactbits/originkit/DitherGlobe'))

export interface ServersGlobeSectionProps {
  readonly value: BrandingServersGlobeDraft
  readonly onChange: (next: BrandingServersGlobeDraft) => void
  /** False while another tab is showing, so no renderer is built for nothing. */
  readonly active: boolean
}

export function ServersGlobeSection({ value, onChange, active }: ServersGlobeSectionProps) {
  const { t } = useTranslation()
  const variant: GlobeVariant = isGlobeVariant(value.variant) ? value.variant : 'globe'
  const spec = GLOBE_CATALOG[variant]

  /** Defaults underneath, the operator's departures on top. */
  const effective = useMemo(
    () => ({ ...defaultGlobeProps(variant), ...value.props }),
    [variant, value.props],
  )

  const setProp = (name: string, next: string | number | boolean): void => {
    const props = { ...value.props }
    const shipped = (spec.props as Record<string, GlobePropSpec>)[name]?.default
    // Back at the shipped value means the operator has no opinion any more, and
    // an entry saying so is indistinguishable from one they chose deliberately.
    if (next === shipped) delete props[name]
    else props[name] = next
    onChange({ ...value, props })
  }

  const setVariant = (next: GlobeVariant): void => {
    // The props belong to the variant. Carrying them across would hand the new
    // planet the previous one's tuning under names that mean nothing to it.
    onChange({ ...value, variant: next, props: {} })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe2 className="h-4 w-4" /> {t('brandingPage.servers.title')}
          </CardTitle>
          <CardDescription>{t('brandingPage.servers.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="servers-globe-enabled">
                {t('brandingPage.servers.enabledLabel')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('brandingPage.servers.enabledHint')}
              </p>
            </div>
            <Switch
              id="servers-globe-enabled"
              checked={value.enabled}
              onCheckedChange={(enabled) => onChange({ ...value, enabled })}
            />
          </div>

          <div className="space-y-2">
            <Label>{t('brandingPage.servers.variantLabel')}</Label>
            <div className="grid gap-2 sm:grid-cols-3">
              {GLOBE_VARIANTS.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setVariant(id)}
                  aria-pressed={variant === id}
                  className={cn(
                    'rounded-lg border p-3 text-left transition-colors',
                    variant === id
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-muted-foreground/40',
                  )}
                >
                  <span className="block text-sm font-medium">
                    {t(`brandingPage.servers.variants.${id}.name`)}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {t(`brandingPage.servers.variants.${id}.note`)}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {!spec.supportsMarkers && (
            <p className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t('brandingPage.servers.noMarkers')}
            </p>
          )}

          <GlobePreview active={active} variant={variant} props={effective} />

          <div className="grid gap-4 sm:grid-cols-2">
            {Object.entries(spec.props as Record<string, GlobePropSpec>).map(([name, propSpec]) => (
              <GlobeControl
                key={`${variant}:${name}`}
                name={name}
                spec={propSpec}
                value={effective[name]}
                onChange={(next) => setProp(name, next)}
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/** One control, chosen by the prop's own kind. */
function GlobeControl({
  name,
  spec,
  value,
  onChange,
}: {
  readonly name: string
  readonly spec: GlobePropSpec
  readonly value: string | number | boolean
  readonly onChange: (next: string | number | boolean) => void
}) {
  const { t } = useTranslation()
  // Same resolver the card effects use, so the ~340 labels already translated
  // there cover every prop name the globes share with them, and a name neither
  // knows falls back to itself rather than printing a raw key.
  const label = t(`brandingPage.cardEffectControls.${name}`, name)
  const id = `globe-prop-${name}`

  if (spec.kind === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
        <Label htmlFor={id} className="text-sm font-normal">
          {label}
        </Label>
        <Switch
          id={id}
          checked={value === true}
          onCheckedChange={(next) => onChange(next)}
        />
      </div>
    )
  }

  if (spec.kind === 'color') {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex items-center gap-2">
          <input
            id={id}
            type="color"
            value={typeof value === 'string' ? value : spec.default}
            onChange={(e) => onChange(e.target.value.toUpperCase())}
            className="h-9 w-12 cursor-pointer rounded border bg-transparent p-0.5"
          />
          <span className="font-mono text-xs text-muted-foreground">
            {typeof value === 'string' ? value : spec.default}
          </span>
        </div>
      </div>
    )
  }

  if (spec.kind === 'enum') {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        <Select
          value={typeof value === 'string' ? value : spec.default}
          onValueChange={(next) => onChange(next)}
        >
          <SelectTrigger id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* `cardEffectOptions`, not `cardEffectControls`: the option
                VALUES have their own namespace, shared with the card
                effects, where `left`/`right`/`dots`/`solid` are already
                translated. Reading a namespace that does not exist is
                invisible to the parity guard — it compares ru against en,
                and a missing namespace is missing from both. */}
            {spec.values.map((option) => (
              <SelectItem key={option} value={option}>
                {t(`brandingPage.cardEffectOptions.${option}`, option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )
  }

  const numeric = typeof value === 'number' ? value : spec.default
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{numeric}</span>
      </div>
      <Slider
        id={id}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={[numeric]}
        onValueChange={([next]) => onChange(next ?? spec.default)}
      />
    </div>
  )
}

/**
 * The chosen planet, drawn with the operator's own settings.
 *
 * WHY IT IS HERE AT ALL. The whole reason these components are vendored into
 * this repository is that an operator tuning a slider against a preview that
 * has drifted from production is being lied to, quietly. A tab of numbers with
 * no picture would be the same lie by omission.
 *
 * It renders only while the tab is open: each planet costs a live WebGL context
 * (except the dithered one, which draws on a plain canvas), and the card-effect
 * preview on the neighbouring tabs is already holding one.
 */
function GlobePreview({
  active,
  variant,
  props,
}: {
  readonly active: boolean
  readonly variant: GlobeVariant
  readonly props: Record<string, string | number | boolean>
}) {
  const { t } = useTranslation()
  if (!active) return null

  const n = (key: string, fallback: number) =>
    typeof props[key] === 'number' ? (props[key] as number) : fallback
  const s = (key: string, fallback: string) =>
    typeof props[key] === 'string' ? (props[key] as string) : fallback
  const b = (key: string, fallback: boolean) =>
    typeof props[key] === 'boolean' ? (props[key] as boolean) : fallback

  return (
    <div className="space-y-1.5">
      <Label>{t('brandingPage.servers.previewLabel')}</Label>
      <div
        className="overflow-hidden rounded-lg border bg-black"
        style={{ height: 260 }}
        aria-hidden="true"
      >
        <Suspense fallback={null}>
          {variant === 'globe' ? (
            <Globe
              speed={n('speed', 2)}
              smoothing={n('smoothing', 8)}
              scale={n('scale', 8)}
              direction={s('direction', 'left') === 'right' ? 'right' : 'left'}
              stopOnHover={b('stopOnHover', true)}
              initialLatitude={n('initialLatitude', 23)}
              initialLongitude={n('initialLongitude', -23)}
              dragSpeed={n('dragSpeed', 5)}
              detail={n('detail', 5)}
              fill={s('fill', 'dots') === 'solid' ? 'solid' : 'dots'}
              fillColor={s('fillColor', '#FFFFFF')}
              showOutline={b('showOutline', true)}
              outlineColor={s('outlineColor', '#FFFFFF')}
              outlineWidth={n('outlineWidth', 1)}
              showGrid={b('showGrid', true)}
              graticuleColor={s('graticuleColor', '#D4D4D4')}
              oceanColor={s('oceanColor', '#000000')}
              dots={{
                color: s('dotColor', '#FFFFFF'),
                size: n('dotSize', 5),
                density: n('dotDensity', 8),
                allDots: b('allDots', false),
              }}
              markerConfig={{
                // Three real places, so the operator can see what a marker
                // looks like against their colours instead of guessing.
                markers: PREVIEW_MARKERS,
                color: s('markerColor', '#00F7FF'),
                size: n('markerSize', 40),
              }}
            />
          ) : variant === 'globe-mesh' ? (
            <GlobeMesh
              dot={s('dot', '#FFFFFF')}
              net={s('net', '#26FF00')}
              density={n('density', 20)}
              spin={n('spin', 20)}
              spinDir={s('spinDir', 'right') === 'left' ? 'left' : 'right'}
              hoverOn={b('hoverOn', true)}
              sizePercent={n('sizePercent', 100)}
            />
          ) : (
            <DitherGlobe
              colorA={s('colorA', '#0B0B12')}
              colorB={s('colorB', '#E8E8F0')}
              accent={s('accent', '#5B8DEF')}
              pixel={n('pixel', 4)}
              levels={n('levels', 6)}
              land={n('land', 50)}
              globeSize={n('globeSize', 100)}
              glowEnabled={b('glowEnabled', true)}
              glowSize={n('glowSize', 12)}
              speed={n('speed', 6)}
              dragEnabled={b('dragEnabled', true)}
            />
          )}
        </Suspense>
      </div>
      <p className="text-xs text-muted-foreground">{t('brandingPage.servers.previewHint')}</p>
    </div>
  )
}

/** Frankfurt, Amsterdam, Helsinki — a shape an operator recognises. */
const PREVIEW_MARKERS = [
  { lat: 50.11, lng: 8.68 },
  { lat: 52.37, lng: 4.9 },
  { lat: 60.17, lng: 24.94 },
]
