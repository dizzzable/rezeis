/**
 * «Ноды и страны» — the online card turned over by its globe button: who is
 * online on which node and in which country, ranked.
 *
 * NOW is the newest sample the panel stored (every five minutes), stamped with
 * when it was taken; the server explains why it is not a live `/api/nodes` call
 * (`summariseOnlineDistribution`). A reading older than three missed samples is
 * called out of date in words rather than passed off as now.
 *
 * SHARES ARE OF CONNECTIONS. Remnawave counts a person on every node they are
 * connected to, so the node counts can add up to more than the card's «Сейчас»
 * and the shares here are of their own sum — the note under the lists says so.
 *
 * A node without a connection stays in the list, last and marked «нет связи»,
 * counting nobody: its last reported number is not people online now. Its PEAK
 * over the window is still shown — it is when the node was up.
 *
 * Flags are the panel's own SVGs (`NodeFlag`), never emoji: Windows draws no
 * flag emoji at all and would show «DE».
 */
import { type JSX, useId } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Globe } from 'lucide-react'
import { motion } from 'motion/react'

import { Skeleton } from '@/components/ui/skeleton'
import { NodeFlag } from '@/features/remnawave/remnawave-flags'
import { usePermissionStore } from '@/features/rbac/use-permission-store'
import { activeLocale, cn } from '@/lib/utils'

import {
  dashboardApi,
  onlineCardKeys,
  type OnlineDistribution,
  type OnlineRange,
} from './dashboard-api'
import {
  countryName,
  describeMoment,
  formatCount,
  formatShare,
  ONLINE_COLOR,
  ONLINE_REFETCH_MS,
} from './dashboard-online-model'
import { useAnswerFreshness } from './dashboard-online-freshness'
import { OnlineNotice, OnlineStaleNotice } from './dashboard-online-notice'

/** A reading older than this is out of date: three five-minute samples have been missed. */
export const ONLINE_READING_STALE_MS = 15 * 60_000

type DistributionNode = OnlineDistribution['nodes'][number]
type DistributionCountry = OnlineDistribution['countries'][number]

