import { type JSX } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
} from '@/components/ui/form'
import { settingsApi } from '@/features/settings/settings-api'
import { PlatformSettingsForm } from '@/features/settings/platform-settings-form'

function parseCsvValues(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function parseCsvNumbers(value: string): number[] {
  return parseCsvValues(value)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
}

export function PlatformSettingsPage(): JSX.Element {
  const { t } = useTranslation()
  const referralExchangePolicyQuery = useQuery({
    queryKey: ['settings', 'referral-exchange-policy'],
    queryFn: settingsApi.getReferralExchangePolicy,
  })
  const partnerWithdrawalPolicyQuery = useQuery({
    queryKey: ['settings', 'partner-withdrawal-policy'],
    queryFn: settingsApi.getPartnerWithdrawalPolicy,
  })

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
              <ReferralExchangeSection data={referralExchangePolicyQuery.data} />
            ) : (
              <p className="text-muted-foreground">{t('settings.businessPolicy.referral.loading')}</p>
            )}
          </section>

          <section className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4">
            <div>
              <h2 className="font-semibold text-foreground">{t('settings.businessPolicy.partner.title')}</h2>
              <p className="text-muted-foreground">{t('settings.businessPolicy.partner.description')}</p>
            </div>
            {partnerWithdrawalPolicyQuery.data ? (
              <PartnerWithdrawalSection data={partnerWithdrawalPolicyQuery.data} />
            ) : (
              <p className="text-muted-foreground">{t('settings.businessPolicy.partner.loading')}</p>
            )}
          </section>
        </CardContent>
      </Card>
    </div>
  )
}

interface ReferralExchangePolicyData {
  exchangeEnabled: boolean
  giftPromocodeEnabled: boolean
  allowedPlanIds: string[]
  allowedDurationDays: number[]
  codePrefix: string
  costPerDay: number
}

interface ReferralExchangeSectionProps {
  readonly data: ReferralExchangePolicyData
}

