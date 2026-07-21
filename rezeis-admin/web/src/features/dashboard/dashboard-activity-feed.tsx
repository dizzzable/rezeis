import { type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  Rss,
  User,
  Server,
  Activity,
  CreditCard,
  Bell,
  ShieldAlert,
  Smartphone,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

import { dashboardApi, type ActivityFeedItem } from './dashboard-api'

type Scope =
  | 'user'
  | 'node'
  | 'service'
  | 'crm'
  | 'subscription'
  | 'errors'
  | 'hwid'
  | 'torrent'
  | 'other'

type Severity = 'positive' | 'negative' | 'neutral'

interface ScopeMeta {
  readonly icon: LucideIcon
  /** Tailwind classes for the round icon chip (bg + text). */
  readonly chip: string
}

const SCOPE_META: Record<Scope, ScopeMeta> = {
  user: { icon: User, chip: 'bg-blue-500/15 text-blue-400' },
  node: { icon: Server, chip: 'bg-emerald-500/15 text-emerald-400' },
  service: { icon: Activity, chip: 'bg-violet-500/15 text-violet-400' },
  crm: { icon: CreditCard, chip: 'bg-amber-500/15 text-amber-400' },
  subscription: { icon: Bell, chip: 'bg-cyan-500/15 text-cyan-400' },
  errors: { icon: ShieldAlert, chip: 'bg-red-500/15 text-red-400' },
  hwid: { icon: Smartphone, chip: 'bg-slate-500/15 text-slate-300' },
  torrent: { icon: ShieldAlert, chip: 'bg-orange-500/15 text-orange-400' },
  other: { icon: Rss, chip: 'bg-muted text-muted-foreground' },
}

const NEGATIVE_EVENTS = new Set<string>([
  'node.connection_lost',
  'node.disabled',
  'node.deleted',
  'user.deleted',
  'user.disabled',
  'user.limited',
  'user.expired',
  'user.revoked',
  'service.login_attempt_failed',
])

const POSITIVE_EVENTS = new Set<string>([
  'node.connection_restored',
  'node.enabled',
  'node.created',
  'user.created',
  'user.enabled',
  'user.first_connected',
  'user.first_traffic',
  'user.traffic_reset',
  'service.login_attempt_success',
  'service.panel_started',
])

export function DashboardActivityFeed(): JSX.Element {
  const { t, i18n } = useTranslation()

  const { data: events, isLoading } = useQuery({
    queryKey: ['admin', 'remnawave', 'activity-feed'],
    queryFn: () => dashboardApi.getActivityFeed(20),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })

  const header = (
    <CardHeader>
      <CardTitle className="flex items-center gap-2">
        <Rss className="h-4 w-4" />
        {t('dashboardPage.activityFeed.title')}
        {events && events.length > 0 ? (
          <Badge variant="secondary" className="ml-auto text-[10px]">
            {events.length}
          </Badge>
        ) : null}
      </CardTitle>
      <CardDescription>{t('dashboardPage.activityFeed.description')}</CardDescription>
    </CardHeader>
  )

  if (isLoading) {
    return (
      <Card>
        {header}
        <CardContent className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      {header}
      <CardContent>
        {!events || events.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Rss className="h-5 w-5" />
            </span>
            <p className="max-w-xs text-sm text-muted-foreground">
              {t('dashboardPage.activityFeed.empty')}
            </p>
          </div>
        ) : (
          <ul className="-mr-2 max-h-80 space-y-1.5 overflow-y-auto pr-2">
            {events.map((event: ActivityFeedItem) => (
              <ActivityRow key={event.id} event={event} t={t} locale={i18n.language} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

interface ActivityRowProps {
  readonly event: ActivityFeedItem
  readonly t: ReturnType<typeof useTranslation>['t']
  readonly locale: string
}

function ActivityRow({ event, t, locale }: ActivityRowProps): JSX.Element {
  const scope = scopeOf(event.eventType)
  const meta = SCOPE_META[scope]
  const Icon = meta.icon
  const severity = severityOf(event.eventType)
  const title = eventTitle(t, event.eventType, scope)
  const detail = eventDetail(event.payload)
  const absolute = new Date(event.createdAt).toLocaleString(locale)

  return (
    <li
      className={cn(
        'group flex items-center gap-3 rounded-lg border border-l-2 bg-card/40 px-3 py-2 transition-colors hover:bg-accent/40',
        severity === 'negative' && 'border-l-red-500/60',
        severity === 'positive' && 'border-l-emerald-500/60',
        severity === 'neutral' && 'border-l-border',
      )}
    >
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          meta.chip,
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        {detail ? (
          <span className="block truncate text-xs text-muted-foreground">{detail}</span>
        ) : (
          <span className="block truncate font-mono text-[10px] text-muted-foreground/70">
            {event.eventType}
          </span>
        )}
      </div>
      <time
        className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
        title={absolute}
        dateTime={event.createdAt}
      >
        {relativeTime(t, event.createdAt)}
      </time>
    </li>
  )
}

function scopeOf(eventType: string): Scope {
  const head = eventType.split('.')[0]
  switch (head) {
    case 'user':
      return 'user'
    case 'user_hwid_devices':
      return 'hwid'
    case 'node':
      return 'node'
    case 'service':
      return 'service'
    case 'crm':
      return 'crm'
    case 'subscription':
      return 'subscription'
    case 'errors':
      return 'errors'
    case 'torrent_blocker':
      return 'torrent'
    default:
      return 'other'
  }
}

function severityOf(eventType: string): Severity {
  if (eventType.startsWith('errors.') || eventType.includes('overdue')) return 'negative'
  if (NEGATIVE_EVENTS.has(eventType)) return 'negative'
  if (POSITIVE_EVENTS.has(eventType)) return 'positive'
  return 'neutral'
}

/** Localised, human-readable event title with a graceful fallback. */
function eventTitle(
  t: ReturnType<typeof useTranslation>['t'],
  eventType: string,
  scope: Scope,
): string {
  const flatKey = eventType.replace(/\./g, '_')
  const fullKey = `dashboardPage.activityFeed.events.${flatKey}`
  const translated = t(fullKey)
  if (translated !== fullKey) return translated
  // Unknown event → "<Scope>: humanised action".
  const scopeLabel = t(`dashboardPage.activityFeed.scope.${scope}`)
  const action = eventType.split('.').slice(1).join(' ').replace(/_/g, ' ').trim()
  return action ? `${scopeLabel}: ${action}` : scopeLabel
}

/** Best-effort human detail from the webhook payload (`payload.data` first). */
function eventDetail(payload: Record<string, unknown>): string | null {
  const data =
    payload && typeof payload['data'] === 'object' && payload['data'] !== null
      ? (payload['data'] as Record<string, unknown>)
      : payload

  const pick = (key: string): string | null => {
    const value = data[key]
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
  }

  const named = pick('username') ?? pick('email') ?? pick('name') ?? pick('nodeName') ?? pick('tag')
  if (named) return named

  const uuid = pick('uuid')
  return uuid ? `${uuid.slice(0, 8)}…` : null
}

function relativeTime(t: ReturnType<typeof useTranslation>['t'], iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return t('dashboardPage.activityFeed.justNow')
  if (minutes < 60) return t('dashboardPage.activityFeed.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('dashboardPage.activityFeed.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  return t('dashboardPage.activityFeed.daysAgo', { count: days })
}
