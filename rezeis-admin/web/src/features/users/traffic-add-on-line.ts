/**
 * «из них докупки: +50 ГБ до 01.10 03:20 (по Москве)» — which part of a
 * subscription's traffic limit is an add-on with an end of its own.
 *
 * With the durable add-on model on, the limit the subscription card shows and
 * edits is the plan's base plus every live traffic add-on. Without this line
 * an operator took the whole number for the base and typed a new total around
 * it, and the add-on's end then took its gigabytes out of what the operator
 * meant to give (owner, 25.09.2026). The server sends the share
 * (`trafficAddOns`, from the ACTIVE entitlements) and the panel's «Часовой
 * пояс» (`displayTimeZone`); the times are shown in that zone, named.
 */
import { zoneOffsetLabel } from '@/features/settings/platform-timezone'

/** Add-ons that end at the same moment, summed — `GET /admin/users/:telegramId`, per subscription. */
export interface TrafficAddOnShareItem {
  readonly gb: number
  /** When the panel takes them off; `null` for a row with no end. */
  readonly endsAt: string | null
  /** Remnawave's traffic reset they end with — the time to show; `null` otherwise. */
  readonly resetAt: string | null
}

export interface TrafficAddOnShare {
  readonly totalGb: number
  readonly items: ReadonlyArray<TrafficAddOnShareItem>
}

type Translate = (key: string, options?: Record<string, unknown>) => string

/** The dative a Russian sentence names these zones with; any other zone goes by its offset. */
const ZONE_PHRASE_RU: Readonly<Record<string, string>> = {
  'Europe/Kaliningrad': 'по Калининграду',
  'Europe/Moscow': 'по Москве',
  'Europe/Samara': 'по Самаре',
  'Europe/Volgograd': 'по Волгограду',
  'Asia/Yekaterinburg': 'по Екатеринбургу',
  'Asia/Omsk': 'по Омску',
  'Asia/Novosibirsk': 'по Новосибирску',
  'Asia/Krasnoyarsk': 'по Красноярску',
  'Asia/Irkutsk': 'по Иркутску',
  'Asia/Yakutsk': 'по Якутску',
  'Asia/Vladivostok': 'по Владивостоку',
  'Asia/Magadan': 'по Магадану',
  'Asia/Kamchatka': 'по Камчатке',
  'Europe/Minsk': 'по Минску',
  'Europe/Kyiv': 'по Киеву',
  'Europe/Kiev': 'по Киеву',
  'Asia/Almaty': 'по Алматы',
  'Asia/Tashkent': 'по Ташкенту',
}

/** The operator's zone when this browser knows it; UTC otherwise, and then named UTC. */
function usableZone(zone: string | null | undefined): string {
  if (typeof zone !== 'string' || zone.trim() === '') return 'UTC'
  return zoneOffsetLabel(zone, new Date()) === null ? 'UTC' : zone
}

/**
 * `UTC`, `UTC+5`, `UTC+5:30`, `UTC-3` — the zone's offset at `at`, written as
 * the bot's notices and the cabinet write it (an ASCII minus, the hours
 * without a leading zero, minutes only when there are some), so one moment
 * reads the same to the operator and to the customer. Pinned against both by
 * `zone-phrase-ru.parity.test.ts`. The time-zone picker keeps its own
 * `UTC+05:00` (`zoneOffsetLabel`).
 */
function zoneOffset(zone: string, at: Date): string {
  const label = zoneOffsetLabel(zone, at)
  if (label === null) return 'UTC'
  const match = /^UTC([+-])(\d{2}):(\d{2})$/u.exec(label)
  if (match === null) return label
  // A zero offset is UTC's clock, whatever the zone is called.
  if (match[2] === '00' && match[3] === '00') return 'UTC'
  return `UTC${match[1]}${Number(match[2])}${match[3] === '00' ? '' : `:${match[3]}`}`
}

/** «по Москве» / "Moscow Time"; «по UTC» / "UTC"; otherwise the offset, «UTC+5». */
function zonePhrase(zone: string, at: Date, language: string): string {
  const offset = zoneOffset(zone, at)
  const ru = language.startsWith('ru')
  if (offset === 'UTC') return ru ? 'по UTC' : 'UTC'
  if (ru) return ZONE_PHRASE_RU[zone] ?? offset
  const name = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'shortGeneric' })
    .formatToParts(at)
    .find((part) => part.type === 'timeZoneName')?.value
  return name === undefined || name.startsWith('GMT') ? offset : name
}

/** «01.10 03:20» in `zone`. */
function formatWhen(instant: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((piece) => piece.type === type)?.value ?? ''
  return `${part('day')}.${part('month')} ${part('hour')}:${part('minute')}`
}

/**
 * The line for a subscription's share, or `null` when it has none. Each group
 * shows the moment the customer loses it: the traffic reset for a reset
 * add-on (the take-off half an hour later is the panel's business), the end
 * otherwise.
 */
export function trafficAddOnLine(
  share: TrafficAddOnShare | null | undefined,
  displayTimeZone: string | null | undefined,
  language: string,
  t: Translate,
): string | null {
  if (share === null || share === undefined || share.items.length === 0) return null
  const zone = usableZone(displayTimeZone)
  const number = new Intl.NumberFormat(language.startsWith('ru') ? 'ru-RU' : 'en-GB', { maximumFractionDigits: 2 })
  let firstMoment: Date | null = null
  const items = share.items.map((item) => {
    const gb = number.format(item.gb)
    const moment = item.resetAt ?? item.endsAt
    if (moment === null) return t('userDetailPanel.subscriptions.trafficAddOnNoEnd', { gb })
    const instant = new Date(moment)
    firstMoment ??= instant
    return t('userDetailPanel.subscriptions.trafficAddOnUntil', { gb, when: formatWhen(instant, zone) })
  })
  const line = t('userDetailPanel.subscriptions.trafficAddOns', { items: items.join(', ') })
  return firstMoment === null ? line : `${line} (${zonePhrase(zone, firstMoment, language)})`
}
