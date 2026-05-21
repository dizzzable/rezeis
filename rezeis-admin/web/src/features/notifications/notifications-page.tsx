import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Bell,
  Edit2,
  Hash,
  Loader2,
  MessageSquare,
  Power,
  Save,
  Send,
  Settings2,
  Smartphone,
  Sparkles,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { FadeIn } from '@/lib/motion'

// ── Types ────────────────────────────────────────────────────────────────────

interface NotificationTemplate {
  id: string
  type: string
  title: string
  body: string
  isActive: boolean
}

// ── Label keys ───────────────────────────────────────────────────────────────

const USER_NOTIFICATION_KEYS = [
  'expires_in_3_days',
  'expires_in_2_days',
  'expires_in_1_days',
  'expired',
  'limited',
  'expired_1_day_ago',
  'referral_attached',
  'referral_reward',
  'referral_qualified',
  'partner_referral_registered',
  'partner_earning',
  'partner_withdrawal_request_created',
  'partner_withdrawal_under_review',
  'partner_withdrawal_completed',
  'partner_withdrawal_rejected',
] as const

const SYSTEM_NOTIFICATION_KEYS = [
  'bot_lifetime',
  'bot_update',
  'user_registered',
  'web_user_registered',
  'web_account_linked',
  'access_policy',
  'subscription',
  'promocode_activated',
  'trial_getted',
  'node_status',
  'user_first_connected',
  'user_hwid',
] as const

const EVENT_CATEGORIES = ['USER', 'AUTH', 'SUBSCRIPTION', 'PAYMENT', 'REFERRAL', 'PARTNER', 'PROMOCODE', 'SYSTEM'] as const

// ── Main Page ────────────────────────────────────────────────────────────────

