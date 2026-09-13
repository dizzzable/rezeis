import { describe, expect, it, vi } from 'vitest'

import { LOGO_DISPLAY_PIXELS, planQrLogo } from '@/lib/qr/kit/qr-logo'
import { QR_STYLE_PLAIN, drawQr, type QrDrawing, type QrLogo, type QrStyle } from '@/lib/qr/kit/qr-style'
import {
  APP_ICON_LOGO,
  BULLSEYE_LOGO,
  EYE_LOGO,
  TRANSPARENT_LOGO,
  paintLogo,
} from '@/test/qr-logo-bitmaps'

import {
  QR_LOGO_CHECK_LINKS_PER_SHAPE,
  QR_LOGO_CHECK_SEED,
  QR_LOGO_CHECK_SIZES,
  QR_LOGO_MAX_BREAK_RATE,
  QR_LOGO_MAX_CELL_BREAK_RATE,
  QR_LOGO_MIN_CELL_CODES,
  createQrLogoCheckStore,
  judgeQrLogoCheck,
  qrLogoCheckKey,
  qrLogoSaveRefusal,
  qrLogoVerdictMessage,
  type QrLogoChecker,
  type QrLogoVerdict,
  type QrStyleWithLogo,
} from './qr-logo-check'
import { createBrowserQrLogoChecker } from './qr-logo-check-browser'
import {
  covers,
  luma,
  rasteriseCamera,
  readsQr,
  runQrLogoCheck,
  type QrLogoCheckCell,
  type QrLogoCheckRun,
} from './qr-logo-check-run'
import { QR_LOGO_LINK_SHAPES, sampleQrLogoCheckLinks } from './qr-logo-links'

/**
 * The QR logo check: the rule it applies, the links and pictures it judges
 * on, and — with a real reader, never a stubbed verdict — the verdicts the
 * measurement behind its thresholds produced.
 *
 * The thresholds are written here as LITERALS. A check that read
 * `QR_LOGO_MAX_BREAK_RATE` to build its boundary would move with a mutation of
 * it and pass.
 */

const LOGO_SRC = '/uploads/branding/0123456789abcdef0123456789abcdef.png'
const withLogo = (style: Omit<QrStyle, 'logo'>, size: QrLogo['size'], plate: QrLogo['plate']): QrStyleWithLogo => ({
  ...style,
  logo: { src: LOGO_SRC, size, plate },
})
const PLAIN = { modules: 'square', eyes: 'square', dark: '#000000' } as const
const DOTS_NAVY = { modules: 'dots', eyes: 'rounded', dark: '#1e3a8a' } as const

/** A run of eight cells with the given counts, the rest of each cell filled in. */
function runOf(cells: ReadonlyArray<Partial<QrLogoCheckCell>>): QrLogoCheckRun {
  return {
    cells: cells.map((cell, index) => ({
      shape: QR_LOGO_LINK_SHAPES[index % 4] ?? 'invite',
      displayPixels: index < 4 ? 208 : 256,
      links: 100,
      planned: 100,
      readableToday: 100,
      broken: 0,
      mended: 0,
      ...cell,
    })),
    pairs: cells.length * 100,
    milliseconds: 1,
  }
}
const eightCells = (first: Partial<QrLogoCheckCell>): QrLogoCheckRun => runOf([first, {}, {}, {}, {}, {}, {}, {}])

