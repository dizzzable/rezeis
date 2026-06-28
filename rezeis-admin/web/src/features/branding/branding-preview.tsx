/**
 * BrandingPreview
 * ───────────────
 * Live phone-frame preview of the reiwa web cabinet. Mirrors the real
 * redesigned dashboard: branded header with the Reiwa mark, an aurora-style
 * subscription card (CSS approximation of the SPA's WebGL Aurora), action
 * buttons and the floating bottom-nav pill — all driven by the branding values
 * the operator is editing, so changes are visible instantly.
 */

import { Suspense, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Wifi, WalletCards, Share2, Settings, Sparkles } from 'lucide-react'

import { ReiwaMark } from './reiwa-mark'
import { CardLogoMark, type CardLogoPreset } from './card-logo-mark'
import {
  CARD_EFFECT_COMPONENTS,
  getCardEffectDefaults,
  type CardEffectId,
} from './card-effect-registry'
import { usePlans, type Plan } from '@/features/plans/plans-api'
import { autoPlanGradient } from './plan-card-styles-section'
import { buildTextureCss } from './app-texture'
import type { PlanCardStyleDraft, BrandingAppBackgroundDraft } from './branding-form-schema'

interface BrandingPreviewProps {
  values: {
    brandName?: string
    logoUrl?: string | null
    primary?: string
    primaryFg?: string
    bgPrimary?: string
    bgSecondary?: string
    cardGradient?: string
    cardPattern?: string | null
    cardLogo?: CardLogoPreset
    cardLogoUrl?: string | null
    cardEffect?: string
    cardEffectProps?: Record<string, unknown>
    cardEffectOpacity?: number
    fontFamily?: string
    borderRadius?: string
    planCardStyles?: Record<string, PlanCardStyleDraft>
    appBackground?: BrandingAppBackgroundDraft
  }
  /** Active configurator tab — drives a context-aware preview view. */
  focus?: string
}

/**
 * Mirrors the SPA's `brandAuroraStops`: a darkened → lightened → darkened triad
 * derived from the brand colour, so the default Aurora effect in the preview
 * tracks the chosen primary (same intent as the live cabinet).
 */
function brandAuroraStops(primary: string): [string, string, string] {
  return [shadeHex(primary, -0.25), shadeHex(primary, 0.35), shadeHex(primary, -0.1)]
}

