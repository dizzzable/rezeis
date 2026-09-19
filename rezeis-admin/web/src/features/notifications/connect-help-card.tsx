import { useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { AlertTriangle, LifeBuoy, Loader2, ScrollText, Send } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { InfoTip } from '@/components/ui/info-tip'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useHasPermission } from '@/features/rbac'
import {
  CONNECT_HELP_BROADCAST_PREFILL,
  CONNECT_HELP_LOG_FILTERS,
  NOTIFICATION_TEMPLATES_ANCHOR,
  attemptLabel,
  customerLabel,
  formatAgo,
  formatInZone,
  healthSentence,
  isCycleStale,
  lastCycleSentence,
  outcomeLabel,
  parseDelayHours,
  readConnectHelpLogPage,
  readConnectHelpSettings,
  readConnectHelpStatus,
  type ConnectHelpLogFilter,
  type ConnectHelpLogPage,
  type ConnectHelpSettings,
} from './connect-help-view'

/** Under `['admin', 'notifications']`, so invalidating the page's queries refreshes these too. */
const SETTINGS_KEY = ['admin', 'notifications', 'connect-help', 'settings'] as const
const STATUS_KEY = ['admin', 'notifications', 'connect-help', 'status'] as const
const LOG_KEY = ['admin', 'notifications', 'connect-help', 'log'] as const

/**
 * «Уведомления» → «Пользовательские» → «Помощь с подключением».
 *
 * The operator's three switches (automatic sending, the hours, trials and
 * gifts), what the connection signal can currently vouch for, what the last
 * cycle did, where to change the text, the broadcast for those already
 * waiting, and the log. Reading needs `notifications:view` like the page;
 * saving needs `settings:edit`, like the page's other switches.
 */
