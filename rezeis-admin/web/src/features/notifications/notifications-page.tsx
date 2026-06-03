import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Bell,
  Edit2,
  Hash,
  Loader2,
  Mail,
  MessageSquare,
  Power,
  Save,
  Send,
  Settings2,
  Shield,
  Smartphone,
  Sparkles,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { adminQueryKeys } from '@/lib/admin-query-keys'
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
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
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
    queryKey: adminQueryKeys.settings.all,
    queryFn: async () => (await api.get('/admin/settings')).data,
  })

  const { data: templates } = useQuery({
    queryKey: adminQueryKeys.notifications.templates,
    queryFn: async () => (await api.get<NotificationTemplate[]>('/admin/notifications/templates')).data,
  })

  const notifSettings = (settings?.userNotifications ?? {}) as Record<string, boolean>

  const toggleMutation = useMutation({
    mutationFn: (data: { userNotifications: Record<string, boolean> }) =>
      api.patch('/admin/settings/notifications', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.settings.all })
      toast.success(t('notificationsPage.toasts.settingUpdated'))
    },
    onError: () => toast.error(t('notificationsPage.toasts.settingFailed')),
  })

  const updateTemplateMutation = useMutation({
    mutationFn: (data: { id: string; title: string; body: string }) =>
      api.patch(`/admin/notifications/templates/${data.id}`, { title: data.title, body: data.body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.notifications.templates })
      setEditTemplate(null)
      toast.success(t('notificationsPage.toasts.templateUpdated'))
    },
    onError: () => toast.error(t('notificationsPage.toasts.templateFailed')),
  })

  const seedMutation = useMutation({
    mutationFn: () => api.post('/admin/notifications/templates/seed'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.notifications.templates })
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
    queryKey: adminQueryKeys.settings.all,
    queryFn: async () => (await api.get('/admin/settings')).data,
  })

  const notifSettings = (settings?.systemNotifications ?? {}) as Record<string, boolean>

  const toggleMutation = useMutation({
    mutationFn: (data: { systemNotifications: Record<string, boolean> }) =>
      api.patch('/admin/settings/notifications', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.settings.all })
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
  const { data: settings, isLoading } = useQuery({
    queryKey: adminQueryKeys.settings.all,
    queryFn: async () => (await api.get('/admin/settings')).data,
  })

  if (isLoading) return <Skeleton className="h-64 w-full" />

  return (
    <div className="space-y-6">
      <TelegramDeliveryForm settings={settings} />
      <EmailDeliverySettings />
    </div>
  )
}

interface TelegramDeliveryFormProps {
  readonly settings: unknown
}

/**
 * Telegram delivery form. The parent waits for the `useQuery` to resolve
 * before mounting this child, so we can safely derive default values from
 * `settings` synchronously — no set-state-during-render hack is needed.
 */
