import type { JSX } from 'react'
import { useEffect } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CalendarClock, LoaderCircle, Save, Settings2 } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createPlatformSettingsSchema } from '@/features/settings/platform-settings-schema'
import { settingsApi } from '@/features/settings/settings-api'
import { queryClient } from '@/lib/query-client'
import { translateErrorMessage } from '@/lib/translate-error'

type PlatformSettingsFormValues = z.infer<ReturnType<typeof createPlatformSettingsSchema>>

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

export function PlatformSettingsForm(): JSX.Element {
  const { t } = useTranslation()
  const platformSettingsSchema = createPlatformSettingsSchema()
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
      accessMode: 'open',
      inviteModeStartedAt: '',
      defaultCurrency: 'USD',
    },
  })
  const updateMutation = useMutation({
    mutationFn: settingsApi.updatePlatformSettings,
    onSuccess: (settings): void => {
      queryClient.setQueryData(['settings', 'platform'], settings)
      toast.success(t('settings.platform.saveSuccess'))
    },
    onError: (error: Error): void => {
      toast.error(translateErrorMessage(t, error.message))
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
      accessMode: readString(settingsQuery.data.accessMode) || 'open',
      inviteModeStartedAt: formatDateTimeInput(settingsQuery.data.inviteModeStartedAt),
      defaultCurrency: readString(settingsQuery.data.defaultCurrency) || 'USD',
    })
  }, [settingsQuery.data, form])
  function handleSubmit(values: PlatformSettingsFormValues): void {
    updateMutation.mutate({
      rulesRequired: values.rulesRequired,
      rulesLink: formatNullableString(values.rulesLink),
      channelRequired: values.channelRequired,
      channelId: formatNullableString(values.channelId),
      channelLink: formatNullableString(values.channelLink),
      accessMode: values.accessMode.trim(),
      inviteModeStartedAt: formatNullableDateTime(values.inviteModeStartedAt),
      defaultCurrency: values.defaultCurrency.trim().toUpperCase(),
    })
  }
  return (
    <div className="space-y-4">
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
      <form className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]" onSubmit={form.handleSubmit(handleSubmit)}>
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex size-11 items-center justify-center rounded-2xl bg-accent text-primary">
                <Settings2 className="size-5" />
              </div>
              <div>
                <CardTitle>{t('settings.platform.accessPolicyTitle')}</CardTitle>
                <CardDescription>{t('settings.platform.accessPolicyDescription')}</CardDescription>
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
                <Select value={form.watch('accessMode')} onValueChange={(value: string): void => form.setValue('accessMode', value, { shouldDirty: true })}>
                  <SelectTrigger id="accessMode" className="w-full">
                    <SelectValue placeholder={t('settings.platform.labels.accessMode')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">{t('settings.platform.accessModes.open')}</SelectItem>
                    <SelectItem value="approval">{t('settings.platform.accessModes.approval')}</SelectItem>
                    <SelectItem value="invite">{t('settings.platform.accessModes.invite')}</SelectItem>
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
          </CardContent>
        </Card>
        <div className="space-y-4">
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
            {settingsQuery.error ? <p className="text-destructive">{translateErrorMessage(t, settingsQuery.error.message)}</p> : null}
          </CardContent>
          <CardFooter className="pt-1">
            <Button type="submit" className="w-full" disabled={settingsQuery.isLoading || updateMutation.isPending}>
              {updateMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
              {t('settings.platform.submit')}
            </Button>
          </CardFooter>
        </Card>
        </div>
      </form>
    </div>
  )
}
