/**
 * The QR logo check as the QR tab runs it, in the operator's browser.
 *
 *   1. The logo is loaded by the CABINET'S OWN LOADER (`loadQrLogo` from the
 *      vendored kit): same origin, a redirect is no logo, an SVG over 96 KB is
 *      no logo, a raster is redrawn to at most 256 px. A file it answers
 *      `null` for is a file the cabinet would draw no logo from — refused as
 *      `unloadable`, since saving it would promise a logo nobody sees.
 *   2. The image the loader produced is drawn by the browser into a square,
 *      the box the renderer gives a logo, with the renderer's own fitting.
 *   3. The decoding half (`qr-logo-check-run.ts`, and ZXing with it) is
 *      fetched only now, on the first logo an operator picks.
 *   4. The run is judged by `judgeQrLogoCheck`.
 *
 * Every step that can fail answers a verdict (`unloadable`, `failed`) rather
 * than throwing; an abort answers `null`.
 */
import { loadQrLogo } from '../../lib/qr/kit/qr-logo-source'

import {
  QR_LOGO_CHECK_LINKS_PER_SHAPE,
  QR_LOGO_CHECK_SEED,
  QR_LOGO_CHECK_SIZES,
  judgeQrLogoCheck,
  type QrLogoChecker,
} from './qr-logo-check'
import type { QrLogoBitmap } from './qr-logo-check-run'
import { sampleQrLogoCheckLinks } from './qr-logo-links'

/**
 * The resolution a logo is drawn at for the check. The camera model paints the
 * image box at 4 × its CSS pixels, which is at most about 205 texels across at
 * 256 CSS px — so every model pixel gets its own texel.
 */
export const QR_LOGO_CHECK_BITMAP_PIXELS = 256

export interface BrowserQrLogoCheckerOptions {
  /** `/uploads/branding/<file>` → the `data:` URI the renderer inlines, or `null`. The cabinet's loader by default. */
  readonly loadHref?: (src: string) => Promise<string | null>
  /** A `data:` URI → the square box the renderer draws it into, or `null` when the browser cannot draw it. */
  readonly drawBox?: (href: string, pixels: number) => Promise<QrLogoBitmap | null>
  /** Links of each shape. Production checks `QR_LOGO_CHECK_LINKS_PER_SHAPE`; only a test passes fewer. */
  readonly linksPerShape?: number
}

export function createBrowserQrLogoChecker(options: BrowserQrLogoCheckerOptions = {}): QrLogoChecker {
  const loadHref = options.loadHref ?? loadQrLogo
  const drawBox = options.drawBox ?? drawLogoBox
  const links = sampleQrLogoCheckLinks(options.linksPerShape ?? QR_LOGO_CHECK_LINKS_PER_SHAPE, QR_LOGO_CHECK_SEED)

  return async (style, { signal, onProgress }) => {
    try {
      const href = await loadHref(style.logo.src)
      if (signal.aborted) return null
      if (href === null) return { status: 'unloadable' }
      const bitmap = await drawBox(href, QR_LOGO_CHECK_BITMAP_PIXELS)
      if (signal.aborted) return null
      if (bitmap === null) return { status: 'failed' }
      const { runQrLogoCheck } = await import('./qr-logo-check-run')
      if (signal.aborted) return null
      const run = await runQrLogoCheck({
        style,
        bitmap,
        href,
        links,
        sizes: QR_LOGO_CHECK_SIZES,
        signal,
        onProgress,
      })
      return run === null ? null : judgeQrLogoCheck(run)
    } catch {
      return signal.aborted ? null : { status: 'failed' }
    }
  }
}

/**
 * The logo drawn into a `pixels` × `pixels` box, transparent where it does not
 * cover — the way the renderer's `<image>` fits it: whole, centred, never
 * cropped or stretched (`preserveAspectRatio` at its default, `xMidYMid meet`).
 *
 * An image with a size of its own (every raster the loader produces, and an
 * SVG that states one) is fitted here from that size. An SVG without one is
 * handed to the browser inside an `<image>` of the box's size, so the fitting
 * is the browser's SVG implementation itself — the one the cabinet's code
 * goes through.
 */
export async function drawLogoBox(href: string, pixels: number): Promise<QrLogoBitmap | null> {
  if (typeof document === 'undefined') return null
  try {
    const image = await decodeImage(href)
    const canvas = document.createElement('canvas')
    canvas.width = pixels
    canvas.height = pixels
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return null
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    const { naturalWidth: width, naturalHeight: height } = image
    if (width > 0 && height > 0) {
      const scale = Math.min(pixels / width, pixels / height)
      const drawnWidth = width * scale
      const drawnHeight = height * scale
      context.drawImage(image, (pixels - drawnWidth) / 2, (pixels - drawnHeight) / 2, drawnWidth, drawnHeight)
    } else {
      const wrapper =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 ${pixels} ${pixels}">` +
        `<image href="${href}" x="0" y="0" width="${pixels}" height="${pixels}"/></svg>`
      context.drawImage(await decodeImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(wrapper)}`), 0, 0)
    }
    const data = context.getImageData(0, 0, pixels, pixels)
    return { width: pixels, height: pixels, rgba: data.data }
  } catch {
    // Undecodable, or a canvas the browser will not let us read back.
    return null
  }
}

async function decodeImage(src: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.decoding = 'async'
  image.src = src
  await image.decode()
  return image
}
