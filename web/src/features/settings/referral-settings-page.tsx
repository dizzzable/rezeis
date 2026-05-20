/* eslint-disable @typescript-eslint/no-explicit-any -- TODO: type API responses */
import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Save, Share2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { FadeIn } from '@/lib/motion'

export default function ReferralSettingsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data: settings, isLoading } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: async () => (await api.get('/admin/settings')).data,
  })

  const referral = (settings?.referralSettings ?? {}) as Record<string, any>

  const [enabled, setEnabled] = useState(false)
  const [accrualStrategy, setAccrualStrategy] = useState('ON_FIRST_PAYMENT')
  const [rewardType, setRewardType] = useState('EXTRA_DAYS')
  const [level1Reward, setLevel1Reward] = useState('')
  const [level2Reward, setLevel2Reward] = useState('')
  const [level3Reward, setLevel3Reward] = useState('')
  const [pointsPerReferral, setPointsPerReferral] = useState('')
  const [qualifyOnPurchase, setQualifyOnPurchase] = useState(true)
  const [inviteLinkTtlDays, setInviteLinkTtlDays] = useState('')
  const [inviteSlots, setInviteSlots] = useState('')
  const [inviteSlotsEnabled, setInviteSlotsEnabled] = useState(false)
  const [linkTtlEnabled, setLinkTtlEnabled] = useState(false)

  // Points exchange settings
  const [exchangeEnabled, setExchangeEnabled] = useState(false)
  const [daysEnabled, setDaysEnabled] = useState(true)
  const [daysPointsCost, setDaysPointsCost] = useState('1')
  const [giftEnabled, setGiftEnabled] = useState(false)
  const [giftPointsCost, setGiftPointsCost] = useState('30')
  const [giftDurationDays, setGiftDurationDays] = useState('30')
  const [discountEnabled, setDiscountEnabled] = useState(false)
  const [discountPointsCost, setDiscountPointsCost] = useState('10')
  const [discountMaxPercent, setDiscountMaxPercent] = useState('50')
  const [trafficEnabled, setTrafficEnabled] = useState(false)
  const [trafficPointsCost, setTrafficPointsCost] = useState('5')
  const [trafficMaxGb, setTrafficMaxGb] = useState('100')

  useEffect(() => {
    if (referral) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- TODO: refactor to derive state
      setEnabled(referral.enabled ?? referral.enable ?? true)
      setAccrualStrategy(referral.accrualStrategy ?? 'ON_FIRST_PAYMENT')
      setRewardType(referral.rewardType ?? 'EXTRA_DAYS')
      setLevel1Reward(String(referral.level1Reward ?? referral.pointsPerReferral ?? '5'))
      setLevel2Reward(String(referral.level2Reward ?? ''))
      setLevel3Reward(String(referral.level3Reward ?? ''))
      setPointsPerReferral(String(referral.pointsPerReferral ?? ''))
      setQualifyOnPurchase(referral.qualifyOnPurchase ?? true)
      setInviteLinkTtlDays(String(referral.inviteLinkTtlDays ?? referral.inviteLimits?.linkTtlSeconds ? Math.round((referral.inviteLimits?.linkTtlSeconds ?? 0) / 86400) : ''))
      setInviteSlots(String(referral.inviteSlots ?? referral.inviteLimits?.initialSlots ?? ''))
      setInviteSlotsEnabled(referral.inviteLimits?.slotsEnabled ?? false)
      setLinkTtlEnabled(referral.inviteLimits?.linkTtlEnabled ?? false)

      // Points exchange
      const pe = referral.pointsExchange ?? {}
      setExchangeEnabled(pe.exchangeEnabled ?? false)
      setDaysEnabled(pe.subscriptionDays?.enabled ?? true)
      setDaysPointsCost(String(pe.subscriptionDays?.pointsCost ?? '1'))
      setGiftEnabled(pe.giftSubscription?.enabled ?? false)
      setGiftPointsCost(String(pe.giftSubscription?.pointsCost ?? '30'))
      setGiftDurationDays(String(pe.giftSubscription?.giftDurationDays ?? '30'))
      setDiscountEnabled(pe.discount?.enabled ?? false)
      setDiscountPointsCost(String(pe.discount?.pointsCost ?? '10'))
      setDiscountMaxPercent(String(pe.discount?.maxDiscountPercent ?? '50'))
      setTrafficEnabled(pe.traffic?.enabled ?? false)
      setTrafficPointsCost(String(pe.traffic?.pointsCost ?? '5'))
      setTrafficMaxGb(String(pe.traffic?.maxTrafficGb ?? '100'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])

  const saveMutation = useMutation({
    mutationFn: () => api.patch('/admin/settings/referral', {
      enabled,
      accrualStrategy,
      rewardType,
      level1Reward: level1Reward ? parseInt(level1Reward) : undefined,
      level2Reward: level2Reward ? parseInt(level2Reward) : undefined,
      level3Reward: level3Reward ? parseInt(level3Reward) : undefined,
      pointsPerReferral: pointsPerReferral ? parseInt(pointsPerReferral) : undefined,
      qualifyOnPurchase,
      inviteLimits: {
        linkTtlEnabled,
        linkTtlSeconds: inviteLinkTtlDays ? parseInt(inviteLinkTtlDays) * 86400 : null,
        slotsEnabled: inviteSlotsEnabled,
        initialSlots: inviteSlots ? parseInt(inviteSlots) : null,
      },
      pointsExchange: {
        exchangeEnabled,
        subscriptionDays: { enabled: daysEnabled, pointsCost: parseInt(daysPointsCost) || 1 },
        giftSubscription: { enabled: giftEnabled, pointsCost: parseInt(giftPointsCost) || 30, giftDurationDays: parseInt(giftDurationDays) || 30 },
        discount: { enabled: discountEnabled, pointsCost: parseInt(discountPointsCost) || 10, maxDiscountPercent: parseInt(discountMaxPercent) || 50 },
        traffic: { enabled: trafficEnabled, pointsCost: parseInt(trafficPointsCost) || 5, maxTrafficGb: parseInt(trafficMaxGb) || 100 },
      },
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] }); toast.success(t('referralSettingsPage.saved')) },
    onError: () => toast.error(t('referralSettingsPage.saveFailed')),
  })

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Share2 className="h-6 w-6" /> {t('referralSettingsPage.title')}
            </h1>
            <p className="text-muted-foreground">{t('referralSettingsPage.subtitle')}</p>
          </div>
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            {t('referralSettingsPage.save')}
          </Button>
        </div>
      </FadeIn>

      {/* General */}
      <Card>
        <CardHeader><CardTitle>{t('referralSettingsPage.general.title')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('referralSettingsPage.general.enable')}</Label>
              <p className="text-xs text-muted-foreground">{t('referralSettingsPage.general.enableHint')}</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('referralSettingsPage.general.qualifyOnPurchase')}</Label>
              <p className="text-xs text-muted-foreground">{t('referralSettingsPage.general.qualifyOnPurchaseHint')}</p>
            </div>
            <Switch checked={qualifyOnPurchase} onCheckedChange={setQualifyOnPurchase} />
          </div>
          <div className="space-y-1.5 max-w-xs">
            <Label>{t('referralSettingsPage.general.accrualStrategy')}</Label>
            <Select value={accrualStrategy} onValueChange={setAccrualStrategy}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ON_FIRST_PAYMENT">{t('referralSettingsPage.general.onFirstPayment')}</SelectItem>
                <SelectItem value="ON_EACH_PAYMENT">{t('referralSettingsPage.general.onEachPayment')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Rewards */}
      <Card>
        <CardHeader>
          <CardTitle>{t('referralSettingsPage.rewards.title')}</CardTitle>
          <CardDescription>{t('referralSettingsPage.rewards.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5 max-w-xs">
            <Label>{t('referralSettingsPage.rewards.rewardType')}</Label>
            <Select value={rewardType} onValueChange={setRewardType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="EXTRA_DAYS">{t('referralSettingsPage.rewards.extraDays')}</SelectItem>
                <SelectItem value="POINTS">{t('referralSettingsPage.rewards.points')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              { label: t('referralSettingsPage.rewards.level1'), value: level1Reward, set: setLevel1Reward },
              { label: t('referralSettingsPage.rewards.level2'), value: level2Reward, set: setLevel2Reward },
              { label: t('referralSettingsPage.rewards.level3'), value: level3Reward, set: setLevel3Reward },
            ].map((f) => (
              <div key={f.label} className="space-y-1.5">
                <Label>{f.label}</Label>
                <Input
                  type="number" min="0" placeholder="0"
                  value={f.value} onChange={(e) => f.set(e.target.value)}
                />
                <p className="text-[10px] text-muted-foreground">
                  {rewardType === 'EXTRA_DAYS' ? t('referralSettingsPage.rewards.unitDays') : t('referralSettingsPage.rewards.unitPoints')}
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Invite Limits */}
      <Card>
        <CardHeader>
          <CardTitle>{t('referralSettingsPage.inviteLimits.title')}</CardTitle>
          <CardDescription>{t('referralSettingsPage.inviteLimits.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('referralSettingsPage.inviteLimits.enableLinkTtl')}</Label>
              <p className="text-xs text-muted-foreground">{t('referralSettingsPage.inviteLimits.enableLinkTtlHint')}</p>
            </div>
            <Switch checked={linkTtlEnabled} onCheckedChange={setLinkTtlEnabled} />
          </div>
          {linkTtlEnabled && (
            <div className="space-y-1.5 w-40">
              <Label>{t('referralSettingsPage.inviteLimits.linkTtlDays')}</Label>
              <Input type="number" min="1" value={inviteLinkTtlDays} onChange={(e) => setInviteLinkTtlDays(e.target.value)} />
            </div>
          )}
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('referralSettingsPage.inviteLimits.enableSlots')}</Label>
              <p className="text-xs text-muted-foreground">{t('referralSettingsPage.inviteLimits.enableSlotsHint')}</p>
            </div>
            <Switch checked={inviteSlotsEnabled} onCheckedChange={setInviteSlotsEnabled} />
          </div>
          {inviteSlotsEnabled && (
            <div className="space-y-1.5 w-40">
              <Label>{t('referralSettingsPage.inviteLimits.initialSlots')}</Label>
              <Input type="number" min="1" value={inviteSlots} onChange={(e) => setInviteSlots(e.target.value)} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Points Exchange */}
      <Card>
        <CardHeader>
          <CardTitle>{t('referralSettingsPage.pointsExchange.title')}</CardTitle>
          <CardDescription>{t('referralSettingsPage.pointsExchange.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('referralSettingsPage.pointsExchange.enable')}</Label>
              <p className="text-xs text-muted-foreground">{t('referralSettingsPage.pointsExchange.enableHint')}</p>
            </div>
            <Switch checked={exchangeEnabled} onCheckedChange={setExchangeEnabled} />
          </div>

          {exchangeEnabled && (
            <div className="space-y-4 pt-2">
              {/* Subscription Days */}
              <div className="rounded-md border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="font-medium">{t('referralSettingsPage.pointsExchange.subscriptionDays')}</Label>
                  <Switch checked={daysEnabled} onCheckedChange={setDaysEnabled} />
                </div>
                {daysEnabled && (
                  <div className="space-y-1.5 w-48">
                    <Label className="text-xs">{t('referralSettingsPage.pointsExchange.pointsPerDay')}</Label>
                    <Input type="number" min="1" value={daysPointsCost} onChange={(e) => setDaysPointsCost(e.target.value)} />
                  </div>
                )}
              </div>

              {/* Gift Subscription */}
              <div className="rounded-md border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="font-medium">{t('referralSettingsPage.pointsExchange.giftSubscription')}</Label>
                  <Switch checked={giftEnabled} onCheckedChange={setGiftEnabled} />
                </div>
                {giftEnabled && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t('referralSettingsPage.pointsExchange.pointsCost')}</Label>
                      <Input type="number" min="1" value={giftPointsCost} onChange={(e) => setGiftPointsCost(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t('referralSettingsPage.pointsExchange.giftDuration')}</Label>
                      <Input type="number" min="1" value={giftDurationDays} onChange={(e) => setGiftDurationDays(e.target.value)} />
                    </div>
                  </div>
                )}
              </div>

              {/* Discount */}
              <div className="rounded-md border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="font-medium">{t('referralSettingsPage.pointsExchange.personalDiscount')}</Label>
                  <Switch checked={discountEnabled} onCheckedChange={setDiscountEnabled} />
                </div>
                {discountEnabled && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t('referralSettingsPage.pointsExchange.pointsPerPercent')}</Label>
                      <Input type="number" min="1" value={discountPointsCost} onChange={(e) => setDiscountPointsCost(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t('referralSettingsPage.pointsExchange.maxDiscount')}</Label>
                      <Input type="number" min="1" max="100" value={discountMaxPercent} onChange={(e) => setDiscountMaxPercent(e.target.value)} />
                    </div>
                  </div>
                )}
              </div>

              {/* Traffic */}
              <div className="rounded-md border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="font-medium">{t('referralSettingsPage.pointsExchange.extraTraffic')}</Label>
                  <Switch checked={trafficEnabled} onCheckedChange={setTrafficEnabled} />
                </div>
                {trafficEnabled && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t('referralSettingsPage.pointsExchange.pointsPerGb')}</Label>
                      <Input type="number" min="1" value={trafficPointsCost} onChange={(e) => setTrafficPointsCost(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t('referralSettingsPage.pointsExchange.maxTraffic')}</Label>
                      <Input type="number" min="1" value={trafficMaxGb} onChange={(e) => setTrafficMaxGb(e.target.value)} />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
