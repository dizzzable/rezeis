import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Save, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import {
  createInitialNotificationJsonSettingsDraft,
  createNotificationJsonSettingsSchema,
  type NotificationJsonSettingsData,
  type NotificationJsonSettingsDraft,
} from './notification-json-settings-schema'

const ACCESS_MODES = ['PUBLIC', 'INVITED', 'PURCHASE_BLOCKED', 'REG_BLOCKED', 'RESTRICTED'] as const
const CURRENCIES = ['RUB', 'USD', 'EUR', 'XTR', 'USDT', 'TON'] as const

interface BrandingVerificationSettings {
  readonly telegramTemplate?: { readonly ru?: string; readonly en?: string }
  readonly passwordResetTelegramTemplate?: { readonly ru?: string; readonly en?: string }
}

interface BrandingSettings {
  readonly projectName?: string
  readonly webTitle?: string
  readonly channelUsername?: string
  readonly verification?: BrandingVerificationSettings
}

interface MultiSubscriptionSettings {
  readonly enabled?: boolean
  readonly defaultMaxSubscriptions?: number
}

interface AdminSettings {
  readonly accessMode?: string
  readonly defaultCurrency?: string
  readonly rulesRequired?: boolean
  readonly channelRequired?: boolean
  readonly rulesLink?: string
  readonly channelLink?: string
  readonly channelId?: string | number | bigint | null
  readonly userNotifications?: Record<string, unknown>
  readonly systemNotifications?: Record<string, unknown>
  readonly brandingSettings?: BrandingSettings
  readonly multiSubscriptionSettings?: MultiSubscriptionSettings
}

export default function SettingsPage() {
  const { t } = useTranslation()
  const { data: settings, isLoading } = useQuery<AdminSettings>({
    queryKey: ['admin', 'settings'],
    queryFn: async () => (await api.get<AdminSettings>('/admin/settings')).data,
  })

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('settingsPage.title')}</h1>
        <p className="text-muted-foreground">{t('settingsPage.subtitle')}</p>
      </div>

      <Tabs defaultValue="platform">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="platform">{t('settingsPage.tabs.platform')}</TabsTrigger>
          <TabsTrigger value="branding">{t('settingsPage.tabs.branding')}</TabsTrigger>
          <TabsTrigger value="multi-sub">{t('settingsPage.tabs.multiSub')}</TabsTrigger>
          <TabsTrigger value="notifications">{t('settingsPage.tabs.notifications')}</TabsTrigger>
        </TabsList>

        <TabsContent value="platform"><PlatformTab settings={settings} /></TabsContent>
        <TabsContent value="branding"><BrandingTab settings={settings} /></TabsContent>
        <TabsContent value="multi-sub"><MultiSubTab settings={settings} /></TabsContent>
        <TabsContent value="notifications"><NotificationsTab settings={settings} /></TabsContent>
      </Tabs>
    </div>
  )
}

