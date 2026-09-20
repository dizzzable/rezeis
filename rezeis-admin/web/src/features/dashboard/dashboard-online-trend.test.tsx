/**
 * «Онлайн пользователей»: what an operator reads on it, and when it moves.
 *
 * Held here: the window switch (a request per window, keyed by it, and labels
 * that follow the numbers on screen), the globe that turns the card over to
 * nodes and countries (a real toggle, by mouse and by keyboard), the permission
 * gate (no request at all without `remnawave:view`), the honest states (no
 * zero printed for a Remnawave that did not answer or a window nothing was
 * measured in), numbers and dates in the language of the interface, and
 * stillness under the system's reduce-motion and under the panel's own
 * animations switch.
 *
 * `Date` is fixed, so «today» and «yesterday» and every clock time below are
 * the same on every machine; expected times are formatted here, independently,
 * with `Intl` in the machine's own zone, which is the zone the card uses.
 */
import {
  cloneElement,
  isValidElement,
  type ComponentProps,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const recorded = vi.hoisted(() => ({
  areas: [] as Array<{ readonly isAnimationActive: unknown; readonly name: unknown }>,
  tooltips: [] as unknown[],
}))

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    Area: (props: ComponentProps<typeof actual.Area>) => {
      recorded.areas.push({ isAnimationActive: props.isAnimationActive, name: props.name })
      return <actual.Area {...props} />
    },
    Tooltip: (props: ComponentProps<typeof actual.Tooltip>) => {
      recorded.tooltips.push(props.isAnimationActive)
      return <actual.Tooltip {...props} />
    },
    // jsdom has no layout engine; draw at the size a stretched card would give.
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, { width: 640, height: 240 })
        : children,
  }
})

/**
 * Every element the motion library renders carries `data-motion-element`, so a
 * still card can be held to having none — the range switch's sliding thumb and
 * the sides' cross-fade included, which a class-based check cannot see.
 */
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>()
  const { createElement, forwardRef } = await import('react')
  const marked = new Map<PropertyKey, unknown>()
  const motion = new Proxy(actual.motion, {
    get(target, key) {
      if (!marked.has(key)) {
        const Component = Reflect.get(target, key) as ComponentType<Record<string, unknown>>
        marked.set(
          key,
          forwardRef<unknown, Record<string, unknown>>((props, ref) =>
            createElement(Component, { ...props, ref, 'data-motion-element': '' }),
          ),
        )
      }
      return marked.get(key)
    },
  })
  return { ...actual, motion }
})

import { usePermissionStore } from '@/features/rbac/use-permission-store'
import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { useAppearanceStore } from '@/lib/theme/appearance-store'

import {
  dashboardApi,
  onlineCardKeys,
  type OnlineDistribution,
  type OnlineOverview,
  type OnlineRange,
} from './dashboard-api'
import { DashboardOnlineDistribution } from './dashboard-online-distribution'
import { ONLINE_ANSWER_STALE_MS } from './dashboard-online-freshness'
import { ONLINE_CARD_PREFERENCE_KEY } from './dashboard-online-model'
import { DashboardOnlineTrend } from './dashboard-online-trend'

// ── Time, fixed ─────────────────────────────────────────────────────────────

/** 18.09.2026, 12:34:56 in this machine's own zone. */
const NOW = new Date(2026, 8, 18, 12, 34, 56).getTime()
const HOUR = 3_600_000
const ago = (ms: number): string => new Date(NOW - ms).toISOString()

/** The language's own short clock time: «04:00» in Russian, «4:00 AM» in English. */
function clock(at: string, locale: 'en-US' | 'ru-RU' = 'en-US'): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(Date.parse(at))
}
function count(value: number, locale: 'en-US' | 'ru-RU' = 'en-US'): string {
  return new Intl.NumberFormat(locale).format(value)
}

// ── Answers ─────────────────────────────────────────────────────────────────

function overview(partial: Partial<OnlineOverview> = {}): OnlineOverview {
  return {
    range: '24h',
    generatedAt: new Date(NOW).toISOString(),
    bucketMinutes: 5,
    points: [
      { time: ago(3 * HOUR), onlineNow: 900 },
      { time: ago(HOUR), onlineNow: 1234 },
      { time: ago(HOUR / 2), onlineNow: null },
      { time: ago(5 * 60_000), onlineNow: 1100 },
    ],
    sampleCount: 3,
    peak: { value: 1234, at: ago(HOUR) },
    latestSample: { onlineNow: 1100, at: ago(5 * 60_000) },
    live: { onlineNow: 1111, uniqueUsers: 4812, checkedAt: ago(60_000) },
    ...partial,
  }
}