export function DashboardOnlineDistribution({
  range,
  animate,
}: {
  readonly range: OnlineRange
  readonly animate: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const canView = usePermissionStore((s) => s.hasPermission('remnawave', 'view'))
  const query = useQuery({
    queryKey: onlineCardKeys.distribution(range),
    queryFn: () => dashboardApi.getOnlineDistribution(range),
    enabled: canView,
    refetchInterval: ONLINE_REFETCH_MS,
    refetchIntervalInBackground: false,
    // Asks again the moment the tab is looked at — see the chart side.
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
  })
  const freshness = useAnswerFreshness(query)
  const nodesId = useId()
  const countriesId = useId()

  const data = query.data
  if (data === undefined) {
    return query.isError ? (
      <OnlineNotice
        tone="error"
        title={t('dashboardPage.onlineTrend.distribution.loadFailed')}
        action={t('dashboardPage.onlineTrend.retry')}
        onAction={() => void query.refetch()}
      />
    ) : (
      <DistributionSkeleton />
    )
  }
  // The answer on screen is not the current one: said over whatever it shows,
  // in the tone of what happened — a failed refresh, or one that has not landed.
  const notCurrent = freshness.stale ? (
    <OnlineStaleNotice
      tone={freshness.failed ? 'failed' : 'waiting'}
      message={t(
        freshness.failed ? 'dashboardPage.onlineTrend.staleAnswer' : 'dashboardPage.onlineTrend.pausedAnswer',
        { when: describeMoment(new Date(freshness.receivedAt).toISOString(), freshness.now, t) },
      )}
      retryLabel={t(
        freshness.failed ? 'dashboardPage.onlineTrend.retry' : 'dashboardPage.onlineTrend.refresh',
      )}
      retrying={query.isFetching}
      onRetry={() => void query.refetch()}
    />
  ) : null
  // Both times from the server's one clock: a browser running fast must not see
  // every reading as out of date.
  const answeredAt = Date.parse(data.generatedAt)

  if (data.sampledAt === null) {
    return (
      <div className="flex flex-col gap-3">
        {notCurrent}
        {data.nodeReadFailedAt !== null ? (
          // Samples were taken, but not one could read the node list: that is
          // an outage to report, not a panel without nodes.
          <OnlineNotice
            tone="error"
            title={t('dashboardPage.onlineTrend.distribution.nodesUnreadable')}
            hint={t('dashboardPage.onlineTrend.distribution.nodesUnreadableHint')}
          />
        ) : (
          <OnlineNotice
            tone="empty"
            title={t(`dashboardPage.onlineTrend.empty.${data.range}`)}
            hint={t('dashboardPage.onlineTrend.empty.hint')}
          />
        )}
      </div>
    )
  }

  const locale = activeLocale()
  const when = describeMoment(data.sampledAt, answeredAt, t)
  const readFailed = data.nodeReadFailedAt !== null
  const stale = Date.parse(data.sampledAt) < answeredAt - ONLINE_READING_STALE_MS
  const nobodyOnline = data.totalUsersOnline === 0 && data.nodes.some((node) => node.isConnected)
  // Why the lists are older than they should be — the node read failing says
  // more than «out of date», so it wins when both are true.
  const readingNotice = readFailed ? (
    <p role="status" className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
      <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
      {t('dashboardPage.onlineTrend.distribution.nodesUnreadableSince', { when })}
    </p>
  ) : stale ? (
    <p role="status" className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
      <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
      {t('dashboardPage.onlineTrend.distribution.stale', { when })}
    </p>
  ) : null

  if (data.nodes.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {notCurrent}
        {readingNotice}
        <OnlineNotice tone="empty" title={t('dashboardPage.onlineTrend.distribution.noNodes')} />
      </div>
    )
  }

  // SIDE BY SIDE WITH THE SUBSCRIPTION CARD (from `xl`) this side takes the
  // height the row already gives the card and scrolls inside it, so turning the
  // card over never stretches the row — or the card beside it. Measured at 1920
  // with eight nodes, letting it grow took the row from 560 to 638 px. Stacked,
  // below `xl`, it simply takes the height its lists need: a scroll box inside
  // a scrolling page is the worse of the two there.
  return (
    <div
      className={cn(
        '@container flex min-h-48 flex-col gap-3 xl:min-h-0 xl:flex-1 xl:basis-0',
        query.isPlaceholderData && 'opacity-60',
      )}
      data-online-distribution={data.range}
    >
      {notCurrent}
      {readingNotice}
      {/* From `xl` this box scrolls, so it takes keyboard focus and a name: a
          list a keyboard cannot scroll to is a list half of it cannot read
          (axe `scrollable-region-focusable`). */}
      <div
        data-online-lists=""
        role="region"
        aria-label={t('dashboardPage.onlineTrend.distribution.listsLabel')}
        tabIndex={0}
        className={cn(
          'grid content-start gap-x-6 gap-y-5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring @min-[26rem]:grid-cols-2 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1',
          freshness.stale && 'opacity-70',
        )}
      >
        <section aria-labelledby={nodesId} data-online-list="nodes">
          <ListHeading id={nodesId}>{t('dashboardPage.onlineTrend.distribution.byNode')}</ListHeading>
          <ol className="flex flex-col gap-2.5">
            {data.nodes.map((node, index) => (
              <NodeRow
                key={node.uuid}
                node={node}
                total={data.totalUsersOnline}
                order={index}
                animate={animate}
                locale={locale}
              />
            ))}
          </ol>
        </section>
        <section aria-labelledby={countriesId} data-online-list="countries">
          <ListHeading id={countriesId}>{t('dashboardPage.onlineTrend.distribution.byCountry')}</ListHeading>
          <ol className="flex flex-col gap-2.5">
            {data.countries.map((country, index) => (
              <CountryRow
                key={country.countryCode || '__none__'}
                country={country}
                total={data.totalUsersOnline}
                order={index}
                animate={animate}
                locale={locale}
              />
            ))}
          </ol>
        </section>
      </div>
      <div className="flex flex-col gap-1 text-[11px] leading-4 text-muted-foreground">
        {nobodyOnline ? <p>{t('dashboardPage.onlineTrend.distribution.nobodyOnline')}</p> : null}
        <p>
          {readingNotice !== null ? null : `${t('dashboardPage.onlineTrend.distribution.sampledAt', { when })} · `}
          {t('dashboardPage.onlineTrend.distribution.connections')}
        </p>
      </div>
    </div>
  )
}

