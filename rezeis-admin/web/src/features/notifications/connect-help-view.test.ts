/**
 * «Помощь с подключением» — the words the card says, from the codes and the
 * numbers the server sends. Run against the real bundles in both languages,
 * through a private i18next instance, so a sentence that lost a placeholder or
 * a key that is missing in one language fails here rather than on screen.
 */
import i18next, { type TFunction } from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import { en } from '@/i18n/features/notifications.en'
import { ru } from '@/i18n/features/notifications.ru'

import {
  CONNECT_HELP_BROADCAST_PREFILL,
  attemptLabel,
  formatInZone,
  healthSentence,
  isCycleStale,
  lastCycleSentence,
  outcomeLabel,
  parseDelayHours,
  readConnectHelpLogPage,
  readConnectHelpSettings,
  readConnectHelpStatus,
  type ConnectHelpCycle,
  type ConnectSignalHealth,
} from './connect-help-view'

let tRu: TFunction
let tEn: TFunction

beforeAll(async () => {
  const instance = i18next.createInstance()
  await instance.init({
    lng: 'ru',
    fallbackLng: false,
    resources: { ru: { translation: ru }, en: { translation: en } },
    interpolation: { escapeValue: false },
  })
  tRu = instance.getFixedT('ru')
  tEn = instance.getFixedT('en')
})

const NOW = new Date('2026-09-19T07:40:00.000Z')

function health(overrides: Partial<ConnectSignalHealth> = {}): ConnectSignalHealth {
  return {
    state: 'live',
    lastOkAt: '2026-09-19T07:35:00.000Z',
    coverage: { total: 40, connected: 25, verified: 10 },
    probe: { failingSince: null, firstPassHours: 3 },
    ...overrides,
  }
}

function cycle(overrides: Partial<ConnectHelpCycle> = {}): ConnectHelpCycle {
  return {
    finishedAt: '2026-09-19T07:40:00.000Z',
    standDown: null,
    checked: 12,
    waiting: 5,
    sent: { bot: 2, push: 1, email: 0 },
    banner: 1,
    optedOut: 0,
    merged: 0,
    skippedUnverifiable: 0,
    skippedTemplateOff: 0,
    deferred: 0,
    leftOver: 0,
    errors: 0,
    ...overrides,
  }
}

describe('the switches as the server sends them', () => {
  it('reads what was saved', () => {
    expect(readConnectHelpSettings({ enabled: true, delayHours: 6, includeTrials: true })).toEqual({
      enabled: true,
      delayHours: 6,
      includeTrials: true,
    })
  })

  it('reads anything malformed as OFF / 24 / OFF — never a switch that looks on', () => {
    expect(readConnectHelpSettings({})).toEqual({ enabled: false, delayHours: 24, includeTrials: false })
    expect(readConnectHelpSettings({ enabled: 'true', delayHours: 500, includeTrials: 1 })).toEqual({
      enabled: false,
      delayHours: 24,
      includeTrials: false,
    })
  })

  it('refuses an answer that is not a settings object at all', () => {
    expect(readConnectHelpSettings([])).toBeNull()
    expect(readConnectHelpSettings(null)).toBeNull()
    expect(readConnectHelpSettings('x')).toBeNull()
  })
})

describe('the hours field', () => {
  it('takes a whole number of 1–168', () => {
    expect(parseDelayHours('1')).toBe(1)
    expect(parseDelayHours('168')).toBe(168)
    expect(parseDelayHours(' 36 ')).toBe(36)
  })

  it('refuses everything the server would refuse', () => {
    for (const text of ['', '0', '169', '1.5', '1e2', '-3', 'сутки', '24ч']) {
      expect(parseDelayHours(text), text).toBeNull()
    }
  })
})

describe('the signal sentence (design §1.7)', () => {
  it('live: the last check and the coverage', () => {
    expect(healthSentence(tRu, health(), { now: NOW, timezone: 'Europe/Moscow', locale: 'ru' })).toBe(
      'Статус подключения проверяется: последняя проверка 5 мин назад. Проверено 35 из 40 подписок за 30 дней.',
    )
    expect(healthSentence(tEn, health(), { now: NOW, timezone: 'UTC', locale: 'en' })).toBe(
      'Connections are being checked: last check 5 min ago. Checked 35 of 40 subscriptions of the last 30 days.',
    )
  })

  it('starting: how long the first pass still takes', () => {
    expect(
      healthSentence(tRu, health({ state: 'starting', probe: { failingSince: null, firstPassHours: 8 } }), {
        now: NOW,
        timezone: 'UTC',
        locale: 'ru',
      }),
    ).toBe('Проверяем подписки впервые — это займёт до 8 ч. Пока проверено 35 из 40.')
  })

  it('webhooks_only and blind: since when, in the panel’s own zone', () => {
    const failing = health({
      state: 'webhooks_only',
      probe: { failingSince: '2026-09-19T05:00:00.000Z', firstPassHours: 0 },
    })
    const moscow = healthSentence(tRu, failing, { now: NOW, timezone: 'Europe/Moscow', locale: 'ru' })
    expect(moscow).toContain(`Remnawave не отвечает на запросы с ${formatInZone('2026-09-19T05:00:00.000Z', 'Europe/Moscow', 'ru', 'dateTime')}.`)
    expect(moscow).toContain('08:00')
    expect(moscow).toContain('Автоматическая помощь ждёт')

    const blind = healthSentence(tRu, { ...failing, state: 'blind' }, { now: NOW, timezone: 'UTC', locale: 'ru' })
    expect(blind).toContain('Сейчас не можем узнать, кто подключался: Remnawave не отвечает с')
    expect(blind).toContain('05:00')
    expect(blind).toContain('Автоматическая помощь приостановлена.')
  })
})

