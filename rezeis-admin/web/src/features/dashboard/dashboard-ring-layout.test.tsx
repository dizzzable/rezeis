/**
 * Where the ring puts its legend — the arrangement that keeps every word whole.
 *
 * jsdom has no layout engine, so a word broken in the middle cannot be seen
 * here. The widths were measured in Chromium against the compiled classes with
 * the panel's own fonts (see `dashboard-ring.tsx`); what is held here is the
 * arrangement those measurements depend on. At a 22rem threshold the legend
 * sat beside the ring in half of a 1920 px dashboard and read
 * "Ограничен|ные", "Истёкши|е".
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DashboardRing } from './dashboard-ring'

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    // jsdom has no layout engine; give the ring the size its fixed wrapper would.
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, { width: 192, height: 192 })
        : children,
  }
})

/** The ring's fixed box: `h-48 w-48`, in px at the default 16 px root. */
const RING_PX = 192
/** `gap-x-6` beside the ring. */
const GAP_PX = 24
/**
 * The widest legend row measured: dot, two gaps, "Ограниченные" and a six-digit
 * count, in IBM Plex Mono — the widest of the panel's fonts (Geist: 189.4 px).
 */
const WIDEST_ROW_PX = 191.2

function renderRing() {
  return render(
    <DashboardRing
      slices={[
        { key: 'active', name: 'Активные (> 7 дн.)', value: 187310, color: 'hsl(142, 71%, 45%)' },
        { key: 'limited', name: 'Ограниченные', value: 214000, color: 'hsl(48, 96%, 53%)' },
        { key: 'expired', name: 'Истёкшие', value: 312000, color: 'hsl(0, 84%, 60%)' },
        { key: 'expiring', name: 'Истекают (7д)', value: 960000, color: 'hsl(25, 95%, 53%)' },
      ]}
      total={1673310}
      tooltipStyle={{}}
    />,
  )
}

/** The ring, the legend beside or under it, and the box that lays them out. */
function parts(container: HTMLElement) {
  const legendList = container.querySelector('ul')
  if (legendList === null) throw new Error('no legend is drawn')
  const legend = legendList.parentElement as HTMLElement
  const layout = legend.parentElement as HTMLElement
  const ring = layout.firstElementChild as HTMLElement
  return { layout, ring, legend }
}

/** Every container-width threshold a class list switches on, in rem. */
function thresholds(element: HTMLElement): number[] {
  return [...element.className.matchAll(/@min-\[([\d.]+)rem\]:/g)].map((match) => Number(match[1]))
}

describe('the ring legend', () => {
  it('goes beside the ring only from a column its widest row fits in, and under it below that', () => {
    const { container } = renderRing()
    const { layout, ring, legend } = parts(container)

    expect(layout.parentElement).toHaveClass('@container')
    expect(ring).toHaveClass('h-48', 'w-48', 'shrink-0')
    // Below the threshold: stacked and centred, the legend with the whole column.
    expect(layout).toHaveClass('flex', 'flex-col', 'items-center')

    // One threshold for the row and its legend: two would leave a band where
    // the legend is sized for a row that is not there.
    const used = new Set([...thresholds(layout), ...thresholds(legend)])
    expect([...used], 'the layout and its legend switch at different widths').toHaveLength(1)
    const [rem] = [...used]
    expect(
      rem! * 16,
      `beside the ring from ${rem}rem, the widest row would break a word`,
    ).toBeGreaterThanOrEqual(RING_PX + GAP_PX + WIDEST_ROW_PX)
    expect(layout).toHaveClass(`@min-[${rem}rem]:flex-row`, `@min-[${rem}rem]:gap-x-6`)
  })

  it('moves under the ring rather than break a word when a row still does not fit beside it', () => {
    const { container } = renderRing()
    const { layout, ring, legend } = parts(container)
    const [rem] = thresholds(layout)

    // The row may wrap, and the legend's size for that decision is its
    // narrowest — its longest word and count — growing to its natural width.
    expect(layout).toHaveClass(`@min-[${rem}rem]:flex-wrap`, `@min-[${rem}rem]:items-start`)
    expect(legend).toHaveClass(
      `@min-[${rem}rem]:w-min`,
      `@min-[${rem}rem]:grow`,
      `@min-[${rem}rem]:max-w-max`,
      `@min-[${rem}rem]:self-center`,
    )
    // The ring itself never gives way.
    expect(ring).toHaveClass('shrink-0')
    // A word wider than the whole column is the one thing still allowed to break,
    // so it stays inside the card; nothing anywhere cuts the text short.
    for (const label of container.querySelectorAll('li > span:nth-child(2)')) {
      expect(label).toHaveClass('min-w-0', 'break-words')
      for (let box: Element | null = label; box !== null && box !== container; box = box.parentElement) {
        expect(box.className).not.toMatch(/(^|\s)(truncate|text-ellipsis|whitespace-nowrap|overflow-hidden|line-clamp-\d+)(\s|$)/)
      }
    }
  })
})