function ListHeading({ id, children }: { readonly id: string; readonly children: string }): JSX.Element {
  return (
    <h3 id={id} className="mb-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  )
}

function NodeRow({
  node,
  total,
  order,
  animate,
  locale,
}: {
  readonly node: DistributionNode
  readonly total: number
  readonly order: number
  readonly animate: boolean
  readonly locale: string
}): JSX.Element {
  const { t } = useTranslation()
  const share = node.isConnected && total > 0 ? node.usersOnline / total : 0
  const place = countryName(node.countryCode, locale)
  const peak = t('dashboardPage.onlineTrend.distribution.nodePeak', { value: formatCount(node.peak, locale) })
  return (
    <li
      data-node-row={node.uuid}
      data-connected={node.isConnected ? 'true' : 'false'}
      className={cn(ROW, !node.isConnected && 'text-muted-foreground')}
    >
      <CountryMark code={node.countryCode} title={place} />
      <span className="truncate text-sm">{node.name || t('dashboardPage.onlineTrend.distribution.unnamedNode')}</span>
      {node.isConnected ? <Count value={node.usersOnline} locale={locale} /> : <OfflineBadge />}
      <ShareBar share={share} order={order} animate={animate} className="col-start-2" />
      <span className={DETAIL}>{node.isConnected ? `${formatShare(share, locale)} · ${peak}` : peak}</span>
    </li>
  )
}

function CountryRow({
  country,
  total,
  order,
  animate,
  locale,
}: {
  readonly country: DistributionCountry
  readonly total: number
  readonly order: number
  readonly animate: boolean
  readonly locale: string
}): JSX.Element {
  const { t } = useTranslation()
  const share = total > 0 ? country.usersOnline / total : 0
  const name = countryName(country.countryCode, locale)
  const allDown = country.nodesConnected === 0
  const someDown = !allDown && country.nodesConnected < country.nodes
  return (
    <li data-country-row={country.countryCode} className={cn(ROW, allDown && 'text-muted-foreground')}>
      <CountryMark code={country.countryCode} title={name} />
      <span className="truncate text-sm">{name ?? t('dashboardPage.onlineTrend.distribution.unknownCountry')}</span>
      {allDown ? <OfflineBadge /> : <Count value={country.usersOnline} locale={locale} />}
      <ShareBar share={share} order={order} animate={animate} className="col-start-2" />
      <span className={DETAIL}>{allDown ? null : formatShare(share, locale)}</span>
      {someDown ? (
        <span className="col-span-2 col-start-2 text-[11px] leading-4 text-amber-600 dark:text-amber-400">
          {t('dashboardPage.onlineTrend.distribution.nodesConnected', {
            connected: country.nodesConnected,
            count: country.nodes,
          })}
        </span>
      ) : null}
    </li>
  )
}

/**
 * One ranked row, two lines: the flag, the name and the count; under the name
 * the share as a bar, and beside it the share in figures (and a node's peak).
 * Narrow enough that the two lists sit side by side from 26rem of card.
 */
const ROW = 'grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1'
const DETAIL = 'whitespace-nowrap text-right text-[11px] leading-4 tabular-nums text-muted-foreground'

function Count({ value, locale }: { readonly value: number; readonly locale: string }): JSX.Element {
  return <span className="justify-self-end text-sm font-medium tabular-nums">{formatCount(value, locale)}</span>
}

function OfflineBadge(): JSX.Element {
  const { t } = useTranslation()
  return (
    <span className="justify-self-end rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 text-[11px] font-medium leading-4 text-amber-700 dark:text-amber-300">
      {t('dashboardPage.onlineTrend.distribution.offline')}
    </span>
  )
}

/** The flag, or a globe for a node with no country. Decorative: the name beside it says the same. */
function CountryMark({ code, title }: { readonly code: string; readonly title: string | null }): JSX.Element {
  if (code === '') {
    return (
      <span
        aria-hidden="true"
        className="inline-flex h-4 w-6 items-center justify-center rounded-sm bg-muted/40 ring-1 ring-border/40"
      >
        <Globe className="size-3 text-muted-foreground" />
      </span>
    )
  }
  return (
    <span aria-hidden="true" className="inline-flex" data-country-flag={code}>
      <NodeFlag code={code} title={title ?? code} />
    </span>
  )
}

/**
 * The share as a bar: it grows in from nothing, each a beat after the one above,
 * when motion is allowed; otherwise it is simply drawn at its width.
 */
function ShareBar({
  share,
  order,
  animate,
  className,
}: {
  readonly share: number
  readonly order: number
  readonly animate: boolean
  readonly className?: string
}): JSX.Element {
  const width = `${Math.round(Math.min(1, Math.max(0, share)) * 1000) / 10}%`
  return (
    <div aria-hidden="true" className={cn('h-1.5 overflow-hidden rounded-full bg-muted', className)}>
      {animate ? (
        <motion.div
          data-share-bar={width}
          className="h-full rounded-full"
          style={{ backgroundColor: ONLINE_COLOR }}
          initial={{ width: '0%' }}
          animate={{ width }}
          transition={{ duration: 0.7, delay: Math.min(order, 12) * 0.05, ease: [0.16, 1, 0.3, 1] }}
        />
      ) : (
        <div data-share-bar={width} className="h-full rounded-full" style={{ backgroundColor: ONLINE_COLOR, width }} />
      )}
    </div>
  )
}

function DistributionSkeleton(): JSX.Element {
  return (
    <div className="@container min-h-48" aria-busy="true">
      <div className="grid gap-x-6 gap-y-5 @min-[26rem]:grid-cols-2">
        {[0, 1].map((column) => (
          <div key={column} className="flex flex-col gap-3">
            <Skeleton className="h-3 w-20" />
            {[0, 1, 2, 3].map((row) => (
              <Skeleton key={row} className="h-8 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
