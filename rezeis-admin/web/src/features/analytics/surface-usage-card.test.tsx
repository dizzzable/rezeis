/**
 * «Поверхности и устройства», as the operator meets it.
 *
 * Real recharts is rendered at the size its box gives, with the Pie's props
 * recorded on the way in so a test can ask whether a ring was told to animate.
 * Visibility is the driveable `IntersectionObserver` from `test-utils` — under
 * the suite's inert stub a panel that correctly waits to be seen and a panel
 * that is broken and never draws look the same. Animation frames are queued by
 * hand and run with a chosen clock, so "half-way through the count" is a fact
 * the test sets rather than a race it loses.
 */
import { cloneElement, isValidElement, type ComponentProps, type JSX, type ReactElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { installIntersectionObserver, renderWithProviders, type IntersectionObserverHarness } from '@/test/test-utils'

const recorded = vi.hoisted(() => ({ pies: [] as Array<{ readonly isAnimationActive: unknown; readonly animationBegin: unknown }> }))

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    Pie: (props: ComponentProps<typeof actual.Pie>) => {
      recorded.pies.push({ isAnimationActive: props.isAnimationActive, animationBegin: props.animationBegin })
      return <actual.Pie {...props} />
    },
    // jsdom has no layout engine; give the ring the size its 7rem box would.
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, { width: 112, height: 112 })
        : children,
  }
})

vi.mock('./analytics-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./analytics-api')>()),
  getSurfaceAnalytics: vi.fn(),
}))

import * as analyticsApi from './analytics-api'
import type { UsageSurfaceReport } from './analytics-api'
import { SURFACE_SWEEP_MS } from './surface-motion'
import { SURFACE_CATEGORY_COLORS, SURFACE_OTHER_COLOR, SURFACE_UNKNOWN_COLOR } from './surface-palette'
import { SURFACE_LABEL_KEYS } from './surface-slices'
import {
  SURFACE_LEGEND_ROW_BOX,
  SURFACE_PANEL,
  SURFACE_PANEL_GRID,
  SURFACE_PANEL_HALF,
  SURFACE_PANEL_HEADING,
  SURFACE_RING_BOX,
  SURFACE_RING_ROW,
  SURFACE_SKELETON_LEGEND_ROWS,
  SURFACE_TITLE_LINE,
  SURFACE_NOTE_LINE,
  SurfaceUsageCard,
} from './surface-usage-card'

/** The rem in a Tailwind size token — `size-28` is 7rem, `min-h-4` is 1rem. */
const spacingRem = (className: string, prefix: string): number => {
  const token = className.split(' ').find((part) => part.startsWith(`${prefix}-`))
  if (token === undefined) throw new Error(`no ${prefix}-… in "${className}"`)
  return Number(token.slice(prefix.length + 1)) / 4
}
/** The rem in a container-query variant, e.g. `@min-[18rem]/panel:flex-row`. */
const queryRem = (className: string, suffix: string): number => {
  const token = className.split(' ').find((part) => part.startsWith('@min-[') && part.endsWith(`:${suffix}`))
  if (token === undefined) throw new Error(`no @min-[…]:${suffix} in "${className}"`)
  return Number(token.slice('@min-['.length, token.indexOf('rem]')))
}
/** A ring box without the hover rules, which the skeleton has no use for. */
const ringFrame = (className: string): string =>
  className
    .split(' ')
    .filter((token) => !token.includes('active-slice') && !token.includes('recharts-pie-sector'))
    .join(' ')

const getSurfaceAnalytics = vi.mocked(analyticsApi.getSurfaceAnalytics)

/**
 * Every count distinct from every other number the card prints, so an
 * assertion that finds one cannot be satisfied by another: 48 tracked, 41
 * active, 7 installs. iOS leads the OS ring and trails the installs ring, so a
 * colour handed out by rank would give it two different colours.
 */
const REPORT: UsageSurfaceReport = {
  surfaces: [{ key: 'tma', count: 30 }, { key: 'browser', count: 12 }, { key: 'pwa', count: 6 }],
  formFactors: [{ key: 'mobile', count: 31 }, { key: 'desktop', count: 14 }, { key: 'tablet', count: 3 }],
  operatingSystems: [
    { key: 'ios', count: 17 },
    { key: 'android', count: 14 },
    { key: 'windows', count: 11 },
    { key: 'macos', count: 5 },
    { key: 'other', count: 1 },
  ],
  pwaInstalls: 7,
  pwaInstallsByOs: [{ key: 'android', count: 4 }, { key: 'unknown', count: 2 }, { key: 'ios', count: 1 }],
  activeLast30d: 41,
  totalTracked: 48,
  generatedAt: '2026-09-15T00:00:00.000Z',
}

const EMPTY: UsageSurfaceReport = {
  surfaces: [],
  formFactors: [],
  operatingSystems: [],
  pwaInstalls: 0,
  pwaInstallsByOs: [],
  activeLast30d: 0,
  totalTracked: 0,
  generatedAt: '2026-09-15T00:00:00.000Z',
}

