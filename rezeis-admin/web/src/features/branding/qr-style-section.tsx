import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Info, QrCode, RotateCcw, ShieldCheck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { relativeLuminance } from '@/lib/qr/kit/qr-options'
import {
  QR_STYLE_PLAIN,
  isPlainStyle,
  isUsableDark,
  qrSvg,
  resolveQrStyle,
  type QrStyle,
} from '@/lib/qr/kit/qr-style'

import {
  BRANDING_QR_EYE_SHAPES,
  BRANDING_QR_MODULE_SHAPES,
  QR_STYLE_PRESETS,
  type BrandingQrStyleDraft,
} from './branding-form-schema'

/**
 * The "QR codes" tab: how the codes a subscriber shows OTHER people look — the
 * referral invite and the partner's advertising code. Never the connect code:
 * VPN apps read that one with the strictest scanners there are, and the
 * cabinet draws it plain whatever is chosen here. The section says so in
 * words, and the preview shows it.
 *
 * NOTHING HERE IS A SECOND RENDERER. The preview, the "what the cabinet would
 * draw" fallback and the contrast verdict all come from the cabinet's own
 * `qr-style.ts`, vendored by `scripts/sync-landing-kit.mjs` (kit `qr`) and
 * byte-frozen by `src/lib/qr/qr-kit-manifest.test.ts`. What the operator
 * approves here is what subscribers are shown, and a colour this tab calls too
 * light is one the API refuses and the cabinet would not draw.
 */

/**
 * What the preview encodes. The referral link has the cabinet's own shape —
 * `${reiwaDomain}/register?ref=${referralCode}` in `referrals-page.tsx` — at an
 * ordinary length, because length decides density and density decides how a
 * style looks. The connect link stands for a subscription URL.
 */
export const QR_PREVIEW_REFERRAL_LINK = 'https://cabinet.example.com/register?ref=K7Q2M9XW'
export const QR_PREVIEW_CONNECT_LINK = 'https://sub.example.com/api/sub/4f9c2a7e1b6d3f80a5c7e2d9'

/**
 * The size the cabinet's invite dialog shows the referral code at (`h-52 w-52`
 * in `invite-link-hero.tsx`). The renderer needs it: below four pixels a module
 * it draws dots as rounded squares, and the preview must show what a
 * subscriber would.
 */
export const QR_PREVIEW_REFERRAL_PX = 208
/** The connect sample is a reminder, not a study, so it is drawn smaller. */
export const QR_PREVIEW_CONNECT_PX = 120

const OPAQUE_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

export interface QrStyleSectionProps {
  readonly value: BrandingQrStyleDraft
  readonly onChange: (next: BrandingQrStyleDraft) => void
  /** What a refused save attached to `qrStyle.dark`, if anything. */
  readonly darkError?: string
}

