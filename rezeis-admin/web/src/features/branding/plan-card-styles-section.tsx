/**
 * PlanCardStylesSection — WEB Reiwa configurator block (Тарифные карточки tab).
 *
 * Lists every plan (incl. archived) and lets the operator assign a per-plan
 * tariff-card style: gradient (presets + visual builder), accent colour, and a
 * texture (built-in preset OR uploaded image). Styles are keyed by `planId`
 * and persist into `brandingSettings.planCardStyles`. A live mini tariff-card
 * preview renders each plan's resolved look. Plans without a style fall back to
 * a deterministic auto gradient (mirrors the reiwa cabinet), so the operator
 * sees distinct cards out of the box.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Upload, Wand2, X } from 'lucide-react'
import { toast } from 'sonner'

import api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

import { usePlans } from '@/features/plans/plans-api'
import { GradientBuilder } from './gradient-builder'
import { CardEffectPicker } from './card-effect-section'
import { getCardEffectDefaults } from './card-effect-registry'
import { CARD_GRADIENT_PRESETS, gradientFromPrimary } from './theme-presets'
import { APP_BG_TEXTURE_PATTERNS, buildTextureCss } from './app-texture'
import {
  resolveCardTextForeground,
  resolvePlanCardText,
  resolvePlanCardTextureCss,
} from './plan-card-style-utils'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type {
  BrandingSubscriptionCardTextDraft,
  PlanCardStyleDraft,
} from './branding-form-schema'
import { PlanIconView } from '@/features/plans/plan-icon-view'

type PlanCardStyleMap = Record<string, PlanCardStyleDraft>

interface PlanCardStylesSectionProps {
  readonly value: PlanCardStyleMap
  readonly onChange: (next: PlanCardStyleMap) => void
  /** Brand primary — seeds new gradients + accent default. */
  readonly primary: string
  /**
   * The global card-text decision every tariff card inherits until one is
   * given its own. Required rather than defaulted: a wrong baseline here shows
   * the operator a text colour no subscriber will ever see, and a default would
   * hide that from the compiler.
   */
  readonly subscriptionCardText: BrandingSubscriptionCardTextDraft
}

/** Deterministic auto gradient from a plan id — mirrors reiwa `autoPlanStyle`. */
function autoPlanGradient(planId: string): string {
  let h = 0
  for (let i = 0; i < planId.length; i += 1) {
    h = (h * 31 + planId.charCodeAt(i)) >>> 0
  }
  const hue = h % 360
  return `linear-gradient(135deg, hsl(${hue} 70% 22%), hsl(${(hue + 40) % 360} 65% 32%))`
}

export function PlanCardStylesSection({
  value,
  onChange,
  primary,
  subscriptionCardText,
}: PlanCardStylesSectionProps) {
  const { t } = useTranslation()
  const { data: plans, isLoading } = usePlans()

  // Track the latest value in a ref so multiple patches dispatched in the same
  // tick compound instead of clobbering each other (the effect picker fires
  // onEffectChange AND onPropsChange synchronously — without this the second
  // would recompute from the stale `value` prop and drop the first).
  const valueRef = useRef(value)
  useEffect(() => {
    valueRef.current = value
  }, [value])

  const setStyle = (planId: string, patch: Partial<PlanCardStyleDraft> | null) => {
    const next: PlanCardStyleMap = { ...valueRef.current }
    if (patch === null) {
      delete next[planId]
    } else {
      const merged = { ...(next[planId] ?? {}), ...patch }
      // Drop empty entry entirely so an "all-cleared" plan reverts to auto.
      //
      // `text` counts only when it is an actual override. `inherit` is what an
      // absent entry already does, so a plan switched back to inherit must
      // leave NO entry behind — otherwise the row would keep reading "custom"
      // with nothing to show for it, and the stored payload of an operator who
      // chose inherit would differ from one who never opened the control.
      const hasAny =
        (merged.gradient && merged.gradient.length > 0) ||
        (merged.accent && merged.accent.length > 0) ||
        (merged.texturePreset && merged.texturePreset.length > 0) ||
        (merged.textureUrl && merged.textureUrl.length > 0) ||
        (merged.cardEffect && merged.cardEffect !== 'NONE') ||
        (merged.text != null && merged.text.mode !== 'inherit')
      if (hasAny) next[planId] = merged
      else delete next[planId]
    }
    valueRef.current = next
    onChange(next)
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('brandingPage.sections.planCards.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-24 items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        </CardContent>
      </Card>
    )
  }

  const list = Array.isArray(plans) ? plans : []

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('brandingPage.sections.planCards.title')}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {t('brandingPage.sections.planCards.description')}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {list.length === 0 ? (
          <p className="rounded-md border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">
            {t('brandingPage.sections.planCards.empty')}
          </p>
        ) : (
          list.map((plan) => (
            <PlanStyleRow
              key={plan.id}
              planId={plan.id}
              planName={plan.name}
              planIcon={plan.icon}
              archived={plan.isArchived}
              trafficLimit={plan.trafficLimit}
              deviceLimit={plan.deviceLimit}
              style={value[plan.id]}
              primary={primary}
              subscriptionCardText={subscriptionCardText}
              onPatch={(patch) => setStyle(plan.id, patch)}
              onReset={() => setStyle(plan.id, null)}
            />
          ))
        )}
      </CardContent>
    </Card>
  )
}

