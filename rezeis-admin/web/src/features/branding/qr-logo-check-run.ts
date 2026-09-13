/**
 * The decoding half of the QR logo check: pictures of real codes, read back by
 * a real QR reader. Loaded on demand by the QR tab (`import()`), so the reader
 * — `@zxing/library` — costs nothing to an operator who never sets a logo.
 *
 * ── The reader ──────────────────────────────────────────────────────────────
 *
 * ZXing's JavaScript port, with the hints the cabinet's own decode tests use
 * (`reiwa/web/test/qr-logo-decodes.test.ts`): QR only, `TRY_HARDER`, and no
 * inversion — the port has none. It is the reader family v2rayNG embeds and
 * the strictest one in the chain, so a logo it reads is a logo the forgiving
 * phone cameras read too; the reverse is not true.
 *
 * ── The picture ─────────────────────────────────────────────────────────────
 *
 * Built from the kit's `drawQr` — the very shape list the cabinet serialises
 * into its SVG — through the cabinet tests' CAMERA MODEL: every pixel
 * integrates light (4 × 4 supersampling, averaged), the pixel grid does not
 * line up with the modules (the fractional pixels per module the code is
 * really shown at), and the lens is a little out of focus (a box blur 0.6 of
 * a module wide). The model is `rasteriseCamera` in the cabinet's
 * `web/test/support/qr-raster.ts`, arithmetic for arithmetic, so a rate
 * measured here and a rate measured there are rates of the same thing.
 *
 * What the cabinet tests could only MODEL with shapes — the logo image — is
 * real here: the operator's picture, decoded by the browser, composited into
 * the renderer's image box over whatever the renderer drew beneath it (the
 * white field of a light plate, the dark plate), alpha and all.
 *
 * ── Paired with today's code ────────────────────────────────────────────────
 *
 * Every link is drawn twice, at every size a logo is shown at: today's code
 * (the same style, no logo) and the code with the logo. A code that does not
 * read without the logo says nothing about the logo and is not counted
 * against it; a code that reads without it and not with it is BROKEN by it.
 * Today's code comes from `drawQr` too, as in the cabinet's own decode sweep.
 * For an unstyled code the cabinet draws through `qrcode`'s own writer at
 * level `M` instead, which the kit keeps to itself (`qr-preview-cabinet.test.ts`
 * holds every other file away from the encoder); the two differ only where
 * `drawQr` takes a higher correction level that costs no size — the same
 * symbol version, the same module pitch, different codewords and mask.
 */
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  QRCodeReader,
  RGBLuminanceSource,
} from '@zxing/library'

import { planQrLogo } from '../../lib/qr/kit/qr-logo'
import { drawQr, type QrDrawing, type QrLogoImage, type QrShape, type QrStyle } from '../../lib/qr/kit/qr-style'

import type { QrLogoCheckLink, QrLogoLinkShape } from './qr-logo-links'

/** An image as the browser decoded it: straight (not premultiplied) RGBA, row-major. */
export interface QrLogoBitmap {
  readonly width: number
  readonly height: number
  readonly rgba: Uint8ClampedArray
}

export interface LuminanceImage {
  readonly width: number
  readonly height: number
  /** One byte per pixel, 0 = black, 255 = white. */
  readonly luminance: Uint8ClampedArray
}

/** Supersampling of the camera model, per axis. */
export const CAMERA_SUPERSAMPLE = 4
/** Width of the camera model's defocus, in modules. */
export const CAMERA_BLUR_MODULES = 0.6

/**
 * One cell of the sweep: one shape of link at one display size.
 *
 * `planned` counts the links whose code carries the logo at this size at all —
 * a code the planner finds no room in is drawn without it and can be neither
 * broken nor mended. Of those, `readableToday` read without the logo; `broken`
 * is how many of THOSE do not read with it, and `mended` how many of the rest
 * read only with it.
 */
export interface QrLogoCheckCell {
  readonly shape: QrLogoLinkShape
  readonly displayPixels: number
  readonly links: number
  readonly planned: number
  readonly readableToday: number
  readonly broken: number
  readonly mended: number
}

