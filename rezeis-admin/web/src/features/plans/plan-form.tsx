import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus, Trash2, Archive, ArrowUpRight, Users, Check, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useForm, type FieldErrors, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'

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
import { cn } from '@/lib/utils'
import { remnawaveApi } from '@/features/remnawave/remnawave-api'
import { IconPicker } from '@/features/settings/icon-picker'
import { EmojiTextInput } from '@/features/broadcast/emoji-text-input'
import { usePlans, type Plan } from './plans-api'
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

  const { data: internalSquads } = useQuery({
    queryKey: ['remnawave', 'internal-squads'],
    queryFn: remnawaveApi.getInternalSquads,
    retry: 1,
  })
  const { data: externalSquads } = useQuery({
    queryKey: ['remnawave', 'external-squads'],
    queryFn: remnawaveApi.getExternalSquads,
    retry: 1,
  })

  // All plans for upgrade/replacement picker (exclude current plan)
  const { data: allPlans } = usePlans()
  const otherPlans = (allPlans ?? []).filter((p) => p.id !== plan?.id && p.isActive && !p.isArchived)

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
        setFormErrors({})
        onSubmit(data)
      },
      (errors) => setFormErrors(flattenHookFormErrors(errors)),
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
            <Label className="text-base font-medium">{t('planForm.trial.title')}</Label>
            <p className="text-xs text-muted-foreground">{t('planForm.trial.hint')}</p>
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
              {t('planForm.trial.telegramNote')}
            </p>
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
                <Label className="text-sm">{t('planForm.trial.requireTelegram')}</Label>
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

      {/* Limits */}
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

      <Separator />

      {/* Squads */}
      <div className="space-y-4">
        <Label className="text-base font-medium">{t('planForm.squads')}</Label>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label className="text-sm">{t('planForm.internalSquads')}</Label>
            <InternalSquadsPicker
              squads={internalSquads ?? []}
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
                  {uid.slice(0, 12)}…
                  <Trash2 className="h-3 w-3" aria-hidden />
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                placeholder={t('planForm.allowedUsers.placeholder')}
                value={newAllowedUserId}
                onChange={(e) => setNewAllowedUserId(e.target.value)}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!newAllowedUserId.trim()}
                onClick={() => {
                  const uid = newAllowedUserId.trim()
                  if (uid && !allowedUserIds.includes(uid)) {
                    setAllowedUserIds((prev) => [...prev, uid])
                    setNewAllowedUserId('')
                  }
                }}
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> {t('planForm.allowedUsers.add')}
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
  value,
  onChange,
}: {
  readonly squads: ReadonlyArray<InternalSquadOption>
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
              {byUuid.get(uuid) ?? uuid.slice(0, 8)}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  )
}
