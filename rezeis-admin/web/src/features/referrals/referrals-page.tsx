import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  BadgeCheck,
  BarChart3,
  CheckCircle2,
  Coins,
  Copy,
  Loader2,
  Search,
  Settings,
  Share2,
  ShieldOff,
  UserPlus,
} from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/http-errors'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FadeIn, StaggerList, StaggerItem } from '@/lib/motion'
import { cn } from '@/lib/utils'

import ReferralSettingsPage from '@/features/settings/referral-settings-page'
import ReferralsAnalyticsTab from './referrals-analytics-tab'
import {
  INVITE_STATUS_META,
  REFERRAL_SOURCE_META,
  getLevelMeta,
  getRewardTypeMeta,
  getSourceMeta,
  type InviteStatus,
} from './referrals-icons'

// ── Top-level page ───────────────────────────────────────────────────────────

interface ReferralStats {
  readonly invites: number
  readonly referrals: number
  readonly qualifiedReferrals: number
  readonly rewards: number
  readonly issuedRewards: number
}

export default function ReferralsPage() {
  const { t } = useTranslation()
  const [showAttach, setShowAttach] = useState(false)
  const [showCreateReward, setShowCreateReward] = useState(false)

  const { data: stats } = useQuery<ReferralStats>({
    queryKey: ['admin', 'referrals', 'stats'],
    queryFn: async () => (await api.get('/admin/referrals/stats')).data as ReferralStats,
  })

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Share2 className="h-6 w-6" /> {t('referralsPage.title')}
            </h1>
            <p className="text-muted-foreground">{t('referralsPage.subtitle')}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowAttach(true)}>
              <UserPlus className="h-4 w-4 mr-2" /> {t('referralsPage.attachReferrer')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowCreateReward(true)}>
              <CheckCircle2 className="h-4 w-4 mr-2" /> {t('referralsPage.issueReward')}
            </Button>
          </div>
        </div>
      </FadeIn>

      {/* Stats */}
      {stats && (
        <StaggerList className="grid gap-3 grid-cols-2 sm:grid-cols-5">
          {[
            { label: t('referralsActions.statsLabels.invites'), value: stats.invites, icon: Share2 },
            { label: t('referralsActions.statsLabels.referrals'), value: stats.referrals, icon: UserPlus },
            { label: t('referralsActions.statsLabels.qualified'), value: stats.qualifiedReferrals, icon: BadgeCheck },
            { label: t('referralsActions.statsLabels.rewards'), value: stats.rewards, icon: Coins },
            { label: t('referralsActions.statsLabels.issued'), value: stats.issuedRewards, icon: CheckCircle2 },
          ].map((s) => {
            const Icon = s.icon
            return (
              <StaggerItem key={s.label}>
                <Card>
                  <CardContent className="pt-4 pb-3">
                    <div className="flex items-center justify-between">
                      <p className="text-2xl font-bold tabular-nums">{s.value.toLocaleString('ru-RU')}</p>
                      <Icon className="h-4 w-4 text-muted-foreground/50" />
                    </div>
                    <p className="text-xs text-muted-foreground">{s.label}</p>
                  </CardContent>
                </Card>
              </StaggerItem>
            )
          })}
        </StaggerList>
      )}

      <Tabs defaultValue="referrals">
        <TabsList>
          <TabsTrigger value="referrals">{t('referralsPage.tabs.referrals')}</TabsTrigger>
          <TabsTrigger value="invites">{t('referralsPage.tabs.invites')}</TabsTrigger>
          <TabsTrigger value="rewards">{t('referralsPage.tabs.rewards')}</TabsTrigger>
          <TabsTrigger value="analytics">
            <BarChart3 className="h-3.5 w-3.5 mr-1.5" />
            {t('referralsPage.tabs.analytics')}
          </TabsTrigger>
          <TabsTrigger value="settings">
            <Settings className="h-3.5 w-3.5 mr-1.5" />
            {t('referralsPage.tabs.settings')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="referrals"><ReferralsTab /></TabsContent>
        <TabsContent value="invites"><InvitesTab /></TabsContent>
        <TabsContent value="rewards"><RewardsTab /></TabsContent>
        <TabsContent value="analytics"><ReferralsAnalyticsTab /></TabsContent>
        <TabsContent value="settings" className="pt-4">
          <ReferralSettingsPage />
        </TabsContent>
      </Tabs>

      <Dialog open={showAttach} onOpenChange={setShowAttach}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('referralsActions.attachDialogTitle')}</DialogTitle></DialogHeader>
          <AttachReferrerForm onClose={() => setShowAttach(false)} />
        </DialogContent>
      </Dialog>

      <Dialog open={showCreateReward} onOpenChange={setShowCreateReward}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('referralsActions.issueDialogTitle')}</DialogTitle></DialogHeader>
          <CreateRewardForm onClose={() => setShowCreateReward(false)} />
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Shared types ─────────────────────────────────────────────────────────────