export interface QrLogoCheckRun {
  readonly cells: readonly QrLogoCheckCell[]
  /** Pairs drawn and read — two decodes each. */
  readonly pairs: number
  readonly milliseconds: number
}

const HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]],
  [DecodeHintType.TRY_HARDER, true],
])

/** Whether ZXing reads exactly `text` off the picture. */
export function readsQr(image: LuminanceImage, text: string): boolean {
  try {
    const source = new RGBLuminanceSource(image.luminance, image.width, image.height)
    return new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(source)), HINTS).getText() === text
  } catch {
    return false
  }
}

/**
 * Does this shape cover the point? Units are modules; rounded corners honoured.
 * The cabinet tests' `covers`, and the one definition of coverage here: the
 * span painter below only ever fills what this answers `true` for.
 */
export function covers(shape: QrShape, px: number, py: number): boolean {
  if (shape.kind === 'circle') {
    return (px - shape.cx) ** 2 + (py - shape.cy) ** 2 <= shape.r ** 2
  }
  if (px < shape.x || px > shape.x + shape.w || py < shape.y || py > shape.y + shape.h) return false
  const r = shape.r
  if (r <= 0) return true
  const nx = Math.min(Math.max(px, shape.x + r), shape.x + shape.w - r)
  const ny = Math.min(Math.max(py, shape.y + r), shape.y + shape.h - r)
  return (px - nx) ** 2 + (py - ny) ** 2 <= r ** 2
}

function bounds(shape: QrShape): readonly [number, number, number, number] {
  return shape.kind === 'circle'
    ? [shape.cx - shape.r, shape.cy - shape.r, shape.cx + shape.r, shape.cy + shape.r]
    : [shape.x, shape.y, shape.x + shape.w, shape.y + shape.h]
}

/**
 * Paints `shape` into the fine buffer: every sample point `covers` accepts,
 * and no other.
 *
 * Row by row rather than point by point. Every shape the renderer draws is
 * convex, so on one row of sample points the covered ones are one unbroken
 * run; its ends are estimated in closed form and then settled with `covers`
 * itself, so a run ends exactly where the point test would put it — floating
 * point included — and the result is the point-by-point result, byte for byte
 * (`qr-logo-check.test.ts` holds the two equal). A rounded rectangle whose
 * radius exceeds half its side is not a shape the renderer makes; it is
 * painted point by point.
 */
function paintShape(
  fine: Uint8ClampedArray,
  fineSide: number,
  fineScale: number,
  shape: QrShape,
  value: number,
): void {
  const [x0, y0, x1, y1] = bounds(shape)
  const px0 = Math.max(0, Math.floor(x0 * fineScale))
  const py0 = Math.max(0, Math.floor(y0 * fineScale))
  const px1 = Math.min(fineSide, Math.ceil(x1 * fineScale))
  const py1 = Math.min(fineSide, Math.ceil(y1 * fineScale))
  if (px1 <= px0 || py1 <= py0) return
  const sample = (index: number): number => (index + 0.5) / fineScale
  const degenerate = shape.kind === 'rect' && shape.r > 0 && (shape.r * 2 > shape.w || shape.r * 2 > shape.h)

  for (let y = py0; y < py1; y += 1) {
    const sy = sample(y)
    const row = y * fineSide
    if (degenerate) {
      for (let x = px0; x < px1; x += 1) if (covers(shape, sample(x), sy)) fine[row + x] = value
      continue
    }
    // The covered interval of this row, in modules, in closed form.
    let from: number
    let to: number
    if (shape.kind === 'circle') {
      const remaining = shape.r * shape.r - (sy - shape.cy) ** 2
      if (remaining < 0) continue
      const half = Math.sqrt(remaining)
      from = shape.cx - half
      to = shape.cx + half
    } else {
      if (sy < shape.y || sy > shape.y + shape.h) continue
      let inset = 0
      if (shape.r > 0) {
        const ny = Math.min(Math.max(sy, shape.y + shape.r), shape.y + shape.h - shape.r)
        const remaining = shape.r * shape.r - (sy - ny) ** 2
        if (remaining < 0) continue
        inset = shape.r - Math.sqrt(remaining)
      }
      from = shape.x + inset
      to = shape.x + shape.w - inset
    }
    // Estimated ends, then settled by the point test: step outwards while the
    // next point is still covered, inwards while this one is not.
    let start = Math.min(px1 - 1, Math.max(px0, Math.ceil(from * fineScale - 0.5)))
    let end = Math.max(px0, Math.min(px1 - 1, Math.floor(to * fineScale - 0.5)))
    while (start > px0 && covers(shape, sample(start - 1), sy)) start -= 1
    while (start <= end && !covers(shape, sample(start), sy)) start += 1
    while (end < px1 - 1 && covers(shape, sample(end + 1), sy)) end += 1
    while (end >= start && !covers(shape, sample(end), sy)) end -= 1
    if (end >= start) fine.fill(value, row + start, row + end + 1)
  }
}

