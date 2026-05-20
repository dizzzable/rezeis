/* eslint-disable @typescript-eslint/no-explicit-any -- TODO: type API responses */
import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, UserX, UserCheck, Copy, Save, Send, RefreshCw, Plus, Minus, Trash2, Power, PowerOff, Clock, HardDrive, Smartphone, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'

export default function UserDetailPage() {
  const { t, i18n } = useTranslation()
  const { telegramId } = useParams<{ telegramId: string }>()
  const navigate = useNavigate()
  const queryKey: string[] = ['admin', 'users', telegramId ?? '']

  const { data: user, isLoading } = useQuery({
    queryKey,
    queryFn: async () => (await api.get(`/admin/users/${telegramId}`)).data,
    enabled: !!telegramId,
  })

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }
  if (!user) {
    return (
      <div className="py-16 text-center text-muted-foreground">
        {t('userDetailPage.notFound')}
      </div>
    )
  }

  const subsCount = user.subscriptions?.length ?? 0
  const txCount = user.transactions?.length ?? 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate('/users')}
          aria-label={t('userDetailPage.header.back')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight">{user.name}</h1>
          <p className="text-muted-foreground">
            {user.username ? `@${user.username}` : ''} • TG: {user.telegramId?.toString()}
          </p>
        </div>
        <BlockButton telegramId={telegramId!} isBlocked={user.isBlocked} queryKey={queryKey} />
        <SendNotificationButton telegramId={telegramId!} />
      </div>

      {/* Profile + Quick Actions */}
      <div className="grid gap-4 lg:grid-cols-5">
        <ProfileCard user={user} />
        <QuickActions user={user} telegramId={telegramId!} queryKey={queryKey} />
      </div>

      {/* Tabs */}
      <Tabs defaultValue="subscriptions">
        <TabsList>
          <TabsTrigger value="subscriptions">
            {t('userDetailPage.tabs.subscriptions', { count: subsCount })}
          </TabsTrigger>
          <TabsTrigger value="transactions">
            {t('userDetailPage.tabs.transactions', { count: txCount })}
          </TabsTrigger>
          <TabsTrigger value="referrals">{t('userDetailPage.tabs.referrals')}</TabsTrigger>
          <TabsTrigger value="partner">{t('userDetailPage.tabs.partner')}</TabsTrigger>
        </TabsList>

        <TabsContent value="subscriptions">
          <SubscriptionsTab user={user} queryKey={queryKey} locale={i18n.language} />
        </TabsContent>
        <TabsContent value="transactions">
          <TransactionsTab user={user} locale={i18n.language} />
        </TabsContent>
        <TabsContent value="referrals">
          <ReferralsTab user={user} />
        </TabsContent>
        <TabsContent value="partner">
          <PartnerTab user={user} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ── Profile Card ─────────────────────────────────────────────────────────────

function ProfileCard({ user }: { user: any }) {
  const { t, i18n } = useTranslation()
  const noValue = t('userDetailPage.profile.noValue')
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-base">{t('userDetailPage.profile.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Row label={t('userDetailPage.profile.telegramId')} value={user.telegramId?.toString() ?? noValue} mono copyable />
        <Row label={t('userDetailPage.profile.username')} value={user.username ? `@${user.username}` : noValue} />
        <Row label={t('userDetailPage.profile.referralCode')} value={user.referralCode} mono copyable />
        <Row label={t('userDetailPage.profile.language')} value={user.language ?? noValue} />
        <Row
          label={t('userDetailPage.profile.registered')}
          value={new Date(user.createdAt).toLocaleString(
            i18n.language === 'ru' ? 'ru-RU' : 'en-US',
          )}
        />
        <Row
          label={t('userDetailPage.profile.status')}
          value={
            user.isBlocked
              ? `🔴 ${t('userDetailPage.profile.statusBlocked')}`
              : `🟢 ${t('userDetailPage.profile.statusActive')}`
          }
        />
        {user.webAccount && (
          <>
            <Separator />
            <Row label={t('userDetailPage.profile.webLogin')} value={user.webAccount.username} mono />
            <Row label={t('userDetailPage.profile.webEmail')} value={user.webAccount.email ?? noValue} />
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Row({
  label,
  value,
  mono,
  copyable,
}: {
  label: string
  value: string
  mono?: boolean
  copyable?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`flex items-center gap-1 ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
        {copyable && (
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={() => {
              navigator.clipboard.writeText(value)
              toast.success(t('userDetailPage.copied'))
            }}
          >
            <Copy className="h-3 w-3" />
          </Button>
        )}
      </span>
    </div>
  )
}

// ── Quick Actions (inline editing) ──────────────────────────────────────────

function QuickActions({
  user,
  telegramId,
  queryKey,
}: {
  user: any
  telegramId: string
  queryKey: string[]
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [role, setRole] = useState(user.role)
  const [personalDiscount, setPersonalDiscount] = useState(user.personalDiscount?.toString() ?? '0')
  const [purchaseDiscount, setPurchaseDiscount] = useState(user.purchaseDiscount?.toString() ?? '0')
  const [points, setPoints] = useState(user.points?.toString() ?? '0')
  const [maxSubs, setMaxSubs] = useState(user.maxSubscriptions?.toString() ?? '__default__')
  const [currencyOverride, setCurrencyOverride] = useState(
    user.partnerBalanceCurrencyOverride ?? '__default__',
  )
  const [dirty, setDirty] = useState(false)

  const saveMutation = useMutation({
    mutationFn: (data: any) => api.patch(`/admin/users/${telegramId}/profile`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPage.profileSaved'))
      setDirty(false)
    },
    onError: () => toast.error(t('userDetailPage.profileSaveFailed')),
  })

  const pointsMutation = useMutation({
    mutationFn: (delta: number) => api.post(`/admin/users/${telegramId}/points`, { delta }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey })
      setPoints(res.data.points?.toString())
      toast.success(t('userDetailPage.pointsUpdated'))
    },
  })

  const handleSave = () => {
    saveMutation.mutate({
      role,
      personalDiscount: parseInt(personalDiscount, 10),
      purchaseDiscount: parseInt(purchaseDiscount, 10),
      maxSubscriptions: maxSubs === '__default__' ? null : parseInt(maxSubs, 10),
      partnerBalanceCurrencyOverride: currencyOverride === '__default__' ? null : currencyOverride,
    })
  }

  return (
    <Card className="lg:col-span-3">
      <CardHeader>
        <CardTitle className="text-base">{t('userDetailPage.quickActions.title')}</CardTitle>
        <CardDescription>{t('userDetailPage.quickActions.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('userDetailPage.quickActions.role')}</Label>
            <Select
              value={role}
              onValueChange={(v) => {
                setRole(v)
                setDirty(true)
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="USER">USER</SelectItem>
                <SelectItem value="ADMIN">ADMIN</SelectItem>
                <SelectItem value="DEV">DEV</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('userDetailPage.quickActions.maxSubscriptions')}</Label>
            <Select
              value={maxSubs}
              onValueChange={(v) => {
                setMaxSubs(v)
                setDirty(true)
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder={t('userDetailPage.quickActions.globalDefault')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">
                  {t('userDetailPage.quickActions.globalDefault')}
                </SelectItem>
                <SelectItem value="1">1</SelectItem>
                <SelectItem value="2">2</SelectItem>
                <SelectItem value="3">3</SelectItem>
                <SelectItem value="5">5</SelectItem>
                <SelectItem value="10">10</SelectItem>
                <SelectItem value="-1">{t('userDetailPage.quickActions.unlimited')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('userDetailPage.quickActions.personalDiscount')}</Label>
            <Input
              type="number"
              className="h-9"
              min="0"
              max="100"
              value={personalDiscount}
              onChange={(e) => {
                setPersonalDiscount(e.target.value)
                setDirty(true)
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('userDetailPage.quickActions.purchaseDiscount')}</Label>
            <Input
              type="number"
              className="h-9"
              min="0"
              max="100"
              value={purchaseDiscount}
              onChange={(e) => {
                setPurchaseDiscount(e.target.value)
                setDirty(true)
              }}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label className="text-xs">{t('userDetailPage.quickActions.currencyOverride')}</Label>
            <Select
              value={currencyOverride}
              onValueChange={(v) => {
                setCurrencyOverride(v)
                setDirty(true)
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder={t('userDetailPage.quickActions.currencyDefault')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">
                  {t('userDetailPage.quickActions.defaultLabel')}
                </SelectItem>
                <SelectItem value="RUB">RUB</SelectItem>
                <SelectItem value="USD">USD</SelectItem>
                <SelectItem value="USDT">USDT</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Points */}
        <div className="space-y-1.5">
          <Label className="text-xs">{t('userDetailPage.quickActions.points')}</Label>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => pointsMutation.mutate(-10)}>
              <Minus className="h-3 w-3 mr-1" />10
            </Button>
            <Button size="sm" variant="outline" onClick={() => pointsMutation.mutate(-50)}>
              −50
            </Button>
            <span className="font-mono font-bold text-lg px-3">{points}</span>
            <Button size="sm" variant="outline" onClick={() => pointsMutation.mutate(50)}>
              +50
            </Button>
            <Button size="sm" variant="outline" onClick={() => pointsMutation.mutate(10)}>
              <Plus className="h-3 w-3 mr-1" />10
            </Button>
          </div>
        </div>

        {dirty && (
          <Button onClick={handleSave} disabled={saveMutation.isPending} className="w-full">
            {saveMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            {t('userDetailPage.quickActions.saveChanges')}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

// ── Block Button ─────────────────────────────────────────────────────────────

function BlockButton({
  telegramId,
  isBlocked,
  queryKey,
}: {
  telegramId: string
  isBlocked: boolean
  queryKey: string[]
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => api.post(`/admin/users/${telegramId}/${isBlocked ? 'unblock' : 'block'}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(
        isBlocked ? t('userDetailPage.unblocked') : t('userDetailPage.blocked'),
      )
    },
  })

  if (isBlocked) {
    return (
      <Button variant="outline" onClick={() => mutation.mutate()}>
        <UserCheck className="h-4 w-4 mr-2" /> {t('userDetailPage.header.unblock')}
      </Button>
    )
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive">
          <UserX className="h-4 w-4 mr-2" /> {t('userDetailPage.header.block')}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('userDetailPage.header.blockTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('userDetailPage.header.blockDescription')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('userDetailPage.header.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={() => mutation.mutate()}>
            {t('userDetailPage.header.blockConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ── Subscriptions Tab ────────────────────────────────────────────────────────

function SubscriptionsTab({
  user,
  queryKey,
  locale,
}: {
  user: any
  queryKey: string[]
  locale: string
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [showGiveSub, setShowGiveSub] = useState(false)
  const [showDevices, setShowDevices] = useState<number | null>(null)

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) =>
      api.patch(`/admin/users/subscriptions/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPage.subscriptionUpdated'))
    },
    onError: (err: any) =>
      toast.error(err.response?.data?.message ?? t('userDetailPage.subscriptionUpdateFailed')),
  })

  const syncMutation = useMutation({
    mutationFn: (id: number) => api.post(`/admin/users/subscriptions/${id}/sync`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPage.subscriptionSynced'))
    },
    onError: (err: any) =>
      toast.error(err.response?.data?.message ?? t('userDetailPage.subscriptionSyncFailed')),
  })

  const resetTrafficMutation = useMutation({
    mutationFn: (id: number) => api.post(`/admin/users/subscriptions/${id}/reset-traffic`),
    onSuccess: () => toast.success(t('userDetailPage.trafficReset')),
    onError: (err: any) =>
      toast.error(err.response?.data?.message ?? t('userDetailPage.trafficResetFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/users/subscriptions/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPage.subscriptionDeleted'))
    },
  })

  const grantTrialMutation = useMutation({
    mutationFn: () => api.post(`/admin/users/${user.telegramId?.toString()}/grant-trial`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPage.trialGranted'))
    },
    onError: (err: any) =>
      toast.error(err.response?.data?.message ?? t('userDetailPage.trialGrantFailed')),
  })

  const subs = user.subscriptions ?? []
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US'

  return (
    <div className="space-y-4 mt-4">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setShowGiveSub(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> {t('userDetailPage.subscriptions.giveSubscription')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => grantTrialMutation.mutate()}
          disabled={grantTrialMutation.isPending}
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1" />{' '}
          {t('userDetailPage.subscriptions.grantTrial')}
        </Button>
      </div>

      {subs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {t('userDetailPage.subscriptions.noSubscriptions')}
          </CardContent>
        </Card>
      ) : (
        subs.map((sub: any) => (
          <Card key={sub.id}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-wrap">
                  <CardTitle className="text-base">
                    {(sub.plan as any)?.name ?? `Sub #${sub.id}`}
                  </CardTitle>
                  <Badge
                    variant={
                      sub.status === 'ACTIVE'
                        ? 'default'
                        : sub.status === 'EXPIRED'
                          ? 'destructive'
                          : 'secondary'
                    }
                  >
                    {sub.status}
                  </Badge>
                  {sub.isTrial && (
                    <Badge variant="outline">{t('userDetailPage.subscriptions.trialBadge')}</Badge>
                  )}
                  {user.currentSubscriptionId === sub.id && (
                    <Badge variant="outline" className="text-emerald-600">
                      {t('userDetailPage.subscriptions.currentBadge')}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {sub.status === 'ACTIVE' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => updateMutation.mutate({ id: sub.id, data: { status: 'DISABLED' } })}
                      title={t('userDetailPage.subscriptions.disable')}
                      aria-label={t('userDetailPage.subscriptions.disable')}
                    >
                      <PowerOff className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  )}
                  {sub.status === 'DISABLED' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => updateMutation.mutate({ id: sub.id, data: { status: 'ACTIVE' } })}
                      title={t('userDetailPage.subscriptions.enable')}
                      aria-label={t('userDetailPage.subscriptions.enable')}
                    >
                      <Power className="h-3.5 w-3.5 text-emerald-600" />
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => syncMutation.mutate(sub.id)}
                    title={t('userDetailPage.subscriptions.sync')}
                    aria-label={t('userDetailPage.subscriptions.sync')}
                    disabled={syncMutation.isPending}
                  >
                    <RefreshCw className="h-3.5 w-3.5 text-blue-500" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowDevices(showDevices === sub.id ? null : sub.id)}
                    title={t('userDetailPage.subscriptions.devices')}
                    aria-label={t('userDetailPage.subscriptions.devices')}
                  >
                    <Smartphone className="h-3.5 w-3.5" />
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('userDetailPage.subscriptions.delete')}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {t('userDetailPage.subscriptions.deleteTitle')}
                        </AlertDialogTitle>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>
                          {t('userDetailPage.subscriptions.cancel')}
                        </AlertDialogCancel>
                        <AlertDialogAction onClick={() => deleteMutation.mutate(sub.id)}>
                          {t('userDetailPage.subscriptions.deleteConfirm')}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 md:grid-cols-4 text-sm mb-3">
                <div>
                  <span className="text-muted-foreground">
                    {t('userDetailPage.subscriptions.labels.traffic')}
                  </span>{' '}
                  <span className="font-medium">
                    {sub.trafficLimit ? `${sub.trafficLimit} GB` : '∞'}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">
                    {t('userDetailPage.subscriptions.labels.devices')}
                  </span>{' '}
                  <span className="font-medium">{sub.deviceLimit || '∞'}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">
                    {t('userDetailPage.subscriptions.labels.expires')}
                  </span>{' '}
                  <span className="font-medium">
                    {new Date(sub.expireAt).toLocaleDateString(dateLocale)}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">
                    {t('userDetailPage.subscriptions.labels.remnaId')}
                  </span>{' '}
                  <span className="font-mono text-xs">{sub.userRemnaId?.slice(0, 8)}…</span>
                </div>
              </div>

              {/* Inline actions */}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => updateMutation.mutate({ id: sub.id, data: { expireDays: 7 } })}
                >
                  <Clock className="h-3 w-3 mr-1" />
                  {t('userDetailPage.subscriptions.quickActions.addDays', { count: 7 })}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => updateMutation.mutate({ id: sub.id, data: { expireDays: 30 } })}
                >
                  {t('userDetailPage.subscriptions.quickActions.addDays', { count: 30 })}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => updateMutation.mutate({ id: sub.id, data: { expireDays: -7 } })}
                >
                  {t('userDetailPage.subscriptions.quickActions.subDays', { count: 7 })}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => updateMutation.mutate({ id: sub.id, data: { trafficLimit: 50 } })}
                >
                  <HardDrive className="h-3 w-3 mr-1" />
                  {t('userDetailPage.subscriptions.quickActions.setTraffic', { value: 50 })}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => updateMutation.mutate({ id: sub.id, data: { trafficLimit: 100 } })}
                >
                  {t('userDetailPage.subscriptions.quickActions.setTraffic', { value: 100 })}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => updateMutation.mutate({ id: sub.id, data: { deviceLimit: 3 } })}
                >
                  <Smartphone className="h-3 w-3 mr-1" />
                  {t('userDetailPage.subscriptions.quickActions.setDevices', { count: 3 })}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => updateMutation.mutate({ id: sub.id, data: { deviceLimit: 5 } })}
                >
                  {t('userDetailPage.subscriptions.quickActions.setDevices', { count: 5 })}
                </Button>
                <Separator orientation="vertical" className="h-6" />
                <Button
                  size="sm"
                  variant="outline"
                  className="text-amber-600"
                  onClick={() => resetTrafficMutation.mutate(sub.id)}
                  disabled={resetTrafficMutation.isPending}
                >
                  <RefreshCw className="h-3 w-3 mr-1" />
                  {t('userDetailPage.subscriptions.quickActions.resetTraffic')}
                </Button>
              </div>

              {/* Devices panel */}
              {showDevices === sub.id && <DevicesPanel subscriptionId={sub.id} />}
            </CardContent>
          </Card>
        ))
      )}

      {/* Give Subscription Dialog */}
      <Dialog open={showGiveSub} onOpenChange={setShowGiveSub}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('userDetailPage.giveSubDialog.title')}</DialogTitle>
          </DialogHeader>
          <GiveSubscriptionForm
            telegramId={user.telegramId?.toString()}
            queryKey={queryKey}
            onClose={() => setShowGiveSub(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Devices Panel ─────────────────────────────────────────────────────────────

function DevicesPanel({ subscriptionId }: { subscriptionId: number }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'subscriptions', subscriptionId, 'devices'],
    queryFn: async () =>
      (await api.get(`/admin/users/subscriptions/${subscriptionId}/devices`)).data,
  })

  const revokeMutation = useMutation({
    mutationFn: (hwid: string) =>
      api.delete(`/admin/users/subscriptions/${subscriptionId}/devices/${hwid}`),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['admin', 'subscriptions', subscriptionId, 'devices'],
      })
      toast.success(t('userDetailPage.deviceRevoked'))
    },
    onError: (err: any) =>
      toast.error(err.response?.data?.message ?? t('userDetailPage.deviceRevokeFailed')),
  })

  if (isLoading) {
    return (
      <div className="mt-3 text-xs text-muted-foreground">
        {t('userDetailPage.devicesPanel.loading')}
      </div>
    )
  }

  const devices = data?.devices ?? []

  return (
    <div className="mt-3 border rounded-lg p-3 space-y-2">
      <p className="text-xs font-semibold text-muted-foreground">
        {t('userDetailPage.devicesPanel.title', { count: data?.deviceCount ?? 0 })}
      </p>
      {!devices.length ? (
        <p className="text-xs text-muted-foreground">
          {t('userDetailPage.devicesPanel.empty')}
        </p>
      ) : (
        devices.map((d: any) => (
          <div key={d.hwid} className="flex items-center justify-between text-xs">
            <div>
              <span className="font-mono">{d.hwid.slice(0, 12)}…</span>
              <span className="text-muted-foreground ml-2">
                {d.platform ?? '?'} {d.osVersion ?? ''}
              </span>
              {d.deviceName && (
                <span className="text-muted-foreground ml-1">({d.deviceName})</span>
              )}
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-destructive"
              onClick={() => revokeMutation.mutate(d.hwid)}
              aria-label={t('userDetailPage.subscriptions.delete')}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        ))
      )}
    </div>
  )
}

