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

export interface PromocodeFormData {
  code: string
  rewardType: string
  reward?: number
  availability: string
  isActive: boolean
  lifetime?: number
  maxActivations?: number
  allowedPlanIds?: number[]
  /** Absolute expiry (ISO 8601) or null for none. */
  expiresAt?: string | null
}

interface ExistingPromocode {
  readonly code?: string
  readonly rewardType?: string
  readonly reward?: number | string
  readonly availability?: string
  readonly isActive?: boolean
  readonly lifetime?: number | string
  readonly maxActivations?: number | string
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
    let expiresAt: string | null = null
    if (expiresDate) {
      const [hh, mm] = expiresTime.split(':').map((n) => Number.parseInt(n, 10))
      const merged = new Date(expiresDate)
      merged.setHours(Number.isFinite(hh) ? hh : 23, Number.isFinite(mm) ? mm : 59, 0, 0)
      expiresAt = merged.toISOString()
    }
    onSubmit({
      code: code.toUpperCase(),
      rewardType,
      reward: rewardType !== 'SUBSCRIPTION' ? parseInt(reward, 10) : undefined,
      availability,
      isActive,
      lifetime: parseInt(lifetime, 10),
      maxActivations: parseInt(maxActivations, 10),
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

      <Button type="submit" className="w-full" disabled={isLoading || !code}>
        {promo ? t('promocodeForm.update') : t('promocodeForm.create')}
      </Button>
    </form>
  )
}