/** The one fine buffer, reused across codes of the same size: a check draws hundreds of them. */
let scratch: Uint8ClampedArray | null = null

function fineBuffer(length: number): Uint8ClampedArray {
  if (scratch === null || scratch.length !== length) scratch = new Uint8ClampedArray(length)
  scratch.fill(255)
  return scratch
}

/** Rec. 601 luma of `#rgb` / `#rrggbb`, 0–255 — the cabinet tests' `luma`. */
export function luma(hex: string): number {
  const value = hex.replace('#', '')
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value.slice(0, 6)
  const r = Number.parseInt(full.slice(0, 2), 16)
  const g = Number.parseInt(full.slice(2, 4), 16)
  const b = Number.parseInt(full.slice(4, 6), 16)
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b)
}

/**
 * The camera's picture of `drawing` shown at `pixelsPerModule` CSS px, with the
 * logo image — when the drawing has one — painted from `bitmap` into the box
 * the renderer gave it.
 *
 * A drawing that carries a logo and no bitmap to paint it with is refused:
 * skipping the image would read the code as if its logo were transparent, and
 * the check would pass on a picture nobody draws.
 */
export function rasteriseCamera(
  drawing: QrDrawing,
  pixelsPerModule: number,
  bitmap?: QrLogoBitmap,
): LuminanceImage {
  if (drawing.logo !== undefined && bitmap === undefined) {
    throw new Error('this drawing carries a logo and no image was given to paint it with')
  }
  const side = Math.round(drawing.size * pixelsPerModule)
  const fineSide = side * CAMERA_SUPERSAMPLE
  const fineScale = fineSide / drawing.size
  const fine = fineBuffer(fineSide * fineSide)

  const colours = new Map<string, number>()
  for (const shape of drawing.shapes) {
    // The white field is what the buffer already holds.
    const isField =
      shape.kind === 'rect' && shape.x === 0 && shape.y === 0 && shape.w === drawing.size && shape.fill === '#ffffff'
    if (isField) continue
    let value = colours.get(shape.fill)
    if (value === undefined) {
      value = luma(shape.fill)
      colours.set(shape.fill, value)
    }
    paintShape(fine, fineSide, fineScale, shape, value)
  }

  if (drawing.logo !== undefined && bitmap !== undefined) {
    paintLogo(fine, fineSide, fineScale, drawing.logo, bitmap)
  }

  const luminance = new Uint8ClampedArray(side * side)
  const area = CAMERA_SUPERSAMPLE * CAMERA_SUPERSAMPLE
  const columns = new Uint16Array(side)
  for (let y = 0; y < side; y += 1) {
    columns.fill(0)
    for (let dy = 0; dy < CAMERA_SUPERSAMPLE; dy += 1) {
      const row = (y * CAMERA_SUPERSAMPLE + dy) * fineSide
      for (let x = 0, at = row; x < side; x += 1) {
        let sum = 0
        for (let dx = 0; dx < CAMERA_SUPERSAMPLE; dx += 1, at += 1) sum += fine[at] as number
        columns[x] = (columns[x] as number) + sum
      }
    }
    const out = y * side
    for (let x = 0; x < side; x += 1) luminance[out + x] = Math.round((columns[x] as number) / area)
  }

  const radius = Math.max(1, Math.round((CAMERA_BLUR_MODULES * pixelsPerModule) / 2))
  return boxBlur({ width: side, height: side, luminance }, radius)
}

