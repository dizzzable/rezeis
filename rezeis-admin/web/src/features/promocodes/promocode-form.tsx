import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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

export interface PromocodeFormData {
  code: string
  rewardType: string
  reward?: number
  availability: string
  isActive: boolean
  lifetime?: number
  maxActivations?: number
  allowedPlanIds?: number[]
}

interface ExistingPromocode {
  readonly code?: string
  readonly rewardType?: string
  readonly reward?: number | string
  readonly availability?: string
  readonly isActive?: boolean
  readonly lifetime?: number | string
  readonly maxActivations?: number | string
}

interface Props {
  promo?: ExistingPromocode
  onSubmit: (data: PromocodeFormData) => void
  isLoading: boolean
}

export function PromocodeForm({ promo, onSubmit, isLoading }: Props) {
  const { t } = useTranslation()
  const [code, setCode] = useState(promo?.code ?? '')
  const [rewardType, setRewardType] = useState(promo?.rewardType ?? 'DURATION')
  const [reward, setReward] = useState(promo?.reward?.toString() ?? '7')
  const [availability, setAvailability] = useState(promo?.availability ?? 'ALL')
  const [isActive, setIsActive] = useState(promo?.isActive ?? true)
  const [lifetime, setLifetime] = useState(promo?.lifetime?.toString() ?? '-1')
  const [maxActivations, setMaxActivations] = useState(promo?.maxActivations?.toString() ?? '-1')

  // Load plans for SUBSCRIPTION reward type
  usePlans(undefined, { enabled: rewardType === 'SUBSCRIPTION' })

  const generateCode = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    let result = ''
    for (let i = 0; i < 8; i++) result += chars[Math.floor(Math.random() * chars.length)]
    setCode(result)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit({
      code: code.toUpperCase(),
      rewardType,
      reward: rewardType !== 'SUBSCRIPTION' ? parseInt(reward, 10) : undefined,
      availability,
      isActive,
      lifetime: parseInt(lifetime, 10),
      maxActivations: parseInt(maxActivations, 10),
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

      {/* Reward type description */}
      <div className="text-xs text-muted-foreground bg-muted/50 rounded-md p-3">
        {t(`promocodeForm.rewardDescriptions.${rewardType}`)}
      </div>

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
          <p className="text-xs text-muted-foreground">{t('promocodeForm.unlimitedHint')}</p>
        </div>
        <div className="space-y-2">
          <Label>{t('promocodeForm.maxActivations')}</Label>
          <Input
            type="number"
            value={maxActivations}
            onChange={(e) => setMaxActivations(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('promocodeForm.unlimitedHint')}</p>
        </div>
      </div>

      <Separator />

      {/* Active toggle */}
      <div className="flex items-center gap-3">
        <Switch checked={isActive} onCheckedChange={setIsActive} />
        <Label>{t('promocodeForm.active')}</Label>
      </div>

      <Button type="submit" className="w-full" disabled={isLoading || !code}>
        {promo ? t('promocodeForm.update') : t('promocodeForm.create')}
      </Button>
    </form>
  )
}
