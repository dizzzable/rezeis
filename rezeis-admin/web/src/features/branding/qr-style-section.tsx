import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ImageUp, Info, Loader2, QrCode, RefreshCw, RotateCcw, ShieldCheck, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { LOGO_SVG_MAX_BYTES, useQrLogoHref } from '@/lib/qr/kit/qr-logo-source'
import { relativeLuminance } from '@/lib/qr/kit/qr-options'
import {
  QR_STYLE_PLAIN,
  isPlainStyle,
  isQrLogoSrc,
  isUsableDark,
  qrSvg,
  resolveQrStyle,
  type QrLogo,
  type QrStyle,
} from '@/lib/qr/kit/qr-style'

import { BRANDING_RASTER_MAX_BYTES } from './branding-asset-field'
import {
  BRANDING_QR_EYE_SHAPES,
  BRANDING_QR_LOGO_PLATES,
  BRANDING_QR_LOGO_SIZES,
  BRANDING_QR_MODULE_SHAPES,
  QR_STYLE_PRESETS,
  applyQrStylePreset,
  type BrandingQrStyleDraft,
  type QrStylePreset,
} from './branding-form-schema'
import { formatByteLimit } from './format-byte-limit'
import { qrLogoCheckKey, qrLogoVerdictMessage, type QrLogoCheckStore, type QrLogoVerdict } from './qr-logo-check'
import { qrLogoWithSrc, type QrLogoUploadRefusal, type QrLogoUploadStore } from './qr-logo-upload'

/**
 * The "QR codes" tab: how the codes a subscriber shows OTHER people look — the
 * referral invite and the partner's advertising code. Never the connect code:
 * VPN apps read that one with the strictest scanners there are, and the
 * cabinet draws it plain whatever is chosen here. The section says so in
 * words, and the preview shows it.
 *
 * NOTHING HERE IS A SECOND RENDERER. The preview, the "what the cabinet would
 * draw" fallback, the contrast verdict, the logo's plan and the logo's loading
 * all come from the cabinet's own `qr-style.ts`, `qr-logo.ts` and
 * `qr-logo-source.ts`, vendored by `scripts/sync-landing-kit.mjs` (kit `qr`)
 * and byte-frozen by `src/lib/qr/qr-kit-manifest.test.ts`. What the operator
 * approves here is what subscribers are shown, and a colour this tab calls too
 * light is one the API refuses and the cabinet would not draw.
 *
 * THE LOGO IS CHECKED BY DECODING. Picking a logo, or changing anything about
 * a style that carries one, starts `qr-logo-check.ts` on it: hundreds of
 * synthetic links of every shape the cabinet encodes, at every size it shows a
 * logo at, read back by a real QR reader with and without the logo. The page
 * will not save a logo whose check has not passed (`qrLogoSaveRefusal`).
 */

/**
 * What the preview encodes. The referral link has the cabinet's own shape —
 * `${reiwaDomain}/register?ref=${referralCode}` in `referrals-page.tsx` — at its
 * real length: the code is a Prisma `cuid()` (`User.referralCode`), 25
 * characters, and length decides density, density decides how a style looks
 * and whether a logo fits. The connect link stands for a subscription URL.
 */
export const QR_PREVIEW_REFERRAL_LINK = 'https://cabinet.example.com/register?ref=clx8k2m9q0000a1b2c3d4e5f6'
export const QR_PREVIEW_CONNECT_LINK = 'https://sub.example.com/api/sub/4f9c2a7e1b6d3f80a5c7e2d9'

/**
 * The size the cabinet's invite dialog shows the referral code at — the kit's
 * `LOGO_DISPLAY_PIXELS.referralInvite`, which `invite-link-hero.tsx` hands
 * `qrSvg`. The renderer needs it: below four pixels a module it draws dots as
 * rounded squares, the planner decides from it whether a logo fits, and the
 * preview must show what a subscriber would. A literal, so it stays a constant
 * export for fast refresh; `qr-preview-cabinet.test.ts` holds it to the kit's
 * number and to the number the cabinet actually passes.
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
 * pixels a module — too few for the renderer to keep dots, and far too few for
 * a logo — so a "dots" style reaches every partner card as rounded squares
 * while the referral sample shows dots. The operator is shown the partner's
 * code at this size so what they approve is what partners get. It is the size
 * ON THE CARD: the code a partner taps open is a separate drawing at
 * `QR_PREVIEW_PARTNER_ENLARGED_PX`.
 *
 * Held by `qr-preview-cabinet.test.ts` to a record of the cabinet's number in
 * every run, and the record to the cabinet's source wherever both checkouts
 * are present — and it has to be held that way: no test of the image can do
 * it. For this link the renderer draws the same bytes at every size from 96 to
 * 163 pixels, so a wrong number here would leave every image-level assertion
 * green.
 */
