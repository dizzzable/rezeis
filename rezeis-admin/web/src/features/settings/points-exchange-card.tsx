import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Save, Loader2, CalendarDays, Coins, Gift, Percent, Wifi } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { usePlans, type Plan } from '@/features/plans/plans-api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel } from '@/components/ui/form'

/**
 * `referralSettings.pointsExchange` as the overview returns it. Loose on
 * purpose, like the referral page's own reading of it: numbers may arrive as
 * strings from older saves, and every key may be absent.
 */
export interface PointsExchangeSettings {
  exchangeEnabled?: boolean
  subscriptionDays?: { enabled?: boolean; pointsCost?: number | string }
  giftSubscription?: { enabled?: boolean; pointsCost?: number | string; giftDurationDays?: number | string; giftPlanId?: string | null }
  discount?: { enabled?: boolean; pointsCost?: number | string; maxDiscountPercent?: number | string }
  traffic?: { enabled?: boolean; pointsCost?: number | string; maxTrafficGb?: number | string }
}

/**
 * What points BUY — days, a gift subscription, a permanent discount, traffic —
 * on the Points settings page. It used to sit on the referral settings page,
 * from the days when referrals were the only way to earn a point; with
 * cashback the wallet has more than one source, and what it buys is not a
 * referral question.
 *
 * Storage did not move: the values still live in
 * `referralSettings.pointsExchange`, and this card saves ONLY that key through
 * `PATCH /admin/settings/referral`, which merges the sub-object one level deep
 * and leaves the referral program's own knobs alone.
 */
