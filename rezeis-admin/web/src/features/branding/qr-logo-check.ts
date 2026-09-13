/**
 * Whether an operator's QR logo keeps subscribers' codes readable: the rule,
 * the verdicts the QR tab shows, and the store that runs one check at a time.
 *
 * The owner's decision: an operator may put a logo in the middle of the codes
 * a subscriber shows other people (the referral invite and the partner's
 * advertising codes), and the panel VERIFIES with a real QR reader that codes
 * carrying it still read — and refuses, saying why, a logo that makes them
 * unreadable.
 *
 * ── What is measured ────────────────────────────────────────────────────────
 *
 * `QR_LOGO_CHECK_LINKS_PER_SHAPE` synthetic links of each shape the cabinet
 * encodes (`qr-logo-links.ts`), each drawn at every size the cabinet shows a
 * logo at (`LOGO_DISPLAY_PIXELS` from the kit), with and without the logo,
 * and read back by ZXing through a camera model (`qr-logo-check-run.ts`).
 * A code BREAKS when it reads without the logo and does not read with it.
 *
 * ── The rule, and the measurements behind its numbers ───────────────────────
 *
 * A logo is refused when, over every code that carries it,
 *
 *   broken / read-without-the-logo  >  QR_LOGO_MAX_BREAK_RATE  (5%)
 *
 * or when any one shape at any one size breaks more than
 * `QR_LOGO_MAX_CELL_BREAK_RATE` (15%) of its codes — a logo that spares the
 * bot links and breaks one invite in five is not saved on the strength of the
 * average.
 *
 * Measured on this very sample (100 links of each shape × 208 and 256 px = 800
 * codes), for 21 image models × 3 styles (plain; dots with rounded eyes in navy;
 * rounded in the palest allowed grey) × small and large × both plates — 252
 * checks, 13.09.2026:
 *
 *   - NO LOGO IS FREE. With a fully transparent image, 1.0–1.7% of the codes
 *     that read without a logo broke (767–794 of 800 read without one). The
 *     planner moves a code to a higher correction level and a larger symbol
 *     to make room, and ZXing reads some of those symbols worse than the
 *     smaller logo-less one whatever sits in the middle: one 47-byte bot link
 *     read as M v4 and did not read as the Q v5 the small logo plans, even
 *     with a single module knocked out. That churn — which also MENDS codes,
 *     2–22 per check — belongs to every logo equally, so a rule at zero would
 *     refuse every logo there is.
 *   - Everything that is not shaped like a finder measured inside the same
 *     band: a solid square, discs, a checkerboard finer than a module, photo
 *     noise, a gradient, a wordmark, an app icon, thin rings and frames, the
 *     dark plate alone, light glyphs and light fills on it — 0.9–2.2% overall,
 *     at worst 5.3% in one shape × size (5 of 94).
 *   - Finder-shaped marks — a QR "eye", a bullseye, the class the cabinet pins
 *     as unreadable — broke 40–63% at the large size (93–100% in their worst
 *     cell). At the small size with rounded modules or dots, three of the four
 *     cases broke 28–66%; the fourth, the small bullseye with dots, was the
 *     mildest harmful picture measured: 5.8% overall, 19% in its worst cell.
 *     With square modules the small plate is too small for either mark to pass
 *     for a finder (1.3% and 2.1%), and the check lets them through — it
 *     judges the picture in the style it will be drawn in, and a change of
 *     style is checked again.
 *
 * So: 5% overall is 2.25 times the worst harmless picture and below the
 * mildest harmful one; 15% per cell is 2.8 times the worst harmless cell and
 * below that same case's 19%. `qr-logo-check.test.ts` holds the rule to
 * literals and decodes a finder-shaped logo and a harmless one for real.
 *
 * ── Client side only, on purpose ────────────────────────────────────────────
 *
 * The check needs the operator's image drawn by a browser — an SVG is only an
 * SVG until something renders it — and the API has no browser. So the API
 * enforces every STRUCTURAL rule of a logo (`QrLogoDto`, `readQrStyle`, the
 * 96 KB SVG ceiling on upload) and trusts the panel with readability, the way
 * it trusts it with the rest of the design. A client other than this page can
 * store a logo nobody decoded; this page cannot.
 */
import { LOGO_DISPLAY_PIXELS } from '../../lib/qr/kit/qr-logo'
import { resolveQrStyle, type QrLogo, type QrStyle } from '../../lib/qr/kit/qr-style'

import type { QrLogoCheckCell, QrLogoCheckRun } from './qr-logo-check-run'
import type { QrLogoLinkShape } from './qr-logo-links'

