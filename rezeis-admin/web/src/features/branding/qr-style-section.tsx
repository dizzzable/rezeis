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
 * subscriber would. Held to the number the cabinet hands `qrSvg` there by
 * `qr-preview-cabinet.test.ts`.
 */
export const QR_PREVIEW_REFERRAL_PX = 208
/** The connect sample is a reminder, not a study, so it is drawn smaller. */
export const QR_PREVIEW_CONNECT_PX = 120

/**
 * What the partner sample encodes: a web advertising link in the shape the API
 * mints it — `buildAdDeepLinks` in the backend's `tracking-code.util.ts` writes
 * `${miniAppWebBaseUrl}/?campaign=ad_<code>`, and `generateTrackingCode()`
 * mints ten characters. The length is the real one because length decides the
 * symbol version, and the version decides how many pixels a module gets at the
 * partner's size: this link is version 4, where an ordinary bot link
 * (`t.me/<bot>?start=ad_<code>`) lands too.
 *
 * A reserved domain and an invented code. Deliberately not a `t.me/<name>`
 * link: any bot name made up here could be somebody's real bot, and the panel
 * would be handing operators a scannable code that opens it.
 */
export const QR_PREVIEW_PARTNER_LINK = 'https://cabinet.example.com/?campaign=ad_K7Q2M9XWab'

/**
 * The size a partner sees an advertising code at: `<LocalQr size={96}>` on each
 * placement card in the cabinet's `partner-advertising-section.tsx`, one code
 * for the bot link and one for the web link. That leaves this symbol about 2.3
 * pixels a module — too few for the renderer to keep dots — so a "dots" style
 * reaches every partner code as rounded squares while the referral sample
 * shows dots. The operator is shown the partner's code at this size so what
 * they approve is what partners get. It is the size ON THE CARD: where the
 * cabinet lets a partner tap the code open, the enlarged one is a separate
 * drawing at its own size, and this constant does not describe it.
 *
 * Held to the cabinet's source by `qr-preview-cabinet.test.ts`, and it has to
 * be held there: no test of the image can do it. For this link the renderer
 * draws the same bytes at every size from 96 to 163 pixels, so a wrong number
 * here would leave every image-level assertion green.
 */
export const QR_PREVIEW_PARTNER_PX = 96

/**
 * How large the partner's image is shown a second time: the referral sample's
 * size, so the two sit at one scale and dots on one read against rounded
 * squares on the other. A display size only. It is the SAME image, scaled —
 * drawing the code again at this size would put the dots back and show the
 * operator something no partner sees.
 */
export const QR_PREVIEW_PARTNER_MAGNIFIED_PX = QR_PREVIEW_REFERRAL_PX

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
            <PartnerQrSample
              style={drawn}
              label={t('brandingPage.qr.previewPartner')}
              magnifiedLabel={t('brandingPage.qr.previewPartnerMagnified')}
              stepDownNote={t('brandingPage.qr.previewPartnerStepDown')}
            />
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

interface QrImage {
  /** The drawn SVG as a data URL — how the cabinet hands a code to an `<img>`. */
  readonly src: string
  /**
   * The style asked for dots and the drawing has none: the renderer stepped
   * them down to rounded squares for the size the code is shown at. Read off
   * the markup the renderer actually produced, so the panel never restates
   * where that step happens — a renderer that moved it moves this with it.
   */
  readonly dotsReplaced: boolean
}

/**
 * `qrSvg` for one code at one display size, as the cabinet calls it. Answers
 * `null` until the drawing lands, and again if the renderer throws.
 */
function useQrImage(text: string, style: QrStyle, displayPixels: number): QrImage | null {
  const [image, setImage] = useState<QrImage | null>(null)

  useEffect(() => {
    let cancelled = false
    qrSvg(text, style, displayPixels)
      .then((svg) => {
        if (cancelled) return
        setImage({
          src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
          // `style` is the one this drawing was made for, so the flag always
          // describes the image beside it, never a style still being drawn.
          dotsReplaced: style.modules === 'dots' && !svg.includes('<circle'),
        })
      })
      .catch(() => {
        if (!cancelled) setImage(null)
      })
    return () => {
      cancelled = true
    }
  }, [text, style, displayPixels])

  return image
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
  const image = useQrImage(text, style, displayPixels)

  return (
    <figure className="flex flex-col items-center gap-2">
      <div className="rounded-2xl border bg-white p-4">
        {image === null ? (
          <div style={{ width: displayPixels, height: displayPixels }} aria-hidden="true" />
        ) : (
          <img
            src={image.src}
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

/**
 * The partner's advertising code, twice: once at the size a partner sees it on
 * a placement card, and once enlarged so the operator can see its shapes.
 *
 * Both images are ONE drawing. The enlarged one reuses the `src` of the
 * real-size one and only shows it bigger — an SVG scales without inventing
 * anything — so what it magnifies is exactly the code partners get: rounded
 * squares where the style asked for dots, whenever the renderer stepped them
 * down at the partner's size. Drawn again at the larger size, it would show
 * dots that no partner ever sees.
 *
 * The real-size plate is the cabinet's `LocalQr` plate (`rounded-md`, `p-1`),
 * with a border added only so white on the panel's light background still
 * reads as a plate. The enlarged copy repeats nothing a screen reader needs, so
 * it is hidden from one.
 */
function PartnerQrSample({
  style,
  label,
  magnifiedLabel,
  stepDownNote,
}: {
  readonly style: QrStyle
  readonly label: string
  readonly magnifiedLabel: string
  readonly stepDownNote: string
}) {
  const image = useQrImage(QR_PREVIEW_PARTNER_LINK, style, QR_PREVIEW_PARTNER_PX)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-6">
        <figure className="flex flex-col items-center gap-2">
          <div className="overflow-hidden rounded-md border bg-white p-1">
            {image === null ? (
              <div
                style={{ width: QR_PREVIEW_PARTNER_PX, height: QR_PREVIEW_PARTNER_PX }}
                aria-hidden="true"
              />
            ) : (
              <img
                src={image.src}
                alt={label}
                width={QR_PREVIEW_PARTNER_PX}
                height={QR_PREVIEW_PARTNER_PX}
                data-qr-preview="partner"
              />
            )}
          </div>
          <figcaption className="max-w-[220px] text-center text-xs text-muted-foreground">
            {label}
          </figcaption>
        </figure>
        <figure aria-hidden="true" className="flex flex-col items-center gap-2">
          <div className="rounded-2xl border bg-white p-4">
            {image === null ? (
              <div
                style={{
                  width: QR_PREVIEW_PARTNER_MAGNIFIED_PX,
                  height: QR_PREVIEW_PARTNER_MAGNIFIED_PX,
                }}
              />
            ) : (
              <img
                src={image.src}
                alt=""
                aria-hidden="true"
                width={QR_PREVIEW_PARTNER_MAGNIFIED_PX}
                height={QR_PREVIEW_PARTNER_MAGNIFIED_PX}
                data-qr-preview="partner-magnified"
              />
            )}
          </div>
          <figcaption className="max-w-[220px] text-center text-xs text-muted-foreground">
            {magnifiedLabel}
          </figcaption>
        </figure>
      </div>
      {image?.dotsReplaced === true && (
        <p data-qr-step-down="" className="flex gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {stepDownNote}
        </p>
      )}
    </div>
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
