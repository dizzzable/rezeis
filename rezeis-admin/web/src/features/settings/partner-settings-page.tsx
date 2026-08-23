import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Save, Handshake, Info, Loader2, CreditCard } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { FadeIn } from '@/lib/motion'
import {
  type PaymentGatewayIconType,
  getPaymentGatewayIcon,
} from '@/features/payments/payment-gateway-icons'

/**
 * Catalog of every gateway the rezeis-admin platform supports. The order
 * mirrors `PaymentGatewayType` in `prisma/schema.prisma`. Default
 * commission percents are based on each provider's published rate cards
 * and can be overridden by the operator at runtime.
 *
 * `key` is the JSON field name persisted under `Settings.partnerSettings`.
 * Backend resolves the gateway commission through either a structured
 * `gatewayCommissions[GATEWAY]` map (preferred) or a flat
 * `${gatewayType.toLowerCase()}Commission` field (legacy parity); we
 * write both shapes from this form.
 */
const GATEWAY_COMMISSIONS: ReadonlyArray<{
  readonly type: PaymentGatewayIconType
  readonly key: string
  readonly label: string
  readonly default: string
}> = [
  { type: 'YOOKASSA', key: 'yookassaCommission', label: 'YooKassa', default: '3.5' },
  { type: 'TELEGRAM_STARS', key: 'telegram_starsCommission', label: 'Telegram Stars', default: '30' },
  { type: 'PLATEGA', key: 'plategaCommission', label: 'Platega', default: '3.5' },
  { type: 'HELEKET', key: 'heleketCommission', label: 'Heleket', default: '1.0' },
  { type: 'CRYPTOMUS', key: 'cryptomusCommission', label: 'Cryptomus', default: '1.0' },
  { type: 'MULENPAY', key: 'mulenpayCommission', label: 'MulenPay', default: '3.5' },
  { type: 'ANTILOPAY', key: 'antilopayCommission', label: 'Antilopay', default: '3.5' },
  { type: 'OVERPAY', key: 'overpayCommission', label: 'OverPay', default: '3.5' },
  { type: 'PAYPALYCH', key: 'paypalychCommission', label: 'PayPalych', default: '3.5' },
  { type: 'RIOPAY', key: 'riopayCommission', label: 'RioPay', default: '3.5' },
  { type: 'VALUTIX', key: 'valutixCommission', label: 'Valutix', default: '3.5' },
  { type: 'WATA', key: 'wataCommission', label: 'WATA', default: '3.0' },
  { type: 'AURAPAY', key: 'aurapayCommission', label: 'AuraPay', default: '3.5' },
  { type: 'ROLLYPAY', key: 'rollypayCommission', label: 'RollyPay', default: '3.5' },
  { type: 'SEVERPAY', key: 'severpayCommission', label: 'SeverPay', default: '3.5' },
  { type: 'LAVA', key: 'lavaCommission', label: 'Lava.top', default: '5.0' },
] as const

type AccrualStrategy = 'ON_EACH_PAYMENT' | 'ON_FIRST_PAYMENT'

interface PartnerSettings {
  enabled?: boolean
  invitedOnly?: boolean
  allowBalancePayment?: boolean
  level1Percent?: number | string
  level2Percent?: number | string
  level3Percent?: number | string
  minWithdrawalAmount?: number | string
  autoCalculateCommission?: boolean
  taxPercent?: number | string
  accrualStrategy?: AccrualStrategy
  /**
   * Per-level accrual mode, read by the backend BEFORE the flat
   * `levelNAccrualStrategy` keys and before the legacy flat `accrualStrategy`.
   * A level that is absent, null, empty or unrecognised is not an error — it
   * falls through to the next source, which is what "inherit" is made of.
   */
  accrualStrategies?: Record<string, unknown>
  gatewayCommissions?: Record<string, number>
  [k: string]: unknown
}

/**
 * The empty state of a per-level accrual control.
 *
 * An explicit option, never a blank: a level with no stored value FOLLOWS the
 * strategy above, and a blank would read as "nothing set". (A Radix
 * `SelectItem` cannot carry an empty string as its value either.)
 */
const INHERIT_LEVEL_ACCRUAL = 'INHERIT'

const ACCRUAL_LEVELS = [1, 2, 3] as const

const levelAccrualField = z.enum([
  INHERIT_LEVEL_ACCRUAL,
  'ON_EACH_PAYMENT',
  'ON_FIRST_PAYMENT',
])

