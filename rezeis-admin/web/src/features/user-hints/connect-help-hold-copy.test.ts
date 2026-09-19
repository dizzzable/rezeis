/**
 * «Не получилось подключиться?» is HELD, not only lapsed — and the copy says so.
 *
 * The server shows a pop-up of the `connect-help` group only on a read of the
 * customer's subscription at most `CONNECT_HELP_SHOW_MAX_CHECK_AGE_MS` old
 * that found the VPN never connected; on an older read (or none) it waits,
 * unshown and unclosed, while the next hint goes ahead. The template's (i) and
 * the group field's (i) promise the operator exactly that, with the number the
 * server uses — read out of the service here rather than restated, so the day
 * the number changes this fails instead of the copy quietly lying.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createInstance, type i18n as I18nInstance } from 'i18next'
import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/features/automations.en'
import { ru } from '@/i18n/features/automations.ru'

function instance(lng: 'en' | 'ru'): I18nInstance {
  const i18n = createInstance()
  void i18n.init({
    lng,
    fallbackLng: 'en',
    resources: {
      en: { translation: en as unknown as Record<string, unknown> },
      ru: { translation: ru as unknown as Record<string, unknown> },
    },
    interpolation: { escapeValue: false },
  })
  return i18n
}

const RU = instance('ru')
const EN = instance('en')

const DELIVERY = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'src',
    'modules',
    'user-hints',
    'services',
    'user-hint-delivery.service.ts',
  ),
  'utf8',
)

/** Minutes, from `export const CONNECT_HELP_SHOW_MAX_CHECK_AGE_MS = N * 60 * 1000;`. */
const MINUTES = Number(/export const CONNECT_HELP_SHOW_MAX_CHECK_AGE_MS = (\d+) \* 60 \* 1000;/.exec(DELIVERY)?.[1] ?? NaN)

describe('the connect-help hold, as the operator reads it', () => {
  it('is read from a delivery service that still holds', () => {
    // Anti-vacuous anchor: the cases below state the copy BECAUSE the server
    // does this. If the rule is renamed away, decide which way the copy goes.
    expect(MINUTES, 'CONNECT_HELP_SHOW_MAX_CHECK_AGE_MS was not found in the delivery service').toBe(15)
    expect(DELIVERY).toMatch(/connectHelp === 'hold' \? OUTSIDE_CONNECT_HELP_FAMILY/)
  })

  it('the template’s (i) says the window waits for a fresh check, and how fresh', () => {
    const ruInfo = RU.t('automationsPage.hintTemplates.connect_help.info')
    expect(ruInfo).toContain(`не старше ${MINUTES} минут`)
    expect(ruInfo).toMatch(/окно ждёт/)
    const enInfo = EN.t('automationsPage.hintTemplates.connect_help.info')
    expect(enInfo).toContain(`no older than ${MINUTES} minutes`)
    expect(enInfo).toMatch(/the window waits/)
  })

  it('the group field’s (i) says the same of the group and its sub-groups', () => {
    const ruHint = RU.t('userHints.fields.groupKeyHint')
    expect(ruHint).toContain(`не старше ${MINUTES} минут`)
    expect(ruHint).toMatch(/ждёт, пропуская вперёд другие подсказки/)
    const enHint = EN.t('userHints.fields.groupKeyHint')
    expect(enHint).toContain(`no older than ${MINUTES} minutes`)
    expect(enHint).toMatch(/while other hints go ahead of it/)
  })

  it('keeps the template’s own promise about a customer who connected', () => {
    expect(RU.t('automationsPage.hintTemplates.connect_help.description')).toContain(
      'Если клиент успел подключиться, окно уже не появится.',
    )
    expect(EN.t('automationsPage.hintTemplates.connect_help.description')).toContain(
      'If the customer has connected by then, the window does not appear.',
    )
  })
})
