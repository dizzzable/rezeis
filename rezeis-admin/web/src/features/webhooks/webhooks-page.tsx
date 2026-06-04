import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Copy,
  PlayCircle,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Hourglass,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import { getErrorMessage } from '@/lib/http-errors'

import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  getWebhookEventCatalog,
  listWebhookDeliveries,
  listWebhookSubscriptions,
  regenerateWebhookSecret,
  replayWebhookDelivery,
  testWebhookSubscription,
  updateWebhookSubscription,
  type WebhookDelivery,
  type WebhookSubscription,
} from './webhooks-api'

/**
 * Webhooks dashboard — operator-facing UI for outgoing webhook
 * subscriptions and the per-attempt delivery history.
 */
export default function WebhooksPage({ embedded = false }: { readonly embedded?: boolean } = {}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<WebhookDelivery['status'] | 'ALL'>('ALL')

  const { data: subscriptions, isLoading: subsLoading } = useQuery({
    queryKey: ['webhook-subscriptions'],
    queryFn: listWebhookSubscriptions,
    staleTime: 10_000,
  })

  const { data: catalog } = useQuery({
    queryKey: ['webhook-event-catalog'],
    queryFn: getWebhookEventCatalog,
    staleTime: 60_000,
  })

  const { data: deliveries, isLoading: deliveriesLoading } = useQuery({
    queryKey: ['webhook-deliveries', statusFilter],
    queryFn: () =>
      listWebhookDeliveries({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        limit: 50,
      }),
    staleTime: 5_000,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  })

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['webhook-subscriptions'] })
    queryClient.invalidateQueries({ queryKey: ['webhook-deliveries'] })
  }

  return (
    <div className="space-y-6">
      {!embedded && (
        <div>
          <h1 className="text-2xl font-bold">{t('webhooksPage.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('webhooksPage.subtitle')}</p>
        </div>
      )}

      <SubscriptionsSection
        subscriptions={subscriptions?.items ?? []}
        loading={subsLoading}
        catalog={catalog ?? []}
        onChanged={invalidateAll}
      />

      <DeliveriesSection
        deliveries={deliveries?.items ?? []}
        loading={deliveriesLoading}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        onReplayed={() =>
          queryClient.invalidateQueries({ queryKey: ['webhook-deliveries'] })
        }
      />
    </div>
  )
}

// ── Subscriptions ────────────────────────────────────────────────────────────

function SubscriptionsSection(props: {
  subscriptions: readonly WebhookSubscription[]
  loading: boolean
  catalog: readonly string[]
  onChanged: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">
          {t('webhooksPage.subscriptions.heading', { count: props.subscriptions.length })}
        </h2>
      </div>

      <CreateSubscriptionCard catalog={props.catalog} onCreated={props.onChanged} />

      {props.loading ? (
        <Skeleton className="h-32 w-full" />
      ) : props.subscriptions.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            {t('webhooksPage.subscriptions.empty')}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {props.subscriptions.map((sub) => (
            <SubscriptionCard key={sub.id} subscription={sub} onChanged={props.onChanged} />
          ))}
        </div>
      )}
    </div>
  )
}

