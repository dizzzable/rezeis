import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Save, Share2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
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

type AccrualStrategy = 'ON_FIRST_PAYMENT' | 'ON_EACH_PAYMENT'
type RewardType = 'EXTRA_DAYS' | 'POINTS'

interface ReferralSettings {
  enabled?: boolean
  enable?: boolean
  accrualStrategy?: AccrualStrategy
  rewardType?: RewardType
  level1Reward?: number | string
  level2Reward?: number | string
  level3Reward?: number | string
  pointsPerReferral?: number | string
  qualifyOnPurchase?: boolean
  inviteLinkTtlDays?: number | string
  inviteSlots?: number | string
  inviteLimits?: {
    linkTtlEnabled?: boolean
    linkTtlSeconds?: number | null
    slotsEnabled?: boolean
    initialSlots?: number | null
  }
  pointsExchange?: {
    exchangeEnabled?: boolean
    subscriptionDays?: { enabled?: boolean; pointsCost?: number | string }
    giftSubscription?: { enabled?: boolean; pointsCost?: number | string; giftDurationDays?: number | string }
    discount?: { enabled?: boolean; pointsCost?: number | string; maxDiscountPercent?: number | string }
    traffic?: { enabled?: boolean; pointsCost?: number | string; maxTrafficGb?: number | string }
  }
}

export default function ReferralSettingsPage() {
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

  const referral = ((settings?.referralSettings as ReferralSettings | undefined) ?? {}) as ReferralSettings
  return <ReferralSettingsForm referral={referral} />
}

interface ReferralSettingsFormProps {
  readonly referral: ReferralSettings
}

