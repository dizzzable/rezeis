import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
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
import { PageTitle } from '@/components/layout/page-title'
import { AutoRenewPanel } from './auto-renew-panel'
import { PanelLinkReconciliationPanel } from './panel-link-reconciliation-panel'
import { DuplicateSubscriptionMergePanel } from './duplicate-subscription-merge-panel'
import { UnknownSquadPanel } from './unknown-squad-panel'

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
  readonly user?: { readonly id?: string; readonly name?: string | null } | null
  readonly userTelegramId?: string | number | bigint | null
  readonly status: string
  readonly isTrial?: boolean
  readonly plan?: { readonly name?: string | null } | null
  readonly trafficLimit: number | null
  readonly deviceLimit: number | null
  /**
   * ISO instant, or `null` for an UNLIMITED subscription.
   *
   * Null is a domain state here, not a missing value: `Subscription.expiresAt`
   * is `DateTime?` and the backend reads it that way itself —
   * `referral-points-exchange.service.ts` queries `{ status: ACTIVE,
   * expiresAt: null }` as the unlimited bucket, and `subscription-mutations`
   * declines to extend one ("Unlimited subscription - nothing to extend").
   * Declared as a bare `string` here it fed `new Date(null)`, which coerces to
   * 0, so every unlimited row printed a confident `01.01.1970` instead of
   * failing loudly.
   *
   * `GET /admin/subscriptions` ALSO sends `expiresAt` with the identical value.
   * The header of
   * `src/modules/subscriptions/interfaces/admin-subscriptions-list.interface.ts`
   * calls `expireAt` the LEGACY ALIAS, kept populated so this client keeps
   * working while it migrates — yet nothing in the SPA reads that sibling on
   * this endpoint, so the alias is the live field and the canonical name is the
   * dead one. It is deliberately NOT declared here: a field nothing reads is a
   * field that drifts unnoticed. Dropping it from the wire is the backend's
   * call, not ours.
   *
   * The canonical spelling does exist elsewhere in the SPA and got the
   * nullability right — `users-api.ts` models `expiresAt: z.string().nullable()`
   * on the `/admin/users/search` and subscriptions-workbench rows. Four
   * declarations of one field, three of them agreeing by accident, is how this
   * one drifted; if the alias is ever retired, that schema is the shape to copy.
   */
  readonly expireAt: string | null
}

/** Prefer reiwa user id (works for web-only / no Telegram); fall back to TG id. */
function userProfilePath(sub: SubscriptionRow): string | null {
  const userId = typeof sub.user?.id === 'string' && sub.user.id.length > 0 ? sub.user.id : null
  if (userId) return `/users/${userId}`
  const tg = sub.userTelegramId?.toString()
  if (tg && tg.length > 0) return `/users/${tg}`
  return null
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
            <PageTitle icon={CreditCard} title={t('subscriptionsPage.title')} />
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

      {/* Auto-renewal: the cycle that moves subscriptions between the
          states counted above, plus the manual trigger used when a
          support report says a renewal did not happen. Renders nothing
          without `auto_renew:view`. */}
      <AutoRenewPanel />

      {/* Bulk repair for subscriptions whose panel profile exists but whose
          stored panel identity is empty — the only caller of
          POST /admin/profile-sync/panel-link-reconciliation. Same authority as
          the single-row repair on the user detail page (subscriptions:edit),
          so it sits with the rows it repairs. Renders nothing without it. */}
      <PanelLinkReconciliationPanel />

      {/* The action the sweep above deliberately stops short of: two live
          subscriptions on ONE panel profile, merged into the older row that
          carries the customer history. Only caller of
          POST /admin/profile-sync/duplicate-subscription-merge, same authority
          (subscriptions:edit) and the same rows — it finds its pairs by running
          that very sweep. Renders nothing without the permission. */}
      <DuplicateSubscriptionMergePanel />

      {/* Read-only, and the only surface that answers for the WHOLE install:
          which subscriptions still name a squad the panel no longer serves, and
          which plans will keep recreating the problem. The other two notices
          for this failure arrive too late (a sync that already failed) or only
          once (a toast when a plan is saved). Asks for `plans:view`, renders
          nothing without it. */}
      <UnknownSquadPanel />

      {/* Filters */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-36 h-9" aria-label={t('subscriptionsPage.table.status')}><SelectValue placeholder={t('subscriptionsPage.filters.allStatuses')} /></SelectTrigger>
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
                {data.items.map((sub) => {
                  const profilePath = userProfilePath(sub)
                  const openUser = () => {
                    if (profilePath) navigate(profilePath)
                  }
                  return (
                  <TableRow
                    key={sub.id}
                    className={profilePath ? 'cursor-pointer hover:bg-muted/40' : undefined}
                    onClick={profilePath ? openUser : undefined}
                    // Focusable + Enter/Space for keyboard parity with row click.
                    // No role=link: nested ↗ button must remain the named control
                    // for screen readers (avoid nested interactive).
                    tabIndex={profilePath ? 0 : undefined}
                    onKeyDown={
                      profilePath
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              openUser()
                            }
                          }
                        : undefined
                    }
                  >
                    <TableCell className="font-mono text-xs">{sub.id}</TableCell>
                    <TableCell>
                      <div>
                        <p className="text-sm font-medium">{sub.user?.name ?? '—'}</p>
                        <p className="text-xs text-muted-foreground font-mono">
                          {sub.userTelegramId?.toString()
                            ?? (typeof sub.user?.id === 'string' ? sub.user.id : '—')}
                        </p>
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
                      {/* `=== null`, not a truthiness check: unlimited is a
                          state the server states, and anything else that
                          arrives here should render as the broken value it is
                          rather than be absorbed into "unlimited". */}
                      {sub.expireAt === null
                        ? t('subscriptionsPage.unlimitedExpiry')
                        : new Date(sub.expireAt).toLocaleDateString('ru-RU')}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        disabled={!profilePath}
                        aria-label={t('subscriptionsPage.openUser', {
                          id: sub.user?.id ?? sub.userTelegramId?.toString() ?? sub.id.toString(),
                        })}
                        onClick={(e) => {
                          e.stopPropagation()
                          openUser()
                        }}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
