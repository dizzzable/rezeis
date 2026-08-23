import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Save,
  Share2,
  Loader2,
  CalendarDays,
  Coins,
  Gift,
  Percent,
  Wifi,
} from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { usePlans, type Plan } from '@/features/plans/plans-api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
} from '@/components/ui/form'
import { FadeIn } from '@/lib/motion'

type AccrualStrategy = 'ON_FIRST_PAYMENT' | 'ON_EACH_PAYMENT'
type RewardType = 'EXTRA_DAYS' | 'POINTS'

interface ReferralSettings {
  enabled?: boolean
  enable?: boolean
  invitedOnly?: boolean
  accrualStrategy?: AccrualStrategy
  rewardType?: RewardType
  level1Reward?: number | string
  level2Reward?: number | string
  pointsPerReferral?: number | string
  /** Plans whose purchase qualifies a referral. Empty/absent = every plan. */
  eligiblePlanIds?: string[]
  eligible_plan_ids?: string[]
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
    giftSubscription?: { enabled?: boolean; pointsCost?: number | string; giftDurationDays?: number | string; giftPlanId?: string | null }
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
  // The FULL catalog. `/admin/plans` returns every row including archived ones
  // (`PlansAdminService.listPlans` issues no `where`), and `plansListOptions`
  // only filters when `active` is passed. This page has two pickers asking two
  // different questions, so neither policy lives on the shared query any more
  // — see `eligiblePlanOptions` / `giftPlanOptions` below.
  const { data: plans } = usePlans()

  const numString = z.string().trim()