const WEEK: OnlineOverview = overview({
  range: '7d',
  bucketMinutes: 60,
  peak: { value: 1780, at: ago(20 * HOUR) },
  live: { onlineNow: 1111, uniqueUsers: 9377, checkedAt: ago(60_000) },
})

function distribution(partial: Partial<OnlineDistribution> = {}): OnlineDistribution {
  return {
    range: '24h',
    generatedAt: new Date(NOW).toISOString(),
    sampledAt: ago(3 * 60_000),
    nodeReadFailedAt: null,
    totalUsersOnline: 170,
    nodes: [
      { uuid: 'nl-1', name: 'Amsterdam', countryCode: 'NL', usersOnline: 80, peak: 95, isConnected: true },
      { uuid: 'de-1', name: 'Frankfurt', countryCode: 'DE', usersOnline: 60, peak: 90, isConnected: true },
      { uuid: 'de-2', name: 'Berlin', countryCode: 'DE', usersOnline: 25, peak: 70, isConnected: true },
      { uuid: 'x-1', name: 'Mystery', countryCode: '', usersOnline: 5, peak: 5, isConnected: true },
      { uuid: 'de-3', name: 'Munich', countryCode: 'DE', usersOnline: 0, peak: 40, isConnected: false },
    ],
    countries: [
      { countryCode: 'DE', usersOnline: 85, nodes: 3, nodesConnected: 2 },
      { countryCode: 'NL', usersOnline: 80, nodes: 1, nodesConnected: 1 },
      { countryCode: '', usersOnline: 5, nodes: 1, nodesConnected: 1 },
    ],
    ...partial,
  }
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

function grant(...permissions: string[]): void {
  usePermissionStore.setState({ loaded: true, role: 'ADMIN', granted: new Set(permissions) })
}

/**
 * The tab going away and coming back, as both sides read it: react-query's
 * focus manager (`visibilitychange` on window, `document.visibilityState`) and
 * the card's own clock. The real event bubbles from the document, so one
 * dispatch reaches both.
 */
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
}

function renderCard(client = newClient()): { client: QueryClient; container: HTMLElement; unmount: () => void } {
  const view = render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <DashboardOnlineTrend />
      </QueryClientProvider>
    </I18nextProvider>,
  )
  return { client, container: view.container, unmount: view.unmount }
}

/** Until the answer lands the figures are placeholders under the same labels; wait for the answer. */
async function answered(): Promise<void> {
  await waitFor(() => {
    const figures = document.querySelector('[data-online-card] dl')
    expect(figures, 'the card has its figures').not.toBeNull()
    expect(figures).not.toHaveAttribute('aria-busy')
  })
}

/** Runs every queued frame, and the frames they queue, as if `ms` had passed. */
function runFrames(ms: number): void {
  act(() => {
    for (let round = 0; round < 50 && frames.length > 0; round += 1) {
      const due = frames
      frames = []
      for (const frame of due) frame(performance.now() + ms)
    }
  })
}

/** One of the three numbers under the title, by its label. */
function figure(label: string): { value: string; caption: string } {
  const term = screen.getByText(label, { selector: 'dt span' })
  const box = term.closest('[data-online-figure]') as HTMLElement
  const [value, caption] = [...box.querySelectorAll('dd')].map((dd) => dd.textContent ?? '')
  return { value: value ?? '', caption: caption ?? '' }
}

function rangeButton(name: string): HTMLElement {
  return within(screen.getByRole('group', { name: 'Period' })).getByRole('button', { name })
}

const getOverview = vi.spyOn(dashboardApi, 'getOnlineOverview')
const getDistribution = vi.spyOn(dashboardApi, 'getOnlineDistribution')

beforeAll(async () => {
  await i18nReady
  await i18n.changeLanguage('en')
  await loadFeatureBundle('dashboard')
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  recorded.areas.length = 0
  recorded.tooltips.length = 0
  frames = []
  window.localStorage.clear()
  getOverview.mockReset()
  getDistribution.mockReset()
  grant('remnawave:view')
  useAppearanceStore.setState({ animationsEnabled: true })
  // Still unless a test asks for motion: numbers and bars final from the first frame.
  systemPrefersReducedMotion(true)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  window.matchMedia = realMatchMedia
  setVisibility('visible')
  usePermissionStore.getState().reset()
})

afterAll(async () => {
  await i18n.changeLanguage('en')
})

// ── Permission ──────────────────────────────────────────────────────────────

