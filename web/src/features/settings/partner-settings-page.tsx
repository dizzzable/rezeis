/* eslint-disable @typescript-eslint/no-explicit-any -- TODO: type API responses */
import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Save, Handshake, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { FadeIn } from '@/lib/motion'

const GATEWAY_COMMISSIONS = [
  { key: 'yookassaCommission', label: 'YooKassa', default: '3.5' },
  { key: 'yoomoneyCommission', label: 'YooMoney', default: '3.5' },
  { key: 'tbankCommission', label: 'T-Bank', default: '2.8' },
  { key: 'robokassaCommission', label: 'Robokassa', default: '3.5' },
  { key: 'stripeCommission', label: 'Stripe', default: '3.5' },
  { key: 'mulenpayCommission', label: 'MulenPay', default: '3.5' },
  { key: 'cloudpaymentsCommission', label: 'CloudPayments', default: '3.5' },
  { key: 'telegramStarsCommission', label: 'Telegram Stars', default: '30' },
  { key: 'cryptopayCommission', label: 'CryptoPay', default: '1.0' },
  { key: 'cryptomusCommission', label: 'Cryptomus', default: '1.0' },
  { key: 'heleketCommission', label: 'Heleket', default: '1.0' },
  { key: 'pal24Commission', label: 'Pal24', default: '5.0' },
  { key: 'wataCommission', label: 'WATA', default: '3.0' },
  { key: 'plategaCommission', label: 'Platega', default: '3.5' },
  { key: 'antilopayCommission', label: 'Antilopay', default: '3.5' },
  { key: 'paypalychCommission', label: 'PayPalych', default: '3.5' },
  { key: 'overpayCommission', label: 'OverPay', default: '3.5' },
  { key: 'riopayCommission', label: 'RioPay', default: '3.5' },
]

