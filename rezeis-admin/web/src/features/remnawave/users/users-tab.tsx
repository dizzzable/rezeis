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
  RotateCcw,
  Search,
  Smartphone,
  TriangleAlert,
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
                    {entry.userUuid ? (
                      <p className="font-mono text-[10px] text-muted-foreground/70">{entry.userUuid.slice(0, 8)}…</p>
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