export default function NotificationsPage() {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <FadeIn>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Bell className="h-6 w-6" /> {t('notificationsPage.title')}
          </h1>
          <p className="text-muted-foreground">
            {t('notificationsPage.subtitle')}
          </p>
        </div>
      </FadeIn>

      <Tabs defaultValue="user">
        <TabsList className="flex-wrap">
          <TabsTrigger value="user" className="gap-1.5">
            <Users className="h-3.5 w-3.5" />
            {t('notificationsPage.tabs.user')}
          </TabsTrigger>
          <TabsTrigger value="system" className="gap-1.5">
            <MessageSquare className="h-3.5 w-3.5" />
            {t('notificationsPage.tabs.system')}
          </TabsTrigger>
          <TabsTrigger value="settings" className="gap-1.5">
            <Settings2 className="h-3.5 w-3.5" />
            {t('notificationsPage.tabs.settings')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="user" className="pt-4">
          <UserNotificationsTab />
        </TabsContent>

        <TabsContent value="system" className="pt-4">
          <SystemNotificationsTab />
        </TabsContent>

        <TabsContent value="settings" className="pt-4">
          <DeliverySettingsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ── User Notifications Tab ───────────────────────────────────────────────────

function UserNotificationsTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [editTemplate, setEditTemplate] = useState<NotificationTemplate | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editBody, setEditBody] = useState('')

  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: async () => (await api.get('/admin/settings')).data,
  })

  const { data: templates } = useQuery({
    queryKey: ['notification-templates'],
    queryFn: async () => (await api.get<NotificationTemplate[]>('/admin/notifications/templates')).data,
  })

  const notifSettings = (settings?.userNotifications ?? {}) as Record<string, boolean>

  const toggleMutation = useMutation({
    mutationFn: (data: { userNotifications: Record<string, boolean> }) =>
      api.patch('/admin/settings/notifications', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] })
      toast.success(t('notificationsPage.toasts.settingUpdated'))
    },
    onError: () => toast.error(t('notificationsPage.toasts.settingFailed')),
  })

  const updateTemplateMutation = useMutation({
    mutationFn: (data: { id: string; title: string; body: string }) =>
      api.patch(`/admin/notifications/templates/${data.id}`, { title: data.title, body: data.body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-templates'] })
      setEditTemplate(null)
      toast.success(t('notificationsPage.toasts.templateUpdated'))
    },
    onError: () => toast.error(t('notificationsPage.toasts.templateFailed')),
  })

  const seedMutation = useMutation({
    mutationFn: () => api.post('/admin/notifications/templates/seed'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-templates'] })
      toast.success(t('notificationsPage.toasts.seedSuccess'))
    },
    onError: () => toast.error(t('notificationsPage.toasts.seedFailed')),
  })

  function handleToggle(key: string, current: boolean) {
    toggleMutation.mutate({
      userNotifications: { ...notifSettings, [key]: !current },
    })
  }

  if (settingsLoading) return <Skeleton className="h-64 w-full" />

  return (
    <div className="space-y-6">
      {/* Toggles */}
      <Card>
        <CardHeader>
          <CardTitle>{t('notificationsPage.userNotifications.title')}</CardTitle>
          <CardDescription>
            {t('notificationsPage.userNotifications.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {USER_NOTIFICATION_KEYS.map((key) => {
            const enabled = notifSettings[key] ?? true
            return (
              <div key={key} className="flex items-center justify-between py-1">
                <div>
                  <Label className="text-sm">{t(String(`notificationsPage.userLabels.${key}`))}</Label>
                  <p className="text-[11px] text-muted-foreground font-mono">{key}</p>
                </div>
                <Switch checked={enabled} onCheckedChange={() => handleToggle(key, enabled)} />
              </div>
            )
          })}
        </CardContent>
      </Card>

      {/* Templates */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t('notificationsPage.templates.title')}</CardTitle>
              <CardDescription>
                {t('notificationsPage.templates.description')}
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => seedMutation.mutate()} disabled={seedMutation.isPending}>
              <Sparkles className="h-4 w-4 mr-1" />
              {t('notificationsPage.templates.seedButton')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {!templates || templates.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
              <Bell className="h-10 w-10 opacity-30" />
              <p>{t('notificationsPage.templates.empty')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {templates.map((tpl) => (
                <div key={tpl.id} className="flex items-center justify-between rounded-md border px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="font-mono text-[10px]">{tpl.type}</Badge>
                      <span className="text-sm font-medium truncate">{tpl.title}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-lg">
                      {tpl.body.replace(/<[^>]+>/g, '').slice(0, 80)}…
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => { setEditTemplate(tpl); setEditTitle(tpl.title); setEditBody(tpl.body) }}>
                    <Edit2 className="h-3.5 w-3.5 mr-1" /> {t('notificationsPage.templates.editButton')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit template dialog */}
      <Dialog open={!!editTemplate} onOpenChange={(v) => !v && setEditTemplate(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('notificationsPage.templates.editDialogTitle', { type: editTemplate?.type })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t('notificationsPage.templates.titleLabel')}</Label>
              <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('notificationsPage.templates.bodyLabel')}</Label>
              <Textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} className="font-mono text-xs min-h-32" />
              <p className="text-[10px] text-muted-foreground">
                {t('notificationsPage.templates.bodyHint')}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTemplate(null)}>{t('notificationsPage.templates.cancel')}</Button>
            <Button
              onClick={() => editTemplate && updateTemplateMutation.mutate({ id: editTemplate.id, title: editTitle, body: editBody })}
              disabled={updateTemplateMutation.isPending}
            >
              {updateTemplateMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              {t('notificationsPage.templates.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── System Notifications Tab ─────────────────────────────────────────────────

function SystemNotificationsTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data: settings, isLoading } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: async () => (await api.get('/admin/settings')).data,
  })

  const notifSettings = (settings?.systemNotifications ?? {}) as Record<string, boolean>

  const toggleMutation = useMutation({
    mutationFn: (data: { systemNotifications: Record<string, boolean> }) =>
      api.patch('/admin/settings/notifications', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] })
      toast.success(t('notificationsPage.toasts.settingUpdated'))
    },
    onError: () => toast.error(t('notificationsPage.toasts.settingFailed')),
  })

  function handleToggle(key: string, current: boolean) {
    toggleMutation.mutate({
      systemNotifications: { ...notifSettings, [key]: !current },
    })
  }

  if (isLoading) return <Skeleton className="h-64 w-full" />

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('notificationsPage.systemNotifications.title')}</CardTitle>
        <CardDescription>
          {t('notificationsPage.systemNotifications.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {SYSTEM_NOTIFICATION_KEYS.map((key) => {
          const enabled = notifSettings[key] ?? true
          return (
            <div key={key} className="flex items-center justify-between py-1">
              <div>
                <Label className="text-sm">{t(String(`notificationsPage.systemLabels.${key}`))}</Label>
                <p className="text-[11px] text-muted-foreground font-mono">{key}</p>
              </div>
              <Switch checked={enabled} onCheckedChange={() => handleToggle(key, enabled)} />
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

// ── Delivery Settings Tab ────────────────────────────────────────────────────

function DeliverySettingsTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data: settings, isLoading } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: async () => (await api.get('/admin/settings')).data,
  })

  const tgConfig = ((settings?.systemNotifications as Record<string, unknown>)?.telegram ?? {}) as Record<string, unknown>

  const [enabled, setEnabled] = useState(false)
  const [chatId, setChatId] = useState('')
  const [defaultTopicId, setDefaultTopicId] = useState('')
  const [topics, setTopics] = useState<Record<string, string>>({})
  const [hydrated, setHydrated] = useState(false)

  // Hydrate from settings
  if (settings && !hydrated) {
    setEnabled(tgConfig.enabled === true)
    setChatId(typeof tgConfig.chatId === 'string' ? tgConfig.chatId : '')
    setDefaultTopicId(typeof tgConfig.topicId === 'number' ? String(tgConfig.topicId) : '')
    const rawTopics = (tgConfig.topics ?? {}) as Record<string, unknown>
    const parsed: Record<string, string> = {}
    for (const [k, v] of Object.entries(rawTopics)) {
      parsed[k.toUpperCase()] = typeof v === 'number' ? String(v) : ''
    }
    setTopics(parsed)
    setHydrated(true)
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      const topicsPayload: Record<string, number | null> = {}
      for (const cat of EVENT_CATEGORIES) {
        const val = topics[cat]?.trim()
        topicsPayload[cat] = val && /^\d+$/.test(val) ? parseInt(val, 10) : null
      }
      return api.patch('/admin/settings/system-notifications/telegram', {
        enabled,
        chatId: chatId.trim() || null,
        topicId: defaultTopicId.trim() && /^\d+$/.test(defaultTopicId.trim()) ? parseInt(defaultTopicId.trim(), 10) : null,
        topics: topicsPayload,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] })
      toast.success(t('notificationsPage.toasts.deliverySaved'))
    },
    onError: () => toast.error(t('notificationsPage.toasts.deliveryFailed')),
  })

  const testMutation = useMutation({
    mutationFn: () => api.post('/admin/settings/system-notifications/telegram/test'),
    onSuccess: () => toast.success(t('notificationsPage.toasts.testSent')),
    onError: () => toast.error(t('notificationsPage.toasts.testFailed')),
  })

  if (isLoading) return <Skeleton className="h-64 w-full" />

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Send className="h-4 w-4" />
            {t('notificationsPage.delivery.title')}
          </CardTitle>
          <CardDescription>
            {t('notificationsPage.delivery.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Master toggle */}
          <div className="flex items-center justify-between rounded-lg border px-4 py-3">
            <div className="flex items-center gap-2">
              <Power className="h-4 w-4 text-muted-foreground" />
              <div>
                <Label className="font-medium">{t('notificationsPage.delivery.enableLabel')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('notificationsPage.delivery.enableDescription')}
                </p>
              </div>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>

          {/* Chat ID */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <Smartphone className="h-3.5 w-3.5 text-muted-foreground" />
                {t('notificationsPage.delivery.chatIdLabel')}
              </Label>
              <Input
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder={t('notificationsPage.delivery.chatIdPlaceholder')}
              />
              <p className="text-[11px] text-muted-foreground">
                {t('notificationsPage.delivery.chatIdHint')}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <Hash className="h-3.5 w-3.5 text-muted-foreground" />
                {t('notificationsPage.delivery.topicLabel')}
              </Label>
              <Input
                value={defaultTopicId}
                onChange={(e) => setDefaultTopicId(e.target.value)}
                placeholder={t('notificationsPage.delivery.topicPlaceholder')}
              />
              <p className="text-[11px] text-muted-foreground">
                {t('notificationsPage.delivery.topicHint')}
              </p>
            </div>
          </div>

          <Separator />

          {/* Per-category topic routing */}
          <div className="space-y-3">
            <div>
              <Label className="flex items-center gap-1.5 text-sm font-semibold">
                <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
                {t('notificationsPage.delivery.routingTitle')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('notificationsPage.delivery.routingDescription')}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {EVENT_CATEGORIES.map((cat) => (
                <div key={cat} className="space-y-1">
                  <Label className="text-xs">{t(String(`notificationsPage.categoryLabels.${cat}`))}</Label>
                  <Input
                    value={topics[cat] ?? ''}
                    onChange={(e) => setTopics((prev) => ({ ...prev, [cat]: e.target.value }))}
                    placeholder="topic_id"
                    className="h-8 text-xs"
                  />
                </div>
              ))}
            </div>
          </div>

          <Separator />

          <div className="flex gap-3">
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              {t('notificationsPage.delivery.save')}
            </Button>
            <Button variant="outline" onClick={() => testMutation.mutate()} disabled={testMutation.isPending || !enabled || !chatId.trim()}>
              {testMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              {t('notificationsPage.delivery.testMessage')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