describe('the last-cycle line', () => {
  it('names the channels that sent, and only those', () => {
    expect(lastCycleSentence(tRu, cycle(), { timezone: 'Europe/Moscow', locale: 'ru' })).toBe(
      'Последний проход в 10:40: проверено 12, отправлено 3 (бот 2, push 1), баннер 1, ждут проверки 5.',
    )
  })

  it('drops the brackets when nothing was sent', () => {
    expect(
      lastCycleSentence(tRu, cycle({ sent: { bot: 0, push: 0, email: 0 } }), { timezone: 'UTC', locale: 'ru' }),
    ).toBe('Последний проход в 07:40: проверено 12, отправлено 0, баннер 1, ждут проверки 5.')
  })

  it('adds what else happened', () => {
    const line = lastCycleSentence(tRu, cycle({ deferred: 2, merged: 1 }), { timezone: 'UTC', locale: 'ru' })
    expect(line).toMatch(/ждут проверки 5\. Ещё: бот не ответил, повторим через 10 минут — 2, уже помогли по другой подписке — 1\.$/)
  })

  it('says when the help was off, and when there was no pass at all', () => {
    expect(lastCycleSentence(tRu, cycle({ standDown: 'disabled' }), { timezone: 'UTC', locale: 'ru' })).toBe(
      'Последний проход в 07:40: автоматическая отправка была выключена.',
    )
    expect(lastCycleSentence(tRu, null, { timezone: 'UTC', locale: 'ru' })).toBe('Проходов ещё не было.')
  })

  it('knows a worker that stopped', () => {
    expect(isCycleStale(cycle(), new Date('2026-09-19T08:05:00.000Z'))).toBe(false)
    expect(isCycleStale(cycle(), new Date('2026-09-19T08:11:00.000Z'))).toBe(true)
    expect(isCycleStale(null, NOW)).toBe(false)
  })
})

describe('the log in words', () => {
  it('says every outcome, and «В процессе» for one that has not finished', () => {
    expect(outcomeLabel(tRu, 'banner')).toBe('Баннер в кабинете')
    expect(outcomeLabel(tRu, 'skipped_unverifiable')).toBe('Не удалось проверить')
    expect(outcomeLabel(tRu, null)).toBe('В процессе')
    expect(outcomeLabel(tRu, 'something_new')).toBe('something_new')
  })

  it('says every step', () => {
    expect(attemptLabel(tRu, { channel: 'bot', result: 'unconfirmed', at: '' })).toBe('бот: не смог написать клиенту')
    expect(attemptLabel(tRu, { channel: 'bot', result: 'unavailable', at: '', detail: 'bot_blocked' })).toBe(
      'бот: клиент заблокировал бота',
    )
    expect(attemptLabel(tRu, { channel: 'push', result: 'failed', at: '', detail: '0/2' })).toBe('push: браузер не принял')
    expect(attemptLabel(tRu, { channel: 'email', result: 'unavailable', at: '', detail: 'notify_users_off' })).toBe(
      'почта: письма клиентам выключены',
    )
    expect(attemptLabel(tRu, { channel: 'email', result: 'unavailable', at: '', detail: 'mystery' })).toBe(
      'почта: недоступно',
    )
  })

  it('keeps only well-formed rows and steps', () => {
    const page = readConnectHelpLogPage({
      items: [
        {
          subscriptionId: 'sub-1',
          decidedAt: '2026-09-19T07:40:00.000Z',
          outcome: 'push',
          attempts: [{ channel: 'bot', result: 'failed', at: 'x' }, { channel: 'fax', result: 'sent', at: 'x' }, 'junk'],
          user: { id: 'u-1', name: 'Анна' },
        },
        { decidedAt: 'no id' },
      ],
      nextCursor: 'abc',
      timezone: 'Europe/Moscow',
    })
    expect(page?.items).toHaveLength(1)
    expect(page?.items[0].attempts).toEqual([{ channel: 'bot', result: 'failed', at: 'x' }])
    expect(page?.nextCursor).toBe('abc')
    expect(readConnectHelpLogPage({ items: 'no' })).toBeNull()
  })
})

describe('the status answer', () => {
  it('reads a zone, and UTC when the panel has none', () => {
    expect(readConnectHelpStatus({ timezone: 'Asia/Vladivostok' })?.timezone).toBe('Asia/Vladivostok')
    expect(readConnectHelpStatus({})?.timezone).toBe('UTC')
  })

  it('reads a template it cannot name as missing', () => {
    expect(readConnectHelpStatus({ templates: { connect_help: 'active', connect_help_trial: 'broken' } })?.templates).toEqual({
      connect_help: 'active',
      connect_help_trial: 'missing',
    })
  })

  it('opens the broadcast draft the broadcast page prefills', () => {
    expect(CONNECT_HELP_BROADCAST_PREFILL).toBe('/broadcast?compose=connect-help&bucket=paid&days=7')
  })

  it('falls back to UTC for a zone the browser does not know', () => {
    expect(formatInZone('2026-09-19T07:40:00.000Z', 'Mars/Olympus', 'ru', 'time')).toBe('07:40')
    expect(formatInZone('2026-09-19T07:40:00.000Z', 'Asia/Vladivostok', 'ru', 'time')).toBe('17:40')
  })
})