// ── Give Subscription Form ────────────────────────────────────────────────────

function GiveSubscriptionForm({
  telegramId,
  queryKey,
  onClose,
}: {
  telegramId: string
  queryKey: string[]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [planId, setPlanId] = useState('')
  const [durationDays, setDurationDays] = useState('30')
  const [isTrial, setIsTrial] = useState(false)

  const { data: plans } = useQuery({
    queryKey: ['admin', 'plans'],
    queryFn: async () => (await api.get('/admin/plans')).data as any[],
  })

  const selectedPlan = plans?.find((p: any) => String(p.id) === planId)

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/admin/users/${telegramId}/give-subscription`, {
        planId,
        durationDays: parseInt(durationDays),
        isTrial,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPage.subscriptionGiven'))
      onClose()
    },
    onError: (err: any) =>
      toast.error(err.response?.data?.message ?? t('userDetailPage.subscriptionGiveFailed')),
  })

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>{t('userDetailPage.giveSubDialog.plan')}</Label>
        <Select value={planId} onValueChange={setPlanId}>
          <SelectTrigger>
            <SelectValue placeholder={t('userDetailPage.giveSubDialog.planPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {plans
              ?.filter((p: any) => !p.isArchived)
              .map((p: any) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>

      {selectedPlan && (
        <div className="space-y-1.5">
          <Label>{t('userDetailPage.giveSubDialog.duration')}</Label>
          <Select value={durationDays} onValueChange={setDurationDays}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {selectedPlan.durations?.map((d: any) => (
                <SelectItem key={d.id} value={String(d.days)}>
                  {t('userDetailPage.giveSubDialog.durationDays', { count: d.days })}
                </SelectItem>
              ))}
              {[7, 30, 90, 365].map((days) => (
                <SelectItem key={`custom-${days}`} value={String(days)}>
                  {t('userDetailPage.giveSubDialog.durationDays', { count: days })}{' '}
                  {t('userDetailPage.giveSubDialog.customSuffix')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Switch checked={isTrial} onCheckedChange={setIsTrial} id="is-trial" />
        <Label htmlFor="is-trial">{t('userDetailPage.giveSubDialog.markTrial')}</Label>
      </div>

      <div className="flex gap-3 justify-end">
        <Button variant="outline" onClick={onClose}>
          {t('userDetailPage.giveSubDialog.cancel')}
        </Button>
        <Button
          onClick={() => mutation.mutate()}
          disabled={!planId || mutation.isPending}
        >
          {mutation.isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Plus className="h-4 w-4 mr-2" />
          )}
          {t('userDetailPage.giveSubDialog.submit')}
        </Button>
      </div>
    </div>
  )
}

// ── Transactions Tab ─────────────────────────────────────────────────────────

function TransactionsTab({ user, locale }: { user: any; locale: string }) {
  const { t } = useTranslation()
  const txs = user.transactions ?? []
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US'

  if (!txs.length) {
    return (
      <Card className="mt-4">
        <CardContent className="py-12 text-center text-muted-foreground">
          {t('userDetailPage.transactions.empty')}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="mt-4">
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('userDetailPage.transactions.columns.paymentId')}</TableHead>
              <TableHead>{t('userDetailPage.transactions.columns.status')}</TableHead>
              <TableHead>{t('userDetailPage.transactions.columns.amount')}</TableHead>
              <TableHead>{t('userDetailPage.transactions.columns.gateway')}</TableHead>
              <TableHead>{t('userDetailPage.transactions.columns.type')}</TableHead>
              <TableHead>{t('userDetailPage.transactions.columns.date')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {txs.map((tx: any) => (
              <TableRow key={tx.id}>
                <TableCell className="font-mono text-xs">{tx.paymentId?.slice(0, 8)}…</TableCell>
                <TableCell>
                  <Badge variant={tx.status === 'COMPLETED' ? 'default' : 'secondary'}>
                    {tx.status}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono">
                  {tx.amount} {tx.currency}
                </TableCell>
                <TableCell className="text-xs uppercase">{tx.gatewayType}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs">
                    {tx.purchaseType}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">
                  {new Date(tx.createdAt).toLocaleDateString(dateLocale)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

// ── Referrals Tab ────────────────────────────────────────────────────────────

function ReferralsTab({ user }: { user: any }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('userDetailPage.referrals.referredByTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {user.referral ? (
            <div className="text-sm">
              <span className="text-muted-foreground">
                {t('userDetailPage.referrals.referrerLabel')}{' '}
              </span>
              <span className="font-medium">
                {user.referral.referrer?.name ??
                  user.referral.referrer?.username ??
                  user.referral.referrerTelegramId?.toString()}
              </span>
              <span className="text-muted-foreground ml-2">
                {t('userDetailPage.referrals.levelLabel')} {user.referral.level} •{' '}
                {t('userDetailPage.referrals.sourceLabel')} {user.referral.inviteSource}
              </span>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('userDetailPage.referrals.noReferrer')}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('userDetailPage.referrals.referralsGivenTitle', {
              count: user.referralsGiven?.length ?? 0,
            })}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {user.referralsGiven?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('userDetailPage.referrals.columns.user')}</TableHead>
                  <TableHead>{t('userDetailPage.referrals.columns.level')}</TableHead>
                  <TableHead>{t('userDetailPage.referrals.columns.source')}</TableHead>
                  <TableHead>{t('userDetailPage.referrals.columns.qualified')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {user.referralsGiven.map((r: any) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-sm">
                      {r.referred?.name ?? r.referredTelegramId?.toString()}
                    </TableCell>
                    <TableCell>{r.level}</TableCell>
                    <TableCell className="text-xs">{r.inviteSource}</TableCell>
                    <TableCell className="text-xs">
                      {r.qualifiedAt
                        ? t('userDetailPage.referrals.qualifiedYes')
                        : t('userDetailPage.referrals.qualifiedNo')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="py-8 text-center text-muted-foreground">
              {t('userDetailPage.referrals.empty')}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ── Send Notification Button ─────────────────────────────────────────────────

function SendNotificationButton({ telegramId }: { telegramId: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')

  const mutation = useMutation({
    mutationFn: () => api.post(`/admin/users/${telegramId}/notify`, { message }),
    onSuccess: () => {
      toast.success(t('userDetailPage.notificationSent'))
      setOpen(false)
      setMessage('')
    },
    onError: () => toast.error(t('userDetailPage.notificationSendFailed')),
  })

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Send className="h-4 w-4 mr-2" /> {t('userDetailPage.header.notify')}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('userDetailPage.notifyDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('userDetailPage.notifyDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <textarea
            className="w-full h-24 border rounded-md p-3 text-sm"
            placeholder={t('userDetailPage.notifyDialog.placeholder')}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>{t('userDetailPage.notifyDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => mutation.mutate()} disabled={!message.trim()}>
              {t('userDetailPage.notifyDialog.send')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// ── Partner Tab ──────────────────────────────────────────────────────────────

function PartnerTab({ user }: { user: any }) {
  const { t } = useTranslation()

  if (!user.partner) {
    return (
      <Card className="mt-4">
        <CardContent className="py-12 text-center text-muted-foreground">
          {t('userDetailPage.partner.notPartner')}
        </CardContent>
      </Card>
    )
  }

  const p = user.partner
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="text-base">{t('userDetailPage.partner.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 md:grid-cols-3 text-sm">
          <div>
            <span className="text-muted-foreground">
              {t('userDetailPage.partner.balance')}
            </span>{' '}
            <span className="font-mono font-bold">{(p.balance / 100).toFixed(2)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">
              {t('userDetailPage.partner.totalEarned')}
            </span>{' '}
            <span className="font-mono">{(p.totalEarned / 100).toFixed(2)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">
              {t('userDetailPage.partner.totalWithdrawn')}
            </span>{' '}
            <span className="font-mono">{(p.totalWithdrawn / 100).toFixed(2)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">
              {t('userDetailPage.partner.referralsLevel1')}
            </span>{' '}
            <span>{p.referralsCount}</span>
          </div>
          <div>
            <span className="text-muted-foreground">
              {t('userDetailPage.partner.referralsLevel2')}
            </span>{' '}
            <span>{p.level2ReferralsCount}</span>
          </div>
          <div>
            <span className="text-muted-foreground">
              {t('userDetailPage.partner.referralsLevel3')}
            </span>{' '}
            <span>{p.level3ReferralsCount}</span>
          </div>
          <div>
            <span className="text-muted-foreground">
              {t('userDetailPage.partner.status')}
            </span>{' '}
            <Badge variant={p.isActive ? 'default' : 'secondary'}>
              {p.isActive
                ? t('userDetailPage.partner.active')
                : t('userDetailPage.partner.inactive')}
            </Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
