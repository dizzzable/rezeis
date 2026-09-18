/**
 * The «Онлайн пользователей» card fills its half of the dashboard row with its
 * chart, rather than leaving an empty band under it — up to a ceiling.
 *
 * The card shares a grid row with the subscription card, and a grid row
 * stretches both cards to the taller one. With two columns the subscription
 * card is always the taller one: its client-apps half carries a note under the
 * ring. The trend card drew a fixed 12rem chart at the top of that height, and
 * the empty band under it was 244–260 px at 1920 with the sidebar open.
 *
 * Filling the card closed the band and, on the narrowest two-column windows,
 * made the chart as tall as the band had been: 862–902 px at 1024–1180 with the
 * sidebar open. The row is now two columns only from `xl` (see
 * `dashboard-chart-row-layout.test.tsx`), and the chart stops at 32rem, centred
 * in what the card has left.
 *
 * Measured again on 18.09.2026, after the card's header gained its three
 * figures and its window switch (Chromium, the default font, ru and en, sidebar
 * open and collapsed, 768–2560 px): side by side the chart is 370 px at 1920
 * with the sidebar open, 386 px at 1576–1600, 452–468 px at 1384–1440 and
 * 436–468 px at 1280, each time filling the card down to its padding; stacked,
 * below 1280, it is 192 px. None of those reaches the 32rem ceiling any more —
 * it stays for a subscription card that grows taller still (large font size,
 * long app names). Where the subscription card is short — 1920 without the
 * sidebar, 2560 with it — this card is now the taller of the two, at 382 px,
 * and the one beside it gets about 18 px more than its content.
 *
 * The other side of the card («Ноды и страны») takes the same height from the
 * row and scrolls inside it, so turning the card over does not move the row:
 * 560 and 560 px at 1920, 642 and 642 at 1440 (see
 * `dashboard-online-distribution.tsx`).
 *
 * jsdom has no layout engine, so what is held here is the arrangement those
 * measurements depend on: a column card whose content takes the rest of the
 * cell and centres the chart, and a chart that takes the whole content with
 * 12rem as its floor and 32rem as its ceiling, drawn by recharts at whatever
 * size that box has.
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePermissionStore } from '@/features/rbac/use-permission-store'
import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { dashboardApi, type OnlineOverview } from './dashboard-api'
import { DashboardOnlineTrend } from './dashboard-online-trend'

const handedToContainer = vi.hoisted(() => [] as Array<{ width?: unknown; height?: unknown }>)

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    // jsdom has no layout engine: record what the container is asked to follow,
    // and draw the chart at a fixed size.
    ResponsiveContainer: ({ children, width, height }: { children: ReactNode; width?: unknown; height?: unknown }) => {
      handedToContainer.push({ width, height })
      return isValidElement(children)
        ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, { width: 640, height: 192 })
        : children
    },
  }
})

/** The chart's box, and every box between it and the card. */
function chain(): { card: HTMLElement; between: HTMLElement[]; chartBox: HTMLElement } {
  const drawn = document.querySelector('.recharts-wrapper')
  if (drawn === null) throw new Error('no chart is drawn')
  const chartBox = drawn.parentElement as HTMLElement
  const card = chartBox.closest<HTMLElement>('[data-concept-surface="card"]')
  if (card === null) throw new Error('the chart is not inside a card')
  const between: HTMLElement[] = []
  for (let box = chartBox.parentElement; box !== null && box !== card; box = box.parentElement) between.push(box)
  return { card, between, chartBox }
}

beforeAll(async () => {
  await loadFeatureBundle('dashboard')
})

