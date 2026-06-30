import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Save, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { enablePush } from '@/lib/push'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'

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
  readonly channelRecheck?: boolean
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
  readonly platformBranding?: BrandingSettings
  readonly multiSubscriptionSettings?: MultiSubscriptionSettings
  readonly botTokenConfigured?: boolean
  readonly webPush?: {
    readonly configured: boolean
    readonly publicKey: string
    readonly source: 'settings' | 'env' | null
  }
}

export default function SettingsPage() {
  const { t } = useTranslation()
  const { data: settings, isLoading } = useQuery<AdminSettings>({
    queryKey: ['admin', 'settings'],
    queryFn: async () => (await api.get<AdminSettings>('/admin/settings')).data,
  })

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('settingsPage.title')}</h1>
        <p className="text-muted-foreground">{t('settingsPage.subtitle')}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <div className="space-y-6">
          <PlatformTab settings={settings} />
          <MultiSubTab settings={settings} />
        </div>
        <div className="space-y-6">
          <BotTokenSection settings={settings} />
          <WebPushSection settings={settings} />
        </div>
      </div>
      <BrandingTab settings={settings} />
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
    <Card>
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
                {ACCESS_MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {t(`settingsPage.platform.accessModeLabels.${m}`)}
                  </SelectItem>
                ))}
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

