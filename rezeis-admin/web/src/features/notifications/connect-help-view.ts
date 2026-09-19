/**
 * «Помощь с подключением» — what the card reads, and the sentences it says.
 *
 * Pure, so every branch is tested without rendering: the server answers in
 * codes and numbers (`GET /admin/connect-help/status`), and the words an
 * operator reads are made here, in the panel's language and time zone.
 */
import type { TFunction } from 'i18next'

/** The broadcast draft «Отправить рассылкой тем, кто уже ждёт…» opens (built by the broadcast page). */
export const CONNECT_HELP_BROADCAST_PREFILL = '/broadcast?compose=connect-help&bucket=paid&days=7'

/** The id of the «Шаблоны сообщений» card the «Изменить текст» link scrolls to. */
export const NOTIFICATION_TEMPLATES_ANCHOR = 'notification-templates'

export const CONNECT_HELP_MIN_DELAY_HOURS = 1
export const CONNECT_HELP_MAX_DELAY_HOURS = 168
export const CONNECT_HELP_DEFAULT_DELAY_HOURS = 24

export interface ConnectHelpSettings {
  readonly enabled: boolean
  readonly delayHours: number
  readonly includeTrials: boolean
}

export type ConnectSignalState = 'live' | 'starting' | 'webhooks_only' | 'blind'

export interface ConnectSignalHealth {
  readonly state: ConnectSignalState
  readonly lastOkAt: string | null
  readonly coverage: { readonly total: number; readonly connected: number; readonly verified: number }
  readonly probe: { readonly failingSince: string | null; readonly firstPassHours: number }
}

export interface ConnectHelpCycle {
  readonly finishedAt: string
  readonly standDown: 'disabled' | null
  readonly checked: number
  readonly waiting: number
  readonly sent: { readonly bot: number; readonly push: number; readonly email: number }
  readonly banner: number
  readonly optedOut: number
  readonly merged: number
  readonly skippedUnverifiable: number
  readonly skippedTemplateOff: number
  readonly deferred: number
  readonly leftOver: number
  readonly errors: number
}

export type ConnectHelpTemplateState = 'active' | 'inactive' | 'missing'

export interface ConnectHelpStatus {
  readonly health: ConnectSignalHealth | null
  readonly lastCycle: ConnectHelpCycle | null
  readonly templates: {
    readonly connect_help: ConnectHelpTemplateState
    readonly connect_help_trial: ConnectHelpTemplateState
  }
  readonly timezone: string
}

export interface ConnectHelpAttempt {
  readonly channel: 'bot' | 'push' | 'email'
  readonly result: string
  readonly at: string
  readonly detail?: string
}

export interface ConnectHelpLogItem {
  readonly subscriptionId: string
  readonly decidedAt: string
  readonly kind: string | null
  readonly source: string | null
  readonly outcome: string | null
  readonly attempts: readonly ConnectHelpAttempt[]
  readonly deferrals: number
  readonly connectedAt: string | null
  readonly user: {
    readonly id: string
    readonly telegramId: string | null
    readonly name: string | null
    readonly username: string | null
  }
  readonly planName: string | null
}

export interface ConnectHelpLogPage {
  readonly items: readonly ConnectHelpLogItem[]
  readonly nextCursor: string | null
  readonly timezone: string
}

/** The log's filters, in the order the chips show them. `null` is «Все». */
export const CONNECT_HELP_LOG_FILTERS = [
  'bot',
  'push',
  'email',
  'banner',
  'opted_out',
  'merged',
  'skipped_unverifiable',
  'skipped_template_off',
  'broadcast',
  'in_flight',
] as const

export type ConnectHelpLogFilter = (typeof CONNECT_HELP_LOG_FILTERS)[number]

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * The switches as the server stores them — read the way the server reads them,
 * so a malformed answer shows OFF / 24 / OFF, never a switch that looks on.
 * `null` when the answer is not a settings object at all.
 */
