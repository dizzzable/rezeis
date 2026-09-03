import { useTranslation } from 'react-i18next'

import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { usePlans } from '@/features/plans/plans-api'

import type { PromocodeRewardType } from './wheel-config-api'
import { PROMO_REWARD_TYPES, type PromoDraft } from './promo-prize'

/**
 * The form for a PROMOCODE prize. What each field means, and why the prize
 * needs them at all, is in `promo-prize.ts` beside the converters.
 */
export function PromoPrizeFields({
  draft,
  onChange,
}: {
  readonly draft: PromoDraft
  readonly onChange: (next: PromoDraft) => void
}) {
  const { t } = useTranslation()
  const { data: plans } = usePlans()
  const options = plans ?? []

  const togglePlan = (planId: string, on: boolean) => {
    const next = on
      ? [...draft.planIds.filter((id) => id !== planId), planId]
      : draft.planIds.filter((id) => id !== planId)
    onChange({ ...draft, planIds: next })
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{t('wheelConfigPage.promo.hint')}</p>

      <div className="space-y-1.5">
        <Label>{t('wheelConfigPage.promo.rewardType')}</Label>
        <Select
          value={draft.rewardType}
          onValueChange={(value) =>
            onChange({ ...draft, rewardType: value as PromocodeRewardType })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROMO_REWARD_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {t(`wheelConfigPage.promo.types.${type}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {draft.rewardType === 'SUBSCRIPTION' ? (
        <div className="space-y-1.5">
          <Label>{t('wheelConfigPage.promo.planId')}</Label>
          <Select value={draft.planId} onValueChange={(value) => onChange({ ...draft, planId: value })}>
            <SelectTrigger>
              <SelectValue placeholder={t('wheelConfigPage.promo.planPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {options.map((plan) => (
                <SelectItem key={plan.id} value={plan.id}>
                  {plan.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label>{t('wheelConfigPage.promo.allowedPlans')}</Label>
        {/* Empty means "anywhere", which is why there is no "all" checkbox:
            an empty list already says it, and two ways to say one thing is
            how a filter ends up meaning neither. */}
        <p className="text-xs text-muted-foreground">{t('wheelConfigPage.promo.allowedPlansHint')}</p>
        <div className="max-h-40 space-y-1.5 overflow-y-auto">
          {options.map((plan) => (
            <label key={plan.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.planIds.includes(plan.id)}
                onCheckedChange={(checked) => togglePlan(plan.id, checked === true)}
              />
              {plan.name}
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>{t('wheelConfigPage.promo.lifetime')}</Label>
        <Input
          type="number"
          min={1}
          value={draft.lifetime}
          placeholder={t('wheelConfigPage.promo.lifetimePlaceholder')}
          onChange={(event) => onChange({ ...draft, lifetime: event.target.value })}
        />
      </div>
    </div>
  )
}