export const QR_PREVIEW_PARTNER_PX = 96

/**
 * How large the partner's card image is shown a second time: the referral
 * sample's size, so the two sit at one scale and dots on one read against
 * rounded squares on the other. A display size only. It is the SAME image,
 * scaled — drawing the code again at this size would put the dots back and
 * show the operator something no partner sees on the card.
 */
export const QR_PREVIEW_PARTNER_MAGNIFIED_PX = QR_PREVIEW_REFERRAL_PX

/**
 * The size the cabinet draws a partner's code at when the partner taps it open
 * (`partner-qr-dialog.tsx`, `ENLARGED_PARTNER_QR_PIXELS`) — the kit's
 * `LOGO_DISPLAY_PIXELS.partnerEnlarged`. A drawing of its own, in the style,
 * with the logo wherever the planner finds room: the code partners actually
 * put in front of a camera. A literal for the same reason as the referral
 * size, held to both numbers by the same test.
 */
export const QR_PREVIEW_PARTNER_ENLARGED_PX = 256

/** How long a style must stay put before its logo is checked — typing a colour is not six checks. */
const LOGO_CHECK_DEBOUNCE_MS = 400

const OPAQUE_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

export interface QrStyleSectionProps {
  readonly value: BrandingQrStyleDraft
  readonly onChange: (next: BrandingQrStyleDraft) => void
  /** What a refused save attached to `qrStyle.dark`, if anything. */
  readonly darkError?: string
  /** What a refused save attached to `qrStyle.logo` — its address, size or plate, or its check — if anything. */
  readonly logoError?: string
  /** The brand logo (`logoUrl`), offered as the QR logo when it is an upload the cabinet relays. */
  readonly brandLogoUrl?: string | null
  /**
   * Uploads a QR logo — the page's, because an upload outlives this tab: it
   * lands in the style as it stands when it finishes, and the tab mounted
   * again still shows it running, or what refused it (`qr-logo-upload.ts`).
   */
  readonly logoUpload: QrLogoUploadStore
  /** Runs and remembers the logo checks — the page's, so its save reads the same verdicts. */
  readonly logoCheck: QrLogoCheckStore
}

