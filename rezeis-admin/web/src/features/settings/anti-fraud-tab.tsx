/**
 * Anti-fraud tab — operator-editable detector thresholds.
 *
 * These knobs used to be `ANTIFRAUD_*` environment variables, which meant
 * changing one was an edit-a-file-and-restart-a-container job. They are now
 * stored in the panel, and the environment variable is only the fallback:
 *
 *     stored panel value  →  environment variable  →  built-in default
 *          (wins)                (fallback)
 *
 * The form says so out loud rather than leaving an operator to work it out: a
 * field taken from the panel is badged, and its env value is shown beneath it,
 * so somebody who set `ANTIFRAUD_SHARING_IP_WINDOW_MINUTES=30` and then sees 45
 * here can see exactly why.
 *
 * Bounds are NOT hardcoded here — they arrive in `ranges` from the same tables
 * the server validates against, so the `min`/`max` on these inputs cannot drift
 * away from what the API will accept. An out-of-range value is rejected by the
 * server with a message naming the field, which is surfaced verbatim in the
 * toast; it is never silently clamped.
 *
 * ONE SECTION HAS ONLY TWO LAYERS. The subscription-UA knobs are new: no
 * `ANTIFRAUD_UA_*` variable has ever existed and none was added, so under a
 * stored value there is the built-in default and nothing else. That section says
 * "default", not "environment", and its reset button says "reset to defaults" —
 * a form that claimed an env layer it does not have would send an operator
 * looking for a variable to set.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, RotateCcw, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useHasPermission } from '@/features/rbac'

import {
  settingsApi,
  type AntiFraudSettings,
  type AntiFraudSettingsPatch,
  type SharingDetectionConfig,
  type SubscriptionUaConfig,
  type TrafficAbuseConfig,
  type TunableRange,
} from './settings-api'
import {
  buildResetPatch,
  getAntiFraudFormKey,
  serverMessage,
  toFormState,
} from './anti-fraud-form-state'

const ANTI_FRAUD_SETTINGS_KEY = ['settings', 'anti-fraud'] as const

type SharingKey = keyof SharingDetectionConfig
type TrafficKey = keyof TrafficAbuseConfig
type SubscriptionUaKey = keyof SubscriptionUaConfig

/** Order the fields are rendered in — also the order the form reads them back. */
const SHARING_SWITCHES: readonly SharingKey[] = [
  'enableHwidOverage',
  'enableIpSharing',
  'ipNetworkGrouping',
]
const SHARING_NUMBERS: readonly SharingKey[] = [
  'ipWindowMinutes',
  'ipConcurrencyWindowSeconds',
  'ipOverageMargin',
  'ipV4PrefixLength',
  'ipV6PrefixLength',
  'maxNodesPerRun',
  'maxIpsInMetadata',
]
/**
 * Sharing knobs that have NO `ANTIFRAUD_*` variable under them, so the value
 * shown beneath a saved override is the built-in default and must not be
 * labelled "Environment:". Everything else in this section predates the panel
 * and keeps its env layer; see `sharing-detection.config.ts`.
 */
const SHARING_WITHOUT_ENV = new Set<SharingKey>(['ipConcurrencyWindowSeconds'])
const TRAFFIC_NUMBERS: readonly TrafficKey[] = [
  'minGb',
  'medianMultiplier',
  'sharePercent',
  'maxNodesPerRun',
]
const SUBSCRIPTION_UA_NUMBERS: readonly SubscriptionUaKey[] = [
  'uaEvidenceWindowMinutes',
  'uaRequestPageSize',
]

export default function AntiFraudTab() {
  const { data, isLoading } = useQuery({
    queryKey: ANTI_FRAUD_SETTINGS_KEY,
    queryFn: settingsApi.getAntiFraudSettings,
  })
  return <AntiFraudTabForm key={getAntiFraudFormKey(data)} settings={data} isLoading={isLoading} />
}

