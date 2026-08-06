/**
 * Users tab — fast user lookup, HWID dashboard and recent subscription
 * activity. Built around four cards in a 2-column grid:
 *
 *   ┌─────────────────────┬─────────────────────┐
 *   │ User search         │ HWID stats (small)  │
 *   ├─────────────────────┼─────────────────────┤
 *   │ HWID top abusers    │ Subscription log    │
 *   └─────────────────────┴─────────────────────┘
 *
 * The search column reaches across the whole row when a user is selected,
 * because the resolved profile card needs the wider column for tabular
 * fields (UUID, traffic, expiry, …).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  AtSign,
  CalendarClock,
  Hash,
  KeyRound,
  Loader2,
  RadioTower,
  RotateCcw,
  Search,
  Smartphone,
  TriangleAlert,
  Wifi,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { remnawaveApi, type RemnawaveUserSummary } from '../remnawave-api'
import { KEYS } from '../remnawave-query-keys'
import { formatBytes } from '../remnawave-utils'
import { EndpointDegraded } from '../shared/endpoint-degraded'
import { StatTile } from '../shared/stat-tile'
import { TabHeader } from '../shared/tab-header'

export function UsersTab() {
  const { t } = useTranslation()

  return (
    <div className="space-y-4">
      <TabHeader
        title={t('remnaWavePage.tabs.users')}
        subtitle={t('remnaWavePage.users.subtitle')}
      />

      <UserSearchCard />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <HwidSummaryCards />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <HwidTopUsersCard />
        <SubscriptionRequestLogCard />
      </div>
    </div>
  )
}

// ── User search ──────────────────────────────────────────────────────────────

function UserSearchCard() {
  const { t } = useTranslation()
  const [telegramId, setTelegramId] = useState('')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [subscriptionUuid, setSubscriptionUuid] = useState('')

  const resolveMutation = useMutation({
    mutationFn: remnawaveApi.resolveUser,
  })

  function handleSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    resolveMutation.mutate({
      telegramId: telegramId.trim() || undefined,
      username: username.trim() || undefined,
      email: email.trim() || undefined,
      subscriptionUuid: subscriptionUuid.trim() || undefined,
    })
  }

  function handleReset(): void {
    setTelegramId('')
    setUsername('')
    setEmail('')
    setSubscriptionUuid('')
    resolveMutation.reset()
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Search className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('remnaWavePage.users.search.title')}
        </CardTitle>
        <CardDescription className="text-xs">
          {t('remnaWavePage.users.search.description')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SearchField icon={Hash} id="rmw-search-tg" label={t('remnaWavePage.users.search.telegramId')} value={telegramId} onChange={setTelegramId} placeholder="123456789" />
          <SearchField icon={AtSign} id="rmw-search-username" label={t('remnaWavePage.users.search.username')} value={username} onChange={setUsername} placeholder="durov" />
          <SearchField icon={AtSign} id="rmw-search-email" label={t('remnaWavePage.users.search.email')} value={email} onChange={setEmail} placeholder="user@example.com" />
          <SearchField icon={KeyRound} id="rmw-search-suuid" label={t('remnaWavePage.users.search.subscriptionUuid')} value={subscriptionUuid} onChange={setSubscriptionUuid} placeholder="abc12345" />
          <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-4">
            <Button type="submit" size="sm" disabled={resolveMutation.isPending}>
              {resolveMutation.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Search className="mr-2 h-3.5 w-3.5" />}
              {t('remnaWavePage.users.search.submit')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={handleReset}>
              <RotateCcw className="mr-2 h-3.5 w-3.5" />
              {t('remnaWavePage.users.search.reset')}
            </Button>
          </div>
        </form>

        {resolveMutation.isSuccess && resolveMutation.data ? (
          <UserSummaryPanel user={resolveMutation.data} />
        ) : null}

        {resolveMutation.isSuccess && !resolveMutation.data ? (
          <p className="mt-4 rounded-md border border-dashed border-border/60 px-3 py-2 text-sm text-muted-foreground">
            {t('remnaWavePage.users.search.notFound')}
          </p>
        ) : null}

        {resolveMutation.isError ? (
          <p className="mt-4 rounded-md border border-dashed border-destructive/40 px-3 py-2 text-sm text-destructive">
            {t('remnaWavePage.users.search.error')}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

interface SearchFieldProps {
  readonly icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
  readonly id: string
  readonly label: string
  readonly value: string
  readonly onChange: (next: string) => void
  readonly placeholder: string
}

function SearchField({ icon: Icon, id, label, value, onChange, placeholder }: SearchFieldProps) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <div className="relative">
        <Icon className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" aria-hidden />
        <Input id={id} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="pl-7" />
      </div>
    </div>
  )
}

function UserSummaryPanel({ user }: { user: RemnawaveUserSummary }) {
  const { t } = useTranslation()
  const usedBytes = user.trafficUsedBytes ?? 0
  const limitBytes = user.trafficLimitBytes ?? 0

  return (
    <div className="mt-4 grid gap-3 rounded-lg border border-border/60 bg-card/40 p-4 sm:grid-cols-3">
      <SummaryRow label={t('remnaWavePage.users.summary.username')} value={user.username} />
      <SummaryRow label={t('remnaWavePage.users.summary.status')} value={user.status ?? '—'} />
      <SummaryRow label={t('remnaWavePage.users.summary.telegramId')} value={user.telegramId ?? '—'} />
      <SummaryRow label={t('remnaWavePage.users.summary.email')} value={user.email ?? '—'} />
      <SummaryRow
        label={t('remnaWavePage.users.summary.traffic')}
        value={limitBytes > 0 ? `${formatBytes(usedBytes)} / ${formatBytes(limitBytes)}` : formatBytes(usedBytes)}
      />
      <SummaryRow
        label={t('remnaWavePage.users.summary.expiresAt')}
        value={user.expireAt ? new Date(user.expireAt).toLocaleString() : '—'}
      />
      <SummaryRow label={t('remnaWavePage.users.summary.hwidLimit')} value={String(user.hwidDeviceLimit ?? '—')} />
      <SummaryRow label={t('remnaWavePage.users.summary.tag')} value={user.tag ?? '—'} />
      <SummaryRow
        label={t('remnaWavePage.users.summary.uuid')}
        value={
          <span className="font-mono text-[11px]">{user.uuid}</span>
        }
      />
      <div className="sm:col-span-3">
        <UserLiveSessions uuid={user.uuid} />
      </div>
    </div>
  )
}

/**
 * On-demand "where is this user connecting from right now" drilldown. Uses the
 * panel ip-control endpoint (matured on 2.8+), so it's gated behind the
 * detected capability and only fetches when the operator clicks — the call
 * runs an async panel job we poll, so we never fire it automatically.
 */
