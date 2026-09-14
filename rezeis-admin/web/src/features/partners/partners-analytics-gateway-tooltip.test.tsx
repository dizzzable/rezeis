/**
 * The partners analytics "by gateway" donut names the gateway its tooltip points at.
 *
 * Its tooltip was handed `formatter={(value) => [formatKopecks(value), '']}`.
 * recharts 3 prints a tooltip item's name and the " : " separator whenever the
 * name is a string or a number, and `''` is a string, so hovering a slice read
 * " : 1 234,56 ₽" with no gateway; only the legend beside it could say which
 * slice that was.
 *
 * Real recharts is rendered, with only its entrance animation turned off (jsdom
 * never advances it) and a size its wrapper would give. Every other card of the
 * tab stays loading: they are not the question.
 */
import { cloneElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { i18n, i18nReady } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    Pie: (props: ComponentProps<typeof actual.Pie>) => <actual.Pie {...props} isAnimationActive={false} />,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, { width: 320, height: 260 })
        : children,
  }
})

vi.mock('./partners-queries', () => {
  const loading = () => ({ data: undefined, isLoading: true })
  return {
    useFunnel: loading,
    useTimeseries: loading,
    useTopPartners: loading,
    useLevelDistribution: loading,
    useWithdrawalThroughput: loading,
    useKpis: loading,
    useCohortRetention: loading,
    useGatewayDistribution: () => ({
      data: {
        byGateway: {
          CRYPTOMUS: { earnings: 5_000, transactions: 1 },
          YOOKASSA: { earnings: 123_456, transactions: 4 },
        },
        totalEarnings: 128_456,
        from: '2026-08-15T00:00:00.000Z',
        to: '2026-09-14T00:00:00.000Z',
      },
      isLoading: false,
    }),
  }
})

import { formatKopecks } from './partner-formatters'
import PartnersAnalyticsTab from './partners-analytics-tab'

beforeAll(async () => {
  await i18nReady
})

describe('partners analytics — the gateway donut’s tooltip says which gateway', () => {
  it.each([
    [0, 'YOOKASSA', 123_456],
    [1, 'CRYPTOMUS', 5_000],
  ] as const)('slice %i: %s, beside its earnings', async (index, gateway, kopecks) => {
    renderWithProviders(<PartnersAnalyticsTab />)
    const title = i18n.t('partnersAnalytics.gatewayDistribution.title')
    let card: HTMLElement | null = await screen.findByText(title)
    while (card !== null && card.querySelector('.recharts-pie-sector') === null) card = card.parentElement
    if (card === null) throw new Error(`no donut is drawn under "${title}"`)
    const sectors = card.querySelectorAll('.recharts-pie-sector')
    expect(sectors, 'precondition: one slice per gateway with earnings').toHaveLength(2)

    fireEvent.mouseEnter(sectors[index] as Element)

    const tooltip = await waitFor(() => {
      const items = (card as HTMLElement).querySelectorAll('.recharts-tooltip-item')
      if (items.length !== 1) throw new Error(`the tooltip shows ${items.length} items, not the one slice pointed at`)
      return items[0] as Element
    })
    expect({
      name: tooltip.querySelector('.recharts-tooltip-item-name')?.textContent ?? null,
      value: tooltip.querySelector('.recharts-tooltip-item-value')?.textContent ?? null,
    }).toEqual({ name: gateway, value: formatKopecks(kopecks) })
  })
})
