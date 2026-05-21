/* eslint-disable @typescript-eslint/no-explicit-any -- TODO: type API responses */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
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

const ACCESS_MODES = ['PUBLIC', 'INVITED', 'PURCHASE_BLOCKED', 'REG_BLOCKED', 'RESTRICTED'] as const
const CURRENCIES = ['RUB', 'USD', 'EUR', 'XTR', 'USDT', 'TON'] as const

export default function SettingsPage() {
  const { t } = useTranslation()
  const { data: settings, isLoading } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: async () => (await api.get('/admin/settings')).data,
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

function PlatformTab({ settings }: { settings: any }) {
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
    mutationFn: (data: any) => api.patch('/admin/settings/platform', data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] }); toast.success(t('settingsPage.platform.saved')) },
    onError: () => toast.error(t('settingsPage.platform.saveFailed')),
  })

  const handleSave = () => {
    mutation.mutate({
      accessMode,
      defaultCurrency,
      rulesRequired,
      channelRequired,
      rulesLink,
      channelLink,
      channelId: channelId ? BigInt(channelId) : null,
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
              <SelectTrigger><SelectValue /></SelectTrigger>
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
              <SelectTrigger><SelectValue /></SelectTrigger>
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
            <Switch checked={rulesRequired} onCheckedChange={setRulesRequired} />
          </div>
          {rulesRequired && (
            <div className="space-y-2 pl-4 border-l-2">
              <Label>{t('settingsPage.platform.rulesLink')}</Label>
              <Input value={rulesLink} onChange={(e) => setRulesLink(e.target.value)} placeholder="https://example.com/rules" />
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('settingsPage.platform.channelRequired')}</Label>
              <p className="text-xs text-muted-foreground">{t('settingsPage.platform.channelRequiredHint')}</p>
            </div>
            <Switch checked={channelRequired} onCheckedChange={setChannelRequired} />
          </div>
          {channelRequired && (
            <div className="space-y-3 pl-4 border-l-2">
              <div className="space-y-2">
                <Label>{t('settingsPage.platform.channelLink')}</Label>
                <Input value={channelLink} onChange={(e) => setChannelLink(e.target.value)} placeholder="https://t.me/yourchannel" />
              </div>
              <div className="space-y-2">
                <Label>{t('settingsPage.platform.channelId')}</Label>
                <Input value={channelId} onChange={(e) => setChannelId(e.target.value)} placeholder="-1001234567890" />
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

function NotificationsTab({ settings }: { settings: any }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [userNotifications, setUserNotifications] = useState(JSON.stringify(settings?.userNotifications ?? {}, null, 2))
  const [systemNotifications, setSystemNotifications] = useState(JSON.stringify(settings?.systemNotifications ?? {}, null, 2))

  const mutation = useMutation({
    mutationFn: (data: any) => api.patch('/admin/settings/notifications', data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] }); toast.success(t('settingsPage.notifications.saved')) },
    onError: () => toast.error(t('settingsPage.notifications.saveFailed')),
  })

  const handleSave = () => {
    try {
      mutation.mutate({
        userNotifications: JSON.parse(userNotifications),
        systemNotifications: JSON.parse(systemNotifications),
      })
    } catch { toast.error(t('settingsPage.notifications.invalidJson')) }
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>{t('settingsPage.notifications.title')}</CardTitle>
        <CardDescription>{t('settingsPage.notifications.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>{t('settingsPage.notifications.userNotifications')}</Label>
          <textarea className="w-full h-32 font-mono text-xs border rounded-md p-3 bg-muted/30" value={userNotifications} onChange={(e) => setUserNotifications(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>{t('settingsPage.notifications.systemNotifications')}</Label>
          <textarea className="w-full h-32 font-mono text-xs border rounded-md p-3 bg-muted/30" value={systemNotifications} onChange={(e) => setSystemNotifications(e.target.value)} />
        </div>
        <Button onClick={handleSave} disabled={mutation.isPending}>
          {mutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
          {t('settingsPage.notifications.saveButton')}
        </Button>
      </CardContent>
    </Card>
  )
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function JsonSettingsTab({ title, description, endpoint, data }: { title: string; description: string; endpoint: string; data: any }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [json, setJson] = useState(JSON.stringify(data ?? {}, null, 2))

  const mutation = useMutation({
    mutationFn: (parsed: any) => api.patch(`/admin/settings/${endpoint}`, parsed),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] }); toast.success(t('settingsPage.json.saved', { title })) },
    onError: () => toast.error(t('settingsPage.json.saveFailed')),
  })

  const handleSave = () => {
    try {
      const parsed = JSON.parse(json)
      mutation.mutate(parsed)
    } catch { toast.error(t('settingsPage.json.invalidJson')) }
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <textarea className="w-full h-64 font-mono text-xs border rounded-md p-3 bg-muted/30" value={json} onChange={(e) => setJson(e.target.value)} />
        <Button onClick={handleSave} disabled={mutation.isPending}>
          {mutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
          {t('common.save')}
        </Button>
      </CardContent>
    </Card>
  )
}

// ── Branding Tab ──────────────────────────────────────────────────────────────

function BrandingTab({ settings }: { settings: any }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const branding = (settings?.brandingSettings ?? {}) as Record<string, any>

  const [projectName, setProjectName] = useState(branding.projectName ?? '')
  const [webTitle, setWebTitle] = useState(branding.webTitle ?? '')
  const [supportLink, setSupportLink] = useState(branding.supportLink ?? '')
  const [channelUsername, setChannelUsername] = useState(branding.channelUsername ?? '')
  const [botMenuButtonText, setBotMenuButtonText] = useState(branding.botMenuButtonText ?? 'Shop')

  // Verification templates
  const verification = (branding.verification ?? {}) as Record<string, any>
  const [verifyTelegramRu, setVerifyTelegramRu] = useState(verification.telegramTemplate?.ru ?? '')
  const [verifyTelegramEn, setVerifyTelegramEn] = useState(verification.telegramTemplate?.en ?? '')
  const [passwordResetRu, setPasswordResetRu] = useState(verification.passwordResetTelegramTemplate?.ru ?? '')
  const [passwordResetEn, setPasswordResetEn] = useState(verification.passwordResetTelegramTemplate?.en ?? '')

  const mutation = useMutation({
    mutationFn: (data: any) => api.patch('/admin/settings/platform', { brandingSettings: data }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] }); toast.success(t('settingsPage.branding.saved')) },
    onError: () => toast.error(t('settingsPage.branding.saveFailed')),
  })

  const handleSave = () => {
    mutation.mutate({
      projectName,
      webTitle,
      supportLink,
      channelUsername,
      botMenuButtonText,
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
            <Label>{t('settingsPage.branding.projectName')}</Label>
            <Input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="Rezeis VPN" />
            <p className="text-xs text-muted-foreground">{t('settingsPage.branding.projectNameHint')}</p>
          </div>
          <div className="space-y-2">
            <Label>{t('settingsPage.branding.webTitle')}</Label>
            <Input value={webTitle} onChange={(e) => setWebTitle(e.target.value)} placeholder="Rezeis — Fast VPN" />
            <p className="text-xs text-muted-foreground">{t('settingsPage.branding.webTitleHint')}</p>
          </div>
          <div className="space-y-2">
            <Label>{t('settingsPage.branding.supportLink')}</Label>
            <Input value={supportLink} onChange={(e) => setSupportLink(e.target.value)} placeholder="https://t.me/support" />
          </div>
          <div className="space-y-2">
            <Label>{t('settingsPage.branding.channelUsername')}</Label>
            <Input value={channelUsername} onChange={(e) => setChannelUsername(e.target.value)} placeholder="@yourchannel" />
          </div>
          <div className="space-y-2">
            <Label>{t('settingsPage.branding.botMenuButtonText')}</Label>
            <Input value={botMenuButtonText} onChange={(e) => setBotMenuButtonText(e.target.value)} placeholder="Shop" />
            <p className="text-xs text-muted-foreground">{t('settingsPage.branding.botMenuButtonTextHint')}</p>
          </div>
        </div>

        <Separator />

        <div className="space-y-4">
          <h3 className="text-sm font-semibold">{t('settingsPage.branding.verificationTemplates')}</h3>
          <p className="text-xs text-muted-foreground">{t('settingsPage.branding.verificationTemplatesHint')}</p>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{t('settingsPage.branding.verificationRu')}</Label>
              <textarea
                className="w-full h-20 font-mono text-xs border rounded-md p-2 bg-muted/30 resize-y"
                value={verifyTelegramRu}
                onChange={(e) => setVerifyTelegramRu(e.target.value)}
                placeholder="{project_name} код верификации&#10;Код: {code}"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('settingsPage.branding.verificationEn')}</Label>
              <textarea
                className="w-full h-20 font-mono text-xs border rounded-md p-2 bg-muted/30 resize-y"
                value={verifyTelegramEn}
                onChange={(e) => setVerifyTelegramEn(e.target.value)}
                placeholder="{project_name} verification code&#10;Code: {code}"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('settingsPage.branding.passwordResetRu')}</Label>
              <textarea
                className="w-full h-20 font-mono text-xs border rounded-md p-2 bg-muted/30 resize-y"
                value={passwordResetRu}
                onChange={(e) => setPasswordResetRu(e.target.value)}
                placeholder="Код сброса пароля {project_name}&#10;Код: {code}"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('settingsPage.branding.passwordResetEn')}</Label>
              <textarea
                className="w-full h-20 font-mono text-xs border rounded-md p-2 bg-muted/30 resize-y"
                value={passwordResetEn}
                onChange={(e) => setPasswordResetEn(e.target.value)}
                placeholder="Your {project_name} password reset code:&#10;{code}"
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

function MultiSubTab({ settings }: { settings: any }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const multiSub = (settings?.multiSubscriptionSettings ?? {}) as Record<string, any>

  const [enabled, setEnabled] = useState(multiSub.enabled ?? false)
  const [defaultMax, setDefaultMax] = useState(String(multiSub.defaultMaxSubscriptions ?? '1'))

  const mutation = useMutation({
    mutationFn: (data: any) => api.patch('/admin/settings/platform', { multiSubscriptionSettings: data }),
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
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        {enabled && (
          <div className="space-y-2 pl-4 border-l-2">
            <Label>{t('settingsPage.multiSub.defaultMax')}</Label>
            <Input
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