describe('who gets the card', () => {
  it('asks nothing and shows nothing without remnawave:view — and asks the moment the grant arrives', async () => {
    usePermissionStore.getState().reset()
    getOverview.mockResolvedValue(overview())
    const { container } = renderCard()

    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
    expect(getOverview).not.toHaveBeenCalled()
    expect(getDistribution).not.toHaveBeenCalled()

    // Anti-vacuity: the same mount does ask once the operator may look.
    act(() => grant('remnawave:view'))
    await waitFor(() => expect(getOverview).toHaveBeenCalledWith('24h'))
  })

  it('keeps the nodes-and-countries side from asking on its own without the grant', async () => {
    usePermissionStore.getState().reset()
    getDistribution.mockResolvedValue(distribution())
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={newClient()}>
          <DashboardOnlineDistribution range="24h" animate={false} />
        </QueryClientProvider>
      </I18nextProvider>,
    )

    await act(async () => {})
    expect(getDistribution).not.toHaveBeenCalled()
    act(() => grant('remnawave:view'))
    await waitFor(() => expect(getDistribution).toHaveBeenCalledWith('24h'))
  })
})

// ── The window ──────────────────────────────────────────────────────────────

describe('the window switch', () => {
  it('asks for seven days under a key of its own, and labels the numbers by the window they belong to', async () => {
    let answerWeek: (value: OnlineOverview) => void = () => {}
    getOverview.mockImplementation((range: OnlineRange) =>
      range === '24h'
        ? // The day's peak was yesterday evening, twenty hours back.
          Promise.resolve(overview({ peak: { value: 1234, at: ago(20 * HOUR) } }))
        : new Promise((resolve) => (answerWeek = resolve)),
    )
    const user = userEvent.setup()
    const { client } = renderCard()

    await answered()
    expect(figure('Peak in 24 h')).toEqual({ value: count(1234), caption: `yesterday at ${clock(ago(20 * HOUR))}` })
    expect(rangeButton('24 h')).toHaveAttribute('aria-pressed', 'true')
    expect(rangeButton('7 days')).toHaveAttribute('aria-pressed', 'false')

    await user.click(rangeButton('7 days'))

    expect(getOverview).toHaveBeenLastCalledWith('7d')
    expect(rangeButton('7 days')).toHaveAttribute('aria-pressed', 'true')
    expect(client.getQueryCache().find({ queryKey: onlineCardKeys.overview('24h'), exact: true })).toBeDefined()
    expect(client.getQueryCache().find({ queryKey: onlineCardKeys.overview('7d'), exact: true })).toBeDefined()
    // Until the week arrives, the day's numbers stay — still called the day's.
    expect(screen.getByRole('group', { name: 'Period' })).toHaveAttribute('aria-busy', 'true')
    // …and still dated right: «yesterday» is judged by the answer's own clock,
    // not by the fetch time of a query that has no answer yet.
    expect(figure('Peak in 24 h')).toEqual({ value: count(1234), caption: `yesterday at ${clock(ago(20 * HOUR))}` })
    expect(screen.queryByText('Peak in 7 days')).toBeNull()

    act(() => answerWeek(WEEK))

    await screen.findByText('Peak in 7 days')
    expect(figure('Peak in 7 days').value).toBe(count(1780))
    expect(figure('Unique in a week').value).toBe(count(9377))
    // Twenty hours back from 12:34 is yesterday afternoon.
    expect(figure('Peak in 7 days').caption).toBe(`yesterday at ${clock(ago(20 * HOUR))}`)
    // A week's point is an hour's highest reading, and the series says so.
    await waitFor(() => expect(recorded.areas.at(-1)?.name).toBe('Online, hourly maximum'))
    expect(screen.getByRole('group', { name: 'Period' })).not.toHaveAttribute('aria-busy')
  })

  it('sends the window as the query parameter, and refuses an answer of the wrong shape', async () => {
    const get = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({ data: WEEK } as never)
      .mockResolvedValueOnce({ data: '<html>' } as never)

    await expect(dashboardApi.getOnlineOverview('7d')).resolves.toEqual(WEEK)
    expect(get).toHaveBeenCalledWith('/admin/remnawave/metrics/online-overview', { params: { range: '7d' } })
    await expect(dashboardApi.getOnlineOverview('24h')).rejects.toThrow()
    get.mockRestore()
  })

  it('remembers the window and the side for the next visit, and survives storage that throws', async () => {
    getOverview.mockResolvedValue(overview())
    getDistribution.mockResolvedValue(distribution())
    const user = userEvent.setup()
    const first = renderCard()
    await answered()
    await user.click(rangeButton('7 days'))
    await user.click(screen.getByRole('button', { name: 'Nodes and countries' }))

    expect(JSON.parse(window.localStorage.getItem(ONLINE_CARD_PREFERENCE_KEY) ?? '{}')).toEqual({ range: '7d', view: 'distribution' })
    first.unmount()

    // The next visit opens where this one was left.
    const second = renderCard()
    expect(await screen.findByRole('region', { name: 'By node' })).toBeInTheDocument()
    expect(getDistribution).toHaveBeenLastCalledWith('7d')
    second.unmount()

    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    renderCard()
    // Unreadable storage: the card opens on its defaults instead of not at all.
    await waitFor(() => expect(getOverview).toHaveBeenLastCalledWith('24h'))
    getItem.mockRestore()
  })
})