describe('the rule, in numbers', () => {
  it('is the measured one: 5% overall, 15% in one shape × size, cells of 20 or more, 100 links of each shape', () => {
    expect(QR_LOGO_MAX_BREAK_RATE).toBe(0.05)
    expect(QR_LOGO_MAX_CELL_BREAK_RATE).toBe(0.15)
    expect(QR_LOGO_MIN_CELL_CODES).toBe(20)
    expect(QR_LOGO_CHECK_LINKS_PER_SHAPE).toBe(100)
    expect(QR_LOGO_CHECK_SEED).toBe(20260913)
  })

  it('checks every size the cabinet shows a logo at — the kit’s own table', () => {
    expect([...QR_LOGO_CHECK_SIZES]).toEqual([208, 256])
    expect([...QR_LOGO_CHECK_SIZES]).toEqual(Object.values(LOGO_DISPLAY_PIXELS))
  })

  it('passes at 5% of readable codes broken, and refuses above it', () => {
    // One cell of 100 readable codes and seven clean ones: 5 broken of 800
    // would be far under, so the breakage is put where the rate is exact.
    const judged = (broken: number, readable: number) =>
      judgeQrLogoCheck(runOf([{ readableToday: readable, planned: readable, broken }])).status
    expect(judged(5, 100)).toBe('passed')
    expect(judged(6, 100)).toBe('unreadable')
    expect(judged(38, 767)).toBe('passed')
    expect(judged(39, 767)).toBe('unreadable')
  })

  it('refuses one shape × size broken past 15% even when the whole check is under 5%', () => {
    expect(judgeQrLogoCheck(eightCells({ broken: 15 })).status).toBe('passed')
    const refused = judgeQrLogoCheck(eightCells({ broken: 16 }))
    expect(refused.status).toBe('unreadable')
    // 16 of 800 overall: it is the cell that refused it.
    expect(refused.status === 'unreadable' && refused.report.breakRate).toBe(0.02)
    expect(refused.status === 'unreadable' && refused.report.worstCell).toEqual({
      shape: 'invite',
      displayPixels: 208,
      rate: 0.16,
    })
  })

  it('does not judge a cell of fewer than 20 readable codes on its own', () => {
    expect(judgeQrLogoCheck(eightCells({ readableToday: 19, planned: 19, broken: 19 })).status).toBe('passed')
    expect(judgeQrLogoCheck(eightCells({ readableToday: 20, planned: 20, broken: 20 })).status).toBe('unreadable')
  })

  it('fails — never passes — a run that judged nothing', () => {
    expect(judgeQrLogoCheck(runOf([{ planned: 0, readableToday: 0 }]))).toEqual({ status: 'failed' })
    expect(judgeQrLogoCheck({ cells: [], pairs: 0, milliseconds: 0 })).toEqual({ status: 'failed' })
    // A reader that cannot read even the codes without a logo is broken, and
    // a broken reader would otherwise pass every logo it is shown.
    expect(judgeQrLogoCheck(runOf([{ planned: 100, readableToday: 49 }])).status).toBe('failed')
    expect(judgeQrLogoCheck(runOf([{ planned: 100, readableToday: 50 }])).status).toBe('passed')
  })

  it('says what it measured, in the words the operator reads', () => {
    const t = (key: string, options?: Record<string, unknown>): string => `${key} ${JSON.stringify(options ?? {})}`
    const unreadable = judgeQrLogoCheck(runOf([{ broken: 30, mended: 2 }]))
    expect(qrLogoVerdictMessage(t, unreadable)).toBe(
      'brandingPage.qr.logo.check.unreadable {"readable":100,"broken":30,"rate":"30","limit":"5"}',
    )
    const cell = judgeQrLogoCheck(eightCells({ broken: 16 }))
    expect(qrLogoVerdictMessage(t, cell)).toBe('brandingPage.qr.logo.check.unreadableCell {"rate":"16","limit":"15"}')
    const passed = judgeQrLogoCheck(runOf([{ planned: 100, readableToday: 97, broken: 2 }]))
    expect(qrLogoVerdictMessage(t, passed)).toBe(
      'brandingPage.qr.logo.check.passed {"codes":100,"readable":97,"broken":2,"rate":"2.1","limit":"5"}',
    )
    expect(qrLogoVerdictMessage(t, { status: 'checking', done: 1, total: 2 })).toBeNull()
  })
})

