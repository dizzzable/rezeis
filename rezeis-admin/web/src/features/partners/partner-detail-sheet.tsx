import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Activity,
  ChevronRight,
  Coins,
  Download,
  Edit,
  Loader2,
  Network,
  ShieldCheck,
  Wallet,
} from 'lucide-react'
import { toast } from 'sonner'

import { getErrorMessage } from '@/lib/http-errors'
import { formatDateTime } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'

import { formatKopecks, formatKopecksCompact, formatNumber } from './partner-formatters'
import { downloadCsv } from './csv-download'
import { AnimatedCounter } from './animated-counter'
import {
  Partner,
  PartnerWithdrawalStatus,
  PARTNER_WITHDRAWAL_STATUSES,
} from './partners-api'
import {
  usePartnerAudit,
  usePartnerEarnings,
  usePartnerOverview,
  usePartnerReferrals,
  usePartnerWithdrawals,
  usePartnerMutations,
} from './partners-queries'

interface PartnerDetailSheetProps {
  readonly partner: Partner | null
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

export default function PartnerDetailSheet({ partner, open, onOpenChange }: PartnerDetailSheetProps) {
  const { t } = useTranslation()
  const partnerId = partner?.id ?? null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-3xl p-0 flex flex-col"
        aria-label={t('partnersDetail.sheet.aria')}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b">
          <div className="flex items-center justify-between gap-3">
            <div>
              <SheetTitle className="text-base">
                {partner?.user.name ?? partner?.user.username ?? '—'}
              </SheetTitle>
              <SheetDescription className="text-xs font-mono">
                {partner?.user.telegramId
                  ? `tg ${partner.user.telegramId}`
                  : partner?.user.username
                    ? `@${partner.user.username}`
                    : ''}
                {partner ? ` · ${partner.id.slice(0, 8)}…` : ''}
              </SheetDescription>
            </div>
            {partner && (
              <Badge
                variant={partner.isActive ? 'success' : 'secondary'}
                className="text-[10px] uppercase"
              >
                {partner.isActive
                  ? t('partnersDetail.status.active')
                  : t('partnersDetail.status.inactive')}
              </Badge>
            )}
          </div>
        </SheetHeader>

        {partner && partnerId ? (
          <Tabs defaultValue="overview" className="flex-1 flex flex-col">
            <TabsList className="rounded-none border-b px-6 h-11 bg-transparent justify-start">
              <TabsTrigger value="overview">
                <Activity className="h-3.5 w-3.5 mr-1.5" />
                {t('partnersDetail.tabs.overview')}
              </TabsTrigger>
              <TabsTrigger value="earnings">
                <Coins className="h-3.5 w-3.5 mr-1.5" />
                {t('partnersDetail.tabs.earnings')}
              </TabsTrigger>
              <TabsTrigger value="referrals">
                <Network className="h-3.5 w-3.5 mr-1.5" />
                {t('partnersDetail.tabs.referrals')}
              </TabsTrigger>
              <TabsTrigger value="withdrawals">
                <Wallet className="h-3.5 w-3.5 mr-1.5" />
                {t('partnersDetail.tabs.withdrawals')}
              </TabsTrigger>
              <TabsTrigger value="settings">
                <Edit className="h-3.5 w-3.5 mr-1.5" />
                {t('partnersDetail.tabs.settings')}
              </TabsTrigger>
              <TabsTrigger value="audit">
                <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />
                {t('partnersDetail.tabs.audit')}
              </TabsTrigger>
            </TabsList>
            <ScrollArea className="flex-1">
              <div className="p-6">
                <TabsContent value="overview" className="m-0">
                  <OverviewPanel partnerId={partnerId} />
                </TabsContent>
                <TabsContent value="earnings" className="m-0">
                  <EarningsPanel partnerId={partnerId} />
                </TabsContent>
                <TabsContent value="referrals" className="m-0">
                  <ReferralsPanel partnerId={partnerId} />
                </TabsContent>
                <TabsContent value="withdrawals" className="m-0">
                  <WithdrawalsPanel partnerId={partnerId} />
                </TabsContent>
                <TabsContent value="settings" className="m-0">
                  <SettingsPanel partner={partner} />
                </TabsContent>
                <TabsContent value="audit" className="m-0">
                  <AuditPanel partnerId={partnerId} />
                </TabsContent>
              </div>
            </ScrollArea>
          </Tabs>
        ) : (
          <div className="flex-1 p-6">
            <Skeleton className="h-32 w-full" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

// ── Overview ──────────────────────────────────────────────────────────────────

function OverviewPanel({ partnerId }: { readonly partnerId: string }) {
  const { t } = useTranslation()
  const { data, isLoading } = usePartnerOverview(partnerId)

  if (isLoading || !data) return <Skeleton className="h-48 w-full" />

  const { partner } = data
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <MetricCard
          label={t('partnersDetail.metric.balance')}
          value={formatKopecks(partner.balance)}
          numericValue={partner.balance / 100}
          formatter={(v) =>
            `${v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`
          }
          accent="emerald"
        />
        <MetricCard
          label={t('partnersDetail.metric.totalEarned')}
          value={formatKopecks(partner.totalEarned)}
          numericValue={partner.totalEarned / 100}
          formatter={(v) =>
            `${v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`
          }
        />
        <MetricCard
          label={t('partnersDetail.metric.totalWithdrawn')}
          value={formatKopecks(partner.totalWithdrawn)}
          numericValue={partner.totalWithdrawn / 100}
          formatter={(v) =>
            `${v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`
          }
        />
        <MetricCard
          label={t('partnersDetail.metric.referralsTotal')}
          value={formatNumber(partner.referralsCount)}
          numericValue={partner.referralsCount}
          formatter={formatNumber}
        />
      </div>

      <Card>
        <CardContent className="pt-4 grid grid-cols-3 gap-3">
          <MiniMetric
            label={t('partnersDetail.metric.earnings7d')}
            value={formatKopecksCompact(data.earningsLast7d)}
          />
          <MiniMetric
            label={t('partnersDetail.metric.earnings30d')}
            value={formatKopecksCompact(data.earningsLast30d)}
          />
          <MiniMetric
            label={t('partnersDetail.metric.transactions30d')}
            value={formatNumber(data.transactionsLast30d)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4 space-y-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase">
            {t('partnersDetail.overview.referralsByLevel')}
          </p>
          <div className="grid grid-cols-3 gap-2">
            <LevelBadge level={1} count={data.referralsByLevel.l1} />
            <LevelBadge level={2} count={data.referralsByLevel.l2} />
            <LevelBadge level={3} count={data.referralsByLevel.l3} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('partnersDetail.overview.created')}</span>
            <span className="font-mono text-xs">{formatDateTime(partner.createdAt)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              {t('partnersDetail.overview.lastUpdated')}
            </span>
            <span className="font-mono text-xs">{formatDateTime(partner.updatedAt)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              {t('partnersDetail.overview.useGlobalSettings')}
            </span>
            <Badge variant={partner.useGlobalSettings ? 'secondary' : 'outline'}>
              {partner.useGlobalSettings
                ? t('partnersDetail.overview.global')
                : t('partnersDetail.overview.individual')}
            </Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function MetricCard({
  label,
  value,
  numericValue,
  formatter,
  accent,
}: {
  readonly label: string
  readonly value: string
  readonly numericValue?: number
  readonly formatter?: (value: number) => string
  readonly accent?: 'emerald' | 'blue' | 'red'
}) {
  const accentClass =
    accent === 'emerald'
      ? 'text-emerald-500'
      : accent === 'blue'
        ? 'text-blue-500'
        : accent === 'red'
          ? 'text-destructive'
          : ''
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</p>
        <p className={`text-2xl font-bold tabular-nums mt-1 ${accentClass}`}>
          {numericValue !== undefined && formatter ? (
            <AnimatedCounter value={numericValue} format={formatter} />
          ) : (
            value
          )}
        </p>
      </CardContent>
    </Card>
  )
}

function MiniMetric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground uppercase">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function LevelBadge({ level, count }: { readonly level: number; readonly count: number }) {
  const colorClass =
    level === 1
      ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30'
      : level === 2
        ? 'bg-blue-500/10 text-blue-600 border-blue-500/30'
        : 'bg-purple-500/10 text-purple-600 border-purple-500/30'
  return (
    <div className={`rounded-lg border px-3 py-2 ${colorClass}`}>
      <p className="text-[10px] font-mono uppercase">L{level}</p>
      <p className="text-xl font-bold tabular-nums">{formatNumber(count)}</p>
    </div>
  )
}

// ── Earnings ─────────────────────────────────────────────────────────────────

function EarningsPanel({ partnerId }: { readonly partnerId: string }) {
  const { t } = useTranslation()
  const { data, isLoading } = usePartnerEarnings(partnerId, 50, 0)

  async function handleCsvDownload() {
    try {
      await downloadCsv({
        path: `/admin/partners/${partnerId}/export/earnings.csv`,
        filename: `partner-${partnerId.slice(0, 8)}-earnings.csv`,
      })
      toast.success(t('partnersDetail.export.success'))
    } catch {
      toast.error(t('partnersDetail.export.failed'))
    }
  }

  if (isLoading || !data) return <Skeleton className="h-64 w-full" />
  if (data.items.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        {t('partnersDetail.empty')}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={handleCsvDownload}>
          <Download className="h-3.5 w-3.5 mr-1.5" />
          {t('partnersDetail.export.csv')}
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('partnersDetail.earnings.level')}</TableHead>
            <TableHead>{t('partnersDetail.earnings.referral')}</TableHead>
            <TableHead>{t('partnersDetail.earnings.payment')}</TableHead>
            <TableHead>{t('partnersDetail.earnings.percent')}</TableHead>
            <TableHead>{t('partnersDetail.earnings.earned')}</TableHead>
            <TableHead>{t('partnersDetail.earnings.date')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.items.map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                <Badge variant="outline">L{row.level}</Badge>
              </TableCell>
              <TableCell className="text-sm">
                {row.referralUser?.name ?? row.referralUser?.username ?? '—'}
                <p className="text-[10px] text-muted-foreground font-mono">
                  {row.referralUser?.telegramId ?? ''}
                </p>
              </TableCell>
              <TableCell className="font-mono text-xs">{formatKopecks(row.paymentAmount)}</TableCell>
              <TableCell className="font-mono text-xs">{row.percent}%</TableCell>
              <TableCell className="font-mono text-xs text-emerald-500 font-semibold">
                {formatKopecks(row.earnedAmount)}
              </TableCell>
              <TableCell className="text-[11px] text-muted-foreground">
                {formatDateTime(row.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// ── Referrals ─────────────────────────────────────────────────────────────────

function ReferralsPanel({ partnerId }: { readonly partnerId: string }) {
  const { t } = useTranslation()
  const { data, isLoading } = usePartnerReferrals(partnerId, 50, 0)

  if (isLoading || !data) return <Skeleton className="h-64 w-full" />
  if (data.items.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        {t('partnersDetail.empty')}
      </div>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('partnersDetail.referrals.level')}</TableHead>
          <TableHead>{t('partnersDetail.referrals.user')}</TableHead>
          <TableHead>{t('partnersDetail.referrals.created')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.items.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <Badge variant="outline">L{row.level}</Badge>
            </TableCell>
            <TableCell className="text-sm">
              <p className="font-medium">{row.user?.name ?? row.user?.username ?? '—'}</p>
              <p className="text-[10px] text-muted-foreground font-mono">
                {row.user?.telegramId ?? ''}
              </p>
            </TableCell>
            <TableCell className="text-[11px] text-muted-foreground">
              {formatDateTime(row.createdAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

// ── Withdrawals ───────────────────────────────────────────────────────────────

function WithdrawalsPanel({ partnerId }: { readonly partnerId: string }) {
  const { t } = useTranslation()
  const { data, isLoading } = usePartnerWithdrawals(partnerId, 50, 0)

  if (isLoading || !data) return <Skeleton className="h-64 w-full" />
  if (data.items.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        {t('partnersDetail.empty')}
      </div>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('partnersDetail.withdrawals.amount')}</TableHead>
          <TableHead>{t('partnersDetail.withdrawals.status')}</TableHead>
          <TableHead>{t('partnersDetail.withdrawals.method')}</TableHead>
          <TableHead>{t('partnersDetail.withdrawals.date')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.items.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-mono text-xs font-semibold">
              {formatKopecks(row.amount)}
            </TableCell>
            <TableCell>
              <WithdrawalStatusBadge status={row.status} />
            </TableCell>
            <TableCell className="text-xs">{row.method}</TableCell>
            <TableCell className="text-[11px] text-muted-foreground">
              {formatDateTime(row.createdAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function WithdrawalStatusBadge({ status }: { readonly status: PartnerWithdrawalStatus }) {
  const { t } = useTranslation()
  const variant: 'success' | 'warning' | 'destructive' | 'secondary' =
    status === 'COMPLETED'
      ? 'success'
      : status === 'PENDING'
        ? 'warning'
        : status === 'REJECTED'
          ? 'destructive'
          : 'secondary'
  return <Badge variant={variant}>{t(`withdrawalsPage.statuses.${status}`)}</Badge>
}

// keep enum reference live
void PARTNER_WITHDRAWAL_STATUSES

// ── Settings ─────────────────────────────────────────────────────────────────

function SettingsPanel({ partner }: { readonly partner: Partner }) {
  const { t } = useTranslation()
  const { adjustBalance, updateIndividualSettings } = usePartnerMutations()

  const adjustSchema = z.object({
    amount: z
      .string()
      .trim()
      .min(1, t('partnersDetail.validation.amountRequired'))
      .refine((v) => Number.isFinite(Number(v)), {
        message: t('partnersDetail.validation.amountInvalid'),
      }),
    reason: z.string().trim(),
  })
  type AdjustValues = z.infer<typeof adjustSchema>
  const adjustForm = useForm<AdjustValues>({
    resolver: zodResolver(adjustSchema),
    defaultValues: { amount: '', reason: '' },
  })

  const ratesSchema = useMemo(() => {
    const percentField = z
      .string()
      .trim()
      .refine(
        (v) => {
          if (v === '') return true
          const n = Number(v)
          return Number.isFinite(n) && n >= 0 && n <= 100
        },
        { message: t('partnersDetail.validation.percentRange') },
      )
    const fixedField = z
      .string()
      .trim()
      .refine(
        (v) => {
          if (v === '') return true
          const n = Number(v)
          return Number.isFinite(n) && n >= 0
        },
        { message: t('partnersDetail.validation.fixedAmount') },
      )
    return z.object({
      useGlobalSettings: z.boolean(),
      accrualStrategy: z.enum(['ON_EACH_PAYMENT', 'ONCE_PER_USER']),
      rewardType: z.enum(['PERCENT', 'FIXED']),
      level1Percent: percentField,
      level2Percent: percentField,
      level3Percent: percentField,
      level1Fixed: fixedField,
      level2Fixed: fixedField,
      level3Fixed: fixedField,
    })
  }, [t])
  type RatesValues = z.infer<typeof ratesSchema>

  const ratesForm = useForm<RatesValues>({
    resolver: zodResolver(ratesSchema),
    defaultValues: {
      useGlobalSettings: partner.useGlobalSettings,
      accrualStrategy: partner.accrualStrategy,
      rewardType: partner.rewardType,
      level1Percent: partner.level1Percent ?? '',
      level2Percent: partner.level2Percent ?? '',
      level3Percent: partner.level3Percent ?? '',
      level1Fixed:
        partner.level1FixedAmount === null ? '' : (partner.level1FixedAmount / 100).toFixed(2),
      level2Fixed:
        partner.level2FixedAmount === null ? '' : (partner.level2FixedAmount / 100).toFixed(2),
      level3Fixed:
        partner.level3FixedAmount === null ? '' : (partner.level3FixedAmount / 100).toFixed(2),
    },
  })

  const useGlobal = ratesForm.watch('useGlobalSettings')
  const rewardType = ratesForm.watch('rewardType')

  function handleAdjustSubmit(values: AdjustValues) {
    adjustBalance.mutate(
      {
        partnerId: partner.id,
        amount: Math.round(Number(values.amount) * 100),
        reason: values.reason || undefined,
      },
      {
        onSuccess: () => {
          toast.success(t('partnersDetail.toasts.balanceAdjusted'))
          adjustForm.reset({ amount: '', reason: '' })
        },
        onError: (err) =>
          toast.error(getErrorMessage(err, t('partnersDetail.toasts.balanceFailed'))),
      },
    )
  }

  function handleRatesSubmit(values: RatesValues) {
    if (!partner.user.telegramId) {
      toast.error(t('partnersDetail.toasts.noTelegramId'))
      return
    }
    updateIndividualSettings.mutate(
      {
        telegramId: partner.user.telegramId,
        useGlobalSettings: values.useGlobalSettings,
        accrualStrategy: values.accrualStrategy,
        rewardType: values.rewardType,
        level1Percent: values.level1Percent ? Number(values.level1Percent) : null,
        level2Percent: values.level2Percent ? Number(values.level2Percent) : null,
        level3Percent: values.level3Percent ? Number(values.level3Percent) : null,
        level1FixedAmount: values.level1Fixed
          ? Math.round(Number(values.level1Fixed) * 100)
          : null,
        level2FixedAmount: values.level2Fixed
          ? Math.round(Number(values.level2Fixed) * 100)
          : null,
        level3FixedAmount: values.level3Fixed
          ? Math.round(Number(values.level3Fixed) * 100)
          : null,
      },
      {
        onSuccess: () => toast.success(t('partnersDetail.toasts.settingsSaved')),
        onError: (err) =>
          toast.error(getErrorMessage(err, t('partnersDetail.toasts.settingsFailed'))),
      },
    )
  }

  return (
    <div className="space-y-6">
      {/* Balance adjustment */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          <div>
            <p className="text-sm font-semibold">{t('partnersDetail.adjust.title')}</p>
            <p className="text-xs text-muted-foreground">
              {t('partnersDetail.adjust.description')}
            </p>
          </div>
          <Form {...adjustForm}>
            <form onSubmit={adjustForm.handleSubmit(handleAdjustSubmit)} className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <FormField
                  control={adjustForm.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Input
                          type="number"
                          step="0.01"
                          placeholder={t('partnersDetail.adjust.amountPlaceholder')}
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
                    <FormItem>
                      <FormControl>
                        <Input
                          placeholder={t('partnersDetail.adjust.reasonPlaceholder')}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <Button type="submit" size="sm" disabled={adjustBalance.isPending}>
                {adjustBalance.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <ChevronRight className="h-4 w-4 mr-2" />
                )}
                {t('partnersDetail.adjust.apply')}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      <Separator />

      {/* Individual rates */}
      <Card>
        <CardContent className="pt-4 space-y-4">
          <div>
            <p className="text-sm font-semibold">{t('partnersDetail.individual.title')}</p>
            <p className="text-xs text-muted-foreground">
              {t('partnersDetail.individual.description')}
            </p>
          </div>
          <Form {...ratesForm}>
            <form onSubmit={ratesForm.handleSubmit(handleRatesSubmit)} className="space-y-4">
              <FormField
                control={ratesForm.control}
                name="useGlobalSettings"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between space-y-0">
                    <div>
                      <FormLabel className="cursor-pointer">
                        {t('partnersDetail.individual.useGlobal')}
                      </FormLabel>
                      <FormDescription className="text-[11px]">
                        {t('partnersDetail.individual.useGlobalHint')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={ratesForm.control}
                  name="accrualStrategy"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">
                        {t('partnersDetail.individual.accrualStrategy')}
                      </FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                        disabled={useGlobal}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="ON_EACH_PAYMENT">
                            {t('partnersDetail.individual.onEach')}
                          </SelectItem>
                          <SelectItem value="ONCE_PER_USER">
                            {t('partnersDetail.individual.oncePerUser')}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
                <FormField
                  control={ratesForm.control}
                  name="rewardType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">
                        {t('partnersDetail.individual.rewardType')}
                      </FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                        disabled={useGlobal}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="PERCENT">
                            {t('partnersDetail.individual.percent')}
                          </SelectItem>
                          <SelectItem value="FIXED">
                            {t('partnersDetail.individual.fixed')}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
              </div>

              <div>
                <Label className="text-xs">
                  {rewardType === 'FIXED'
                    ? t('partnersDetail.individual.fixedAmounts')
                    : t('partnersDetail.individual.percents')}
                </Label>
                <div className="grid grid-cols-3 gap-2 mt-2">
                  {(rewardType === 'FIXED'
                    ? ['level1Fixed', 'level2Fixed', 'level3Fixed']
                    : ['level1Percent', 'level2Percent', 'level3Percent']
                  ).map((name, idx) => (
                    <FormField
                      key={name}
                      control={ratesForm.control}
                      name={name as keyof RatesValues}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-[10px] uppercase">L{idx + 1}</FormLabel>
                          <FormControl>
                            <div className="relative">
                              <Input
                                type="number"
                                step={rewardType === 'FIXED' ? '0.01' : '0.1'}
                                min="0"
                                disabled={useGlobal}
                                placeholder={
                                  useGlobal
                                    ? t('partnersDetail.individual.globalPlaceholder')
                                    : '0'
                                }
                                {...field}
                                value={
                                  typeof field.value === 'boolean' ? '' : (field.value ?? '')
                                }
                                className="pr-8"
                              />
                              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">
                                {rewardType === 'FIXED' ? '₽' : '%'}
                              </span>
                            </div>
                          </FormControl>
                          <FormMessage className="text-[10px]" />
                        </FormItem>
                      )}
                    />
                  ))}
                </div>
              </div>

              <Button type="submit" size="sm" disabled={updateIndividualSettings.isPending}>
                {updateIndividualSettings.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                {t('partnersDetail.individual.save')}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  )
}

// ── Audit ────────────────────────────────────────────────────────────────────

function AuditPanel({ partnerId }: { readonly partnerId: string }) {
  const { t } = useTranslation()
  const [offset, setOffset] = useState(0)
  const { data, isLoading } = usePartnerAudit(partnerId, 25, offset)

  if (isLoading || !data) return <Skeleton className="h-64 w-full" />
  if (data.items.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        {t('partnersDetail.empty')}
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {data.items.map((event) => (
        <div key={event.id} className="rounded-lg border bg-card/50 px-3 py-2">
          <div className="flex items-center justify-between">
            <Badge variant="outline" className="text-[10px] font-mono">
              {event.action}
            </Badge>
            <span className="text-[10px] text-muted-foreground font-mono">
              {formatDateTime(event.createdAt)}
            </span>
          </div>
          {event.adminUsername && (
            <p className="text-xs mt-1">
              {t('partnersDetail.audit.by')}{' '}
              <span className="font-mono">{event.adminUsername}</span>
            </p>
          )}
          {Object.keys(event.metadata).length > 0 && (
            <details className="mt-2 text-[11px]">
              <summary className="cursor-pointer text-muted-foreground">
                {t('partnersDetail.audit.metadata')}
              </summary>
              <pre className="mt-1 bg-muted/40 rounded p-2 overflow-x-auto text-[10px]">
                {JSON.stringify(event.metadata, null, 2)}
              </pre>
            </details>
          )}
        </div>
      ))}
      {data.total > offset + data.items.length && (
        <Button variant="ghost" size="sm" onClick={() => setOffset(offset + 25)}>
          {t('partnersDetail.audit.loadMore')}
        </Button>
      )}
    </div>
  )
}