// ── Honest states ───────────────────────────────────────────────────────────

describe('what the card says when it cannot know', () => {
  it('says Remnawave is not answering instead of printing zero, and shows the newest reading as «now»', async () => {
    getOverview.mockResolvedValue(overview({ live: null }))
    renderCard()
    await answered()

    expect(figure('Unique in a day')).toEqual({ value: '—', caption: 'Remnawave is not answering' })
    expect(figure('Now')).toEqual({ value: count(1100), caption: `reading at ${clock(ago(5 * 60_000))}` })
    expect(document.querySelector('[data-live-dot]')).toHaveAttribute('data-live-dot', 'sample')
    // The stored chart is still drawn.
    expect(document.querySelector('[data-online-chart="24h"]')).not.toBeNull()
  })

  it('says nothing was measured in the window rather than drawing a flat zero', async () => {
    getOverview.mockResolvedValue(
      overview({ points: [], sampleCount: 0, peak: null, latestSample: null }),
    )
    renderCard()

    expect(await screen.findByText('Nothing was measured in the last 24 hours')).toBeInTheDocument()
    expect(document.querySelector('.recharts-wrapper')).toBeNull()
    expect(figure('Peak in 24 h')).toEqual({ value: '—', caption: 'no data' })
    // Remnawave's own «now» is still true.
    expect(figure('Now').value).toBe(count(1111))
  })

  it('has nothing for «now» when neither Remnawave nor the store has it', async () => {
    getOverview.mockResolvedValue(overview({ live: null, latestSample: null, sampleCount: 0, peak: null, points: [] }))
    renderCard()
    await answered()

    expect(figure('Now')).toEqual({ value: '—', caption: 'no data' })
    expect(document.querySelector('[data-live-dot]')).toHaveAttribute('data-live-dot', 'none')
  })

  it('names a peak of zero as zero, not one', async () => {
    getOverview.mockResolvedValue(
      overview({
        points: [
          { time: ago(HOUR), onlineNow: 0 },
          { time: ago(5 * 60_000), onlineNow: 0 },
        ],
        sampleCount: 2,
        peak: { value: 0, at: ago(5 * 60_000) },
      }),
    )
    renderCard()
    await answered()

    expect(figure('Peak in 24 h').value).toBe('0')
  })

  it('says the answer did not arrive, and asks again on request', async () => {
    getOverview.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(overview())
    const user = userEvent.setup()
    renderCard()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load who is online.')
    expect(figure('Now')).toEqual({ value: '—', caption: 'no data' })

    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(figure('Now').value).toBe(count(1111)))
    expect(getOverview).toHaveBeenCalledTimes(2)
  })
})

// ── Answers that stop being current ─────────────────────────────────────────