describe('the links', () => {
  const links = sampleQrLogoCheckLinks(QR_LOGO_CHECK_LINKS_PER_SHAPE, QR_LOGO_CHECK_SEED)

  it('are the same links every time, 100 of each shape', () => {
    expect(sampleQrLogoCheckLinks(QR_LOGO_CHECK_LINKS_PER_SHAPE, QR_LOGO_CHECK_SEED)).toEqual(links)
    expect(links).toHaveLength(400)
    for (const shape of QR_LOGO_LINK_SHAPES) {
      expect(links.filter((link) => link.shape === shape), shape).toHaveLength(100)
    }
    // A different seed is a different sample — the seed is not decorative.
    expect(sampleQrLogoCheckLinks(QR_LOGO_CHECK_LINKS_PER_SHAPE, QR_LOGO_CHECK_SEED + 1)).not.toEqual(links)
  })

  it('have the shapes the cabinet encodes, at the lengths they come in', () => {
    const shapes = {
      invite: /^https:\/\/[a-z0-9.-]{10,40}\/register\?ref=c[a-z0-9]{24}$/,
      botAd: /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{1,28}(?:bot|Bot)\?start=ad_[A-Za-z0-9]{10}$/,
      webAd: /^https:\/\/[a-z0-9.-]{10,40}\/\?campaign=ad_[A-Za-z0-9]{10}$/,
      utm: /^https:\/\/[a-z0-9.-]{10,30}\/\?campaign=ad_[A-Za-z0-9]{10}&utm_source=[a-z]+&utm_campaign=[a-z0-9_]{4,12}$/,
    } as const
    const lengths: Record<string, number[]> = {}
    for (const { shape, text } of links) {
      expect(text, shape).toMatch(shapes[shape])
      expect(() => new URL(text)).not.toThrow()
      ;(lengths[shape] ??= []).push(new TextEncoder().encode(text).length)
    }
    const range = (shape: string): [number, number] => [Math.min(...(lengths[shape] ?? [])), Math.max(...(lengths[shape] ?? []))]
    // Spread across the versions a logo is planned on, not pinned to one.
    expect(range('invite')[1] - range('invite')[0]).toBeGreaterThanOrEqual(20)
    expect(range('botAd')[1] - range('botAd')[0]).toBeGreaterThanOrEqual(20)
    expect(range('webAd')[1] - range('webAd')[0]).toBeGreaterThanOrEqual(20)
    expect(range('utm')[0]).toBeGreaterThan(range('webAd')[0])
  })

  it('give the planner room for a logo in nearly every code, at both sizes and both logo sizes', () => {
    // Anchor for the verdicts below: a sample whose codes carried no logo
    // would judge nothing and pass everything.
    for (const size of ['small', 'large'] as const) {
      const style = withLogo(PLAIN, size, 'light')
      for (const displayPixels of QR_LOGO_CHECK_SIZES) {
        const planned = links.filter((link) => planQrLogo(link.text, style, displayPixels) !== null).length
        expect(planned, `${size} at ${displayPixels} px`).toBe(400)
      }
    }
  })
})