  const schema = z.object({
    enabled: z.boolean(),
    invitedOnly: z.boolean(),
    accrualStrategy: z.enum(['ON_FIRST_PAYMENT', 'ON_EACH_PAYMENT']),
    rewardType: z.enum(['EXTRA_DAYS', 'POINTS']),
    level1Reward: numString,
    level2Reward: numString,
    pointsPerReferral: numString,
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
    giftPlanId: numString,
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

  // Which plans count towards a referral. Kept outside the form schema (like
  // the promocode plan scope) because it is a chip multi-select, not an input.
  // Reuses the `plans` query already loaded above for the gift-plan picker.
  const [eligiblePlanIds, setEligiblePlanIds] = useState<string[]>(
    referral.eligiblePlanIds ?? referral.eligible_plan_ids ?? [],
  )
  const toggleEligiblePlan = (planId: string) =>
    setEligiblePlanIds((prev) =>
      prev.includes(planId) ? prev.filter((id) => id !== planId) : [...prev, planId],
    )

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      enabled: referral.enabled ?? referral.enable ?? true,
      invitedOnly: referral.invitedOnly ?? false,
      accrualStrategy: referral.accrualStrategy ?? 'ON_FIRST_PAYMENT',
      rewardType: referral.rewardType ?? 'EXTRA_DAYS',
      level1Reward: String(referral.level1Reward ?? referral.pointsPerReferral ?? '5'),
      level2Reward: referral.level2Reward != null ? String(referral.level2Reward) : '',
      pointsPerReferral: referral.pointsPerReferral != null ? String(referral.pointsPerReferral) : '',
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
  const rewardType = form.watch('rewardType')
  const linkTtlEnabled = form.watch('linkTtlEnabled')
  const inviteSlotsEnabled = form.watch('inviteSlotsEnabled')
  const exchangeEnabled = form.watch('exchangeEnabled')
  const daysEnabled = form.watch('daysEnabled')
  const giftEnabled = form.watch('giftEnabled')
  const discountEnabled = form.watch('discountEnabled')
  const trafficEnabled = form.watch('trafficEnabled')
  const inviteLinkTtlDays = form.watch('inviteLinkTtlDays')
  const inviteSlots = form.watch('inviteSlots')
  const giftPlanId = form.watch('giftPlanId')

  // ── Two pickers, two questions, two filters ───────────────────────────────
  //
  // Both were fed one `usePlans({ active: true })`, which gave them the same
  // answer to different questions and was wrong for each in its own way.

  /** What the platform can actually sell — mirror of `PlanCatalogService`. */
  const sellable = (plan: Plan): boolean => plan.isActive && !plan.isArchived
  const allPlans = plans ?? []

  /**
   * QUALIFYING plans — "which purchases count a referral".
   *
   * Offers only what is on sale, because a NEW qualification on a plan nobody
   * can buy is an outage in disguise: an empty selection means "every plan
   * qualifies", so a selection containing only retired plans means no purchase
   * ever qualifies again, and nothing says so.
   *
   * It also keeps every plan ALREADY selected, whatever its state. Archiving
   * or deactivating a plan used to make its chip vanish while its id stayed in
   * the saved configuration: the operator saw "N plans selected" with fewer
   * than N chips lit, could not tell which were missing, and had no way to
   * drop one short of "Clear", which drops all of them. Archiving is
   * reversible, so the setting was still live — it had just gone invisible.
   */
  const eligiblePlanOptions = allPlans.filter(
    (plan) => sellable(plan) || eligiblePlanIds.includes(plan.id),
  )

  /**
   * Selected ids with no plan behind them any more. Plans can be hard-deleted
   * (`DELETE /admin/plans/:planId`) and the id survives in
   * `referralSettings.eligiblePlanIds` forever, submitted by every save.
   * Rendered so it can be seen and removed; nothing else would ever show it.
   */
  // Only once the catalog has actually landed. `plans` is `undefined` while the
  // query is in flight, and computing this against an empty list made EVERY
  // selected plan flash up as deleted on a slow connection.
  const orphanEligiblePlanIds =
    plans === undefined
      ? []
      : eligiblePlanIds.filter((id) => !allPlans.some((plan) => plan.id === id))

  /**
   * GIFT plan — the subscription a user receives NOW for their points.
   *
   * Strictly what is on sale: this mints a NEW subscription, so a retired plan
   * should not be handed out. That is a real tightening — `active: true` let
   * archived-but-active plans through, and the deployment that prompted this
   * has three of them. The stored choice is kept in the list regardless: a
   * value the form submits has to be a value the operator can see.
   */
  const giftPlanOptions = allPlans.filter(
    (plan) => sellable(plan) || plan.id === giftPlanId,
  )

  // ── Invite-limit bounds ───────────────────────────────────────────────────
  //
  // Mirrors of the SERVER's floors, which stay the authority:
  // `ReferralInviteLimitsService` exports `MIN_LINK_TTL_SECONDS = 60` and
  // `MIN_INVITE_COUNT_SETTING = 0`, and clamps whatever is already stored
  // (with a warning) on every read. These copies exist only so the boxes can
  // say the bound out loud before a bad number is written at all — this page
  // is where the bad numbers came from, because `PATCH /admin/settings/referral`
  // takes a bare `Record<string, unknown>` and has no DTO to refuse them.
  //
  // ONE day, not sixty seconds: this box is denominated in whole days, so the
  // smallest value it can express that clears the server's 60s floor is 1.
  // "No expiry" is an EMPTY box, not a zero one — see `parseBoundedInt`.
  const MIN_LINK_TTL_DAYS = 1
  // ZERO, not one, and the `min="1"` that used to sit on this input was a bug
  // in its own right: `initialSlots: 0` is a documented, legitimate setting
  // ("this user gets no invite slots"), and the input refused to save it. The
  // broken value is a NEGATIVE — `getCapacity` floors `remainingSlots` at 0,
  // so it locks the operator's users out of inviting with no error anywhere.
  const MIN_INITIAL_SLOTS = 0

  /**
   * One operator-typed box → the number that actually goes out.
   *
   * Replaces `parseInt`, which is lenient in the worst possible direction: it
   * stops at the first character it cannot read and returns what it has, so a
   * junk box yields a PLAUSIBLE WRONG NUMBER rather than a rejection.
   * `parseInt('1e3', 10)` is 1 — and `1e3` is a valid value for
   * `<input type="number">`, so an operator asking for a 1000-day link got a
   * 1-day one with nothing on screen to say so. `Number('1e3')` is 1000.
   *
   * Empty → `null`, which is the real setting "no expiry" / "unlimited slots"
   * and must stay reachable. Anything that is not a finite number → `null`
   * too: better the safe unbounded setting than a number nobody typed.
   * `Math.trunc` then `Math.max(floor, …)` is exactly what the server's
   * `normalizeSetting` does to a stored value.
   */
  const parseBoundedInt = (raw: string, floor: number): number | null => {
    if (raw.trim() === '') return null
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return null
    return Math.max(floor, Math.trunc(parsed))
  }

  // Named on the field and held at Save, rather than left to the native
  // bubble: `min` is enforced by the browser only while the input is MOUNTED,
  // and both of these live behind a toggle. Typing a negative and then
  // switching the section off unmounted the constraint with the field and let
  // the value through — `linkTtlSeconds` and `initialSlots` are written
  // regardless of their enable flags, and the server's reader deliberately
  // leaves values behind a disabled toggle unclamped. `parseBoundedInt` is
  // what closes that path; these two only drive what the operator SEES, so
  // they follow the toggle — a held Save with no visible field to explain it
  // would be its own dead end.
  const linkTtlBelowFloor =
    linkTtlEnabled &&
    inviteLinkTtlDays.trim() !== '' &&
    Number(inviteLinkTtlDays) < MIN_LINK_TTL_DAYS
  const initialSlotsBelowFloor =
    inviteSlotsEnabled &&
    inviteSlots.trim() !== '' &&
    Number(inviteSlots) < MIN_INITIAL_SLOTS

  const saveMutation = useMutation({
    mutationFn: (values: FormValues) =>
      api.patch('/admin/settings/referral', {
        enabled: values.enabled,
        invitedOnly: values.invitedOnly,
        accrualStrategy: values.accrualStrategy,
        rewardType: values.rewardType,
        level1Reward: values.level1Reward ? parseInt(values.level1Reward, 10) : undefined,
        level2Reward: values.level2Reward ? parseInt(values.level2Reward, 10) : undefined,
        pointsPerReferral: values.pointsPerReferral
          ? parseInt(values.pointsPerReferral, 10)
          : undefined,
        // Empty list = every plan qualifies (backend only filters when non-empty).
        eligiblePlanIds,
        inviteLimits: {
          linkTtlEnabled: values.linkTtlEnabled,
          // "No expiry" is an EMPTY box, and ONLY an empty box: `parseBoundedInt`
          // maps `''` to `null` and everything else to a clamped number. A ZERO
          // box is not no-expiry — `'0'` is a non-empty string, so the old `? :`
          // here sent `0`, an invite already expired the instant it is minted.
          // It now clamps up to `MIN_LINK_TTL_DAYS` instead, which is why the
          // server's floor never has to reject anything this form can produce.
          linkTtlSeconds: (() => {
            const days = parseBoundedInt(values.inviteLinkTtlDays, MIN_LINK_TTL_DAYS)
            return days === null ? null : days * 86400
          })(),
          slotsEnabled: values.inviteSlotsEnabled,
          initialSlots: parseBoundedInt(values.inviteSlots, MIN_INITIAL_SLOTS),
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
            <Button
              type="submit"
              disabled={saveMutation.isPending || linkTtlBelowFloor || initialSlotsBelowFloor}
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              {t('referralSettingsPage.save')}
            </Button>
          </div>
        </FadeIn>

        {/* Three-column hero: General / Rewards / Invite Limits */}
        <div className="grid gap-4 lg:grid-cols-3">
          {/* General */}
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle>{t('referralSettingsPage.general.title')}</CardTitle>
            </CardHeader>
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
                name="invitedOnly"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between space-y-0">
                    <div>
                      <FormLabel>{t('referralSettingsPage.general.invitedOnly')}</FormLabel>
                      <FormDescription className="text-xs">
                        {t('referralSettingsPage.general.invitedOnlyHint')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
              {/* `qualifyOnPurchase` removed: a referral qualifies on the
                  referred user's purchase unconditionally — there is no code
                  path that reads this flag, so the switch only looked like a
                  choice. Use "Accrual strategy" below to control WHICH purchase
                  qualifies. */}
              <FormField
                control={form.control}
                name="accrualStrategy"
                render={({ field }) => (
                  <FormItem className="space-y-1.5">
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
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle>{t('referralSettingsPage.rewards.title')}</CardTitle>
              <CardDescription>{t('referralSettingsPage.rewards.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField
                control={form.control}
                name="rewardType"
                render={({ field }) => (
                  <FormItem className="space-y-1.5">
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
              {/* The referral program pays two levels (FIRST / SECOND). A third
                  level exists only in the PARTNER program, which is a separate
                  system with its own settings page — offering `level3Reward`
                  here saved a value nothing would ever read. */}
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
                {(['level1Reward', 'level2Reward'] as const).map((name, idx) => (
                  <FormField
                    key={name}
                    control={form.control}
                    name={name}
                    render={({ field }) => (
                      <FormItem className="space-y-1.5">
                        <FormLabel className="text-xs">
                          {idx === 0
                            ? t('referralSettingsPage.rewards.level1')
                            : t('referralSettingsPage.rewards.level2')}
                        </FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min="0"
                            placeholder="0"
                            className="h-8 text-sm"
                            {...field}
                          />
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

              {/* Qualification scope. A referral is always earned by a PURCHASE
                  — this narrows WHICH purchases count, which is the real
                  anti-abuse lever (e.g. don't pay out for a trial or the
                  cheapest plan). Empty selection = every plan qualifies. */}
              <div className="space-y-2 pt-1">
                <div className="flex items-center justify-between gap-2">
                  <FormLabel className="text-xs">
                    {t('referralSettingsPage.rewards.eligiblePlans')}
                  </FormLabel>
                  {eligiblePlanIds.length > 0 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => setEligiblePlanIds([])}
                    >
                      {t('referralSettingsPage.rewards.eligiblePlansClear')}
                    </Button>
                  ) : null}
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {eligiblePlanOptions.map((p) => {
                    const selected = eligiblePlanIds.includes(p.id)
                    // Shown only because it is already selected. Marked so the
                    // operator knows why it is here and what state it is in.
                    const retired = !sellable(p)
                    return (
                      <Button
                        key={p.id}
                        type="button"
                        variant={selected ? 'default' : 'outline'}
                        size="sm"
                        className="h-auto min-h-9 justify-start whitespace-normal py-1.5 text-left text-xs"
                        onClick={() => toggleEligiblePlan(p.id)}
                        aria-pressed={selected}
                      >
                        {p.name}
                        {retired ? (
                          <span className="ml-1 text-[10px] uppercase tracking-wide opacity-70">
                            {p.isArchived
                              ? t('referralSettingsPage.rewards.eligiblePlanArchived')
                              : t('referralSettingsPage.rewards.eligiblePlanInactive')}
                          </span>
                        ) : null}
                      </Button>
                    )
                  })}
                  {orphanEligiblePlanIds.map((id) => (
                    <Button
                      key={id}
                      type="button"
                      variant="default"
                      size="sm"
                      className="h-auto min-h-9 justify-start whitespace-normal py-1.5 text-left text-xs"
                      onClick={() => toggleEligiblePlan(id)}
                      aria-pressed={true}
                    >
                      {t('referralSettingsPage.rewards.eligiblePlanMissing', {
                        id: id.slice(0, 8),
                      })}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {eligiblePlanIds.length === 0
                    ? t('referralSettingsPage.rewards.eligiblePlansAllHint')
                    : t('referralSettingsPage.rewards.eligiblePlansHint', {
                        count: eligiblePlanIds.length,
                      })}
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Invite Limits */}
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle>{t('referralSettingsPage.inviteLimits.title')}</CardTitle>
              <CardDescription>
                {t('referralSettingsPage.inviteLimits.description')}
              </CardDescription>
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
                    <FormItem className="space-y-1.5">
                      <FormLabel className="text-xs">
                        {t('referralSettingsPage.inviteLimits.linkTtlDays')}
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={MIN_LINK_TTL_DAYS}
                          className="h-8 text-sm"
                          aria-invalid={linkTtlBelowFloor}
                          {...field}
                        />
                      </FormControl>
                      {/* `FormDescription` rather than a bare <p>: it carries the
                          id `FormControl` already points `aria-describedby` at, so
                          the bound is announced with the field instead of only
                          being visible next to it. */}
                      <FormDescription
                        className={
                          linkTtlBelowFloor
                            ? 'text-xs text-destructive'
                            : 'text-xs text-muted-foreground'
                        }
                      >
                        {t('referralSettingsPage.inviteLimits.linkTtlMin', {
                          min: MIN_LINK_TTL_DAYS,
                        })}
                      </FormDescription>
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
                    <FormItem className="space-y-1.5">
                      <FormLabel className="text-xs">
                        {t('referralSettingsPage.inviteLimits.initialSlots')}
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={MIN_INITIAL_SLOTS}
                          className="h-8 text-sm"
                          aria-invalid={initialSlotsBelowFloor}
                          {...field}
                        />
                      </FormControl>
                      <FormDescription
                        className={
                          initialSlotsBelowFloor
                            ? 'text-xs text-destructive'
                            : 'text-xs text-muted-foreground'
                        }
                      >
                        {t('referralSettingsPage.inviteLimits.initialSlotsMin', {
                          min: MIN_INITIAL_SLOTS,
                        })}
                      </FormDescription>
                    </FormItem>
                  )}
                />
              )}
            </CardContent>
          </Card>
        </div>

        {/* Points Exchange — full-width with 4 sub-cards in 2x2 grid */}
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