function UserLiveSessions({ uuid }: { uuid: string }) {
  const { t } = useTranslation()
  const [load, setLoad] = useState(false)
  const { data: caps } = useQuery({ queryKey: KEYS.version, queryFn: remnawaveApi.getCapabilities, staleTime: 5 * 60_000 })

  const { data: sessions, isFetching, refetch } = useQuery({
    queryKey: ['remnawave', 'live-user', uuid],
    queryFn: () => remnawaveApi.getUserLiveSessions(uuid),
    enabled: load && caps?.liveIpControl === true,
    staleTime: 10_000,
  })

  if (caps?.liveIpControl !== true) return null

  const totalIps = (sessions ?? []).reduce((acc, n) => acc + n.ips.length, 0)

  return (
    <div className="mt-1 border-t border-border/60 pt-3">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <RadioTower className="h-3.5 w-3.5" aria-hidden />
          {t('remnaWavePage.users.live.title')}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isFetching}
          onClick={() => {
            if (!load) setLoad(true)
            else void refetch()
          }}
        >
          {isFetching ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Wifi className="mr-2 h-3.5 w-3.5" aria-hidden />
          )}
          {t('remnaWavePage.users.live.load')}
        </Button>
      </div>
      {load && !isFetching && (sessions?.length ?? 0) === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">{t('remnaWavePage.users.live.empty')}</p>
      ) : null}
      {sessions && sessions.length > 0 ? (
        <div className="mt-2 space-y-2">
          <p className="text-[11px] text-muted-foreground">
            {t('remnaWavePage.users.live.summary', { nodes: sessions.length, ips: totalIps })}
          </p>
          {sessions.map((n) => (
            <div key={n.nodeUuid} className="rounded-md border border-border/50 p-2">
              <p className="text-xs font-medium">{n.nodeName || n.nodeUuid.slice(0, 8)}</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {n.ips.map((sample) => (
                  <Badge key={sample.ip} variant="secondary" className="font-mono text-[10px]">
                    {sample.ip}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-medium tabular-nums">{value}</p>
    </div>
  )
}

// ── HWID summary tiles ───────────────────────────────────────────────────────

function HwidSummaryCards() {
  const { t } = useTranslation()
  const { data: stats, isLoading } = useQuery({
    queryKey: KEYS.hwidStats,
    queryFn: remnawaveApi.getHwidStats,
  })

  if (isLoading) {
    return (
      <Card className="md:col-span-2 xl:col-span-4">
        <CardContent className="flex h-24 items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
        </CardContent>
      </Card>
    )
  }

  if (!stats) {
    return (
      <EndpointDegraded
        title={t('remnaWavePage.hwid.title')}
        description={t('remnaWavePage.hwid.unavailable')}
        compact
        className="md:col-span-2 xl:col-span-4"
      />
    )
  }

  return (
    <>
      <StatTile
        icon={Smartphone}
        title={t('remnaWavePage.hwid.totalDevices')}
        value={stats.stats?.totalHwidDevices ?? 0}
      />
      <StatTile
        icon={Hash}
        title={t('remnaWavePage.hwid.uniqueDevices')}
        value={stats.stats?.totalUniqueDevices ?? 0}
      />
      <StatTile
        icon={CalendarClock}
        title={t('remnaWavePage.hwid.avgPerUser')}
        value={(stats.stats?.averageHwidDevicesPerUser ?? 0).toFixed(1)}
      />
      <StatTile
        icon={TriangleAlert}
        title={t('remnaWavePage.users.hwid.platforms')}
        value={(stats.byPlatform ?? []).length}
      />
    </>
  )
}

// ── HWID top users (potential abusers) ──────────────────────────────────────

function HwidTopUsersCard() {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery({
    queryKey: KEYS.hwidTopUsers,
    queryFn: remnawaveApi.getHwidTopUsers,
  })

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <TriangleAlert className="h-4 w-4 text-amber-500" aria-hidden />
          {t('remnaWavePage.users.topAbusers.title')}
        </CardTitle>
        <CardDescription className="text-xs">
          {t('remnaWavePage.users.topAbusers.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {isLoading ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
          </div>
        ) : !data || data.length === 0 ? (
          <p className="px-6 pb-4 text-sm text-muted-foreground">{t('remnaWavePage.users.topAbusers.empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('remnaWavePage.users.topAbusers.user')}</TableHead>
                <TableHead className="text-right">{t('remnaWavePage.users.topAbusers.devices')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((row) => (
                <TableRow key={row.userUuid}>
                  <TableCell>
                    <p className="font-medium">{row.username}</p>
                    <p className="font-mono text-[10px] text-muted-foreground/70">{row.userUuid.slice(0, 8)}…</p>
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge variant={row.devicesCount >= 10 ? 'destructive' : row.devicesCount >= 5 ? 'outline' : 'secondary'} className="px-2 text-[11px] tabular-nums">
                      {row.devicesCount}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

// ── Subscription request log ────────────────────────────────────────────────

function SubscriptionRequestLogCard() {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery({
    queryKey: [...KEYS.subRequestHistory, { limit: 20 }] as const,
    queryFn: () => remnawaveApi.getSubscriptionRequestHistory({ limit: 20 }),
  })

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <CalendarClock className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('remnaWavePage.users.requestLog.title')}
        </CardTitle>
        <CardDescription className="text-xs">
          {t('remnaWavePage.users.requestLog.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {isLoading ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
          </div>
        ) : !data || data.length === 0 ? (
          <p className="px-6 pb-4 text-sm text-muted-foreground">{t('remnaWavePage.users.requestLog.empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('remnaWavePage.users.requestLog.when')}</TableHead>
                <TableHead>{t('remnaWavePage.users.requestLog.client')}</TableHead>
                <TableHead className="text-right">{t('remnaWavePage.users.requestLog.ip')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="text-xs">
                    {entry.requestedAt ? new Date(entry.requestedAt).toLocaleString() : '—'}
                    {/* 2.7.4 identifies the owner by uuid, 2.8.0 by a panel-internal
                        integer. Rendering `userUuid.slice(0, 8)` for both used to
                        display the integer as though it were a uuid prefix. */}
                    {entry.userUuid ? (
                      <p className="font-mono text-[10px] text-muted-foreground/70">{entry.userUuid.slice(0, 8)}…</p>
                    ) : entry.panelUserId !== null && entry.panelUserId !== undefined ? (
                      <p className="font-mono text-[10px] text-muted-foreground/70">#{entry.panelUserId}</p>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs">
                    {entry.userAgent ? (
                      <span className="font-mono">{shortenUserAgent(entry.userAgent)}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                    {entry.ipAddress ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

// User-Agents Remnawave logs are like `Happ/4.10.2/ios/2605221402666` —
// keep the first two segments for readability, drop machine identifiers.
function shortenUserAgent(ua: string): string {
  const parts = ua.split('/')
  if (parts.length >= 3) return `${parts[0]} · ${parts[2]}`
  return ua
}