export default function PartnerSettingsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data: settings, isLoading } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: async () => (await api.get('/admin/settings')).data,
  })

  const partner = (settings?.partnerSettings ?? {}) as Record<string, any>

  const [enabled, setEnabled] = useState(false)
  const [level1Percent, setLevel1Percent] = useState('')
  const [level2Percent, setLevel2Percent] = useState('')
  const [level3Percent, setLevel3Percent] = useState('')
  const [minWithdrawal, setMinWithdrawal] = useState('')
  const [autoCalculate, setAutoCalculate] = useState(false)
  const [taxPercent, setTaxPercent] = useState('')
  const [accrualStrategy, setAccrualStrategy] = useState('ON_EACH_PAYMENT')
  const [commissions, setCommissions] = useState<Record<string, string>>({})

  useEffect(() => {
    if (partner) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- TODO: refactor to derive state
      setEnabled(partner.enabled ?? false)
      setLevel1Percent(String(partner.level1Percent ?? ''))
      setLevel2Percent(String(partner.level2Percent ?? ''))
      setLevel3Percent(String(partner.level3Percent ?? ''))
      setMinWithdrawal(String(partner.minWithdrawalAmount ?? ''))
      setAutoCalculate(partner.autoCalculateCommission ?? false)
      setTaxPercent(String(partner.taxPercent ?? ''))
      setAccrualStrategy(partner.accrualStrategy ?? 'ON_EACH_PAYMENT')

      const comms: Record<string, string> = {}
      for (const gc of GATEWAY_COMMISSIONS) {
        comms[gc.key] = String(partner[gc.key] ?? gc.default)
      }
      setCommissions(comms)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, any> = {
        enabled,
        level1Percent: level1Percent ? parseFloat(level1Percent) : undefined,
        level2Percent: level2Percent ? parseFloat(level2Percent) : undefined,
        level3Percent: level3Percent ? parseFloat(level3Percent) : undefined,
        minWithdrawalAmount: minWithdrawal ? parseInt(minWithdrawal) : undefined,
        autoCalculateCommission: autoCalculate,
        taxPercent: taxPercent ? parseFloat(taxPercent) : undefined,
        accrualStrategy,
      }
      // Add gateway commissions
      for (const gc of GATEWAY_COMMISSIONS) {
        if (commissions[gc.key]) {
          payload[gc.key] = parseFloat(commissions[gc.key])
        }
      }
      return api.patch('/admin/settings/partner', payload)
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] }); toast.success(t('partnerSettingsPage.saved')) },
    onError: () => toast.error(t('partnerSettingsPage.saveFailed')),
  })

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Handshake className="h-6 w-6" /> {t('partnerSettingsPage.title')}
            </h1>
            <p className="text-muted-foreground">{t('partnerSettingsPage.subtitle')}</p>
          </div>
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            {t('partnerSettingsPage.save')}
          </Button>
        </div>
      </FadeIn>

      <Card>
        <CardHeader><CardTitle>{t('partnerSettingsPage.general.title')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('partnerSettingsPage.general.enable')}</Label>
              <p className="text-xs text-muted-foreground">{t('partnerSettingsPage.general.enableHint')}</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('partnerSettingsPage.general.autoCalculate')}</Label>
              <p className="text-xs text-muted-foreground">{t('partnerSettingsPage.general.autoCalculateHint')}</p>
            </div>
            <Switch checked={autoCalculate} onCheckedChange={setAutoCalculate} />
          </div>
          <div className="space-y-1.5 max-w-xs">
            <Label>{t('partnerSettingsPage.general.accrualStrategy')}</Label>
            <Select value={accrualStrategy} onValueChange={setAccrualStrategy}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ON_EACH_PAYMENT">{t('partnerSettingsPage.general.onEachPayment')}</SelectItem>
                <SelectItem value="ON_FIRST_PAYMENT">{t('partnerSettingsPage.general.onFirstPayment')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {accrualStrategy === 'ON_FIRST_PAYMENT'
                ? t('partnerSettingsPage.general.onFirstPaymentHint')
                : t('partnerSettingsPage.general.onEachPaymentHint')}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('partnerSettingsPage.commissionRates.title')}</CardTitle>
          <CardDescription>{t('partnerSettingsPage.commissionRates.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              { label: t('partnerSettingsPage.commissionRates.level1'), value: level1Percent, set: setLevel1Percent },
              { label: t('partnerSettingsPage.commissionRates.level2'), value: level2Percent, set: setLevel2Percent },
              { label: t('partnerSettingsPage.commissionRates.level3'), value: level3Percent, set: setLevel3Percent },
            ].map((f) => (
              <div key={f.label} className="space-y-1.5">
                <Label>{f.label}</Label>
                <div className="relative">
                  <Input
                    type="number" min="0" max="100" step="0.1" placeholder="0"
                    value={f.value} onChange={(e) => f.set(e.target.value)}
                    className="pr-8"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('partnerSettingsPage.commissionRates.taxPercent')}</Label>
              <div className="relative w-40">
                <Input
                  type="number" min="0" max="100" step="0.1" placeholder="6"
                  value={taxPercent} onChange={(e) => setTaxPercent(e.target.value)}
                  className="pr-8"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
              </div>
              <p className="text-[11px] text-muted-foreground">{t('partnerSettingsPage.commissionRates.taxPercentHint')}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('partnerSettingsPage.withdrawal.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1.5 w-64">
            <Label>{t('partnerSettingsPage.withdrawal.minAmount')}</Label>
            <Input
              type="number" min="0" step="1" placeholder="50000"
              value={minWithdrawal} onChange={(e) => setMinWithdrawal(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              {minWithdrawal ? `= ${(parseInt(minWithdrawal) / 100).toFixed(2)} ₽` : t('partnerSettingsPage.withdrawal.defaultHint')}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('partnerSettingsPage.gatewayCommissions.title')}</CardTitle>
          <CardDescription>
            {t('partnerSettingsPage.gatewayCommissions.description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {GATEWAY_COMMISSIONS.map((gc) => (
              <div key={gc.key} className="space-y-1">
                <Label className="text-xs">{gc.label}</Label>
                <div className="relative">
                  <Input
                    type="number" min="0" max="100" step="0.1"
                    value={commissions[gc.key] ?? gc.default}
                    onChange={(e) => setCommissions((prev) => ({ ...prev, [gc.key]: e.target.value }))}
                    className="pr-8 h-8 text-sm"
                  />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">%</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