/**
 * Mirrors the backend's `readAccrualMode`: anything that is not one of the
 * recognised spellings — absent, null, empty, junk — is not a mode and falls
 * through. `ONCE_PER_USER` is the per-partner enum spelling of the same thing.
 */
function normaliseAccrualMode(value: unknown): AccrualStrategy | null {
  if (typeof value !== 'string') return null
  const upper = value.trim().toUpperCase()
  if (upper === 'ON_FIRST_PAYMENT' || upper === 'ONCE_PER_USER') return 'ON_FIRST_PAYMENT'
  if (upper === 'ON_EACH_PAYMENT') return 'ON_EACH_PAYMENT'
  return null
}

/**
 * What the form should show for one level, in the order the backend resolves
 * it: `accrualStrategies.LEVEL_N` → flat `levelNAccrualStrategy` → inherit.
 *
 * It deliberately does NOT fall back to `partner.accrualStrategy`. That is the
 * value the level inherits, and pre-filling the control with it would turn an
 * inherited level into a stored one on the very next save — the level would
 * stop following the strategy above without the operator ever choosing that.
 */
function readGlobalLevelAccrual(
  partner: PartnerSettings,
  level: (typeof ACCRUAL_LEVELS)[number],
): AccrualStrategy | typeof INHERIT_LEVEL_ACCRUAL {
  const fromMap = normaliseAccrualMode(partner.accrualStrategies?.[`LEVEL_${level}`])
  if (fromMap !== null) return fromMap
  const fromFlat = normaliseAccrualMode(partner[`level${level}AccrualStrategy`])
  if (fromFlat !== null) return fromFlat
  return INHERIT_LEVEL_ACCRUAL
}

/** Info icon whose explanation appears on hover and on keyboard focus. */
function SettingHint({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className="inline-flex text-muted-foreground transition-colors hover:text-foreground"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs leading-snug">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export default function PartnerSettingsPage() {
  const { t } = useTranslation()
  const { data: settings, isError, isLoading } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: async () => (await api.get('/admin/settings')).data,
  })

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  // A FAILED LOAD IS NOT AN EMPTY FORM.
  //
  // Every control below is a statement about `Settings.partnerSettings`, and
  // the per-level accrual selects are the loudest of them: "Inherit (On each
  // payment)" claims that three levels are following the strategy above. Built
  // from a request that never arrived that claim is invented — and the Save
  // button beside it would write the invention back over whatever is really
  // stored, clearing every per-level mode in one click.
  //
  // An ABSENT `partnerSettings` on a response that DID arrive is a different
  // thing: a real, empty install, which still gets the form and its defaults.
  // The guard is on the request failing, not on the object being missing.
  if (isError || settings === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Handshake className="h-5 w-5" /> {t('partnerSettingsPage.title')}
          </CardTitle>
          <CardDescription>{t('partnerSettingsPage.loadFailed')}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const partner = ((settings?.partnerSettings as PartnerSettings | undefined) ?? {}) as PartnerSettings

  return <PartnerSettingsForm partner={partner} />
}

interface PartnerSettingsFormProps {
  readonly partner: PartnerSettings
}