export function PlatformTab({ settings }: { settings: AdminSettings | undefined }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [accessMode, setAccessMode] = useState(settings?.accessMode ?? 'PUBLIC')
  const [defaultCurrency, setDefaultCurrency] = useState(settings?.defaultCurrency ?? 'RUB')
  const [rulesRequired, setRulesRequired] = useState(settings?.rulesRequired ?? false)
  const [channelRequired, setChannelRequired] = useState(settings?.channelRequired ?? false)
  const [rulesLink, setRulesLink] = useState(settings?.rulesLink ?? '')
  const [channelLink, setChannelLink] = useState(settings?.channelLink ?? '')
  const [channelId, setChannelId] = useState(settings?.channelId?.toString() ?? '')

  const mutation = useMutation({
    mutationFn: (data: {
      readonly accessMode: string
      readonly defaultCurrency: string
      readonly rulesRequired: boolean
      readonly channelRequired: boolean
      readonly rulesLink: string | null
      readonly channelLink: string | null
      readonly channelId: string | null
    }) => api.patch('/admin/settings/platform', data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] }); toast.success(t('settingsPage.platform.saved')) },
    onError: () => toast.error(t('settingsPage.platform.saveFailed')),
  })

  const handleSave = () => {
    // The platform DTO validates rulesLink/channelLink with @IsUrl and
    // channelId with a numeric-string regex, each guarded by
    // `@ValidateIf(value !== null)`. An empty string is NOT null, so it
    // still hits @IsUrl and 400s. Normalise blanks to null. channelId
    // must be sent as a string (the DTO matches /^-?\d+$/) — never a
    // BigInt, which axios' JSON.stringify cannot serialise.
    const normalize = (v: string): string | null => {
      const trimmed = v.trim()
      return trimmed.length > 0 ? trimmed : null
    }
    mutation.mutate({
      accessMode,
      defaultCurrency,
      rulesRequired,
      channelRequired,
      rulesLink: normalize(rulesLink),
      channelLink: normalize(channelLink),
      channelId: normalize(channelId),
    })
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>{t('settingsPage.platform.title')}</CardTitle>
        <CardDescription>{t('settingsPage.platform.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>{t('settingsPage.platform.accessMode')}</Label>
            <Select value={accessMode} onValueChange={setAccessMode}>
              <SelectTrigger aria-label={t('settingsPage.platform.accessMode')}><SelectValue /></SelectTrigger>
              <SelectContent>
                {ACCESS_MODES.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t(`settingsPage.platform.accessModeHints.${accessMode}`)}
            </p>
          </div>
          <div className="space-y-2">
            <Label>{t('settingsPage.platform.defaultCurrency')}</Label>
            <Select value={defaultCurrency} onValueChange={setDefaultCurrency}>
              <SelectTrigger aria-label={t('settingsPage.platform.defaultCurrency')}><SelectValue /></SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <Separator />

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('settingsPage.platform.rulesRequired')}</Label>
              <p className="text-xs text-muted-foreground">{t('settingsPage.platform.rulesRequiredHint')}</p>
            </div>
            <Switch
              checked={rulesRequired}
              onCheckedChange={setRulesRequired}
              aria-label={t('settingsPage.platform.rulesRequired')}
            />
          </div>
          {rulesRequired && (
            <div className="space-y-2 pl-4 border-l-2">
              <Label htmlFor="platform-rules-link">{t('settingsPage.platform.rulesLink')}</Label>
              <Input
                id="platform-rules-link"
                value={rulesLink}
                onChange={(e) => setRulesLink(e.target.value)}
                placeholder={t('settingsPage.platform.rulesLinkPlaceholder')}
              />
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('settingsPage.platform.channelRequired')}</Label>
              <p className="text-xs text-muted-foreground">{t('settingsPage.platform.channelRequiredHint')}</p>
            </div>
            <Switch
              checked={channelRequired}
              onCheckedChange={setChannelRequired}
              aria-label={t('settingsPage.platform.channelRequired')}
            />
          </div>
          {channelRequired && (
            <div className="space-y-3 pl-4 border-l-2">
              <div className="space-y-2">
                <Label htmlFor="platform-channel-link">{t('settingsPage.platform.channelLink')}</Label>
                <Input
                  id="platform-channel-link"
                  value={channelLink}
                  onChange={(e) => setChannelLink(e.target.value)}
                  placeholder={t('settingsPage.platform.channelLinkPlaceholder')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="platform-channel-id">{t('settingsPage.platform.channelId')}</Label>
                <Input
                  id="platform-channel-id"
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value)}
                  placeholder="-1001234567890"
                />
              </div>
            </div>
          )}
        </div>

        <Separator />

        <Button onClick={handleSave} disabled={mutation.isPending}>
          {mutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
          {t('settingsPage.platform.saveButton')}
        </Button>
      </CardContent>
    </Card>
  )
}

export function NotificationsTab({ settings }: { settings: AdminSettings | undefined }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const notificationJsonSchema = useMemo(
    () => createNotificationJsonSettingsSchema({ invalidJson: t('settingsPage.notifications.invalidJson') }),
    [t],
  )
  const form = useForm<NotificationJsonSettingsDraft, unknown, NotificationJsonSettingsData>({
    resolver: zodResolver(notificationJsonSchema) as Resolver<
      NotificationJsonSettingsDraft,
      unknown,
      NotificationJsonSettingsData
    >,
    defaultValues: createInitialNotificationJsonSettingsDraft(settings),
    mode: 'onSubmit',
    reValidateMode: 'onBlur',
  })

  const mutation = useMutation({
    mutationFn: (data: NotificationJsonSettingsData) =>
      api.patch('/admin/settings/notifications', data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] }); toast.success(t('settingsPage.notifications.saved')) },
    onError: () => toast.error(t('settingsPage.notifications.saveFailed')),
  })

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>{t('settingsPage.notifications.title')}</CardTitle>
        <CardDescription>{t('settingsPage.notifications.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={form.handleSubmit((values) => mutation.mutate(values))}>
          <div className="space-y-2">
            <Label htmlFor="userNotificationsJson">{t('settingsPage.notifications.userNotifications')}</Label>
            <textarea
              id="userNotificationsJson"
              className="w-full h-32 font-mono text-xs border rounded-md p-3 bg-muted/30"
              aria-invalid={!!form.formState.errors.userNotificationsJson}
              {...form.register('userNotificationsJson')}
            />
            <FieldError message={form.formState.errors.userNotificationsJson?.message} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="systemNotificationsJson">{t('settingsPage.notifications.systemNotifications')}</Label>
            <textarea
              id="systemNotificationsJson"
              className="w-full h-32 font-mono text-xs border rounded-md p-3 bg-muted/30"
              aria-invalid={!!form.formState.errors.systemNotificationsJson}
              {...form.register('systemNotificationsJson')}
            />
            <FieldError message={form.formState.errors.systemNotificationsJson?.message} />
          </div>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            {t('settingsPage.notifications.saveButton')}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function FieldError({ message }: { readonly message?: string }) {
  return message ? <p className="text-sm text-destructive">{message}</p> : null
}


// ── Branding Tab ──────────────────────────────────────────────────────────────

export function BrandingTab({ settings }: { settings: AdminSettings | undefined }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const branding = settings?.brandingSettings ?? {}

  const [projectName, setProjectName] = useState(branding.projectName ?? '')
  const [webTitle, setWebTitle] = useState(branding.webTitle ?? '')
  const [channelUsername, setChannelUsername] = useState(branding.channelUsername ?? '')

  // Verification templates
  const verification = branding.verification ?? {}
  const [verifyTelegramRu, setVerifyTelegramRu] = useState(verification.telegramTemplate?.ru ?? '')
  const [verifyTelegramEn, setVerifyTelegramEn] = useState(verification.telegramTemplate?.en ?? '')
  const [passwordResetRu, setPasswordResetRu] = useState(verification.passwordResetTelegramTemplate?.ru ?? '')
  const [passwordResetEn, setPasswordResetEn] = useState(verification.passwordResetTelegramTemplate?.en ?? '')

  const mutation = useMutation({
    mutationFn: (data: BrandingSettings) => api.patch('/admin/settings/platform', { brandingSettings: data }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] }); toast.success(t('settingsPage.branding.saved')) },
    onError: () => toast.error(t('settingsPage.branding.saveFailed')),
  })

  const handleSave = () => {
    mutation.mutate({
      projectName,
      webTitle,
      channelUsername,
      verification: {
        telegramTemplate: { ru: verifyTelegramRu, en: verifyTelegramEn },
        passwordResetTelegramTemplate: { ru: passwordResetRu, en: passwordResetEn },
      },
    })
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>{t('settingsPage.branding.title')}</CardTitle>
        <CardDescription>{t('settingsPage.branding.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="settings-branding-project-name">{t('settingsPage.branding.projectName')}</Label>
            <Input
              id="settings-branding-project-name"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder={t('settingsPage.branding.projectNamePlaceholder')}
            />
            <p className="text-xs text-muted-foreground">{t('settingsPage.branding.projectNameHint')}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-branding-web-title">{t('settingsPage.branding.webTitle')}</Label>
            <Input
              id="settings-branding-web-title"
              value={webTitle}
              onChange={(e) => setWebTitle(e.target.value)}
              placeholder={t('settingsPage.branding.webTitlePlaceholder')}
            />
            <p className="text-xs text-muted-foreground">{t('settingsPage.branding.webTitleHint')}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-branding-channel-username">{t('settingsPage.branding.channelUsername')}</Label>
            <Input
              id="settings-branding-channel-username"
              value={channelUsername}
              onChange={(e) => setChannelUsername(e.target.value)}
              placeholder={t('settingsPage.branding.channelUsernamePlaceholder')}
            />
          </div>
        </div>

        <Separator />

        <div className="space-y-4">
          <h3 className="text-sm font-semibold">{t('settingsPage.branding.verificationTemplates')}</h3>
          <p className="text-xs text-muted-foreground">{t('settingsPage.branding.verificationTemplatesHint')}</p>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="settings-branding-verification-ru">{t('settingsPage.branding.verificationRu')}</Label>
              <textarea
                id="settings-branding-verification-ru"
                className="w-full h-20 font-mono text-xs border rounded-md p-2 bg-muted/30 resize-y"
                value={verifyTelegramRu}
                onChange={(e) => setVerifyTelegramRu(e.target.value)}
                placeholder={t('settingsPage.branding.verifyTelegramRuPlaceholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-branding-verification-en">{t('settingsPage.branding.verificationEn')}</Label>
              <textarea
                id="settings-branding-verification-en"
                className="w-full h-20 font-mono text-xs border rounded-md p-2 bg-muted/30 resize-y"
                value={verifyTelegramEn}
                onChange={(e) => setVerifyTelegramEn(e.target.value)}
                placeholder={t('settingsPage.branding.verifyTelegramEnPlaceholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-branding-password-reset-ru">{t('settingsPage.branding.passwordResetRu')}</Label>
              <textarea
                id="settings-branding-password-reset-ru"
                className="w-full h-20 font-mono text-xs border rounded-md p-2 bg-muted/30 resize-y"
                value={passwordResetRu}
                onChange={(e) => setPasswordResetRu(e.target.value)}
                placeholder={t('settingsPage.branding.passwordResetRuPlaceholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-branding-password-reset-en">{t('settingsPage.branding.passwordResetEn')}</Label>
              <textarea
                id="settings-branding-password-reset-en"
                className="w-full h-20 font-mono text-xs border rounded-md p-2 bg-muted/30 resize-y"
                value={passwordResetEn}
                onChange={(e) => setPasswordResetEn(e.target.value)}
                placeholder={t('settingsPage.branding.passwordResetEnPlaceholder')}
              />
            </div>
          </div>
        </div>

        <Button onClick={handleSave} disabled={mutation.isPending}>
          {mutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
          {t('settingsPage.branding.saveButton')}
        </Button>
      </CardContent>
    </Card>
  )
}

// ── Multi-Subscription Tab ────────────────────────────────────────────────────

export function MultiSubTab({ settings }: { settings: AdminSettings | undefined }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const multiSub = settings?.multiSubscriptionSettings ?? {}

  const [enabled, setEnabled] = useState(multiSub.enabled ?? false)
  const [defaultMax, setDefaultMax] = useState(String(multiSub.defaultMaxSubscriptions ?? '1'))

  const mutation = useMutation({
    mutationFn: (data: MultiSubscriptionSettings) => api.patch('/admin/settings/platform', { multiSubscriptionSettings: data }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] }); toast.success(t('settingsPage.multiSub.saved')) },
    onError: () => toast.error(t('settingsPage.multiSub.saveFailed')),
  })

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>{t('settingsPage.multiSub.title')}</CardTitle>
        <CardDescription>{t('settingsPage.multiSub.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Label>{t('settingsPage.multiSub.enable')}</Label>
            <p className="text-xs text-muted-foreground">{t('settingsPage.multiSub.enableHint')}</p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label={t('settingsPage.multiSub.enable')}
          />
        </div>

        {enabled && (
          <div className="space-y-2 pl-4 border-l-2">
            <Label htmlFor="multi-sub-default-max">{t('settingsPage.multiSub.defaultMax')}</Label>
            <Input
              id="multi-sub-default-max"
              type="number" min="1" max="100"
              value={defaultMax}
              onChange={(e) => setDefaultMax(e.target.value)}
              className="w-32"
            />
            <p className="text-xs text-muted-foreground">{t('settingsPage.multiSub.defaultMaxHint')}</p>
          </div>
        )}

        <Button onClick={() => mutation.mutate({ enabled, defaultMaxSubscriptions: parseInt(defaultMax) || 1 })} disabled={mutation.isPending}>
          {mutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
          {t('settingsPage.multiSub.saveButton')}
        </Button>
      </CardContent>
    </Card>
  )
}