/**
 * The image, stretched over the renderer's box: the bitmap is the box's
 * content already (`qr-logo-check-browser.ts` draws it through an SVG
 * `<image>` of the same size, so `preserveAspectRatio` is the browser's own),
 * composited with its alpha over what lies beneath.
 */
function paintLogo(
  fine: Uint8ClampedArray,
  fineSide: number,
  fineScale: number,
  box: QrLogoImage,
  bitmap: QrLogoBitmap,
): void {
  const { value, alpha } = texels(bitmap)
  const px0 = Math.max(0, Math.floor(box.x * fineScale))
  const py0 = Math.max(0, Math.floor(box.y * fineScale))
  const px1 = Math.min(fineSide, Math.ceil((box.x + box.w) * fineScale))
  const py1 = Math.min(fineSide, Math.ceil((box.y + box.h) * fineScale))
  for (let y = py0; y < py1; y += 1) {
    const v = ((y + 0.5) / fineScale - box.y) / box.h
    if (v < 0 || v >= 1) continue
    const rowOfTexels = Math.min(bitmap.height - 1, Math.floor(v * bitmap.height)) * bitmap.width
    const row = y * fineSide
    for (let x = px0; x < px1; x += 1) {
      const u = ((x + 0.5) / fineScale - box.x) / box.w
      if (u < 0 || u >= 1) continue
      const texel = rowOfTexels + Math.min(bitmap.width - 1, Math.floor(u * bitmap.width))
      const a = alpha[texel] as number
      if (a === 0) continue
      fine[row + x] = Math.round((value[texel] as number) * a + (fine[row + x] as number) * (1 - a))
    }
  }
}

/** Rec. 601 luma and alpha (0–1) per texel, once per image rather than once per code. */
const preparedTexels = new WeakMap<QrLogoBitmap, { readonly value: Float32Array; readonly alpha: Float32Array }>()

function texels(bitmap: QrLogoBitmap): { readonly value: Float32Array; readonly alpha: Float32Array } {
  const known = preparedTexels.get(bitmap)
  if (known !== undefined) return known
  const count = bitmap.width * bitmap.height
  if (!(bitmap.width > 0 && bitmap.height > 0) || bitmap.rgba.length < count * 4) {
    throw new Error('the logo image is empty')
  }
  const value = new Float32Array(count)
  const alpha = new Float32Array(count)
  for (let i = 0; i < count; i += 1) {
    const at = i * 4
    value[i] =
      0.299 * (bitmap.rgba[at] as number) + 0.587 * (bitmap.rgba[at + 1] as number) + 0.114 * (bitmap.rgba[at + 2] as number)
    alpha[i] = (bitmap.rgba[at + 3] as number) / 255
  }
  const prepared = { value, alpha }
  preparedTexels.set(bitmap, prepared)
  return prepared
}

/**
 * A box blur of `radius`, the window clipped at the edges — the cabinet
 * tests' `blur`, computed in two passes. Over a clipped window that is a
 * rectangle the two passes average exactly what one 2-D pass averages, and
 * the intermediate is kept unrounded so the result rounds once, as there.
 */
function boxBlur(image: LuminanceImage, radius: number): LuminanceImage {
  const { width, height, luminance } = image
  const horizontal = new Float64Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0
      let count = 0
      for (let dx = -radius; dx <= radius; dx += 1) {
        const sx = x + dx
        if (sx < 0 || sx >= width) continue
        sum += luminance[y * width + sx] ?? 255
        count += 1
      }
      horizontal[y * width + x] = sum / count
    }
  }
  const out = new Uint8ClampedArray(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0
      let count = 0
      for (let dy = -radius; dy <= radius; dy += 1) {
        const sy = y + dy
        if (sy < 0 || sy >= height) continue
        sum += horizontal[sy * width + x] ?? 255
        count += 1
      }
      out[y * width + x] = Math.round(sum / count)
    }
  }
  return { width, height, luminance: out }
}

/**
 * Whether today's code — no logo — reads, per style, size and link. It is the
 * same for every logo an operator tries on one style, and it is half of every
 * pair, so it is kept for the page's life instead of being drawn again.
 */
const todayReadsCache = new Map<string, boolean>()
const TODAY_CACHE_LIMIT = 10_000

