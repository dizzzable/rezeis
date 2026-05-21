/* eslint-disable @typescript-eslint/no-explicit-any -- TODO: type API responses */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Handshake, DollarSign, Settings2, TrendingUp, Loader2, Settings } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { FadeIn } from '@/lib/motion'
import PartnerSettingsPage from '@/features/settings/partner-settings-page'
import WithdrawalsPage from '@/features/partners/withdrawals-page'

const ALLOWED_TABS = ['partners', 'withdrawals', 'settings'] as const
type PartnersTab = (typeof ALLOWED_TABS)[number]

export default function PartnersPage() {
  const { t } = useTranslation()
  const { hash: locationHash, pathname: locationPathname } = useLocation()
  const navigate = useNavigate()

  const initialTab: PartnersTab = (() => {
    const hash = locationHash.replace('#', '')
    return (ALLOWED_TABS as readonly string[]).includes(hash) ? (hash as PartnersTab) : 'partners'
  })()

  const [activeTab, setActiveTab] = useState<PartnersTab>(initialTab)

  // Keep tab in sync with hash changes (deep links, browser back/forward).
  useEffect(() => {
    const hash = locationHash.replace('#', '')
    if ((ALLOWED_TABS as readonly string[]).includes(hash) && hash !== activeTab) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- TODO: refactor to derive state
      setActiveTab(hash as PartnersTab)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationHash])

  function handleTabChange(value: string): void {
    if (!(ALLOWED_TABS as readonly string[]).includes(value)) {
      return
    }
    setActiveTab(value as PartnersTab)
    navigate(`${locationPathname}#${value}`, { replace: true })
  }

  const { data: stats } = useQuery({
    queryKey: ['admin', 'partners', 'stats'],
    queryFn: async () => (await api.get('/admin/partners/stats')).data as { total?: number; totalPartners?: number; active?: number; activePartners?: number; pendingWithdrawals: number },
  })

  const totalPartners = stats?.total ?? stats?.totalPartners ?? 0
  const activePartners = stats?.active ?? stats?.activePartners ?? 0
  const pendingWithdrawals = stats?.pendingWithdrawals ?? 0

  return (
    <div className="space-y-6">
      <FadeIn>
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Handshake className="h-6 w-6" /> {t('partnersPage.title')}
          </h1>
          <p className="text-muted-foreground">{t('partnersPage.subtitle')}</p>
        </div>
      </FadeIn>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: t('partnersPage.stats.total'), value: totalPartners, icon: Handshake },
          { label: t('partnersPage.stats.active'), value: activePartners, icon: TrendingUp },
          { label: t('partnersPage.stats.pendingWithdrawals'), value: pendingWithdrawals, icon: DollarSign },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <s.icon className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-2xl font-bold tabular-nums">{s.value}</p>
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="partners">{t('partnersPage.tabs.partners')}</TabsTrigger>
          <TabsTrigger value="withdrawals">{t('partnersPage.tabs.withdrawals')}</TabsTrigger>
          <TabsTrigger value="settings">
            <Settings className="h-3.5 w-3.5 mr-1.5" />
            {t('partnersPage.tabs.settings')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="partners"><PartnersTab /></TabsContent>
        <TabsContent value="withdrawals" className="pt-4"><WithdrawalsPage embedded /></TabsContent>
        <TabsContent value="settings" className="pt-4">
          <PartnerSettingsPage />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ── Partners Tab ──────────────────────────────────────────────────────────────

function PartnersTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [selectedPartner, setSelectedPartner] = useState<any | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'partners'],
    queryFn: async () => {
      const raw = (await api.get('/admin/partners?limit=50')).data as
        | unknown[]
        | { items?: unknown[] }
      return Array.isArray(raw) ? raw : (raw?.items ?? [])
    },
  })

  const toggleMutation = useMutation({
    mutationFn: (id: number) => api.post(`/admin/partners/${id}/toggle-active`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'partners'] }); toast.success(t('partnersDetail.toasts.statusUpdated')) },
  })

  if (isLoading) return <div className="space-y-3 mt-4">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>

  return (
    <div className="mt-4">
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('partnersDetail.columns.partner')}</TableHead>
                <TableHead>{t('partnersDetail.columns.balance')}</TableHead>
                <TableHead>{t('partnersDetail.columns.earned')}</TableHead>
                <TableHead>{t('partnersDetail.columns.referrals')}</TableHead>
                <TableHead>{t('partnersDetail.columns.status')}</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.map((p: any) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <div>
                      <p className="font-medium text-sm">{p.user?.name ?? '—'}</p>
                      <p className="text-xs text-muted-foreground">@{p.user?.username ?? p.user?.telegramId}</p>
                    </div>
                  </TableCell>
                  <TableCell className="tabular-nums font-mono text-sm">
                    {(p.balance / 100).toFixed(2)} ₽
                  </TableCell>
                  <TableCell className="tabular-nums font-mono text-sm text-emerald-600">
                    {(p.totalEarned / 100).toFixed(2)} ₽
                  </TableCell>
                  <TableCell className="tabular-nums text-sm">
                    {p.referralsCount} / {p.level2ReferralsCount} / {p.level3ReferralsCount}
                  </TableCell>
                  <TableCell>
                    <Switch checked={p.isActive} onCheckedChange={() => toggleMutation.mutate(p.id)} />
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" className="h-7 text-xs"
                      onClick={() => { setSelectedPartner(p); setShowSettings(true) }}>
                      <Settings2 className="h-3.5 w-3.5 mr-1" /> {t('partnersDetail.manage')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Partner settings dialog */}
      <Dialog open={showSettings} onOpenChange={setShowSettings}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{t('partnersDetail.dialogTitle', { name: selectedPartner?.user?.name ?? '' })}</DialogTitle></DialogHeader>
          {selectedPartner && <PartnerSettingsForm partner={selectedPartner} onClose={() => setShowSettings(false)} />}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Partner Settings Form ─────────────────────────────────────────────────────

function PartnerSettingsForm({ partner, onClose: _onClose }: { partner: any; onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [adjustAmount, setAdjustAmount] = useState('')
  const [adjustReason, setAdjustReason] = useState('')
  const [level1Percent, setLevel1Percent] = useState(String((partner.individualSettings as any)?.level1Percent ?? ''))
  const [level2Percent, setLevel2Percent] = useState(String((partner.individualSettings as any)?.level2Percent ?? ''))
  const [level3Percent, setLevel3Percent] = useState(String((partner.individualSettings as any)?.level3Percent ?? ''))

  const adjustMutation = useMutation({
    mutationFn: () => api.post(`/admin/partners/${partner.id}/balance-adjust`, {
      amount: Math.round(parseFloat(adjustAmount) * 100), // to kopecks
      reason: adjustReason,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'partners'] })
      toast.success(t('partnersDetail.toasts.balanceAdjusted'))
      setAdjustAmount('')
      setAdjustReason('')
    },
    onError: (err: any) => toast.error(err.response?.data?.message ?? t('partnersDetail.toasts.balanceFailed')),
  })

  const settingsMutation = useMutation({
    mutationFn: () => api.patch(`/admin/partners/${partner.id}/individual-settings`, {
      level1Percent: level1Percent ? parseFloat(level1Percent) : undefined,
      level2Percent: level2Percent ? parseFloat(level2Percent) : undefined,
      level3Percent: level3Percent ? parseFloat(level3Percent) : undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'partners'] })
      toast.success(t('partnersDetail.toasts.settingsSaved'))
    },
    onError: (err: any) => toast.error(err.response?.data?.message ?? t('partnersDetail.toasts.settingsFailed')),
  })

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="bg-muted/40 rounded-lg p-3">
          <p className="text-muted-foreground text-xs">{t('partnersDetail.settings.currentBalance')}</p>
          <p className="text-xl font-bold tabular-nums">{(partner.balance / 100).toFixed(2)} ₽</p>
        </div>
        <div className="bg-muted/40 rounded-lg p-3">
          <p className="text-muted-foreground text-xs">{t('partnersDetail.settings.totalEarned')}</p>
          <p className="text-xl font-bold tabular-nums text-emerald-600">{(partner.totalEarned / 100).toFixed(2)} ₽</p>
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-sm font-semibold">{t('partnersDetail.settings.adjustment')}</p>
        <div className="flex gap-2">
          <Input
            type="number" step="0.01" placeholder={t('partnersDetail.settings.amountPlaceholder')}
            value={adjustAmount} onChange={(e) => setAdjustAmount(e.target.value)}
            className="flex-1 h-9"
          />
          <Input
            placeholder={t('partnersDetail.settings.reasonPlaceholder')}
            value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)}
            className="flex-1 h-9"
          />
        </div>
        <Button size="sm" onClick={() => adjustMutation.mutate()} disabled={!adjustAmount || adjustMutation.isPending}>
          {adjustMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <DollarSign className="h-4 w-4 mr-2" />}
          {t('partnersDetail.settings.apply')}
        </Button>
      </div>

      <Separator />

      <div className="space-y-3">
        <p className="text-sm font-semibold">{t('partnersDetail.settings.individualRates')}</p>
        <p className="text-xs text-muted-foreground">{t('partnersDetail.settings.ratesHint')}</p>
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: t('partnersDetail.settings.level1'), value: level1Percent, set: setLevel1Percent },
            { label: t('partnersDetail.settings.level2'), value: level2Percent, set: setLevel2Percent },
            { label: t('partnersDetail.settings.level3'), value: level3Percent, set: setLevel3Percent },
          ].map((f) => (
            <div key={f.label} className="space-y-1">
              <Label className="text-xs">{f.label}</Label>
              <Input
                type="number" min="0" max="100" step="0.1" placeholder={t('partnersDetail.settings.globalPlaceholder')}
                value={f.value} onChange={(e) => f.set(e.target.value)}
                className="h-9"
              />
            </div>
          ))}
        </div>
        <Button size="sm" onClick={() => settingsMutation.mutate()} disabled={settingsMutation.isPending}>
          {settingsMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Settings2 className="h-4 w-4 mr-2" />}
          {t('partnersDetail.settings.saveSettings')}
        </Button>
      </div>
    </div>
  )
}

// ── Withdrawals Tab ───────────────────────────────────────────────────────────
// Renders the full `WithdrawalsPage` in embedded mode — same backend, same
// stats / filter / requisites / reject-with-reason flow. The standalone
// `/withdrawals` route is kept as a redirect to `/partners#withdrawals` for
// deep-link compatibility.