function shadeHex(hex: string, amount: number): string {
  const m = hex.trim().replace(/^#/, '')
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m
  if (full.length < 6) return hex
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  const mix = (n: number) =>
    amount >= 0 ? Math.round(n + (255 - n) * amount) : Math.round(n * (1 + amount))
  const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`
}

const RADIUS_MAP: Record<string, string> = {
  'rounded-none': '0',
  'rounded-lg': '0.5rem',
  'rounded-xl': '0.75rem',
  'rounded-2xl': '1rem',
  'rounded-3xl': '1.5rem',
  'rounded-full': '9999px',
}

export function BrandingPreview({ values, focus }: BrandingPreviewProps) {
  const { t } = useTranslation()
  const {
    brandName = 'Reiwa',
    logoUrl,
    primary = '#22c55e',
    primaryFg = '#0a0a0a',
    bgPrimary = '#0a0a0a',
    bgSecondary = '#171717',
    cardGradient = 'linear-gradient(135deg, #064e3b 0%, #22c55e 100%)',
    cardPattern,
    cardLogo = 'DEFAULT',
    cardLogoUrl,
    cardEffect = 'aurora',
    cardEffectProps = {},
    cardEffectOpacity = 1,
    fontFamily = 'Geist Variable, system-ui, sans-serif',
    borderRadius = 'rounded-2xl',
    planCardStyles = {},
    appBackground,
  } = values

  const radius = RADIUS_MAP[borderRadius] ?? '1rem'

  // Plans power the context-aware tariff preview (planCards tab). Shared,
  // react-query-cached fetch — free when the section already loaded it.
  const { data: plans } = usePlans()

  // Live site-wide app background (App background tab). Mirrors the cabinet
  // shell: gradient / tiled texture / animated effect / plain colour.
  const AppBgEffect =
    appBackground?.kind === 'effect' &&
    appBackground.effect !== 'NONE' &&
    appBackground.effect in CARD_EFFECT_COMPONENTS
      ? CARD_EFFECT_COMPONENTS[appBackground.effect as CardEffectId]
      : null
  const appBgEffectProps = useMemo<Record<string, unknown>>(() => {
    if (!AppBgEffect || !appBackground) return {}
    const base = { ...getCardEffectDefaults(appBackground.effect), ...appBackground.props }
    if (appBackground.effect === 'aurora' && base['colorStops'] === undefined) {
      return { colorStops: brandAuroraStops(primary), amplitude: 1.1, blend: 0.55, speed: 0.8, ...base }
    }
    return base
  }, [AppBgEffect, appBackground, primary])
  const appBgTextureCss =
    appBackground?.kind === 'texture' ? buildTextureCss(appBackground.texture) : null

  // Resolve the live effect component + merged params, mirroring the SPA: the
  // default Aurora is auto-tinted to the brand colour unless the operator has
  // pinned explicit colorStops.
  const EffectComponent =
    cardEffect !== 'NONE' && cardEffect in CARD_EFFECT_COMPONENTS
      ? CARD_EFFECT_COMPONENTS[cardEffect as CardEffectId]
      : null
  const mergedEffectProps = useMemo<Record<string, unknown>>(() => {
    if (!EffectComponent) return {}
    const base = { ...getCardEffectDefaults(cardEffect), ...cardEffectProps }
    if (cardEffect === 'aurora' && base['colorStops'] === undefined) {
      return { colorStops: brandAuroraStops(primary), amplitude: 1.1, blend: 0.55, speed: 0.8, ...base }
    }
    return base
  }, [EffectComponent, cardEffect, cardEffectProps, primary])

  return (
    <div className="flex flex-col items-center">
      {/* Phone frame */}
      <div
        className="relative w-[300px] overflow-hidden rounded-[2.5rem] border-4 border-zinc-800 shadow-2xl"
        style={{ backgroundColor: bgPrimary, fontFamily }}
      >
        {/* Ambient brand glow */}
        <div
          className="pointer-events-none absolute -top-16 -left-16 h-48 w-48 rounded-full blur-3xl"
          style={{ background: primary, opacity: 0.18 }}
        />

        {/* Live site-wide app background layer (App background tab). */}
        {appBackground && appBackground.kind !== 'none' && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {appBackground.kind === 'gradient' && (
              <div className="absolute inset-0" style={{ backgroundImage: appBackground.gradient }} />
            )}
            {appBgTextureCss && (
              <div
                className="absolute inset-0"
                style={{
                  backgroundColor: appBgTextureCss.backgroundColor,
                  backgroundImage: appBgTextureCss.backgroundImage,
                  backgroundSize: appBgTextureCss.backgroundSize,
                }}
              />
            )}
            {AppBgEffect && (
              <Suspense fallback={null}>
                <div className="absolute inset-0" style={{ opacity: appBackground.opacity }}>
                  <AppBgEffect {...appBgEffectProps} />
                </div>
              </Suspense>
            )}
          </div>
        )}

        {/* Status bar */}
        <div className="relative flex items-center justify-between px-6 pt-3 pb-1">
          <span className="text-[10px] font-medium text-white/50">9:41</span>
          <span className="text-[10px] text-white/50">●●● ▮</span>
        </div>

        {/* Content area */}
        <div className="relative px-4 pb-4">
          {/* Header: logo + brand + actions */}
          <div className="flex items-center justify-between py-3">
            <div className="flex items-center gap-2">
              {logoUrl ? (
                <img src={logoUrl} alt={brandName} className="h-7 w-7 rounded-lg object-contain" />
              ) : (
                <ReiwaMark className="h-7 w-7" style={{ color: primary }} />
              )}
              <div className="leading-tight">
                <p className="text-xs font-semibold text-white">{brandName}</p>
                <p className="text-[9px] text-white/40">
                  {t('brandingPage.sections.preview.welcome')}
                </p>
              </div>
            </div>
            <div className="flex gap-1.5">
              <span className="h-6 w-6 rounded-full border border-white/10 bg-white/5" />
              <span className="h-6 w-6 rounded-full border border-white/10 bg-white/5" />
            </div>
          </div>

          {/* Context-aware body: tariff cards on the planCards tab, else the
              dashboard mock (subscription card + actions + nav). */}
          {focus === 'planCards' ? (
            <TariffListPreview
              plans={(plans ?? []).slice(0, 3)}
              planCardStyles={planCardStyles}
              primary={primary}
              cardLogo={cardLogo}
              cardLogoUrl={cardLogoUrl}
              radius={radius}
              unlimitedLabel={t('brandingPage.sections.planCards.unlimited')}
              emptyLabel={t('brandingPage.sections.planCards.empty')}
            />
          ) : (
            <>
          {/* Subscription card — live effect over the operator gradient */}
          <div
            className="relative h-[160px] overflow-hidden p-4 ring-1 ring-white/10"
            style={{ borderRadius: radius }}
          >
            {/* Static foundation / fallback: dark base + operator gradient */}
            <div className="absolute inset-0" style={{ backgroundColor: '#0b0b0d' }} />
            <div
              className="absolute inset-0"
              style={{ backgroundImage: cardGradient, opacity: 0.85 }}
            />
            {/* Live animated effect layer (the REAL ReactBits effect) */}
            {EffectComponent && (
              <Suspense fallback={null}>
                <div className="absolute inset-0" style={{ opacity: cardEffectOpacity }}>
                  <EffectComponent {...mergedEffectProps} />
                </div>
              </Suspense>
            )}
            <div className="absolute inset-0 bg-linear-to-b from-black/40 via-transparent to-black/60" />
            {cardPattern && cardPattern !== 'none' && (
              <div
                className="absolute inset-0 opacity-40"
                style={{ backgroundImage: cardPattern }}
              />
            )}
            {/* Watermark — operator-configurable glyph or custom image */}
            <CardLogoMark
              preset={cardLogo}
              customUrl={cardLogoUrl}
              className="pointer-events-none absolute -right-4 -bottom-6 h-28 w-28"
              style={{ color: '#ffffff', opacity: 0.12 }}
            />

            {/* Card content */}
            <div className="relative flex h-full flex-col justify-between text-white">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Wifi className="h-3.5 w-3.5 opacity-90" />
                  <span className="text-[11px] font-semibold opacity-95">{brandName}</span>
                </div>
                <span className="rounded-full bg-white/25 px-2 py-0.5 text-[8px] font-bold uppercase backdrop-blur-md">
                  {t('brandingPage.sections.preview.statusLabel')}
                </span>
              </div>

              <p className="font-mono text-sm tracking-[0.18em] opacity-90">
                usr_a1b2c3d4e5f6
              </p>

              <div>
                <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-black/35">
                  <div className="h-full w-2/3 rounded-full bg-white/85" />
                </div>
                <div className="flex items-end justify-between">
                  <div>
                    <p className="text-[8px] uppercase opacity-60">
                      {t('brandingPage.sections.preview.expires')}
                    </p>
                    <p className="text-[11px] font-semibold">03/2026</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[8px] uppercase opacity-60">
                      {t('brandingPage.sections.preview.device')}
                    </p>
                    <p className="text-[11px] font-medium">iPhone 15</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="mt-3 grid grid-cols-3 gap-2">
            {[
              t('brandingPage.sections.preview.actions.buy'),
              t('brandingPage.sections.preview.actions.connect'),
              t('brandingPage.sections.preview.actions.upgrade'),
            ].map((label, i) => (
              <div
                key={label}
                className="flex flex-col items-center gap-1 rounded-2xl py-2.5"
                style={
                  i === 1
                    ? { backgroundColor: primary }
                    : { backgroundColor: `${bgSecondary}cc`, border: '1px solid rgba(255,255,255,0.08)' }
                }
              >
                <div
                  className="h-3.5 w-3.5 rounded-full"
                  style={{ backgroundColor: i === 1 ? primaryFg : primary }}
                />
                <span
                  className="text-[9px] font-medium"
                  style={{ color: i === 1 ? primaryFg : 'rgba(255,255,255,0.6)' }}
                >
                  {label}
                </span>
              </div>
            ))}
          </div>

          {/* Bottom nav pill */}
          <div
            className="mt-4 flex items-center justify-between rounded-full border border-white/10 px-1.5 py-1.5"
            style={{ backgroundColor: `${bgSecondary}e6` }}
          >
            <div
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5"
              style={{ backgroundColor: primary }}
            >
              <WalletCards className="h-3.5 w-3.5" style={{ color: primaryFg }} />
              <span className="text-[9px] font-medium" style={{ color: primaryFg }}>
                {t('brandingPage.sections.preview.nav')}
              </span>
            </div>
            <Share2 className="mx-3 h-3.5 w-3.5 text-white/40" />
            <Settings className="mr-3 h-3.5 w-3.5 text-white/40" />
          </div>
            </>
          )}
        </div>
      </div>

      <p className="mt-3 text-center text-xs text-muted-foreground">
        {t('brandingPage.sections.preview.liveLabel')}
      </p>
    </div>
  )
}

/**
 * Context-aware tariff preview shown on the "Тарифные карточки" tab. Renders up
 * to three plans as cabinet-style cards (gradient + texture + accent + clean
 * icon) using the SAME resolution rules as the reiwa `/plans` page, so the
 * operator sees per-plan edits live in the phone frame.
 */
interface TariffListPreviewProps {
  readonly plans: ReadonlyArray<Plan>
  readonly planCardStyles: Record<string, PlanCardStyleDraft>
  readonly primary: string
  readonly cardLogo: CardLogoPreset
  readonly cardLogoUrl?: string | null
  readonly radius: string
  readonly unlimitedLabel: string
  readonly emptyLabel: string
}

function TariffListPreview({
  plans,
  planCardStyles,
  primary,
  cardLogo,
  cardLogoUrl,
  radius,
  unlimitedLabel,
  emptyLabel,
}: TariffListPreviewProps) {
  if (plans.length === 0) {
    return (
      <div className="mt-2 flex h-[180px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/10 px-4 text-center">
        <Sparkles className="h-6 w-6 text-white/30" />
        <p className="text-[10px] text-white/40">{emptyLabel}</p>
      </div>
    )
  }
  return (
    <div className="mt-2 space-y-2.5">
      {plans.map((plan) => (
        <TariffPreviewCard
          key={plan.id}
          plan={plan}
          style={planCardStyles[plan.id]}
          primary={primary}
          cardLogo={cardLogo}
          cardLogoUrl={cardLogoUrl}
          radius={radius}
          unlimitedLabel={unlimitedLabel}
        />
      ))}
    </div>
  )
}

function TariffPreviewCard({
  plan,
  style,
  primary,
  cardLogo,
  cardLogoUrl,
  radius,
  unlimitedLabel,
}: {
  readonly plan: Plan
  readonly style: PlanCardStyleDraft | undefined
  readonly primary: string
  readonly cardLogo: CardLogoPreset
  readonly cardLogoUrl?: string | null
  readonly radius: string
  readonly unlimitedLabel: string
}) {
  const gradient = style?.gradient && style.gradient.length > 0 ? style.gradient : autoPlanGradient(plan.id)
  const accent = style?.accent && style.accent.length > 0 ? style.accent : primary
  const textureUrl = style?.textureUrl && style.textureUrl.length > 0 ? style.textureUrl : null
  const textureCss =
    !textureUrl && style?.texturePreset
      ? buildTextureCss({
          pattern: style.texturePreset,
          color: accent,
          background: 'transparent',
          scale: 18,
          opacity: 0.5,
        })
      : null
  // A raw emoji / shortcode icon (not a lucide key like "zap") renders as text.
  const isEmoji = !!plan.icon && !/^[a-z0-9_-]+$/i.test(plan.icon)

  return (
    <div
      className="relative overflow-hidden p-3 ring-1 ring-white/10"
      style={{ borderRadius: radius, backgroundImage: gradient }}
    >
      {textureUrl ? (
        <div
          className="absolute inset-0 opacity-25"
          style={{ backgroundImage: `url("${textureUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' }}
        />
      ) : textureCss ? (
        <div
          className="absolute inset-0"
          style={{ backgroundImage: textureCss.backgroundImage, backgroundSize: textureCss.backgroundSize }}
        />
      ) : null}
      <div className="absolute inset-0 bg-linear-to-br from-black/30 via-transparent to-black/55" />
      <CardLogoMark
        preset={cardLogo}
        customUrl={cardLogoUrl}
        className="pointer-events-none absolute -right-3 -bottom-4 h-20 w-20"
        style={{ color: '#ffffff', opacity: 0.12 }}
      />
      <div className="relative flex items-center gap-2.5 text-white">
        <span className="shrink-0 leading-none drop-shadow" style={{ color: accent }}>
          {isEmoji ? (
            <span className="text-xl leading-none">{plan.icon}</span>
          ) : (
            <Sparkles className="h-5 w-5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-semibold drop-shadow">{plan.name}</p>
          <p className="text-[9px] font-medium text-white/80">
            {plan.trafficLimit > 0 ? `${plan.trafficLimit} GB` : unlimitedLabel}
            {plan.deviceLimit > 0 ? ` · ${plan.deviceLimit}` : ''}
          </p>
        </div>
      </div>
    </div>
  )
}