const t = (key: string): string => {
  const text = i18n.t(key)
  if (text === key) throw new Error(`${key} has no words in "${i18n.language}"`)
  return text
}

// ── The page around the card ────────────────────────────────────────────────

const realMatchMedia = window.matchMedia
function systemPrefersReducedMotion(reduce: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion: reduce'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

let frames: FrameRequestCallback[] = []
/** Runs every queued frame, and the frames they queue, with the clock at `at`. */
function runFrames(at: number): void {
  act(() => {
    for (let round = 0; round < 50 && frames.length > 0; round += 1) {
      const due = frames
      frames = []
      for (const frame of due) frame(at)
    }
  })
}

let visibility: IntersectionObserverHarness | null = null

beforeAll(async () => {
  await i18nReady
  await i18n.changeLanguage('ru')
  await loadFeatureBundle('analytics')
})

beforeEach(() => {
  recorded.pies.length = 0
  frames = []
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => {
    frames.push(frame)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  getSurfaceAnalytics.mockReset()
  useAppearanceStore.setState({ animationsEnabled: true })
})

afterEach(() => {
  visibility?.restore()
  visibility = null
  window.matchMedia = realMatchMedia
  vi.unstubAllGlobals()
})

// ── Reading the card ────────────────────────────────────────────────────────

const panel = (id: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-surface-panel="${id}"]`)
  if (found === null) throw new Error(`no ${id} panel is drawn`)
  return found
}
const rows = (from: HTMLElement): HTMLElement[] => [...from.querySelectorAll<HTMLElement>('[data-surface-legend-row]')]
const row = (from: HTMLElement, key: string): HTMLElement => {
  const found = from.querySelector<HTMLElement>(`[data-surface-legend-row="${key}"]`)
  if (found === null) throw new Error(`no legend row for ${key}`)
  return found
}
const dot = (legendRow: HTMLElement): string => (legendRow.firstElementChild as HTMLElement).style.backgroundColor
const hole = (from: HTMLElement): string => from.querySelector('[data-surface-ring-hole]')?.textContent ?? ''
const sectorPaths = (from: HTMLElement): SVGPathElement[] => [...from.querySelectorAll<SVGPathElement>('.recharts-pie-sector path')]
/** jsdom leaves `oklch()` as written apart from its spacing. */
const asDom = (css: string): string => css.replace(/\s+/g, ' ')

async function renderCard(report: UsageSurfaceReport = REPORT): Promise<void> {
  getSurfaceAnalytics.mockResolvedValue(report)
  renderWithProviders(<SurfaceUsageCard />)
  await waitFor(() => expect(document.querySelectorAll('[data-surface-panel]')).toHaveLength(4))
}

/**
 * A second reader of the card's query, so a test can wait for the error to have
 * REACHED the components rather than only the cache — the card is meant to look
 * exactly the same either way, so it has nothing of its own to wait for.
 */
function SurfaceQueryProbe(): JSX.Element {
  const { isError } = useQuery({ queryKey: ['analytics', 'surfaces'], queryFn: getSurfaceAnalytics, staleTime: 60_000 })
  return <span data-surface-query={isError ? 'error' : 'ok'} />
}

/** The still card: the system asks for less motion, so everything is drawn complete at once. */
async function renderStill(report: UsageSurfaceReport = REPORT): Promise<void> {
  systemPrefersReducedMotion(true)
  await renderCard(report)
  await waitFor(() => expect(panel('surface').querySelectorAll('.recharts-pie-sector').length).toBeGreaterThan(0))
}

// ── Layout ──────────────────────────────────────────────────────────────────

describe('the four panels', () => {
  it('are laid out by the card’s own width: one column, two by two, four in a row', async () => {
    await renderStill()
    const grid = panel('surface').parentElement as HTMLElement

    expect(grid.className).toBe(SURFACE_PANEL_GRID)
    expect(grid).toHaveClass('grid', '@min-[37rem]:grid-cols-2', '@min-[75rem]:grid-cols-4')
    // No bare column count: below the first threshold the panels stack.
    expect(grid.className).not.toMatch(/(^|\s)grid-cols-\d/)
    expect(grid.parentElement).toHaveClass('@container')
    expect([...grid.children].map((child) => (child as HTMLElement).dataset.surfacePanel)).toEqual(['surface', 'form', 'os', 'pwa'])
    for (const section of grid.children) {
      // Heading and ring share rows with the neighbours: the rings of a row start level.
      expect(section).toHaveClass('row-span-2', 'grid-rows-subgrid')
      // Each half carries the panel's query container; the subgrid item cannot.
      expect([...section.children].map((half) => (half as HTMLElement).className)).toEqual([
        SURFACE_PANEL_HALF,
        SURFACE_PANEL_HALF,
      ])
    }
  })

  it('never takes more columns than leave every panel of the row room for its legend beside its ring', async () => {
    await renderStill()
    const beside = queryRem(SURFACE_RING_ROW, 'flex-row')
    const gutter = spacingRem(SURFACE_PANEL_GRID, 'gap-x')

    // Two columns only once two of those fit, four only once four do. This is
    // the whole of the layout rule: the arrangement is chosen by width, never
    // by how many rows one panel's legend happens to have.
    expect(queryRem(SURFACE_PANEL_GRID, 'grid-cols-2')).toBeGreaterThanOrEqual(2 * beside + gutter)
    expect(queryRem(SURFACE_PANEL_GRID, 'grid-cols-4')).toBeGreaterThanOrEqual(4 * beside + 3 * gutter)
    expect(queryRem(SURFACE_PANEL_GRID, 'grid-cols-4')).toBeGreaterThan(queryRem(SURFACE_PANEL_GRID, 'grid-cols-2'))
  })

  it('draws a ring at least as tall as the longest legend it can be asked to draw', async () => {
    await renderStill()
    // Beside a legend, a panel is as tall as the taller of the two. A ring
    // shorter than the longest legend would leave every panel whose legend is
    // short standing in the difference — the empty space this card replaced.
    const longest = Object.keys(SURFACE_LABEL_KEYS.os).length
    expect(longest).toBeGreaterThanOrEqual(7)
    expect(spacingRem(SURFACE_RING_BOX, 'size')).toBeGreaterThanOrEqual(longest * spacingRem(SURFACE_LEGEND_ROW_BOX, 'min-h'))
  })

  it('put each ring beside its legend when it fits, and every word of it whole', async () => {
    await renderStill()
    for (const id of ['surface', 'form', 'os', 'pwa']) {
      const ring = panel(id).querySelector('[data-surface-ring]') as HTMLElement
      const legend = panel(id).querySelector('ul') as HTMLElement
      expect(ringFrame(ring.className)).toBe(SURFACE_RING_BOX)
      expect(ring.parentElement?.className).toBe(SURFACE_RING_ROW)
      expect(legend.parentElement).toBe(ring.parentElement)
      // Under the ring only while the panel is narrower than the threshold —
      // which is only ever a single column, where there is no neighbour to be
      // uneven with; beside it from there on.
      expect(ring.parentElement).toHaveClass('flex-col', `@min-[${queryRem(SURFACE_RING_ROW, 'flex-row')}rem]/panel:flex-row`)
      // As wide as its widest row and no wider: a legend stretched across the
      // panel puts its counts an inch away from the names they belong to.
      expect(legend).toHaveClass('w-full', `@min-[${queryRem(SURFACE_RING_ROW, 'flex-row')}rem]/panel:w-max`, `@min-[${queryRem(SURFACE_RING_ROW, 'flex-row')}rem]/panel:max-w-full`)
      expect(legend.className.split(' ')).not.toContain('grow')
      for (const legendRow of rows(panel(id))) {
        const name = legendRow.children[1] as HTMLElement
        expect(name).toHaveClass('min-w-0', 'break-words')
        for (let box: HTMLElement | null = name; box !== null && box.tagName !== 'SECTION'; box = box.parentElement) {
          expect(box.className).not.toMatch(/(^|\s)(truncate|text-ellipsis|whitespace-nowrap|overflow-hidden|line-clamp-\d+)(\s|$)/)
        }
      }
    }
  })

  it('keeps every legend row a row where subgrid is missing', async () => {
    await renderStill()
    // Chrome 111–116 are inside this app's build target and drop `subgrid`. A
    // row that falls back to no columns of its own stacks its dot, name, count
    // and share into four lines — seven legend rows become twenty-eight.
    for (const legendRow of rows(panel('os'))) {
      expect(legendRow).toHaveClass(
        'grid-cols-subgrid',
        'not-supports-[grid-template-columns:subgrid]:grid-cols-[auto_minmax(0,1fr)_auto_auto]',
      )
    }
  })

  it('keep each number in the panel it describes', async () => {
    await renderStill()
    const surface = within(panel('surface'))
    const installs = within(panel('pwa'))

    expect(within(panel('surface')).getByRole('heading').textContent).toBe(t('analyticsPage.surfaces.panels.surface'))
    expect(within(panel('form')).getByRole('heading').textContent).toBe(t('analyticsPage.surfaces.panels.form'))
    expect(within(panel('os')).getByRole('heading').textContent).toBe(t('analyticsPage.surfaces.panels.os'))
    expect(within(panel('pwa')).getByRole('heading').textContent).toBe(t('analyticsPage.surfaces.panels.pwa'))

    expect(surface.getByText(t('analyticsPage.surfaces.tracked')).textContent).toBe(`${t('analyticsPage.surfaces.tracked')} 48`)
    expect(surface.getByText(t('analyticsPage.surfaces.active30d')).textContent).toBe(`${t('analyticsPage.surfaces.active30d')} 41`)
    expect(installs.getByText(t('analyticsPage.surfaces.pwaInstalls')).textContent).toBe(`${t('analyticsPage.surfaces.pwaInstalls')} 7`)
    for (const id of ['form', 'os']) {
      expect(within(panel(id)).getByText(t('analyticsPage.surfaces.lastVisit'))).toBeInTheDocument()
    }
    // Nowhere else: a number detached from its ring is what this card replaced.
    for (const id of ['form', 'os', 'pwa']) {
      expect(within(panel(id)).queryByText(t('analyticsPage.surfaces.tracked'))).toBeNull()
      expect(within(panel(id)).queryByText(t('analyticsPage.surfaces.active30d'))).toBeNull()
    }
    for (const id of ['surface', 'form', 'os']) {
      expect(within(panel(id)).queryByText(t('analyticsPage.surfaces.pwaInstalls'))).toBeNull()
    }
    // The ring's hole: its own total.
    expect([hole(panel('surface')), hole(panel('form')), hole(panel('os')), hole(panel('pwa'))]).toEqual(['48', '48', '48', '7'])
  })

  it('list each category with its count and its share of the ring, the neutral buckets last', async () => {
    await renderStill()
    const readRows = (id: string): string[][] =>
      rows(panel(id)).map((legendRow) => [...legendRow.children].slice(1).map((cell) => cell.textContent ?? ''))
    const percent = (value: number): string =>
      new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 }).format(value)

    expect(readRows('surface')).toEqual([
      [t('analyticsPage.surfaces.surface.tma'), '30', percent(30 / 48)],
      [t('analyticsPage.surfaces.surface.browser'), '12', percent(12 / 48)],
      [t('analyticsPage.surfaces.surface.pwa'), '6', percent(6 / 48)],
    ])
    expect(readRows('pwa')).toEqual([
      [t('analyticsPage.surfaces.os.android'), '4', percent(4 / 7)],
      [t('analyticsPage.surfaces.os.ios'), '1', percent(1 / 7)],
      // Larger than iOS, and still after it: "not recorded" is not a category.
      [t('analyticsPage.surfaces.os.unknown'), '2', percent(2 / 7)],
    ])
    expect(rows(panel('os')).map((legendRow) => legendRow.dataset.surfaceLegendRow)).toEqual(['ios', 'android', 'windows', 'macos', 'other'])
  })
})

// ── Colour ──────────────────────────────────────────────────────────────────

describe('colour follows the category, never its place', () => {
  it('draws iOS and Android in the same colours in «ОС» and in «Установки PWA по ОС»', async () => {
    await renderStill()
    const os = panel('os')
    const installs = panel('pwa')
    // Precondition: the two rings rank them differently.
    expect(rows(os).map((legendRow) => legendRow.dataset.surfaceLegendRow).slice(0, 2)).toEqual(['ios', 'android'])
    expect(rows(installs).map((legendRow) => legendRow.dataset.surfaceLegendRow).slice(0, 2)).toEqual(['android', 'ios'])

    for (const key of ['ios', 'android']) {
      expect(dot(row(os, key)), key).toBe(asDom(SURFACE_CATEGORY_COLORS.os[key] as string))
      expect(dot(row(installs, key)), key).toBe(dot(row(os, key)))
    }
    expect(dot(row(installs, 'unknown'))).toBe(asDom(SURFACE_UNKNOWN_COLOR))
    expect(dot(row(os, 'other'))).toBe(asDom(SURFACE_OTHER_COLOR))
  })

  it('paints each slice the colour of its legend row', async () => {
    await renderStill()
    for (const id of ['surface', 'form', 'os', 'pwa']) {
      const fills = sectorPaths(panel(id)).map((path) => path.getAttribute('fill'))
      expect(fills, id).toEqual(rows(panel(id)).map((legendRow) => dot(legendRow)))
    }
  })
})

// ── Hover ───────────────────────────────────────────────────────────────────

describe('pointing at a slice or a legend row points at both', () => {
  it('lights the legend row of the slice under the pointer, and shows its share in the hole', async () => {
    await renderStill()
    const os = panel('os')
    const sector = os.querySelectorAll('.recharts-pie-sector')[1] as Element

    fireEvent.mouseEnter(sector)

    expect(os.querySelectorAll('[data-highlighted]')).toHaveLength(1)
    expect(row(os, 'android')).toHaveAttribute('data-highlighted')
    expect(row(os, 'ios')).toHaveClass('opacity-50')
    expect(row(os, 'android')).not.toHaveClass('opacity-50')
    expect(hole(os)).toBe(new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 }).format(14 / 48))
    // The neighbouring panels are not involved.
    expect(document.querySelectorAll('[data-highlighted]')).toHaveLength(1)
    // The tooltip paints in the theme's own colours. `hsl(var(--background))`
    // is dropped by a browser here (the variables hold whole oklch() values),
    // and recharts would otherwise write the item in the slice's pale colour.
    const tooltip = await waitFor(() => {
      const box = os.querySelector<HTMLElement>('.recharts-default-tooltip')
      expect(box, 'no tooltip opened').not.toBeNull()
      return box as HTMLElement
    })
    expect(tooltip.getAttribute('style')).toContain('background-color: var(--background)')
    expect(tooltip.getAttribute('style')).not.toMatch(/hsl\(\s*var\(--/)
    expect(tooltip.querySelector('.recharts-tooltip-item')?.getAttribute('style')).toContain('color: var(--foreground)')

    // Recharts redraws the sector it now calls active: leave the one on the page, not the one entered.
    fireEvent.mouseLeave(os.querySelectorAll('.recharts-pie-sector')[1] as Element)

    expect(os.querySelectorAll('[data-highlighted]')).toHaveLength(0)
    expect(rows(os).filter((legendRow) => legendRow.classList.contains('opacity-50'))).toEqual([])
    expect(hole(os)).toBe('48')
  })

  it('dims the other slices while the pointer is on a legend row, and lets go when it leaves', async () => {
    await renderStill()
    const surface = panel('surface')
    const ringBox = surface.querySelector('[data-surface-ring]') as HTMLElement
    const browserRow = row(surface, 'browser')
    // The dimming is a rule on the ring's box, keyed by which slice is active —
    // NOT a prop on the sectors. A prop would re-render the chart, and recharts
    // restarts a sweep it is given new props for.
    const shapes = (): Array<string | null> => sectorPaths(surface).map((path) => path.getAttribute('d'))
    const drawn = shapes()
    expect(ringBox).not.toHaveAttribute('data-active-slice')
    expect(sectorPaths(surface).map((path) => path.getAttribute('fill-opacity'))).toEqual([null, null, null])

    // React builds onPointerEnter/Leave from pointerover/pointerout; a bare
    // `pointerenter` would reach no handler at all.
    act(() => {
      browserRow.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: null }))
    })

    expect(ringBox).toHaveAttribute('data-active-slice', '1')
    expect(ringBox).toHaveClass('data-[active-slice="1"]:[&_.recharts-pie-sector:not(:nth-child(2))]:opacity-30')
    expect(shapes(), 'the chart was rebuilt by a hover').toEqual(drawn)
    expect(browserRow).toHaveAttribute('data-highlighted')
    expect(hole(surface)).toBe(new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 }).format(12 / 48))

    act(() => {
      browserRow.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: null }))
    })

    expect(ringBox).not.toHaveAttribute('data-active-slice')
    expect(shapes(), 'the chart was rebuilt by a hover').toEqual(drawn)
    expect(browserRow).not.toHaveAttribute('data-highlighted')
    expect(hole(surface)).toBe('48')
  })

  it('has a rule for every slice a ring can draw', async () => {
    await renderStill()
    const ringBox = panel('os').querySelector('[data-surface-ring]') as HTMLElement
    // Tailwind reads the source, so each index is spelled out; a ring with more
    // slices than there are rules would light one and dim none.
    const rules = [...ringBox.classList].filter((token) => token.startsWith('data-[active-slice='))
    const buckets = Object.keys(SURFACE_LABEL_KEYS.os).length
    expect(rules.length).toBeGreaterThanOrEqual(buckets)
    for (let index = 0; index < buckets; index += 1) {
      expect(ringBox).toHaveClass(`data-[active-slice="${index}"]:[&_.recharts-pie-sector:not(:nth-child(${index + 1}))]:opacity-30`)
    }
  })
})

// ── Motion ──────────────────────────────────────────────────────────────────

/** Class tokens that move something. Hover transitions are allowed only as `motion-safe:` variants. */
const MOVING = /(^|\s)(animate-[\w-]+|transition(-[\w[\],-]+)?|opacity-0)(\s|$)/

function expectStill(): void {
  expect(recorded.pies.length, 'no ring was drawn').toBeGreaterThanOrEqual(4)
  expect(recorded.pies.every((pie) => pie.isAnimationActive === false), 'a ring was told to animate').toBe(true)
  expect([hole(panel('surface')), hole(panel('form')), hole(panel('os')), hole(panel('pwa'))]).toEqual(['48', '48', '48', '7'])
  expect(within(panel('surface')).getByText(t('analyticsPage.surfaces.active30d')).textContent).toBe(`${t('analyticsPage.surfaces.active30d')} 41`)
  expect(rows(panel('surface')).map((legendRow) => legendRow.children[2]?.textContent)).toEqual(['30', '12', '6'])
  // The card's own elements. The (i) is the shared `InfoTip`, whose only
  // transition is its icon's colour on hover — a fade, not movement.
  const moving = [...document.querySelectorAll('[data-surface-panel] *:not(button)')]
    .map((element) => (typeof element.className === 'string' ? element.className : ''))
    .filter((className) => MOVING.test(className))
  expect(moving).toEqual([])
  // Nothing waits for the panel to be seen…
  expect(visibility?.observed ?? []).toEqual([])
  // …and nothing is on its way anywhere: every number above was final before a
  // single frame ran, and running whatever is queued (recharts queues its own)
  // changes none of them.
  const before = [...document.querySelectorAll('[data-surface-panel]')].map((section) => section.textContent)
  runFrames(performance.now() + SURFACE_SWEEP_MS * 3)
  expect([...document.querySelectorAll('[data-surface-panel]')].map((section) => section.textContent)).toEqual(before)
}

describe('motion', () => {
  it('stands still when the system asks for less motion: rings drawn whole, numbers final, nothing waiting', async () => {
    visibility = installIntersectionObserver({ initiallyIntersecting: false })
    await renderStill()

    expectStill()
  })

  it('stands still when the operator has switched the panel’s animations off', async () => {
    visibility = installIntersectionObserver({ initiallyIntersecting: false })
    systemPrefersReducedMotion(false)
    useAppearanceStore.setState({ animationsEnabled: false })
    await renderCard()
    await waitFor(() => expect(panel('surface').querySelectorAll('.recharts-pie-sector').length).toBeGreaterThan(0))

    expectStill()
  })

  it('waits for each panel to come into view, then sweeps its ring in and counts its numbers up', async () => {
    visibility = installIntersectionObserver({ initiallyIntersecting: false })
    systemPrefersReducedMotion(false)
    await renderCard()

    // Every panel is watched on its own…
    expect(visibility.observed).toEqual(['surface', 'form', 'os', 'pwa'].map(panel))
    // …and until it is seen there is only the track, a zero, and no rows yet.
    for (const id of ['surface', 'form', 'os', 'pwa']) {
      expect(panel(id).querySelector('[data-surface-ring-track]'), id).not.toBeNull()
      expect(panel(id).querySelectorAll('.recharts-pie-sector'), id).toHaveLength(0)
      expect(hole(panel(id)), id).toBe('0')
      for (const legendRow of rows(panel(id))) expect(legendRow).toHaveClass('opacity-0')
    }
    expect(recorded.pies).toEqual([])

    // The surface panel scrolls into view; the others stay below the fold.
    const seenAt = performance.now()
    act(() => visibility?.report((node) => node === panel('surface')))

    expect(recorded.pies.length).toBeGreaterThan(0)
    expect(recorded.pies.every((pie) => pie.isAnimationActive === true)).toBe(true)
    expect(recorded.pies[0]?.animationBegin).toBe(0)
    for (const legendRow of rows(panel('surface'))) {
      expect(legendRow).toHaveClass('motion-safe:animate-in')
      expect(legendRow).not.toHaveClass('opacity-0')
    }
    expect(hole(panel('form'))).toBe('0')

    runFrames(seenAt + SURFACE_SWEEP_MS / 2)
    const halfway = Number(hole(panel('surface')))
    expect(halfway, 'half-way through the sweep').toBeGreaterThan(0)
    expect(halfway, 'half-way through the sweep').toBeLessThan(48)

    runFrames(seenAt + SURFACE_SWEEP_MS * 3)
    expect(hole(panel('surface'))).toBe('48')
    expect(within(panel('surface')).getByText(t('analyticsPage.surfaces.tracked')).textContent).toBe(`${t('analyticsPage.surfaces.tracked')} 48`)
    expect(hole(panel('form')), 'a panel still out of view has not played').toBe('0')
  })

  it('sweeps the ring WHILE the numbers count: the slices have moved between two moments of one sweep', async () => {
    visibility = installIntersectionObserver({ initiallyIntersecting: false })
    systemPrefersReducedMotion(false)
    await renderCard()
    act(() => visibility?.report((node) => node === panel('surface')))
    // recharts spends its first frames starting — the begin delay, then the
    // animation — and it reads the clock itself, so the sweep starts at the
    // first frame that is not in its past. From there the two samples are its
    // quarter and its two thirds.
    const sweepFrom = performance.now() + 1
    runFrames(sweepFrom)

    runFrames(sweepFrom + SURFACE_SWEEP_MS * 0.25)
    // The counted figure itself, not the line: while it counts there is a
    // second, screen-reader copy of the number it is on its way to.
    const countedStat = (): number =>
      Number(
        within(panel('surface'))
          .getByText(t('analyticsPage.surfaces.tracked'))
          .querySelector('[data-counting] [aria-hidden="true"]')?.textContent ?? '-1',
      )
    const early = { shapes: sectorPaths(panel('surface')).map((path) => path.getAttribute('d')), count: hole(panel('surface')), tracked: countedStat() }
    // The pointer lands on a legend row half-way through — which re-renders the
    // panel. The sweep must go on regardless: it is the chart being handed new
    // props that sends recharts back to the beginning.
    act(() => {
      row(panel('surface'), 'browser').dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: null }))
    })
    runFrames(sweepFrom + SURFACE_SWEEP_MS * 0.7)
    const later = { shapes: sectorPaths(panel('surface')).map((path) => path.getAttribute('d')), count: hole(panel('surface')), tracked: countedStat() }

    // Precondition: there is something drawn to compare.
    expect(early.shapes).toHaveLength(3)
    // A ring that went back to nothing draws no sectors at all.
    expect(later.shapes, 'the sweep started over').toHaveLength(3)
    expect(early.shapes.every((shape) => typeof shape === 'string' && shape.length > 0)).toBe(true)
    // The ring is sweeping…
    expect(later.shapes, 'the ring stood still while the numbers counted').not.toEqual(early.shapes)
    // …and the number is counting at the same time. Both at once is the point:
    // a count kept in the panel re-renders it every frame, which hands recharts
    // a new animation id, which starts the sweep again from nothing — the ring
    // then sits at the first frame for as long as the numbers run.
    expect(Number(early.count)).toBeGreaterThan(0)
    expect(Number(early.count)).toBeLessThan(48)
    expect(later.tracked, 'the count stood still').toBeGreaterThan(early.tracked)
    expect(early.tracked).toBeGreaterThan(0)

    act(() => {
      row(panel('surface'), 'browser').dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: null }))
    })
    runFrames(sweepFrom + SURFACE_SWEEP_MS * 3)
    expect(hole(panel('surface'))).toBe('48')
  })

  it('says the number it is on its way to while it counts, and one number once it arrives', async () => {
    visibility = installIntersectionObserver({ initiallyIntersecting: false })
    systemPrefersReducedMotion(false)
    await renderCard()
    const seenAt = performance.now()
    act(() => visibility?.report((node) => node === panel('surface')))
    runFrames(seenAt + SURFACE_SWEEP_MS * 0.4)

    const tracked = within(panel('surface')).getByText(t('analyticsPage.surfaces.tracked'))
    const counting = tracked.querySelector('[data-counting]')
    expect(counting, 'the number is not counting').not.toBeNull()
    // What is animated and what is read out are separate: a screen reader was
    // being told the zero the count happened to be passing through.
    expect(counting?.querySelector('[aria-hidden="true"]')?.textContent).not.toBe('48')
    expect(counting?.querySelector('.sr-only')?.textContent).toBe('48')

    runFrames(seenAt + SURFACE_SWEEP_MS * 3)

    // Arrived: one number again, so selecting it copies «48», not «4848».
    expect(tracked.querySelectorAll('[data-counting]')).toHaveLength(0)
    expect(tracked.textContent).toBe(t('analyticsPage.surfaces.tracked') + ' 48')
  })

  it('draws the finished card the moment the browser says it is printing', async () => {
    visibility = installIntersectionObserver({ initiallyIntersecting: false })
    systemPrefersReducedMotion(false)
    await renderCard()
    // Nothing has been on screen, so nothing has counted or swept: on paper
    // this was four empty rings, four zeroes, and legends at opacity 0.
    expect(hole(panel('surface'))).toBe('0')
    expect(rows(panel('surface'))[0]).toHaveClass('opacity-0')

    act(() => {
      window.dispatchEvent(new Event('beforeprint'))
    })

    expectStill()
    for (const id of ['surface', 'form', 'os', 'pwa']) {
      for (const legendRow of rows(panel(id))) expect(legendRow, id).not.toHaveClass('opacity-0')
      expect(panel(id).querySelectorAll('.recharts-pie-sector').length, id).toBeGreaterThan(0)
    }
  })

  it('does not count the total again when the pointer leaves a slice', async () => {
    visibility = installIntersectionObserver()
    systemPrefersReducedMotion(false)
    const shownAt = performance.now()
    await renderCard()
    runFrames(shownAt + SURFACE_SWEEP_MS * 3)
    expect(hole(panel('surface'))).toBe('48')
    const browserRow = row(panel('surface'), 'browser')

    act(() => {
      browserRow.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: null }))
    })
    act(() => {
      browserRow.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: null }))
    })

    expect(hole(panel('surface'))).toBe('48')
  })
})

// ── Before, without, and instead of data ────────────────────────────────────

describe('a panel with nothing to show', () => {
  it('keeps its ring as a grey track, a zero in it, and says why where the legend would be', async () => {
    systemPrefersReducedMotion(true)
    await renderCard(EMPTY)

    for (const [id, message] of [
      ['surface', 'analyticsPage.surfaces.empty'],
      ['form', 'analyticsPage.surfaces.empty'],
      ['os', 'analyticsPage.surfaces.empty'],
      ['pwa', 'analyticsPage.surfaces.emptyInstalls'],
    ] as const) {
      const ring = panel(id).querySelector('[data-surface-ring]') as HTMLElement
      expect(ringFrame(ring.className), id).toBe(SURFACE_RING_BOX)
      expect(ring.querySelector('[data-surface-ring-track]'), id).not.toBeNull()
      expect(hole(panel(id)), id).toBe('0')
      expect(panel(id).querySelector('ul'), id).toBeNull()
      const said = within(panel(id)).getByText(t(message))
      expect(said.parentElement, id).toBe(ring.parentElement)
    }
    expect(document.querySelectorAll('.recharts-pie-sector')).toHaveLength(0)
  })

  it('does so for installs alone while the other three have their rings', async () => {
    systemPrefersReducedMotion(true)
    await renderCard({ ...REPORT, pwaInstalls: 0, pwaInstallsByOs: [] })

    expect(within(panel('pwa')).getByText(t('analyticsPage.surfaces.emptyInstalls'))).toBeInTheDocument()
    expect(panel('pwa').querySelector('[data-surface-ring-track]')).not.toBeNull()
    for (const id of ['surface', 'form', 'os']) {
      await waitFor(() => expect(panel(id).querySelectorAll('.recharts-pie-sector').length, id).toBeGreaterThan(0))
      expect(within(panel(id)).queryByText(t('analyticsPage.surfaces.empty'))).toBeNull()
    }
  })
})

describe('while the numbers load', () => {
  it('holds the panels’ own frame, so nothing moves when they arrive', async () => {
    systemPrefersReducedMotion(true)
    let answer: (report: UsageSurfaceReport) => void = () => {}
    getSurfaceAnalytics.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    renderWithProviders(<SurfaceUsageCard />)

    const skeletons = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('[data-surface-panel-skeleton]')]
      expect(found).toHaveLength(4)
      return found
    })
    const grid = skeletons[0]?.parentElement as HTMLElement
    expect(grid.className).toBe(SURFACE_PANEL_GRID)
    expect(grid).toHaveAttribute('aria-busy', 'true')

    const frameOf = (box: HTMLElement) => {
      const heading = box.querySelector('[data-surface-heading]') as HTMLElement
      const ring = box.querySelector('[data-surface-ring]') as HTMLElement
      return {
        panel: box.className,
        halves: [...box.children].map((half) => (half as HTMLElement).className),
        heading: heading.className,
        title: (heading.firstElementChild as HTMLElement).className,
        note: (heading.lastElementChild as HTMLElement).className.split(' ')[0],
        ringRow: (ring.parentElement as HTMLElement).className,
        ring: ringFrame(ring.className),
      }
    }
    const skeletonFrames = skeletons.map(frameOf)
    expect(skeletonFrames[0]).toEqual({
      panel: SURFACE_PANEL,
      halves: [SURFACE_PANEL_HALF, SURFACE_PANEL_HALF],
      heading: SURFACE_PANEL_HEADING,
      title: SURFACE_TITLE_LINE,
      note: SURFACE_NOTE_LINE,
      ringRow: SURFACE_RING_ROW,
      ring: SURFACE_RING_BOX,
    })
    expect(
      skeletons.map((box) => box.querySelectorAll(`[data-surface-skeleton-legend] > .${SURFACE_LEGEND_ROW_BOX}`).length),
    ).toEqual([
      SURFACE_SKELETON_LEGEND_ROWS.surface,
      SURFACE_SKELETON_LEGEND_ROWS.form,
      SURFACE_SKELETON_LEGEND_ROWS.os,
      SURFACE_SKELETON_LEGEND_ROWS.pwa,
    ])
    expect(SURFACE_SKELETON_LEGEND_ROWS).toEqual({ surface: 3, form: 3, os: 6, pwa: 6 })
    // The shimmer stops for anyone who asked for stillness: never a bare `animate-pulse`.
    const shimmering = [...grid.querySelectorAll('*')].map((element) => element.getAttribute('class') ?? '')
    expect(shimmering.filter((className) => /(^|\s)motion-safe:animate-pulse(\s|$)/.test(className)).length).toBeGreaterThan(0)
    expect(shimmering.filter((className) => /(^|\s)animate-pulse(\s|$)/.test(className))).toEqual([])

    await act(async () => answer(REPORT))
    await waitFor(() => expect(document.querySelectorAll('[data-surface-panel]')).toHaveLength(4))

    const loaded = ['surface', 'form', 'os', 'pwa'].map((id) => frameOf(panel(id)))
    expect(loaded).toEqual(skeletonFrames)
    expect(rows(panel('os'))[0]).toHaveClass(SURFACE_LEGEND_ROW_BOX)
  })

  it('keeps the rings it has drawn when a later refetch fails', async () => {
    systemPrefersReducedMotion(true)
    getSurfaceAnalytics.mockResolvedValue(REPORT)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <SurfaceUsageCard />
          <SurfaceQueryProbe />
        </QueryClientProvider>
      </I18nextProvider>,
    )
    await waitFor(() => expect(document.querySelectorAll('[data-surface-panel]')).toHaveLength(4))

    // The window regains focus an hour later and the request fails.
    getSurfaceAnalytics.mockRejectedValue(new Error('offline'))
    await act(async () => {
      await client.refetchQueries({ queryKey: ['analytics', 'surfaces'] })
    })

    // Precondition: the query is in error, the card has been re-rendered with
    // that in hand, and the data it drew is still there. (The probe watches the
    // same query, so this waits for what the card itself has been told.)
    await waitFor(() => expect(document.querySelector('[data-surface-query="error"]')).not.toBeNull())
    expect(client.getQueryState(['analytics', 'surfaces'])?.data).not.toBeUndefined()
    // The operator is still reading the breakdown; a failure in the background
    // is no reason to take it off the screen and leave a sentence in its place.
    expect(screen.queryByText(t('analyticsPage.surfaces.unavailable'))).toBeNull()
    expect(document.querySelectorAll('[data-surface-panel]')).toHaveLength(4)
    expect(hole(panel('surface'))).toBe('48')
    expect(rows(panel('surface')).map((legendRow) => legendRow.children[2]?.textContent)).toEqual(['30', '12', '6'])
    client.clear()
  })

  it('says the statistics could not be loaded instead of drawing empty rings', async () => {
    systemPrefersReducedMotion(true)
    getSurfaceAnalytics.mockRejectedValue(new Error('offline'))
    renderWithProviders(<SurfaceUsageCard />)

    expect(await screen.findByText(t('analyticsPage.surfaces.unavailable'))).toBeInTheDocument()
    expect(document.querySelectorAll('[data-surface-panel], [data-surface-panel-skeleton]')).toHaveLength(0)
  })
})
