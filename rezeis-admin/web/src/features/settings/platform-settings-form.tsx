import type { JSX } from 'react'
import { useEffect } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CalendarClock, LoaderCircle, Palette, Save, Settings2, ShieldCheck } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  DEFAULT_PLATFORM_ACCESS_MODE,
  isPlatformAccessMode,
  PLATFORM_ACCESS_MODES,
  type PlatformAccessMode,
} from '@/features/settings/access-mode'
import { createPlatformSettingsSchema } from '@/features/settings/platform-settings-schema'
import { settingsApi } from '@/features/settings/settings-api'
import { queryClient } from '@/lib/query-client'

type PlatformSettingsFormValues = z.infer<ReturnType<typeof createPlatformSettingsSchema>>

type PlatformSettingsFormVariant = 'full' | 'accessMode'

const ACCESS_MODE_PREVIEW_MODES: readonly PlatformAccessMode[] = PLATFORM_ACCESS_MODES

interface PlatformSettingsFormProps {
  readonly variant?: PlatformSettingsFormVariant
}

function readString(value: string | null | undefined): string {
  return typeof value === 'string' ? value : ''
}

function formatDateTimeInput(value: string | null | undefined): string {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const offsetInMinutes: number = date.getTimezoneOffset()
  const normalizedDate: Date = new Date(date.getTime() - offsetInMinutes * 60_000)
  return normalizedDate.toISOString().slice(0, 16)
}

function formatNullableString(value: string): string | null {
  const normalizedValue: string = value.trim()
  return normalizedValue ? normalizedValue : null
}