interface ReferralUserSummary {
  readonly id?: string
  readonly name?: string | null
  readonly username?: string | null
}

interface ReferralRow {
  readonly id: string
  readonly referrer?: ReferralUserSummary | null
  readonly referrerTelegramId?: string | null
  readonly referred?: ReferralUserSummary | null
  readonly referredTelegramId?: string | null
  readonly level: number
  readonly inviteSource?: string | null
  readonly qualifiedAt?: string | null
  readonly createdAt: string
}

interface InviteRow {
  readonly id: string
  readonly inviter?: ReferralUserSummary | null
  readonly inviterTelegramId?: string | null
  readonly token: string
  readonly expiresAt?: string | null
  readonly revokedAt?: string | null
  readonly consumedAt?: string | null
}

interface RewardRow {
  readonly id: string
  readonly referralId: string
  readonly user?: ReferralUserSummary | null
  readonly userTelegramId?: string | null
  readonly type: string
  readonly amount: number | string
  readonly isIssued: boolean
  readonly issuedAt?: string | null
  readonly issuedBy?: string | null
  readonly createdAt: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function unwrap<T>(raw: ReadonlyArray<T> | { items?: ReadonlyArray<T> } | undefined): readonly T[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object' && 'items' in raw) return raw.items ?? []
  return []
}

function deriveInviteStatus(inv: InviteRow): InviteStatus {
  if (inv.revokedAt) return 'revoked'
  if (inv.consumedAt) return 'consumed'
  if (inv.expiresAt && new Date(inv.expiresAt) < new Date()) return 'expired'
  return 'active'
}

function matchesQuery(query: string, ...fields: ReadonlyArray<string | null | undefined>): boolean {
  if (!query.trim()) return true
  const needle = query.trim().toLowerCase()
  return fields.some((f) => (f ?? '').toLowerCase().includes(needle))
}

// ── Referrals Tab ────────────────────────────────────────────────────────────

function ReferralsTab() {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [levelFilter, setLevelFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'qualified' | 'pending'>('all')

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'referrals', 'list'],
    queryFn: async () => {
      const raw = (await api.get('/admin/referrals?limit=200')).data as
        | ReadonlyArray<ReferralRow>
        | { items?: ReadonlyArray<ReferralRow> }
      return unwrap(raw)
    },
  })

  const filtered = useMemo(() => {
    if (!data) return [] as readonly ReferralRow[]
    return data.filter((r) => {
      if (levelFilter !== 'all' && String(r.level) !== levelFilter) return false
      if (statusFilter === 'qualified' && !r.qualifiedAt) return false
      if (statusFilter === 'pending' && r.qualifiedAt) return false
      return matchesQuery(
        query,
        r.referrer?.name,
        r.referrer?.username,
        r.referrerTelegramId?.toString(),
        r.referred?.name,
        r.referred?.username,
        r.referredTelegramId?.toString(),
      )
    })
  }, [data, query, levelFilter, statusFilter])

  if (isLoading) return <Skeleton className="h-48 w-full mt-4" />

  return (
    <div className="space-y-3 mt-4">
      <FilterBar query={query} onQueryChange={setQuery} placeholder={t('referralsActions.referralsTab.searchPlaceholder')}>
        <Select value={levelFilter} onValueChange={setLevelFilter}>
          <SelectTrigger className="w-32 h-9">
            <SelectValue placeholder={t('referralsActions.referralsTab.filters.level')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('referralsActions.referralsTab.filters.allLevels')}</SelectItem>
            <SelectItem value="1">L1</SelectItem>
            <SelectItem value="2">L2</SelectItem>
            <SelectItem value="3">L3</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
          <SelectTrigger className="w-44 h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('referralsActions.referralsTab.filters.allStatuses')}</SelectItem>
            <SelectItem value="qualified">{t('referralsActions.referralsTab.filters.qualified')}</SelectItem>
            <SelectItem value="pending">{t('referralsActions.referralsTab.filters.pending')}</SelectItem>
          </SelectContent>
        </Select>
      </FilterBar>

      <Card>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              {t('referralsActions.referralsTab.empty')}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('referralsActions.referralsTab.columns.referrer')}</TableHead>
                  <TableHead>{t('referralsActions.referralsTab.columns.referred')}</TableHead>
                  <TableHead>{t('referralsActions.referralsTab.columns.level')}</TableHead>
                  <TableHead>{t('referralsActions.referralsTab.columns.source')}</TableHead>
                  <TableHead>{t('referralsActions.referralsTab.columns.qualified')}</TableHead>
                  <TableHead>{t('referralsActions.referralsTab.columns.created')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r) => {
                  const levelMeta = getLevelMeta(r.level)
                  const sourceMeta = getSourceMeta(r.inviteSource)
                  const LevelIcon = levelMeta.icon
                  const SourceIcon = sourceMeta.icon
                  return (
                    <TableRow key={r.id}>
                      <TableCell><UserCell user={r.referrer} telegramId={r.referrerTelegramId} /></TableCell>
                      <TableCell><UserCell user={r.referred} telegramId={r.referredTelegramId} /></TableCell>
                      <TableCell>
                        <Badge variant="outline" className="gap-1">
                          <LevelIcon className={cn('h-3 w-3', levelMeta.className)} /> L{r.level}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <SourceIcon className={cn('h-3.5 w-3.5', sourceMeta.className)} />
                          {r.inviteSource ?? '—'}
                        </span>
                      </TableCell>
                      <TableCell>
                        {r.qualifiedAt ? (
                          <div className="inline-flex items-center gap-1">
                            <BadgeCheck className="h-4 w-4 text-emerald-500" />
                            <span className="text-xs">{new Date(r.qualifiedAt).toLocaleDateString('ru-RU')}</span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(r.createdAt).toLocaleDateString('ru-RU')}
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

// ── Invites Tab ──────────────────────────────────────────────────────────────

function InvitesTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | InviteStatus>('all')

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'referrals', 'invites'],
    queryFn: async () => {
      const raw = (await api.get('/admin/referrals/invites?limit=200')).data as
        | ReadonlyArray<InviteRow>
        | { items?: ReadonlyArray<InviteRow> }
      return unwrap(raw)
    },
  })

  const filtered = useMemo(() => {
    if (!data) return [] as readonly InviteRow[]
    return data.filter((inv) => {
      const status = deriveInviteStatus(inv)
      if (statusFilter !== 'all' && status !== statusFilter) return false
      return matchesQuery(
        query,
        inv.inviter?.name,
        inv.inviter?.username,
        inv.inviterTelegramId?.toString(),
        inv.token,
      )
    })
  }, [data, query, statusFilter])

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/referrals/invites/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'referrals', 'invites'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'referrals', 'stats'] })
      toast.success(t('referralsActions.invitesTab.revokeSuccess'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('referralsActions.invitesTab.revokeFailed'))),
  })

  const copyToken = (token: string) => {
    void navigator.clipboard.writeText(token).then(
      () => toast.success(t('referralsActions.invitesTab.copied')),
      () => toast.error(t('referralsActions.invitesTab.copyFailed')),
    )
  }

  if (isLoading) return <Skeleton className="h-48 w-full mt-4" />

  return (
    <div className="space-y-3 mt-4">
      <FilterBar query={query} onQueryChange={setQuery} placeholder={t('referralsActions.invitesTab.searchPlaceholder')}>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
          <SelectTrigger className="w-44 h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('referralsActions.invitesTab.filters.all')}</SelectItem>
            <SelectItem value="active">{t('referralsActions.invitesTab.status.active')}</SelectItem>
            <SelectItem value="consumed">{t('referralsActions.invitesTab.status.consumed')}</SelectItem>
            <SelectItem value="expired">{t('referralsActions.invitesTab.status.expired')}</SelectItem>
            <SelectItem value="revoked">{t('referralsActions.invitesTab.status.revoked')}</SelectItem>
          </SelectContent>
        </Select>
      </FilterBar>

      <Card>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">{t('referralsActions.invitesTab.empty')}</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('referralsActions.invitesTab.columns.inviter')}</TableHead>
                  <TableHead>{t('referralsActions.invitesTab.columns.token')}</TableHead>
                  <TableHead>{t('referralsActions.invitesTab.columns.expires')}</TableHead>
                  <TableHead>{t('referralsActions.invitesTab.columns.status')}</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((inv) => {
                  const status = deriveInviteStatus(inv)
                  const meta = INVITE_STATUS_META[status]
                  const StatusIcon = meta.icon
                  return (
                    <TableRow key={inv.id}>
                      <TableCell><UserCell user={inv.inviter} telegramId={inv.inviterTelegramId} /></TableCell>
                      <TableCell>
                        <span className="font-mono text-xs text-muted-foreground">
                          {inv.token.slice(0, 16)}…
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {inv.expiresAt ? new Date(inv.expiresAt).toLocaleDateString('ru-RU') : '∞'}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="gap-1 capitalize">
                          <StatusIcon className={cn('h-3 w-3', meta.className)} />
                          {t(`referralsActions.invitesTab.status.${status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => copyToken(inv.token)}
                            title={t('referralsActions.invitesTab.copyTitle')}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          {status === 'active' && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-destructive"
                              onClick={() => revokeMutation.mutate(inv.id)}
                              disabled={revokeMutation.isPending}
                              title={t('referralsActions.invitesTab.revokeTitle')}
                            >
                              <ShieldOff className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
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

// ── Rewards Tab ──────────────────────────────────────────────────────────────

function RewardsTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | 'POINTS' | 'EXTRA_DAYS'>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'issued' | 'pending'>('all')
  const [selected, setSelected] = useState<readonly string[]>([])

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'referrals', 'rewards'],
    queryFn: async () => {
      const raw = (await api.get('/admin/referrals/rewards?limit=200')).data as
        | ReadonlyArray<RewardRow>
        | { items?: ReadonlyArray<RewardRow> }
      return unwrap(raw)
    },
  })

  const filtered = useMemo(() => {
    if (!data) return [] as readonly RewardRow[]
    return data.filter((rw) => {
      if (typeFilter !== 'all' && rw.type !== typeFilter) return false
      if (statusFilter === 'issued' && !rw.isIssued) return false
      if (statusFilter === 'pending' && rw.isIssued) return false
      return matchesQuery(
        query,
        rw.user?.name,
        rw.user?.username,
        rw.userTelegramId?.toString(),
        rw.referralId,
      )
    })
  }, [data, query, typeFilter, statusFilter])

  const issueMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/referrals/rewards/${id}/issue`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'referrals', 'rewards'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'referrals', 'stats'] })
      toast.success(t('referralsActions.rewardsTab.issueSuccess'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('referralsActions.rewardsTab.issueFailed'))),
  })

  const bulkIssueMutation = useMutation({
    mutationFn: (ids: readonly string[]) =>
      api.post('/admin/referrals/rewards/bulk-issue', { ids: [...ids] }).then((r) => r.data as {
        issued: number
        skipped: number
        failed: number
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'referrals', 'rewards'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'referrals', 'stats'] })
      toast.success(
        t('referralsActions.rewardsTab.bulkIssueSuccess', {
          issued: result.issued,
          skipped: result.skipped,
          failed: result.failed,
        }),
      )
      setSelected([])
    },
    onError: (err) => toast.error(getErrorMessage(err, t('referralsActions.rewardsTab.bulkIssueFailed'))),
  })

  const togglePending = useMemo(
    () => filtered.filter((rw) => !rw.isIssued).map((rw) => rw.id),
    [filtered],
  )
  const allChecked = togglePending.length > 0 && selected.length === togglePending.length

  if (isLoading) return <Skeleton className="h-48 w-full mt-4" />

  return (
    <div className="space-y-3 mt-4">
      <FilterBar query={query} onQueryChange={setQuery} placeholder={t('referralsActions.rewardsTab.searchPlaceholder')}>
        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as typeof typeFilter)}>
          <SelectTrigger className="w-36 h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('referralsActions.rewardsTab.filters.allTypes')}</SelectItem>
            <SelectItem value="POINTS">{t('referralsActions.create.typePoints')}</SelectItem>
            <SelectItem value="EXTRA_DAYS">{t('referralsActions.create.typeExtraDays')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
          <SelectTrigger className="w-44 h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('referralsActions.rewardsTab.filters.allStatuses')}</SelectItem>
            <SelectItem value="issued">{t('referralsActions.rewardsTab.issued')}</SelectItem>
            <SelectItem value="pending">{t('referralsActions.rewardsTab.pending')}</SelectItem>
          </SelectContent>
        </Select>
        {selected.length > 0 && (
          <Button
            size="sm"
            onClick={() => bulkIssueMutation.mutate(selected)}
            disabled={bulkIssueMutation.isPending}
          >
            {bulkIssueMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4 mr-2" />
            )}
            {t('referralsActions.rewardsTab.bulkIssueButton', { count: selected.length })}
          </Button>
        )}
      </FilterBar>

      <Card>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">{t('referralsActions.rewardsTab.empty')}</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-9">
                    <Checkbox
                      checked={allChecked}
                      onCheckedChange={(checked) => {
                        setSelected(checked ? togglePending : [])
                      }}
                      aria-label={t('referralsActions.rewardsTab.bulkSelectAria')}
                    />
                  </TableHead>
                  <TableHead>{t('referralsActions.rewardsTab.columns.user')}</TableHead>
                  <TableHead>{t('referralsActions.rewardsTab.columns.type')}</TableHead>
                  <TableHead>{t('referralsActions.rewardsTab.columns.amount')}</TableHead>
                  <TableHead>{t('referralsActions.rewardsTab.columns.status')}</TableHead>
                  <TableHead>{t('referralsActions.rewardsTab.columns.created')}</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((rw) => {
                  const meta = getRewardTypeMeta(rw.type)
                  const Icon = meta.icon
                  const isSelected = selected.includes(rw.id)
                  return (
                    <TableRow key={rw.id}>
                      <TableCell>
                        {!rw.isIssued && (
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={(checked) =>
                              setSelected((prev) =>
                                checked ? [...prev, rw.id] : prev.filter((id) => id !== rw.id),
                              )
                            }
                            aria-label={t('referralsActions.rewardsTab.bulkRowAria')}
                          />
                        )}
                      </TableCell>
                      <TableCell><UserCell user={rw.user} telegramId={rw.userTelegramId} /></TableCell>
                      <TableCell>
                        <Badge variant="outline" className="gap-1">
                          <Icon className={cn('h-3 w-3', meta.className)} /> {rw.type}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono font-medium tabular-nums">{rw.amount}</TableCell>
                      <TableCell>
                        {rw.isIssued ? (
                          <Badge variant="default" className="text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 gap-1">
                            <CheckCircle2 className="h-3 w-3" /> {t('referralsActions.rewardsTab.issued')}
                          </Badge>
                        ) : (
                          <Badge variant="secondary">{t('referralsActions.rewardsTab.pending')}</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(rw.createdAt).toLocaleDateString('ru-RU')}
                      </TableCell>
                      <TableCell>
                        {!rw.isIssued && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-emerald-600"
                            onClick={() => issueMutation.mutate(rw.id)}
                            disabled={issueMutation.isPending}
                            title={t('referralsActions.rewardsTab.issueTitle')}
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
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

// ── Reusable bits ────────────────────────────────────────────────────────────

interface FilterBarProps {
  readonly query: string
  readonly onQueryChange: (value: string) => void
  readonly placeholder: string
  readonly children?: React.ReactNode
}

function FilterBar({ query, onQueryChange, placeholder, children }: FilterBarProps) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="relative flex-1 min-w-[200px] max-w-md">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={placeholder}
          className="pl-8 h-9"
        />
      </div>
      {children}
    </div>
  )
}

interface UserCellProps {
  readonly user?: ReferralUserSummary | null
  readonly telegramId?: string | null
}

function UserCell({ user, telegramId }: UserCellProps) {
  return (
    <div>
      <p className="text-sm font-medium">{user?.name ?? user?.username ?? '—'}</p>
      <p className="text-xs text-muted-foreground font-mono">{telegramId ?? '—'}</p>
    </div>
  )
}

// ── Attach Referrer Form ────────────────────────────────────────────────────

function AttachReferrerForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [referredId, setReferredId] = useState('')
  const [referrerId, setReferrerId] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/admin/referrals/attach', {
        referredTelegramId: referredId,
        referrerTelegramId: referrerId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'referrals'] })
      toast.success(t('referralsActions.attach.success'))
      onClose()
    },
    onError: (err) => toast.error(getErrorMessage(err, t('referralsActions.attach.failed'))),
  })

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>{t('referralsActions.attach.referredLabel')}</Label>
        <Input placeholder="123456789" value={referredId} onChange={(e) => setReferredId(e.target.value)} />
        <p className="text-xs text-muted-foreground">{t('referralsActions.attach.referredHint')}</p>
      </div>
      <div className="space-y-1.5">
        <Label>{t('referralsActions.attach.referrerLabel')}</Label>
        <Input placeholder="987654321" value={referrerId} onChange={(e) => setReferrerId(e.target.value)} />
        <p className="text-xs text-muted-foreground">{t('referralsActions.attach.referrerHint')}</p>
      </div>
      <div className="flex gap-3 justify-end">
        <Button variant="outline" onClick={onClose}>{t('referralsActions.attach.cancel')}</Button>
        <Button
          onClick={() => mutation.mutate()}
          disabled={!referredId || !referrerId || mutation.isPending}
        >
          {mutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <UserPlus className="h-4 w-4 mr-2" />}
          {t('referralsActions.attach.submit')}
        </Button>
      </div>
    </div>
  )
}

