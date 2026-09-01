import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { usePlans } from '@/features/plans/plans-api'

const REWARD_TYPES = [
  'DURATION',
  'TRAFFIC',
  'DEVICES',
  'SUBSCRIPTION',
  'PERSONAL_DISCOUNT',
  'PURCHASE_DISCOUNT',
] as const
const AVAILABILITIES = ['ALL', 'NEW', 'EXISTING', 'INVITED', 'ALLOWED'] as const

/**
 * Reward types that apply to an existing subscription (extend duration / add
 * traffic / add devices). Only these consult the promocode's `allowedPlanIds`
 * eligibility filter on the backend (`resolveTargetSubscription` →
 * `PLAN_NOT_ELIGIBLE`). SUBSCRIPTION carries its own plan (the reward) and the
 * discount types are user-scoped, so the plan filter is hidden for them.
 */
const PLAN_SCOPED_REWARDS: readonly string[] = ['DURATION', 'TRAFFIC', 'DEVICES']

export interface PromocodePlanSnapshot {
  id: string
  name: string
  type: string
  deviceLimit: number
  trafficLimit?: number | null
  trafficLimitStrategy: string
  internalSquads: string[]
  externalSquad?: string | null
  duration?: number
  tag?: string | null
  description?: string | null
}

/**
 * One extra thing the code does, beside the main action above it.
 *
 * ── Why "extra" and not a flat list ───────────────────────────────────────
 *
 * The main action keeps the form it always had — a type, a value, and for
 * SUBSCRIPTION a plan and duration picker. Folding that into a generic row
 * would put a plan picker inside a list item and make the common case (one
 * action, which is most codes) heavier than it is today, to serve the rarer
 * one. So the list starts where the form used to end.
 */
export interface PromocodeActionInput {
  type: string
  value?: number | null
  /** PURCHASE_DISCOUNT only: plans the granted discount may be spent on. */
  discountAllowedPlanIds?: string[]
  /** PURCHASE_DISCOUNT only: how long the grant stays spendable. */
  discountValidForDays?: number | null
}

export interface PromocodeFormData {
  code: string
  rewardType: string
  reward?: number
  /**
   * Everything the code does, main action first. Sent alongside the legacy
   * fields, which the API rewrites from this list's first entry — so a panel
   * and an API on different versions cannot describe different offers.
   */
  actions?: PromocodeActionInput[]
  availability: string
  isActive: boolean
  lifetime?: number
  maxActivations?: number
  allowedPlanIds?: string[]
  /** Plan snapshot for the SUBSCRIPTION reward type. */
  plan?: PromocodePlanSnapshot
  /** Absolute expiry (ISO 8601) or null for none. */
  expiresAt?: string | null
}

interface ExistingPromocode {
  readonly code?: string
  readonly actions?: readonly {
    readonly type: string
    readonly value: number | null
    readonly discountAllowedPlanIds?: readonly string[]
    readonly discountValidForDays?: number | null
  }[]
  readonly rewardType?: string
  readonly reward?: number | string
  readonly availability?: string
  readonly isActive?: boolean
  readonly lifetime?: number | string
  readonly maxActivations?: number | string
  readonly allowedPlanIds?: readonly string[]
  readonly expiresAt?: string | null
}

interface Props {
  promo?: ExistingPromocode
  onSubmit: (data: PromocodeFormData) => void
  isLoading: boolean
}