function formatNullableDateTime(value: string): string | null {
  if (!value) {
    return null
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date.toISOString()
}

function getConfiguredStateKey(value: string): 'configured' | 'missing' {
  return value.trim().length > 0 ? 'configured' : 'missing'
}

export function PlatformSettingsForm({ variant = 'full' }: PlatformSettingsFormProps): JSX.Element {
  const { t } = useTranslation()
  const platformSettingsSchema = createPlatformSettingsSchema()
  const isAccessModeVariant: boolean = variant === 'accessMode'
  const settingsQuery = useQuery({
    queryKey: ['settings', 'platform'],
    queryFn: settingsApi.getPlatformSettings,
  })
  const form = useForm<PlatformSettingsFormValues>({
    resolver: zodResolver(platformSettingsSchema),
    defaultValues: {
      rulesRequired: false,
      rulesLink: '',
      channelRequired: false,
      channelId: '',
      channelLink: '',
      accessMode: DEFAULT_PLATFORM_ACCESS_MODE,
      inviteModeStartedAt: '',
      defaultCurrency: 'USD',
      projectName: '',
      webTitle: '',
      supportUrl: '',
      supportUsername: '',
      accessRequestIntro: '',
      accessApprovedMessage: '',
      accessRejectedMessage: '',
    },
  })
  const updateMutation = useMutation({
    mutationFn: settingsApi.updatePlatformSettings,
    onSuccess: (settings): void => {
      queryClient.setQueryData(['settings', 'platform'], settings)
      toast.success(t('settings.platform.saveSuccess'))
    },
    onError: (): void => {
      toast.error(t('settings.platform.saveError'))
    },
  })
  useEffect((): void => {
    if (!settingsQuery.data) {
      return
    }
    form.reset({
      rulesRequired: settingsQuery.data.rulesRequired,
      rulesLink: readString(settingsQuery.data.rulesLink),
      channelRequired: settingsQuery.data.channelRequired,
      channelId: readString(settingsQuery.data.channelId),
      channelLink: readString(settingsQuery.data.channelLink),
      accessMode: settingsQuery.data.accessMode,
      inviteModeStartedAt: formatDateTimeInput(settingsQuery.data.inviteModeStartedAt),
      defaultCurrency: readString(settingsQuery.data.defaultCurrency) || 'USD',
      projectName: readString(settingsQuery.data.branding.projectName),
      webTitle: readString(settingsQuery.data.branding.webTitle),
      supportUrl: readString(settingsQuery.data.branding.supportUrl),
      supportUsername: readString(settingsQuery.data.branding.supportUsername),
      accessRequestIntro: readString(settingsQuery.data.branding.accessRequestIntro),
      accessApprovedMessage: readString(settingsQuery.data.branding.accessApprovedMessage),
      accessRejectedMessage: readString(settingsQuery.data.branding.accessRejectedMessage),
    })
  }, [settingsQuery.data, form])
  function handleSubmit(values: PlatformSettingsFormValues): void {
    updateMutation.mutate({
      rulesRequired: values.rulesRequired,
      rulesLink: formatNullableString(values.rulesLink),
      channelRequired: values.channelRequired,
      channelId: formatNullableString(values.channelId),
      channelLink: formatNullableString(values.channelLink),
      accessMode: values.accessMode,
      inviteModeStartedAt: formatNullableDateTime(values.inviteModeStartedAt),
      defaultCurrency: values.defaultCurrency.trim().toUpperCase(),
      branding: {
        projectName: formatNullableString(values.projectName),
        webTitle: formatNullableString(values.webTitle),
        supportUrl: formatNullableString(values.supportUrl),
        supportUsername: formatNullableString(values.supportUsername),
        accessRequestIntro: formatNullableString(values.accessRequestIntro),
        accessApprovedMessage: formatNullableString(values.accessApprovedMessage),
        accessRejectedMessage: formatNullableString(values.accessRejectedMessage),
      },
    })
  }

  // eslint-disable-next-line react-hooks/incompatible-library -- react-hook-form watch() pattern
  const accessModeValue: PlatformAccessMode = form.watch('accessMode')
  const rulesRequired: boolean = form.watch('rulesRequired')
  const channelRequired: boolean = form.watch('channelRequired')
  const rulesLink: string = form.watch('rulesLink')
  const channelId: string = form.watch('channelId')
  const channelLink: string = form.watch('channelLink')

  return (
    <div className="space-y-4">
      {isAccessModeVariant ? (
        <Card className="overflow-hidden border-border/80 bg-[linear-gradient(145deg,oklch(0.992_0.006_84.6)_0%,oklch(0.948_0.026_206.87/0.76)_100%)] shadow-sm">
          <CardHeader className="gap-4">
            <Badge className="w-fit">{t('accessModePage.badge')}</Badge>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="max-w-3xl space-y-2">
                <CardTitle className="text-2xl tracking-tight">{t('accessModePage.title')}</CardTitle>
                <CardDescription className="text-sm leading-6">{t('accessModePage.summary')}</CardDescription>
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3 text-sm text-muted-foreground">{t('settings.platform.endpoint')}</div>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3 border-t border-border/60 pt-6 md:grid-cols-3">
            <div className="rounded-2xl border border-border/70 bg-background/75 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('accessModePage.snapshot.modeLabel')}</p>
              <p className="mt-2 text-base font-semibold">{t(`settings.platform.accessModes.${accessModeValue}`)}</p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/75 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('accessModePage.snapshot.rulesLabel')}</p>
              <p className="mt-2 text-base font-semibold">{rulesRequired ? t('accessModePage.snapshot.required') : t('accessModePage.snapshot.optional')}</p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/75 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('accessModePage.snapshot.channelLabel')}</p>
              <p className="mt-2 text-base font-semibold">{channelRequired ? t('accessModePage.snapshot.required') : t('accessModePage.snapshot.optional')}</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2 rounded-[28px] border border-border/80 bg-card/90 px-5 py-5 shadow-sm backdrop-blur sm:px-6">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">{t('settings.platform.breadcrumb')}</p>
          <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">{t('settings.platform.title')}</h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{t('settings.platform.summary')}</p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/70 px-4 py-3 text-sm text-muted-foreground">{t('settings.platform.endpoint')}</div>
          </div>
        </div>
      )}
      {isAccessModeVariant ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('accessModePage.preview.title')}</CardTitle>
            <CardDescription>{t('accessModePage.preview.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              {ACCESS_MODE_PREVIEW_MODES.map((mode) => {
                const isCurrentMode: boolean = accessModeValue === mode
                return (
                  <div key={mode} className={`rounded-2xl border p-4 ${isCurrentMode ? 'border-primary/40 bg-primary/5' : 'border-border/70 bg-background/70'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold">{t(`settings.platform.accessModes.${mode}`)}</p>
                      {isCurrentMode ? <Badge variant="secondary">{t('accessModePage.preview.current')}</Badge> : null}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{t(`accessModePage.preview.modes.${mode}`)}</p>
                  </div>
                )
              })}
            </div>
            <div className="grid gap-3 lg:grid-cols-3">
              <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('accessModePage.preview.outcomes.registration')}</p>
                <p className="mt-2 text-sm font-medium">{t(`accessModePage.preview.registration.${accessModeValue}`)}</p>
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('accessModePage.preview.outcomes.purchase')}</p>
                <p className="mt-2 text-sm font-medium">{t(`accessModePage.preview.purchase.${accessModeValue}`)}</p>
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('accessModePage.preview.outcomes.gates')}</p>
                <div className="mt-2 space-y-1 text-sm font-medium">
                  <p>{t('accessModePage.preview.rulesGate', { state: rulesRequired ? t('accessModePage.snapshot.required') : t('accessModePage.snapshot.optional') })}</p>
                  <p>{t('accessModePage.preview.channelGate', { state: channelRequired ? t('accessModePage.snapshot.required') : t('accessModePage.snapshot.optional') })}</p>
                </div>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-2xl border border-border/70 bg-background/70 p-4 text-sm">
                <span className="font-medium">{t('accessModePage.preview.links.rules')}</span>
                <span className="ml-2 text-muted-foreground">{t(`accessModePage.preview.linkState.${getConfiguredStateKey(rulesLink)}`)}</span>
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/70 p-4 text-sm">
                <span className="font-medium">{t('accessModePage.preview.links.channelId')}</span>
                <span className="ml-2 text-muted-foreground">{t(`accessModePage.preview.linkState.${getConfiguredStateKey(channelId)}`)}</span>
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/70 p-4 text-sm">
                <span className="font-medium">{t('accessModePage.preview.links.channelLink')}</span>
                <span className="ml-2 text-muted-foreground">{t(`accessModePage.preview.linkState.${getConfiguredStateKey(channelLink)}`)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}
      <form className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]" onSubmit={form.handleSubmit(handleSubmit)}>
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex size-11 items-center justify-center rounded-2xl bg-accent text-primary">
                {isAccessModeVariant ? <ShieldCheck className="size-5" /> : <Settings2 className="size-5" />}
              </div>
              <div>
                <CardTitle>{isAccessModeVariant ? t('accessModePage.consoleTitle') : t('settings.platform.accessPolicyTitle')}</CardTitle>
                <CardDescription>{isAccessModeVariant ? t('accessModePage.consoleDescription') : t('settings.platform.accessPolicyDescription')}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="flex items-start gap-3 rounded-2xl border border-border/70 bg-background/70 p-4">
                <Checkbox
                  className="mt-1"
                  checked={form.watch('rulesRequired')}
                  onCheckedChange={(checked: boolean | 'indeterminate'): void => {
                    form.setValue('rulesRequired', checked === true, { shouldDirty: true })
                  }}
                />
                <div>
                  <p className="text-sm font-medium">{t('settings.platform.labels.rulesRequired')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{t('settings.platform.labels.rulesRequiredHint')}</p>
                </div>
              </label>
              <label className="flex items-start gap-3 rounded-2xl border border-border/70 bg-background/70 p-4">
                <Checkbox
                  className="mt-1"
                  checked={form.watch('channelRequired')}
                  onCheckedChange={(checked: boolean | 'indeterminate'): void => {
                    form.setValue('channelRequired', checked === true, { shouldDirty: true })
                  }}
                />
                <div>
                  <p className="text-sm font-medium">{t('settings.platform.labels.channelRequired')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{t('settings.platform.labels.channelRequiredHint')}</p>
                </div>
              </label>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="rulesLink">{t('settings.platform.labels.rulesLink')}</Label>
                <Input id="rulesLink" placeholder={t('settings.platform.placeholders.rulesLink')} {...form.register('rulesLink')} />
                {form.formState.errors.rulesLink ? <p className="text-sm text-destructive">{t(form.formState.errors.rulesLink.message ?? '')}</p> : null}
              </div>
              <div className="space-y-2">
                <Label htmlFor="accessMode">{t('settings.platform.labels.accessMode')}</Label>
                <Select
                  value={form.watch('accessMode')}
                  onValueChange={(value: string): void => {
                    if (!isPlatformAccessMode(value)) {
                      return
                    }
                    form.setValue('accessMode', value satisfies PlatformAccessMode, { shouldDirty: true })
                  }}
                >
                  <SelectTrigger id="accessMode" className="w-full">
                    <SelectValue placeholder={t('settings.platform.labels.accessMode')} />
                  </SelectTrigger>
                  <SelectContent>
                    {PLATFORM_ACCESS_MODES.map((accessMode) => (
                      <SelectItem key={accessMode} value={accessMode}>
                        {t(`settings.platform.accessModes.${accessMode}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {form.formState.errors.accessMode ? <p className="text-sm text-destructive">{t(form.formState.errors.accessMode.message ?? '')}</p> : null}
              </div>
              <div className="space-y-2">
                <Label htmlFor="channelId">{t('settings.platform.labels.channelId')}</Label>
                <Input id="channelId" placeholder={t('settings.platform.placeholders.channelId')} {...form.register('channelId')} />
                {form.formState.errors.channelId ? <p className="text-sm text-destructive">{t(form.formState.errors.channelId.message ?? '')}</p> : null}
              </div>
              <div className="space-y-2">
                <Label htmlFor="channelLink">{t('settings.platform.labels.channelLink')}</Label>
                <Input id="channelLink" placeholder={t('settings.platform.placeholders.channelLink')} {...form.register('channelLink')} />
                {form.formState.errors.channelLink ? <p className="text-sm text-destructive">{t(form.formState.errors.channelLink.message ?? '')}</p> : null}
              </div>
            </div>
            {isAccessModeVariant ? (
              <div className="rounded-2xl border border-border/70 bg-background/70 p-4 text-sm text-muted-foreground">
                {t('accessModePage.consoleHint')}
              </div>
            ) : null}
          </CardContent>
        </Card>
        {isAccessModeVariant ? null : (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex size-11 items-center justify-center rounded-2xl bg-accent text-primary">
                  <Palette className="size-5" />
                </div>
                <div>
                  <CardTitle>{t('settings.platform.brandingTitle')}</CardTitle>
                  <CardDescription>{t('settings.platform.brandingDescription')}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="projectName">{t('settings.platform.labels.projectName')}</Label>
                  <Input id="projectName" placeholder={t('settings.platform.placeholders.projectName')} {...form.register('projectName')} />
                  {form.formState.errors.projectName ? <p className="text-sm text-destructive">{t(form.formState.errors.projectName.message ?? '')}</p> : null}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="webTitle">{t('settings.platform.labels.webTitle')}</Label>
                  <Input id="webTitle" placeholder={t('settings.platform.placeholders.webTitle')} {...form.register('webTitle')} />
                  {form.formState.errors.webTitle ? <p className="text-sm text-destructive">{t(form.formState.errors.webTitle.message ?? '')}</p> : null}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="supportUrl">{t('settings.platform.labels.supportUrl')}</Label>
                  <Input id="supportUrl" placeholder={t('settings.platform.placeholders.supportUrl')} {...form.register('supportUrl')} />
                  {form.formState.errors.supportUrl ? <p className="text-sm text-destructive">{t(form.formState.errors.supportUrl.message ?? '')}</p> : null}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="supportUsername">{t('settings.platform.labels.supportUsername')}</Label>
                  <Input id="supportUsername" placeholder={t('settings.platform.placeholders.supportUsername')} {...form.register('supportUsername')} />
                  {form.formState.errors.supportUsername ? <p className="text-sm text-destructive">{t(form.formState.errors.supportUsername.message ?? '')}</p> : null}
                </div>
              </div>
              <div className="grid gap-4 lg:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="accessRequestIntro">{t('settings.platform.labels.accessRequestIntro')}</Label>
                  <Textarea id="accessRequestIntro" className="min-h-28" placeholder={t('settings.platform.placeholders.accessRequestIntro')} {...form.register('accessRequestIntro')} />
                  {form.formState.errors.accessRequestIntro ? <p className="text-sm text-destructive">{t(form.formState.errors.accessRequestIntro.message ?? '')}</p> : null}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="accessApprovedMessage">{t('settings.platform.labels.accessApprovedMessage')}</Label>
                  <Textarea id="accessApprovedMessage" className="min-h-28" placeholder={t('settings.platform.placeholders.accessApprovedMessage')} {...form.register('accessApprovedMessage')} />
                  {form.formState.errors.accessApprovedMessage ? <p className="text-sm text-destructive">{t(form.formState.errors.accessApprovedMessage.message ?? '')}</p> : null}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="accessRejectedMessage">{t('settings.platform.labels.accessRejectedMessage')}</Label>
                  <Textarea id="accessRejectedMessage" className="min-h-28" placeholder={t('settings.platform.placeholders.accessRejectedMessage')} {...form.register('accessRejectedMessage')} />
                  {form.formState.errors.accessRejectedMessage ? <p className="text-sm text-destructive">{t(form.formState.errors.accessRejectedMessage.message ?? '')}</p> : null}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
        <div className="space-y-4">
          {isAccessModeVariant ? null : (
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="flex size-11 items-center justify-center rounded-2xl bg-accent text-primary">
                    <CalendarClock className="size-5" />
                  </div>
                  <div>
                    <CardTitle>{t('settings.platform.inviteDefaultsTitle')}</CardTitle>
                    <CardDescription>{t('settings.platform.inviteDefaultsDescription')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="inviteModeStartedAt">{t('settings.platform.labels.inviteModeStartedAt')}</Label>
                  <Input id="inviteModeStartedAt" type="datetime-local" {...form.register('inviteModeStartedAt')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="defaultCurrency">{t('settings.platform.labels.defaultCurrency')}</Label>
                  <Input id="defaultCurrency" placeholder={t('settings.platform.placeholders.defaultCurrency')} {...form.register('defaultCurrency')} />
                  {form.formState.errors.defaultCurrency ? <p className="text-sm text-destructive">{t(form.formState.errors.defaultCurrency.message ?? '')}</p> : null}
                </div>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>{t('settings.platform.requestStateTitle')}</CardTitle>
              <CardDescription>{t('settings.platform.requestStateDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                {settingsQuery.isLoading ? t('settings.platform.state.loading') : t('settings.platform.state.ready')}
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                {updateMutation.isPending ? t('settings.platform.state.saving') : t('settings.platform.state.idle')}
              </div>
              {isAccessModeVariant ? <div className="rounded-2xl border border-border/70 bg-background/70 p-4">{t('accessModePage.requestStateHint')}</div> : null}
              {settingsQuery.error ? <p className="text-destructive">{t('settings.platform.loadError')}</p> : null}
            </CardContent>
            <CardFooter className="pt-1">
              <Button type="submit" className="w-full" disabled={settingsQuery.isLoading || updateMutation.isPending}>
                {updateMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                {isAccessModeVariant ? t('accessModePage.submit') : t('settings.platform.submit')}
              </Button>
            </CardFooter>
          </Card>
        </div>
      </form>
    </div>
  )
}