function AntiFraudTabForm({
  settings,
  isLoading,
}: {
  settings: AntiFraudSettings | undefined
  isLoading: boolean
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const canEdit = useHasPermission('settings', 'edit')
  const canSeeAccuracy = useHasPermission('fraud_signals', 'view')

  const effective = settings?.effective
  // Two separate maps, NOT one merged one: `maxNodesPerRun` exists in both
  // sections with different bounds and different meanings, so a flat state
  // object would have the traffic knob silently overwrite the sharing knob.
  const [sharing, setSharing] = useState<Record<string, string | boolean>>(() =>
    effective ? toFormState(effective.sharing) : {},
  )
  const [traffic, setTraffic] = useState<Record<string, string | boolean>>(() =>
    effective ? toFormState(effective.trafficAbuse) : {},
  )
  const [subscriptionUa, setSubscriptionUa] = useState<Record<string, string | boolean>>(() =>
    effective ? toFormState(effective.subscriptionUa) : {},
  )

  const overriddenSharing = useMemo(
    () => new Set(settings?.overridden.sharing ?? []),
    [settings],
  )
  const overriddenTraffic = useMemo(
    () => new Set(settings?.overridden.trafficAbuse ?? []),
    [settings],
  )
  const overriddenSubscriptionUa = useMemo(
    () => new Set(settings?.overridden.subscriptionUa ?? []),
    [settings],
  )

  const mutation = useMutation({
    mutationFn: (patch: AntiFraudSettingsPatch) => settingsApi.updateAntiFraudSettings(patch),
    onSuccess: (next) => {
      queryClient.setQueryData(ANTI_FRAUD_SETTINGS_KEY, next)
      toast.success(t('antiFraudTab.saved'))
    },
    // The server names the offending field and its range; showing that beats
    // any generic string this form could invent, and it is the whole point of
    // rejecting rather than clamping.
    onError: (error) => toast.error(serverMessage(error) ?? t('antiFraudTab.saveFailed')),
  })

  if (isLoading || !settings || !effective) {
    return (
      <Card>
        <CardContent className="flex h-32 items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
        </CardContent>
      </Card>
    )
  }

  const submitSharing = () => {
    const patch: AntiFraudSettingsPatch['sharing'] = {}
    for (const key of SHARING_SWITCHES) patch[key] = Boolean(sharing[key]) as never
    for (const key of SHARING_NUMBERS) patch[key] = Number(sharing[key]) as never
    mutation.mutate({ sharing: patch })
  }
  const submitTraffic = () => {
    const patch: AntiFraudSettingsPatch['trafficAbuse'] = { enabled: Boolean(traffic.enabled) }
    for (const key of TRAFFIC_NUMBERS) patch[key] = Number(traffic[key]) as never
    mutation.mutate({ trafficAbuse: patch })
  }
  const submitSubscriptionUa = () => {
    const patch: AntiFraudSettingsPatch['subscriptionUa'] = {
      enableSubscriptionUaTunnel: Boolean(subscriptionUa.enableSubscriptionUaTunnel),
    }
    for (const key of SUBSCRIPTION_UA_NUMBERS) patch[key] = Number(subscriptionUa[key]) as never
    mutation.mutate({ subscriptionUa: patch })
  }
  /**
   * Clear every stored field of a section — back to the environment variables,
   * or, for `subscriptionUa`, back to the built-in defaults.
   */
  const resetSection = (section: 'sharing' | 'trafficAbuse' | 'subscriptionUa') => {
    const fields =
      section === 'sharing'
        ? [...SHARING_SWITCHES, ...SHARING_NUMBERS]
        : section === 'trafficAbuse'
          ? ['enabled', ...TRAFFIC_NUMBERS]
          : ['enableSubscriptionUaTunnel', ...SUBSCRIPTION_UA_NUMBERS]
    mutation.mutate(buildResetPatch(section, fields as readonly string[]))
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <ShieldAlert className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t('antiFraudTab.title')}
          </CardTitle>
          <CardDescription className="space-y-1 text-xs">
            <span className="block">{t('antiFraudTab.precedence')}</span>
            <span className="block">{t('antiFraudTab.applyTiming')}</span>
            {/* The one number that says whether a threshold change would help,
                pointed at rather than duplicated. The report reads fraud
                signals and its endpoint is gated on `fraud_signals:view`, not
                on the `settings:view` that opens this tab — so it lives on the
                fraud page, and the link only appears to somebody who can
                actually follow it. Rendering the card here instead would 403
                for a settings-only operator. */}
            {canSeeAccuracy ? (
              <span className="block">
                <Link to="/fraud" className="underline underline-offset-2 hover:text-foreground">
                  {t('antiFraudTab.accuracyLink')}
                </Link>
              </span>
            ) : null}
          </CardDescription>
        </CardHeader>
      </Card>

      <Section
        title={t('antiFraudTab.sharing.title')}
        description={t('antiFraudTab.sharing.description')}
        canEdit={canEdit}
        pending={mutation.isPending}
        onSave={submitSharing}
        onReset={() => resetSection('sharing')}
        hasOverrides={overriddenSharing.size > 0}
      >
        {SHARING_SWITCHES.map((key) => (
          <SwitchRow
            key={key}
            id={`af-sharing-${key}`}
            label={t(`antiFraudTab.sharing.fields.${key}.label`)}
            hint={t(`antiFraudTab.sharing.fields.${key}.hint`)}
            checked={Boolean(sharing[key])}
            onChange={(value) => setSharing((prev) => ({ ...prev, [key]: value }))}
            disabled={!canEdit}
            overridden={overriddenSharing.has(key)}
            fallbackLabel={
              settings.fallback.sharing[key]
                ? t('antiFraudTab.envOn')
                : t('antiFraudTab.envOff')
            }
          />
        ))}
        {SHARING_NUMBERS.map((key) => (
          <NumberRow
            key={key}
            id={`af-sharing-${key}`}
            label={t(`antiFraudTab.sharing.fields.${key}.label`)}
            hint={t(`antiFraudTab.sharing.fields.${key}.hint`)}
            value={String(sharing[key] ?? '')}
            onChange={(value) => setSharing((prev) => ({ ...prev, [key]: value }))}
            range={settings.ranges.sharing[key]}
            disabled={!canEdit}
            overridden={overriddenSharing.has(key)}
            fallbackValue={settings.fallback.sharing[key] as number}
            fallbackNote={
              SHARING_WITHOUT_ENV.has(key) ? 'antiFraudTab.defaultIs' : undefined
            }
          />
        ))}
      </Section>

      <Section
        title={t('antiFraudTab.traffic.title')}
        description={t('antiFraudTab.traffic.description')}
        canEdit={canEdit}
        pending={mutation.isPending}
        onSave={submitTraffic}
        onReset={() => resetSection('trafficAbuse')}
        hasOverrides={overriddenTraffic.size > 0}
      >
        <SwitchRow
          id="af-traffic-enabled"
          label={t('antiFraudTab.traffic.fields.enabled.label')}
          hint={t('antiFraudTab.traffic.fields.enabled.hint')}
          checked={Boolean(traffic.enabled)}
          onChange={(value) => setTraffic((prev) => ({ ...prev, enabled: value }))}
          disabled={!canEdit}
          overridden={overriddenTraffic.has('enabled')}
          fallbackLabel={
            settings.fallback.trafficAbuse.enabled
              ? t('antiFraudTab.envOn')
              : t('antiFraudTab.envOff')
          }
        />
        {TRAFFIC_NUMBERS.map((key) => (
          <NumberRow
            key={key}
            id={`af-traffic-${key}`}
            label={t(`antiFraudTab.traffic.fields.${key}.label`)}
            hint={t(`antiFraudTab.traffic.fields.${key}.hint`)}
            value={String(traffic[key] ?? '')}
            onChange={(value) => setTraffic((prev) => ({ ...prev, [key]: value }))}
            range={settings.ranges.trafficAbuse[key]}
            disabled={!canEdit}
            overridden={overriddenTraffic.has(key)}
            fallbackValue={settings.fallback.trafficAbuse[key] as number}
          />
        ))}
      </Section>

      <Section
        title={t('antiFraudTab.subscriptionUa.title')}
        description={t('antiFraudTab.subscriptionUa.description')}
        canEdit={canEdit}
        pending={mutation.isPending}
        onSave={submitSubscriptionUa}
        onReset={() => resetSection('subscriptionUa')}
        hasOverrides={overriddenSubscriptionUa.size > 0}
        // No env layer under this section — see the file header.
        resetLabel={t('antiFraudTab.resetToDefault')}
      >
        <SwitchRow
          id="af-ua-enableSubscriptionUaTunnel"
          label={t('antiFraudTab.subscriptionUa.fields.enableSubscriptionUaTunnel.label')}
          hint={t('antiFraudTab.subscriptionUa.fields.enableSubscriptionUaTunnel.hint')}
          checked={Boolean(subscriptionUa.enableSubscriptionUaTunnel)}
          onChange={(value) =>
            setSubscriptionUa((prev) => ({ ...prev, enableSubscriptionUaTunnel: value }))
          }
          disabled={!canEdit}
          overridden={overriddenSubscriptionUa.has('enableSubscriptionUaTunnel')}
          fallbackLabel={
            settings.fallback.subscriptionUa.enableSubscriptionUaTunnel
              ? t('antiFraudTab.envOn')
              : t('antiFraudTab.envOff')
          }
          fallbackNote="antiFraudTab.defaultIs"
        />
        {SUBSCRIPTION_UA_NUMBERS.map((key) => (
          <NumberRow
            key={key}
            id={`af-ua-${key}`}
            label={t(`antiFraudTab.subscriptionUa.fields.${key}.label`)}
            hint={t(`antiFraudTab.subscriptionUa.fields.${key}.hint`)}
            value={String(subscriptionUa[key] ?? '')}
            onChange={(value) => setSubscriptionUa((prev) => ({ ...prev, [key]: value }))}
            range={settings.ranges.subscriptionUa[key]}
            disabled={!canEdit}
            overridden={overriddenSubscriptionUa.has(key)}
            fallbackValue={settings.fallback.subscriptionUa[key] as number}
            fallbackNote="antiFraudTab.defaultIs"
          />
        ))}
      </Section>
    </div>
  )
}