describe('the picture', () => {
  /** The cabinet tests' `rasteriseCamera`, point by point and with a two-dimensional blur — the model's definition. */
  function referenceCamera(drawing: QrDrawing, pixelsPerModule: number): Uint8ClampedArray {
    const side = Math.round(drawing.size * pixelsPerModule)
    const fineSide = side * 4
    const fineScale = fineSide / drawing.size
    const fine = new Uint8ClampedArray(fineSide * fineSide).fill(255)
    for (const shape of drawing.shapes) {
      const [x0, y0, x1, y1] =
        shape.kind === 'circle'
          ? [shape.cx - shape.r, shape.cy - shape.r, shape.cx + shape.r, shape.cy + shape.r]
          : [shape.x, shape.y, shape.x + shape.w, shape.y + shape.h]
      for (let y = Math.max(0, Math.floor(y0 * fineScale)); y < Math.min(fineSide, Math.ceil(y1 * fineScale)); y += 1) {
        for (let x = Math.max(0, Math.floor(x0 * fineScale)); x < Math.min(fineSide, Math.ceil(x1 * fineScale)); x += 1) {
          if (covers(shape, (x + 0.5) / fineScale, (y + 0.5) / fineScale)) fine[y * fineSide + x] = luma(shape.fill)
        }
      }
    }
    const averaged = new Uint8ClampedArray(side * side)
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        let sum = 0
        for (let dy = 0; dy < 4; dy += 1) for (let dx = 0; dx < 4; dx += 1) sum += fine[(y * 4 + dy) * fineSide + x * 4 + dx] ?? 255
        averaged[y * side + x] = Math.round(sum / 16)
      }
    }
    const radius = Math.max(1, Math.round((0.6 * pixelsPerModule) / 2))
    const out = new Uint8ClampedArray(side * side)
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        let sum = 0
        let count = 0
        for (let dy = -radius; dy <= radius; dy += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            if (x + dx < 0 || y + dy < 0 || x + dx >= side || y + dy >= side) continue
            sum += averaged[(y + dy) * side + x + dx] ?? 255
            count += 1
          }
        }
        out[y * side + x] = Math.round(sum / count)
      }
    }
    return out
  }

  it('is the camera model byte for byte — squares, rounded modules, dots, rounded eyes and both plates', () => {
    const links = sampleQrLogoCheckLinks(1, 7)
    let compared = 0
    for (const base of [PLAIN, DOTS_NAVY, { modules: 'rounded', eyes: 'rounded', dark: '#595959' }] as const) {
      for (const plate of ['light', 'dark'] as const) {
        for (const link of links) {
          const style = withLogo(base, 'large', plate)
          const plan = planQrLogo(link.text, style, 208)
          if (plan === null) continue
          const { logo: _image, ...drawing } = drawQr(link.text, style, {
            displayPixels: 208,
            logo: { plan, href: 'data:image/png;base64,iVBORw0KGgo=' },
          })
          const pixelsPerModule = 208 / drawing.size
          expect(rasteriseCamera(drawing, pixelsPerModule).luminance).toEqual(referenceCamera(drawing, pixelsPerModule))
          compared += 1
        }
      }
    }
    expect(compared).toBe(3 * 2 * 4)
  })

  it('refuses a drawing that carries a logo it was given no image for', () => {
    const style = withLogo(PLAIN, 'large', 'light')
    const text = 'https://cabinet.example.com/?campaign=ad_K7Q2M9XWab'
    const plan = planQrLogo(text, style, 256)
    expect(plan).not.toBeNull()
    const drawing = drawQr(text, style, { displayPixels: 256, logo: { plan: plan!, href: 'data:image/png;base64,iVBORw0KGgo=' } })
    expect(() => rasteriseCamera(drawing, 256 / drawing.size)).toThrow(/no image/)
  })

  it('paints the image into the renderer’s box, over what is beneath, with its alpha', () => {
    const style = withLogo(PLAIN, 'large', 'dark')
    const text = 'https://cabinet.example.com/?campaign=ad_K7Q2M9XWab'
    const plan = planQrLogo(text, style, 256)!
    const drawing = drawQr(text, style, { displayPixels: 256, logo: { plan, href: 'data:image/png;base64,iVBORw0KGgo=' } })
    const { logo: box, ...shapes } = drawing
    const ppm = 256 / drawing.size
    // Transparent: exactly what the renderer drew beneath — the dark plate.
    expect(rasteriseCamera(drawing, ppm, paintLogo(TRANSPARENT_LOGO, 16)).luminance).toEqual(
      rasteriseCamera(shapes, ppm).luminance,
    )
    // Opaque white: the middle of the box turns white, and nothing outside it moves.
    const white = rasteriseCamera(drawing, ppm, paintLogo(() => [255, 255, 255, 255], 16)).luminance
    const plate = rasteriseCamera(shapes, ppm).luminance
    const side = Math.round(drawing.size * ppm)
    const centre = Math.floor(side / 2) * side + Math.floor(side / 2)
    expect(plate[centre]).toBe(0)
    expect(white[centre]).toBe(255)
    expect(white[0]).toBe(plate[0])
    expect(box).toBeDefined()
  })
})

describe('real decodes — the verdicts the thresholds were set on', () => {
  // Each case is the production check itself: 100 links of each shape, both
  // sizes, the camera model, ZXing. The exact counts are those of the
  // measurement in `qr-logo-check.ts`; they move only if the kit, the reader
  // or the model does, and then the thresholds need measuring again.
  const links = sampleQrLogoCheckLinks(QR_LOGO_CHECK_LINKS_PER_SHAPE, QR_LOGO_CHECK_SEED)
  const check = async (style: QrStyleWithLogo, painter: Parameters<typeof paintLogo>[0]) => {
    const run = await runQrLogoCheck({ style, bitmap: paintLogo(painter), links, sizes: QR_LOGO_CHECK_SIZES })
    expect(run).not.toBeNull()
    return judgeQrLogoCheck(run as QrLogoCheckRun)
  }

  it('passes an app icon on the white field, large — inside the churn every logo costs', async () => {
    const verdict = await check(withLogo(PLAIN, 'large', 'light'), APP_ICON_LOGO)
    expect(verdict.status).toBe('passed')
    if (verdict.status !== 'passed') return
    expect(verdict.report.totals).toEqual({ planned: 800, readableToday: 767, broken: 14, mended: 16 })
  }, 180_000)

  it('refuses a QR eye on the white field, large — the class the cabinet pins as unreadable', async () => {
    const verdict = await check(withLogo(PLAIN, 'large', 'light'), EYE_LOGO)
    expect(verdict.status).toBe('unreadable')
    if (verdict.status !== 'unreadable') return
    expect(verdict.report.totals).toEqual({ planned: 800, readableToday: 767, broken: 314, mended: 10 })
    expect(verdict.report.worstCell).toEqual({ shape: 'webAd', displayPixels: 208, rate: 91 / 94 })
  }, 180_000)

  it('refuses the mildest harmful picture measured: a small bullseye with navy dots, 5.8% overall and 19% in one cell', async () => {
    const verdict = await check(withLogo(DOTS_NAVY, 'small', 'light'), BULLSEYE_LOGO)
    expect(verdict.status).toBe('unreadable')
    if (verdict.status !== 'unreadable') return
    expect(verdict.report.totals).toEqual({ planned: 800, readableToday: 794, broken: 46, mended: 2 })
    expect(verdict.report.worstCell).toEqual({ shape: 'botAd', displayPixels: 208, rate: 0.19 })
  }, 180_000)

  it('reads codes at all: without a logo, today’s codes of the sample read under the model', () => {
    // The anchor that makes the passes above mean something from the other
    // side: the reader is not merely failing everything it is shown.
    let read = 0
    for (const link of links.slice(0, 40)) {
      const today = drawQr(link.text, QR_STYLE_PLAIN, { displayPixels: 208 })
      if (readsQr(rasteriseCamera(today, 208 / today.size), link.text)) read += 1
    }
    expect(read).toBeGreaterThanOrEqual(36)
  })
})