beforeEach(() => {
  handedToContainer.length = 0
  window.localStorage.clear()
  // The card only exists for an operator who may view Remnawave.
  usePermissionStore.setState({ loaded: true, role: 'ADMIN', granted: new Set(['remnawave:view']) })
  const overview: OnlineOverview = {
    range: '24h',
    generatedAt: '2026-09-14T08:11:30.000Z',
    bucketMinutes: 5,
    points: [
      { time: '2026-09-14T08:00:00.000Z', onlineNow: 120 },
      { time: '2026-09-14T08:05:00.000Z', onlineNow: 180 },
      { time: '2026-09-14T08:10:00.000Z', onlineNow: 150 },
    ],
    sampleCount: 3,
    peak: { value: 180, at: '2026-09-14T08:05:00.000Z' },
    latestSample: { onlineNow: 150, at: '2026-09-14T08:10:00.000Z' },
    live: { onlineNow: 151, uniqueUsers: 900, checkedAt: '2026-09-14T08:11:00.000Z' },
  }
  vi.spyOn(dashboardApi, 'getOnlineOverview').mockResolvedValue(overview)
})

afterEach(() => {
  usePermissionStore.getState().reset()
})

describe('the online trend card', () => {
  it('gives the chart the height the grid row stretches the card to, up to 32rem, centred in the rest', async () => {
    renderWithProviders(<DashboardOnlineTrend />)
    await waitFor(() => {
      expect(document.querySelector('.recharts-wrapper'), 'the chart was never drawn').not.toBeNull()
    })
    const { card, between, chartBox } = chain()

    // The card lays its header and content out as a column…
    expect(card).toHaveClass('flex', 'flex-col')
    // …the content takes whatever the header leaves of the cell…
    expect(between, 'anti-vacuity: the content box sits between the card and the chart').not.toHaveLength(0)
    for (const box of between) expect(box).toHaveClass('flex-1')
    // …and centres the chart in it when the chart stops short of filling it…
    expect(chartBox.parentElement).toHaveClass('flex', 'flex-col', 'justify-center')
    // …and the chart takes all of it: never less than the 12rem it always had,
    // never more than 32rem.
    expect(chartBox).toHaveClass('h-full', 'min-h-48', 'max-h-128')
    expect(chartBox.className).not.toMatch(/(^|\s)(h-\d+|h-\[[^\]]+\])(\s|$)/)
    expect(chartBox.className.match(/(^|\s)max-h-\S+/g), 'one ceiling, not two').toHaveLength(1)
    // recharts draws at the size of that box.
    expect(handedToContainer).not.toHaveLength(0)
    for (const props of handedToContainer) expect(props).toMatchObject({ width: '100%', height: '100%' })
  })

  it('turned over, takes the height the row gives the card and scrolls inside it — side by side only', async () => {
    window.localStorage.setItem('rezeis.dashboard.onlineCard', JSON.stringify({ range: '24h', view: 'distribution' }))
    vi.spyOn(dashboardApi, 'getOnlineDistribution').mockResolvedValue({
      range: '24h',
      generatedAt: '2026-09-14T08:11:30.000Z',
      sampledAt: '2026-09-14T08:10:00.000Z',
      nodeReadFailedAt: null,
      totalUsersOnline: 3,
      nodes: [{ uuid: 'n', name: 'Node', countryCode: 'DE', usersOnline: 3, peak: 4, isConnected: true }],
      countries: [{ countryCode: 'DE', usersOnline: 3, nodes: 1, nodesConnected: 1 }],
    })
    renderWithProviders(<DashboardOnlineTrend />)
    const lists = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-online-lists]')
      if (found === null) throw new Error('the lists were never drawn')
      return found
    })
    const side = lists.parentElement as HTMLElement
    const card = side.closest<HTMLElement>('[data-concept-surface="card"]') as HTMLElement

    // Every box from the card down fills what its parent leaves…
    for (let box = side.parentElement; box !== null && box !== card; box = box.parentElement) {
      expect(box).toHaveClass('flex-1')
    }
    // …and from `xl`, where the row sets the height, the side adds none of its
    // own (a zero basis, no content minimum) and the lists scroll instead.
    expect(side).toHaveClass('xl:flex-1', 'xl:basis-0', 'xl:min-h-0')
    expect(lists).toHaveClass('xl:flex-1', 'xl:min-h-0', 'xl:overflow-y-auto')
    // Below `xl` the cards stack and nothing scrolls inside the card: no
    // unprefixed ceiling or scroll.
    for (const box of [side, lists]) {
      expect(box.className).not.toMatch(/(^|\s)(max-h-\S+|overflow-y-auto|overflow-auto)(\s|$)/)
    }
  })
})