function Section({
  title,
  description,
  canEdit,
  pending,
  hasOverrides,
  onSave,
  onReset,
  resetLabel,
  children,
}: {
  title: string
  description: string
  canEdit: boolean
  pending: boolean
  hasOverrides: boolean
  onSave: () => void
  onReset: () => void
  /** Defaults to "reset to environment"; sections with no env layer pass their own. */
  resetLabel?: string
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {children}
        {canEdit && (
          <div className="flex justify-end gap-2 pt-1">
            {hasOverrides && (
              <Button variant="outline" onClick={onReset} disabled={pending}>
                <RotateCcw className="mr-2 h-4 w-4" aria-hidden />
                {resetLabel ?? t('antiFraudTab.resetToEnv')}
              </Button>
            )}
            <Button onClick={onSave} disabled={pending}>
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              {t('antiFraudTab.save')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function OverrideBadge({ overridden }: { overridden: boolean }) {
  const { t } = useTranslation()
  if (!overridden) return null
  return (
    <Badge variant="secondary" className="ml-2 text-[10px]">
      {t('antiFraudTab.panelValue')}
    </Badge>
  )
}

function SwitchRow({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
  overridden,
  fallbackLabel,
  fallbackNote = 'antiFraudTab.envIs',
}: {
  id: string
  label: string
  hint: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled: boolean
  overridden: boolean
  fallbackLabel: string
  /** Translation key naming the layer under a stored value: env, or default. */
  fallbackNote?: string
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
          <OverrideBadge overridden={overridden} />
        </Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
        {overridden && (
          <p className="text-xs text-muted-foreground">
            {t(fallbackNote, { value: fallbackLabel })}
          </p>
        )}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
    </div>
  )
}

function NumberRow({
  id,
  label,
  hint,
  value,
  onChange,
  range,
  disabled,
  overridden,
  fallbackValue,
  fallbackNote = 'antiFraudTab.envIs',
}: {
  id: string
  label: string
  hint: string
  value: string
  onChange: (value: string) => void
  range: TunableRange | undefined
  disabled: boolean
  overridden: boolean
  fallbackValue: number
  /** Translation key naming the layer under a stored value: env, or default. */
  fallbackNote?: string
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
          <OverrideBadge overridden={overridden} />
        </Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
        <p className="text-xs text-muted-foreground">
          {range
            ? t('antiFraudTab.allowedRange', { min: range.min, max: range.max })
            : null}
          {overridden ? ` · ${t(fallbackNote, { value: fallbackValue })}` : null}
        </p>
      </div>
      <Input
        id={id}
        type="number"
        min={range?.min}
        max={range?.max}
        step={range?.integer === false ? 'any' : 1}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-28 shrink-0"
      />
    </div>
  )
}