export function ConnectHelpCard() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const canEdit = useHasPermission('settings', 'edit')
  const [logOpen, setLogOpen] = useState(false)

  const settingsQuery = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: async () => readConnectHelpSettings((await api.get('/admin/connect-help/settings')).data),
  })
  const statusQuery = useQuery({
    queryKey: STATUS_KEY,
    queryFn: async () => readConnectHelpStatus((await api.get('/admin/connect-help/status')).data),
    refetchInterval: 60_000,
  })

  const saveMutation = useMutation({
    mutationFn: async (patch: Partial<ConnectHelpSettings>) =>
      readConnectHelpSettings((await api.patch('/admin/connect-help/settings', patch)).data),
    onSuccess: (saved) => {
      if (saved !== null) queryClient.setQueryData(SETTINGS_KEY, saved)
      void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY })
      toast.success(t('notificationsPage.connectHelp.toasts.saved'))
    },
    onError: () => toast.error(t('notificationsPage.connectHelp.toasts.failed')),
  })

  const settings = settingsQuery.data ?? null
  const status = statusQuery.data ?? null
  const now = new Date()
  const timezone = status?.timezone ?? 'UTC'
  const locale = i18n.language
  const disabled = !canEdit || settings === null || saveMutation.isPending

  return (
    <Card id="connect-help">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LifeBuoy className="h-5 w-5" aria-hidden="true" />
          {t('notificationsPage.connectHelp.title')}
        </CardTitle>
        <CardDescription>{t('notificationsPage.connectHelp.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {settingsQuery.isError || (settingsQuery.isSuccess && settings === null) ? (
          <p className="text-sm text-destructive" role="alert">
            {t('notificationsPage.connectHelp.loadFailed')}
          </p>
        ) : null}

        <SwitchRow
          id="connect-help-enabled"
          label={t('notificationsPage.connectHelp.enabled.label')}
          infoLabel={t('notificationsPage.connectHelp.enabled.infoLabel')}
          info={t('notificationsPage.connectHelp.enabled.info')}
          checked={settings?.enabled ?? false}
          disabled={disabled}
          onChange={(enabled) => saveMutation.mutate({ enabled })}
        />

        <DelayRow
          key={settings?.delayHours ?? 'loading'}
          saved={settings?.delayHours ?? null}
          disabled={disabled}
          onSave={(delayHours) => saveMutation.mutate({ delayHours })}
        />

        <SwitchRow
          id="connect-help-trials"
          label={t('notificationsPage.connectHelp.trials.label')}
          infoLabel={t('notificationsPage.connectHelp.trials.infoLabel')}
          info={t('notificationsPage.connectHelp.trials.info')}
          checked={settings?.includeTrials ?? false}
          // A sub-option of the main switch: greyed out while it is off.
          disabled={disabled || settings?.enabled !== true}
          onChange={(includeTrials) => saveMutation.mutate({ includeTrials })}
        />

        {!canEdit ? (
          <p className="text-xs text-muted-foreground">{t('notificationsPage.connectHelp.noEditRight')}</p>
        ) : null}

        <div className="flex items-start gap-1.5 text-sm" data-testid="connect-help-signal">
          <p className="flex-1">
            {statusQuery.isPending
              ? t('notificationsPage.connectHelp.signal.loading')
              : status?.health === null || status === null
                ? t('notificationsPage.connectHelp.signal.unavailable')
                : healthSentence(t, status.health, { now, timezone, locale })}
          </p>
          <InfoTip label={t('notificationsPage.connectHelp.signal.infoLabel')}>
            {t('notificationsPage.connectHelp.signal.info')}
          </InfoTip>
        </div>

        <div className="flex items-start gap-1.5 text-sm text-muted-foreground" data-testid="connect-help-last-cycle">
          <p className="flex-1">
            {status === null ? null : lastCycleSentence(t, status.lastCycle, { timezone, locale })}
            {status !== null && settings?.enabled === true && isCycleStale(status.lastCycle, now) ? (
              <span className="mt-1 block text-amber-600 dark:text-amber-400">
                {t('notificationsPage.connectHelp.lastCycle.stale', {
                  ago: formatAgo(t, status.lastCycle?.finishedAt ?? null, now),
                })}
              </span>
            ) : null}
          </p>
          <InfoTip label={t('notificationsPage.connectHelp.lastCycle.infoLabel')}>
            {t('notificationsPage.connectHelp.lastCycle.info')}
          </InfoTip>
        </div>

        {status !== null && status.templates.connect_help !== 'active' ? (
          <TemplateWarning text={t('notificationsPage.connectHelp.templates.paidOff')} />
        ) : null}
        {status !== null && settings?.includeTrials === true && status.templates.connect_help_trial !== 'active' ? (
          <TemplateWarning text={t('notificationsPage.connectHelp.templates.trialOff')} />
        ) : null}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-4 text-sm">
          <span className="flex items-center gap-1.5">
            <span className="text-muted-foreground">{t('notificationsPage.connectHelp.links.editText')}</span>
            <a
              href={`#${NOTIFICATION_TEMPLATES_ANCHOR}`}
              className="underline-offset-2 hover:underline"
              onClick={(event) => {
                const target = document.getElementById(NOTIFICATION_TEMPLATES_ANCHOR)
                if (target === null) return
                event.preventDefault()
                target.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
            >
              {t('notificationsPage.connectHelp.links.templates')}
            </a>
            <span aria-hidden="true">·</span>
            <Link to="/bot-map" className="underline-offset-2 hover:underline">
              {t('notificationsPage.connectHelp.links.botMap')}
            </Link>
            <InfoTip label={t('notificationsPage.connectHelp.links.editInfoLabel')}>
              {t('notificationsPage.connectHelp.links.editInfo')}
            </InfoTip>
          </span>
          <span className="flex items-center gap-1.5">
            <Link
              to={CONNECT_HELP_BROADCAST_PREFILL}
              className="flex items-center gap-1 underline-offset-2 hover:underline"
            >
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
              {t('notificationsPage.connectHelp.links.broadcast')}
            </Link>
            <InfoTip label={t('notificationsPage.connectHelp.links.broadcastInfoLabel')}>
              {t('notificationsPage.connectHelp.links.broadcastInfo')}
            </InfoTip>
          </span>
          <span className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={() => setLogOpen(true)}>
              <ScrollText className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              {t('notificationsPage.connectHelp.links.log')}
            </Button>
            <InfoTip label={t('notificationsPage.connectHelp.links.logInfoLabel')}>
              {t('notificationsPage.connectHelp.links.logInfo')}
            </InfoTip>
          </span>
        </div>
      </CardContent>
      {logOpen ? <ConnectHelpLogDialog onClose={() => setLogOpen(false)} /> : null}
    </Card>
  )
}

function TemplateWarning({ text }: { readonly text: string }) {
  return (
    <p className="flex items-start gap-1.5 text-sm text-amber-600 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      {text}
    </p>
  )
}

function SwitchRow(props: {
  readonly id: string
  readonly label: string
  readonly infoLabel: string
  readonly info: string
  readonly checked: boolean
  readonly disabled: boolean
  readonly onChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-1.5">
        <Label htmlFor={props.id} className="text-sm">
          {props.label}
        </Label>
        <InfoTip label={props.infoLabel}>{props.info}</InfoTip>
      </div>
      <Switch
        id={props.id}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={(value) => props.onChange(value)}
      />
    </div>
  )
}

/**
 * The hours field. Saved with its own button, only when the text is a whole
 * number of 1..168 that differs from what is stored — the server refuses
 * anything else, and the field says why before it gets that far.
 */
function DelayRow(props: {
  readonly saved: number | null
  readonly disabled: boolean
  readonly onSave: (hours: number) => void
}) {
  const { t } = useTranslation()
  const [text, setText] = useState(props.saved === null ? '' : String(props.saved))
  const parsed = parseDelayHours(text)
  const invalid = text.trim().length > 0 && parsed === null
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="connect-help-delay" className="text-sm">
            {t('notificationsPage.connectHelp.delay.label')}
          </Label>
          <InfoTip label={t('notificationsPage.connectHelp.delay.infoLabel')}>
            {t('notificationsPage.connectHelp.delay.info')}
          </InfoTip>
        </div>
        <div className="flex items-center gap-2">
          <Input
            id="connect-help-delay"
            inputMode="numeric"
            className="h-8 w-20"
            value={text}
            disabled={props.disabled}
            aria-invalid={invalid}
            onChange={(event) => setText(event.target.value)}
          />
          <span className="text-sm text-muted-foreground">{t('notificationsPage.connectHelp.delay.unit')}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={props.disabled || parsed === null || parsed === props.saved}
            onClick={() => {
              if (parsed !== null) props.onSave(parsed)
            }}
          >
            {t('notificationsPage.connectHelp.delay.save')}
          </Button>
        </div>
      </div>
      {invalid ? (
        <p className="text-xs text-destructive" role="alert">
          {t('notificationsPage.connectHelp.delay.invalid')}
        </p>
      ) : null}
    </div>
  )
}

