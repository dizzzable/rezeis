import { useEffect, useState, type JSX } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { settingsApi } from '@/features/settings/settings-api'
import { PlatformSettingsForm } from '@/features/settings/platform-settings-form'

function parseCsvValues(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function parseCsvNumbers(value: string): number[] {
  return parseCsvValues(value).map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0)
}

export function PlatformSettingsPage(): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const referralExchangePolicyQuery = useQuery({ queryKey: ['settings', 'referral-exchange-policy'], queryFn: settingsApi.getReferralExchangePolicy })
  const partnerWithdrawalPolicyQuery = useQuery({ queryKey: ['settings', 'partner-withdrawal-policy'], queryFn: settingsApi.getPartnerWithdrawalPolicy })
  const [allowedPlanIds, setAllowedPlanIds] = useState('')
  const [allowedDurationDays, setAllowedDurationDays] = useState('')
  const [codePrefix, setCodePrefix] = useState('')
  const [costPerDay, setCostPerDay] = useState('')
  const [partnerMinimumAmount, setPartnerMinimumAmount] = useState('')
  const [partnerSupportedMethods, setPartnerSupportedMethods] = useState('')
  const referralExchangePolicyMutation = useMutation({
    mutationFn: settingsApi.updateReferralExchangePolicy,
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['settings', 'referral-exchange-policy'] }),
  })
  const partnerWithdrawalPolicyMutation = useMutation({
    mutationFn: settingsApi.updatePartnerWithdrawalPolicy,
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['settings', 'partner-withdrawal-policy'] }),
  })

  useEffect(() => {
    if (!referralExchangePolicyQuery.data) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- TODO: refactor to derive state
    setAllowedPlanIds(referralExchangePolicyQuery.data.allowedPlanIds.join(', '))
    setAllowedDurationDays(referralExchangePolicyQuery.data.allowedDurationDays.join(', '))
    setCodePrefix(referralExchangePolicyQuery.data.codePrefix)
    setCostPerDay(String(referralExchangePolicyQuery.data.costPerDay))
  }, [referralExchangePolicyQuery.data])

  useEffect(() => {
    if (!partnerWithdrawalPolicyQuery.data) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- TODO: refactor to derive state
    setPartnerMinimumAmount(String(partnerWithdrawalPolicyQuery.data.minimumAmount))
    setPartnerSupportedMethods(partnerWithdrawalPolicyQuery.data.supportedMethods.join(', '))
  }, [partnerWithdrawalPolicyQuery.data])

  return (
    <div className="space-y-4">
      <PlatformSettingsForm />
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.businessPolicy.title')}</CardTitle>
          <CardDescription>{t('settings.businessPolicy.description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 text-sm lg:grid-cols-2">
          <section className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4">
            <div>
              <h2 className="font-semibold text-foreground">{t('settings.businessPolicy.referral.title')}</h2>
              <p className="text-muted-foreground">{t('settings.businessPolicy.referral.description')}</p>
            </div>
            {referralExchangePolicyQuery.data ? (
              <>
                <label className="flex items-center justify-between gap-3 rounded-xl border border-border/60 p-3">
                  <span>{t('settings.businessPolicy.referral.exchangeEnabled')}</span>
                  <Switch checked={referralExchangePolicyQuery.data.exchangeEnabled} onCheckedChange={(checked) => referralExchangePolicyMutation.mutate({ exchangeEnabled: checked })} />
                </label>
                <label className="flex items-center justify-between gap-3 rounded-xl border border-border/60 p-3">
                  <span>{t('settings.businessPolicy.referral.giftPromocodeEnabled')}</span>
                  <Switch checked={referralExchangePolicyQuery.data.giftPromocodeEnabled} onCheckedChange={(checked) => referralExchangePolicyMutation.mutate({ giftPromocodeEnabled: checked })} />
                </label>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="referralAllowedPlanIds">{t('settings.businessPolicy.referral.allowedPlanIds')}</Label>
                    <Input id="referralAllowedPlanIds" value={allowedPlanIds} onChange={(event) => setAllowedPlanIds(event.target.value)} placeholder={t('settings.businessPolicy.referral.allowedPlanIdsPlaceholder')} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="referralAllowedDurationDays">{t('settings.businessPolicy.referral.allowedDurationDays')}</Label>
                    <Input id="referralAllowedDurationDays" value={allowedDurationDays} onChange={(event) => setAllowedDurationDays(event.target.value)} placeholder={t('settings.businessPolicy.referral.allowedDurationDaysPlaceholder')} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="referralCodePrefix">{t('settings.businessPolicy.referral.codePrefix')}</Label>
                    <Input id="referralCodePrefix" value={codePrefix} onChange={(event) => setCodePrefix(event.target.value)} placeholder={t('settings.businessPolicy.referral.codePrefixPlaceholder')} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="referralCostPerDay">{t('settings.businessPolicy.referral.costPerDay')}</Label>
                    <Input id="referralCostPerDay" inputMode="numeric" value={costPerDay} onChange={(event) => setCostPerDay(event.target.value)} placeholder={t('settings.businessPolicy.referral.costPerDayPlaceholder')} />
                  </div>
                </div>
                <Button size="sm" variant="outline" disabled={referralExchangePolicyMutation.isPending} onClick={() => referralExchangePolicyMutation.mutate({ allowedPlanIds: parseCsvValues(allowedPlanIds), allowedDurationDays: parseCsvNumbers(allowedDurationDays), codePrefix: codePrefix.trim(), costPerDay: Number(costPerDay) })}>
                  {t('settings.businessPolicy.referral.save')}
                </Button>
              </>
            ) : <p className="text-muted-foreground">{t('settings.businessPolicy.referral.loading')}</p>}
          </section>

          <section className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4">
            <div>
              <h2 className="font-semibold text-foreground">{t('settings.businessPolicy.partner.title')}</h2>
              <p className="text-muted-foreground">{t('settings.businessPolicy.partner.description')}</p>
            </div>
            {partnerWithdrawalPolicyQuery.data ? (
              <>
                <label className="flex items-center justify-between gap-3 rounded-xl border border-border/60 p-3">
                  <span>{t('settings.businessPolicy.partner.withdrawalsEnabled')}</span>
                  <Switch checked={partnerWithdrawalPolicyQuery.data.enabled} onCheckedChange={(checked) => partnerWithdrawalPolicyMutation.mutate({ enabled: checked })} />
                </label>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="partnerMinimumAmount">{t('settings.businessPolicy.partner.minimumAmount')}</Label>
                    <Input id="partnerMinimumAmount" inputMode="decimal" value={partnerMinimumAmount} onChange={(event) => setPartnerMinimumAmount(event.target.value)} placeholder={t('settings.businessPolicy.partner.minimumAmountPlaceholder')} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="partnerSupportedMethods">{t('settings.businessPolicy.partner.supportedMethods')}</Label>
                    <Input id="partnerSupportedMethods" value={partnerSupportedMethods} onChange={(event) => setPartnerSupportedMethods(event.target.value)} placeholder={t('settings.businessPolicy.partner.supportedMethodsPlaceholder')} />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{t('settings.businessPolicy.partner.updatedAt', { value: partnerWithdrawalPolicyQuery.data.updatedAt })}</p>
                <Button size="sm" variant="outline" disabled={partnerWithdrawalPolicyMutation.isPending} onClick={() => partnerWithdrawalPolicyMutation.mutate({ minimumAmount: Number(partnerMinimumAmount), supportedMethods: parseCsvValues(partnerSupportedMethods) })}>
                  {t('settings.businessPolicy.partner.save')}
                </Button>
              </>
            ) : <p className="text-muted-foreground">{t('settings.businessPolicy.partner.loading')}</p>}
          </section>
        </CardContent>
      </Card>
    </div>
  )
}
