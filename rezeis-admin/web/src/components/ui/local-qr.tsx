/**
 * A plain QR code for the panel's own pages. Drawn by the panel's one QR
 * renderer — the vendored copy of the cabinet's `qr-style.ts` in
 * `@/lib/qr/kit` — and mounted the way the cabinet's `LocalQr` mounts its
 * codes: the SVG as a data URL in an `<img>` on a white plate. Nothing leaves
 * the browser; no third-party service is handed the link.
 *
 * ── Why this is no longer a bitmap from `qrcode` ────────────────────────────
 *
 * It used to call `QRCode.toDataURL(url, { width: size, margin: 1 })` itself:
 * a PNG with a ONE-module quiet zone, from a second copy of the encoder
 * options sitting next to the kit's. ISO/IEC 18004 §6.3.8 asks for four
 * modules, and the zone is not a margin to trim — it is how a detector finds
 * the symbol at all (`qr-options.ts` has the argument). The advertising page
 * shows these codes for operators to take into company advertisements, so the
 * image leaves the panel; the cabinet had already fixed exactly this in its
 * own copy.
 *
 * Now it is `qrSvg(url, QR_STYLE_PLAIN, size)`: `qrcode`'s own SVG writer
 * through `qrOptions()` — the encoder, level, colours and four-module quiet
 * zone of every plain code the cabinet draws — as a vector that stays sharp
 * in a screenshot at any zoom. `qr-preview-cabinet.test.ts` keeps the encoder
 * inside `lib/qr/kit/`, so a third copy of the options cannot appear.
 *
 * ── Plain, with no way to style it ──────────────────────────────────────────
 *
 * Unlike the cabinet's `LocalQr` there is no `style` prop. The operator's QR
 * style is part of branding, which the API serves under `settings:view`; the
 * page this draws for, advertising, is open to `advertising:view` alone. A
 * styled company code there would need the page to read branding under a
 * second permission, and that is not decided — so this draws plain codes, and
 * styling them would be a deliberate change rather than a prop to pass.
 */
import { useEffect, useState } from 'react'

import { QR_STYLE_PLAIN, qrSvg } from '@/lib/qr/kit/qr-style'

export function LocalQr({
  url,
  label,
  size,
}: {
  url: string
  label: string
  /** The CSS size the code is shown at. A plain code is a vector, so it only sizes the image. */
  size: number
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void qrSvg(url, QR_STYLE_PLAIN, size)
      .then((svg) => {
        if (!cancelled) setDataUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [url, size])

  return (
    <div className="flex flex-col items-center gap-1">
      {/* The placeholder sits inside the same plate as the finished code, so
          the caption does not jump by the plate's padding when it lands. */}
      <div className="overflow-hidden rounded-md border bg-white p-1">
        {dataUrl === null ? (
          <div style={{ width: size, height: size }} aria-hidden="true" />
        ) : (
          <img src={dataUrl} alt={label} width={size} height={size} />
        )}
      </div>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  )
}
