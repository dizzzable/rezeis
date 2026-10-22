/**
 * «Как шлюз видят клиенты» — the operator's name, the line under it and an SVG
 * icon for a gateway in the cabinet's payment step: buying, renewing, changing
 * the plan and buying add-ons.
 *
 * Operators asked for it (22.10.2026): customers meet «Platega» and «Wata» with
 * «RUB» under them, cannot tell which takes a card or SBP, and are afraid to
 * press any. Each field is optional; empty means the provider's own — the name,
 * the currency code, the logo. The panel's own screens keep the provider's name.
 *
 * The rules live on the server (`gateway-presentation.util.ts`), which refuses
 * with its own codes; this form checks only what it can say before a save —
 * that a file is an SVG and is not too big — and words the server's refusals.
 * The icon is previewed the way the cabinet shows it: an `<img>` with a `data:`
 * URL, where an SVG runs nothing.
 */
import { useRef, type ChangeEvent, type JSX, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ImageUp, Undo2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

/** The server's limits (`gateway-presentation.util.ts`), for the counters and the file check. */
export const GATEWAY_DISPLAY_NAME_MAX = 40
export const GATEWAY_DISPLAY_DESCRIPTION_MAX = 160
export const GATEWAY_ICON_SVG_MAX_BYTES = 32 * 1024

/** What the form holds: empty strings for «the provider's own». */
export interface GatewayPresentationValues {
  readonly name: string
  readonly description: string
  readonly iconSvg: string
}

/** The stored presentation as the form holds it. */
export function presentationOf(gateway: {
  readonly displayName?: string | null
  readonly displayDescription?: string | null
  readonly displayIconSvg?: string | null
}): GatewayPresentationValues {
  return {
    name: gateway.displayName ?? '',
    description: gateway.displayDescription ?? '',
    iconSvg: gateway.displayIconSvg ?? '',
  }
}

/** What the save sends: `null` for an empty field, which the server reads as «the provider's own». */
export function presentationPatch(values: GatewayPresentationValues): {
  readonly displayName: string | null
  readonly displayDescription: string | null
  readonly displayIconSvg: string | null
} {
  const orNull = (value: string): string | null => (value.trim() === '' ? null : value)
  return {
    displayName: orNull(values.name),
    displayDescription: orNull(values.description),
    displayIconSvg: orNull(values.iconSvg),
  }
}

export function samePresentation(left: GatewayPresentationValues, right: GatewayPresentationValues): boolean {
  return left.name === right.name && left.description === right.description && left.iconSvg === right.iconSvg
}

/**
 * The server's refusals of what the customer is to see, and the sentence each
 * has. A `Map`, not an object: a code that arrives is looked up, and an object
 * would answer «constructor».
 */
export const PRESENTATION_REFUSAL_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['PAYMENT_GATEWAY_DISPLAY_NAME_INVALID', 'paymentGateways.presentation.refusals.nameInvalid'],
  ['PAYMENT_GATEWAY_DISPLAY_DESCRIPTION_INVALID', 'paymentGateways.presentation.refusals.descriptionInvalid'],
  ['PAYMENT_GATEWAY_ICON_INVALID', 'paymentGateways.presentation.refusals.iconInvalid'],
  ['PAYMENT_GATEWAY_ICON_TOO_LARGE', 'paymentGateways.presentation.refusals.iconTooLarge'],
  ['PAYMENT_GATEWAY_ICON_UNSAFE', 'paymentGateways.presentation.refusals.iconUnsafe'],
])

/** An SVG as an image source — the only way the cabinet shows the operator's icon. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function codePoints(value: string): number {
  return [...value].length
}

/** A plain number of user units, as `width` and `height` are written by every editor. */
function userUnits(value: string | undefined): number | null {
  if (value === undefined) return null
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(value)
  if (match === null) return null
  const units = Number(match[1])
  return units > 0 ? units : null
}

/**
 * The root `<svg>` as the server leaves it on save (`normalizeGatewayIconSvg`):
 * the SVG namespace added where it is missing — without it a browser draws no
 * image at all — and a `viewBox` from plain `width` and `height` where there is
 * none, so the icon scales instead of being cut. Done to the uploaded file
 * before it is previewed, so the preview is the icon the customer will get,
 * not an empty box until the first save.
 */
