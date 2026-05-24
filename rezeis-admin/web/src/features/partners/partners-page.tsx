import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Handshake, DollarSign, Settings2, TrendingUp, Loader2, Settings } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/http-errors'
import { useTabSync } from '@/lib/use-tab-sync'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { FadeIn } from '@/lib/motion'
import PartnerSettingsPage from '@/features/settings/partner-settings-page'
import WithdrawalsPage from '@/features/partners/withdrawals-page'

const ALLOWED_TABS = ['partners', 'withdrawals', 'settings'] as const
type PartnersTab = (typeof ALLOWED_TABS)[number]

export default function PartnersPage() {
  const { t } = useTranslation()
  const { activeTab, setTab: handleTabChange } = useTabSync<PartnersTab>(ALLOWED_TABS, 'partners')

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

interface PartnerUserSummary {
  readonly name?: string | null
  readonly username?: string | null
  readonly telegramId?: string | number | bigint | null
}

interface PartnerIndividualSettings {
  readonly level1Percent?: number | string | null
  readonly level2Percent?: number | string | null
  readonly level3Percent?: number | string | null
}

interface PartnerRow {
  readonly id: number
  readonly user?: PartnerUserSummary | null
  readonly balance: number
  readonly totalEarned: number
  readonly referralsCount: number
  readonly level2ReferralsCount: number
  readonly level3ReferralsCount: number
  readonly isActive: boolean
  readonly individualSettings?: PartnerIndividualSettings | null
}

function PartnersTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [selectedPartner, setSelectedPartner] = useState<PartnerRow | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  const { data, isLoading } = useQuery<ReadonlyArray<PartnerRow>>({
    queryKey: ['admin', 'partners'],
    queryFn: async () => {
      const raw = (await api.get('/admin/partners?limit=50')).data as
        | ReadonlyArray<PartnerRow>
        | { items?: ReadonlyArray<PartnerRow> }
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
              {data?.map((p) => (
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

function PartnerSettingsForm({ partner, onClose: _onClose }: { partner: PartnerRow; onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  // ── Balance adjustment subform ──────────────────────────────────────
  const adjustSchema = z.object({
    amount: z
      .string()
      .trim()
      .min(1, t('partnersDetail.settings.validation.amountRequired'))
      .refine((v) => Number.isFinite(Number(v)), {
        message: t('partnersDetail.settings.validation.amountInvalid'),
      }),
    reason: z.string().trim(),
  })
  type AdjustValues = z.infer<typeof adjustSchema>
  const adjustForm = useForm<AdjustValues>({
    resolver: zodResolver(adjustSchema),
    defaultValues: { amount: '', reason: '' },
  })

  const adjustMutation = useMutation({
    mutationFn: (values: AdjustValues) =>
      api.post(`/admin/partners/${partner.id}/balance-adjust`, {
        amount: Math.round(Number(values.amount) * 100), // to kopecks
        reason: values.reason || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'partners'] })
      toast.success(t('partnersDetail.toasts.balanceAdjusted'))
      adjustForm.reset({ amount: '', reason: '' })
    },
    onError: (err) => toast.error(getErrorMessage(err, t('partnersDetail.toasts.balanceFailed'))),
  })

  // ── Individual rates subform ────────────────────────────────────────
  const percentField = z
    .string()
    .trim()
    .refine(
      (v) => {
        if (v === '') return true
        const n = Number(v)
        return Number.isFinite(n) && n >= 0 && n <= 100
      },
      { message: t('partnersDetail.settings.validation.percentRange') },
    )

  const ratesSchema = z.object({
    level1Percent: percentField,
    level2Percent: percentField,
    level3Percent: percentField,
  })
  type RatesValues = z.infer<typeof ratesSchema>
  const ratesForm = useForm<RatesValues>({
    resolver: zodResolver(ratesSchema),
    defaultValues: {
      level1Percent: String(partner.individualSettings?.level1Percent ?? ''),
      level2Percent: String(partner.individualSettings?.level2Percent ?? ''),
      level3Percent: String(partner.individualSettings?.level3Percent ?? ''),
    },
  })

  const settingsMutation = useMutation({
    mutationFn: (values: RatesValues) =>
      api.patch(`/admin/partners/${partner.id}/individual-settings`, {
        level1Percent: values.level1Percent ? Number(values.level1Percent) : undefined,
        level2Percent: values.level2Percent ? Number(values.level2Percent) : undefined,
        level3Percent: values.level3Percent ? Number(values.level3Percent) : undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'partners'] })
      toast.success(t('partnersDetail.toasts.settingsSaved'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('partnersDetail.toasts.settingsFailed'))),
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

      <Form {...adjustForm}>
        <form
          onSubmit={adjustForm.handleSubmit((values) => adjustMutation.mutate(values))}
          className="space-y-3"
        >
          <p className="text-sm font-semibold">{t('partnersDetail.settings.adjustment')}</p>
          <div className="flex gap-2">
            <FormField
              control={adjustForm.control}
              name="amount"
              render={({ field }) => (
                <FormItem className="flex-1">
                  <FormControl>
                    <Input
                      type="number"
                      step="0.01"
                      placeholder={t('partnersDetail.settings.amountPlaceholder')}
                      className="h-9"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={adjustForm.control}
              name="reason"
              render={({ field }) => (
                <FormItem className="flex-1">
                  <FormControl>
                    <Input
                      placeholder={t('partnersDetail.settings.reasonPlaceholder')}
                      className="h-9"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <Button type="submit" size="sm" disabled={adjustMutation.isPending}>
            {adjustMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <DollarSign className="h-4 w-4 mr-2" />}
            {t('partnersDetail.settings.apply')}
          </Button>
        </form>
      </Form>

      <Separator />

      <Form {...ratesForm}>
        <form
          onSubmit={ratesForm.handleSubmit((values) => settingsMutation.mutate(values))}
          className="space-y-3"
        >
          <p className="text-sm font-semibold">{t('partnersDetail.settings.individualRates')}</p>
          <p className="text-xs text-muted-foreground">{t('partnersDetail.settings.ratesHint')}</p>
          <div className="grid grid-cols-3 gap-3">
            {(['level1Percent', 'level2Percent', 'level3Percent'] as const).map((name, idx) => (
              <FormField
                key={name}
                control={ratesForm.control}
                name={name}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">
                      {t(`partnersDetail.settings.level${idx + 1}` as 'partnersDetail.settings.level1')}
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        step="0.1"
                        placeholder={t('partnersDetail.settings.globalPlaceholder')}
                        className="h-9"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
          </div>
          <Button type="submit" size="sm" disabled={settingsMutation.isPending}>
            {settingsMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Settings2 className="h-4 w-4 mr-2" />}
            {t('partnersDetail.settings.saveSettings')}
          </Button>
        </form>
      </Form>
    </div>
  )
}

// ── Withdrawals Tab ───────────────────────────────────────────────────────────
// Renders the full `WithdrawalsPage` in embedded mode — same backend, same
// stats / filter / requisites / reject-with-reason flow. The standalone
// `/withdrawals` route is kept as a redirect to `/partners#withdrawals` for
// deep-link compatibility.