function CreateSubscriptionCard({
  catalog,
  onCreated,
}: {
  catalog: readonly string[]
  onCreated: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [description, setDescription] = useState('')
  const [eventsRaw, setEventsRaw] = useState('')
  const [createdSecret, setCreatedSecret] = useState<{ name: string; secret: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: createWebhookSubscription,
    onSuccess: (sub) => {
      setCreatedSecret({ name: sub.name, secret: sub.secret ?? '' })
      setName('')
      setUrl('')
      setDescription('')
      setEventsRaw('')
      setError(null)
      onCreated()
    },
    onError: (err) =>
      setError(getErrorMessage(err, t('webhooksPage.subscriptions.createFailed'))),
  })

  const eventTypes = useMemo(
    () =>
      eventsRaw
        .split(/[\s,]+/g)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    [eventsRaw],
  )

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t('webhooksPage.subscriptions.newTitle')}</CardTitle>
          <CardDescription>{t('webhooksPage.subscriptions.newDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="wh-name">{t('webhooksPage.subscriptions.fields.name')}</Label>
              <Input
                id="wh-name"
                placeholder={t('webhooksPage.subscriptions.fields.namePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wh-url">{t('webhooksPage.subscriptions.fields.url')}</Label>
              <Input
                id="wh-url"
                placeholder={t('webhooksPage.subscriptions.fields.urlPlaceholder')}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="wh-events">{t('webhooksPage.subscriptions.fields.events')}</Label>
            <Textarea
              id="wh-events"
              rows={2}
              placeholder={t('webhooksPage.subscriptions.fields.eventsPlaceholder')}
              value={eventsRaw}
              onChange={(e) => setEventsRaw(e.target.value)}
            />
            {catalog.length > 0 && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">
                  {t('webhooksPage.subscriptions.catalog', { count: catalog.length })}
                </summary>
                <div className="mt-2 grid grid-cols-2 gap-1 md:grid-cols-3">
                  {catalog.map((evt) => (
                    <code key={evt} className="rounded bg-muted px-1 py-0.5 text-[10px]">
                      {evt}
                    </code>
                  ))}
                </div>
              </details>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="wh-desc">{t('webhooksPage.subscriptions.fields.description')}</Label>
            <Textarea
              id="wh-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button
            onClick={() =>
              mutation.mutate({
                name: name.trim(),
                url: url.trim(),
                description: description.trim() || undefined,
                eventTypes,
              })
            }
            disabled={mutation.isPending || !name.trim() || !url.trim()}
          >
            {mutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-2 h-4 w-4" />
            )}
            {t('webhooksPage.subscriptions.create')}
          </Button>
        </CardContent>
      </Card>

      {createdSecret && (
        <SecretRevealCard
          title={t('webhooksPage.secretReveal.titleNew', { name: createdSecret.name })}
          secret={createdSecret.secret}
          onClose={() => setCreatedSecret(null)}
        />
      )}
    </>
  )
}

function SecretRevealCard({
  title,
  secret,
  onClose,
}: {
  title: string
  secret: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const copy = () => navigator.clipboard?.writeText(secret)
  return (
    <Card className="border-amber-300 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/30">
      <CardContent className="py-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-600" />
          <div className="flex-1 space-y-2">
            <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">{title}</p>
            <p className="text-xs text-amber-800 dark:text-amber-300">
              {t('webhooksPage.secretReveal.description')}
            </p>
            <div className="flex items-center gap-2 rounded-md bg-background p-2 font-mono text-xs">
              <code className="flex-1 break-all">{secret}</code>
              <Button size="sm" variant="outline" onClick={copy}>
                <Copy className="mr-1 h-3 w-3" /> {t('webhooksPage.secretReveal.copy')}
              </Button>
            </div>
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t('webhooksPage.secretReveal.dismiss')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function SubscriptionCard({
  subscription,
  onChanged,
}: {
  subscription: WebhookSubscription
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null)

  const toggleMutation = useMutation({
    mutationFn: (isActive: boolean) =>
      updateWebhookSubscription(subscription.id, { isActive }),
    onSuccess: onChanged,
    onError: (err) => toast.error(getErrorMessage(err, t('webhooksPage.toasts.toggleFailed'))),
  })

  const regenerateMutation = useMutation({
    mutationFn: () => regenerateWebhookSecret(subscription.id),
    onSuccess: (sub) => {
      setRevealedSecret(sub.secret ?? '')
      onChanged()
    },
    onError: (err) => toast.error(getErrorMessage(err, t('webhooksPage.toasts.regenerateFailed'))),
  })

  const testMutation = useMutation({
    mutationFn: () => testWebhookSubscription(subscription.id),
    onSuccess: onChanged,
    onError: (err) => toast.error(getErrorMessage(err, t('webhooksPage.toasts.testFailed'))),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteWebhookSubscription(subscription.id),
    onSuccess: onChanged,
    onError: (err) => toast.error(getErrorMessage(err, t('webhooksPage.toasts.deleteFailed'))),
  })

  const failureRate =
    subscription.totalDeliveries === 0
      ? 0
      : Math.round((subscription.totalFailures / subscription.totalDeliveries) * 100)

  return (
    <Card className={subscription.autoDisabledAt ? 'border-destructive' : ''}>
      <CardContent className="py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">{subscription.name}</h3>
              {subscription.autoDisabledAt && (
                <Badge variant="destructive" className="text-xs">
                  {t('webhooksPage.subscriptions.autoDisabled')}
                </Badge>
              )}
              {subscription.eventTypes.length === 0 ? (
                <Badge variant="secondary" className="text-xs">
                  {t('webhooksPage.subscriptions.allEvents')}
                </Badge>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {t('webhooksPage.subscriptions.filtersCount', { count: subscription.eventTypes.length })}
                </span>
              )}
            </div>
            <p className="break-all text-xs font-mono text-muted-foreground">{subscription.url}</p>
            {subscription.description && (
              <p className="text-xs text-muted-foreground">{subscription.description}</p>
            )}
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              <span>
                {t('webhooksPage.subscriptions.stats.deliveries')}: <strong>{subscription.totalDeliveries}</strong>
              </span>
              <span>
                {t('webhooksPage.subscriptions.stats.failures')}: <strong>{subscription.totalFailures}</strong> ({failureRate}%)
              </span>
              <span>
                {t('webhooksPage.subscriptions.stats.consecutive')}: <strong>{subscription.consecutiveFailures}</strong>
              </span>
              {subscription.lastDeliveredAt && (
                <span>
                  {t('webhooksPage.subscriptions.stats.lastSuccess')}: {new Date(subscription.lastDeliveredAt).toLocaleString()}
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Switch
              checked={subscription.isActive}
              onCheckedChange={(checked) => toggleMutation.mutate(checked)}
              disabled={toggleMutation.isPending}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending}
              title={t('webhooksPage.subscriptions.actions.sendTest')}
              aria-label={t('webhooksPage.subscriptions.actions.sendTest')}
            >
              <PlayCircle className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => regenerateMutation.mutate()}
              disabled={regenerateMutation.isPending}
              title={t('webhooksPage.subscriptions.actions.regenerateSecret')}
              aria-label={t('webhooksPage.subscriptions.actions.regenerateSecret')}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={deleteMutation.isPending}
                  title={t('webhooksPage.subscriptions.actions.delete')}
                  aria-label={t('webhooksPage.subscriptions.actions.delete')}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t('webhooksPage.subscriptions.actions.delete')}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('webhooksPage.subscriptions.actions.deleteConfirm', { name: subscription.name })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deleteMutation.isPending}>
                    {t('common.cancel')}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    disabled={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate()}
                  >
                    {t('webhooksPage.subscriptions.actions.delete')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        {revealedSecret && (
          <div className="mt-3">
            <SecretRevealCard
              title={t('webhooksPage.secretReveal.titleRegen')}
              secret={revealedSecret}
              onClose={() => setRevealedSecret(null)}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Deliveries ──────────────────────────────────────────────────────────────

function DeliveriesSection(props: {
  deliveries: readonly WebhookDelivery[]
  loading: boolean
  statusFilter: WebhookDelivery['status'] | 'ALL'
  onStatusFilterChange: (status: WebhookDelivery['status'] | 'ALL') => void
  onReplayed: () => void
}) {
  const { t } = useTranslation()
  const filters: Array<WebhookDelivery['status'] | 'ALL'> = [
    'ALL',
    'SUCCEEDED',
    'FAILED',
    'RETRYING',
    'PENDING',
  ]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('webhooksPage.deliveries.heading')}</h2>
        <div className="flex flex-wrap gap-1">
          {filters.map((f) => (
            <Button
              key={f}
              size="sm"
              variant={f === props.statusFilter ? 'default' : 'outline'}
              onClick={() => props.onStatusFilterChange(f)}
            >
              {f === 'ALL' ? t('webhooksPage.deliveries.filters.all') : f}
            </Button>
          ))}
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          {props.loading ? (
            <Skeleton className="h-32 w-full" />
          ) : props.deliveries.length === 0 ? (
            <p className="px-6 py-4 text-sm text-muted-foreground">{t('webhooksPage.deliveries.empty')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/30 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 w-10" />
                  <th className="px-3 py-2">{t('webhooksPage.deliveries.columns.event')}</th>
                  <th className="px-3 py-2">{t('webhooksPage.deliveries.columns.subscription')}</th>
                  <th className="px-3 py-2">{t('webhooksPage.deliveries.columns.http')}</th>
                  <th className="px-3 py-2">{t('webhooksPage.deliveries.columns.attempt')}</th>
                  <th className="px-3 py-2">{t('webhooksPage.deliveries.columns.latency')}</th>
                  <th className="px-3 py-2">{t('webhooksPage.deliveries.columns.when')}</th>
                  <th className="w-16" />
                </tr>
              </thead>
              <tbody>
                {props.deliveries.map((delivery) => (
                  <DeliveryRow
                    key={delivery.id}
                    delivery={delivery}
                    onReplayed={props.onReplayed}
                  />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function DeliveryRow({
  delivery,
  onReplayed,
}: {
  delivery: WebhookDelivery
  onReplayed: () => void
}) {
  const { t } = useTranslation()
  const replayMutation = useMutation({
    mutationFn: () => replayWebhookDelivery(delivery.id),
    onSuccess: onReplayed,
    onError: (err) => toast.error(getErrorMessage(err, t('webhooksPage.toasts.replayFailed'))),
  })
  const icon = statusIcon(delivery.status)
  return (
    <tr className="border-b last:border-0 align-top">
      <td className="px-3 py-2">{icon}</td>
      <td className="px-3 py-2 font-mono text-xs">{delivery.eventType}</td>
      <td className="px-3 py-2 truncate">{delivery.subscriptionName}</td>
      <td className="px-3 py-2 font-mono text-xs">
        {delivery.httpStatus ?? <span className="text-muted-foreground">—</span>}
        {delivery.errorMessage && (
          <div className="mt-1 max-w-[200px] truncate text-xs text-destructive" title={delivery.errorMessage}>
            {delivery.errorMessage}
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-xs">{delivery.attempt}</td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {delivery.durationMs !== null ? `${delivery.durationMs}ms` : '—'}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground" title={delivery.createdAt}>
        {timeAgo(delivery.createdAt, t)}
      </td>
      <td className="px-3 py-2 text-right">
        {(delivery.status === 'FAILED' || delivery.status === 'SUCCEEDED') && (
          <Button
            size="icon"
            variant="ghost"
            onClick={() => replayMutation.mutate()}
            disabled={replayMutation.isPending}
            title={t('webhooksPage.deliveries.replay')}
            aria-label={t('webhooksPage.deliveries.replay')}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        )}
      </td>
    </tr>
  )
}

function statusIcon(status: WebhookDelivery['status']) {
  switch (status) {
    case 'SUCCEEDED':
      return <CheckCircle2 className="h-4 w-4 text-emerald-500" />
    case 'FAILED':
      return <XCircle className="h-4 w-4 text-destructive" />
    case 'RETRYING':
      return <RefreshCw className="h-4 w-4 text-amber-500" />
    case 'PENDING':
    default:
      return <Hourglass className="h-4 w-4 text-muted-foreground" />
  }
}

function timeAgo(iso: string, t: (key: string, options?: Record<string, unknown>) => string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return t('webhooksPage.deliveries.relative.seconds', { count: Math.floor(ms / 1_000) })
  if (ms < 3_600_000) return t('webhooksPage.deliveries.relative.minutes', { count: Math.floor(ms / 60_000) })
  if (ms < 86_400_000) return t('webhooksPage.deliveries.relative.hours', { count: Math.floor(ms / 3_600_000) })
  return new Date(iso).toLocaleDateString()
}