function PartnerSettingsForm({ partner }: PartnerSettingsFormProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const percent = z
    .string()
    .trim()
    .refine(
      (v) => {
        if (v === '') return true
        const n = parseFloat(v)
        return !Number.isNaN(n) && n >= 0 && n <= 100
      },
      { message: t('partnerSettingsPage.validation.percentRange') },
    )

  const positiveInt = z
    .string()
    .trim()
    .refine(
      (v) => {
        if (v === '') return true
        return /^\d+$/.test(v)
      },
      { message: t('partnerSettingsPage.validation.positiveAmount') },
    )

  const schema = z.object({
    enabled: z.boolean(),
    invitedOnly: z.boolean(),
    allowBalancePayment: z.boolean(),
    autoCalculate: z.boolean(),
    accrualStrategy: z.enum(['ON_EACH_PAYMENT', 'ON_FIRST_PAYMENT']),
    accrualStrategies: z.object({
      LEVEL_1: levelAccrualField,
      LEVEL_2: levelAccrualField,
      LEVEL_3: levelAccrualField,
    }),
    level1Percent: percent,
    level2Percent: percent,
    level3Percent: percent,
    taxPercent: percent,
    minWithdrawal: positiveInt,
    commissions: z.record(z.string(), percent),
  })

  type FormValues = z.infer<typeof schema>

  const initialCommissions: Record<string, string> = {}
  for (const gc of GATEWAY_COMMISSIONS) {
    const fromMap = partner.gatewayCommissions?.[gc.type]
    const fromFlat = partner[gc.key]
    const value = fromMap ?? fromFlat
    initialCommissions[gc.key] = value !== undefined && value !== null ? String(value) : gc.default
  }

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      enabled: partner.enabled ?? false,
      invitedOnly: partner.invitedOnly ?? false,
      allowBalancePayment: partner.allowBalancePayment ?? false,
      autoCalculate: partner.autoCalculateCommission ?? false,
      accrualStrategy: (partner.accrualStrategy as AccrualStrategy | undefined) ?? 'ON_EACH_PAYMENT',
      accrualStrategies: {
        LEVEL_1: readGlobalLevelAccrual(partner, 1),
        LEVEL_2: readGlobalLevelAccrual(partner, 2),
        LEVEL_3: readGlobalLevelAccrual(partner, 3),
      },
      level1Percent: partner.level1Percent != null ? String(partner.level1Percent) : '',
      level2Percent: partner.level2Percent != null ? String(partner.level2Percent) : '',
      level3Percent: partner.level3Percent != null ? String(partner.level3Percent) : '',
      taxPercent: partner.taxPercent != null ? String(partner.taxPercent) : '',
      minWithdrawal: partner.minWithdrawalAmount != null ? String(partner.minWithdrawalAmount) : '',
      commissions: initialCommissions,
    },
  })

  // react-hook-form's `form.watch()` integration is not yet recognised by react-doctor.
  // eslint-disable-next-line react-hooks/incompatible-library
  const accrualStrategy = form.watch('accrualStrategy')
  const inheritedAccrualLabel =
    accrualStrategy === 'ON_FIRST_PAYMENT'
      ? t('partnerSettingsPage.general.onFirstPayment')
      : t('partnerSettingsPage.general.onEachPayment')
  const minWithdrawalRaw = form.watch('minWithdrawal')

  const saveMutation = useMutation({
    mutationFn: (values: FormValues) => {
      const gatewayCommissionsMap: Record<string, number> = {}
      const payload: Record<string, unknown> = {
        enabled: values.enabled,
        invitedOnly: values.invitedOnly,
        allowBalancePayment: values.allowBalancePayment,
        level1Percent: values.level1Percent ? parseFloat(values.level1Percent) : undefined,
        level2Percent: values.level2Percent ? parseFloat(values.level2Percent) : undefined,
        level3Percent: values.level3Percent ? parseFloat(values.level3Percent) : undefined,
        minWithdrawalAmount: values.minWithdrawal ? parseInt(values.minWithdrawal, 10) : undefined,
        autoCalculateCommission: values.autoCalculate,
        taxPercent: values.taxPercent ? parseFloat(values.taxPercent) : undefined,
        accrualStrategy: values.accrualStrategy,
      }
      // ALL THREE LEVELS, ALWAYS — even the ones the operator did not touch.
      // `accrualStrategies` is NOT in `mergePartnerSettings`'s deep-merge list
      // (only `levels`, `gatewayCommissions` and `withdrawals` are), so the
      // settings PATCH replaces this object wholesale. A submit carrying only
      // the changed level would silently drop the other two.
      //
      // "Inherit" goes out as `null` in BOTH shapes. The backend resolves a
      // level as map → flat `levelNAccrualStrategy` → legacy flat
      // `accrualStrategy`, and `null` is not a recognised mode in either of the
      // first two, so it reaches the legacy key — today's behaviour. Writing
      // only the map would leave a stale flat key still pinning the level.
      const accrualStrategies: Record<string, string | null> = {}
      for (const level of ACCRUAL_LEVELS) {
        const chosen = values.accrualStrategies[`LEVEL_${level}`]
        const wire = chosen === INHERIT_LEVEL_ACCRUAL ? null : chosen
        accrualStrategies[`LEVEL_${level}`] = wire
        payload[`level${level}AccrualStrategy`] = wire
      }
      payload.accrualStrategies = accrualStrategies
      for (const gc of GATEWAY_COMMISSIONS) {
        const v = values.commissions[gc.key]
        if (!v) continue
        const parsed = parseFloat(v)
        if (Number.isFinite(parsed)) {
          // Persist both shapes so backend resolves the value through either lookup path.
          payload[gc.key] = parsed
          gatewayCommissionsMap[gc.type] = parsed
        }
      }
      payload.gatewayCommissions = gatewayCommissionsMap
      return api.patch('/admin/settings/partner', payload)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] })
      toast.success(t('partnerSettingsPage.saved'))
    },
    onError: () => toast.error(t('partnerSettingsPage.saveFailed')),
  })

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((values) => saveMutation.mutate(values))}
        className="space-y-6"
      >
        <FadeIn>
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                <Handshake className="h-6 w-6" /> {t('partnerSettingsPage.title')}
              </h1>
              <p className="text-muted-foreground">{t('partnerSettingsPage.subtitle')}</p>
            </div>
            <Button type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              {t('partnerSettingsPage.save')}
            </Button>
          </div>
        </FadeIn>

        {/* Three-column hero: General / Commission rates / Withdrawal rules */}
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle>{t('partnerSettingsPage.general.title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField
                control={form.control}
                name="enabled"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between space-y-0">
                    <div>
                      <FormLabel>{t('partnerSettingsPage.general.enable')}</FormLabel>
                      <FormDescription className="text-xs">
                        {t('partnerSettingsPage.general.enableHint')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
              {/* Gates the PARTNER program specifically: read by
                  `InternalPartnerController.isPartnerProgramAvailable`, which
                  also blocks withdrawal requests. Distinct from the identically
                  named referral setting — the two programs are separate.
                  Must stay in the form: settings are PATCH-merged, so dropping
                  the key would freeze whatever is stored today with no way to
                  turn it off. */}
              <FormField
                control={form.control}
                name="invitedOnly"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between space-y-0">
                    <div>
                      <FormLabel>{t('partnerSettingsPage.general.invitedOnly')}</FormLabel>
                      <FormDescription className="text-xs">
                        {t('partnerSettingsPage.general.invitedOnlyHint')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="allowBalancePayment"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between space-y-0">
                    <div>
                      <FormLabel>{t('partnerSettingsPage.general.allowBalancePayment')}</FormLabel>
                      <FormDescription className="text-xs">
                        {t('partnerSettingsPage.general.allowBalancePaymentHint')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="autoCalculate"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between space-y-0">
                    <div>
                      <FormLabel>{t('partnerSettingsPage.general.autoCalculate')}</FormLabel>
                      <FormDescription className="text-xs">
                        {t('partnerSettingsPage.general.autoCalculateHint')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="accrualStrategy"
                render={({ field }) => (
                  <FormItem className="space-y-1.5">
                    <FormLabel>{t('partnerSettingsPage.general.accrualStrategy')}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="ON_EACH_PAYMENT">
                          {t('partnerSettingsPage.general.onEachPayment')}
                        </SelectItem>
                        <SelectItem value="ON_FIRST_PAYMENT">
                          {t('partnerSettingsPage.general.onFirstPayment')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription className="text-[11px]">
                      {accrualStrategy === 'ON_FIRST_PAYMENT'
                        ? t('partnerSettingsPage.general.onFirstPaymentHint')
                        : t('partnerSettingsPage.general.onEachPaymentHint')}
                    </FormDescription>
                  </FormItem>
                )}
              />

              <div className="space-y-1.5">
                <div className="flex items-center gap-1">
                  <FormLabel className="text-xs">
                    {t('partnerSettingsPage.general.levelAccrual.title')}
                  </FormLabel>
                </div>
                <FormDescription className="text-[11px]">
                  {t('partnerSettingsPage.general.levelAccrual.description')}
                </FormDescription>
                <div className="grid grid-cols-3 gap-2">
                  {ACCRUAL_LEVELS.map((level) => (
                    <FormField
                      key={level}
                      control={form.control}
                      name={`accrualStrategies.LEVEL_${level}` as const}
                      render={({ field }) => (
                        <FormItem className="space-y-1">
                          <div className="flex items-center gap-1">
                            <FormLabel className="text-[10px] uppercase">L{level}</FormLabel>
                            <SettingHint
                              label={t('partnerSettingsPage.general.levelAccrual.hintAria', {
                                level,
                              })}
                              text={t('partnerSettingsPage.general.levelAccrual.hint', {
                                level,
                              })}
                            />
                          </div>
                          <Select value={field.value} onValueChange={field.onChange}>
                            <FormControl>
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value={INHERIT_LEVEL_ACCRUAL}>
                                {t('partnerSettingsPage.general.levelAccrual.inherit', {
                                  value: inheritedAccrualLabel,
                                })}
                              </SelectItem>
                              <SelectItem value="ON_EACH_PAYMENT">
                                {t('partnerSettingsPage.general.onEachPayment')}
                              </SelectItem>
                              <SelectItem value="ON_FIRST_PAYMENT">
                                {t('partnerSettingsPage.general.onFirstPayment')}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )}
                    />
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle>{t('partnerSettingsPage.commissionRates.title')}</CardTitle>
              <CardDescription>
                {t('partnerSettingsPage.commissionRates.description')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
                {(['level1Percent', 'level2Percent', 'level3Percent'] as const).map((name, idx) => (
                  <FormField
                    key={name}
                    control={form.control}
                    name={name}
                    render={({ field }) => (
                      <FormItem className="space-y-1.5">
                        <FormLabel className="text-xs">
                          {idx === 0
                            ? t('partnerSettingsPage.commissionRates.level1')
                            : idx === 1
                              ? t('partnerSettingsPage.commissionRates.level2')
                              : t('partnerSettingsPage.commissionRates.level3')}
                        </FormLabel>
                        <FormControl>
                          <div className="relative">
                            <Input
                              type="number"
                              min="0"
                              max="100"
                              step="0.1"
                              placeholder="0"
                              {...field}
                              className="pr-8 h-8 text-sm"
                            />
                            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">
                              %
                            </span>
                          </div>
                        </FormControl>
                        <FormMessage className="text-[10px]" />
                      </FormItem>
                    )}
                  />
                ))}
              </div>
              <FormField
                control={form.control}
                name="taxPercent"
                render={({ field }) => (
                  <FormItem className="space-y-1.5">
                    <FormLabel className="text-xs">
                      {t('partnerSettingsPage.commissionRates.taxPercent')}
                    </FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Input
                          type="number"
                          min="0"
                          max="100"
                          step="0.1"
                          placeholder="6"
                          {...field}
                          className="pr-8 h-8 text-sm"
                        />
                        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">
                          %
                        </span>
                      </div>
                    </FormControl>
                    <FormDescription className="text-[10px]">
                      {t('partnerSettingsPage.commissionRates.taxPercentHint')}
                    </FormDescription>
                    <FormMessage className="text-[10px]" />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle>{t('partnerSettingsPage.withdrawal.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              <FormField
                control={form.control}
                name="minWithdrawal"
                render={({ field }) => (
                  <FormItem className="space-y-1.5">
                    <FormLabel>{t('partnerSettingsPage.withdrawal.minAmount')}</FormLabel>
                    <FormControl>
                      <Input type="number" min="0" step="1" placeholder="50000" {...field} />
                    </FormControl>
                    <FormDescription className="text-[11px]">
                      {minWithdrawalRaw && /^\d+$/.test(minWithdrawalRaw)
                        ? `= ${(parseInt(minWithdrawalRaw, 10) / 100).toFixed(2)} ₽`
                        : t('partnerSettingsPage.withdrawal.defaultHint')}
                    </FormDescription>
                    <FormMessage className="text-[10px]" />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>
        </div>

        {/* Gateway commissions — full-width with brand icons */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle>{t('partnerSettingsPage.gatewayCommissions.title')}</CardTitle>
                <CardDescription>
                  {t('partnerSettingsPage.gatewayCommissions.description')}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {GATEWAY_COMMISSIONS.map((gc) => {
                const Icon = getPaymentGatewayIcon(gc.type)
                return (
                  <FormField
                    key={gc.key}
                    control={form.control}
                    name={`commissions.${gc.key}` as const}
                    render={({ field }) => (
                      <FormItem className="space-y-1">
                        <FormLabel className="text-xs flex items-center gap-2">
                          {Icon ? (
                            <Icon className="h-4 w-4" />
                          ) : (
                            <span className="h-4 w-4 inline-block rounded-sm bg-muted/40" />
                          )}
                          <span>{gc.label}</span>
                        </FormLabel>
                        <FormControl>
                          <div className="relative">
                            <Input
                              type="number"
                              min="0"
                              max="100"
                              step="0.1"
                              {...field}
                              className="pr-8 h-8 text-sm"
                            />
                            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">
                              %
                            </span>
                          </div>
                        </FormControl>
                        <FormMessage className="text-[10px]" />
                      </FormItem>
                    )}
                  />
                )
              })}
            </div>
          </CardContent>
        </Card>
      </form>
    </Form>
  )
}
