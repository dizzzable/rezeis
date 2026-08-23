import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus, Trash2, Archive, ArrowUpRight, Users, Check, ChevronDown, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useForm, type FieldErrors, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Link } from 'react-router'

import { DataUnavailable } from '@/components/data-unavailable'
import { Badge, badgeVariants } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/http-errors'
import { cn, truncate } from '@/lib/utils'
import { remnawaveApi } from '@/features/remnawave/remnawave-api'
import { IconPicker } from '@/features/settings/icon-picker'
import { EmojiTextInput } from '@/features/broadcast/emoji-text-input'
import { usePlans, type Plan } from './plans-api'
import {
  describePlanLimitChanges,
  summarizePlanLimitDirection,
  type PlanLimitChange,
} from './plan-limit-scope'
import {
  selectableTransitionTargets,
  strandedTransitionTargets,
  type StrandedTransitionTarget,
} from './plan-transition-targets'
import {
  PLAN_AVAILABILITIES,
  PLAN_CURRENCIES,
  PLAN_TRAFFIC_STRATEGIES,
  PLAN_TYPES,
  TAG_PATTERN,
  TAG_SANITIZE,
  createPlanFormSchema,
  type PlanFormData,
  type PlanFormDraft,
  type PlanFormValidationMessages,
} from './plan-form-schema'

export type { PlanFormData } from './plan-form-schema'

interface PlanInput extends Partial<Plan> {
  /**
   * Backend-only field for archived plans, not present in the public
   * catalog. Tells the renew engine how to migrate active subscriptions
   * (`SELF_RENEW`, `UPGRADE`, `REPLACE`).
   */
  archivedRenewMode?: string
}

interface Props {
  plan?: PlanInput
  onSubmit: (data: PlanFormData) => void
  isLoading: boolean
}

