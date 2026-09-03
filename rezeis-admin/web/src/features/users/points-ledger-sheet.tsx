import { useInfiniteQuery } from '@tanstack/react-query'
import { Loader2, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

import { usersApi, type PointsLedgerEntry } from './users-api'

const PAGE_SIZE = 25

/**
 * The points journal of one account, newest first: every movement, the
 * balance it left behind, and what it was for. The same rows the subscriber
 * will see in the cabinet; only the labels are the operator's.
 *
 * Keyset paging through `useInfiniteQuery`: the backend hands back
 * `nextCursor`, the sheet passes it back for the next page, and the list
 * never repeats or skips a row while cashback lands on top of it.
 */
export function PointsLedgerSheet({
  telegramId,
  balance,
  open,
  onOpenChange,
}: {
  readonly telegramId: string
  readonly balance: number
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language?.startsWith('ru') ? 'ru-RU' : 'en-US'
  const query = useInfiniteQuery({
    queryKey: ['admin', 'users', telegramId, 'points-ledger'],
    queryFn: ({ pageParam }) =>
      usersApi.listPointsLedger({ userId: telegramId, cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: open,
  })
  const rows = query.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-md md:max-w-xl">
        <SheetHeader className="border-b px-6 py-4 text-left">
          <SheetTitle>{t('userDetailPanel.pointsLedger.title')}</SheetTitle>
          <SheetDescription>
            {t('userDetailPanel.pointsLedger.balance', { count: balance })}
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {query.isLoading ? (
            <Skeleton className="h-40 w-full" data-testid="points-ledger-loading" />
          ) : query.isError ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-muted-foreground">{t('userDetailPanel.pointsLedger.loadError')}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                {t('userDetailPanel.pointsLedger.retry')}
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('userDetailPanel.pointsLedger.empty')}</p>
          ) : (
            <ul className="divide-y" aria-label={t('userDetailPanel.pointsLedger.title')}>
              {rows.map((row) => (
                <LedgerRow key={row.id} row={row} locale={locale} t={t} />
              ))}
            </ul>
          )}
        </div>
        {query.hasNextPage && (
          <div className="border-t px-6 py-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t('userDetailPanel.pointsLedger.loadMore')}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function LedgerRow({ row, locale, t }: { readonly row: PointsLedgerEntry; readonly locale: string; readonly t: TFunction }) {
  const positive = row.delta > 0
  const zero = row.delta === 0
  return (
    <li className="flex items-start justify-between gap-3 py-2.5">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {t(`userDetailPanel.pointsLedger.sources.${row.source}`, { defaultValue: row.source })}
          </Badge>
          <span className="text-[11px] text-muted-foreground">
            {new Date(row.createdAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}
          </span>
        </div>
        <p className="text-xs text-muted-foreground break-words">{describeEntry(row, t, locale)}</p>
      </div>
      <div className="shrink-0 text-right">
        <p
          className={cn(
            'font-mono text-sm font-semibold tabular-nums',
            positive && 'text-emerald-600 dark:text-emerald-400',
            !positive && !zero && 'text-red-600 dark:text-red-400',
          )}
        >
          {positive ? '+' : ''}
          {row.delta}
        </p>
        <p className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {t('userDetailPanel.pointsLedger.balanceAfter', { count: row.balanceAfter })}
        </p>
      </div>
    </li>
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function localized(value: unknown, locale: string): string | null {
  if (typeof value === 'string') return value
  const record = asRecord(value)
  if (record === null) return null
  const preferred = locale.startsWith('ru') ? record['ru'] : record['en']
  const fallback = record['en'] ?? record['ru']
  return typeof preferred === 'string' ? preferred : typeof fallback === 'string' ? fallback : null
}

/**
 * What the row was for, in one line. Every branch reads only the keys its
 * writer records (`points-wallet.service.ts` and the callers name them) and
 * falls back to the source label when a key is missing, so an older row or a
 * shape from a newer panel never breaks the list.
 */
function describeEntry(row: PointsLedgerEntry, t: TFunction, locale: string): string {
  const details = asRecord(row.details) ?? {}
  const shortfall = typeof details['shortfall'] === 'number' && details['shortfall'] > 0
    ? ` · ${t('userDetailPanel.pointsLedger.details.shortfall', { count: details['shortfall'] as number })}`
    : ''
  switch (row.source) {
    case 'CASHBACK': {
      const lines = Array.isArray(details['lines']) ? details['lines'] : []
      const what = lines
        .map((line) => asRecord(line))
        .filter((line): line is Record<string, unknown> => line !== null && typeof line['points'] === 'number' && (line['points'] as number) > 0)
        .map((line) => {
          const name = typeof line['name'] === 'string' ? line['name'] : String(line['id'] ?? '')
          const days = typeof line['durationDays'] === 'number' ? ` · ${t('userDetailPanel.pointsLedger.details.days', { count: line['durationDays'] as number })}` : ''
          return `${name}${days}`
        })
        .join(', ')
      const amount = typeof details['paidAmount'] === 'string' ? `${details['paidAmount']} ${String(details['paidCurrency'] ?? '')}`.trim() : null
      return amount === null
        ? what
        : t('userDetailPanel.pointsLedger.details.cashback', { what, amount })
    }
    case 'CASHBACK_REVERSED':
      return (
        t('userDetailPanel.pointsLedger.details.reversal', {
          applied: typeof details['applied'] === 'number' ? details['applied'] : Math.abs(row.delta),
          requested: typeof details['requested'] === 'number' ? details['requested'] : (details['credited'] ?? Math.abs(row.delta)),
        }) + shortfall
      )
    case 'REFERRAL_REWARD':
      return t('userDetailPanel.pointsLedger.details.referral')
    case 'REFERRAL_REWARD_REVOKED':
      return t('userDetailPanel.pointsLedger.details.referralRevoked') + shortfall
    case 'QUEST_REWARD': {
      const title = localized(details['questTitle'], locale)
      return title === null
        ? t('userDetailPanel.pointsLedger.sources.QUEST_REWARD')
        : t('userDetailPanel.pointsLedger.details.quest', { title })
    }
    case 'WHEEL_PRIZE':
      return t('userDetailPanel.pointsLedger.details.wheel')
    case 'CONTEST_PRIZE': {
      const title = localized(details['contestTitle'], locale)
      return title === null
        ? t('userDetailPanel.pointsLedger.sources.CONTEST_PRIZE')
        : t('userDetailPanel.pointsLedger.details.contest', { title })
    }
    case 'EXCHANGE': {
      const type = typeof details['exchangeType'] === 'string' ? details['exchangeType'] : null
      return type === null
        ? t('userDetailPanel.pointsLedger.sources.EXCHANGE')
        : t('userDetailPanel.pointsLedger.details.exchange', {
            type: t(`userDetailPanel.pointsLedger.exchange.${type}`, { defaultValue: type }),
          })
    }
    case 'MANUAL_ADJUSTMENT': {
      const reason = typeof details['reason'] === 'string' ? details['reason'] : 'OTHER'
      const note = typeof details['note'] === 'string' && details['note'].length > 0 ? details['note'] : null
      const label = t(`userDetailPanel.pointsLedger.reasons.${reason}`, { defaultValue: reason })
      return note === null ? label : `${label} · ${t('userDetailPanel.pointsLedger.details.manualNote', { note })}`
    }
    case 'ACCOUNT_MERGE':
      return typeof details['mergedFrom'] === 'string'
        ? t('userDetailPanel.pointsLedger.details.mergeIn', { id: details['mergedFrom'] })
        : t('userDetailPanel.pointsLedger.details.mergeOut', { id: String(details['mergedInto'] ?? '') })
    case 'IMPORT':
      return t('userDetailPanel.pointsLedger.details.import', { importer: String(details['importer'] ?? '') })
    case 'OPENING_BALANCE':
      return t('userDetailPanel.pointsLedger.details.opening')
    default:
      return ''
  }
}