export function readConnectHelpSettings(raw: unknown): ConnectHelpSettings | null {
  if (!isRecord(raw)) return null
  const hours = raw['delayHours']
  return {
    enabled: raw['enabled'] === true,
    delayHours:
      typeof hours === 'number' &&
      Number.isInteger(hours) &&
      hours >= CONNECT_HELP_MIN_DELAY_HOURS &&
      hours <= CONNECT_HELP_MAX_DELAY_HOURS
        ? hours
        : CONNECT_HELP_DEFAULT_DELAY_HOURS,
    includeTrials: raw['includeTrials'] === true,
  }
}

/** The hours field's text as the whole number the server accepts, or `null`. */
export function parseDelayHours(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,3}$/.test(trimmed)) return null
  const hours = Number(trimmed)
  return hours >= CONNECT_HELP_MIN_DELAY_HOURS && hours <= CONNECT_HELP_MAX_DELAY_HOURS ? hours : null
}

function readTemplateState(value: unknown): ConnectHelpTemplateState {
  return value === 'active' || value === 'inactive' ? value : 'missing'
}

function readHealth(raw: unknown): ConnectSignalHealth | null {
  if (!isRecord(raw)) return null
  const state = raw['state']
  if (state !== 'live' && state !== 'starting' && state !== 'webhooks_only' && state !== 'blind') return null
  const coverage = isRecord(raw['coverage']) ? raw['coverage'] : {}
  const probe = isRecord(raw['probe']) ? raw['probe'] : {}
  return {
    state,
    lastOkAt: typeof raw['lastOkAt'] === 'string' ? raw['lastOkAt'] : null,
    coverage: {
      total: readCount(coverage['total']),
      connected: readCount(coverage['connected']),
      verified: readCount(coverage['verified']),
    },
    probe: {
      failingSince: typeof probe['failingSince'] === 'string' ? probe['failingSince'] : null,
      firstPassHours: readCount(probe['firstPassHours']),
    },
  }
}

function readCycle(raw: unknown): ConnectHelpCycle | null {
  if (!isRecord(raw) || typeof raw['finishedAt'] !== 'string') return null
  const sent = isRecord(raw['sent']) ? raw['sent'] : {}
  return {
    finishedAt: raw['finishedAt'],
    standDown: raw['standDown'] === 'disabled' ? 'disabled' : null,
    checked: readCount(raw['checked']),
    waiting: readCount(raw['waiting']),
    sent: { bot: readCount(sent['bot']), push: readCount(sent['push']), email: readCount(sent['email']) },
    banner: readCount(raw['banner']),
    optedOut: readCount(raw['optedOut']),
    merged: readCount(raw['merged']),
    skippedUnverifiable: readCount(raw['skippedUnverifiable']),
    skippedTemplateOff: readCount(raw['skippedTemplateOff']),
    deferred: readCount(raw['deferred']),
    leftOver: readCount(raw['leftOver']),
    errors: readCount(raw['errors']),
  }
}

/** `GET /admin/connect-help/status`, or `null` when the answer is not one. */
export function readConnectHelpStatus(raw: unknown): ConnectHelpStatus | null {
  if (!isRecord(raw)) return null
  const templates = isRecord(raw['templates']) ? raw['templates'] : {}
  return {
    health: readHealth(raw['health']),
    lastCycle: readCycle(raw['lastCycle']),
    templates: {
      connect_help: readTemplateState(templates['connect_help']),
      connect_help_trial: readTemplateState(templates['connect_help_trial']),
    },
    timezone: typeof raw['timezone'] === 'string' && raw['timezone'].length > 0 ? raw['timezone'] : 'UTC',
  }
}

/** A time in the panel's zone; UTC when the zone is not one the browser knows. */
export function formatInZone(
  iso: string,
  timezone: string,
  locale: string,
  shape: 'time' | 'dateTime',
): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  // A 24-hour clock in both languages: the log is read against server times
  // and other operators' reports, and «05:40» must not mean two things.
  const options: Intl.DateTimeFormatOptions =
    shape === 'time'
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
      : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: timezone }).format(at)
  } catch {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(at)
  }
}

