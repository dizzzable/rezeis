/**
 * What `block_ip` and `webhook_post` say when they decline to act.
 *
 * Both now refuse on purpose — a block that would lock the panel out of
 * itself, a request aimed at the machine itself or a cloud metadata service —
 * and the refusal arrives as
 * a coded action result, worded here from its details. Each case asserts the
 * VALUES reach the sentence (the address, the host, the range) and that the
 * variant the details name is the one chosen; a value this bundle has no word
 * for must still land on a sentence, never on a key path.
 */
import { createInstance, type TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/features/automations.en'
import { ru } from '@/i18n/features/automations.ru'

import type { AutomationActionResult } from './automations-api'
import { executionNoteText, resultCodeText } from './run-result-copy'

function translator(lng: 'en' | 'ru'): TFunction {
  const i18n = createInstance()
  void i18n.init({
    lng,
    fallbackLng: 'en',
    resources: {
      en: { translation: en as unknown as Record<string, unknown> },
      ru: { translation: ru as unknown as Record<string, unknown> },
    },
    interpolation: { escapeValue: false },
    initAsync: false,
  })
  return i18n.t.bind(i18n) as TFunction
}

const EN = translator('en')
const RU = translator('ru')

function worded(t: TFunction, code: string, details: AutomationActionResult['details']): string {
  const text = resultCodeText(t, { index: 0, type: 'block_ip', status: 'failed', message: 'english', code, details })
  expect(text).not.toBeNull()
  expect(text).not.toContain('automationsPage.')
  expect(text).not.toContain('{{')
  expect(text).not.toBe('english')
  return text!
}

describe('a block that was refused', () => {
  it('names the address and what it would have locked out', () => {
    expect(worded(RU, 'block_address_protected', { address: '203.0.113.60', protection: 'admin_session' })).toBe(
      '203.0.113.60 не заблокирован: он охватывает адрес, с которого администратор входил или работал за последние 24 часа.',
    )
    expect(
      worded(EN, 'block_address_protected', { address: '10.1.2.3', protection: 'internal_network', range: '10.0.0.0/8' }),
    ).toBe(
      "10.1.2.3 was not blocked: it covers the panel's internal network (10.0.0.0/8): the panel itself, its reverse proxy and the services beside it connect from there.",
    )
  })

  it('still says something for a protection this bundle has no word for', () => {
    expect(worded(RU, 'block_address_protected', { address: '203.0.113.9', protection: 'from_the_future' })).toBe(
      '203.0.113.9 не заблокирован: он охватывает адрес, который панель не должна блокировать.',
    )
  })

  it('tells an address in the rule from one in the run data', () => {
    const rule = worded(RU, 'block_address_invalid', { source: 'rule' })
    const trigger = worded(RU, 'block_address_invalid', { source: 'trigger' })
    expect(rule).toMatch(/в самом действии/)
    expect(trigger).toMatch(/в данных запуска/)
    expect(rule).not.toBe(trigger)
  })

  it('says a block that could not be checked was not made', () => {
    expect(worded(EN, 'block_address_unverified', { address: '203.0.113.99' })).toMatch(/^203\.0\.113\.99 was not blocked/)
    // Where the address was expected to come from, and what to do instead:
    // no event carries one.
    expect(worded(RU, 'block_address_missing', {})).toBe(
      'Ничего не заблокировано: в действии нет адреса, и запуск его не передал. События адресов не содержат — впишите адрес в действие.',
    )
  })
})

describe('a webhook that was not sent', () => {
  it('says why the URL was refused, in words, with the range', () => {
    expect(worded(RU, 'webhook_url_refused', { reason: 'internal_address', range: '169.254.0.0/16', kind: 'link_local' })).toBe(
      'Ничего не отправлено: URL указывает на link-local адрес, где отвечают сервисы метаданных облака (169.254.0.0/16).',
    )
    expect(worded(EN, 'webhook_url_refused', { reason: 'local_name' })).toBe(
      'Nothing was sent: the URL names this machine itself (localhost).',
    )
    expect(worded(RU, 'webhook_url_refused', { reason: 'metadata_name' })).toBe(
      'Ничего не отправлено: URL указывает на сервис метаданных облака.',
    )
    expect(
      worded(EN, 'webhook_url_refused', { reason: 'internal_address', range: 'fd00:ec2::254/128', kind: 'cloud_metadata' }),
    ).toBe('Nothing was sent: the URL points at a cloud metadata address (fd00:ec2::254/128).')
    expect(worded(EN, 'webhook_url_refused', { reason: 'too_long' })).toBe(
      'Nothing was sent: the URL is longer than 2048 characters.',
    )
    expect(worded(EN, 'webhook_url_refused', { reason: 'something_new' })).toBe('Nothing was sent: the URL was refused.')
  })

  it('names the host and the address it resolved to', () => {
    expect(
      worded(RU, 'webhook_address_refused', { host: 'rebind.example.test', address: '127.0.0.1', range: '127.0.0.0/8', kind: 'loopback' }),
    ).toBe('Ничего не отправлено: rebind.example.test указывает на адрес loopback (127.0.0.1), а туда панель запросы не отправляет.')
  })
})

describe('a rule whose actions are not a list', () => {
  it('is worded from the executor’s own sentence', () => {
    expect(executionNoteText(RU, "the rule's actions are not a list, so none of them ran")).toBe(
      'Ничего не выполнено: действия правила — не список. Откройте правило, заново добавьте действия и сохраните — или удалите его.',
    )
  })
})