describe('an answer that is no longer current', () => {
  it('says so when a refresh fails — the dot stops being green — and a retry brings it back', async () => {
    getOverview
      .mockResolvedValueOnce(overview())
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce(overview({ live: { onlineNow: 1200, uniqueUsers: 4900, checkedAt: ago(0) } }))
    const user = userEvent.setup()
    const { client } = renderCard()
    await answered()
    expect(document.querySelector('[data-live-dot]')).toHaveAttribute('data-live-dot', 'live')
    expect(screen.queryByText(/Cannot refresh/)).toBeNull()

    await act(() => client.refetchQueries({ queryKey: onlineCardKeys.overview('24h') }))

    const notice = await screen.findByText(/Cannot refresh/)
    expect(notice).toHaveTextContent(`Cannot refresh: showing what arrived at ${clock(new Date(NOW).toISOString())}`)
    expect(document.querySelector('[data-live-dot]')).toHaveAttribute('data-live-dot', 'stale')
    // The last answer stays readable — it is the last thing known.
    expect(figure('Now').value).toBe(count(1111))

    await user.click(within(notice.closest('[data-online-stale]') as HTMLElement).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByText(/Cannot refresh/)).toBeNull())
    expect(figure('Now').value).toBe(count(1200))
    expect(document.querySelector('[data-live-dot]')).toHaveAttribute('data-live-dot', 'live')
  })

  it('dates the answer — without accusing the panel — when no fresh one has landed', async () => {
    // Later refetches never come back — the kind of silence a sleeping laptop or a hung proxy makes.
    getOverview.mockResolvedValueOnce(overview()).mockReturnValue(new Promise(() => {}))
    renderCard()
    await answered()
    expect(screen.queryByText(/Showing what arrived/)).toBeNull()

    // Three intervals and a second on, the operator comes back to the tab.
    act(() => {
      vi.setSystemTime(NOW + ONLINE_ANSWER_STALE_MS + 1_000)
      window.dispatchEvent(new Event('focus'))
    })

    const notice = await screen.findByText(/Showing what arrived/)
    expect(document.querySelector('[data-live-dot]')).toHaveAttribute('data-live-dot', 'stale')
    // Nothing was tried and failed, so nothing is blamed: this is not the amber line.
    expect(notice.closest('[data-online-stale]')).toHaveAttribute('data-online-stale', 'waiting')
    expect(screen.queryByText(/Cannot refresh/)).toBeNull()
  })

  it('asks again as soon as the tab is looked at, instead of waiting out the interval', async () => {
    // The poll stops while the tab is hidden (`refetchIntervalInBackground: false`),
    // so three minutes away leaves an old answer through nobody's fault. Before
    // this card asked on its own, the operator came back to «Не удаётся
    // обновить» over numbers that were merely waiting for the next tick.
    getOverview.mockResolvedValue(overview())
    renderCard()
    await answered()
    expect(getOverview).toHaveBeenCalledTimes(1)

    act(() => setVisibility('hidden'))
    act(() => {
      vi.setSystemTime(NOW + ONLINE_ANSWER_STALE_MS + 1_000)
      setVisibility('visible')
    })

    await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(document.querySelector('[data-online-stale]')).toBeNull())
    expect(document.querySelector('[data-live-dot]')).toHaveAttribute('data-live-dot', 'live')
  })

  it('says so on the nodes-and-countries side as well', async () => {
    window.localStorage.setItem(ONLINE_CARD_PREFERENCE_KEY, JSON.stringify({ range: '24h', view: 'distribution' }))
    getOverview.mockResolvedValue(overview())
    getDistribution.mockResolvedValueOnce(distribution()).mockRejectedValueOnce(new Error('503'))
    const { client } = renderCard()
    await screen.findByRole('region', { name: 'By node' })

    await act(() => client.refetchQueries({ queryKey: onlineCardKeys.distribution('24h') }))

    const notices = await screen.findAllByText(/Cannot refresh/)
    expect(notices).toHaveLength(1)
    expect(screen.getByRole('region', { name: 'Online by node and by country' })).toContainElement(
      screen.getByRole('region', { name: 'By node' }),
    )
  })
})

// ── The chart's marks ───────────────────────────────────────────────────────

describe('what the chart marks', () => {
  it('draws a reading with no reading on either side as a dot, instead of nothing', async () => {
    const at = (minutes: number) => ago(HOUR - minutes * 60_000)
    getOverview.mockResolvedValue(
      overview({
        points: [
          { time: at(0), onlineNow: 5 },
          { time: at(5), onlineNow: null },
          { time: at(10), onlineNow: 7 },
          { time: at(15), onlineNow: null },
          { time: at(20), onlineNow: 9 },
          { time: at(25), onlineNow: 10 },
        ],
        sampleCount: 4,
        peak: { value: 10, at: at(25) },
      }),
    )
    renderCard()
    await answered()

    // 5 and 7 stand alone; 9 and 10 make a line of their own.
    await waitFor(() => expect(document.querySelectorAll('[data-online-chart] [data-lone-reading]')).toHaveLength(2))
  })

  it('marks the peak on the chart only where the chart has it', async () => {
    // Remnawave's live figure above every stored sample: the header's peak is now, on no point of the chart.
    getOverview.mockResolvedValueOnce(
      overview({
        peak: { value: 1300, at: ago(60_000) },
        live: { onlineNow: 1300, uniqueUsers: 4812, checkedAt: ago(60_000) },
      }),
    )
    const livePeak = renderCard()
    await answered()
    expect(figure('Peak in 24 h').value).toBe(count(1300))
    await waitFor(() => expect(document.querySelector('[data-online-chart] .recharts-surface')).not.toBeNull())
    expect(document.querySelector('.recharts-reference-dot')).toBeNull()
    livePeak.unmount()

    getOverview.mockResolvedValueOnce(overview())
    renderCard()
    await answered()
    await waitFor(() => expect(document.querySelector('.recharts-reference-dot')).not.toBeNull())
  })
})

// ── The globe ───────────────────────────────────────────────────────────────