/** «только что», «5 мин назад», «3 ч назад», «2 дн. назад». */
export function formatAgo(t: TFunction, iso: string | null, now: Date): string {
  if (iso === null) return t('notificationsPage.connectHelp.signal.never')
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return t('notificationsPage.connectHelp.signal.never')
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000)
  if (minutes < 1) return t('notificationsPage.connectHelp.signal.justNow')
  if (minutes < 60) return t('notificationsPage.connectHelp.signal.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return t('notificationsPage.connectHelp.signal.hoursAgo', { count: hours })
  return t('notificationsPage.connectHelp.signal.daysAgo', { count: Math.floor(hours / 24) })
}

/** The signal-health sentence (the texts of design §1.7). */
export function healthSentence(
  t: TFunction,
  health: ConnectSignalHealth,
  context: { readonly now: Date; readonly timezone: string; readonly locale: string },
): string {
  const done = health.coverage.connected + health.coverage.verified
  const total = health.coverage.total
  switch (health.state) {
    case 'live':
      return t('notificationsPage.connectHelp.signal.live', {
        ago: formatAgo(t, health.lastOkAt, context.now),
        done,
        total,
      })
    case 'starting':
      return t('notificationsPage.connectHelp.signal.starting', {
        hours: Math.max(1, health.probe.firstPassHours),
        done,
        total,
      })
    case 'webhooks_only':
    case 'blind': {
      const since = health.probe.failingSince ?? health.lastOkAt
      const time =
        since === null
          ? t('notificationsPage.connectHelp.signal.never')
          : formatInZone(since, context.timezone, context.locale, 'dateTime')
      return t(`notificationsPage.connectHelp.signal.${health.state}`, { time })
    }
  }
}

/** A cycle older than this means the worker has not run for three beats. */
export const CONNECT_HELP_CYCLE_STALE_MS = 30 * 60 * 1000