function ReferralSettingsForm({ referral }: ReferralSettingsFormProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const numString = z.string().trim()

  const schema = z.object({
    enabled: z.boolean(),
    accrualStrategy: z.enum(['ON_FIRST_PAYMENT', 'ON_EACH_PAYMENT']),
    rewardType: z.enum(['EXTRA_DAYS', 'POINTS']),
    level1Reward: numString,
    level2Reward: numString,
    level3Reward: numString,
    pointsPerReferral: numString,
    qualifyOnPurchase: z.boolean(),
    inviteLinkTtlDays: numString,
    inviteSlots: numString,
    inviteSlotsEnabled: z.boolean(),
    linkTtlEnabled: z.boolean(),
    exchangeEnabled: z.boolean(),
    daysEnabled: z.boolean(),
    daysPointsCost: numString,
    giftEnabled: z.boolean(),
    giftPointsCost: numString,
    giftDurationDays: numString,
    discountEnabled: z.boolean(),
    discountPointsCost: numString,
    discountMaxPercent: numString,
    trafficEnabled: z.boolean(),
    trafficPointsCost: numString,
    trafficMaxGb: numString,
  })

  type FormValues = z.infer<typeof schema>

  const inviteLimits = referral.inviteLimits ?? {}
  const pe = referral.pointsExchange ?? {}

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      enabled: referral.enabled ?? referral.enable ?? true,
      accrualStrategy: referral.accrualStrategy ?? 'ON_FIRST_PAYMENT',
      rewardType: referral.rewardType ?? 'EXTRA_DAYS',
      level1Reward: String(referral.level1Reward ?? referral.pointsPerReferral ?? '5'),
      level2Reward: referral.level2Reward != null ? String(referral.level2Reward) : '',
      level3Reward: referral.level3Reward != null ? String(referral.level3Reward) : '',
      pointsPerReferral: referral.pointsPerReferral != null ? String(referral.pointsPerReferral) : '',
      qualifyOnPurchase: referral.qualifyOnPurchase ?? true,
      inviteLinkTtlDays: inviteLimits.linkTtlSeconds
        ? String(Math.round(inviteLimits.linkTtlSeconds / 86400))
        : referral.inviteLinkTtlDays != null
          ? String(referral.inviteLinkTtlDays)
          : '',
      inviteSlots: String(referral.inviteSlots ?? inviteLimits.initialSlots ?? ''),
      inviteSlotsEnabled: inviteLimits.slotsEnabled ?? false,
      linkTtlEnabled: inviteLimits.linkTtlEnabled ?? false,
      exchangeEnabled: pe.exchangeEnabled ?? false,
      daysEnabled: pe.subscriptionDays?.enabled ?? true,
      daysPointsCost: String(pe.subscriptionDays?.pointsCost ?? '1'),
      giftEnabled: pe.giftSubscription?.enabled ?? false,
      giftPointsCost: String(pe.giftSubscription?.pointsCost ?? '30'),
      giftDurationDays: String(pe.giftSubscription?.giftDurationDays ?? '30'),
      discountEnabled: pe.discount?.enabled ?? false,
      discountPointsCost: String(pe.discount?.pointsCost ?? '10'),
      discountMaxPercent: String(pe.discount?.maxDiscountPercent ?? '50'),
      trafficEnabled: pe.traffic?.enabled ?? false,
      trafficPointsCost: String(pe.traffic?.pointsCost ?? '5'),
      trafficMaxGb: String(pe.traffic?.maxTrafficGb ?? '100'),
    },
  })

  const rewardType = form.watch('rewardType')
  const linkTtlEnabled = form.watch('linkTtlEnabled')
  const inviteSlotsEnabled = form.watch('inviteSlotsEnabled')
  const exchangeEnabled = form.watch('exchangeEnabled')
  const daysEnabled = form.watch('daysEnabled')
  const giftEnabled = form.watch('giftEnabled')
  const discountEnabled = form.watch('discountEnabled')
  const trafficEnabled = form.watch('trafficEnabled')

  const saveMutation = useMutation({
    mutationFn: (values: FormValues) =>
      api.patch('/admin/settings/referral', {
        enabled: values.enabled,
        accrualStrategy: values.accrualStrategy,
        rewardType: values.rewardType,
        level1Reward: values.level1Reward ? parseInt(values.level1Reward, 10) : undefined,
        level2Reward: values.level2Reward ? parseInt(values.level2Reward, 10) : undefined,
        level3Reward: values.level3Reward ? parseInt(values.level3Reward, 10) : undefined,
        pointsPerReferral: values.pointsPerReferral
          ? parseInt(values.pointsPerReferral, 10)
          : undefined,
        qualifyOnPurchase: values.qualifyOnPurchase,
        inviteLimits: {
          linkTtlEnabled: values.linkTtlEnabled,
          linkTtlSeconds: values.inviteLinkTtlDays ? parseInt(values.inviteLinkTtlDays, 10) * 86400 : null,
          slotsEnabled: values.inviteSlotsEnabled,
          initialSlots: values.inviteSlots ? parseInt(values.inviteSlots, 10) : null,
        },
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
      toast.success(t('referralSettingsPage.saved'))
    },
    onError: () => toast.error(t('referralSettingsPage.saveFailed')),
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
                <Share2 className="h-6 w-6" /> {t('referralSettingsPage.title')}
              </h1>
              <p className="text-muted-foreground">{t('referralSettingsPage.subtitle')}</p>
            </div>
            <Button type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              {t('referralSettingsPage.save')}
            </Button>
          </div>
        </FadeIn>

        {/* General */}
        <Card>
          <CardHeader><CardTitle>{t('referralSettingsPage.general.title')}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between space-y-0">
                  <div>
                    <FormLabel>{t('referralSettingsPage.general.enable')}</FormLabel>
                    <FormDescription className="text-xs">
                      {t('referralSettingsPage.general.enableHint')}
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
              name="qualifyOnPurchase"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between space-y-0">
                  <div>
                    <FormLabel>{t('referralSettingsPage.general.qualifyOnPurchase')}</FormLabel>
                    <FormDescription className="text-xs">
                      {t('referralSettingsPage.general.qualifyOnPurchaseHint')}
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
                  <FormLabel>{t('referralSettingsPage.general.accrualStrategy')}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="ON_FIRST_PAYMENT">
                        {t('referralSettingsPage.general.onFirstPayment')}
                      </SelectItem>
                      <SelectItem value="ON_EACH_PAYMENT">
                        {t('referralSettingsPage.general.onEachPayment')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* Rewards */}
        <Card>
          <CardHeader>
            <CardTitle>{t('referralSettingsPage.rewards.title')}</CardTitle>
            <CardDescription>{t('referralSettingsPage.rewards.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="rewardType"
              render={({ field }) => (
                <FormItem className="space-y-1.5 max-w-xs">
                  <FormLabel>{t('referralSettingsPage.rewards.rewardType')}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="EXTRA_DAYS">
                        {t('referralSettingsPage.rewards.extraDays')}
                      </SelectItem>
                      <SelectItem value="POINTS">
                        {t('referralSettingsPage.rewards.points')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
            <div className="grid gap-4 sm:grid-cols-3">
              {(['level1Reward', 'level2Reward', 'level3Reward'] as const).map((name, idx) => (
                <FormField
                  key={name}
                  control={form.control}
                  name={name}
                  render={({ field }) => (
                    <FormItem className="space-y-1.5">
                      <FormLabel>
                        {idx === 0
                          ? t('referralSettingsPage.rewards.level1')
                          : idx === 1
                            ? t('referralSettingsPage.rewards.level2')
                            : t('referralSettingsPage.rewards.level3')}
                      </FormLabel>
                      <FormControl>
                        <Input type="number" min="0" placeholder="0" {...field} />
                      </FormControl>
                      <FormDescription className="text-[10px]">
                        {rewardType === 'EXTRA_DAYS'
                          ? t('referralSettingsPage.rewards.unitDays')
                          : t('referralSettingsPage.rewards.unitPoints')}
                      </FormDescription>
                    </FormItem>
                  )}
                />
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Invite Limits */}
        <Card>
          <CardHeader>
            <CardTitle>{t('referralSettingsPage.inviteLimits.title')}</CardTitle>
            <CardDescription>{t('referralSettingsPage.inviteLimits.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="linkTtlEnabled"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between space-y-0">
                  <div>
                    <FormLabel>{t('referralSettingsPage.inviteLimits.enableLinkTtl')}</FormLabel>
                    <FormDescription className="text-xs">
                      {t('referralSettingsPage.inviteLimits.enableLinkTtlHint')}
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
            {linkTtlEnabled && (
              <FormField
                control={form.control}
                name="inviteLinkTtlDays"
                render={({ field }) => (
                  <FormItem className="space-y-1.5 w-40">
                    <FormLabel>{t('referralSettingsPage.inviteLimits.linkTtlDays')}</FormLabel>
                    <FormControl>
                      <Input type="number" min="1" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            )}
            <Separator />
            <FormField
              control={form.control}
              name="inviteSlotsEnabled"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between space-y-0">
                  <div>
                    <FormLabel>{t('referralSettingsPage.inviteLimits.enableSlots')}</FormLabel>
                    <FormDescription className="text-xs">
                      {t('referralSettingsPage.inviteLimits.enableSlotsHint')}
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
            {inviteSlotsEnabled && (
              <FormField
                control={form.control}
                name="inviteSlots"
                render={({ field }) => (
                  <FormItem className="space-y-1.5 w-40">
                    <FormLabel>{t('referralSettingsPage.inviteLimits.initialSlots')}</FormLabel>
                    <FormControl>
                      <Input type="number" min="1" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            )}
          </CardContent>
        </Card>

        {/* Points Exchange */}
        <Card>
          <CardHeader>
            <CardTitle>{t('referralSettingsPage.pointsExchange.title')}</CardTitle>
            <CardDescription>{t('referralSettingsPage.pointsExchange.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="exchangeEnabled"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between space-y-0">
                  <div>
                    <FormLabel>{t('referralSettingsPage.pointsExchange.enable')}</FormLabel>
                    <FormDescription className="text-xs">
                      {t('referralSettingsPage.pointsExchange.enableHint')}
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            {exchangeEnabled && (
              <div className="space-y-4 pt-2">
                {/* Subscription Days */}
                <div className="rounded-md border p-4 space-y-3">
                  <FormField
                    control={form.control}
                    name="daysEnabled"
                    render={({ field }) => (
                      <FormItem className="flex items-center justify-between space-y-0">
                        <Label className="font-medium">
                          {t('referralSettingsPage.pointsExchange.subscriptionDays')}
                        </Label>
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  {daysEnabled && (
                    <FormField
                      control={form.control}
                      name="daysPointsCost"
                      render={({ field }) => (
                        <FormItem className="space-y-1.5 w-48">
                          <FormLabel className="text-xs">
                            {t('referralSettingsPage.pointsExchange.pointsPerDay')}
                          </FormLabel>
                          <FormControl>
                            <Input type="number" min="1" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  )}
                </div>

                {/* Gift Subscription */}
                <div className="rounded-md border p-4 space-y-3">
                  <FormField
                    control={form.control}
                    name="giftEnabled"
                    render={({ field }) => (
                      <FormItem className="flex items-center justify-between space-y-0">
                        <Label className="font-medium">
                          {t('referralSettingsPage.pointsExchange.giftSubscription')}
                        </Label>
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  {giftEnabled && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <FormField
                        control={form.control}
                        name="giftPointsCost"
                        render={({ field }) => (
                          <FormItem className="space-y-1.5">
                            <FormLabel className="text-xs">
                              {t('referralSettingsPage.pointsExchange.pointsCost')}
                            </FormLabel>
                            <FormControl>
                              <Input type="number" min="1" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="giftDurationDays"
                        render={({ field }) => (
                          <FormItem className="space-y-1.5">
                            <FormLabel className="text-xs">
                              {t('referralSettingsPage.pointsExchange.giftDuration')}
                            </FormLabel>
                            <FormControl>
                              <Input type="number" min="1" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    </div>
                  )}
                </div>

                {/* Discount */}
                <div className="rounded-md border p-4 space-y-3">
                  <FormField
                    control={form.control}
                    name="discountEnabled"
                    render={({ field }) => (
                      <FormItem className="flex items-center justify-between space-y-0">
                        <Label className="font-medium">
                          {t('referralSettingsPage.pointsExchange.personalDiscount')}
                        </Label>
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  {discountEnabled && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <FormField
                        control={form.control}
                        name="discountPointsCost"
                        render={({ field }) => (
                          <FormItem className="space-y-1.5">
                            <FormLabel className="text-xs">
                              {t('referralSettingsPage.pointsExchange.pointsPerPercent')}
                            </FormLabel>
                            <FormControl>
                              <Input type="number" min="1" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="discountMaxPercent"
                        render={({ field }) => (
                          <FormItem className="space-y-1.5">
                            <FormLabel className="text-xs">
                              {t('referralSettingsPage.pointsExchange.maxDiscount')}
                            </FormLabel>
                            <FormControl>
                              <Input type="number" min="1" max="100" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    </div>
                  )}
                </div>

                {/* Traffic */}
                <div className="rounded-md border p-4 space-y-3">
                  <FormField
                    control={form.control}
                    name="trafficEnabled"
                    render={({ field }) => (
                      <FormItem className="flex items-center justify-between space-y-0">
                        <Label className="font-medium">
                          {t('referralSettingsPage.pointsExchange.extraTraffic')}
                        </Label>
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  {trafficEnabled && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <FormField
                        control={form.control}
                        name="trafficPointsCost"
                        render={({ field }) => (
                          <FormItem className="space-y-1.5">
                            <FormLabel className="text-xs">
                              {t('referralSettingsPage.pointsExchange.pointsPerGb')}
                            </FormLabel>
                            <FormControl>
                              <Input type="number" min="1" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="trafficMaxGb"
                        render={({ field }) => (
                          <FormItem className="space-y-1.5">
                            <FormLabel className="text-xs">
                              {t('referralSettingsPage.pointsExchange.maxTraffic')}
                            </FormLabel>
                            <FormControl>
                              <Input type="number" min="1" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </form>
    </Form>
  )
}
