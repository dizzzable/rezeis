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
 * in what the card has left. Measured in Chromium 152 against the compiled
 * classes (Geist and IBM Plex Mono, ru and en, sidebar open and collapsed,
 * 768–2600 px), the chart is 436–452 px at 1920 with no band, as before; 512 px
 * at 1280–1576 with the sidebar open (1280–1384 collapsed), where the cap
 * leaves at most 22 px, split above and below it; and 192 px below 1280, where
 * the cards stack.
 *
 * jsdom has no layout engine, so what is held here is the arrangement those
 * measurements depend on: a column card whose content takes the rest of the
 * cell and centres the chart, and a chart that takes the whole content with
 * 12rem as its floor and 32rem as its ceiling, drawn by recharts at whatever
 * size that box has.
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { dashboardApi, type OnlineTrendPoint } from './dashboard-api'
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
  const trend: OnlineTrendPoint[] = [
    { time: '2026-09-14T08:00:00.000Z', onlineNow: 120, totalUsers: 900, nodesOnline: 3 },
    { time: '2026-09-14T09:00:00.000Z', onlineNow: 180, totalUsers: 900, nodesOnline: 3 },
    { time: '2026-09-14T10:00:00.000Z', onlineNow: 150, totalUsers: 901, nodesOnline: 4 },
  ]
  vi.spyOn(dashboardApi, 'getOnlineTrend').mockResolvedValue(trend)
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
})