export function PointsExchangeCard({ pointsExchange }: { readonly pointsExchange: PointsExchangeSettings }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: plans } = usePlans()

  const numString = z.string().trim()
  const schema = z.object({
    exchangeEnabled: z.boolean(),
    daysEnabled: z.boolean(),
    daysPointsCost: numString,
    giftEnabled: z.boolean(),
    giftPointsCost: numString,
    giftDurationDays: numString,
    giftPlanId: numString,
    discountEnabled: z.boolean(),
    discountPointsCost: numString,
    discountMaxPercent: numString,
    trafficEnabled: z.boolean(),
    trafficPointsCost: numString,
    trafficMaxGb: numString,
  })
  type FormValues = z.infer<typeof schema>

  const pe = pointsExchange
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      exchangeEnabled: pe.exchangeEnabled ?? false,
      daysEnabled: pe.subscriptionDays?.enabled ?? true,
      daysPointsCost: String(pe.subscriptionDays?.pointsCost ?? '1'),
      giftEnabled: pe.giftSubscription?.enabled ?? false,
      giftPointsCost: String(pe.giftSubscription?.pointsCost ?? '30'),
      giftDurationDays: String(pe.giftSubscription?.giftDurationDays ?? '30'),
      giftPlanId: pe.giftSubscription?.giftPlanId ?? '',
      discountEnabled: pe.discount?.enabled ?? false,
      discountPointsCost: String(pe.discount?.pointsCost ?? '10'),
      discountMaxPercent: String(pe.discount?.maxDiscountPercent ?? '50'),
      trafficEnabled: pe.traffic?.enabled ?? false,
      trafficPointsCost: String(pe.traffic?.pointsCost ?? '5'),
      trafficMaxGb: String(pe.traffic?.maxTrafficGb ?? '100'),
    },
  })

  // react-hook-form's `form.watch()` integration is not yet recognised by react-doctor.
  // eslint-disable-next-line react-hooks/incompatible-library
  const exchangeEnabled = form.watch('exchangeEnabled')
  const daysEnabled = form.watch('daysEnabled')
  const giftEnabled = form.watch('giftEnabled')
  const discountEnabled = form.watch('discountEnabled')
  const trafficEnabled = form.watch('trafficEnabled')
  const giftPlanId = form.watch('giftPlanId')

  /** What the platform can actually sell — mirror of `PlanCatalogService`. */
  const sellable = (plan: Plan): boolean => plan.isActive && !plan.isArchived
  const allPlans = plans ?? []
  /**
   * GIFT plan — the subscription a user receives NOW for their points.
   * Strictly what is on sale (this mints a NEW subscription), plus the stored
   * choice whatever its state: a value the form submits has to be a value the
   * operator can see.
   */
  const giftPlanOptions = allPlans.filter((plan) => sellable(plan) || plan.id === giftPlanId)

  const saveMutation = useMutation({
    mutationFn: (values: FormValues) =>
      api.patch('/admin/settings/referral', {
        pointsExchange: {
          exchangeEnabled: values.exchangeEnabled,
          subscriptionDays: {
            enabled: values.daysEnabled,
            pointsCost: parseInt(values.daysPointsCost, 10) || 1,
          },
          giftSubscription: {
            enabled: values.giftEnabled,
            pointsCost: parseInt(values.giftPointsCost, 10) || 30,
            giftDurationDays: parseInt(values.giftDurationDays, 10) || 30,
            giftPlanId: values.giftPlanId || null,
          },
          discount: {
            enabled: values.discountEnabled,
            pointsCost: parseInt(values.discountPointsCost, 10) || 10,
            maxDiscountPercent: parseInt(values.discountMaxPercent, 10) || 50,
          },
          traffic: {
            enabled: values.trafficEnabled,
            pointsCost: parseInt(values.trafficPointsCost, 10) || 5,
            maxTrafficGb: parseInt(values.trafficMaxGb, 10) || 100,
          },
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] })
      toast.success(t('pointsSettingsPage.exchange.saved'))
    },
    onError: () => toast.error(t('pointsSettingsPage.exchange.saveFailed')),
  })

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((values) => saveMutation.mutate(values))}
        className="space-y-4"
        aria-label={t('referralSettingsPage.pointsExchange.title')}
      >
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Coins className="h-5 w-5 text-muted-foreground" />
                  {t('referralSettingsPage.pointsExchange.title')}
                </CardTitle>
                <CardDescription>
                  {t('referralSettingsPage.pointsExchange.description')}
                </CardDescription>
              </div>
              <FormField
                control={form.control}
                name="exchangeEnabled"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-3 space-y-0">
                    <FormLabel className="text-xs text-muted-foreground">
                      {t('referralSettingsPage.pointsExchange.enable')}
                    </FormLabel>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>
          </CardHeader>
          <CardContent>
            {!exchangeEnabled ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                {t('referralSettingsPage.pointsExchange.enableHint')}
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {/* Subscription Days */}
                <ExchangeOptionCard
                  icon={<CalendarDays className="h-4 w-4 text-blue-500" />}
                  title={t('referralSettingsPage.pointsExchange.subscriptionDays')}
                  enabledFieldName="daysEnabled"
                  enabled={daysEnabled}
                  control={form.control}
                >
                  <FormField
                    control={form.control}
                    name="daysPointsCost"
                    render={({ field }) => (
                      <FormItem className="space-y-1">
                        <FormLabel className="text-[10px] text-muted-foreground uppercase tracking-wide">
                          {t('referralSettingsPage.pointsExchange.pointsPerDay')}
                        </FormLabel>
                        <FormControl>
                          <Input type="number" min="1" className="h-8 text-sm" {...field} />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </ExchangeOptionCard>

                {/* Gift Subscription */}
                <ExchangeOptionCard
                  icon={<Gift className="h-4 w-4 text-purple-500" />}
                  title={t('referralSettingsPage.pointsExchange.giftSubscription')}
                  enabledFieldName="giftEnabled"
                  enabled={giftEnabled}
                  control={form.control}
                >
                  <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="giftPointsCost"
                      render={({ field }) => (
                        <FormItem className="space-y-1">
                          <FormLabel className="text-[10px] text-muted-foreground uppercase tracking-wide">
                            {t('referralSettingsPage.pointsExchange.pointsCost')}
                          </FormLabel>
                          <FormControl>
                            <Input type="number" min="1" className="h-8 text-sm" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="giftDurationDays"
                      render={({ field }) => (
                        <FormItem className="space-y-1">
                          <FormLabel className="text-[10px] text-muted-foreground uppercase tracking-wide">
                            {t('referralSettingsPage.pointsExchange.giftDuration')}
                          </FormLabel>
                          <FormControl>
                            <Input type="number" min="1" className="h-8 text-sm" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </div>
                  <FormField
                    control={form.control}
                    name="giftPlanId"
                    render={({ field }) => (
                      <FormItem className="space-y-1 mt-2">
                        <FormLabel className="text-[10px] text-muted-foreground uppercase tracking-wide">
                          {t('referralSettingsPage.pointsExchange.giftPlan')}
                        </FormLabel>
                        <Select value={field.value || ''} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger className="h-8 text-sm">
                              <SelectValue placeholder={t('referralSettingsPage.pointsExchange.giftPlanPlaceholder')} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {giftPlanOptions.map((plan) => (
                              <SelectItem key={plan.id} value={plan.id}>
                                {plan.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormDescription className="text-[10px]">
                          {t('referralSettingsPage.pointsExchange.giftPlanHint')}
                        </FormDescription>
                      </FormItem>
                    )}
                  />
                </ExchangeOptionCard>

                {/* Personal Discount */}
                <ExchangeOptionCard
                  icon={<Percent className="h-4 w-4 text-emerald-500" />}
                  title={t('referralSettingsPage.pointsExchange.personalDiscount')}
                  enabledFieldName="discountEnabled"
                  enabled={discountEnabled}
                  control={form.control}
                >
                  <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="discountPointsCost"
                      render={({ field }) => (
                        <FormItem className="space-y-1">
                          <FormLabel className="text-[10px] text-muted-foreground uppercase tracking-wide">
                            {t('referralSettingsPage.pointsExchange.pointsPerPercent')}
                          </FormLabel>
                          <FormControl>
                            <Input type="number" min="1" className="h-8 text-sm" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="discountMaxPercent"
                      render={({ field }) => (
                        <FormItem className="space-y-1">
                          <FormLabel className="text-[10px] text-muted-foreground uppercase tracking-wide">
                            {t('referralSettingsPage.pointsExchange.maxDiscount')}
                          </FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              min="1"
                              max="100"
                              className="h-8 text-sm"
                              {...field}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </div>
                </ExchangeOptionCard>

                {/* Extra Traffic */}
                <ExchangeOptionCard
                  icon={<Wifi className="h-4 w-4 text-amber-500" />}
                  title={t('referralSettingsPage.pointsExchange.extraTraffic')}
                  enabledFieldName="trafficEnabled"
                  enabled={trafficEnabled}
                  control={form.control}
                >
                  <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="trafficPointsCost"
                      render={({ field }) => (
                        <FormItem className="space-y-1">
                          <FormLabel className="text-[10px] text-muted-foreground uppercase tracking-wide">
                            {t('referralSettingsPage.pointsExchange.pointsPerGb')}
                          </FormLabel>
                          <FormControl>
                            <Input type="number" min="1" className="h-8 text-sm" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="trafficMaxGb"
                      render={({ field }) => (
                        <FormItem className="space-y-1">
                          <FormLabel className="text-[10px] text-muted-foreground uppercase tracking-wide">
                            {t('referralSettingsPage.pointsExchange.maxTraffic')}
                          </FormLabel>
                          <FormControl>
                            <Input type="number" min="1" className="h-8 text-sm" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </div>
                </ExchangeOptionCard>
              </div>
            )}
          </CardContent>
        </Card>
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            {t('pointsSettingsPage.exchange.save')}
          </Button>
        </div>
      </form>
    </Form>
  )
}

/**
 * Compact tile for one points-exchange option. The header carries the
 * icon + title + per-option enable Switch; the body is rendered only
 * when the option itself is on, so disabled tiles stay quiet.
 */
function ExchangeOptionCard({
  icon,
  title,
  enabledFieldName,
  enabled,
  control,
  children,
}: {
  readonly icon: React.ReactNode
  readonly title: string
  readonly enabledFieldName:
    | 'daysEnabled'
    | 'giftEnabled'
    | 'discountEnabled'
    | 'trafficEnabled'
  readonly enabled: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic form control passthrough
  readonly control: any
  readonly children: React.ReactNode
}) {
  return (
    <div
      className={`rounded-md border p-3 space-y-3 transition-opacity ${enabled ? 'bg-card' : 'bg-muted/30 opacity-70'}`}
    >
      <FormField
        control={control}
        name={enabledFieldName}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between gap-2 space-y-0">
            <div className="flex items-center gap-2 text-sm font-medium">
              {icon}
              <span>{title}</span>
            </div>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
          </FormItem>
        )}
      />
      {enabled && children}
    </div>
  )
}
