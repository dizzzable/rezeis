/**
 * «Лидеры»: the customers who paid the most over their lifetime, each with an
 * inline bar against the first — so the gap between the top and the rest is
 * seen, not computed. A name opens the customer's page — for a viewer who may
 * open it: a link into a 403 is a door painted on a wall.
 *
 * Lifetime money in several currencies is ranked by its value in the base
 * currency; each row still shows what was paid in which currency.
 */
import { type JSX, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Trophy } from 'lucide-react'
import { motion } from 'motion/react'
import type { TFunction } from 'i18next'

import { usePermissionStore } from '@/features/rbac/use-permission-store'
import { formatDate } from '@/lib/utils'

import { getTopPayers, type TopPayer, type TopPayersReport } from './analytics-api'
import {
  ChartCard,
  EmptyState,
  MoneyNote,
  QueryBody,
} from './analytics-chart-kit'
import { SWEEP_MS, useChartEntrance } from './analytics-chart-support'
import { formatAmounts, formatCount, formatMoney } from './analytics-format'
import { ACCENT } from './analytics-palette'

const TOP_LIMIT = 20

export function LeadersTab({ played }: { readonly played: Set<string> }): JSX.Element {
  const { t } = useTranslation()
  const top = useQuery({ queryKey: ['analytics', 'top-payers', TOP_LIMIT], queryFn: () => getTopPayers(TOP_LIMIT), staleTime: 60_000 })
  return (
    <div className="@container" data-analytics-tab="leaderboard">
      <ChartCard
        id="leaders-top-payers"
        title={t('analyticsPage.topPayers.title')}
        icon={<Trophy className="size-4 text-muted-foreground" aria-hidden="true" />}
        info={t('analyticsPage.topPayers.info')}
        rule="money"
        description={t('analyticsPage.topPayers.description', { count: TOP_LIMIT })}
        contentClassName="px-0 pb-2"
      >
        <QueryBody query={top} height="h-64">
          {(report) =>
            report.payers.length === 0 ? (
              <EmptyState className="h-48">{t('analyticsPage.topPayers.empty')}</EmptyState>
            ) : (
              <TopPayersTable report={report} played={played} />
            )
          }
        </QueryBody>
      </ChartCard>
    </div>
  )
}

function payerName(t: TFunction, payer: TopPayer): string {
  if (payer.name.trim() !== '') return payer.name
  if (payer.username !== null && payer.username !== '') return `@${payer.username}`
  return t('analyticsPage.topPayers.unknownUser')
}

function TopPayersTable({ report, played }: { readonly report: TopPayersReport; readonly played: Set<string> }): JSX.Element {
  const { t } = useTranslation()
  const chartRef = useRef<HTMLDivElement>(null)
  const entrance = useChartEntrance('leaders.topPayers', played, chartRef)
  const { money } = report
  const top = Math.max(0, ...report.payers.map((payer) => payer.totalSpent ?? 0))
  const animate = entrance.animate && entrance.show
  const canOpenCustomers = usePermissionStore((state) => state.hasPermission('users', 'view'))
  return (
    <div ref={chartRef} className="space-y-3">
      {(money.converted || money.unconverted.length > 0) && (
        <div className="px-6">
          <MoneyNote money={money} />
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-top-payers="">
          <caption className="sr-only">{t('analyticsPage.topPayers.title')}</caption>
          <thead className="border-b text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="w-10 px-3 py-2 text-left font-medium">#</th>
              <th scope="col" className="px-3 py-2 text-left font-medium">{t('analyticsPage.topPayers.userColumn')}</th>
              <th scope="col" className="w-[40%] px-3 py-2 text-left font-medium">{t('analyticsPage.topPayers.spentColumn')}</th>
              <th scope="col" className="hidden px-3 py-2 text-right font-medium @min-[36rem]:table-cell">{t('analyticsPage.topPayers.txCountColumn')}</th>
              <th scope="col" className="hidden px-3 py-2 text-right font-medium @min-[48rem]:table-cell">{t('analyticsPage.topPayers.lastPaymentColumn')}</th>
            </tr>
          </thead>
          <tbody>
            {report.payers.map((payer, index) => {
              // No rate for any of the customer's money: no bar, and no «0 ₽» either.
              const width = payer.totalSpent === null || top <= 0 ? 0 : Math.max(0.5, (payer.totalSpent / top) * 100)
              const converted = money.converted && payer.spentByCurrency.some((slice) => slice.currency !== money.currency)
              return (
                <tr key={payer.userId} className="border-b last:border-0" data-top-payer={payer.userId}>
                  <td className="px-3 py-2 align-top font-mono text-xs text-muted-foreground">{index + 1}</td>
                  <td className="max-w-48 px-3 py-2 align-top">
                    {payer.telegramId !== null && canOpenCustomers ? (
                      <Link to={`/users/${payer.telegramId}`} className="font-medium underline-offset-2 hover:underline focus-visible:underline">
                        {payerName(t, payer)}
                      </Link>
                    ) : (
                      <span className="font-medium">{payerName(t, payer)}</span>
                    )}
                    {payer.username !== null && payer.username !== '' && payer.name.trim() !== '' && (
                      <span className="block truncate text-xs text-muted-foreground">@{payer.username}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="flex items-baseline justify-between gap-2">
                      {payer.totalSpent === null ? (
                        <span className="tabular-nums" data-top-payer-unconverted="">
                          <span className="font-medium">{formatAmounts(payer.spentByCurrency)}</span>{' '}
                          <span className="text-xs text-muted-foreground">{t('analyticsPage.topPayers.noRate')}</span>
                        </span>
                      ) : (
                        <span className="font-medium tabular-nums">
                          {converted ? '≈\xa0' : ''}
                          {formatMoney(payer.totalSpent, money.currency)}
                        </span>
                      )}
                      {payer.totalSpent !== null && payer.spentByCurrency.length > 1 && (
                        <span className="truncate text-xs text-muted-foreground">
                          {payer.spentByCurrency.map((slice) => formatMoney(slice.amount, slice.currency, { compact: true })).join(' + ')}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 h-1.5" aria-hidden="true">
                      {animate ? (
                        <motion.div
                          className="h-full rounded-r-[4px]"
                          style={{ backgroundColor: ACCENT }}
                          initial={{ width: 0 }}
                          animate={{ width: `${width}%` }}
                          transition={{ duration: SWEEP_MS / 1000, delay: index * 0.03, ease: [0.16, 1, 0.3, 1] }}
                        />
                      ) : (
                        <div className="h-full rounded-r-[4px]" style={{ width: `${width}%`, backgroundColor: ACCENT }} />
                      )}
                    </div>
                  </td>
                  <td className="hidden px-3 py-2 text-right align-top tabular-nums @min-[36rem]:table-cell">{formatCount(payer.transactionCount)}</td>
                  <td className="hidden px-3 py-2 text-right align-top text-xs text-muted-foreground @min-[48rem]:table-cell">{formatDate(payer.lastPaymentAt)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
