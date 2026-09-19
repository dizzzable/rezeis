/**
 * «Подключение VPN» in the broadcast compose form: the filter
 * `audienceFilter.connect = { bucket, withinDays, excludeHelped }`, the URL
 * prefill `/broadcast?compose=connect-help&bucket=paid|trial&days=N`, and the
 * preview block the API answers with. Pure, so every rule is tested without a
 * page.
 */

/** «Оплатил и не подключился» / «Пробный период или подарок — не подключился». Never both. */
export const CONNECT_BUCKETS = ['paid', 'trial'] as const
export type ConnectBucket = (typeof CONNECT_BUCKETS)[number]

export const CONNECT_DAYS_MIN = 1
export const CONNECT_DAYS_MAX = 30
export const CONNECT_DAYS_DEFAULT = 7

/**
 * ── THE COMPANION, SENT WITH EVERY CONNECT FILTER ────────────────────────
 *
 * A panel image older than this filter does not know `connect`. Its
 * normaliser drops the key, and a filter holding ONLY `connect` becomes "no
 * filter" — which falls back to the preset, and the preset is «Все
 * пользователи» by default. A scheduled «не подключился» broadcast left behind
 * a rollback would then go to everyone.
 *
 * So the form always sends the subscription chips «Активная» + «Ограниченная»
 * beside `connect`, and the preset «Активные подписчики». For this image they
 * change nothing — everyone the connect filter can match holds an ACTIVE or
 * LIMITED subscription — and an older image degrades to active subscribers,
 * never to everyone.
 */
export const CONNECT_COMPANION_SUBSCRIPTION: readonly string[] = ['ACTIVE', 'LIMITED']
export const CONNECT_COMPANION_AUDIENCE = 'ACTIVE_SUBSCRIBERS'

/** The query `compose=connect-help` opens «Новая рассылка» with. */
export const CONNECT_COMPOSE_PARAM = 'compose'
export const CONNECT_COMPOSE_VALUE = 'connect-help'

export interface ConnectPrefill {
  /** `null`: the link named a bucket this panel does not know — nothing is guessed. */
  readonly bucket: ConnectBucket | null
  readonly days: number
}

export interface BroadcastConnectFilterBody {
  readonly bucket: ConnectBucket
  readonly withinDays: number
  readonly excludeHelped: boolean
}

/** Whole days in 1–30; anything unreadable is the default 7. */
export function clampConnectDays(raw: string | number): number {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return CONNECT_DAYS_DEFAULT
  return Math.min(CONNECT_DAYS_MAX, Math.max(CONNECT_DAYS_MIN, Math.trunc(parsed)))
}

export function isConnectBucket(value: unknown): value is ConnectBucket {
  return (CONNECT_BUCKETS as readonly unknown[]).includes(value)
}

/**
 * The prefill a link carries, or `null` when it carries none. A missing
 * `bucket` is «Оплатил» — the link «Помощь с подключением» hands out; one the
 * panel does not know opens the dialog with no chip chosen.
 */
export function parseConnectPrefill(params: URLSearchParams): ConnectPrefill | null {
  if (params.get(CONNECT_COMPOSE_PARAM) !== CONNECT_COMPOSE_VALUE) return null
  const bucket = params.get('bucket')
  const days = params.get('days')
  return {
    bucket: bucket === null ? 'paid' : isConnectBucket(bucket) ? bucket : null,
    days: days === null ? CONNECT_DAYS_DEFAULT : clampConnectDays(days),
  }
}

/**
 * What a `compose=connect-help` link starts the message from: the Russian
 * default of «Помощь с подключением» (`connect_help`, and `connect_help_trial`
 * for trials and gifts, in the panel's template catalogue) WITHOUT its
 * `«{{plan}}»`. A broadcast sends its text exactly as written — it fills in no
 * placeholders — so the template's own body would reach every customer as
 * «Подписка «{{plan}}» оплачена». Russian whatever the panel's language:
 * broadcasts are single-language, and the customers read Russian.
 *
 * `test/broadcast-connect-prefill-copy.spec.ts` (panel side) holds this to the
 * catalogue, so an edit there cannot leave this copy behind.
 */
export const CONNECT_HELP_BROADCAST_COPY: Readonly<Record<ConnectBucket, { readonly title: string; readonly text: string }>> = {
  paid: {
    title: 'Не получилось подключиться?',
    text:
      'Подписка оплачена, но VPN на ней ещё ни разу не подключался.\n\n' +
      'Откройте экран подключения — он подскажет приложение для вашего устройства ' +
      'и добавит подписку в одно касание. Если что-то не выйдет, напишите нам: поможем.',
  },
  trial: {
    title: 'Не получилось подключиться?',
    text:
      'Подписка уже работает, но VPN на ней ещё ни разу не подключался.\n\n' +
      'Откройте экран подключения — он подскажет приложение для вашего устройства ' +
      'и добавит подписку в одно касание. Если что-то не выйдет, напишите нам: поможем.',
  },
}

/** The same query without the prefill, so closing the dialog does not reopen it on the next render. */
export function withoutConnectPrefill(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params)
  next.delete(CONNECT_COMPOSE_PARAM)
  next.delete('bucket')
  next.delete('days')
  return next
}

// ── The preview's `connect` block ─────────────────────────────────────────

export type ConnectSignalState = 'live' | 'starting' | 'webhooks_only' | 'blind'

export interface BroadcastConnectHealth {
  readonly state: ConnectSignalState
  readonly checkedCoverage: number
  readonly lastOkAt: string | null
  readonly lastUserWebhookAt: string | null
  readonly failingSince: string | null
  readonly coverage: {
    readonly total: number
    readonly connected: number
    readonly verified: number
    readonly unverified: number
  }
  readonly firstPassHours: number
}

/**
 * `signal_down`: the connection signal is `webhooks_only` or `blind` — the
 * panel cannot tell who connected, so nothing is counted or sent; `health`
 * says which and since when.
 */
export type BroadcastConnectRefusal = 'too_many' | 'timeout' | 'unreadable' | 'signal_down'

export interface BroadcastConnectPreview {
  readonly verified: number | null
  readonly unverified: number | null
  readonly health: BroadcastConnectHealth
  readonly refusal: BroadcastConnectRefusal | null
  readonly limit: number
}

/** What a stored draft's `audienceFilter.connect` can be, as the API maps it. */
export type StoredConnectFilter = BroadcastConnectFilterBody | { readonly unreadable: true }

export function readableConnect(value: StoredConnectFilter | null | undefined): BroadcastConnectFilterBody | null {
  if (value === null || value === undefined || 'unreadable' in value) return null
  return isConnectBucket(value.bucket) ? value : null
}

/**
 * The health sentence's key and values, or `null` while the signal is `live`
 * (the preview then says nothing about it). The texts are design §1.7's.
 */
export function connectHealthSentence(
  health: BroadcastConnectHealth,
  formatInstant: (iso: string) => string,
): { readonly key: string; readonly values: Record<string, string | number> } | null {
  const done = health.coverage.connected + health.coverage.verified
  switch (health.state) {
    case 'live':
      return null
    case 'starting':
      return {
        key: 'broadcastPage.connect.health.starting',
        values: { hours: Math.max(1, health.firstPassHours), done, total: health.coverage.total },
      }
    case 'webhooks_only':
    case 'blind': {
      const since = health.failingSince ?? health.lastOkAt
      return {
        key: `broadcastPage.connect.health.${health.state}`,
        values: { time: since === null ? '—' : formatInstant(since) },
      }
    }
  }
}
