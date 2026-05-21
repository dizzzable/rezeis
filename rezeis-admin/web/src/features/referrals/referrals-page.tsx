/* eslint-disable @typescript-eslint/no-explicit-any -- TODO: type API responses */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Share2, UserPlus, CheckCircle2, Loader2, Link2Off, Settings } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FadeIn, StaggerList, StaggerItem } from '@/lib/motion'
import ReferralSettingsPage from '@/features/settings/referral-settings-page'

export default function ReferralsPage() {
  const { t } = useTranslation()
  const [showAttach, setShowAttach] = useState(false)
  const [showCreateReward, setShowCreateReward] = useState(false)

  const { data: stats } = useQuery({
    queryKey: ['admin', 'referrals', 'stats'],
    queryFn: async () => (await api.get('/admin/referrals/stats')).data as {
      invites: number; referrals: number; qualifiedReferrals: number; rewards: number; issuedRewards: number
    },
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
            { label: t('referralsActions.statsLabels.invites'), value: stats.invites },
            { label: t('referralsActions.statsLabels.referrals'), value: stats.referrals },
            { label: t('referralsActions.statsLabels.qualified'), value: stats.qualifiedReferrals },
            { label: t('referralsActions.statsLabels.rewards'), value: stats.rewards },
            { label: t('referralsActions.statsLabels.issued'), value: stats.issuedRewards },
          ].map((s) => (
            <StaggerItem key={s.label}>
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-2xl font-bold tabular-nums">{s.value}</p>
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                </CardContent>
              </Card>
            </StaggerItem>
          ))}
        </StaggerList>
      )}

      <Tabs defaultValue="referrals">
        <TabsList>
          <TabsTrigger value="referrals">{t('referralsPage.tabs.referrals')}</TabsTrigger>
          <TabsTrigger value="invites">{t('referralsPage.tabs.invites')}</TabsTrigger>
          <TabsTrigger value="rewards">{t('referralsPage.tabs.rewards')}</TabsTrigger>
          <TabsTrigger value="settings">
            <Settings className="h-3.5 w-3.5 mr-1.5" />
            {t('referralsPage.tabs.settings')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="referrals"><ReferralsTab /></TabsContent>
        <TabsContent value="invites"><InvitesTab /></TabsContent>
        <TabsContent value="rewards"><RewardsTab /></TabsContent>
        <TabsContent value="settings" className="pt-4">
          <ReferralSettingsPage />
        </TabsContent>
      </Tabs>

      {/* Attach referrer dialog */}
      <Dialog open={showAttach} onOpenChange={setShowAttach}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('referralsActions.attachDialogTitle')}</DialogTitle></DialogHeader>
          <AttachReferrerForm onClose={() => setShowAttach(false)} />
        </DialogContent>
      </Dialog>

      {/* Create reward dialog */}
      <Dialog open={showCreateReward} onOpenChange={setShowCreateReward}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('referralsActions.issueDialogTitle')}</DialogTitle></DialogHeader>
          <CreateRewardForm onClose={() => setShowCreateReward(false)} />
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Referrals Tab ─────────────────────────────────────────────────────────────

