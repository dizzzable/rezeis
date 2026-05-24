import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus, Trash2, Archive, ArrowUpRight, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { remnawaveApi } from '@/features/remnawave/remnawave-api'
import { usePlans, type Plan } from './plans-api'

const PLAN_TYPES = ['TRAFFIC', 'DEVICES', 'BOTH', 'UNLIMITED'] as const
const AVAILABILITIES = ['ALL', 'NEW', 'EXISTING', 'INVITED', 'ALLOWED', 'TRIAL'] as const
const TRAFFIC_STRATEGIES = ['MONTH', 'YEAR', 'NO_RESET', 'DAY', 'WEEK'] as const
const CURRENCIES = ['RUB', 'USD', 'XTR', 'USDT', 'TON', 'EUR'] as const

export interface PlanFormData {
  name: string
  description?: string
  tag?: string
  type: string
  availability: string
  trafficLimit: number
  deviceLimit: number
  trafficLimitStrategy: string
  isArchived?: boolean
  archivedRenewMode?: string
  internalSquads?: string[]
  externalSquad?: string
  upgradeToPlanIds?: string[]
  replacementPlanIds?: string[]
  allowedUserIds?: string[]
  durations: { days: number; prices: { currency: string; price: string }[] }[]
}

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
  const [name, setName] = useState(plan?.name ?? '')
  const [description, setDescription] = useState(plan?.description ?? '')
  const [tag, setTag] = useState(plan?.tag ?? '')
  const [type, setType] = useState(plan?.type ?? 'TRAFFIC')
  const [availability, setAvailability] = useState(plan?.availability ?? 'ALL')
  const [trafficLimitGB, setTrafficLimitGB] = useState(
    plan ? String(plan.trafficLimit ?? 50) : '50',
  )
  const [deviceLimit, setDeviceLimit] = useState(plan?.deviceLimit?.toString() ?? '1')
  const [trafficStrategy, setTrafficStrategy] = useState(plan?.trafficLimitStrategy ?? 'MONTH')
  const [selectedInternalSquads, setSelectedInternalSquads] = useState<string[]>(
    plan?.internalSquads ?? [],
  )
  const [externalSquad, setExternalSquad] = useState(plan?.externalSquad ?? '__none__')

  // Archive & transition state
  const [isArchived, setIsArchived] = useState(plan?.isArchived ?? false)
  const [archivedRenewMode, setArchivedRenewMode] = useState(
    plan?.archivedRenewMode ?? 'SELF_RENEW',
  )
  const [upgradeToPlanIds, setUpgradeToPlanIds] = useState<string[]>(
    plan?.upgradeToPlanIds ?? [],
  )
  const [replacementPlanIds, setReplacementPlanIds] = useState<string[]>(
    plan?.replacementPlanIds ?? [],
  )
  const [allowedUserIds, setAllowedUserIds] = useState<string[]>(
    plan?.allowedUserIds ?? [],
  )
  const [newAllowedUserId, setNewAllowedUserId] = useState('')

  const [durations, setDurations] = useState<
    { days: string; prices: { currency: string; price: string }[] }[]
  >(
    plan?.durations?.map((d) => ({
      days: d.days.toString(),
      prices: d.prices.map((p) => ({ currency: p.currency, price: p.price.toString() })),
    })) ?? [{ days: '30', prices: [{ currency: 'RUB', price: '299' }] }],
  )

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit({
      name,
      description: description || undefined,
      tag: tag || undefined,
      type,
      availability,
      trafficLimit: Math.round(parseFloat(trafficLimitGB || '0')),
      deviceLimit: parseInt(deviceLimit || '0', 10),
      trafficLimitStrategy: trafficStrategy,
      isArchived,
      archivedRenewMode: isArchived ? archivedRenewMode : undefined,
      internalSquads: selectedInternalSquads.length > 0 ? selectedInternalSquads : undefined,
      externalSquad:
        externalSquad === '__none__' || externalSquad === '' ? undefined : externalSquad,
      upgradeToPlanIds: upgradeToPlanIds.length > 0 ? upgradeToPlanIds : undefined,
      replacementPlanIds: replacementPlanIds.length > 0 ? replacementPlanIds : undefined,
      allowedUserIds: allowedUserIds.length > 0 ? allowedUserIds : undefined,
      durations: durations.map((d) => ({
        days: parseInt(d.days, 10),
        prices: d.prices.map((p) => ({ currency: p.currency, price: p.price.trim() || '0' })),
      })),
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Basic Info */}
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>{t('planForm.name')} *</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('planForm.namePlaceholder')}
              required
            />
          </div>
          <div className="space-y-2">
            <Label>{t('planForm.tag')}</Label>
            <Input
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder={t('planForm.tagPlaceholder')}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label>{t('planForm.description')}</Label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('planForm.descriptionPlaceholder')}
          />
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
              {AVAILABILITIES.map((a) => (
                <SelectItem key={a} value={a}>
                  {t(`planForm.availabilities.${a}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

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
          />
          <p className="text-xs text-muted-foreground">{t('planForm.unlimitedHint')}</p>
        </div>
        <div className="space-y-2">
          <Label>{t('planForm.deviceLimit')}</Label>
          <Input
            type="number"
            value={deviceLimit}
            onChange={(e) => setDeviceLimit(e.target.value)}
            min="0"
          />
          <p className="text-xs text-muted-foreground">{t('planForm.unlimitedHint')}</p>
        </div>
        <div className="space-y-2">
          <Label>{t('planForm.resetStrategy')}</Label>
          <Select value={trafficStrategy} onValueChange={setTrafficStrategy}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRAFFIC_STRATEGIES.map((s) => (
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
            <div className="flex flex-wrap gap-2">
              {internalSquads?.map((squad) => (
                <Badge
                  key={squad.uuid}
                  variant={selectedInternalSquads.includes(squad.uuid) ? 'default' : 'outline'}
                  className="cursor-pointer"
                  onClick={() => {
                    setSelectedInternalSquads((prev) =>
                      prev.includes(squad.uuid)
                        ? prev.filter((s) => s !== squad.uuid)
                        : [...prev, squad.uuid],
                    )
                  }}
                >
                  {squad.name}
                </Badge>
              ))}
              {!internalSquads?.length && (
                <p className="text-xs text-muted-foreground">{t('planForm.noSquads')}</p>
              )}
            </div>
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
                  />
                </div>
              </div>
              {durations.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive"
                  onClick={() => removeDuration(dIdx)}
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
                >
                  + {t('planForm.addCurrency')}
                </Button>
              </div>
              <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                {duration.prices.map((price, pIdx) => (
                  <div key={pIdx} className="flex items-center gap-2">
                    <Select
                      value={price.currency}
                      onValueChange={(v) => updatePrice(dIdx, pIdx, 'currency', v)}
                    >
                      <SelectTrigger className="w-24">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CURRENCIES.map((c) => (
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
                    />
                    {duration.prices.length > 1 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={() => removePrice(dIdx, pIdx)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
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
                  {otherPlans.map((p) => (
                    <Badge
                      key={p.id}
                      variant={replacementPlanIds.includes(p.id) ? 'default' : 'outline'}
                      className="cursor-pointer"
                      onClick={() =>
                        setReplacementPlanIds((prev) =>
                          prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id],
                        )
                      }
                    >
                      {p.name}
                    </Badge>
                  ))}
                  {otherPlans.length === 0 && (
                    <p className="text-xs text-muted-foreground">{t('planForm.archive.noPlans')}</p>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{t('planForm.archive.replacementHint')}</p>
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
          {otherPlans.map((p) => (
            <Badge
              key={p.id}
              variant={upgradeToPlanIds.includes(p.id) ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() =>
                setUpgradeToPlanIds((prev) =>
                  prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id],
                )
              }
            >
              {p.name}
            </Badge>
          ))}
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
                <Badge
                  key={uid}
                  variant="secondary"
                  className="cursor-pointer gap-1"
                  onClick={() => setAllowedUserIds((prev) => prev.filter((x) => x !== uid))}
                >
                  {uid.slice(0, 12)}…
                  <Trash2 className="h-3 w-3" />
                </Badge>
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