export function withImageRootAttributes(svg: string): string {
  const root = /<svg\b[^>]*>/.exec(svg)
  if (root === null) return svg
  const tag = root[0]
  const attribute = (name: string): string | undefined =>
    new RegExp(`\\s${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(tag)?.[2]
  const additions: string[] = []
  if (attribute('xmlns') === undefined) additions.push('xmlns="http://www.w3.org/2000/svg"')
  if (attribute('viewBox') === undefined) {
    const width = userUnits(attribute('width'))
    const height = userUnits(attribute('height'))
    if (width !== null && height !== null) additions.push(`viewBox="0 0 ${width} ${height}"`)
  }
  if (additions.length === 0) return svg
  return `${svg.slice(0, root.index)}<svg ${additions.join(' ')}${tag.slice('<svg'.length)}${svg.slice(root.index + tag.length)}`
}

export function GatewayCustomerPresentation({
  providerName,
  currency,
  providerIcon,
  values,
  onChange,
}: {
  /** What the customer sees with no name set: the provider's own. */
  readonly providerName: string
  /** What the customer sees under it with no line set. */
  readonly currency: string
  /** The provider's logo, shown where no icon is set. */
  readonly providerIcon: ReactNode
  readonly values: GatewayPresentationValues
  readonly onChange: (next: GatewayPresentationValues) => void
}): JSX.Element {
  const { t } = useTranslation()
  const fileInput = useRef<HTMLInputElement>(null)

  async function readIcon(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    // The same file chosen again is a change too.
    event.target.value = ''
    if (file === undefined) return
    if (file.size > GATEWAY_ICON_SVG_MAX_BYTES) {
      toast.error(t('paymentGateways.presentation.refusals.iconTooLarge'))
      return
    }
    let text: string
    try {
      text = await file.text()
    } catch {
      toast.error(t('paymentGateways.presentation.iconReadFailed'))
      return
    }
    if (!/<svg[\s>]/.test(text) || !/<\/svg>\s*$/.test(text)) {
      toast.error(t('paymentGateways.presentation.refusals.iconInvalid'))
      return
    }
    onChange({ ...values, iconSvg: withImageRootAttributes(text.trim()) })
  }

  const shownName = values.name.trim() === '' ? providerName : values.name.trim()
  const shownLine = values.description.trim() === '' ? currency : values.description.trim()

  return (
    <div
      data-testid="gateway-customer-presentation"
      className="space-y-3 rounded-lg border border-border/60 bg-muted/10 p-3"
    >
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{t('paymentGateways.presentation.title')}</p>
        <p className="text-xs text-muted-foreground">{t('paymentGateways.presentation.description')}</p>
      </div>

      {/* The cabinet's row, drawn the way the cabinet draws it. */}
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">{t('paymentGateways.presentation.preview')}</p>
        <div
          data-testid="gateway-customer-preview"
          className="flex items-center gap-4 rounded-2xl border border-border/60 bg-background p-4"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center">
            {values.iconSvg === '' ? (
              providerIcon
            ) : (
              <img
                data-testid="gateway-custom-icon"
                src={svgDataUrl(values.iconSvg)}
                alt=""
                aria-hidden
                className="h-7 w-7 object-contain"
              />
            )}
          </span>
          <div className="min-w-0 text-left">
            <p className="truncate font-medium">{shownName}</p>
            <p className="whitespace-pre-line text-xs text-muted-foreground">{shownLine}</p>
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="gateway-display-name">{t('paymentGateways.presentation.name')}</Label>
        <Input
          id="gateway-display-name"
          value={values.name}
          placeholder={t('paymentGateways.presentation.namePlaceholder')}
          onChange={(event): void => onChange({ ...values, name: event.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          {t('paymentGateways.presentation.nameHint', {
            used: codePoints(values.name.trim()),
            max: GATEWAY_DISPLAY_NAME_MAX,
          })}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="gateway-display-description">{t('paymentGateways.presentation.line')}</Label>
        <Textarea
          id="gateway-display-description"
          rows={3}
          className="min-h-[64px]"
          value={values.description}
          placeholder={t('paymentGateways.presentation.linePlaceholder')}
          onChange={(event): void => onChange({ ...values, description: event.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          {t('paymentGateways.presentation.lineHint', {
            currency,
            used: codePoints(values.description.trim()),
            max: GATEWAY_DISPLAY_DESCRIPTION_MAX,
          })}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>{t('paymentGateways.presentation.icon')}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept=".svg,image/svg+xml"
            className="hidden"
            data-testid="gateway-icon-file"
            onChange={(event): void => void readIcon(event)}
          />
          <Button type="button" variant="outline" size="sm" onClick={(): void => fileInput.current?.click()}>
            <ImageUp className="mr-2 h-4 w-4" />
            {values.iconSvg === ''
              ? t('paymentGateways.presentation.iconUpload')
              : t('paymentGateways.presentation.iconReplace')}
          </Button>
          {values.iconSvg !== '' && (
            <Button type="button" variant="ghost" size="sm" onClick={(): void => onChange({ ...values, iconSvg: '' })}>
              <Undo2 className="mr-2 h-4 w-4" />
              {t('paymentGateways.presentation.iconRemove')}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t('paymentGateways.presentation.iconHint')}</p>
      </div>
    </div>
  )
}