function TelegramDeliveryForm({ settings }: TelegramDeliveryFormProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const tgConfig = (((settings as Record<string, unknown> | undefined)?.systemNotifications as Record<string, unknown> | undefined)?.telegram ?? {}) as Record<string, unknown>

  const initialTopics: Record<string, string> = {}
  const rawTopics = (tgConfig.topics ?? {}) as Record<string, unknown>
  for (const cat of EVENT_CATEGORIES) {
    const upper = cat.toUpperCase()
    const v = rawTopics[upper] ?? rawTopics[cat]
    initialTopics[cat] = typeof v === 'number' ? String(v) : ''
  }

  const topicIdRule = z
    .string()
    .trim()
    .refine((v) => v === '' || /^\d+$/.test(v), {
      message: t('notificationsPage.delivery.validation.topicInvalid'),
    })

  const schema = z
    .object({
      enabled: z.boolean(),
      mirrorUserNotifications: z.boolean(),
      chatId: z
        .string()
        .trim()
        .refine((v) => v === '' || /^-?\d+$/.test(v), {
          message: t('notificationsPage.delivery.validation.chatIdInvalid'),
        }),
      topicId: topicIdRule,
      topics: z.record(z.string(), topicIdRule),
    })
    .superRefine((data, ctx) => {
      if (data.enabled && !data.chatId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['chatId'],
          message: t('notificationsPage.delivery.validation.chatIdRequired'),
        })
      }
    })

  type FormValues = z.infer<typeof schema>

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      enabled: tgConfig.enabled === true,
      mirrorUserNotifications: tgConfig.mirrorUserNotifications === true,
      chatId: typeof tgConfig.chatId === 'string' ? tgConfig.chatId : '',
      topicId: typeof tgConfig.topicId === 'number' ? String(tgConfig.topicId) : '',
      topics: initialTopics,
    },
  })

  const saveMutation = useMutation({
    mutationFn: (values: FormValues) => {
      const topicsPayload: Record<string, number | null> = {}
      for (const cat of EVENT_CATEGORIES) {
        const val = values.topics[cat]?.trim() ?? ''
        topicsPayload[cat] = val && /^\d+$/.test(val) ? parseInt(val, 10) : null
      }
      return api.patch('/admin/settings/system-notifications/telegram', {
        enabled: values.enabled,
        mirrorUserNotifications: values.mirrorUserNotifications,
        chatId: values.chatId.trim() || null,
        topicId: values.topicId.trim() && /^\d+$/.test(values.topicId.trim())
          ? parseInt(values.topicId.trim(), 10)
          : null,
        topics: topicsPayload,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.settings.all })
      toast.success(t('notificationsPage.toasts.deliverySaved'))
    },
    onError: () => toast.error(t('notificationsPage.toasts.deliveryFailed')),
  })

  const testMutation = useMutation({
    mutationFn: () => api.post('/admin/settings/system-notifications/telegram/test'),
    onSuccess: () => toast.success(t('notificationsPage.toasts.testSent')),
    onError: () => toast.error(t('notificationsPage.toasts.testFailed')),
  })

  // react-hook-form's `form.watch()` is currently flagged by react-doctor as an
  // "incompatible library". This is the documented pattern for subscribing to a
  // single field's value; the React Compiler integration will improve later.
  // eslint-disable-next-line react-hooks/incompatible-library
  const enabled = form.watch('enabled')
  const chatId = form.watch('chatId')

  return (
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
      <CardContent>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((values) => saveMutation.mutate(values))}
            className="space-y-5"
          >
            {/* Master toggle */}
            <FormField
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border px-4 py-3 space-y-0">
                  <div className="flex items-center gap-2">
                    <Power className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <FormLabel className="font-medium">
                        {t('notificationsPage.delivery.enableLabel')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('notificationsPage.delivery.enableDescription')}
                      </FormDescription>
                    </div>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            {/* Chat ID + default topic */}
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="chatId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-1.5">
                      <Smartphone className="h-3.5 w-3.5 text-muted-foreground" />
                      {t('notificationsPage.delivery.chatIdLabel')}
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder={t('notificationsPage.delivery.chatIdPlaceholder')}
                      />
                    </FormControl>
                    <FormDescription className="text-[11px]">
                      {t('notificationsPage.delivery.chatIdHint')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="topicId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-1.5">
                      <Hash className="h-3.5 w-3.5 text-muted-foreground" />
                      {t('notificationsPage.delivery.topicLabel')}
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder={t('notificationsPage.delivery.topicPlaceholder')}
                      />
                    </FormControl>
                    <FormDescription className="text-[11px]">
                      {t('notificationsPage.delivery.topicHint')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <Separator />

            {/* Per-category routing */}
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
                  <FormField
                    key={cat}
                    control={form.control}
                    name={`topics.${cat}` as const}
                    render={({ field }) => (
                      <FormItem className="space-y-1">
                        <FormLabel className="text-xs">
                          {t(String(`notificationsPage.categoryLabels.${cat}`))}
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            placeholder="topic_id"
                            className="h-8 text-xs"
                          />
                        </FormControl>
                        <FormMessage className="text-[10px]" />
                      </FormItem>
                    )}
                  />
                ))}
              </div>
            </div>

            <Separator />

            {/* Mirror user notifications */}
            <FormField
              control={form.control}
              name="mirrorUserNotifications"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border px-4 py-3 space-y-0">
                  <div className="flex items-center gap-2">
                    <Bell className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <FormLabel className="font-medium">
                        {t('notificationsPage.delivery.mirrorLabel')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('notificationsPage.delivery.mirrorDescription')}
                      </FormDescription>
                    </div>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            <Separator />

            <div className="flex gap-3">
              <Button type="submit" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                {t('notificationsPage.delivery.save')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => testMutation.mutate()}
                disabled={testMutation.isPending || !enabled || !chatId.trim()}
              >
                {testMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                {t('notificationsPage.delivery.testMessage')}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}


