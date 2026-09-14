/**
 * What the subscription ring calls its slices, in the words the operator reads.
 *
 * The slices are disjoint: the subscriptions expiring within 7 days are taken
 * out of the active slice (`dashboard-subscription-chart.tsx`), so the green
 * slice holds only the active subscriptions with more than 7 days left — 44 of
 * 52 here. It was still labelled plain "Активные" / "Active", the word the
 * "Активные подписки" / "Active subscriptions" card on the same page counts all
 * 52 under, and the page showed two "active" numbers that contradicted each
 * other.
 *
 * The tooltip on a slice has to say the same. It said nothing: the ring handed
 * recharts an empty name for every slice, so hovering the green one read
 * " : 44" — while the legend, which truncated, showed "Активные (…" at the
 * card's two-column width. The legend now prints every label whole.
 *
 * The card's other spec mocks `t` and reads keys. This one renders the
 * bundles themselves, one language at a time and with no fallback, so a word
 * missing from one of them cannot be covered by the other.
 */
import { cloneElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/features/dashboard.en'
import { ru } from '@/i18n/features/dashboard.ru'

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    // jsdom never advances recharts' entrance animation: the sectors stay
    // without a shape, and there is no slice to point at.
    Pie: (props: ComponentProps<typeof actual.Pie>) => <actual.Pie {...props} isAnimationActive={false} />,
    // jsdom has no layout engine; give the ring the size its fixed wrapper would.
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, {
            width: 192,
            height: 192,
          })
        : children,
  }
})

// The right half has a spec of its own; here it would only add a permission gate and a request.
vi.mock('./dashboard-client-apps', () => ({ DashboardClientApps: () => null }))

import { DashboardSubscriptionChart, SUBSCRIPTION_STATUS_COLORS } from './dashboard-subscription-chart'

/** 52 active, 8 of them expiring within 7 days; 2 expired; none limited. */
const SUMMARY = { subscriptions: { active: 52, limited: 0, expired: 2, expiring7d: 8 } } as never

type Bundle = typeof ru | typeof en