describe('the store', () => {
  const style = withLogo(PLAIN, 'small', 'light')
  const other = withLogo(PLAIN, 'large', 'light')
  const passed: QrLogoVerdict = judgeQrLogoCheck(runOf([{}]))

  function manualChecker() {
    const calls: Array<{ style: QrStyleWithLogo; signal: AbortSignal; resolve: (verdict: QrLogoVerdict | null) => void; progress: (done: number, total: number) => void }> = []
    const checker: QrLogoChecker = (checked, { signal, onProgress }) =>
      new Promise((resolve) => calls.push({ style: checked, signal, resolve, progress: onProgress }))
    return { calls, checker }
  }

  it('has nothing to say about a style without a logo, and never checks one', () => {
    const { calls, checker } = manualChecker()
    const store = createQrLogoCheckStore(checker)
    store.request(QR_STYLE_PLAIN)
    expect(store.verdict(QR_STYLE_PLAIN)).toBeUndefined()
    expect(qrLogoCheckKey(QR_STYLE_PLAIN)).toBeNull()
    expect(calls).toEqual([])
  })

  it('checks a style once, reports progress, and keeps the verdict', async () => {
    const { calls, checker } = manualChecker()
    const store = createQrLogoCheckStore(checker)
    const listener = vi.fn()
    store.subscribe(listener)
    store.request(style)
    store.request(style)
    expect(calls).toHaveLength(1)
    expect(store.verdict(style)).toEqual({ status: 'checking', done: 0, total: 0 })
    calls[0]?.progress(800, 800)
    expect(store.verdict(style)).toEqual({ status: 'checking', done: 800, total: 800 })
    calls[0]?.resolve(passed)
    await Promise.resolve()
    expect(store.verdict(style)).toBe(passed)
    expect(listener).toHaveBeenCalled()
    store.request(style)
    expect(calls).toHaveLength(1)
  })

  it('keys a verdict on everything the logo is drawn with — the colour as the cabinet reads it, too', () => {
    expect(qrLogoCheckKey(style)).not.toBe(qrLogoCheckKey(other))
    expect(qrLogoCheckKey({ ...style, logo: { ...style.logo, plate: 'dark' } })).not.toBe(qrLogoCheckKey(style))
    expect(qrLogoCheckKey({ ...style, modules: 'dots' })).not.toBe(qrLogoCheckKey(style))
    expect(qrLogoCheckKey({ ...style, dark: '#1E3A8A' })).toBe(qrLogoCheckKey({ ...style, dark: '#1e3a8a' }))
    // A logo the cabinet would not draw is no logo to check.
    expect(qrLogoCheckKey({ ...style, logo: { ...style.logo, src: 'https://cdn.example.com/l.png' } })).toBeNull()
  })

  it('runs one check at a time: asking for another style aborts the running one, which leaves no verdict', async () => {
    const { calls, checker } = manualChecker()
    const store = createQrLogoCheckStore(checker)
    store.request(style)
    store.request(other)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.signal.aborted).toBe(true)
    expect(calls[1]?.signal.aborted).toBe(false)
    expect(store.verdict(style)).toBeUndefined()
    // A late answer from the aborted check is not taken.
    calls[0]?.resolve(passed)
    await Promise.resolve()
    expect(store.verdict(style)).toBeUndefined()
    store.request(style)
    expect(calls).toHaveLength(3)
  })

  it('turns a checker that throws into a failed verdict, and checks again only when asked to retry', async () => {
    let attempts = 0
    const store = createQrLogoCheckStore(async () => {
      attempts += 1
      throw new Error('decoder chunk failed to load')
    })
    store.request(style)
    await vi.waitFor(() => expect(store.verdict(style)).toEqual({ status: 'failed' }))
    store.request(style)
    expect(attempts).toBe(1)
    store.retry(style)
    await vi.waitFor(() => expect(attempts).toBe(2))
  })
})