// ── Email SMTP Delivery Settings ─────────────────────────────────────────────

interface SmtpSettings {
  enabled: boolean
  host: string | null
  port: number
  username: string | null
  password: string | null
  fromAddress: string
  fromName: string
  useTls: boolean
  useSsl: boolean
  passwordSet?: boolean
}

function EmailDeliverySettings() {
  const { data, isLoading } = useQuery<SmtpSettings>({
    queryKey: adminQueryKeys.email.settings,
    queryFn: async () => (await api.get('/admin/email/settings')).data,
  })

  if (isLoading || !data) return <Skeleton className="h-64 w-full" />
  return <EmailDeliveryForm initial={data} />
}

interface EmailDeliveryFormProps {
  readonly initial: SmtpSettings
}

function EmailDeliveryForm({ initial }: EmailDeliveryFormProps) {
  const { t } = useTranslation()

  const schema = z
    .object({
      enabled: z.boolean(),
      host: z.string().trim(),
      port: z.coerce
        .number({ error: t('notificationsPage.email.validation.portInvalid') })
        .int(t('notificationsPage.email.validation.portInvalid'))
        .min(1, t('notificationsPage.email.validation.portInvalid'))
        .max(65535, t('notificationsPage.email.validation.portInvalid')),
      username: z.string().trim(),
      password: z.string(),
      fromAddress: z
        .string()
        .trim()
        .min(1, t('notificationsPage.email.validation.fromAddressRequired'))
        .email(t('notificationsPage.email.validation.fromAddressInvalid')),
      fromName: z
        .string()
        .trim()
        .min(1, t('notificationsPage.email.validation.fromNameRequired')),
      useTls: z.boolean(),
      useSsl: z.boolean(),
    })
    .superRefine((data, ctx) => {
      if (data.enabled && !data.host) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['host'],
          message: t('notificationsPage.email.validation.hostRequired'),
        })
      }
    })

  type FormValues = z.infer<typeof schema>

  const form = useForm<FormValues, unknown, FormValues>({
    resolver: zodResolver(schema) as Resolver<FormValues, unknown, FormValues>,
    defaultValues: {
      enabled: initial.enabled,
      host: initial.host ?? '',
      port: initial.port,
      username: initial.username ?? '',
      password: '', // never pre-fill password
      fromAddress: initial.fromAddress,
      fromName: initial.fromName,
      useTls: initial.useTls,
      useSsl: initial.useSsl,
    },
  })

  const testEmailSchema = z
    .string()
    .trim()
    .email(t('notificationsPage.email.validation.testEmailInvalid'))

  const testEmailForm = useForm<{ to: string }>({
    resolver: zodResolver(z.object({ to: testEmailSchema })),
    defaultValues: { to: '' },
  })

  const saveMutation = useMutation({
    mutationFn: (values: FormValues) => {
      const payload: Record<string, unknown> = { ...values }
      // Don't send empty password (keeps existing)
      if (!values.password) delete payload.password
      return api.post('/admin/email/settings', payload)
    },
    onSuccess: () => toast.success(t('notificationsPage.email.toasts.saved')),
    onError: () => toast.error(t('notificationsPage.email.toasts.saveFailed')),
  })

  const verifyMutation = useMutation({
    mutationFn: async () => (await api.post('/admin/email/verify')).data as { success: boolean; error?: string },
    onSuccess: (res) => {
      if (res.success) toast.success(t('notificationsPage.email.toasts.verifyOk'))
      else toast.error(res.error ?? t('notificationsPage.email.toasts.verifyFailed'))
    },
    onError: () => toast.error(t('notificationsPage.email.toasts.verifyFailed')),
  })

  const testMutation = useMutation({
    mutationFn: async (values: { to: string }) =>
      (await api.post('/admin/email/test', { to: values.to })).data as { success: boolean; error?: string },
    onSuccess: (res) => {
      if (res.success) toast.success(t('notificationsPage.email.toasts.testSent'))
      else toast.error(res.error ?? t('notificationsPage.email.toasts.testFailed'))
    },
    onError: () => toast.error(t('notificationsPage.email.toasts.testFailed')),
  })

  // See note above on `form.watch()` and the React Compiler integration.
  // eslint-disable-next-line react-hooks/incompatible-library
  const enabled = form.watch('enabled')
  const host = form.watch('host')

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-4 w-4" />
          {t('notificationsPage.email.title')}
        </CardTitle>
        <CardDescription>
          {t('notificationsPage.email.description')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((values) => saveMutation.mutate(values))}
            className="space-y-5"
          >
            {/* Master toggle */}
            <FormField
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border px-4 py-3 space-y-0">
                  <div className="flex items-center gap-2">
                    <Power className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <FormLabel className="font-medium">
                        {t('notificationsPage.email.enableLabel')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('notificationsPage.email.enableDescription')}
                      </FormDescription>
                    </div>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            {/* SMTP config */}
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="host"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">{t('notificationsPage.email.host')}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="smtp.example.com"
                        className="h-8 text-xs font-mono"
                      />
                    </FormControl>
                    <FormMessage className="text-[10px]" />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="port"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">{t('notificationsPage.email.port')}</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        onChange={(e) => field.onChange(e.target.value === '' ? '' : Number(e.target.value))}
                        className="h-8 text-xs font-mono"
                      />
                    </FormControl>
                    <FormMessage className="text-[10px]" />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="username"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">{t('notificationsPage.email.username')}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="user@example.com"
                        className="h-8 text-xs font-mono"
                      />
                    </FormControl>
                    <FormMessage className="text-[10px]" />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">{t('notificationsPage.email.password')}</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        {...field}
                        placeholder={initial.passwordSet ? '••••••••' : ''}
                        className="h-8 text-xs font-mono"
                      />
                    </FormControl>
                    <FormMessage className="text-[10px]" />
                  </FormItem>
                )}
              />
            </div>

            <Separator />

            {/* From address */}
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="fromAddress"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">{t('notificationsPage.email.fromAddress')}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="no-reply@yourdomain.com"
                        className="h-8 text-xs font-mono"
                      />
                    </FormControl>
                    <FormMessage className="text-[10px]" />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="fromName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">{t('notificationsPage.email.fromName')}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="Rezeis VPN"
                        className="h-8 text-xs"
                      />
                    </FormControl>
                    <FormMessage className="text-[10px]" />
                  </FormItem>
                )}
              />
            </div>

            {/* TLS/SSL */}
            <div className="flex items-center gap-6">
              <FormField
                control={form.control}
                name="useTls"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0">
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <FormLabel className="text-xs">
                      <Shield className="inline h-3 w-3 mr-1" />
                      STARTTLS
                    </FormLabel>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="useSsl"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0">
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <FormLabel className="text-xs">
                      <Shield className="inline h-3 w-3 mr-1" />
                      SSL/TLS
                    </FormLabel>
                  </FormItem>
                )}
              />
            </div>

            <Separator />

            {/* Actions */}
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                {t('notificationsPage.email.save')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => verifyMutation.mutate()}
                disabled={verifyMutation.isPending || !host}
              >
                {verifyMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Shield className="mr-2 h-4 w-4" />}
                {t('notificationsPage.email.verify')}
              </Button>
            </div>
          </form>
        </Form>

        {/* Test email — separate sub-form so save validation does not block test */}
        <Form {...testEmailForm}>
          <form
            onSubmit={testEmailForm.handleSubmit((values) => testMutation.mutate(values))}
            className="flex items-start gap-2 pt-4 mt-4 border-t"
          >
            <FormField
              control={testEmailForm.control}
              name="to"
              render={({ field }) => (
                <FormItem className="flex-1 max-w-64 space-y-1">
                  <FormControl>
                    <Input
                      type="email"
                      {...field}
                      placeholder={t('notificationsPage.email.testPlaceholder')}
                      className="h-8 text-xs"
                    />
                  </FormControl>
                  <FormMessage className="text-[10px]" />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={testMutation.isPending || !enabled}
            >
              {testMutation.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-2 h-3.5 w-3.5" />}
              {t('notificationsPage.email.sendTest')}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}