interface PlanStyleRowProps {
  readonly planId: string
  readonly planName: string
  readonly planIcon: string | null
  readonly archived: boolean
  readonly trafficLimit: number
  readonly deviceLimit: number
  readonly style: PlanCardStyleDraft | undefined
  readonly primary: string
  readonly subscriptionCardText: BrandingSubscriptionCardTextDraft
  readonly onPatch: (patch: Partial<PlanCardStyleDraft>) => void
  readonly onReset: () => void
}

function PlanStyleRow({
  planId,
  planName,
  planIcon,
  archived,
  trafficLimit,
  deviceLimit,
  style,
  primary,
  subscriptionCardText,
  onPatch,
  onReset,
}: PlanStyleRowProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const configured = style !== undefined

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 p-3 text-left"
      >
        <TariffCardThumb
          planId={planId}
          planName={planName}
          planIcon={planIcon}
          trafficLimit={trafficLimit}
          deviceLimit={deviceLimit}
          style={style}
          subscriptionCardText={subscriptionCardText}
          className="h-14 w-24 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{planName}</span>
            {archived && (
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                {t('brandingPage.sections.planCards.archived')}
              </span>
            )}
            <span
              className={cn(
                'shrink-0 rounded-full px-2 py-0.5 text-[10px]',
                configured ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
              )}
            >
              {configured
                ? t('brandingPage.sections.planCards.custom')
                : t('brandingPage.sections.planCards.auto')}
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {trafficLimit > 0 ? `${trafficLimit} GB` : t('brandingPage.sections.planCards.unlimited')}
            {deviceLimit > 0 ? ` · ${deviceLimit}` : ''}
          </p>
        </div>
        <span className="text-xs text-muted-foreground">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="space-y-3 border-t p-3">
          {/* Gradient presets */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">{t('brandingPage.sections.planCards.gradient')}</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => onPatch({ gradient: gradientFromPrimary(primary) })}
              >
                <Wand2 className="mr-1 h-3 w-3" />
                {t('brandingPage.sections.planCards.fromPrimary')}
              </Button>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(34px,1fr))] gap-1.5">
              {CARD_GRADIENT_PRESETS.map((preset) => {
                const active = (style?.gradient ?? '').toLowerCase() === preset.value.toLowerCase()
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-label={t(`brandingPage.cardGradients.${preset.id}`)}
                    title={t(`brandingPage.cardGradients.${preset.id}`)}
                    onClick={() => onPatch({ gradient: preset.value })}
                    className={cn(
                      'aspect-square rounded-md ring-1 transition-all hover:scale-[1.08]',
                      active ? 'ring-2 ring-primary' : 'ring-white/10 hover:ring-primary/40',
                    )}
                    style={{ backgroundImage: preset.value }}
                  />
                )
              })}
            </div>
            <GradientBuilder
              value={style?.gradient ?? ''}
              onChange={(css) => onPatch({ gradient: css })}
            />
            {/* Editable CSS readout — paste a ready gradient or copy the built
                one, mirroring the subscription-card constructor. */}
            <Input
              value={style?.gradient ?? ''}
              onChange={(e) => onPatch({ gradient: e.target.value })}
              className="h-8 font-mono text-xs"
              placeholder={t('brandingPage.sections.card.gradientPlaceholder')}
              aria-label={t('brandingPage.sections.card.gradient')}
            />
          </div>

          {/* Accent */}
          <div className="space-y-1.5">
            <Label className="text-xs">{t('brandingPage.sections.planCards.accent')}</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label={t('brandingPage.sections.planCards.accent')}
                value={isHex(style?.accent) ? (style?.accent as string) : primary}
                onChange={(e) => onPatch({ accent: e.target.value })}
                className="h-8 w-12 cursor-pointer rounded border bg-transparent"
              />
              <Input
                value={style?.accent ?? ''}
                onChange={(e) => onPatch({ accent: e.target.value })}
                placeholder={primary}
                className="h-8 font-mono text-xs"
              />
            </div>
          </div>

          {/* Card text — same four policies as the subscription card, plus the
              inherit default. Deliberately worded and shaped like the global
              control (`brandingPage.sections.card.textMode*`), because it is
              the same decision taken one level down. */}
          <div className="space-y-1.5 rounded-md border border-dashed bg-muted/20 p-2">
            <Label className="text-xs" htmlFor={`planCardText-${planId}`}>
              {t('brandingPage.sections.planCards.text')}
            </Label>
            <p className="text-[11px] text-muted-foreground">
              {t('brandingPage.sections.planCards.textHint')}
            </p>
            <Select
              value={style?.text?.mode ?? 'inherit'}
              onValueChange={(mode) =>
                onPatch({
                  text: {
                    mode: mode as NonNullable<PlanCardStyleDraft['text']>['mode'],
                    // A colour belongs to `custom` alone. Clearing it on every
                    // other mode is what keeps the persisted entry identical to
                    // an untouched one when the operator returns to inherit.
                    color: mode === 'custom' ? (style?.text?.color ?? primary) : null,
                  },
                })
              }
            >
              <SelectTrigger id={`planCardText-${planId}`} className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">
                  {t('brandingPage.sections.planCards.textInherit')}
                </SelectItem>
                <SelectItem value="auto">
                  {t('brandingPage.sections.card.textModes.auto')}
                </SelectItem>
                <SelectItem value="light">
                  {t('brandingPage.sections.card.textModes.light')}
                </SelectItem>
                <SelectItem value="dark">
                  {t('brandingPage.sections.card.textModes.dark')}
                </SelectItem>
                <SelectItem value="custom">
                  {t('brandingPage.sections.card.textModes.custom')}
                </SelectItem>
              </SelectContent>
            </Select>
            {style?.text?.mode === 'custom' && (
              <div className="flex items-center gap-2">
                {/* A swatch beside the text box, exactly like the accent
                    control above. It matters more here than there: a validation
                    error on this value lands at path
                    `planCardStyles.<planId>.text.color`, which react-hook-form
                    cannot attach to any input, so a half-typed colour would
                    read as a Save button that does nothing. The swatch can only
                    emit `#rrggbb`, so there is always a way to set this that
                    cannot fail. */}
                <input
                  type="color"
                  aria-label={t('brandingPage.sections.card.textColor')}
                  value={isOpaqueHex(style.text.color) ? style.text.color : '#ffffff'}
                  onChange={(e) => onPatch({ text: { mode: 'custom', color: e.target.value } })}
                  className="h-8 w-12 cursor-pointer rounded border bg-transparent"
                />
                <Input
                  value={style.text.color ?? ''}
                  onChange={(e) =>
                    onPatch({ text: { mode: 'custom', color: e.target.value || null } })
                  }
                  placeholder="#ffffff"
                  className="h-8 font-mono text-xs"
                />
              </div>
            )}
          </div>

          {/* Texture: preset grid + upload */}
          <div className="space-y-1.5">
            <Label className="text-xs">{t('brandingPage.sections.planCards.texture')}</Label>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(34px,1fr))] gap-1.5">
              <button
                type="button"
                onClick={() => onPatch({ texturePreset: null, textureUrl: null })}
                className={cn(
                  'flex aspect-square items-center justify-center rounded-md border text-[9px] text-muted-foreground transition-all hover:border-primary/40',
                  !style?.texturePreset && !style?.textureUrl ? 'border-primary ring-1 ring-primary' : 'border-border',
                )}
              >
                {t('brandingPage.sections.planCards.textureNone')}
              </button>
              {APP_BG_TEXTURE_PATTERNS.map((pattern) => {
                const css = buildTextureCss({
                  pattern,
                  color: isHex(style?.accent) ? (style?.accent as string) : primary,
                  background: '#0b0b0d',
                  scale: 18,
                  opacity: 0.6,
                })
                const active = style?.texturePreset === pattern && !style?.textureUrl
                return (
                  <button
                    key={pattern}
                    type="button"
                    aria-label={pattern}
                    title={pattern}
                    onClick={() => onPatch({ texturePreset: pattern, textureUrl: null })}
                    className={cn(
                      'aspect-square rounded-md ring-1 transition-all hover:scale-[1.06]',
                      active ? 'ring-2 ring-primary' : 'ring-white/10 hover:ring-primary/40',
                    )}
                    style={{
                      backgroundColor: css.backgroundColor,
                      backgroundImage: css.backgroundImage,
                      backgroundSize: css.backgroundSize,
                    }}
                  />
                )
              })}
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={style?.textureUrl ?? ''}
                onChange={(e) => onPatch({ textureUrl: e.target.value || null })}
                placeholder={t('brandingPage.sections.planCards.textureUrlPlaceholder')}
                className="h-8 font-mono text-xs"
              />
              <TextureUploadButton onUploaded={(url) => onPatch({ textureUrl: url, texturePreset: null })} />
              {style?.textureUrl ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  aria-label={t('brandingPage.sections.planCards.textureClear')}
                  onClick={() => onPatch({ textureUrl: null })}
                >
                  <X className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
          </div>

          {/* Per-plan animated background effect (opt-in). */}
          <div className="space-y-1.5">
            <Label className="text-xs">{t('brandingPage.sections.planCards.effect')}</Label>
            <CardEffectPicker
              effect={style?.cardEffect ?? 'NONE'}
              props={style?.cardEffectProps ?? {}}
              opacity={style?.cardEffectOpacity ?? 1}
              livePreview={false}
              onEffectChange={(e) =>
                onPatch(
                  e === 'NONE'
                    ? { cardEffect: null, cardEffectProps: undefined, cardEffectOpacity: undefined }
                    : {
                        cardEffect: e,
                        cardEffectProps: getCardEffectDefaults(e),
                        cardEffectOpacity: style?.cardEffectOpacity ?? 1,
                      },
                )
              }
              onPropsChange={(p) => onPatch({ cardEffectProps: p })}
              onOpacityChange={(o) => onPatch({ cardEffectOpacity: o })}
            />
          </div>

          <div className="flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-[11px] text-muted-foreground"
              onClick={onReset}
              disabled={!configured}
            >
              {t('brandingPage.sections.planCards.resetToAuto')}
            </Button>
            <TariffCardThumb
              planId={planId}
              planName={planName}
              planIcon={planIcon}
              trafficLimit={trafficLimit}
              deviceLimit={deviceLimit}
              style={style}
              subscriptionCardText={subscriptionCardText}
              className="h-20 w-32"
            />
          </div>
        </div>
      )}
    </div>
  )
}

