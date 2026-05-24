import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Save, Handshake, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { FadeIn } from '@/lib/motion'

const GATEWAY_COMMISSIONS = [
  { key: 'yookassaCommission', label: 'YooKassa', default: '3.5' },
  { key: 'yoomoneyCommission', label: 'YooMoney', default: '3.5' },
  { key: 'tbankCommission', label: 'T-Bank', default: '2.8' },
  { key: 'robokassaCommission', label: 'Robokassa', default: '3.5' },
  { key: 'stripeCommission', label: 'Stripe', default: '3.5' },
  { key: 'mulenpayCommission', label: 'MulenPay', default: '3.5' },
  { key: 'cloudpaymentsCommission', label: 'CloudPayments', default: '3.5' },
  { key: 'telegramStarsCommission', label: 'Telegram Stars', default: '30' },
  { key: 'cryptopayCommission', label: 'CryptoPay', default: '1.0' },
  { key: 'cryptomusCommission', label: 'Cryptomus', default: '1.0' },
  { key: 'heleketCommission', label: 'Heleket', default: '1.0' },
  { key: 'pal24Commission', label: 'Pal24', default: '5.0' },
  { key: 'wataCommission', label: 'WATA', default: '3.0' },
  { key: 'plategaCommission', label: 'Platega', default: '3.5' },
  { key: 'antilopayCommission', label: 'Antilopay', default: '3.5' },
  { key: 'paypalychCommission', label: 'PayPalych', default: '3.5' },
  { key: 'overpayCommission', label: 'OverPay', default: '3.5' },
  { key: 'riopayCommission', label: 'RioPay', default: '3.5' },
] as const

type AccrualStrategy = 'ON_EACH_PAYMENT' | 'ON_FIRST_PAYMENT'

interface PartnerSettings {
  enabled?: boolean
  level1Percent?: number | string
  level2Percent?: number | string
  level3Percent?: number | string
  minWithdrawalAmount?: number | string
  autoCalculateCommission?: boolean
  taxPercent?: number | string
  accrualStrategy?: AccrualStrategy
  [k: string]: unknown
}

export default function PartnerSettingsPage() {
  const { t } = useTranslation()

  const { data: settings, isLoading } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: async () => (await api.get('/admin/settings')).data,
  })

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  const partner = ((settings?.partnerSettings as PartnerSettings | undefined) ?? {}) as PartnerSettings

  return <PartnerSettingsForm partner={partner} />
}

interface PartnerSettingsFormProps {
  readonly partner: PartnerSettings
}