export function PromocodeForm({ promo, onSubmit, isLoading }: Props) {
  const { t } = useTranslation()
  const [code, setCode] = useState(promo?.code ?? '')
  // Everything past the main action. Seeded by dropping the first stored
  // action, which the fields above already represent — keeping it would render
  // the main action twice.
  // The restrictions the MAIN action's discount carries, when it is one.
  // Distinct from `allowedPlanIds` below, which says where the CODE may be
  // activated: this says where the granted discount may be SPENT, weeks later
  // and possibly on a different plan.
  const [mainDiscountPlanIds, setMainDiscountPlanIds] = useState<string[]>(() => [
    ...(promo?.actions?.[0]?.discountAllowedPlanIds ?? []),
  ])
  const [mainDiscountDays, setMainDiscountDays] = useState(
    promo?.actions?.[0]?.discountValidForDays?.toString() ?? '',
  )
  const [extraActions, setExtraActions] = useState<PromocodeActionInput[]>(() =>
    (promo?.actions ?? []).slice(1).map((action) => ({
      type: action.type,
      value: action.value,
      discountAllowedPlanIds: [...(action.discountAllowedPlanIds ?? [])],
      discountValidForDays: action.discountValidForDays ?? null,
    })),
  )
  const [rewardType, setRewardType] = useState(promo?.rewardType ?? 'DURATION')
  const [reward, setReward] = useState(promo?.reward?.toString() ?? '7')
  const [availability, setAvailability] = useState(promo?.availability ?? 'ALL')
  const [isActive, setIsActive] = useState(promo?.isActive ?? true)
  const [lifetime, setLifetime] = useState(promo?.lifetime?.toString() ?? '-1')
  const [maxActivations, setMaxActivations] = useState(promo?.maxActivations?.toString() ?? '-1')
  // Absolute expiry: a calendar date + a HH:mm time. Empty date = no deadline.
  const initialExpiry = promo?.expiresAt ? new Date(promo.expiresAt) : undefined
  const [expiresDate, setExpiresDate] = useState<Date | undefined>(
    initialExpiry && !Number.isNaN(initialExpiry.getTime()) ? initialExpiry : undefined,
  )
  const [expiresTime, setExpiresTime] = useState(
    initialExpiry && !Number.isNaN(initialExpiry.getTime())
      ? `${String(initialExpiry.getHours()).padStart(2, '0')}:${String(initialExpiry.getMinutes()).padStart(2, '0')}`
      : '23:59',
  )

  // Load plans for SUBSCRIPTION reward (the reward itself) and for the
  // plan-scoped reward types (eligibility filter). Fetch once either is active.
  // A PURCHASE_DISCOUNT now picks plans too — the ones its granted discount may
  // be spent on — so the plan list is needed for it as well.
  const usesDiscountPlans =
    rewardType === 'PURCHASE_DISCOUNT' ||
    extraActions.some((action) => action.type === 'PURCHASE_DISCOUNT')
  const needsPlans =
    rewardType === 'SUBSCRIPTION' ||
    PLAN_SCOPED_REWARDS.includes(rewardType) ||
    usesDiscountPlans
  const { data: plans } = usePlans(undefined, { enabled: needsPlans })
  const [selectedPlanId, setSelectedPlanId] = useState('')
  const [selectedDuration, setSelectedDuration] = useState('')
  const selectedPlan = plans?.find((p) => p.id === selectedPlanId)
  const planDurations = (selectedPlan?.durations ?? []).filter((d) => d.isActive)

  // Plan-eligibility filter (`allowedPlanIds`): which existing plans a
  // DURATION/TRAFFIC/DEVICES promo may be activated against. Empty = all plans.
  const [allowedPlanIds, setAllowedPlanIds] = useState<string[]>(
    promo?.allowedPlanIds ? [...promo.allowedPlanIds] : [],
  )
  const togglePlanScope = (planId: string) => {
    setAllowedPlanIds((prev) =>
      prev.includes(planId) ? prev.filter((id) => id !== planId) : [...prev, planId],
    )
  }

  const generateCode = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    let result = ''
    for (let i = 0; i < 8; i++) result += chars[Math.floor(Math.random() * chars.length)]
    setCode(result)
  }

  /**
   * A type may appear once. The database enforces the same thing, and the API
   * refuses a duplicate before it gets there — offering one here would only be
   * a way to reach that error.
   *
   * SUBSCRIPTION is excluded from the extras entirely: it replaces the
   * subscription every other action mutates, so it always runs first, and the
   * main block above is where that is set.
   */
  const isTypeAvailable = (type: string, exceptIndex: number): boolean => {
    if (type === 'SUBSCRIPTION') return false
    if (type === rewardType) return false
    return !extraActions.some((action, i) => i !== exceptIndex && action.type === type)
  }
  const availableExtraTypes = REWARD_TYPES.filter((rt) => isTypeAvailable(rt, -1))

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    let expiresAt: string | null = null
    if (expiresDate) {
      const [hh, mm] = expiresTime.split(':').map((n) => Number.parseInt(n, 10))
      const merged = new Date(expiresDate)
      merged.setHours(Number.isFinite(hh) ? hh : 23, Number.isFinite(mm) ? mm : 59, 0, 0)
      expiresAt = merged.toISOString()
    }
    let plan: PromocodePlanSnapshot | undefined
    if (rewardType === 'SUBSCRIPTION' && selectedPlan) {
      plan = {
        id: selectedPlan.id,
        name: selectedPlan.name,
        type: selectedPlan.type,
        deviceLimit: selectedPlan.deviceLimit,
        trafficLimit: selectedPlan.trafficLimit,
        trafficLimitStrategy: selectedPlan.trafficLimitStrategy,
        internalSquads: [...selectedPlan.internalSquads],
        externalSquad: selectedPlan.externalSquad,
        ...(selectedDuration ? { duration: Number.parseInt(selectedDuration, 10) } : {}),
        tag: selectedPlan.tag,
        description: selectedPlan.description,
      }
    }
    // Plan-eligibility filter only applies to subscription-targeting rewards.
    const planScope =
      PLAN_SCOPED_REWARDS.includes(rewardType) && allowedPlanIds.length > 0
        ? allowedPlanIds
        : []
    const mainValue = rewardType !== 'SUBSCRIPTION' ? parseInt(reward, 10) : undefined
    const actions: PromocodeActionInput[] = [
      {
        type: rewardType,
        value: mainValue ?? null,
        ...(rewardType === 'PURCHASE_DISCOUNT'
          ? {
              discountAllowedPlanIds: [...mainDiscountPlanIds],
              discountValidForDays: mainDiscountDays.trim().length > 0
                ? Number.parseInt(mainDiscountDays, 10)
                : null,
            }
          : {}),
      },
      ...extraActions
        .filter((action) => action.type.length > 0)
        .map((action) => ({
          type: action.type,
          value: action.value ?? null,
          ...(action.type === 'PURCHASE_DISCOUNT'
            ? {
                discountAllowedPlanIds: [...(action.discountAllowedPlanIds ?? [])],
                discountValidForDays: action.discountValidForDays ?? null,
              }
            : {}),
        })),
    ]
    onSubmit({
      code: code.toUpperCase(),
      actions,
      rewardType,
      reward: mainValue,
      availability,
      isActive,
      lifetime: parseInt(lifetime, 10),
      maxActivations: parseInt(maxActivations, 10),
      allowedPlanIds: planScope,
      ...(plan ? { plan } : {}),
      expiresAt,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Code */}
      <div className="space-y-2">
        <Label>{t('promocodeForm.code')} *</Label>
        <div className="flex gap-2">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={t('promocodeFormExtras.codePlaceholder')}
            className="font-mono uppercase"
            required
          />
          <Button type="button" variant="outline" onClick={generateCode}>
            {t('promocodeForm.generate')}
          </Button>
        </div>
      </div>

      <Separator />

      {/* Reward Type */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label>{t('promocodeForm.rewardType')}</Label>
          <Select value={rewardType} onValueChange={setRewardType}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REWARD_TYPES.map((rt) => (
                <SelectItem key={rt} value={rt}>
                  {t(`promocodeForm.rewardTypes.${rt}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {rewardType !== 'SUBSCRIPTION' ? (
          <div className="space-y-2">
            <Label>{t(`promocodeForm.rewardLabels.${rewardType}`)}</Label>
            <Input
              type="number"
              value={reward}
              onChange={(e) => setReward(e.target.value)}
              min="1"
            />
          </div>
        ) : null}
      </div>

      {/* Where the MAIN action's discount may be spent */}
      {rewardType === 'PURCHASE_DISCOUNT' ? (
        <div className="space-y-3 rounded-md border border-border/60 p-3">
          <p className="text-xs text-muted-foreground">
            {t('promocodeForm.discountScopeHint')}
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{t('promocodeForm.discountPlans')}</Label>
              <div className="flex flex-wrap gap-2">
                {(plans ?? [])
                  .filter((p) => !p.isArchived)
                  .map((p) => (
                    <Button
                      key={p.id}
                      type="button"
                      size="sm"
                      variant={mainDiscountPlanIds.includes(p.id) ? 'default' : 'outline'}
                      onClick={() =>
                        setMainDiscountPlanIds((prev) =>
                          prev.includes(p.id)
                            ? prev.filter((id) => id !== p.id)
                            : [...prev, p.id],
                        )
                      }
                    >
                      {p.name}
                    </Button>
                  ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('promocodeForm.discountPlansEmpty')}
              </p>
            </div>
            <div className="space-y-2">
              <Label>{t('promocodeForm.discountValidForDays')}</Label>
              <Input
                type="number"
                min="1"
                value={mainDiscountDays}
                onChange={(e) => setMainDiscountDays(e.target.value)}
                placeholder={t('promocodeForm.discountValidForDaysPlaceholder')}
              />
            </div>
          </div>
        </div>
      ) : null}

      {/* Everything else the code does */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>{t('promocodeForm.extraActions')}</Label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={availableExtraTypes.length === 0}
            onClick={() =>
              setExtraActions((prev) => [
                ...prev,
                { type: availableExtraTypes[0] ?? '', value: null },
              ])
            }
          >
            {t('promocodeForm.addAction')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('promocodeForm.extraActionsHint')}</p>
        {extraActions.map((action, index) => (
          <div key={index} className="space-y-3 rounded-md border border-border/60 p-3">
            <div className="grid gap-4 md:grid-cols-[1fr_1fr_auto]">
              <div className="space-y-2">
                <Label>{t('promocodeForm.rewardType')}</Label>
                <Select
                  value={action.type}
                  onValueChange={(value) =>
                    setExtraActions((prev) =>
                      prev.map((item, i) => (i === index ? { ...item, type: value } : item)),
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REWARD_TYPES.filter(
                      (rt) => rt === action.type || isTypeAvailable(rt, index),
                    ).map((rt) => (
                      <SelectItem key={rt} value={rt}>
                        {t(`promocodeForm.rewardTypes.${rt}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {action.type === 'SUBSCRIPTION' ? (
                <p className="self-end text-xs text-muted-foreground">
                  {t('promocodeForm.subscriptionMainOnly')}
                </p>
              ) : (
                <div className="space-y-2">
                  <Label>{t(`promocodeForm.rewardLabels.${action.type}`)}</Label>
                  <Input
                    type="number"
                    min="1"
                    value={action.value?.toString() ?? ''}
                    onChange={(e) =>
                      setExtraActions((prev) =>
                        prev.map((item, i) =>
                          i === index
                            ? {
                                ...item,
                                value:
                                  e.target.value.trim().length > 0
                                    ? Number.parseInt(e.target.value, 10)
                                    : null,
                              }
                            : item,
                        ),
                      )
                    }
                  />
                </div>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="self-end text-destructive"
                aria-label={t('promocodeForm.removeAction')}
                onClick={() =>
                  setExtraActions((prev) => prev.filter((_, i) => i !== index))
                }
              >
                {t('promocodeForm.removeAction')}
              </Button>
            </div>
            {action.type === 'PURCHASE_DISCOUNT' ? (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>{t('promocodeForm.discountPlans')}</Label>
                  <div className="flex flex-wrap gap-2">
                    {(plans ?? [])
                      .filter((p) => !p.isArchived)
                      .map((p) => (
                        <Button
                          key={p.id}
                          type="button"
                          size="sm"
                          variant={
                            (action.discountAllowedPlanIds ?? []).includes(p.id)
                              ? 'default'
                              : 'outline'
                          }
                          onClick={() =>
                            setExtraActions((prev) =>
                              prev.map((item, i) => {
                                if (i !== index) return item
                                const current = item.discountAllowedPlanIds ?? []
                                return {
                                  ...item,
                                  discountAllowedPlanIds: current.includes(p.id)
                                    ? current.filter((id) => id !== p.id)
                                    : [...current, p.id],
                                }
                              }),
                            )
                          }
                        >
                          {p.name}
                        </Button>
                      ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>{t('promocodeForm.discountValidForDays')}</Label>
                  <Input
                    type="number"
                    min="1"
                    value={action.discountValidForDays?.toString() ?? ''}
                    onChange={(e) =>
                      setExtraActions((prev) =>
                        prev.map((item, i) =>
                          i === index
                            ? {
                                ...item,
                                discountValidForDays:
                                  e.target.value.trim().length > 0
                                    ? Number.parseInt(e.target.value, 10)
                                    : null,
                              }
                            : item,
                        ),
                      )
                    }
                    placeholder={t('promocodeForm.discountValidForDaysPlaceholder')}
                  />
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <Separator />

      {/* Plan + duration selector for SUBSCRIPTION reward */}
      {rewardType === 'SUBSCRIPTION' ? (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>{t('promocodeForm.plan')}</Label>
            <Select
              value={selectedPlanId}
              onValueChange={(v) => {
                setSelectedPlanId(v)
                setSelectedDuration('')
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('promocodeForm.planPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {(plans ?? [])
                  .filter((p) => !p.isArchived)
                  .map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t('promocodeForm.planDuration')}</Label>
            <Select
              value={selectedDuration}
              onValueChange={setSelectedDuration}
              disabled={!selectedPlan || planDurations.length === 0}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('promocodeForm.planDurationPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {planDurations.map((d) => (
                  <SelectItem key={d.id} value={String(d.days)}>
                    {t('promocodeForm.planDurationDays', { count: d.days })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t('promocodeForm.planHint')}</p>
          </div>
        </div>
      ) : null}

      {/* Reward type description */}
      <div className="text-xs text-muted-foreground bg-muted/50 rounded-md p-3">
        {t(`promocodeForm.rewardDescriptions.${rewardType}`)}
      </div>

      {/* Plan-eligibility filter for subscription-targeting rewards */}
      {PLAN_SCOPED_REWARDS.includes(rewardType) ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label>{t('promocodeForm.allowedPlans')}</Label>
            {allowedPlanIds.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setAllowedPlanIds([])}
              >
                {t('promocodeForm.allowedPlansClear')}
              </Button>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {(plans ?? [])
              .filter((p) => !p.isArchived)
              .map((p) => {
                const selected = allowedPlanIds.includes(p.id)
                return (
                  <Button
                    key={p.id}
                    type="button"
                    variant={selected ? 'default' : 'outline'}
                    size="sm"
                    className="h-auto min-h-9 justify-start whitespace-normal py-1.5 text-left text-xs"
                    onClick={() => togglePlanScope(p.id)}
                    aria-pressed={selected}
                  >
                    {p.name}
                  </Button>
                )
              })}
          </div>
          <p className="text-xs text-muted-foreground">
            {allowedPlanIds.length === 0
              ? t('promocodeForm.allowedPlansAllHint')
              : t('promocodeForm.allowedPlansHint', { count: allowedPlanIds.length })}
          </p>
        </div>
      ) : null}

      <Separator />

      {/* Availability & Limits */}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-2">
          <Label>{t('promocodeForm.availability')}</Label>
          <Select value={availability} onValueChange={setAvailability}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AVAILABILITIES.map((a) => (
                <SelectItem key={a} value={a}>
                  {t(`promocodeForm.availabilities.${a}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>{t('promocodeForm.lifetime')}</Label>
          <Input
            type="number"
            value={lifetime}
            onChange={(e) => setLifetime(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('promocodeForm.lifetimeHint')}</p>
        </div>
        <div className="space-y-2">
          <Label>{t('promocodeForm.maxActivations')}</Label>
          <Input
            type="number"
            value={maxActivations}
            onChange={(e) => setMaxActivations(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('promocodeForm.maxActivationsHint')}</p>
        </div>
      </div>

      {/* Absolute expiry — calendar date + time */}
      <div className="space-y-2">
        <Label>{t('promocodeForm.expiresAt')}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <DatePicker
            value={expiresDate}
            onChange={setExpiresDate}
            className="w-48"
            placeholder={t('promocodeForm.expiresNever')}
          />
          <Input
            type="time"
            value={expiresTime}
            onChange={(e) => setExpiresTime(e.target.value)}
            disabled={!expiresDate}
            className="w-32"
            aria-label={t('promocodeForm.expiresTime')}
          />
          {expiresDate ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setExpiresDate(undefined)}
            >
              {t('promocodeForm.expiresClear')}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{t('promocodeForm.expiresAtHint')}</p>
      </div>

      <Separator />

      {/* Active toggle */}
      <div className="flex items-center gap-3">
        <Switch checked={isActive} onCheckedChange={setIsActive} />
        <Label>{t('promocodeForm.active')}</Label>
      </div>

      <Button
        type="submit"
        className="w-full"
        disabled={isLoading || !code || (rewardType === 'SUBSCRIPTION' && (!selectedPlanId || !selectedDuration))}
      >
        {promo ? t('promocodeForm.update') : t('promocodeForm.create')}
      </Button>
    </form>
  )
}
