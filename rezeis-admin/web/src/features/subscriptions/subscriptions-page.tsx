import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { CreditCard, RefreshCw, Filter, ExternalLink } from 'lucide-react'

import { api } from '@/lib/api'
import { adminQueryKeys } from '@/lib/admin-query-keys'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { FadeIn } from '@/lib/motion'

const STATUSES = ['ACTIVE', 'DISABLED', 'LIMITED', 'EXPIRED', 'DELETED']

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  ACTIVE: 'default',
  DISABLED: 'secondary',
  LIMITED: 'outline',
  EXPIRED: 'destructive',
  DELETED: 'destructive',
}

interface SubscriptionRow {
  readonly id: string | number
  readonly user?: { readonly name?: string | null } | null
  readonly userTelegramId?: string | number | bigint | null
  readonly status: string
  readonly isTrial?: boolean
  readonly plan?: { readonly name?: string | null } | null
  readonly trafficLimit: number | null
  readonly deviceLimit: number | null
  readonly expireAt: string
}

interface SubscriptionsList {
  readonly items: ReadonlyArray<SubscriptionRow>
  readonly total: number
}

export default function SubscriptionsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [statusFilter, setStatusFilter] = useState('__all__')
  const [trialOnly, setTrialOnly] = useState(false)

  const queryParams = new URLSearchParams({ limit: '50' })
  if (statusFilter && statusFilter !== '__all__') queryParams.set('status', statusFilter)
  if (trialOnly) queryParams.set('isTrial', 'true')

  const { data, isLoading, refetch } = useQuery<SubscriptionsList>({
    queryKey: adminQueryKeys.subscriptions.list({ statusFilter, trialOnly }),
    queryFn: async ({ signal }) =>
      (await api.get<SubscriptionsList>(`/admin/subscriptions?${queryParams}`, { signal })).data,
    placeholderData: keepPreviousData,
  })

  const { data: stats } = useQuery({
    queryKey: adminQueryKeys.subscriptions.stats,
    queryFn: async () => (await api.get('/admin/subscriptions/stats')).data as {
      total: number;
      byStatus: Record<string, number>;
      trialCount: number;
      expiringIn7d: number;
    },
  })

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <CreditCard className="h-6 w-6" /> {t('subscriptionsPage.title')}
            </h1>
            <p className="text-muted-foreground">{t('subscriptionsPage.subtitle')}</p>
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => refetch()}
            aria-label={t('subscriptionsPage.refreshSubscriptions')}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </FadeIn>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: t('subscriptionsPage.stats.total'), value: stats.total },
            { label: t('subscriptionsPage.stats.active'), value: stats.byStatus['ACTIVE'] ?? 0 },
            { label: t('subscriptionsPage.stats.trial'), value: stats.trialCount },
            { label: t('subscriptionsPage.stats.expiring7d'), value: stats.expiringIn7d },
          ].map((s) => (
            <Card key={s.label}>
              <CardContent className="pt-4 pb-3">
                <p className="text-2xl font-bold tabular-nums">{s.value}</p>
                <p className="text-xs text-muted-foreground">{s.label}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-36 h-9"><SelectValue placeholder={t('subscriptionsPage.filters.allStatuses')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{t('subscriptionsPage.filters.allStatuses')}</SelectItem>
                {STATUSES.map((s) => <SelectItem key={s} value={s}>{String(t(`subscriptionsPage.statuses.${s}`, s))}</SelectItem>)}
              </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="trial-only" checked={trialOnly} onCheckedChange={setTrialOnly} />
          <Label htmlFor="trial-only" className="text-sm">{t('subscriptionsPage.filters.trialOnly')}</Label>
        </div>
        {(statusFilter || trialOnly) && (
          <Button variant="ghost" size="sm" onClick={() => { setStatusFilter(''); setTrialOnly(false) }}>
            {t('subscriptionsPage.filters.clear')}
          </Button>
        )}
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : !data?.items?.length ? (
            <div className="py-16 text-center text-muted-foreground">
              <CreditCard className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p>{t('subscriptionsPage.empty')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('subscriptionsPage.table.id')}</TableHead>
                  <TableHead>{t('subscriptionsPage.table.user')}</TableHead>
                  <TableHead>{t('subscriptionsPage.table.status')}</TableHead>
                  <TableHead>{t('subscriptionsPage.table.plan')}</TableHead>
                  <TableHead>{t('subscriptionsPage.table.traffic')}</TableHead>
                  <TableHead>{t('subscriptionsPage.table.devices')}</TableHead>
                  <TableHead>{t('subscriptionsPage.table.expires')}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((sub) => (
                  <TableRow key={sub.id} className="cursor-pointer hover:bg-muted/30"
                    onClick={() => navigate(`/users/${sub.userTelegramId?.toString()}`)}>
                    <TableCell className="font-mono text-xs">{sub.id}</TableCell>
                    <TableCell>
                      <div>
                        <p className="text-sm font-medium">{sub.user?.name ?? '—'}</p>
                        <p className="text-xs text-muted-foreground font-mono">{sub.userTelegramId?.toString()}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Badge variant={STATUS_VARIANT[sub.status] ?? 'outline'}>{String(t(`subscriptionsPage.statuses.${sub.status}`, sub.status))}</Badge>
                        {sub.isTrial && <Badge variant="outline" className="text-xs">{t('subscriptionsPage.trialBadge')}</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{sub.plan?.name ?? '—'}</TableCell>
                    <TableCell className="text-xs">{sub.trafficLimit ? t('subscriptionsPage.trafficGb', { value: sub.trafficLimit }) : '∞'}</TableCell>
                    <TableCell className="text-xs">{sub.deviceLimit || '∞'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(sub.expireAt).toLocaleDateString('ru-RU')}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        aria-label={t('subscriptionsPage.openUser', { id: sub.userTelegramId?.toString() ?? sub.id.toString() })}
                        onClick={() => navigate(`/users/${sub.userTelegramId?.toString()}`)}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