function ReferralsTab() {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'referrals', 'list'],
    queryFn: async () => {
      const raw = (await api.get('/admin/referrals?limit=100')).data as
        | unknown[]
        | { items?: unknown[] }
      const items = Array.isArray(raw) ? raw : (raw?.items ?? [])
      return { items }
    },
  })

  if (isLoading) return <Skeleton className="h-48 w-full mt-4" />

  return (
    <Card className="mt-4">
      <CardContent className="p-0">
        {!data?.items?.length ? (
          <div className="py-12 text-center text-muted-foreground">{t('referralsActions.referralsTab.empty')}</div>
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
              {data.items.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <div>
                      <p className="text-sm font-medium">{r.referrer?.name ?? '—'}</p>
                      <p className="text-xs text-muted-foreground font-mono">{r.referrerTelegramId?.toString()}</p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div>
                      <p className="text-sm font-medium">{r.referred?.name ?? '—'}</p>
                      <p className="text-xs text-muted-foreground font-mono">{r.referredTelegramId?.toString()}</p>
                    </div>
                  </TableCell>
                  <TableCell><Badge variant="outline">L{r.level}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.inviteSource}</TableCell>
                  <TableCell>
                    {r.qualifiedAt ? (
                      <div>
                        <CheckCircle2 className="h-4 w-4 text-emerald-500 inline mr-1" />
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
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

// ── Invites Tab ───────────────────────────────────────────────────────────────

function InvitesTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'referrals', 'invites'],
    queryFn: async () => {
      const raw = (await api.get('/admin/referrals/invites?limit=100')).data as
        | unknown[]
        | { items?: unknown[] }
      const items = Array.isArray(raw) ? raw : (raw?.items ?? [])
      return { items }
    },
  })

  const revokeMutation = useMutation({
    mutationFn: (id: number) => api.post(`/admin/referrals/invites/${id}/revoke`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'referrals', 'invites'] }); toast.success(t('referralsActions.invitesTab.revokeSuccess')) },
    onError: (err: any) => toast.error(err.response?.data?.message ?? t('referralsActions.invitesTab.revokeFailed')),
  })

  if (isLoading) return <Skeleton className="h-48 w-full mt-4" />

  return (
    <Card className="mt-4">
      <CardContent className="p-0">
        {!data?.items?.length ? (
          <div className="py-12 text-center text-muted-foreground">{t('referralsActions.invitesTab.empty')}</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('referralsActions.invitesTab.columns.inviter')}</TableHead>
                <TableHead>{t('referralsActions.invitesTab.columns.token')}</TableHead>
                <TableHead>{t('referralsActions.invitesTab.columns.expires')}</TableHead>
                <TableHead>{t('referralsActions.invitesTab.columns.status')}</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((inv: any) => (
                <TableRow key={inv.id}>
                  <TableCell>
                    <div>
                      <p className="text-sm font-medium">{inv.inviter?.name ?? '—'}</p>
                      <p className="text-xs text-muted-foreground font-mono">{inv.inviterTelegramId?.toString()}</p>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{inv.token?.slice(0, 16)}…</TableCell>
                  <TableCell className="text-xs">
                    {inv.expiresAt ? new Date(inv.expiresAt).toLocaleDateString('ru-RU') : '∞'}
                  </TableCell>
                  <TableCell>
                    {inv.revokedAt ? (
                      <Badge variant="destructive">{t('referralsActions.invitesTab.status.revoked')}</Badge>
                    ) : inv.expiresAt && new Date(inv.expiresAt) < new Date() ? (
                      <Badge variant="secondary">{t('referralsActions.invitesTab.status.expired')}</Badge>
                    ) : (
                      <Badge variant="default">{t('referralsActions.invitesTab.status.active')}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {!inv.revokedAt && (
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive"
                        onClick={() => revokeMutation.mutate(inv.id)}>
                        <Link2Off className="h-3.5 w-3.5" />
                      </Button>
                    )}
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

// ── Rewards Tab ───────────────────────────────────────────────────────────────

function RewardsTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'referrals', 'rewards'],
    queryFn: async () => {
      const raw = (await api.get('/admin/referrals/rewards?limit=100')).data as
        | unknown[]
        | { items?: unknown[] }
      const items = Array.isArray(raw) ? raw : (raw?.items ?? [])
      return { items }
    },
  })

  const issueMutation = useMutation({
    mutationFn: (id: number) => api.post(`/admin/referrals/rewards/${id}/issue`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'referrals', 'rewards'] }); toast.success(t('referralsActions.rewardsTab.issueSuccess')) },
    onError: (err: any) => toast.error(err.response?.data?.message ?? t('referralsActions.rewardsTab.issueFailed')),
  })

  if (isLoading) return <Skeleton className="h-48 w-full mt-4" />

  return (
    <Card className="mt-4">
      <CardContent className="p-0">
        {!data?.items?.length ? (
          <div className="py-12 text-center text-muted-foreground">{t('referralsActions.rewardsTab.empty')}</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('referralsActions.rewardsTab.columns.user')}</TableHead>
                <TableHead>{t('referralsActions.rewardsTab.columns.type')}</TableHead>
                <TableHead>{t('referralsActions.rewardsTab.columns.amount')}</TableHead>
                <TableHead>{t('referralsActions.rewardsTab.columns.status')}</TableHead>
                <TableHead>{t('referralsActions.rewardsTab.columns.created')}</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((rw: any) => (
                <TableRow key={rw.id}>
                  <TableCell>
                    <div>
                      <p className="text-sm font-medium">{rw.user?.name ?? '—'}</p>
                      <p className="text-xs text-muted-foreground font-mono">{rw.userTelegramId?.toString()}</p>
                    </div>
                  </TableCell>
                  <TableCell><Badge variant="outline">{rw.type}</Badge></TableCell>
                  <TableCell className="font-mono font-medium">{rw.amount}</TableCell>
                  <TableCell>
                    {rw.isIssued ? (
                      <Badge variant="default" className="text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20">
                        <CheckCircle2 className="h-3 w-3 mr-1" /> {t('referralsActions.rewardsTab.issued')}
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
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-emerald-600"
                        onClick={() => issueMutation.mutate(rw.id)} disabled={issueMutation.isPending}>
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
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

// ── Attach Referrer Form ──────────────────────────────────────────────────────

function AttachReferrerForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [referredId, setReferredId] = useState('')
  const [referrerId, setReferrerId] = useState('')

  const mutation = useMutation({
    mutationFn: () => api.post('/admin/referrals/attach', {
      referredTelegramId: referredId,
      referrerTelegramId: referrerId,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'referrals'] })
      toast.success(t('referralsActions.attach.success'))
      onClose()
    },
    onError: (err: any) => toast.error(err.response?.data?.message ?? t('referralsActions.attach.failed')),
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
        <Button onClick={() => mutation.mutate()} disabled={!referredId || !referrerId || mutation.isPending}>
          {mutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <UserPlus className="h-4 w-4 mr-2" />}
          {t('referralsActions.attach.submit')}
        </Button>
      </div>
    </div>
  )
}

// ── Create Reward Form ────────────────────────────────────────────────────────

function CreateRewardForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [referralId, setReferralId] = useState('')
  const [telegramId, setTelegramId] = useState('')
  const [type, setType] = useState('POINTS')
  const [amount, setAmount] = useState('')

  const mutation = useMutation({
    mutationFn: () => api.post('/admin/referrals/rewards', {
      referralId: parseInt(referralId),
      userTelegramId: telegramId,
      type,
      amount: parseInt(amount),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'referrals', 'rewards'] })
      toast.success(t('referralsActions.create.success'))
      onClose()
    },
    onError: (err: any) => toast.error(err.response?.data?.message ?? t('referralsActions.create.failed')),
  })

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>{t('referralsActions.create.referralIdLabel')}</Label>
          <Input type="number" placeholder="1" value={referralId} onChange={(e) => setReferralId(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t('referralsActions.create.userTelegramIdLabel')}</Label>
          <Input placeholder="123456789" value={telegramId} onChange={(e) => setTelegramId(e.target.value)} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>{t('referralsActions.create.typeLabel')}</Label>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger><SelectValue /></SelectTrigger>
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
        <Button onClick={() => mutation.mutate()} disabled={!referralId || !telegramId || !amount || mutation.isPending}>
          {mutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
          {t('referralsActions.create.submit')}
        </Button>
      </div>
    </div>
  )
}