/** The last-cycle line: «Последний проход в 10:40: проверено 12, отправлено 3 (бот 2, push 1), …». */
export function lastCycleSentence(
  t: TFunction,
  cycle: ConnectHelpCycle | null,
  context: { readonly timezone: string; readonly locale: string },
): string {
  if (cycle === null) return t('notificationsPage.connectHelp.lastCycle.none')
  const time = formatInZone(cycle.finishedAt, context.timezone, context.locale, 'time')
  if (cycle.standDown === 'disabled') return t('notificationsPage.connectHelp.lastCycle.disabled', { time })
  const key = 'notificationsPage.connectHelp.lastCycle'
  const sentParts = (['bot', 'push', 'email'] as const)
    .filter((channel) => cycle.sent[channel] > 0)
    .map((channel) => t(`${key}.channels.${channel}`, { count: cycle.sent[channel] }))
  const sent = cycle.sent.bot + cycle.sent.push + cycle.sent.email
  const summary = t(`${key}.summary`, {
    time,
    checked: cycle.checked,
    sent,
    breakdown: sentParts.length === 0 ? '' : t(`${key}.breakdown`, { parts: sentParts.join(', ') }),
    banner: cycle.banner,
    waiting: cycle.waiting,
  })
  const extras = (
    [
      ['deferred', cycle.deferred],
      ['optedOut', cycle.optedOut],
      ['merged', cycle.merged],
      ['skippedUnverifiable', cycle.skippedUnverifiable],
      ['skippedTemplateOff', cycle.skippedTemplateOff],
      ['leftOver', cycle.leftOver],
      ['errors', cycle.errors],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([name, count]) => t(`${key}.extras.${name}`, { count }))
  return extras.length === 0 ? summary : `${summary} ${t(`${key}.more`, { parts: extras.join(', ') })}`
}

/** Whether the last cycle is too old for a worker that runs every ten minutes. */
export function isCycleStale(cycle: ConnectHelpCycle | null, now: Date): boolean {
  if (cycle === null) return false
  const at = new Date(cycle.finishedAt)
  return !Number.isNaN(at.getTime()) && now.getTime() - at.getTime() > CONNECT_HELP_CYCLE_STALE_MS
}

const OUTCOMES = new Set<string>(CONNECT_HELP_LOG_FILTERS)

/** A decision's outcome in words; `null` is a ladder that has not finished. */
export function outcomeLabel(t: TFunction, outcome: string | null): string {
  const key = outcome ?? 'in_flight'
  return OUTCOMES.has(key) ? t(`notificationsPage.connectHelp.log.outcome.${key}`) : key
}

const RESULTS: Readonly<Record<ConnectHelpAttempt['channel'], ReadonlySet<string>>> = {
  bot: new Set(['confirmed', 'unconfirmed', 'rejected', 'disabled', 'timeout', 'failed']),
  push: new Set(['delivered', 'failed']),
  email: new Set(['queued', 'failed']),
}

const UNAVAILABLE = new Set([
  'no_telegram',
  'bot_blocked',
  'relay_off',
  'not_configured',
  'no_subscription',
  'no_mailer',
  'not_mailable',
  'smtp_off',
  'notify_users_off',
  'no_verified_email',
])

/** One step in words: «бот: клиент заблокировал бота». */
export function attemptLabel(t: TFunction, attempt: ConnectHelpAttempt): string {
  const base = 'notificationsPage.connectHelp.log.attempt'
  const channel = t(`${base}.channel.${attempt.channel}`)
  let result: string
  if (attempt.result === 'unavailable') {
    result =
      attempt.detail !== undefined && UNAVAILABLE.has(attempt.detail)
        ? t(`${base}.unavailable.${attempt.detail}`)
        : t(`${base}.unavailable.other`)
  } else if (RESULTS[attempt.channel]?.has(attempt.result) === true) {
    result = t(`${base}.${attempt.channel}.${attempt.result}`)
  } else {
    result = attempt.result
  }
  return `${channel}: ${result}`
}

/** Who the decision was about, in the order an operator would search for them. */
export function customerLabel(item: ConnectHelpLogItem): string {
  if (item.user.name !== null && item.user.name.length > 0) {
    return item.user.username === null ? item.user.name : `${item.user.name} (@${item.user.username})`
  }
  if (item.user.username !== null) return `@${item.user.username}`
  return item.user.telegramId ?? item.user.id
}

/** `GET /admin/connect-help/log`, or `null` when the answer is not one. */
export function readConnectHelpLogPage(raw: unknown): ConnectHelpLogPage | null {
  if (!isRecord(raw) || !Array.isArray(raw['items'])) return null
  const items: ConnectHelpLogItem[] = []
  for (const entry of raw['items']) {
    if (!isRecord(entry) || typeof entry['subscriptionId'] !== 'string' || typeof entry['decidedAt'] !== 'string') {
      continue
    }
    const user = isRecord(entry['user']) ? entry['user'] : {}
    const attempts: ConnectHelpAttempt[] = []
    for (const step of Array.isArray(entry['attempts']) ? entry['attempts'] : []) {
      if (!isRecord(step)) continue
      const channel = step['channel']
      if (channel !== 'bot' && channel !== 'push' && channel !== 'email') continue
      if (typeof step['result'] !== 'string' || typeof step['at'] !== 'string') continue
      attempts.push({
        channel,
        result: step['result'],
        at: step['at'],
        ...(typeof step['detail'] === 'string' ? { detail: step['detail'] } : {}),
      })
    }
    items.push({
      subscriptionId: entry['subscriptionId'],
      decidedAt: entry['decidedAt'],
      kind: typeof entry['kind'] === 'string' ? entry['kind'] : null,
      source: typeof entry['source'] === 'string' ? entry['source'] : null,
      outcome: typeof entry['outcome'] === 'string' ? entry['outcome'] : null,
      attempts,
      deferrals: readCount(entry['deferrals']),
      connectedAt: typeof entry['connectedAt'] === 'string' ? entry['connectedAt'] : null,
      user: {
        id: typeof user['id'] === 'string' ? user['id'] : '',
        telegramId: typeof user['telegramId'] === 'string' ? user['telegramId'] : null,
        name: typeof user['name'] === 'string' ? user['name'] : null,
        username: typeof user['username'] === 'string' ? user['username'] : null,
      },
      planName: typeof entry['planName'] === 'string' ? entry['planName'] : null,
    })
  }
  return {
    items,
    nextCursor: typeof raw['nextCursor'] === 'string' ? raw['nextCursor'] : null,
    timezone: typeof raw['timezone'] === 'string' && raw['timezone'].length > 0 ? raw['timezone'] : 'UTC',
  }
}
