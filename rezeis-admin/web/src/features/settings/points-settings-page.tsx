import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Coins, Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { FadeIn } from '@/lib/motion'

import { PointsExchangeCard, type PointsExchangeSettings } from './points-exchange-card'

interface PointsOverview {
  readonly defaultCurrency?: string
  readonly pointsSettings?: { readonly cashback?: { readonly enabled?: boolean; readonly percent?: number } }
  readonly referralSettings?: { readonly pointsExchange?: PointsExchangeSettings }
}

/** The cashback rule as the overview stores it; anything absent reads as OFF. */
function readCashbackSettings(pointsSettings: PointsOverview['pointsSettings']): {
  readonly enabled: boolean
  readonly percent: number
} {
  const cashback = pointsSettings?.cashback
  const percent = cashback?.percent
  return {
    enabled: cashback?.enabled === true,
    percent: typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.trunc(percent)) : 0,
  }
}

/**
 * Settings → Points. Two cards: the global cashback rule every plan and
 * add-on in "same as settings" mode follows, and what points buy (moved here
 * from the referral settings — the referral program earns points, it does
 * not decide what they are worth).
 */
export default function PointsSettingsPage() {
  const { t } = useTranslation()
  const { data: settings, isLoading } = useQuery<PointsOverview>({
    queryKey: ['admin', 'settings'],
    queryFn: async () => (await api.get<PointsOverview>('/admin/settings')).data,
  })

  if (isLoading || settings === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Coins className="h-6 w-6" /> {t('pointsSettingsPage.title')}
          </h1>
          <p className="text-muted-foreground">{t('pointsSettingsPage.subtitle')}</p>
        </div>
      </FadeIn>
      <CashbackCard
        cashback={readCashbackSettings(settings.pointsSettings)}
        defaultCurrency={settings.defaultCurrency ?? 'RUB'}
      />
      <PointsExchangeCard pointsExchange={settings.referralSettings?.pointsExchange ?? {}} />
    </div>
  )
}

function parsePercent(raw: string): number | null {
  if (raw.trim() === '') return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 100) return null
  return value
}

function CashbackCard({
  cashback,
  defaultCurrency,
}: {
  readonly cashback: { readonly enabled: boolean; readonly percent: number }
  readonly defaultCurrency: string
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [enabled, setEnabled] = useState(cashback.enabled)
  const [percent, setPercent] = useState(String(cashback.percent))
  const parsedPercent = parsePercent(percent)
  const percentInvalid = parsedPercent === null

  const saveMutation = useMutation({
    // The switch and the percent travel together: the backend merges the
    // sub-object one level deep, so sending both keeps the two in step with
    // what the operator sees on screen.
    mutationFn: (input: { readonly enabled: boolean; readonly percent: number }) =>
      api.patch('/admin/settings/points', { cashback: input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] })
      toast.success(t('pointsSettingsPage.cashback.saved'))
    },
    onError: () => toast.error(t('pointsSettingsPage.cashback.saveFailed')),
  })

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>{t('pointsSettingsPage.cashback.title')}</CardTitle>
            <CardDescription>{t('pointsSettingsPage.cashback.description')}</CardDescription>
          </div>
          <div className="flex items-center gap-3">
            <Label htmlFor="points-cashback-enabled" className="text-xs text-muted-foreground">
              {t('pointsSettingsPage.cashback.enable')}
            </Label>
            <Switch
              id="points-cashback-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label={t('pointsSettingsPage.cashback.enable')}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="points-cashback-percent">{t('pointsSettingsPage.cashback.percent')}</Label>
            <Input
              id="points-cashback-percent"
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              step={1}
              value={percent}
              onChange={(event) => setPercent(event.target.value)}
              aria-invalid={percentInvalid}
              aria-label={t('pointsSettingsPage.cashback.percent')}
              className="max-w-[10rem]"
            />
            <p className="text-xs text-muted-foreground">{t('pointsSettingsPage.cashback.percentHint')}</p>
            {percentInvalid && (
              <p className="text-xs text-destructive" role="alert">
                {t('pointsSettingsPage.cashback.percentRange')}
              </p>
            )}
          </div>
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>{t('pointsSettingsPage.cashback.hintDisabled')}</p>
            <p>{t('pointsSettingsPage.cashback.hintPartners')}</p>
            <p>
              {t('pointsSettingsPage.cashback.hintCurrency', { currency: defaultCurrency })}{' '}
              <Link to="/settings" className="underline underline-offset-2">
                {t('pointsSettingsPage.cashback.hintCurrencyLink')}
              </Link>
            </p>
            <p>{t('pointsSettingsPage.cashback.hintDiscountLoop')}</p>
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={saveMutation.isPending || percentInvalid}
            onClick={() => {
              if (parsedPercent === null) return
              saveMutation.mutate({ enabled, percent: parsedPercent })
            }}
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            {t('pointsSettingsPage.cashback.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