function todayReads(text: string, style: QrStyle, displayPixels: number): boolean {
  const key = `${style.modules}|${style.eyes}|${style.dark}|${displayPixels}|${text}`
  const known = todayReadsCache.get(key)
  if (known !== undefined) return known
  const today = drawQr(text, style, { displayPixels })
  const reads = readsQr(rasteriseCamera(today, displayPixels / today.size), text)
  if (todayReadsCache.size >= TODAY_CACHE_LIMIT) todayReadsCache.clear()
  todayReadsCache.set(key, reads)
  return reads
}

/** A valid `data:` href for the renderer. The picture itself is `bitmap`; the renderer only checks the href's form. */
const HREF_FOR_RENDERER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII='

export interface QrLogoCheckInput {
  /** The style as the cabinet will draw it, logo included. */
  readonly style: QrStyle
  /** The logo image, as the browser decoded it. */
  readonly bitmap: QrLogoBitmap
  readonly links: readonly QrLogoCheckLink[]
  readonly sizes: readonly number[]
  /** The loaded `data:` URI, when there is one — handed to the renderer exactly as the cabinet hands it. */
  readonly href?: string
  readonly signal?: AbortSignal
  /** Called after every pair, and once at the start. */
  readonly onProgress?: (done: number, total: number) => void
  /** How long to compute before yielding to the page, in ms. */
  readonly sliceMs?: number
}

/**
 * Draws and reads every link at every size, with and without the logo.
 * `null` when `signal` aborts — a check for a style nobody is looking at any
 * more answers nothing.
 */
export async function runQrLogoCheck(input: QrLogoCheckInput): Promise<QrLogoCheckRun | null> {
  const { style, bitmap, links, sizes, signal, onProgress } = input
  if (style.logo === null) throw new Error('a logo check needs a style with a logo')
  const withoutLogo: QrStyle = { ...style, logo: null }
  const href = input.href ?? HREF_FOR_RENDERER
  const sliceMs = input.sliceMs ?? 12
  const started = Date.now()
  const total = links.length * sizes.length
  const cells = new Map<string, { -readonly [K in keyof QrLogoCheckCell]: QrLogoCheckCell[K] }>()
  let done = 0
  let sliceStarted = Date.now()
  onProgress?.(0, total)

  for (const displayPixels of sizes) {
    for (const link of links) {
      if (signal?.aborted) return null
      const key = `${link.shape}@${displayPixels}`
      let cell = cells.get(key)
      if (cell === undefined) {
        cell = { shape: link.shape, displayPixels, links: 0, planned: 0, readableToday: 0, broken: 0, mended: 0 }
        cells.set(key, cell)
      }
      cell.links += 1

      const plan = planQrLogo(link.text, style, displayPixels)
      if (plan !== null) {
        const logoDrawing = drawQr(link.text, style, { displayPixels, logo: { plan, href } })
        // The renderer refuses a plan it cannot draw and draws no logo; the
        // cabinet then shows no logo either, so there is nothing to judge.
        if (logoDrawing.logo !== undefined) {
          cell.planned += 1
          const readsToday = todayReads(link.text, withoutLogo, displayPixels)
          const logoReads = readsQr(
            rasteriseCamera(logoDrawing, displayPixels / logoDrawing.size, bitmap),
            link.text,
          )
          if (readsToday) {
            cell.readableToday += 1
            if (!logoReads) cell.broken += 1
          } else if (logoReads) {
            cell.mended += 1
          }
        }
      }

      done += 1
      onProgress?.(done, total)
      if (Date.now() - sliceStarted >= sliceMs) {
        await yieldToPage()
        sliceStarted = Date.now()
      }
    }
  }
  if (signal?.aborted) return null
  return { cells: [...cells.values()], pairs: done, milliseconds: Date.now() - started }
}

/**
 * Lets the page paint and handle input between slices of the check. Through a
 * message rather than `setTimeout(0)`: browsers clamp nested timeouts to 4 ms,
 * which over the hundreds of slices a check takes would add seconds of doing
 * nothing.
 */
function yieldToPage(): Promise<void> {
  if (typeof MessageChannel !== 'function') return new Promise((resolve) => setTimeout(resolve, 0))
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}