function PartnerSettingsForm({ partner }: PartnerSettingsFormProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const percent = z
    .string()
    .trim()
    .refine(
      (v) => {
        if (v === '') return true
        const n = parseFloat(v)
        return !Number.isNaN(n) && n >= 0 && n <= 100
      },
      { message: t('partnerSettingsPage.validation.percentRange') },
    )

  const positiveInt = z
    .string()
    .trim()
    .refine(
      (v) => {
        if (v === '') return true
        return /^\d+$/.test(v)
      },
      { message: t('partnerSettingsPage.validation.positiveAmount') },
    )

  const schema = z.object({
    enabled: z.boolean(),
    autoCalculate: z.boolean(),
    accrualStrategy: z.enum(['ON_EACH_PAYMENT', 'ON_FIRST_PAYMENT']),
    level1Percent: percent,
    level2Percent: percent,
    level3Percent: percent,
    taxPercent: percent,
    minWithdrawal: positiveInt,
    commissions: z.record(z.string(), percent),
  })

  type FormValues = z.infer<typeof schema>

  const initialCommissions: Record<string, string> = {}
  for (const gc of GATEWAY_COMMISSIONS) {
    initialCommissions[gc.key] = String(partner[gc.key] ?? gc.default)
  }

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      enabled: partner.enabled ?? false,
      autoCalculate: partner.autoCalculateCommission ?? false,
      accrualStrategy: (partner.accrualStrategy as AccrualStrategy | undefined) ?? 'ON_EACH_PAYMENT',
      level1Percent: partner.level1Percent != null ? String(partner.level1Percent) : '',
      level2Percent: partner.level2Percent != null ? String(partner.level2Percent) : '',
      level3Percent: partner.level3Percent != null ? String(partner.level3Percent) : '',
      taxPercent: partner.taxPercent != null ? String(partner.taxPercent) : '',
      minWithdrawal: partner.minWithdrawalAmount != null ? String(partner.minWithdrawalAmount) : '',
      commissions: initialCommissions,
    },
  })

  const accrualStrategy = form.watch('accrualStrategy')
  const minWithdrawalRaw = form.watch('minWithdrawal')

  const saveMutation = useMutation({
    mutationFn: (values: FormValues) => {
      const payload: Record<string, unknown> = {
        enabled: values.enabled,
        level1Percent: values.level1Percent ? parseFloat(values.level1Percent) : undefined,
        level2Percent: values.level2Percent ? parseFloat(values.level2Percent) : undefined,
        level3Percent: values.level3Percent ? parseFloat(values.level3Percent) : undefined,
        minWithdrawalAmount: values.minWithdrawal ? parseInt(values.minWithdrawal, 10) : undefined,
        autoCalculateCommission: values.autoCalculate,
        taxPercent: values.taxPercent ? parseFloat(values.taxPercent) : undefined,
        accrualStrategy: values.accrualStrategy,
      }
      for (const gc of GATEWAY_COMMISSIONS) {
        const v = values.commissions[gc.key]
        if (v) payload[gc.key] = parseFloat(v)
      }
      return api.patch('/admin/settings/partner', payload)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] })
      toast.success(t('partnerSettingsPage.saved'))
    },
    onError: () => toast.error(t('partnerSettingsPage.saveFailed')),
  })

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((values) => saveMutation.mutate(values))}
        className="space-y-6"
      >
        <FadeIn>
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                <Handshake className="h-6 w-6" /> {t('partnerSettingsPage.title')}
              </h1>
              <p className="text-muted-foreground">{t('partnerSettingsPage.subtitle')}</p>
            </div>
            <Button type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              {t('partnerSettingsPage.save')}
            </Button>
          </div>
        </FadeIn>

        <Card>
          <CardHeader><CardTitle>{t('partnerSettingsPage.general.title')}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between space-y-0">
                  <div>
                    <FormLabel>{t('partnerSettingsPage.general.enable')}</FormLabel>
                    <FormDescription className="text-xs">
                      {t('partnerSettingsPage.general.enableHint')}
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="autoCalculate"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between space-y-0">
                  <div>
                    <FormLabel>{t('partnerSettingsPage.general.autoCalculate')}</FormLabel>
                    <FormDescription className="text-xs">
                      {t('partnerSettingsPage.general.autoCalculateHint')}
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="accrualStrategy"
              render={({ field }) => (
                <FormItem className="space-y-1.5 max-w-xs">
                  <FormLabel>{t('partnerSettingsPage.general.accrualStrategy')}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="ON_EACH_PAYMENT">
                        {t('partnerSettingsPage.general.onEachPayment')}
                      </SelectItem>
                      <SelectItem value="ON_FIRST_PAYMENT">
                        {t('partnerSettingsPage.general.onFirstPayment')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription className="text-[11px]">
                    {accrualStrategy === 'ON_FIRST_PAYMENT'
                      ? t('partnerSettingsPage.general.onFirstPaymentHint')
                      : t('partnerSettingsPage.general.onEachPaymentHint')}
                  </FormDescription>
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('partnerSettingsPage.commissionRates.title')}</CardTitle>
            <CardDescription>{t('partnerSettingsPage.commissionRates.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-3">
              {(['level1Percent', 'level2Percent', 'level3Percent'] as const).map((name, idx) => (
                <FormField
                  key={name}
                  control={form.control}
                  name={name}
                  render={({ field }) => (
                    <FormItem className="space-y-1.5">
                      <FormLabel>
                        {idx === 0
                          ? t('partnerSettingsPage.commissionRates.level1')
                          : idx === 1
                            ? t('partnerSettingsPage.commissionRates.level2')
                            : t('partnerSettingsPage.commissionRates.level3')}
                      </FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Input
                            type="number"
                            min="0"
                            max="100"
                            step="0.1"
                            placeholder="0"
                            {...field}
                            className="pr-8"
                          />
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
                        </div>
                      </FormControl>
                      <FormMessage className="text-[10px]" />
                    </FormItem>
                  )}
                />
              ))}
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="taxPercent"
                render={({ field }) => (
                  <FormItem className="space-y-1.5">
                    <FormLabel>{t('partnerSettingsPage.commissionRates.taxPercent')}</FormLabel>
                    <FormControl>
                      <div className="relative w-40">
                        <Input
                          type="number"
                          min="0"
                          max="100"
                          step="0.1"
                          placeholder="6"
                          {...field}
                          className="pr-8"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
                      </div>
                    </FormControl>
                    <FormDescription className="text-[11px]">
                      {t('partnerSettingsPage.commissionRates.taxPercentHint')}
                    </FormDescription>
                    <FormMessage className="text-[10px]" />
                  </FormItem>
                )}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('partnerSettingsPage.withdrawal.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <FormField
              control={form.control}
              name="minWithdrawal"
              render={({ field }) => (
                <FormItem className="space-y-1.5 w-64">
                  <FormLabel>{t('partnerSettingsPage.withdrawal.minAmount')}</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min="0"
                      step="1"
                      placeholder="50000"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription className="text-[11px]">
                    {minWithdrawalRaw && /^\d+$/.test(minWithdrawalRaw)
                      ? `= ${(parseInt(minWithdrawalRaw, 10) / 100).toFixed(2)} ₽`
                      : t('partnerSettingsPage.withdrawal.defaultHint')}
                  </FormDescription>
                  <FormMessage className="text-[10px]" />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('partnerSettingsPage.gatewayCommissions.title')}</CardTitle>
            <CardDescription>
              {t('partnerSettingsPage.gatewayCommissions.description')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {GATEWAY_COMMISSIONS.map((gc) => (
                <FormField
                  key={gc.key}
                  control={form.control}
                  name={`commissions.${gc.key}` as const}
                  render={({ field }) => (
                    <FormItem className="space-y-1">
                      <FormLabel className="text-xs">{gc.label}</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Input
                            type="number"
                            min="0"
                            max="100"
                            step="0.1"
                            {...field}
                            className="pr-8 h-8 text-sm"
                          />
                          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">%</span>
                        </div>
                      </FormControl>
                      <FormMessage className="text-[10px]" />
                    </FormItem>
                  )}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      </form>
    </Form>
  )
}