export function QrStyleSection({
  value,
  onChange,
  darkError,
  logoError,
  brandLogoUrl = null,
  logoUpload,
  logoCheck,
}: QrStyleSectionProps) {
  const { t } = useTranslation()
  const dark = value.dark.trim()
  const wellFormed = OPAQUE_HEX.test(dark)
  const usable = isUsableDark(dark)
  const verdict = !wellFormed ? 'invalid' : usable ? 'ok' : 'too-light'
  // What the cabinet draws for this value — its own reader, so a colour it
  // would not draw shows as the black it would draw instead.
  const drawn = useMemo(() => resolveQrStyle(value), [value])
  const set = (patch: Partial<BrandingQrStyleDraft>): void => onChange({ ...value, ...patch })

  const logoKey = qrLogoCheckKey(drawn)
  useEffect(() => {
    if (logoKey === null) return undefined
    // Asking again for a style that already has a verdict is a no-op, so a
    // new `drawn` with the same key costs a timer and nothing else.
    const timer = setTimeout(() => logoCheck.request(drawn), LOGO_CHECK_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [drawn, logoKey, logoCheck])
  const logoVerdict = useSyncExternalStore(logoCheck.subscribe, () => logoCheck.verdict(drawn))

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
              // A preset restyles the code around the operator's logo; it never takes it away.
              onPick: () => onChange(applyQrStylePreset(value, style)),
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

          <QrLogoControls
            logo={value.logo}
            onLogoChange={(logo) => onChange({ ...value, logo })}
            logoError={logoError}
            brandLogoUrl={brandLogoUrl}
            logoUpload={logoUpload}
            verdict={logoVerdict}
            onRetry={() => logoCheck.retry(drawn)}
          />

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              // "Logo and all" — including a logo still uploading, or what refused one.
              logoUpload.supersede()
              onChange(QR_STYLE_PLAIN)
            }}
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
                withLogo
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
            <div className="flex flex-wrap items-end gap-6">
              <QrSample
                kind="partner-enlarged"
                text={QR_PREVIEW_PARTNER_LINK}
                style={drawn}
                displayPixels={QR_PREVIEW_PARTNER_ENLARGED_PX}
                label={t('brandingPage.qr.previewPartnerEnlarged')}
                withLogo
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

/**
 * The logo: upload one, take the brand logo, choose its size and what it sits
 * on, take it away — and what the check found. Everything a refused save says
 * about `qrStyle.logo` is shown here, beside the controls that can fix it.
 */
function QrLogoControls({
  logo,
  onLogoChange,
  logoError,
  brandLogoUrl,
  logoUpload,
  verdict,
  onRetry,
}: {
  readonly logo: QrLogo | null
  readonly onLogoChange: (logo: QrLogo | null) => void
  readonly logoError: string | undefined
  readonly brandLogoUrl: string | null
  readonly logoUpload: QrLogoUploadStore
  readonly verdict: QrLogoVerdict | undefined
  readonly onRetry: () => void
}) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const upload = useSyncExternalStore(logoUpload.subscribe, logoUpload.state)
  const uploading = upload.uploading
  const refusal = upload.refusal === null ? null : uploadRefusalMessage(t, upload.refusal)
  const brandLogoUsable = isQrLogoSrc(brandLogoUrl)

  const onSelect = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    if (file !== undefined) logoUpload.pick(file)
    event.target.value = ''
  }

  const errorId = 'qr-logo-error'
  return (
    <div className="space-y-3" data-qr-logo-controls="">
      <div className="space-y-1">
        <Label id="qr-logo-label">{t('brandingPage.qr.logo.label')}</Label>
        <p className="text-xs text-muted-foreground">{t('brandingPage.qr.logo.hint')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {logo === null ? (
          <p className="text-xs text-muted-foreground" data-qr-logo-none="">
            {t('brandingPage.qr.logo.none')}
          </p>
        ) : (
          <figure className="flex items-center gap-3">
            <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-md border bg-white p-1">
              <img
                src={logo.src}
                alt={t('brandingPage.qr.logo.current')}
                className="h-full w-full object-contain"
                data-qr-logo-thumbnail=""
              />
            </div>
            <figcaption className="max-w-[16rem] break-all font-mono text-[11px] text-muted-foreground">
              {logo.src}
            </figcaption>
          </figure>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            aria-invalid={logoError !== undefined || refusal !== null}
            aria-describedby={logoError !== undefined ? errorId : undefined}
          >
            {uploading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <ImageUp className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            {uploading
              ? t('brandingPage.qr.logo.uploading')
              : t(logo === null ? 'brandingPage.qr.logo.upload' : 'brandingPage.qr.logo.replace')}
          </Button>
          {brandLogoUrl !== null && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!brandLogoUsable || logo?.src === brandLogoUrl}
              onClick={() => {
                if (!isQrLogoSrc(brandLogoUrl)) return
                logoUpload.supersede()
                onLogoChange(qrLogoWithSrc(logo, brandLogoUrl))
              }}
            >
              {t('brandingPage.qr.logo.useBrandLogo')}
            </Button>
          )}
          {logo !== null && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                logoUpload.supersede()
                onLogoChange(null)
              }}
            >
              <X className="mr-2 h-4 w-4" aria-hidden="true" /> {t('brandingPage.qr.logo.remove')}
            </Button>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/webp,image/svg+xml"
          className="hidden"
          data-qr-logo-file=""
          onChange={onSelect}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t('brandingPage.qr.logo.limits', {
          raster: formatByteLimit(BRANDING_RASTER_MAX_BYTES),
          svg: formatByteLimit(LOGO_SVG_MAX_BYTES),
        })}
      </p>
      {brandLogoUrl !== null && !brandLogoUsable && (
        <p className="text-[11px] text-muted-foreground">{t('brandingPage.qr.logo.brandLogoUnusable')}</p>
      )}
      {refusal !== null && (
        <p role="alert" className="text-xs text-destructive" data-qr-logo-refusal="">
          {refusal}
        </p>
      )}

      {logo !== null && (
        <>
          <ChoiceRow
            id="qr-logo-size"
            label={t('brandingPage.qr.logo.sizeLabel')}
            columns="sm:grid-cols-2"
            options={BRANDING_QR_LOGO_SIZES.map((id) => ({
              id,
              label: t(`brandingPage.qr.logo.sizes.${id}`),
              pressed: logo.size === id,
              onPick: () => onLogoChange({ ...logo, size: id }),
            }))}
          />
          <ChoiceRow
            id="qr-logo-plate"
            label={t('brandingPage.qr.logo.plateLabel')}
            columns="sm:grid-cols-2"
            options={BRANDING_QR_LOGO_PLATES.map((id) => ({
              id,
              label: t(`brandingPage.qr.logo.plates.${id}`),
              pressed: logo.plate === id,
              onPick: () => onLogoChange({ ...logo, plate: id }),
            }))}
          />
          <QrLogoCheckStatus verdict={verdict} onRetry={onRetry} />
        </>
      )}

      {logoError !== undefined && (
        <p id={errorId} role="alert" className="text-xs text-destructive" data-qr-logo-error="">
          {logoError}
        </p>
      )}
    </div>
  )
}