/** Compact CSS-only tariff-card preview (no WebGL) used in the editor list. */
function TariffCardThumb({
  planId,
  planName,
  planIcon,
  trafficLimit,
  deviceLimit,
  style,
  subscriptionCardText,
  className,
}: {
  readonly planId: string
  readonly planName: string
  readonly planIcon: string | null
  readonly trafficLimit: number
  readonly deviceLimit: number
  readonly style: PlanCardStyleDraft | undefined
  readonly subscriptionCardText: BrandingSubscriptionCardTextDraft
  readonly className?: string
}) {
  const gradient = style?.gradient && style.gradient.length > 0 ? style.gradient : autoPlanGradient(planId)
  const textureCss = resolvePlanCardTextureCss(style)
  /**
   * The forced foreground for this card, resolved through the same precedence
   * the cabinet uses (per-plan override → global → auto).
   *
   * `null` means `auto`, and this thumb keeps drawing white for that — it has no
   * contrast engine and is 24px tall. That is the pre-existing behaviour and it
   * is left alone deliberately: the phone-frame preview beside this section
   * runs the real computation and shows the accurate automatic colour. What the
   * thumb must never do is ignore an EXPLICIT choice, because then the operator
   * would pick "dark text" and see white here.
   */
  const forcedForeground = resolveCardTextForeground(
    resolvePlanCardText(style, subscriptionCardText),
  )

  return (
    <div
      className={cn('relative overflow-hidden rounded-lg ring-1 ring-white/10', className)}
      style={{ backgroundImage: gradient }}
      data-plan-card-thumb-foreground={forcedForeground ?? 'auto'}
    >
      <div className="absolute inset-0 bg-linear-to-b from-black/30 via-transparent to-black/60" />
      {style?.textureUrl ? (
        <div
          className="absolute inset-0 opacity-60"
          style={{ backgroundImage: `url("${style.textureUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' }}
        />
      ) : textureCss ? (
        <div
          className="absolute inset-0 opacity-70"
          style={{ backgroundImage: textureCss.backgroundImage, backgroundSize: textureCss.backgroundSize }}
        />
      ) : null}
      <div
        className="relative flex h-full flex-col justify-between p-1.5"
        style={{ color: forcedForeground ?? '#ffffff' }}
      >
        <div className="flex items-center gap-1">
          {planIcon ? (
            <PlanIconView value={planIcon} className="h-3.5 w-3.5 text-xs" />
          ) : null}
          <span className="truncate text-[9px] font-semibold opacity-95">{planName}</span>
        </div>
        <span
          className="text-[8px] font-medium"
          // No accent → follow the resolved card foreground rather than a
          // hard-coded white, or a dark-text card would print a white sub-line.
          style={
            isHex(style?.accent)
              ? { color: style?.accent as string }
              : { opacity: 0.85 }
          }
        >
          {trafficLimit > 0 ? `${trafficLimit} GB` : '∞'}
          {deviceLimit > 0 ? ` · ${deviceLimit}` : ''}
        </span>
      </div>
    </div>
  )
}

/** Upload a texture image via the existing branding asset endpoint. */
function TextureUploadButton({ onUploaded }: { readonly onUploaded: (url: string) => void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)

  return (
    <label className="inline-flex">
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        aria-label={t('brandingPage.sections.planCards.textureUpload')}
        onChange={async (e) => {
          const file = e.target.files?.[0]
          if (!file) return
          setBusy(true)
          try {
            const form = new FormData()
            form.append('file', file)
            const { data } = await api.post<{ url: string }>('/admin/settings/branding/logo-upload', form, {
              headers: { 'Content-Type': 'multipart/form-data' },
            })
            onUploaded(data.url)
          } catch {
            toast.error(t('brandingPage.sections.planCards.uploadFailed'))
          } finally {
            setBusy(false)
            e.target.value = ''
          }
        }}
      />
      <Button type="button" variant="outline" size="icon" className="h-8 w-8 shrink-0" asChild>
        <span>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        </span>
      </Button>
    </label>
  )
}

function isHex(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^#([0-9a-fA-F]{3,8})$/.test(value.trim())
}

/** The colour swatch can only round-trip opaque hex, which is also all the schema accepts. */
function isOpaqueHex(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim())
}