describe('the globe button', () => {
  it('turns the card over to nodes and countries and back, by mouse and by keyboard', async () => {
    getOverview.mockResolvedValue(overview())
    getDistribution.mockResolvedValue(distribution())
    const user = userEvent.setup()
    renderCard()
    await answered()
    const globe = screen.getByRole('button', { name: 'Nodes and countries' })

    expect(globe).toHaveAttribute('aria-pressed', 'false')
    expect(document.querySelector('[data-online-chart]')).not.toBeNull()
    expect(getDistribution).not.toHaveBeenCalled()

    await user.click(globe)

    expect(globe).toHaveAttribute('aria-pressed', 'true')
    const nodes = await screen.findByRole('region', { name: 'By node' })
    expect(getDistribution).toHaveBeenCalledWith('24h')
    expect(document.querySelector('[data-online-chart]')).toBeNull()
    expect(within(nodes).getAllByRole('listitem').map((row) => row.querySelector('span.truncate')?.textContent)).toEqual([
      'Amsterdam',
      'Frankfurt',
      'Berlin',
      'Mystery',
      'Munich',
    ])

    // Back with the keyboard alone.
    globe.focus()
    await user.keyboard('{Enter}')
    expect(globe).toHaveAttribute('aria-pressed', 'false')
    expect(document.querySelector('[data-online-chart]')).not.toBeNull()
    await user.keyboard(' ')
    expect(globe).toHaveAttribute('aria-pressed', 'true')
  })

  it('says what it does in a tooltip, and keeps its name while it is pressed', async () => {
    getOverview.mockResolvedValue(overview())
    getDistribution.mockResolvedValue(distribution())
    const user = userEvent.setup()
    renderCard()
    await answered()
    const globe = screen.getByRole('button', { name: 'Nodes and countries' })

    await user.hover(globe)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Show who is online by node and by country')
    await user.click(globe)
    expect(globe).toHaveAccessibleName('Nodes and countries')
  })

  it('ranks nodes and countries with localized names, shares of the connections, peaks and the node that is down', async () => {
    window.localStorage.setItem(ONLINE_CARD_PREFERENCE_KEY, JSON.stringify({ range: '24h', view: 'distribution' }))
    getOverview.mockResolvedValue(overview())
    getDistribution.mockResolvedValue(distribution())
    renderCard()

    const nodes = await screen.findByRole('region', { name: 'By node' })
    const countries = screen.getByRole('region', { name: 'By country' })

    const amsterdam = nodes.querySelector('[data-node-row="nl-1"]') as HTMLElement
    expect(amsterdam).toHaveTextContent('Amsterdam')
    expect(amsterdam).toHaveTextContent(`80${new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 0 }).format(80 / 170)}`)
    expect(amsterdam).toHaveTextContent('peak 95')
    expect(amsterdam.querySelector('[data-country-flag="NL"]')).not.toBeNull()

    // Down: last, marked, counting nobody, its peak still shown.
    const munich = nodes.querySelector('[data-node-row="de-3"]') as HTMLElement
    expect(munich).toHaveAttribute('data-connected', 'false')
    expect(munich).toHaveTextContent('no connection')
    expect(munich).toHaveTextContent('peak 40')
    expect(munich.querySelector('[data-share-bar]')).toHaveAttribute('data-share-bar', '0%')

    const germany = countries.querySelector('[data-country-row="DE"]') as HTMLElement
    expect(germany).toHaveTextContent('Germany')
    expect(germany).toHaveTextContent('2 of 3 nodes connected')
    const nowhere = countries.querySelector('[data-country-row=""]') as HTMLElement
    expect(nowhere).toHaveTextContent('No country')
    expect(nowhere.querySelector('[data-country-flag]')).toBeNull()

    expect(screen.getByText(/Connections are counted/)).toHaveTextContent(`As of the reading at ${clock(ago(3 * 60_000))}`)
  })

  it('judges «out of date» by the server’s clock, not by a browser clock running twenty minutes fast', async () => {
    vi.setSystemTime(NOW + 20 * 60_000)
    window.localStorage.setItem(ONLINE_CARD_PREFERENCE_KEY, JSON.stringify({ range: '24h', view: 'distribution' }))
    getOverview.mockResolvedValue(overview())
    // Taken three minutes before the server answered.
    getDistribution.mockResolvedValue(distribution())
    renderCard()

    await screen.findByRole('region', { name: 'By node' })
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText(/Connections are counted/)).toHaveTextContent(`As of the reading at ${clock(ago(3 * 60_000))}`)
  })

  it('shows the last node list that was read, and says the newest reading of it failed', async () => {
    window.localStorage.setItem(ONLINE_CARD_PREFERENCE_KEY, JSON.stringify({ range: '24h', view: 'distribution' }))
    getOverview.mockResolvedValue(overview())
    getDistribution.mockResolvedValue(distribution({ sampledAt: ago(25 * 60_000), nodeReadFailedAt: ago(3 * 60_000) }))
    renderCard()

    const notice = await screen.findByText(/Remnawave is not giving the node list/)
    expect(notice).toHaveTextContent(`Remnawave is not giving the node list: showing the one read at ${clock(ago(25 * 60_000))}`)
    expect(screen.getByRole('region', { name: 'By node' })).toBeInTheDocument()
    // One notice: the failing read explains the age better than «out of date».
    expect(screen.queryByText(/this is out of date/)).toBeNull()
  })

  it('says the node list could not be read — never «no enabled nodes» — when no reading of it worked', async () => {
    window.localStorage.setItem(ONLINE_CARD_PREFERENCE_KEY, JSON.stringify({ range: '24h', view: 'distribution' }))
    getOverview.mockResolvedValue(overview())
    getDistribution.mockResolvedValue(
      distribution({ sampledAt: null, nodeReadFailedAt: ago(3 * 60_000), nodes: [], countries: [], totalUsersOnline: 0 }),
    )
    renderCard()

    expect(await screen.findByRole('alert')).toHaveTextContent('Remnawave is not giving the node list')
    expect(screen.queryByText('The last reading has no enabled nodes.')).toBeNull()
    expect(screen.queryByText('Nothing was measured in the last 24 hours')).toBeNull()
  })

  it('lets a keyboard reach the lists that scroll: a named region that takes focus', async () => {
    window.localStorage.setItem(ONLINE_CARD_PREFERENCE_KEY, JSON.stringify({ range: '24h', view: 'distribution' }))
    getOverview.mockResolvedValue(overview())
    getDistribution.mockResolvedValue(distribution())
    const user = userEvent.setup()
    renderCard()
    const lists = await screen.findByRole('region', { name: 'Online by node and by country' })

    screen.getByRole('button', { name: 'Nodes and countries' }).focus()
    await user.tab()

    expect(lists).toHaveFocus()
  })

  it('says a reading is out of date, and says so when the window holds none', async () => {
    window.localStorage.setItem(ONLINE_CARD_PREFERENCE_KEY, JSON.stringify({ range: '24h', view: 'distribution' }))
    getOverview.mockResolvedValue(overview())
    getDistribution.mockResolvedValueOnce(distribution({ sampledAt: ago(2 * HOUR) }))
    const first = renderCard()

    expect(await screen.findByRole('status')).toHaveTextContent(`The last reading was at ${clock(ago(2 * HOUR))}: this is out of date`)
    first.unmount()

    getDistribution.mockResolvedValueOnce(distribution({ sampledAt: null, nodes: [], countries: [], totalUsersOnline: 0 }))
    renderCard()
    expect(await screen.findByText('Nothing was measured in the last 24 hours')).toBeInTheDocument()
  })
})

