/**
 * BrandingAssetField — one image slot on the branding page: a drop target that
 * also opens a file picker, the URL it resolved to, and a read-out of what was
 * actually uploaded.
 *
 * The read-out is the point. Three separate reports came down to the same gap:
 * the panel accepted a file and then said nothing about it, so "what size
 * should the logo be?" had no answer anywhere in the product, and an operator
 * whose export carried its own padding had no way to tell a small mark from a
 * small artboard. The intrinsic dimensions are measured off the rendered image,
 * so they are reported for a file uploaded a moment ago and for one uploaded
 * last month, with no server round-trip either way.
 */
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { Loader2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/**
 * Byte ceilings the server enforces, mirrored here so the operator learns them
 * BEFORE picking a file rather than after waiting for an upload.
 *
 * These are copies of server constants and are guidance only — the server stays
 * the authority and re-checks every byte. They are written out rather than
 * fetched because they are compile-time constants over there too, and a round
 * trip to learn them would not make the number any more current.
 *
 *   raster: `MAX_FILE_SIZE`   — src/modules/settings/services/branding-asset-upload.service.ts:28
 *   svg:    `SVG_MAX_BYTES`   — src/modules/settings/services/icon-upload.service.ts:172
 *
 * The two differ by 4×, and that gap is the whole defect: the slots advertised
 * "up to 2 MB", accepted `image/svg+xml`, and then `assertSafeSvg` refused
 * anything over 512 KB. A 1024×1024 design-tool SVG export routinely lands
 * between the two, so the operator picked a file, waited, and was rejected by a
 * limit the panel had never mentioned.
 */
export const BRANDING_RASTER_MAX_BYTES = 2 * 1024 * 1024;
export const BRANDING_SVG_MAX_BYTES = 512 * 1024;

/** What a slot expects, so the field can say whether the file measures up. */
export interface BrandingAssetAdvice {
  /** Shortest side the slot wants, in pixels. Raster only — vectors scale. */
  readonly minPx?: number
  /** Whether a non-square file is worth warning about (PWA / watermark slots). */
  readonly square?: boolean
}

export interface BrandingAssetFieldProps {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly accept: string
  readonly value: string | null
  readonly onChange: (url: string | null) => void
  readonly upload: (file: File) => Promise<string>
  readonly advice?: BrandingAssetAdvice
  /** Rendered between the drop zone and the URL row — e.g. a live tile preview. */
  readonly children?: React.ReactNode
  readonly urlPlaceholder: string
  readonly invalid?: boolean
}

interface MeasuredAsset {
  readonly width: number
  readonly height: number
}

export function BrandingAssetField({
  id,
  label,
  hint,
  accept,
  value,
  onChange,
  upload,
  advice,
  children,
  urlPlaceholder,
  invalid,
}: BrandingAssetFieldProps): JSX.Element {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [measured, setMeasured] = useState<MeasuredAsset | null>(null)
  const [settledValue, setSettledValue] = useState<string | null>(value)
  const [oversize, setOversize] = useState<OversizeRejection | null>(null)

  // Derived from `accept`, not from a prop of its own: a slot that starts
  // accepting SVG then gets the SVG limit stated automatically, and one that
  // stops accepting it stops claiming a limit that no longer applies. There is
  // nothing per-slot left to forget to pass.
  const acceptsSvg = accept.toLowerCase().includes('image/svg+xml')

  /**
   * The URL box is controlled and commits on every keystroke, and the measurer
   * below is a real `<img src>`. Without this delay, hand-typing
   * `https://cdn.example.com/logo.png` fired a request per character from the
   * eighth onwards — a console full of failures, and a partially-typed internal
   * hostname leaked outward as a sequence of lookups to unintended hosts. The
   * previous guard only excluded the first seven characters, which is to say it
   * excluded nothing that mattered.
   *
   * An upload or a paste settles immediately on the next tick; only typing
   * pays the delay, and only once.
   */
  useEffect(() => {
    if (value === settledValue) return undefined
    const timer = setTimeout(() => setSettledValue(value), 600)
    return () => clearTimeout(timer)
  }, [value, settledValue])

  const mutation = useMutation({
    mutationFn: upload,
    onSuccess: (url) => {
      // The measurement belongs to the previous file; drop it so a stale
      // "1024 × 1024" cannot sit under a mark that is now 64 × 64.
      setMeasured(null)
      setSettledValue(url)
      onChange(url)
      toast.success(t('brandingPage.sections.identity.uploadSuccess'))
    },
    onError: (error: unknown) => {
      const message = (error as { response?: { data?: { message?: string } } })?.response?.data
        ?.message
      toast.error(message ?? t('brandingPage.sections.identity.uploadFailed'))
    },
  })

  function acceptFiles(files: FileList | null | undefined): void {
    const file = files?.[0]
    if (!file) return
    // Guidance, never the gate. The server re-checks every byte and is the only
    // thing that decides; this exists so a 900 KB SVG is refused in the browser,
    // by name and by number, instead of after an upload the operator had no
    // reason to expect would fail.
    const rejection = oversizeRejection(file)
    if (rejection !== null) {
      setOversize(rejection)
      toast.error(describeOversize(t, rejection))
      return
    }
    setOversize(null)
    mutation.mutate(file)
  }

  function onDrop(event: DragEvent<HTMLButtonElement>): void {
    event.preventDefault()
    setIsDragging(false)
    acceptFiles(event.dataTransfer?.files)
  }

  function onSelect(event: ChangeEvent<HTMLInputElement>): void {
    acceptFiles(event.target.files)
    event.target.value = ''
  }

  const warning = measured ? assetWarning(measured, advice, isVector(settledValue)) : null

  return (
    <div className="space-y-3">
      <Label htmlFor={id}>{label}</Label>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <button
          type="button"
          data-branding-asset-dropzone={id}
          onDragOver={(event) => {
            event.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          aria-label={`${t('brandingPage.sections.identity.dropHere')} — ${label}`}
          disabled={mutation.isPending}
          className={cn(
            'flex min-h-[104px] flex-1 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-4 text-center transition-colors',
            isDragging
              ? 'border-primary bg-primary/10'
              : 'border-border hover:border-primary/60 hover:bg-accent/40',
          )}
        >
          {mutation.isPending ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <Upload className="h-5 w-5 text-muted-foreground" />
          )}
          <span className="text-sm font-medium">
            {mutation.isPending
              ? t('brandingPage.sections.identity.uploading')
              : t('brandingPage.sections.identity.dropHere')}
          </span>
          <span className="text-[11px] text-muted-foreground">{hint}</span>
          {/* Stated on the drop zone itself, so it is on screen at the moment
              the operator decides which file to pick — the one moment at which
              knowing the ceiling changes what they do. */}
          <span className="text-[11px] text-muted-foreground" data-branding-asset-limits={id}>
            {acceptsSvg
              ? t('brandingPage.sections.identity.sizeLimits', {
                  raster: formatByteLimit(BRANDING_RASTER_MAX_BYTES),
                  svg: formatByteLimit(BRANDING_SVG_MAX_BYTES),
                })
              : t('brandingPage.sections.identity.sizeLimitsRaster', {
                  raster: formatByteLimit(BRANDING_RASTER_MAX_BYTES),
                })}
          </span>
        </button>

        {children}
      </div>

      {oversize ? (
        <p className="text-[11px] text-destructive" data-branding-asset-oversize={id}>
          {describeOversize(t, oversize)}
        </p>
      ) : null}

      <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={onSelect} />

      <div className="flex gap-2">
        <Input
          id={id}
          value={value ?? ''}
          aria-invalid={invalid}
          placeholder={urlPlaceholder}
          className="font-mono text-xs"
          onChange={(event) => {
            const next = event.target.value.trim()
            setMeasured(null)
            onChange(next.length > 0 ? next : null)
          }}
        />
        {value ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={`${t('brandingPage.sections.identity.remove')} — ${label}`}
            onClick={() => {
              setMeasured(null)
              onChange(null)
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      {/* Off-screen measurer: the only reader of the file's intrinsic size.
          `naturalWidth` is 0 for an SVG with no intrinsic dimensions, which is
          reported as "vector" rather than as a bogus 0 × 0.

          Gated on the value looking like a reference the browser could resolve,
          because the URL box is controlled and fires on every keystroke: an
          ungated measurer would issue one failed request per character typed
          into it, against whatever prefix existed at that moment. */}
      {measurable(settledValue) ? (
        <img
          src={settledValue}
          alt=""
          aria-hidden
          className="hidden"
          onLoad={(event) => {
            const image = event.currentTarget
            setMeasured({ width: image.naturalWidth, height: image.naturalHeight })
          }}
          onError={() => setMeasured(null)}
        />
      ) : null}

      {/* Only once a measurement really came back. Showing this row for any
          non-empty value would caption a half-typed URL, or one that failed to
          load, as "vector file — scales without loss": a statement about a file
          nothing has read. */}
      {measured ? (
        <p className="text-[11px] text-muted-foreground" data-branding-asset-readout={id}>
          {measured.width > 0 && measured.height > 0
            ? t('brandingPage.sections.identity.measured', {
                width: measured.width,
                height: measured.height,
              })
            : t('brandingPage.sections.identity.measuredVector')}
        </p>
      ) : null}

      {warning ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-500" data-branding-asset-warning={id}>
          {t(`brandingPage.sections.identity.${warning.key}`, warning.params)}
        </p>
      ) : null}
    </div>
  )
}

interface OversizeRejection {
  /** Which ceiling was crossed — the two carry different advice. */
  readonly kind: 'svg' | 'raster'
  readonly actualBytes: number
  readonly limitBytes: number
}

/**
 * Whether the picked file is over the ceiling the server will apply to it.
 *
 * The SVG branch keys off the browser's sniffed `file.type` first and the
 * extension only as a fallback, because that is the order that matches the
 * server: `verifyImageContent` routes on the DECLARED multipart type
 * (`icon-upload.service.ts:598`), which is what `file.type` becomes. A file the
 * browser calls `image/svg+xml` therefore gets the 512 KB ceiling here and the
 * same one there.
 *
 * Files the browser cannot type at all fall to the raster ceiling — the looser
 * of the two, which is the right way to be wrong for a check that is only
 * guidance: it never blocks something the server would have accepted.
 */
function oversizeRejection(file: File): OversizeRejection | null {
  const isSvg =
    file.type.toLowerCase() === 'image/svg+xml' ||
    (file.type === '' && /\.svg$/i.test(file.name))
  const limitBytes = isSvg ? BRANDING_SVG_MAX_BYTES : BRANDING_RASTER_MAX_BYTES
  if (file.size <= limitBytes) return null
  return { kind: isSvg ? 'svg' : 'raster', actualBytes: file.size, limitBytes }
}

/** The refusal, naming the file's real size and the real ceiling — both, always. */
function describeOversize(
  t: (key: string, options?: Record<string, unknown>) => string,
  rejection: OversizeRejection,
): string {
  return t(
    rejection.kind === 'svg'
      ? 'brandingPage.sections.identity.tooLargeSvg'
      : 'brandingPage.sections.identity.tooLargeRaster',
    {
      actual: formatByteLimit(rejection.actualBytes),
      limit: formatByteLimit(rejection.limitBytes),
    },
  )
}

/**
 * Bytes as an operator reads them. Binary units, because that is what both
 * server constants are written in (`512 * 1024`, `2 * 1024 * 1024`) — rounding
 * 512 KiB to "524 KB" would print a number that appears nowhere else.
 */
function formatByteLimit(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024)
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
  }
  const kb = bytes / 1024
  return `${Number.isInteger(kb) ? kb : Math.round(kb)} KB`
}

/**
 * Whether a value is worth handing to an `<img>`. Deliberately looser than the
 * form's own validation — this decides only whether to attempt a measurement,
 * and a value the schema will reject can still be measured harmlessly.
 */
function measurable(value: string | null): value is string {
  if (value === null) return false;
  return /^(?:https?:\/\/|data:image\/|\/uploads\/)/i.test(value.trim());
}

/** Whether the stored reference is a vector, which no pixel count can judge. */
function isVector(value: string | null): boolean {
  if (value === null) return false
  const trimmed = value.trim()
  return /^data:image\/svg\+xml/i.test(trimmed) || /\.svg(?:[?#]|$)/i.test(trimmed)
}

/**
 * The two advisories worth raising, and nothing else. Both are advisory by
 * design: the file is already accepted and stored, and an operator who knows
 * their asset is fine should not be blocked by a guess made from pixel counts.
 */
function assetWarning(
  measured: MeasuredAsset,
  advice: BrandingAssetAdvice | undefined,
  vector: boolean,
): { key: 'warnNotSquare' | 'warnTooSmall'; params: Record<string, number> } | null {
  if (!advice) return null
  if (measured.width === 0 || measured.height === 0) return null
  if (advice.square === true && measured.width !== measured.height) {
    return { key: 'warnNotSquare', params: { width: measured.width, height: measured.height } }
  }
  // An SVG that declares `width="64"` measures 64 and is not thereby soft on a
  // dense screen — it is resolution-independent, which the read-out one line
  // above may be saying at the same time. Only a raster earns this advice.
  if (vector) return null
  const shortest = Math.min(measured.width, measured.height)
  if (advice.minPx !== undefined && shortest < advice.minPx) {
    return { key: 'warnTooSmall', params: { min: advice.minPx, actual: shortest } }
  }
  return null
}