export function QrStyleSection({ value, onChange, darkError }: QrStyleSectionProps) {
  const { t } = useTranslation()
  const dark = value.dark.trim()
  const wellFormed = OPAQUE_HEX.test(dark)
  const usable = isUsableDark(dark)
  const verdict = !wellFormed ? 'invalid' : usable ? 'ok' : 'too-light'
  // What the cabinet draws for this value — its own reader, so a colour it
  // would not draw shows as the black it would draw instead.
  const drawn = useMemo(() => resolveQrStyle(value), [value])
  const set = (patch: Partial<BrandingQrStyleDraft>): void => onChange({ ...value, ...patch })

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <QrCode className="h-4 w-4" /> {t('brandingPage.qr.title')}
          </CardTitle>
          <CardDescription>{t('brandingPage.qr.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2 rounded-lg border p-3 text-sm">
            <p>{t('brandingPage.qr.appliesTo')}</p>
            <p className="flex gap-2 text-muted-foreground">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {t('brandingPage.qr.connectPlain')}
            </p>
          </div>

          <ChoiceRow
            id="qr-style-presets"
            label={t('brandingPage.qr.presetsLabel')}
            columns="sm:grid-cols-4"
            options={QR_STYLE_PRESETS.map(({ id, style }) => ({
              id,
              label: t(`brandingPage.qr.presets.${id}`),
              pressed: sameStyle(value, style),
              onPick: () => onChange(style),
            }))}
          />

          <div className="space-y-2">
            <ChoiceRow
              id="qr-style-modules"
              label={t('brandingPage.qr.modulesLabel')}
              columns="sm:grid-cols-3"
              options={BRANDING_QR_MODULE_SHAPES.map((id) => ({
                id,
                label: t(`brandingPage.qr.modules.${id}`),
                pressed: value.modules === id,
                onPick: () => set({ modules: id }),
              }))}
            />
            {value.modules === 'dots' && (
              <p className="flex gap-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {t('brandingPage.qr.dotsNote')}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <ChoiceRow
              id="qr-style-eyes"
              label={t('brandingPage.qr.eyesLabel')}
              columns="sm:grid-cols-2"
              options={BRANDING_QR_EYE_SHAPES.map((id) => ({
                id,
                label: t(`brandingPage.qr.eyes.${id}`),
                pressed: value.eyes === id,
                onPick: () => set({ eyes: id }),
              }))}
            />
            <p className="text-xs text-muted-foreground">{t('brandingPage.qr.eyesHint')}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="qr-style-dark">{t('brandingPage.qr.colourLabel')}</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label={t('brandingPage.qr.colourPicker')}
                value={pickerValue(dark)}
                onChange={(event) => set({ dark: event.target.value })}
                className="h-9 w-12 cursor-pointer rounded border bg-transparent p-0.5"
              />
              <Input
                id="qr-style-dark"
                value={value.dark}
                onChange={(event) => set({ dark: event.target.value })}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={!usable || darkError !== undefined}
                aria-describedby="qr-style-contrast"
                className="w-32 font-mono"
              />
            </div>
            <p
              id="qr-style-contrast"
              data-qr-contrast={verdict}
              className={cn(
                'text-xs',
                verdict === 'ok'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-amber-600 dark:text-amber-400',
              )}
            >
              {verdict === 'invalid'
                ? t('brandingPage.qr.colourInvalid')
                : t(verdict === 'ok' ? 'brandingPage.qr.contrastOk' : 'brandingPage.qr.contrastTooLight', {
                    ratio: contrastRatio(dark),
                  })}
            </p>
            <p className="text-xs text-muted-foreground">{t('brandingPage.qr.colourHint')}</p>
            {darkError !== undefined && (
              <p role="alert" className="text-xs text-destructive">
                {darkError}
              </p>
            )}
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange(QR_STYLE_PLAIN)}
            disabled={isPlainStyle(value)}
          >
            <RotateCcw className="mr-2 h-4 w-4" /> {t('brandingPage.qr.reset')}
          </Button>

          <div className="space-y-2">
            <Label>{t('brandingPage.qr.previewLabel')}</Label>
            <div className="flex flex-wrap items-end gap-6">
              <QrSample
                kind="referral"
                text={QR_PREVIEW_REFERRAL_LINK}
                style={drawn}
                displayPixels={QR_PREVIEW_REFERRAL_PX}
                label={t('brandingPage.qr.previewReferral')}
              />
              <QrSample
                kind="connect"
                text={QR_PREVIEW_CONNECT_LINK}
                style={QR_STYLE_PLAIN}
                displayPixels={QR_PREVIEW_CONNECT_PX}
                label={t('brandingPage.qr.previewConnect')}
              />
            </div>
            {!usable && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {t('brandingPage.qr.previewRefused')}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t('brandingPage.qr.previewHint')}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/** A labelled row of toggle buttons; exactly one is pressed when the value matches one. */
function ChoiceRow({
  id,
  label,
  columns,
  options,
}: {
  readonly id: string
  readonly label: string
  readonly columns: string
  readonly options: readonly {
    readonly id: string
    readonly label: string
    readonly pressed: boolean
    readonly onPick: () => void
  }[]
}) {
  const labelId = `${id}-label`
  return (
    <div className="space-y-2">
      <Label id={labelId}>{label}</Label>
      <div role="group" aria-labelledby={labelId} className={cn('grid gap-2', columns)}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={option.pressed}
            onClick={option.onPick}
            className={cn(
              'rounded-lg border p-3 text-left text-sm font-medium transition-colors',
              option.pressed
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-muted-foreground/40',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * One code, drawn by the cabinet's renderer and mounted the way the cabinet
 * mounts it: an SVG data URL in an `<img>` on a white plate
 * (`invite-link-hero.tsx`). The light field of a code is part of the picture a
 * subscriber scans, so the sample does not sit on the panel's own background.
 */
function QrSample({
  kind,
  text,
  style,
  displayPixels,
  label,
}: {
  readonly kind: 'referral' | 'connect'
  readonly text: string
  readonly style: QrStyle
  readonly displayPixels: number
  readonly label: string
}) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    qrSvg(text, style, displayPixels)
      .then((svg) => {
        if (!cancelled) setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
      })
      .catch(() => {
        if (!cancelled) setSrc(null)
      })
    return () => {
      cancelled = true
    }
  }, [text, style, displayPixels])

  return (
    <figure className="flex flex-col items-center gap-2">
      <div className="rounded-2xl border bg-white p-4">
        {src === null ? (
          <div style={{ width: displayPixels, height: displayPixels }} aria-hidden="true" />
        ) : (
          <img
            src={src}
            alt={label}
            width={displayPixels}
            height={displayPixels}
            data-qr-preview={kind}
          />
        )}
      </div>
      <figcaption className="max-w-[220px] text-center text-xs text-muted-foreground">
        {label}
      </figcaption>
    </figure>
  )
}

function sameStyle(a: QrStyle, b: QrStyle): boolean {
  return (
    a.modules === b.modules &&
    a.eyes === b.eyes &&
    a.dark.trim().toLowerCase() === b.dark.toLowerCase()
  )
}

/** `<input type="color">` speaks `#rrggbb` only; anything it cannot show reads as black. */
function pickerValue(hex: string): string {
  if (/^#[0-9a-f]{6}$/i.test(hex)) return hex.toLowerCase()
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    return `#${[...hex.slice(1)].map((c) => c + c).join('')}`.toLowerCase()
  }
  return '#000000'
}

/**
 * Contrast against white, from the same luminance the verdict uses, floored to
 * two places: 6.996:1 must not read as "7.00:1" beside a refusal.
 */
function contrastRatio(hex: string): string {
  const ratio = 1.05 / (relativeLuminance(hex) + 0.05)
  return (Math.floor(ratio * 100) / 100).toFixed(2)
}