// ── Create Reward Form ──────────────────────────────────────────────────────

function CreateRewardForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [referralId, setReferralId] = useState('')
  const [telegramId, setTelegramId] = useState('')
  const [type, setType] = useState<'POINTS' | 'EXTRA_DAYS'>('POINTS')
  const [amount, setAmount] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/admin/referrals/rewards', {
        referralId,
        userTelegramId: telegramId,
        type,
        amount: parseInt(amount, 10),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'referrals', 'rewards'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'referrals', 'stats'] })
      toast.success(t('referralsActions.create.success'))
      onClose()
    },
    onError: (err) => toast.error(getErrorMessage(err, t('referralsActions.create.failed'))),
  })

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>{t('referralsActions.create.referralIdLabel')}</Label>
        <Input
          placeholder="cm12abc34567"
          value={referralId}
          onChange={(e) => setReferralId(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">{t('referralsActions.create.referralIdHint')}</p>
      </div>
      <div className="space-y-1.5">
        <Label>{t('referralsActions.create.userTelegramIdLabel')}</Label>
        <Input
          placeholder="123456789"
          value={telegramId}
          onChange={(e) => setTelegramId(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>{t('referralsActions.create.typeLabel')}</Label>
          <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="POINTS">{t('referralsActions.create.typePoints')}</SelectItem>
              <SelectItem value="EXTRA_DAYS">{t('referralsActions.create.typeExtraDays')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>{t('referralsActions.create.amountLabel')}</Label>
          <Input type="number" min="1" placeholder="100" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
      </div>
      <div className="flex gap-3 justify-end">
        <Button variant="outline" onClick={onClose}>{t('referralsActions.create.cancel')}</Button>
        <Button
          onClick={() => mutation.mutate()}
          disabled={!referralId || !telegramId || !amount || mutation.isPending}
        >
          {mutation.isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <CheckCircle2 className="h-4 w-4 mr-2" />
          )}
          {t('referralsActions.create.submit')}
        </Button>
      </div>
    </div>
  )
}

// Suppress unused-import warning when REFERRAL_SOURCE_META is referenced only via the helper.
void REFERRAL_SOURCE_META