// ── Language ────────────────────────────────────────────────────────────────

describe('in Russian', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('writes numbers, times, countries and labels the Russian way', async () => {
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('dashboard')
    window.localStorage.setItem(ONLINE_CARD_PREFERENCE_KEY, JSON.stringify({ range: '24h', view: 'chart' }))
    getOverview.mockResolvedValue(overview({ live: null }))
    getDistribution.mockResolvedValue(distribution())
    const user = userEvent.setup()
    renderCard()

    await answered()
    expect(figure('Пик за 24 ч')).toEqual({ value: count(1234, 'ru-RU'), caption: `в ${clock(ago(HOUR), 'ru-RU')}` })
    expect(figure('Уникальных за сутки')).toEqual({ value: '—', caption: 'Remnawave не отвечает' })
    expect(figure('Сейчас').caption).toBe(`замер в ${clock(ago(5 * 60_000), 'ru-RU')}`)

    await user.click(screen.getByRole('button', { name: 'Ноды и страны' }))
    const countries = await screen.findByRole('region', { name: 'По странам' })
    expect(countries.querySelector('[data-country-row="DE"]')).toHaveTextContent('Германия')
    expect(countries.querySelector('[data-country-row="DE"]')).toHaveTextContent('2 из 3 нод на связи')
  })
})

// ── Motion ──────────────────────────────────────────────────────────────────

/**
 * Class tokens that move something unconditionally. A `motion-safe:` one is the
 * system's to stop; `transition-colors` — every Button's hover — changes a
 * colour, which is not motion.
 */
function movingTokens(className: string): string[] {
  return className.split(/\s+/).filter((token) => /^(animate-|transition)/.test(token) && token !== 'transition-colors')
}