describe('the save gate', () => {
  const t = (key: string): string => key
  const style = withLogo(PLAIN, 'small', 'light')

  it('lets a style without a logo through, whatever the store holds', () => {
    const store = createQrLogoCheckStore(async () => null)
    expect(qrLogoSaveRefusal(store, QR_STYLE_PLAIN, t)).toBeNull()
  })

  it('refuses a logo nobody checked yet, and starts its check', () => {
    const request = vi.fn()
    const store = { verdict: () => undefined, request, retry: vi.fn(), subscribe: () => () => {} }
    expect(qrLogoSaveRefusal(store, style, t)).toBe('brandingPage.qr.logo.check.pending')
    expect(request).toHaveBeenCalledWith(style)
  })

  it.each([
    [{ status: 'checking', done: 3, total: 800 }, 'brandingPage.qr.logo.check.pending'],
    [{ status: 'unloadable' }, 'brandingPage.qr.logo.check.unloadable'],
    [{ status: 'failed' }, 'brandingPage.qr.logo.check.failed'],
    [judgeQrLogoCheck(runOf([{ broken: 30 }])), 'brandingPage.qr.logo.check.unreadable'],
  ] as const)('refuses a logo whose verdict is %j', (verdict, message) => {
    const store = { verdict: () => verdict as QrLogoVerdict, request: vi.fn(), retry: vi.fn(), subscribe: () => () => {} }
    expect(qrLogoSaveRefusal(store, style, t)).toBe(message)
  })

  it('lets a logo through only once its check passed', () => {
    const store = {
      verdict: () => judgeQrLogoCheck(runOf([{}])),
      request: vi.fn(),
      retry: vi.fn(),
      subscribe: () => () => {},
    }
    expect(qrLogoSaveRefusal(store, style, t)).toBeNull()
  })
})

describe('the browser checker', () => {
  const style = withLogo(PLAIN, 'large', 'light')
  const options = () => ({ signal: new AbortController().signal, onProgress: () => {} })

  it('refuses a logo the cabinet’s loader draws nothing from, without decoding anything', async () => {
    const drawBox = vi.fn()
    const checker = createBrowserQrLogoChecker({ loadHref: async () => null, drawBox })
    expect(await checker(style, options())).toEqual({ status: 'unloadable' })
    expect(drawBox).not.toHaveBeenCalled()
  })

  it('fails — not passes — when the browser cannot draw the image', async () => {
    const checker = createBrowserQrLogoChecker({
      loadHref: async () => 'data:image/png;base64,iVBORw0KGgo=',
      drawBox: async () => null,
    })
    expect(await checker(style, options())).toEqual({ status: 'failed' })
  })

  it('answers nothing for an aborted check', async () => {
    const controller = new AbortController()
    const checker = createBrowserQrLogoChecker({
      loadHref: async () => {
        controller.abort()
        return 'data:image/png;base64,iVBORw0KGgo='
      },
      drawBox: async () => paintLogo(TRANSPARENT_LOGO, 16),
    })
    expect(await checker(style, { signal: controller.signal, onProgress: () => {} })).toBeNull()
  })

  it('decodes for real through the image the browser drew: an eye refused, nothing in the middle passed', async () => {
    const run = (painter: Parameters<typeof paintLogo>[0]) =>
      createBrowserQrLogoChecker({
        loadHref: async () => 'data:image/png;base64,iVBORw0KGgo=',
        drawBox: async () => paintLogo(painter),
        linksPerShape: 5,
      })(style, options())
    expect((await run(EYE_LOGO))?.status).toBe('unreadable')
    expect((await run(TRANSPARENT_LOGO))?.status).toBe('passed')
  }, 60_000)
})