/** Links of each shape, each checked at every size. */
export const QR_LOGO_CHECK_LINKS_PER_SHAPE = 100
/** The seed of those links: the same links for every logo, so verdicts are reproducible and comparable. */
export const QR_LOGO_CHECK_SEED = 20260913
/** Every size the cabinet shows a logo-bearing code at — the kit's own table, so a new size is checked the day it lands. */
export const QR_LOGO_CHECK_SIZES: readonly number[] = Object.values(LOGO_DISPLAY_PIXELS)

/** Refuse above this share of readable codes broken, over the whole check. See the header. */
export const QR_LOGO_MAX_BREAK_RATE = 0.05
/** Refuse above this share in any one shape × size. See the header. */
export const QR_LOGO_MAX_CELL_BREAK_RATE = 0.15
/**
 * A cell judged on its own needs this many readable codes: below it one
 * broken code swings the rate by several points, which is noise, not a logo.
 */
export const QR_LOGO_MIN_CELL_CODES = 20

export interface QrLogoCheckTotals {
  readonly planned: number
  readonly readableToday: number
  readonly broken: number
  readonly mended: number
}

export interface QrLogoCheckReport {
  readonly cells: readonly QrLogoCheckCell[]
  readonly totals: QrLogoCheckTotals
  /** `broken / readableToday` over every cell. */
  readonly breakRate: number
  /** The cell with the highest break rate among those large enough to judge. */
  readonly worstCell: { readonly shape: QrLogoLinkShape; readonly displayPixels: number; readonly rate: number } | null
}

export type QrLogoVerdict =
  /** Running. `total` is pairs (a link at a size), each two decodes. */
  | { readonly status: 'checking'; readonly done: number; readonly total: number }
  /** Codes with the logo read: within both limits. */
  | { readonly status: 'passed'; readonly report: QrLogoCheckReport }
  /** The logo breaks codes past a limit. */
  | { readonly status: 'unreadable'; readonly report: QrLogoCheckReport }
  /** The cabinet's own loader draws no logo from this file — missing, not an image, or an SVG over 96 KB. */
  | { readonly status: 'unloadable' }
  /** The check itself could not run, or judged nothing. Never a pass. */
  | { readonly status: 'failed' }

export type QrStyleWithLogo = QrStyle & { readonly logo: QrLogo }

/**
 * The style the cabinet would draw for `style` — its own reader — when that
 * style carries a logo; `null` when there is no logo to check.
 */
export function checkableQrStyle(style: QrStyle): QrStyleWithLogo | null {
  const drawn = resolveQrStyle(style)
  return drawn.logo === null ? null : (drawn as QrStyleWithLogo)
}

/** What a verdict is about: every member that changes the codes a logo sits in. */
export function qrLogoCheckKey(style: QrStyle): string | null {
  const drawn = checkableQrStyle(style)
  if (drawn === null) return null
  return JSON.stringify([drawn.modules, drawn.eyes, drawn.dark, drawn.logo.src, drawn.logo.size, drawn.logo.plate])
}

/**
 * The rule. A run that drew no logo, or read under half of the codes even
 * without one, judged nothing and FAILS — a broken reader must not pass every
 * logo it is shown.
 */
export function judgeQrLogoCheck(run: QrLogoCheckRun): QrLogoVerdict {
  const totals = run.cells.reduce<QrLogoCheckTotals>(
    (sum, cell) => ({
      planned: sum.planned + cell.planned,
      readableToday: sum.readableToday + cell.readableToday,
      broken: sum.broken + cell.broken,
      mended: sum.mended + cell.mended,
    }),
    { planned: 0, readableToday: 0, broken: 0, mended: 0 },
  )
  if (totals.planned === 0 || totals.readableToday * 2 < totals.planned) return { status: 'failed' }

  let worstCell: QrLogoCheckReport['worstCell'] = null
  for (const cell of run.cells) {
    if (cell.readableToday < QR_LOGO_MIN_CELL_CODES) continue
    const rate = cell.broken / cell.readableToday
    if (worstCell === null || rate > worstCell.rate) {
      worstCell = { shape: cell.shape, displayPixels: cell.displayPixels, rate }
    }
  }
  const breakRate = totals.broken / totals.readableToday
  const report: QrLogoCheckReport = { cells: run.cells, totals, breakRate, worstCell }
  const unreadable =
    breakRate > QR_LOGO_MAX_BREAK_RATE || (worstCell !== null && worstCell.rate > QR_LOGO_MAX_CELL_BREAK_RATE)
  return { status: unreadable ? 'unreadable' : 'passed', report }
}

type Translate = (key: string, options?: Record<string, unknown>) => string

const percent = (share: number): string => (Math.round(share * 1000) / 10).toString()

/**
 * What the operator is told about a verdict, with the measured numbers — the
 * same sentence on the QR tab and in a refused save. `null` while checking.
 */