export function BotTokenSection({ settings }: { settings: AdminSettings | undefined }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const configured = settings?.botTokenConfigured ?? false
  const [botToken, setBotToken] = useState('')

  const mutation = useMutation({
    mutationFn: (token: string) => api.patch('/admin/settings/platform', { botToken: token }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] })
      setBotToken('')
      toast.success(t('settingsPage.botToken.saved'))
    },
    onError: () => toast.error(t('settingsPage.botToken.saveFailed')),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settingsPage.botToken.title')}</CardTitle>
        <CardDescription>{t('settingsPage.botToken.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border p-3 text-sm">
          {configured
            ? t('settingsPage.botToken.statusConfigured')
            : t('settingsPage.botToken.statusMissing')}
        </div>
        <div className="space-y-2">
          <Label htmlFor="settings-bot-token">{t('settingsPage.botToken.field')}</Label>
          <Input
            id="settings-bot-token"
            type="password"
            autoComplete="off"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder={t('settingsPage.botToken.placeholder')}
          />
          <p className="text-xs text-muted-foreground">{t('settingsPage.botToken.hint')}</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => mutation.mutate(botToken.trim())} disabled={mutation.isPending || botToken.trim().length === 0}>
            {mutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            {t('settingsPage.botToken.saveButton')}
          </Button>
          {configured && (
            <Button
              variant="outline"
              onClick={() => mutation.mutate('')}
              disabled={mutation.isPending}
            >
              {t('settingsPage.botToken.clearButton')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export function WebPushSection({ settings }: { settings: AdminSettings | undefined }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const configured = settings?.webPush?.configured ?? false
  const publicKey = settings?.webPush?.publicKey ?? ''
  const source = settings?.webPush?.source ?? null
  const [contactEmail, setContactEmail] = useState('')

  const generate = useMutation({
    mutationFn: (email: string) =>
      api.post('/admin/settings/web-push/generate', { contactEmail: email }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] })
      setContactEmail('')
      toast.success(t('settingsPage.webPush.generated'))
    },
    onError: (err: { response?: { data?: { message?: string } } }) =>
      toast.error(err.response?.data?.message ?? t('settingsPage.webPush.generateFailed')),
  })

  const clear = useMutation({
    mutationFn: () => api.post('/admin/settings/web-push/clear', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] })
      toast.success(t('settingsPage.webPush.cleared'))
    },
    onError: () => toast.error(t('settingsPage.webPush.generateFailed')),
  })

  const test = useMutation({
    mutationFn: async () => {
      // Granting browser permission isn't enough — the admin browser must also
      // have a push SUBSCRIPTION. Ensure one exists (idempotent) before the
      // server tries to deliver, so the test works in one click right after the
      // permission prompt.
      const result = await enablePush()
      if (result === 'permission-denied') throw new Error(t('settingsPage.webPush.permissionDenied'))
      if (result === 'push-disabled') throw new Error(t('settingsPage.webPush.disabledServer'))
      if (result === 'unsupported') throw new Error(t('settingsPage.webPush.unsupported'))
      return api.post('/admin/push/test', {})
    },
    onSuccess: () => toast.success(t('settingsPage.webPush.testSent')),
    onError: (err: Error & { response?: { data?: { message?: string } } }) =>
      toast.error(err.response?.data?.message ?? err.message ?? t('settingsPage.webPush.testFailed')),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settingsPage.webPush.title')}</CardTitle>
        <CardDescription>{t('settingsPage.webPush.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border p-3 text-sm">
          {configured
            ? t('settingsPage.webPush.statusConfigured', {
                source: t(`settingsPage.webPush.source.${source ?? 'env'}`),
              })
            : t('settingsPage.webPush.statusMissing')}
        </div>
        {configured && publicKey.length > 0 && (
          <div className="space-y-1">
            <Label>{t('settingsPage.webPush.publicKeyLabel')}</Label>
            <Input readOnly value={publicKey} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          </div>
        )}
        <Separator />
        <div className="space-y-2">
          <Label htmlFor="settings-vapid-email">{t('settingsPage.webPush.emailLabel')}</Label>
          <Input
            id="settings-vapid-email"
            type="email"
            autoComplete="off"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder={t('settingsPage.webPush.emailPlaceholder')}
          />
          <p className="text-xs text-muted-foreground">{t('settingsPage.webPush.hint')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => generate.mutate(contactEmail.trim())}
            disabled={generate.isPending || !contactEmail.includes('@')}
          >
            {generate.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            {configured ? t('settingsPage.webPush.regenerateButton') : t('settingsPage.webPush.generateButton')}
          </Button>
          <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending || !configured}>
            {test.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            {t('settingsPage.webPush.testButton')}
          </Button>
          {configured && source === 'settings' && (
            <Button variant="outline" onClick={() => clear.mutate()} disabled={clear.isPending}>
              {t('settingsPage.webPush.clearButton')}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t('settingsPage.webPush.testHint')}</p>
      </CardContent>
    </Card>
  )
}


// ── Branding Tab ──────────────────────────────────────────────────────────────

export function BrandingTab({ settings }: { settings: AdminSettings | undefined }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const branding = settings?.platformBranding ?? {}

  const [projectName, setProjectName] = useState(branding.projectName ?? '')
  const [webTitle, setWebTitle] = useState(branding.webTitle ?? '')
  const [channelUsername, setChannelUsername] = useState(branding.channelUsername ?? '')
  const [channelRecheck, setChannelRecheck] = useState(branding.channelRecheck ?? true)

  // Verification templates
  const verification = branding.verification ?? {}
  const [verifyTelegramRu, setVerifyTelegramRu] = useState(verification.telegramTemplate?.ru ?? '')
  const [verifyTelegramEn, setVerifyTelegramEn] = useState(verification.telegramTemplate?.en ?? '')
  const [passwordResetRu, setPasswordResetRu] = useState(verification.passwordResetTelegramTemplate?.ru ?? '')
  const [passwordResetEn, setPasswordResetEn] = useState(verification.passwordResetTelegramTemplate?.en ?? '')

  const mutation = useMutation({
    mutationFn: (data: BrandingSettings) => api.patch('/admin/settings/platform', { platformBranding: data }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] }); toast.success(t('settingsPage.branding.saved')) },
    onError: () => toast.error(t('settingsPage.branding.saveFailed')),
  })

  const handleSave = () => {
    mutation.mutate({
      projectName,
      webTitle,
      channelUsername,
      channelRecheck,
      verification: {
        telegramTemplate: { ru: verifyTelegramRu, en: verifyTelegramEn },
        passwordResetTelegramTemplate: { ru: passwordResetRu, en: passwordResetEn },
      },
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settingsPage.branding.title')}</CardTitle>
        <CardDescription>{t('settingsPage.branding.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
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

        <div className="flex items-center justify-between rounded-lg border p-3">
          <div className="pr-3">
            <Label>{t('settingsPage.branding.channelRecheck')}</Label>
            <p className="text-xs text-muted-foreground">{t('settingsPage.branding.channelRecheckHint')}</p>
          </div>
          <Switch
            checked={channelRecheck}
            onCheckedChange={setChannelRecheck}
            aria-label={t('settingsPage.branding.channelRecheck')}
          />
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
    <Card>
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