/** The log: every decision, newest first, a page at a time, filterable by outcome. */
function ConnectHelpLogDialog({ onClose }: { readonly onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const [filter, setFilter] = useState<ConnectHelpLogFilter | null>(null)
  const logQuery = useInfiniteQuery({
    queryKey: [...LOG_KEY, filter ?? 'all'],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<ConnectHelpLogPage> => {
      const params: Record<string, string> = {}
      if (pageParam !== null) params['cursor'] = pageParam
      if (filter !== null) params['outcome'] = filter
      const page = readConnectHelpLogPage((await api.get('/admin/connect-help/log', { params })).data)
      if (page === null) throw new Error('not a log page')
      return page
    },
    getNextPageParam: (last) => last.nextCursor,
  })
  const pages = logQuery.data?.pages ?? []
  const items = pages.flatMap((page) => page.items)
  const timezone = pages[0]?.timezone ?? 'UTC'
  const locale = i18n.language

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('notificationsPage.connectHelp.log.title')}</DialogTitle>
          <DialogDescription>{t('notificationsPage.connectHelp.log.description', { timezone })}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('notificationsPage.connectHelp.log.filterLabel')}>
          {[null, ...CONNECT_HELP_LOG_FILTERS].map((value) => (
            <Button
              key={value ?? 'all'}
              size="sm"
              variant={filter === value ? 'default' : 'outline'}
              aria-pressed={filter === value}
              className="h-7 px-2 text-xs"
              onClick={() => setFilter(value)}
            >
              {value === null ? t('notificationsPage.connectHelp.log.all') : outcomeLabel(t, value)}
            </Button>
          ))}
        </div>
        {logQuery.isPending ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          </div>
        ) : logQuery.isError && items.length === 0 ? (
          <p className="text-sm text-destructive" role="alert">
            {t('notificationsPage.connectHelp.log.loadFailed')}
          </p>
        ) : items.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">{t('notificationsPage.connectHelp.log.empty')}</p>
        ) : (
          <ul className="divide-y text-sm" data-testid="connect-help-log">
            {items.map((item) => (
              <li key={`${item.subscriptionId}:${item.decidedAt}`} className="space-y-0.5 py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{customerLabel(item)}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatInZone(item.decidedAt, timezone, locale, 'dateTime')}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {[
                    item.planName,
                    item.kind === 'paid' || item.kind === 'trial'
                      ? t(`notificationsPage.connectHelp.log.kind.${item.kind}`)
                      : null,
                    item.source === null
                      ? null
                      : item.source.startsWith('broadcast')
                        ? t('notificationsPage.connectHelp.log.source.broadcast')
                        : t('notificationsPage.connectHelp.log.source.auto'),
                  ]
                    .filter((part): part is string => part !== null && part.length > 0)
                    .join(' · ')}
                </div>
                <div>
                  <span className="font-medium">{outcomeLabel(t, item.outcome)}</span>
                  <span className="text-muted-foreground">
                    {' — '}
                    {item.attempts.length === 0
                      ? t('notificationsPage.connectHelp.log.noSteps')
                      : item.attempts.map((attempt) => attemptLabel(t, attempt)).join(' → ')}
                  </span>
                </div>
                {item.deferrals > 0 || item.connectedAt !== null ? (
                  <div className="text-xs text-muted-foreground">
                    {[
                      item.deferrals > 0
                        ? t('notificationsPage.connectHelp.log.deferrals', { count: item.deferrals })
                        : null,
                      item.connectedAt === null
                        ? null
                        : t('notificationsPage.connectHelp.log.connectedLater', {
                            time: formatInZone(item.connectedAt, timezone, locale, 'dateTime'),
                          }),
                    ]
                      .filter((part): part is string => part !== null)
                      .join(' · ')}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {logQuery.hasNextPage ? (
          <Button
            variant="outline"
            size="sm"
            disabled={logQuery.isFetchingNextPage}
            onClick={() => void logQuery.fetchNextPage()}
          >
            {logQuery.isFetchingNextPage ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            {t('notificationsPage.connectHelp.log.more')}
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