export function PlanForm({ plan, onSubmit, isLoading }: Props) {
  const { t } = useTranslation()
  const validationMessages = useMemo<PlanFormValidationMessages>(() => ({
    nameRequired: t('planForm.validation.nameRequired'),
    nameTooLong: t('planForm.validation.nameTooLong'),
    descriptionTooLong: t('planForm.validation.descriptionTooLong'),
    tagInvalid: t('planForm.tagInvalid'),
    iconTooLong: t('planForm.validation.iconTooLong'),
    planTypeInvalid: t('planForm.validation.planTypeInvalid'),
    availabilityInvalid: t('planForm.validation.availabilityInvalid'),
    trafficLimitInvalid: t('planForm.validation.trafficLimitInvalid'),
    deviceLimitInvalid: t('planForm.validation.deviceLimitInvalid'),
    resetStrategyInvalid: t('planForm.validation.resetStrategyInvalid'),
    trialMaxClaimsInvalid: t('planForm.validation.trialMaxClaimsInvalid'),
    durationRequired: t('planForm.validation.durationRequired'),
    durationDaysInvalid: t('planForm.validation.durationDaysInvalid'),
    durationDuplicate: t('planForm.validation.durationDuplicate'),
    trialDurationCount: t('planForm.validation.trialDurationCount'),
    priceRequired: t('planForm.validation.priceRequired'),
    priceInvalid: t('planForm.validation.priceInvalid'),
    currencyInvalid: t('planForm.validation.currencyInvalid'),
    currencyDuplicate: t('planForm.validation.currencyDuplicate'),
    paidTrialPriceRequired: t('planForm.validation.paidTrialPriceRequired'),
    replacementRequired: t('planForm.validation.replacementRequired'),
    allowedUsersRequired: t('planForm.validation.allowedUsersRequired'),
  }), [t])
  const planFormSchema = useMemo(() => createPlanFormSchema(validationMessages), [validationMessages])
  const initialDraft = useMemo(() => createInitialPlanDraft(plan), [plan])
  const form = useForm<PlanFormDraft, unknown, PlanFormData>({
    defaultValues: initialDraft,
    mode: 'onSubmit',
    reValidateMode: 'onBlur',
    resolver: zodResolver(planFormSchema) as Resolver<PlanFormDraft, unknown, PlanFormData>,
  })
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [name, setName] = useState(initialDraft.name)
  const [description, setDescription] = useState(initialDraft.description)
  const [tag, setTag] = useState(initialDraft.tag)
  const [icon, setIcon] = useState<string | null>(initialDraft.icon)
  const [type, setType] = useState(initialDraft.type)
  const [availability, setAvailability] = useState(initialDraft.availability)
  const [trafficLimitGB, setTrafficLimitGB] = useState(initialDraft.trafficLimitGB)
  const [deviceLimit, setDeviceLimit] = useState(initialDraft.deviceLimit)
  const [trafficStrategy, setTrafficStrategy] = useState(initialDraft.trafficLimitStrategy)
  const [selectedInternalSquads, setSelectedInternalSquads] = useState<string[]>(
    [...initialDraft.internalSquads],
  )
  const [externalSquad, setExternalSquad] = useState(initialDraft.externalSquad)

  // Archive & transition state
  const [isArchived, setIsArchived] = useState(initialDraft.isArchived)
  const [archivedRenewMode, setArchivedRenewMode] = useState(initialDraft.archivedRenewMode)
  const [upgradeToPlanIds, setUpgradeToPlanIds] = useState<string[]>(
    [...initialDraft.upgradeToPlanIds],
  )
  const [replacementPlanIds, setReplacementPlanIds] = useState<string[]>(
    [...initialDraft.replacementPlanIds],
  )
  const [allowedUserIds, setAllowedUserIds] = useState<string[]>(
    [...initialDraft.allowedUserIds],
  )
  const [newAllowedUserId, setNewAllowedUserId] = useState('')
  // Friendly labels for resolved allowed users (reiwa_id → "Name · TG 123").
  const [allowedUserLabels, setAllowedUserLabels] = useState<Record<string, string>>({})
  const [resolvingAllowedUser, setResolvingAllowedUser] = useState(false)

  // Trial config (only meaningful when availability === 'TRIAL')
  const [trialMaxClaims, setTrialMaxClaims] = useState(initialDraft.trialSettings.maxClaims)
  const [trialFree, setTrialFree] = useState(initialDraft.trialSettings.free)
  const [trialScope, setTrialScope] = useState<'ALL' | 'INVITED'>(initialDraft.trialSettings.availabilityScope)
  const [trialRequireTelegram, setTrialRequireTelegram] = useState(initialDraft.trialSettings.requireTelegramLink)

  const [durations, setDurations] = useState<
    { days: string; prices: { currency: string; price: string }[] }[]
  >(initialDraft.durations.map((d) => ({
    days: d.days,
    prices: d.prices.map((p) => ({ currency: p.currency, price: p.price })),
  })))

  const internalSquadsQuery = useQuery({
    queryKey: ['remnawave', 'internal-squads'],
    queryFn: remnawaveApi.getInternalSquads,
    retry: 1,
  })
  const externalSquadsQuery = useQuery({
    queryKey: ['remnawave', 'external-squads'],
    queryFn: remnawaveApi.getExternalSquads,
    retry: 1,
  })
  const { data: internalSquads } = internalSquadsQuery
  const { data: externalSquads } = externalSquadsQuery
  // "No squads available" on a disabled control is a claim about the
  // operator's Remnawave panel. It is only true once the panel has answered.
  const internalSquadsUnavailable =
    internalSquadsQuery.isError ||
    (!internalSquadsQuery.isPending && internalSquads === undefined)
  const externalSquadsUnavailable =
    externalSquadsQuery.isError ||
    (!externalSquadsQuery.isPending && externalSquads === undefined)

  // Who may be OFFERED as an upgrade or replacement target.
  //
  // `selectableTransitionTargets` is the server's rule, not a convenience
  // filter. This was `p.isActive && !p.isArchived`, which is strictly wider
  // than the backend's `ASSIGNABLE_TRANSITION_AVAILABILITIES` and therefore
  // offered TRIAL plans the write refuses. An operator picked one and was told
  // so in English, naming a cuid that appeared nowhere on this form.
  const plansQuery = usePlans()
  const { data: allPlans } = plansQuery
  const otherPlans = useMemo(
    () => selectableTransitionTargets(allPlans, plan?.id),
    [allPlans, plan?.id],
  )

  // Targets that are SELECTED but no longer selectable — archived, switched
  // off, converted to a trial, or deleted since the day they were saved. They
  // stay in state and keep being submitted, so the operator has to be able to
  // see them and take them off; that is the half of the defect that made the
  // plan permanently unsaveable.
  //
  // GATED ON THE CATALOG HAVING RESOLVED. `strandedTransitionTargets` answers
  // `[]` while `allPlans` is undefined and that answer means "not known yet",
  // NOT "nothing is wrong" — without this gate the form opens clean and sprouts
  // warnings a moment later, which reads as the panel changing its mind.
  const catalogResolved = !plansQuery.isPending && allPlans !== undefined
  const strandedUpgrades = useMemo(
    () => (catalogResolved ? strandedTransitionTargets(allPlans, upgradeToPlanIds, plan?.id) : []),
    [catalogResolved, allPlans, upgradeToPlanIds, plan?.id],
  )
  // Bound to `isArchived`, deliberately NOT to the renewal mode.
  // `plan-form-schema.ts:195` submits `replacementPlanIds` whenever the plan is
  // archived, while the picker below only exists under REPLACE_ON_RENEW — so a
  // SELF_RENEW plan submits ids that no control on the form renders. Everything
  // that is submitted is shown; nothing that is dropped raises an alarm.
  const strandedReplacements = useMemo(
    () =>
      catalogResolved && isArchived
        ? strandedTransitionTargets(allPlans, replacementPlanIds, plan?.id)
        : [],
    [catalogResolved, isArchived, allPlans, replacementPlanIds, plan?.id],
  )

  // What the operator is told INSTEAD of a round trip. Keyed under names of
  // their own rather than `replacementPlanIds`, which the schema already owns:
  // both messages can then be on screen at once, and neither overwrites the
  // other's field error.
  const strandedErrors = useMemo<Record<string, string>>(() => {
    const errors: Record<string, string> = {}
    if (strandedUpgrades.length > 0) {
      errors.upgradeToPlanIdsStranded = t('planForm.transitions.strandedUpgradeError', {
        plans: strandedUpgrades.map(strandedTargetLabel).join(', '),
      })
    }
    if (strandedReplacements.length > 0) {
      errors.replacementPlanIdsStranded = t('planForm.transitions.strandedReplacementError', {
        plans: strandedReplacements.map(strandedTargetLabel).join(', '),
      })
    }
    return errors
  }, [strandedUpgrades, strandedReplacements, t])

  const addDuration = () => {
    setDurations([...durations, { days: '30', prices: [{ currency: 'RUB', price: '0' }] }])
  }

  const removeDuration = (idx: number) => {
    setDurations(durations.filter((_, i) => i !== idx))
  }

  const updateDuration = (idx: number, field: string, value: string) => {
    const updated = [...durations]
    updated[idx] = { ...updated[idx], [field]: value }
    setDurations(updated)
  }

  const addPrice = (dIdx: number) => {
    const updated = [...durations]
    updated[dIdx].prices.push({ currency: 'USD', price: '0' })
    setDurations(updated)
  }

  const removePrice = (dIdx: number, pIdx: number) => {
    const updated = [...durations]
    updated[dIdx].prices = updated[dIdx].prices.filter((_, i) => i !== pIdx)
    setDurations(updated)
  }

  const updatePrice = (dIdx: number, pIdx: number, field: string, value: string) => {
    const updated = [...durations]
    updated[dIdx].prices[pIdx] = { ...updated[dIdx].prices[pIdx], [field]: value }
    setDurations(updated)
  }

  const handleAddAllowedUser = async () => {
    const identifier = newAllowedUserId.trim()
    if (!identifier || resolvingAllowedUser) {
      return
    }

    setResolvingAllowedUser(true)
    try {
      const { data } = await api.get<{ id: string; label: string }>(
        '/admin/users/resolve',
        { params: { identifier } },
      )
      if (allowedUserIds.includes(data.id)) {
        toast.info(t('planForm.allowedUsers.alreadyAdded'))
      } else {
        setAllowedUserIds((prev) => [...prev, data.id])
      }
      setAllowedUserLabels((prev) => ({ ...prev, [data.id]: data.label }))
      setNewAllowedUserId('')
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status
      toast.error(
        status === 404
          ? t('planForm.allowedUsers.resolveFailed')
          : getErrorMessage(error, t('planForm.allowedUsers.resolveFailed')),
      )
    } finally {
      setResolvingAllowedUser(false)
    }
  }

  // Which limits this edit moves, and which way. Recomputed as the operator
  // types so the notice below appears at the moment of the decision rather than
  // after Save — unlike the squad propagation banner, there is no background
  // work to follow here, only a rule to state while it can still be changed.
  // `plan?.id` is the test for "this plan is saved, so it may have subscribers":
  // the create dialog passes no id and stays silent.
  const limitChanges = useMemo<readonly PlanLimitChange[]>(
    () =>
      describePlanLimitChanges({
        isSavedPlan: plan?.id !== undefined,
        savedType: initialDraft.type,
        draftType: type,
        savedTrafficLimitGB: initialDraft.trafficLimitGB,
        draftTrafficLimitGB: trafficLimitGB,
        savedDeviceLimit: initialDraft.deviceLimit,
        draftDeviceLimit: deviceLimit,
      }),
    [plan?.id, initialDraft, type, trafficLimitGB, deviceLimit],
  )
  const limitDirection = useMemo(
    () => summarizePlanLimitDirection(limitChanges),
    [limitChanges],
  )

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    const draft: PlanFormDraft = {
      name,
      description,
      tag,
      icon,
      type,
      availability,
      trafficLimitGB,
      deviceLimit,
      trafficLimitStrategy: trafficStrategy,
      isArchived,
      archivedRenewMode,
      internalSquads: selectedInternalSquads,
      externalSquad,
      upgradeToPlanIds,
      replacementPlanIds,
      allowedUserIds,
      trialSettings: {
        maxClaims: trialMaxClaims,
        free: trialFree,
        availabilityScope: trialScope,
        requireTelegramLink: trialRequireTelegram,
      },
      durations,
    }

    form.reset(draft)
    void form.handleSubmit(
      (data) => {
        // Schema-valid and still unsaveable. The schema validates the draft
        // against itself and has never seen the plan catalog, so this is the
        // one place where "these ids are selected" and "the server will refuse
        // them" can meet before the request goes out.
        if (Object.keys(strandedErrors).length > 0) {
          setFormErrors(strandedErrors)
          return
        }
        setFormErrors({})
        onSubmit(data)
      },
      (errors) => setFormErrors({ ...flattenHookFormErrors(errors), ...strandedErrors }),
    )(e)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Basic Info */}
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>{t('planForm.name')} *</Label>
            <EmojiTextInput
              value={name}
              onChange={setName}
              placeholder={t('planForm.namePlaceholder')}
              required
              aria-invalid={!!formErrors.name}
              emojiAriaLabel={t('emojiPicker.trigger')}
            />
            <FieldError message={formErrors.name} />
          </div>
          <div className="space-y-2">
            <Label>{t('planForm.tag')}</Label>
            <Input
              value={tag}
              onChange={(e) => {
                // Force uppercase + strip disallowed characters so the value
                // we hold always satisfies the Remnawave tag contract.
                const next = e.target.value.toUpperCase().replace(TAG_SANITIZE, '').slice(0, 16)
                setTag(next)
              }}
              placeholder={t('planForm.tagPlaceholder')}
              maxLength={16}
              autoCapitalize="characters"
              spellCheck={false}
              aria-invalid={!!formErrors.tag || (tag.length > 0 && !TAG_PATTERN.test(tag))}
            />
            <p className="text-xs text-muted-foreground">{t('planForm.tagHint')}</p>
            <FieldError message={formErrors.tag} />
          </div>
        </div>
        <div className="space-y-2">
          <Label>{t('planForm.description')}</Label>
          <EmojiTextInput
            value={description}
            onChange={setDescription}
            placeholder={t('planForm.descriptionPlaceholder')}
            emojiAriaLabel={t('emojiPicker.trigger')}
          />
        </div>

        {/* Plan icon — shown on the cabinet plan card */}
        <div className="space-y-2">
          <Label>{t('planForm.icon')}</Label>
          <IconPicker value={icon} onChange={setIcon} autoLabel={t('planForm.iconNone')} />
          <p className="text-xs text-muted-foreground">{t('planForm.iconHint')}</p>
          {/* Where the colour lives. A `Plan` row carries an icon and nothing
              else about how its card looks — gradient, accent, texture and
              effect are stored per plan in `brandingSettings.planCardStyles`
              and edited in WEB Reiwa → Tariff cards. The icon picker is the
              only appearance control on this form, so the form reads as "looks
              are configured here" and an operator searched it for a colour
              picker that has never been in it, with nothing on screen pointing
              anywhere else.

              Opens in a new tab deliberately: this form renders inside a
              dialog on the plans page, so an in-place navigation would unmount
              it and discard a half-filled plan without warning. It lands on the
              page's default tab, not on Tariff cards — `WebReiwaPage` keeps its
              tab in `useState` with no URL binding, so there is nothing to deep
              link to yet. */}
          <p className="text-xs text-muted-foreground">
            {t('planForm.cardAppearanceHint')}{' '}
            <Link
              to="/web-reiwa"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {t('planForm.cardAppearanceLink')}
            </Link>
          </p>
        </div>
      </div>

      <Separator />

      {/* Type & Availability */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label>{t('planForm.planType')}</Label>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLAN_TYPES.map((tt) => (
                <SelectItem key={tt} value={tt}>
                  {t(`planForm.types.${tt}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>{t('planForm.availability')}</Label>
          <Select value={availability} onValueChange={setAvailability}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLAN_AVAILABILITIES.map((a) => (
                <SelectItem key={a} value={a}>
                  {t(`planForm.availabilities.${a}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Trial configuration — only when availability = TRIAL */}
      {availability === 'TRIAL' && (
        <>
          <Separator />
          <div className="space-y-4 rounded-lg border border-dashed p-4">
            <div className="flex items-center gap-2">
              <Label className="text-base font-medium">{t('planForm.trial.title')}</Label>
            </div>
            <p className="text-xs text-muted-foreground">{t('planForm.trial.hint')}</p>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label className="text-sm">{t('planForm.trial.maxClaims')}</Label>
                <Input
                  type="number"
                  min="1"
                  max="100"
                  value={trialMaxClaims}
                  onChange={(e) => setTrialMaxClaims(e.target.value)}
                  aria-invalid={!!formErrors['trialSettings.maxClaims']}
                />
                <FieldError message={formErrors['trialSettings.maxClaims']} />
                <p className="text-xs text-muted-foreground">{t('planForm.trial.maxClaimsHint')}</p>
              </div>
              <div className="space-y-2">
                <Label className="text-sm">{t('planForm.trial.pricing')}</Label>
                <Select value={trialFree ? 'free' : 'paid'} onValueChange={(v) => setTrialFree(v === 'free')}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="free">{t('planForm.trial.free')}</SelectItem>
                    <SelectItem value="paid">{t('planForm.trial.paid')}</SelectItem>
                  </SelectContent>
                </Select>
                {!trialFree && (
                  <p className="text-xs text-muted-foreground">
                    {t('planForm.trial.paidNotice')}
                  </p>
                )}
                <FieldError message={formErrors['trialSettings.free']} />
              </div>
              <div className="space-y-2">
                <Label className="text-sm">{t('planForm.trial.scope')}</Label>
                <Select value={trialScope} onValueChange={(v) => setTrialScope(v as 'ALL' | 'INVITED')}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">{t('planForm.trial.scopeAll')}</SelectItem>
                    <SelectItem value="INVITED">{t('planForm.trial.scopeInvited')}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t('planForm.trial.scopeHint')}</p>
              </div>
            </div>

            {/* Require Telegram link before claiming the trial (free or paid) */}
            <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
              <div className="space-y-0.5 pr-3">
                <div className="flex items-center gap-2">
                  <Label className="text-sm">{t('planForm.trial.requireTelegram')}</Label>
                  {/* The Telegram-flow reminder is tucked behind an info icon
                      (hover) next to the field it explains, to keep the form
                      compact. */}
                  <TooltipProvider delayDuration={150}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={t('planForm.trial.telegramNoteAria')}
                          className="inline-flex text-amber-500 transition-colors hover:text-amber-400"
                        >
                          <Info className="h-4 w-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs text-xs leading-snug">
                        {t('planForm.trial.telegramNote')}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <p className="text-xs text-muted-foreground">{t('planForm.trial.requireTelegramHint')}</p>
              </div>
              <Switch
                checked={trialRequireTelegram}
                onCheckedChange={setTrialRequireTelegram}
                aria-label={t('planForm.trial.requireTelegram')}
              />
            </div>
          </div>
        </>
      )}

      <Separator />

      {/* Limits — hidden entirely for the UNLIMITED plan type, where traffic,
          devices and the reset strategy are all meaningless (the backend
          normalizer forces traffic=∞ / devices=∞ for this type anyway). */}
      {type !== 'UNLIMITED' && (
      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-2">
          <Label>{t('planForm.trafficLimit')}</Label>
          <Input
            type="number"
            value={trafficLimitGB}
            onChange={(e) => setTrafficLimitGB(e.target.value)}
            min="0"
            step="1"
            aria-invalid={!!formErrors.trafficLimitGB}
          />
          <p className="text-xs text-muted-foreground">{t('planForm.unlimitedHint')}</p>
          <FieldError message={formErrors.trafficLimitGB} />
        </div>
        <div className="space-y-2">
          <Label>{t('planForm.deviceLimit')}</Label>
          <Input
            type="number"
            value={deviceLimit}
            onChange={(e) => setDeviceLimit(e.target.value)}
            min="0"
            aria-invalid={!!formErrors.deviceLimit}
          />
          <p className="text-xs text-muted-foreground">{t('planForm.unlimitedHint')}</p>
          <FieldError message={formErrors.deviceLimit} />
        </div>
        <div className="space-y-2">
          <Label>{t('planForm.resetStrategy')}</Label>
          <Select value={trafficStrategy} onValueChange={setTrafficStrategy}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLAN_TRAFFIC_STRATEGIES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`planForm.resetStrategies.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      )}

      {/* Sits OUTSIDE the block above on purpose: switching the plan type to
          UNLIMITED hides both inputs while still changing the persisted limits,
          and that is the largest limit change an operator can make. */}
      {limitDirection !== null && (
        <LimitScopeNotice changes={limitChanges} direction={limitDirection} />
      )}

      <Separator />

      {/* Squads */}
      <div className="space-y-4">
        <Label className="text-base font-medium">{t('planForm.squads')}</Label>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label className="text-sm">{t('planForm.internalSquads')}</Label>
            <InternalSquadsPicker
              squads={internalSquads ?? []}
              unavailable={internalSquadsUnavailable}
              onRetry={() => void internalSquadsQuery.refetch()}
              value={selectedInternalSquads}
              onChange={setSelectedInternalSquads}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm">{t('planForm.externalSquad')}</Label>
            <Select value={externalSquad} onValueChange={setExternalSquad}>
              <SelectTrigger>
                <SelectValue placeholder={t('planForm.none')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t('planForm.none')}</SelectItem>
                {externalSquads?.map((squad) => (
                  <SelectItem key={squad.uuid} value={squad.uuid}>
                    {squad.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {externalSquadsUnavailable && (
              <DataUnavailable
                message={t('planForm.squadsUnavailable')}
                onRetry={() => void externalSquadsQuery.refetch()}
              />
            )}
          </div>
        </div>
      </div>

      <Separator />

      {/* Durations & Prices */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Label className="text-base font-medium">{t('planForm.pricing')}</Label>
          <Button type="button" variant="outline" size="sm" onClick={addDuration}>
            <Plus className="h-3.5 w-3.5 mr-1" /> {t('planForm.addDuration')}
          </Button>
        </div>
        <FieldError message={formErrors.durations} />

        {durations.map((duration, dIdx) => (
          <div key={dIdx} className="border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">{t('planForm.days')}</Label>
                  <Input
                    type="number"
                    className="w-24"
                    value={duration.days}
                    onChange={(e) => updateDuration(dIdx, 'days', e.target.value)}
                    min="1"
                    aria-label={t('planForm.durationDaysAria', { index: dIdx + 1 })}
                    aria-invalid={!!formErrors[`durations.${dIdx}.days`]}
                  />
                  <FieldError message={formErrors[`durations.${dIdx}.days`]} />
                </div>
              </div>
              {durations.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive"
                  onClick={() => removeDuration(dIdx)}
                  aria-label={t('planForm.removeDurationAria', { index: dIdx + 1 })}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              ) : null}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">{t('planForm.prices')}</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => addPrice(dIdx)}
                  aria-label={t('planForm.addCurrencyAria', { index: dIdx + 1 })}
                >
                  + {t('planForm.addCurrency')}
                </Button>
              </div>
              <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                {duration.prices.map((price, pIdx) => (
                  <div key={pIdx} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Select
                        value={price.currency}
                        onValueChange={(v) => updatePrice(dIdx, pIdx, 'currency', v)}
                      >
                        <SelectTrigger
                          className="w-24"
                          aria-label={t('planForm.currencyAria', {
                            duration: dIdx + 1,
                            index: pIdx + 1,
                          })}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PLAN_CURRENCIES.map((c) => (
                            <SelectItem key={c} value={c}>
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        type="number"
                        value={price.price}
                        onChange={(e) => updatePrice(dIdx, pIdx, 'price', e.target.value)}
                        min="0"
                        step="0.01"
                        className="flex-1"
                        aria-label={t('planForm.priceAria', {
                          duration: dIdx + 1,
                          index: pIdx + 1,
                        })}
                        aria-invalid={!!formErrors[`durations.${dIdx}.prices.${pIdx}.price`]}
                      />
                      {duration.prices.length > 1 ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={() => removePrice(dIdx, pIdx)}
                          aria-label={t('planForm.removePriceAria', {
                            duration: dIdx + 1,
                            index: pIdx + 1,
                          })}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      ) : null}
                    </div>
                    <FieldError
                      message={
                        formErrors[`durations.${dIdx}.prices.${pIdx}.currency`] ??
                        formErrors[`durations.${dIdx}.prices.${pIdx}.price`]
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      <Separator />

      {/* Archive & Transitions */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Archive className="h-4 w-4 text-muted-foreground" />
          <Label className="text-base font-medium">{t('planForm.archive.title')}</Label>
        </div>

        <div className="flex items-center justify-between rounded-lg border px-4 py-3">
          <div>
            <Label className="font-medium">{t('planForm.archive.isArchived')}</Label>
            <p className="text-xs text-muted-foreground">{t('planForm.archive.isArchivedHint')}</p>
          </div>
          <Switch checked={isArchived} onCheckedChange={setIsArchived} />
        </div>

        {isArchived && (
          <div className="space-y-3 rounded-lg border border-dashed p-4">
            <div className="space-y-2">
              <Label className="text-sm">{t('planForm.archive.renewMode')}</Label>
              <Select value={archivedRenewMode} onValueChange={setArchivedRenewMode}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SELF_RENEW">{t('planForm.archive.selfRenew')}</SelectItem>
                  <SelectItem value="REPLACE_ON_RENEW">{t('planForm.archive.replaceOnRenew')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t('planForm.archive.renewModeHint')}</p>
            </div>

            {archivedRenewMode === 'REPLACE_ON_RENEW' && (
              <div className="space-y-2">
                <Label className="text-sm">{t('planForm.archive.replacementPlans')}</Label>
                <div className="flex flex-wrap gap-2">
                  {otherPlans.map((p) => {
                    const isSelected = replacementPlanIds.includes(p.id)
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className={badgeVariants({
                          variant: isSelected ? 'default' : 'outline',
                          className: 'cursor-pointer',
                        })}
                        aria-pressed={isSelected}
                        onClick={() =>
                          setReplacementPlanIds((prev) =>
                            prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id],
                          )
                        }
                      >
                        {p.name}
                      </button>
                    )
                  })}
                  {otherPlans.length === 0 && (
                    <p className="text-xs text-muted-foreground">{t('planForm.archive.noPlans')}</p>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{t('planForm.archive.replacementHint')}</p>
                <FieldError message={formErrors.replacementPlanIds} />
              </div>
            )}

            {/* OUTSIDE the renew-mode gate on purpose. `replacementPlanIds` is
                submitted whenever the plan is archived, under both renewal
                modes, but the picker above only exists under REPLACE_ON_RENEW.
                Put these chips inside it and a SELF_RENEW plan goes on
                submitting ids that appear on no screen — which is the original
                defect, moved rather than fixed. */}
            <StrandedTransitionChips
              targets={strandedReplacements}
              error={formErrors.replacementPlanIdsStranded}
              onRemove={(id) => setReplacementPlanIds((prev) => prev.filter((x) => x !== id))}
            />
          </div>
        )}
      </div>

      <Separator />

      {/* Upgrade Targets */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
          <Label className="text-base font-medium">{t('planForm.upgrade.title')}</Label>
        </div>
        <p className="text-xs text-muted-foreground">{t('planForm.upgrade.hint')}</p>
        <div className="flex flex-wrap gap-2">
          {otherPlans.map((p) => {
            const isSelected = upgradeToPlanIds.includes(p.id)
            return (
              <button
                key={p.id}
                type="button"
                className={badgeVariants({
                  variant: isSelected ? 'default' : 'outline',
                  className: 'cursor-pointer',
                })}
                aria-pressed={isSelected}
                onClick={() =>
                  setUpgradeToPlanIds((prev) =>
                    prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id],
                  )
                }
              >
                {p.name}
              </button>
            )
          })}
          {otherPlans.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('planForm.upgrade.noPlans')}</p>
          )}
        </div>
        <StrandedTransitionChips
          targets={strandedUpgrades}
          error={formErrors.upgradeToPlanIdsStranded}
          onRemove={(id) => setUpgradeToPlanIds((prev) => prev.filter((x) => x !== id))}
        />
      </div>

      {/* Allowed Users (only when availability = ALLOWED) */}
      {availability === 'ALLOWED' && (
        <>
          <Separator />
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <Label className="text-base font-medium">{t('planForm.allowedUsers.title')}</Label>
            </div>
            <p className="text-xs text-muted-foreground">{t('planForm.allowedUsers.hint')}</p>
            <div className="flex flex-wrap gap-2">
              {allowedUserIds.map((uid) => (
                <button
                  key={uid}
                  type="button"
                  className={badgeVariants({ variant: 'secondary', className: 'cursor-pointer gap-1' })}
                  aria-label={t('planForm.allowedUsers.removeAria', { userId: uid })}
                  onClick={() => setAllowedUserIds((prev) => prev.filter((x) => x !== uid))}
                >
                  {allowedUserLabels[uid] ?? truncate(uid, 12)}
                  <Trash2 className="h-3 w-3" aria-hidden />
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                placeholder={t('planForm.allowedUsers.placeholder')}
                value={newAllowedUserId}
                onChange={(e) => setNewAllowedUserId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void handleAddAllowedUser()
                  }
                }}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!newAllowedUserId.trim() || resolvingAllowedUser}
                onClick={() => void handleAddAllowedUser()}
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                {resolvingAllowedUser ? t('planForm.allowedUsers.resolving') : t('planForm.allowedUsers.add')}
              </Button>
            </div>
            <FieldError message={formErrors.allowedUserIds} />
          </div>
        </>
      )}

      <Separator />

      <Button type="submit" className="w-full" disabled={isLoading || !name}>
        {plan ? t('planForm.update') : t('planForm.create')}
      </Button>
    </form>
  )
}


function FieldError({ message }: { readonly message?: string }) {
  if (!message) return null
  return <p className="text-xs font-medium text-destructive" role="alert">{message}</p>
}

/**
 * What to call a stranded target.
 *
 * The name whenever the plan is still in the catalog; the raw id ONLY when it
 * is gone and there is nothing else left to call it. Naming a plan by its cuid
 * is what made the server's refusal unactionable in the first place, so it is
 * the last resort here, not the default.
 */
function strandedTargetLabel(target: StrandedTransitionTarget): string {
  return target.name ?? target.id
}

/**
 * Selected transition targets the server will refuse — and the way off them.
 *
 * These ids are already saved on the plan and are submitted on every save; the
 * pickers above cannot show them, because a plan that may not be OFFERED is
 * filtered out of the list the pickers are built from. Rendering them here is
 * the only thing standing between the operator and a plan that can never be
 * saved again.
 *
 * `destructive` rather than `warning`: it is the one variant in
 * `badgeVariants` built from theme tokens (`bg-destructive` /
 * `text-destructive-foreground`), so it re-colours with the panel's theme.
 * `warning` / `info` / `success` are pinned to `bg-yellow-100 text-yellow-800`
 * and friends, which keep a light-mode swatch in a dark panel.
 */
function StrandedTransitionChips({
  targets,
  error,
  onRemove,
}: {
  readonly targets: readonly StrandedTransitionTarget[]
  readonly error?: string
  readonly onRemove: (id: string) => void
}) {
  const { t } = useTranslation()
  if (targets.length === 0) return null

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {targets.map((target) => {
          const label = strandedTargetLabel(target)
          const reason = t(`planForm.transitions.strandedReason.${target.reason}`)
          return (
            <button
              key={target.id}
              type="button"
              className={badgeVariants({
                variant: 'destructive',
                className: 'cursor-pointer gap-1',
              })}
              aria-label={t('planForm.transitions.strandedRemoveAria', { plan: label, reason })}
              onClick={() => onRemove(target.id)}
            >
              {label} · {reason}
              <Trash2 className="h-3 w-3" aria-hidden />
            </button>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground">{t('planForm.transitions.strandedHint')}</p>
      <FieldError message={error} />
    </div>
  )
}

/**
 * States, at the moment a limit is edited, that the change does NOT reach the
 * people already on this plan until they renew or upgrade.
 *
 * That is the product's rule, not an accident — `BulkPlanAssignmentService`
 * defers the same reshape by default so an admin action never silently shrinks
 * a paying customer, and `bulk-assign-plan-dialog` already says so for the bulk
 * path. The plan editor was the one place that changed limits and said nothing,
 * which is what made correct behaviour read as a bug.
 *
 * The rule is the same in both directions; the sentence is not. On a cut the
 * operator needs to know nobody was reduced today, on a raise they need to know
 * the gift has not been delivered yet — so support is not told otherwise.
 */
function LimitScopeNotice({
  changes,
  direction,
}: {
  readonly changes: readonly PlanLimitChange[]
  readonly direction: 'raise' | 'cut' | 'mixed'
}) {
  const { t } = useTranslation()
  const formatLimit = (field: PlanLimitChange['field'], value: number): string =>
    value === 0
      ? t('planForm.limitScope.unlimited')
      : field === 'traffic'
        ? t('planForm.limitScope.trafficValue', { value })
        : String(value)

  return (
    <div className="flex gap-3 rounded-md border p-3" role="status">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-sm font-medium">{t('planForm.limitScope.title')}</p>
        <ul className="text-xs text-muted-foreground">
          {changes.map((change) => (
            <li key={change.field}>
              {t(`planForm.limitScope.${change.field}Change`, {
                from: formatLimit(change.field, change.from),
                to: formatLimit(change.field, change.to),
              })}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">{t(`planForm.limitScope.${direction}`)}</p>
        {/*
          The renewal rule above is only half of what happens. A subscriber
          whose limit an operator set by hand from the Users page is EXEMPT —
          `resolveInheritedPlanLimitUpdate` re-applies the plan only to the
          fields whose columns still match that subscription's own
          `plan_snapshot`, so an individual adjustment survives the renewal that
          moves everyone else. Saying only "on renewal" here sends an operator
          looking for a bug when the one customer they hand-tuned does not move
          with the rest.
        */}
        <p className="text-xs text-muted-foreground">{t('planForm.limitScope.individuallyAdjusted')}</p>
      </div>
    </div>
  )
}

function createInitialPlanDraft(plan?: PlanInput): PlanFormDraft {
  const planDeviceLimit = plan?.deviceLimit

  return {
    name: plan?.name ?? '',
    description: plan?.description ?? '',
    tag: plan?.tag ?? '',
    icon: plan?.icon ?? null,
    type: plan?.type ?? 'TRAFFIC',
    availability: plan?.availability ?? 'ALL',
    trafficLimitGB: plan ? String(plan.trafficLimit ?? 0) : '50',
    deviceLimit: plan ? String(planDeviceLimit !== undefined && planDeviceLimit > 0 ? planDeviceLimit : 0) : '1',
    trafficLimitStrategy: plan?.trafficLimitStrategy ?? 'MONTH',
    isArchived: plan?.isArchived ?? false,
    archivedRenewMode: plan?.archivedRenewMode ?? 'SELF_RENEW',
    internalSquads: plan?.internalSquads ? [...plan.internalSquads] : [],
    externalSquad: plan?.externalSquad ?? '__none__',
    upgradeToPlanIds: plan?.upgradeToPlanIds ? [...plan.upgradeToPlanIds] : [],
    replacementPlanIds: plan?.replacementPlanIds ? [...plan.replacementPlanIds] : [],
    allowedUserIds: plan?.allowedUserIds ? [...plan.allowedUserIds] : [],
    trialSettings: {
      maxClaims: String(plan?.trialSettings?.maxClaims ?? 1),
      free: plan?.trialSettings?.free ?? true,
      availabilityScope: plan?.trialSettings?.availabilityScope ?? 'ALL',
      requireTelegramLink: plan?.trialSettings?.requireTelegramLink ?? false,
    },
    durations: plan?.durations?.map((duration) => ({
      days: duration.days.toString(),
      prices: duration.prices.map((price) => ({
        currency: price.currency,
        price: price.price.toString(),
      })),
    })) ?? [{ days: '30', prices: [{ currency: 'RUB', price: '299' }] }],
  }
}

function flattenHookFormErrors(errors: FieldErrors<PlanFormDraft>): Record<string, string> {
  const flattenedErrors: Record<string, string> = {}
  collectHookFormErrors(errors, [], flattenedErrors)
  return flattenedErrors
}

function collectHookFormErrors(value: unknown, path: string[], output: Record<string, string>): void {
  if (value === null || typeof value !== 'object') return

  const maybeError = value as { readonly message?: unknown }
  if (typeof maybeError.message === 'string') {
    const key = path.length > 0 ? path.join('.') : 'form'
    output[key] ??= maybeError.message
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'message' || key === 'type' || key === 'types' || key === 'ref') continue
    collectHookFormErrors(child, [...path, key], output)
  }
}


interface InternalSquadOption {
  readonly uuid: string
  readonly name: string
}

/**
 * Internal squads multi-select picker.
 *
 * Mirrors the visual + interaction model of the External squad
 * `<Select>` next to it (a single `<button>` trigger that opens a
 * dropdown), but hosts a multi-select Command list inside so the
 * operator can tick several squads in one go. Selected count goes
 * into the trigger label so the form stays scannable when the
 * dropdown is closed.
 */
function InternalSquadsPicker({
  squads,
  unavailable = false,
  onRetry,
  value,
  onChange,
}: {
  readonly squads: ReadonlyArray<InternalSquadOption>
  /**
   * The squad list never arrived. Without this the empty `squads` array is
   * indistinguishable from a panel with no squads, and the control says
   * "No squads available" on a disabled trigger — a confident false claim
   * about the operator's infrastructure, made while creating a plan.
   */
  readonly unavailable?: boolean
  readonly onRetry?: () => void
  readonly value: ReadonlyArray<string>
  readonly onChange: (next: string[]) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  // Map for quick lookup (rendering "selected" badge labels).
  const byUuid = useMemo(
    () => new Map(squads.map((s) => [s.uuid, s.name])),
    [squads],
  )

  const triggerLabel =
    value.length === 0
      ? t('planForm.internalSquadsPlaceholder')
      : t('planForm.internalSquadsCount', { count: value.length })

  const toggle = (uuid: string) => {
    onChange(
      value.includes(uuid)
        ? value.filter((id) => id !== uuid)
        : [...value, uuid],
    )
  }

  if (unavailable) {
    return <DataUnavailable message={t('planForm.squadsUnavailable')} onRetry={onRetry} />
  }

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal"
            disabled={squads.length === 0}
          >
            <span className={cn('truncate', value.length === 0 && 'text-muted-foreground')}>
              {squads.length === 0 ? t('planForm.noSquads') : triggerLabel}
            </span>
            <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command>
            <CommandInput placeholder={t('planForm.internalSquadsPlaceholder')} />
            <CommandList>
              <CommandEmpty>{t('planForm.noSquads')}</CommandEmpty>
              <CommandGroup>
                {squads.map((squad) => {
                  const selected = value.includes(squad.uuid)
                  return (
                    <CommandItem
                      key={squad.uuid}
                      value={`${squad.name} ${squad.uuid}`}
                      onSelect={() => toggle(squad.uuid)}
                      className="cursor-pointer"
                    >
                      <Checkbox
                        checked={selected}
                        className="mr-2 h-4 w-4"
                        // Visual-only — the row click handles state.
                        onCheckedChange={() => toggle(squad.uuid)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <span className="flex-1 truncate">{squad.name}</span>
                      {selected ? <Check className="ml-2 h-4 w-4 opacity-70" /> : null}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {/* Selected chip preview (read-only echo so the operator can see
          which squads are picked without opening the dropdown). */}
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((uuid) => (
            <Badge key={uuid} variant="secondary" className="font-normal">
              {byUuid.get(uuid) ?? truncate(uuid, 8)}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  )
}