export function qrLogoVerdictMessage(t: Translate, verdict: QrLogoVerdict): string | null {
  switch (verdict.status) {
    case 'checking':
      return null
    case 'passed':
      return t('brandingPage.qr.logo.check.passed', {
        codes: verdict.report.totals.planned,
        readable: verdict.report.totals.readableToday,
        broken: verdict.report.totals.broken,
        rate: percent(verdict.report.breakRate),
        limit: percent(QR_LOGO_MAX_BREAK_RATE),
      })
    case 'unreadable': {
      const { report } = verdict
      if (report.breakRate <= QR_LOGO_MAX_BREAK_RATE && report.worstCell !== null) {
        return t('brandingPage.qr.logo.check.unreadableCell', {
          rate: percent(report.worstCell.rate),
          limit: percent(QR_LOGO_MAX_CELL_BREAK_RATE),
        })
      }
      return t('brandingPage.qr.logo.check.unreadable', {
        readable: report.totals.readableToday,
        broken: report.totals.broken,
        rate: percent(report.breakRate),
        limit: percent(QR_LOGO_MAX_BREAK_RATE),
      })
    }
    case 'unloadable':
      return t('brandingPage.qr.logo.check.unloadable')
    case 'failed':
      return t('brandingPage.qr.logo.check.failed')
  }
}

/**
 * Why a save that carries `style` must not go out, or `null` when it may.
 *
 * A style without a logo always may. One with a logo may only once its check
 * has PASSED — for exactly this style, since the logo is judged in the colour,
 * shapes, size and plate it will be drawn in. A check that has not run yet is
 * started here, so the refusal the operator reads is followed by a verdict.
 */
export function qrLogoSaveRefusal(store: QrLogoCheckStore, style: QrStyle, t: Translate): string | null {
  if (qrLogoCheckKey(style) === null) return null
  const verdict = store.verdict(style)
  if (verdict?.status === 'passed') return null
  if (verdict === undefined) store.request(style)
  if (verdict === undefined || verdict.status === 'checking') return t('brandingPage.qr.logo.check.pending')
  return qrLogoVerdictMessage(t, verdict)
}

/** Runs the check for one style. Resolves `null` when `signal` aborts; never rejects for a failure it can name. */
export type QrLogoChecker = (
  style: QrStyleWithLogo,
  options: { readonly signal: AbortSignal; readonly onProgress: (done: number, total: number) => void },
) => Promise<QrLogoVerdict | null>

export interface QrLogoCheckStore {
  /** The verdict for this style's logo: `undefined` when never asked, or when the style has no logo. */
  verdict(style: QrStyle): QrLogoVerdict | undefined
  /**
   * Starts the check for this style unless it already ran or runs. A check
   * running for any OTHER style is aborted first: one check at a time, for the
   * style the operator is looking at.
   */
  request(style: QrStyle): void
  /** Forgets a `failed` verdict and checks again. */
  retry(style: QrStyle): void
  subscribe(listener: () => void): () => void
}

export function createQrLogoCheckStore(checker: QrLogoChecker): QrLogoCheckStore {
  const verdicts = new Map<string, QrLogoVerdict>()
  const listeners = new Set<() => void>()
  let running: { readonly key: string; readonly controller: AbortController } | null = null

  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const start = (style: QrStyle): void => {
    const drawn = checkableQrStyle(style)
    const key = qrLogoCheckKey(style)
    if (drawn === null || key === null) return
    if (running !== null && running.key !== key) {
      running.controller.abort()
      // An aborted check left no verdict: asked again later, it starts over.
      verdicts.delete(running.key)
      running = null
    }
    if (verdicts.has(key)) return

    const controller = new AbortController()
    const current = { key, controller }
    running = current
    verdicts.set(key, { status: 'checking', done: 0, total: 0 })
    notify()

    const settle = (verdict: QrLogoVerdict | null): void => {
      if (running === current) running = null
      if (controller.signal.aborted || verdict === null) return
      verdicts.set(key, verdict)
      notify()
    }
    let lastReport = 0
    checker(drawn, {
      signal: controller.signal,
      onProgress: (done, total) => {
        if (controller.signal.aborted) return
        const now = Date.now()
        // Enough to move a progress bar; not a render per pair.
        if (done !== total && done !== 0 && now - lastReport < 100) return
        lastReport = now
        verdicts.set(key, { status: 'checking', done, total })
        notify()
      },
    }).then(settle, () => settle({ status: 'failed' }))
  }

  return {
    verdict: (style) => {
      const key = qrLogoCheckKey(style)
      return key === null ? undefined : verdicts.get(key)
    },
    request: start,
    retry: (style) => {
      const key = qrLogoCheckKey(style)
      if (key === null || verdicts.get(key)?.status !== 'failed') return
      verdicts.delete(key)
      start(style)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