function renderCard(lng: 'ru' | 'en', bundle: Bundle) {
  const i18n = createInstance()
  void i18n.use(initReactI18next).init({
    lng,
    resources: { [lng]: { translation: bundle } },
    interpolation: { escapeValue: false },
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <DashboardSubscriptionChart summary={SUMMARY} />
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

/** A CSS colour as jsdom serialises it, so a legend dot can be matched to its slice. */
function computed(color: string): string {
  const probe = document.createElement('span')
  probe.style.backgroundColor = color
  return probe.style.backgroundColor
}

/** The legend row element whose dot is `color`. */
function legendRowElement(bundle: Bundle, color: string): HTMLElement {
  const column = screen
    .getByRole('heading', { name: bundle.dashboardPage.subscriptionChart.title })
    .closest('section') as HTMLElement
  const rows = within(column)
    .getAllByRole('listitem')
    .filter((row) => !row.classList.contains('recharts-tooltip-item'))
  const row = rows.find((candidate) => (candidate.children[0] as HTMLElement | undefined)?.style.backgroundColor === computed(color))
  if (row === undefined) throw new Error(`no legend row is drawn in ${color}`)
  return row
}

/** The legend row whose dot is `color`: its label and its number. */
function legendRow(bundle: Bundle, color: string): { readonly label: string; readonly value: number } {
  const row = legendRowElement(bundle, color)
  return { label: row.children[1]?.textContent ?? '', value: Number(row.children[2]?.textContent) }
}

/** Points at the slice drawn in `color`, the way a mouse over it does. */
function hoverSlice(color: string): void {
  const shape = document.querySelector(`.recharts-pie-sector path[fill="${color}"]`)
  if (shape === null) throw new Error(`no slice is drawn in ${color}`)
  fireEvent.mouseEnter(shape.closest('.recharts-pie-sector') as Element)
}

/** Classes that cut text short or clip it: the ellipsis, no wrapping, a line clamp, a hidden overflow. */
const CLIPPING = /(^|\s)(truncate|text-ellipsis|text-clip|whitespace-nowrap|overflow-hidden|overflow-x-hidden|line-clamp-\d+)(\s|$)/

/** The label and every element between it and the card's column, each of which could clip it. */
function labelAndItsBoxes(label: HTMLElement): HTMLElement[] {
  const boxes: HTMLElement[] = []
  for (let element: HTMLElement | null = label; element !== null && element.tagName !== 'SECTION'; element = element.parentElement) {
    boxes.push(element)
  }
  return boxes
}

/** What the open tooltip names, and with what number. */
function tooltip(): { readonly name: string | null; readonly value: string | null } {
  const items = document.querySelectorAll('.recharts-tooltip-item')
  if (items.length !== 1) throw new Error(`the tooltip shows ${items.length} items, not the one slice pointed at`)
  const item = items[0] as Element
  return {
    name: item.querySelector('.recharts-tooltip-item-name')?.textContent ?? null,
    value: item.querySelector('.recharts-tooltip-item-value')?.textContent ?? null,
  }
}

describe('the subscription ring — what its green slice is called', () => {
  it.each([
    ['ru', ru, 'Активные (> 7 дн.)'],
    ['en', en, 'Active (> 7d left)'],
  ] as const)('says it counts the active subscriptions with more than 7 days left, in the legend and in its tooltip (%s)', async (lng, bundle, words) => {
    renderCard(lng, bundle)
    const labels = bundle.dashboardPage.subscriptionChart

    const green = legendRow(bundle, SUBSCRIPTION_STATUS_COLORS.active)
    expect(green).toEqual({ label: words, value: 44 })
    // The same horizon as the slice it was taken from.
    const horizon = /\d+/.exec(labels.expiring)?.[0]
    expect(horizon).toBe('7')
    expect(green.label).toContain(horizon)
    // And not the opening of the card that counts all 52: "Активные" beside
    // "Активные подписки" read as the same thing counted twice.
    const card = bundle.dashboardPage.kpis.activeSubscriptions
    expect(card.toLocaleLowerCase(lng).startsWith(green.label.toLocaleLowerCase(lng))).toBe(false)

    // The other rows keep their words, and the four numbers add up to the heading's total.
    expect(legendRow(bundle, SUBSCRIPTION_STATUS_COLORS.expiring)).toEqual({ label: labels.expiring, value: 8 })
    expect(legendRow(bundle, SUBSCRIPTION_STATUS_COLORS.expired)).toEqual({ label: labels.expired, value: 2 })
    expect(legendRow(bundle, SUBSCRIPTION_STATUS_COLORS.limited)).toEqual({ label: labels.limited, value: 0 })
    expect(screen.getByText(labels.description.replace('{{total}}', '54'))).toBeInTheDocument()

    // The tooltip on the green slice: the legend's words, beside the legend's number.
    hoverSlice(SUBSCRIPTION_STATUS_COLORS.active)
    await waitFor(() => expect(tooltip()).toEqual({ name: words, value: '44' }))
  })

  it.each([
    ['ru', ru],
    ['en', en],
  ] as const)('prints every legend label whole, wrapping a long one instead of cutting it short (%s)', (lng, bundle) => {
    // The legend used to `truncate`. Beside a 12rem ring in half of a 1920 px
    // dashboard a label gets about 84 px, and the green one read "Активные (…"
    // / "Active (> 7…": the words that tell it apart from the "Активные
    // подписки" card were the words cut off. jsdom has no layout, so what is
    // held here is that nothing is allowed to cut the words; the widths were
    // measured in a browser against the compiled Tailwind classes.
    renderCard(lng, bundle)
    const labels = bundle.dashboardPage.subscriptionChart

    const rows = [
      [SUBSCRIPTION_STATUS_COLORS.active, labels.active],
      [SUBSCRIPTION_STATUS_COLORS.limited, labels.limited],
      [SUBSCRIPTION_STATUS_COLORS.expired, labels.expired],
      [SUBSCRIPTION_STATUS_COLORS.expiring, labels.expiring],
    ] as const
    for (const [color, words] of rows) {
      const label = legendRowElement(bundle, color).children[1] as HTMLElement
      expect(label.textContent).toBe(words)
      for (const box of labelAndItsBoxes(label)) {
        expect(box.className, `"${words}" is clipped by <${box.tagName.toLowerCase()} class="${box.className}">`).not.toMatch(CLIPPING)
      }
      // Free to wrap, and to break a word longer than the column rather than
      // push the number out of the card.
      expect(label).toHaveClass('min-w-0', 'break-words')
    }

    // A column too narrow for a legend beside the ring gets it under the ring,
    // where a label has the whole column, instead of a sliver of it: the ring
    // and legend sit in a size container and go side by side from a width on.
    const legend = legendRowElement(bundle, SUBSCRIPTION_STATUS_COLORS.active).closest('ul') as HTMLElement
    const layout = legend.closest('[class*=":flex-row"]') as HTMLElement | null
    expect(layout, 'the ring and its legend must be laid out by the width of their column').not.toBeNull()
    expect(layout).toHaveClass('flex-col')
    expect(layout?.className).toMatch(/(^|\s)@min-\[[\d.]+rem\]:flex-row(\s|$)/)
    expect(layout?.parentElement).toHaveClass('@container')
  })

  it('names every drawn slice in its tooltip, the way its legend row does', async () => {
    renderCard('ru', ru)
    for (const color of [SUBSCRIPTION_STATUS_COLORS.expired, SUBSCRIPTION_STATUS_COLORS.expiring, SUBSCRIPTION_STATUS_COLORS.active]) {
      const row = legendRow(ru, color)
      expect(row.value, 'precondition: a slice with nothing in it is not drawn').toBeGreaterThan(0)
      hoverSlice(color)
      await waitFor(() => expect(tooltip()).toEqual({ name: row.label, value: String(row.value) }))
    }
  })
})