/** What the operator is told about an upload that did not become the logo. */
function uploadRefusalMessage(
  t: (key: string, options?: Record<string, unknown>) => string,
  refusal: QrLogoUploadRefusal,
): string {
  switch (refusal.kind) {
    case 'too-large':
      return t(refusal.svg ? 'brandingPage.qr.logo.tooLargeSvg' : 'brandingPage.qr.logo.tooLargeRaster', {
        actual: formatByteLimit(refusal.bytes),
        limit: formatByteLimit(refusal.limit),
      })
    case 'refused':
      return refusal.message
    case 'failed':
      return t('brandingPage.qr.logo.uploadFailed')
  }
}

/** What the check is doing, or what it found, with the numbers it found it with. */
function QrLogoCheckStatus({
  verdict,
  onRetry,
}: {
  readonly verdict: QrLogoVerdict | undefined
  readonly onRetry: () => void
}) {
  const { t } = useTranslation()
  if (verdict === undefined) return null
  if (verdict.status === 'checking') {
    const share = verdict.total > 0 ? Math.round((verdict.done / verdict.total) * 100) : 0
    return (
      <div className="space-y-1.5" data-qr-logo-check="checking">
        <Progress value={share} className="h-1.5" aria-label={t('brandingPage.qr.logo.check.progress')} />
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {t('brandingPage.qr.logo.check.checking', { done: verdict.done, total: verdict.total })}
        </p>
      </div>
    )
  }
  const passed = verdict.status === 'passed'
  return (
    <div className="space-y-1.5" data-qr-logo-check={verdict.status}>
      <p
        className={cn(
          'text-xs',
          passed ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive',
        )}
        aria-live="polite"
      >
        {qrLogoVerdictMessage(t, verdict)}
      </p>
      {verdict.status === 'failed' && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="mr-2 h-3.5 w-3.5" aria-hidden="true" /> {t('brandingPage.qr.logo.check.retry')}
        </Button>
      )}
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
 * `qrSvg` for one code at one display size, as the cabinet calls it — with the
 * loaded logo, where the caller has one. Answers `null` until the drawing
 * lands, and again if the renderer throws.
 */
function useQrImage(text: string, style: QrStyle, displayPixels: number, logoHref?: string): QrImage | null {
  const [image, setImage] = useState<QrImage | null>(null)

  useEffect(() => {
    let cancelled = false
    qrSvg(text, style, displayPixels, logoHref)
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
  }, [text, style, displayPixels, logoHref])

  return image
}

/**
 * One code, drawn by the cabinet's renderer and mounted the way the cabinet
 * mounts it: an SVG data URL in an `<img>` on a white plate
 * (`invite-link-hero.tsx`). The light field of a code is part of the picture a
 * subscriber scans, so the sample does not sit on the panel's own background.
 *
 * `withLogo` samples carry the style's logo exactly as the cabinet's do: the
 * kit's `useQrLogoHref` loads it only where the kit's planner finds room at
 * this size, and `qrSvg` draws the logo-less code until it has loaded.
 */
function QrSample({
  kind,
  text,
  style,
  displayPixels,
  label,
  withLogo = false,
}: {
  readonly kind: 'referral' | 'connect' | 'partner-enlarged'
  readonly text: string
  readonly style: QrStyle
  readonly displayPixels: number
  readonly label: string
  readonly withLogo?: boolean
}) {
  const logoHref = useQrLogoHref(text, withLogo ? style : QR_STYLE_PLAIN, displayPixels)
  const image = useQrImage(text, style, displayPixels, withLogo ? logoHref : undefined)

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
      <figcaption className="max-w-[260px] text-center text-xs text-muted-foreground">
        {label}
      </figcaption>
    </figure>
  )
}

/**
 * The partner's advertising code as it sits on a placement card, twice: once
 * at the size a partner sees it there, and once enlarged so the operator can
 * see its shapes.
 *
 * Both images are ONE drawing. The enlarged one reuses the `src` of the
 * real-size one and only shows it bigger — an SVG scales without inventing
 * anything — so what it magnifies is exactly the code partners get on the
 * card: rounded squares where the style asked for dots, whenever the renderer
 * stepped them down at the partner's size, and never a logo, for which a card
 * code has no room. Drawn again at the larger size, it would show dots that no
 * partner sees on the card. (The code a partner taps open is the separate
 * `partner-enlarged` sample.)
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
  // No logo: `LocalQr`, which draws the card's code, has no way to pass one.
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

/** Whether the drawing members match a preset's — the logo is not a preset's to match. */
function sameStyle(a: QrStyle, b: QrStylePreset): boolean {
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