async function expectStillCard(): Promise<void> {
  getOverview.mockResolvedValue(overview())
  getDistribution.mockResolvedValue(distribution())
  const user = userEvent.setup()
  renderCard()
  await answered()

  // Numbers final at once — no count from zero.
  expect(figure('Now').value).toBe(count(1111))
  expect(figure('Peak in 24 h').value).toBe(count(1234))
  // The chart drawn whole, its tooltip without a glide.
  await waitFor(() => expect(recorded.areas.length).toBeGreaterThan(0))
  expect(recorded.areas.every((area) => area.isAnimationActive === false), 'the area was told to animate').toBe(true)
  expect(recorded.tooltips.length, 'no tooltip was drawn — the check below would be empty').toBeGreaterThan(0)
  expect(recorded.tooltips.every((active) => active === false), 'the tooltip was told to animate').toBe(true)
  expect(document.querySelector('[data-live-dot]')?.className).not.toMatch(/animate-/)
  // Every element of the card, the range switch and the globe included.
  const moving = [...document.querySelectorAll('[data-online-card], [data-online-card] *')].flatMap((element) =>
    movingTokens(element.getAttribute('class') ?? ''),
  )
  expect(moving).toEqual([])
  // And nothing the motion library drives: no sliding thumb, no cross-fade.
  expect(document.querySelectorAll('[data-online-card] [data-motion-element]')).toHaveLength(0)

  // Turning the card over swaps the sides in one step: nothing lingers on its way out.
  await user.click(screen.getByRole('button', { name: 'Nodes and countries' }))
  expect(document.querySelector('[data-online-view="chart"]')).toBeNull()
  expect(document.querySelector('[data-online-view="distribution"]')).not.toBeNull()
  expect(document.querySelectorAll('[data-online-card] [data-motion-element]')).toHaveLength(0)
  // And the bars stand at their width from the start.
  const bar = (await screen.findByRole('region', { name: 'By node' })).querySelector('[data-node-row="nl-1"] [data-share-bar]') as HTMLElement
  expect(bar.style.width).toBe(bar.getAttribute('data-share-bar'))
  expect(bar.style.width).not.toBe('0%')
}

describe('motion', () => {
  it('stands still when the system asks for less motion', async () => {
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame))
    systemPrefersReducedMotion(true)
    await expectStillCard()
  })

  it('stands still when the operator has switched the panel’s animations off', async () => {
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame))
    systemPrefersReducedMotion(false)
    useAppearanceStore.setState({ animationsEnabled: false })
    await expectStillCard()
  })

  it('otherwise draws the chart in, counts the numbers up, eases the sides over and grows the bars', async () => {
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame))
    vi.stubGlobal('cancelAnimationFrame', () => {})
    systemPrefersReducedMotion(false)
    getOverview.mockResolvedValue(overview())
    getDistribution.mockResolvedValue(distribution())
    renderCard()
    await answered()

    // The count starts from zero and waits for frames.
    expect(figure('Now').value).toBe('0')
    runFrames(5_000)
    expect(figure('Now').value, 'and reaches the value once time has passed').toBe(count(1111))
    await waitFor(() => expect(recorded.areas.length).toBeGreaterThan(0))
    expect(recorded.areas.every((area) => area.isAnimationActive === true)).toBe(true)
    expect(document.querySelector('[data-live-dot]')).toHaveClass('motion-safe:animate-pulse')
    // Anti-vacuity for the still cards: here the thumb and the sides ARE the motion library's.
    expect(document.querySelector('[data-range="24h"] [data-motion-element]')).not.toBeNull()
    expect(document.querySelector('[data-online-view][data-motion-element]')).not.toBeNull()

    // The chart side eases out before the other comes in: in the very commit of
    // the click it is still there. (Synchronous on purpose — the frame loop of
    // the motion library runs on real time.)
    fireEvent.click(screen.getByRole('button', { name: 'Nodes and countries' }))
    expect(document.querySelector('[data-online-view="chart"]')).not.toBeNull()
  })

  it('grows the bars in from nothing when motion is allowed, and draws them at their width when it is not', () => {
    const client = newClient()
    client.setQueryData(onlineCardKeys.distribution('24h'), distribution())
    const renderSide = (animate: boolean) =>
      render(
        <I18nextProvider i18n={i18n}>
          <QueryClientProvider client={client}>
            <DashboardOnlineDistribution range="24h" animate={animate} />
          </QueryClientProvider>
        </I18nextProvider>,
      )
    const firstBar = (): HTMLElement =>
      document.querySelector('[data-node-row="nl-1"] [data-share-bar]') as HTMLElement

    // The first commit, before any frame: the answer is already in the cache.
    const moving = renderSide(true)
    expect(firstBar().getAttribute('data-share-bar')).toBe('47.1%')
    expect(firstBar().style.width).toBe('0%')
    moving.unmount()

    renderSide(false)
    expect(firstBar().style.width).toBe('47.1%')
  })
})