function ReferralExchangeSection({ data }: ReferralExchangeSectionProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const schema = z.object({
    allowedPlanIds: z.string(),
    allowedDurationDays: z.string(),
    codePrefix: z.string(),
    costPerDay: z.string(),
  })
  type FormValues = z.infer<typeof schema>

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      allowedPlanIds: data.allowedPlanIds.join(', '),
      allowedDurationDays: data.allowedDurationDays.join(', '),
      codePrefix: data.codePrefix,
      costPerDay: String(data.costPerDay),
    },
  })

  const referralExchangePolicyMutation = useMutation({
    mutationFn: settingsApi.updateReferralExchangePolicy,
    onSuccess: async () =>
      queryClient.invalidateQueries({ queryKey: ['settings', 'referral-exchange-policy'] }),
  })

  return (
    <Form {...form}>
      <form
        className="space-y-3"
        onSubmit={form.handleSubmit((values) =>
          referralExchangePolicyMutation.mutate({
            allowedPlanIds: parseCsvValues(values.allowedPlanIds),
            allowedDurationDays: parseCsvNumbers(values.allowedDurationDays),
            codePrefix: values.codePrefix.trim(),
            costPerDay: Number(values.costPerDay),
          }),
        )}
      >
        <label className="flex items-center justify-between gap-3 rounded-xl border border-border/60 p-3">
          <span>{t('settings.businessPolicy.referral.exchangeEnabled')}</span>
          <Switch
            checked={data.exchangeEnabled}
            onCheckedChange={(checked) => referralExchangePolicyMutation.mutate({ exchangeEnabled: checked })}
          />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-xl border border-border/60 p-3">
          <span>{t('settings.businessPolicy.referral.giftPromocodeEnabled')}</span>
          <Switch
            checked={data.giftPromocodeEnabled}
            onCheckedChange={(checked) => referralExchangePolicyMutation.mutate({ giftPromocodeEnabled: checked })}
          />
        </label>
        <div className="grid gap-3 md:grid-cols-2">
          <FormField
            control={form.control}
            name="allowedPlanIds"
            render={({ field }) => (
              <FormItem className="space-y-2">
                <FormLabel htmlFor="referralAllowedPlanIds">
                  {t('settings.businessPolicy.referral.allowedPlanIds')}
                </FormLabel>
                <FormControl>
                  <Input
                    id="referralAllowedPlanIds"
                    {...field}
                    placeholder={t('settings.businessPolicy.referral.allowedPlanIdsPlaceholder')}
                  />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="allowedDurationDays"
            render={({ field }) => (
              <FormItem className="space-y-2">
                <FormLabel htmlFor="referralAllowedDurationDays">
                  {t('settings.businessPolicy.referral.allowedDurationDays')}
                </FormLabel>
                <FormControl>
                  <Input
                    id="referralAllowedDurationDays"
                    {...field}
                    placeholder={t('settings.businessPolicy.referral.allowedDurationDaysPlaceholder')}
                  />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="codePrefix"
            render={({ field }) => (
              <FormItem className="space-y-2">
                <FormLabel htmlFor="referralCodePrefix">
                  {t('settings.businessPolicy.referral.codePrefix')}
                </FormLabel>
                <FormControl>
                  <Input
                    id="referralCodePrefix"
                    {...field}
                    placeholder={t('settings.businessPolicy.referral.codePrefixPlaceholder')}
                  />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="costPerDay"
            render={({ field }) => (
              <FormItem className="space-y-2">
                <FormLabel htmlFor="referralCostPerDay">
                  {t('settings.businessPolicy.referral.costPerDay')}
                </FormLabel>
                <FormControl>
                  <Input
                    id="referralCostPerDay"
                    inputMode="numeric"
                    {...field}
                    placeholder={t('settings.businessPolicy.referral.costPerDayPlaceholder')}
                  />
                </FormControl>
              </FormItem>
            )}
          />
        </div>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={referralExchangePolicyMutation.isPending}
        >
          {t('settings.businessPolicy.referral.save')}
        </Button>
      </form>
    </Form>
  )
}

interface PartnerWithdrawalPolicyData {
  enabled: boolean
  minimumAmount: number
  supportedMethods: string[]
  updatedAt: string
}

interface PartnerWithdrawalSectionProps {
  readonly data: PartnerWithdrawalPolicyData
}

function PartnerWithdrawalSection({ data }: PartnerWithdrawalSectionProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const schema = z.object({
    minimumAmount: z.string(),
    supportedMethods: z.string(),
  })
  type FormValues = z.infer<typeof schema>

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      minimumAmount: String(data.minimumAmount),
      supportedMethods: data.supportedMethods.join(', '),
    },
  })

  const partnerWithdrawalPolicyMutation = useMutation({
    mutationFn: settingsApi.updatePartnerWithdrawalPolicy,
    onSuccess: async () =>
      queryClient.invalidateQueries({ queryKey: ['settings', 'partner-withdrawal-policy'] }),
  })

  return (
    <Form {...form}>
      <form
        className="space-y-3"
        onSubmit={form.handleSubmit((values) =>
          partnerWithdrawalPolicyMutation.mutate({
            minimumAmount: Number(values.minimumAmount),
            supportedMethods: parseCsvValues(values.supportedMethods),
          }),
        )}
      >
        <label className="flex items-center justify-between gap-3 rounded-xl border border-border/60 p-3">
          <span>{t('settings.businessPolicy.partner.withdrawalsEnabled')}</span>
          <Switch
            checked={data.enabled}
            onCheckedChange={(checked) => partnerWithdrawalPolicyMutation.mutate({ enabled: checked })}
          />
        </label>
        <div className="grid gap-3 md:grid-cols-2">
          <FormField
            control={form.control}
            name="minimumAmount"
            render={({ field }) => (
              <FormItem className="space-y-2">
                <FormLabel htmlFor="partnerMinimumAmount">
                  {t('settings.businessPolicy.partner.minimumAmount')}
                </FormLabel>
                <FormControl>
                  <Input
                    id="partnerMinimumAmount"
                    inputMode="decimal"
                    {...field}
                    placeholder={t('settings.businessPolicy.partner.minimumAmountPlaceholder')}
                  />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="supportedMethods"
            render={({ field }) => (
              <FormItem className="space-y-2">
                <FormLabel htmlFor="partnerSupportedMethods">
                  {t('settings.businessPolicy.partner.supportedMethods')}
                </FormLabel>
                <FormControl>
                  <Input
                    id="partnerSupportedMethods"
                    {...field}
                    placeholder={t('settings.businessPolicy.partner.supportedMethodsPlaceholder')}
                  />
                </FormControl>
              </FormItem>
            )}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t('settings.businessPolicy.partner.updatedAt', { value: data.updatedAt })}
        </p>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={partnerWithdrawalPolicyMutation.isPending}
        >
          {t('settings.businessPolicy.partner.save')}
        </Button>
      </form>
    </Form>
  )
}
