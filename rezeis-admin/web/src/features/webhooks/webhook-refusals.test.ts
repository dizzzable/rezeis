/**
 * Where the panel does not send a webhook, as the webhooks page words it.
 *
 * The server refuses a subscription URL that points at the machine itself or
 * at a cloud metadata service, at save and at send, in English and with no
 * code. These are recognised by shape; everything else — every other delivery
 * error, every other refusal — must read exactly as before. The last block
 * holds this page's copy of the server's range nouns to the server's table.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createInstance, type TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'
import { getErrorMessage } from '@/lib/http-errors'

import { deliveryErrorText, subscriptionErrorText } from './webhook-refusals'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `web/src/features/webhooks` → the repository root beside `src/`. */
const REPO = resolve(HERE, '..', '..', '..', '..')

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

function refused(message: string): unknown {
  return {
    isAxiosError: true,
    message: 'Request failed with status code 400',
    response: { status: 400, data: { statusCode: 400, message } },
  }
}

describe('a delivery the panel refused to send', () => {
  it('says why, in the operator’s language, with the range', () => {
    expect(deliveryErrorText(RU, 'Refused before sending: the URL points at a loopback address (127.0.0.0/8)')).toBe(
      'Не отправлено: URL указывает на адрес loopback (127.0.0.0/8).',
    )
    expect(deliveryErrorText(RU, 'Refused before sending: the URL names a cloud metadata service')).toBe(
      'Не отправлено: URL указывает на сервис метаданных облака.',
    )
    expect(deliveryErrorText(EN, 'Refused before sending: the URL names this machine itself (localhost)')).toBe(
      'Not sent: the URL names this machine itself (localhost).',
    )
  })

  it('names the host and the address it resolved to', () => {
    expect(
      deliveryErrorText(RU, 'Refused before sending: rebind.example.test resolves to a loopback address (127.0.0.0/8): 127.0.0.1'),
    ).toBe('Не отправлено: rebind.example.test указывает на адрес loopback (127.0.0.1), а туда панель вебхуки не отправляет.')
  })

  it('leaves every other delivery error in the server’s words', () => {
    for (const message of ['timeout of 10000ms exceeded', 'connect ECONNREFUSED 10.0.0.5:8080', 'Subscription is disabled']) {
      expect(deliveryErrorText(RU, message)).toBe(message)
    }
    // A shape this page does not know stays as the server wrote it, too.
    expect(deliveryErrorText(RU, 'Refused before sending: something new')).toBe('Refused before sending: something new')
  })
})

describe('a subscription URL the panel refused to save', () => {
  it('says why, in the operator’s language', () => {
    expect(
      subscriptionErrorText(
        RU,
        refused('The panel does not send webhooks there: the URL points at a cloud metadata address (100.100.100.200/32)'),
        'fallback',
      ),
    ).toBe('Панель не отправляет вебхуки на этот адрес: URL указывает на адрес сервиса метаданных облака (100.100.100.200/32).')
  })

  it('leaves every other refusal as the page showed it before', () => {
    expect(subscriptionErrorText(RU, refused('URL must use http:// or https://'), 'fallback')).toBe(
      'URL must use http:// or https://',
    )
    const unanswered = { isAxiosError: true, message: 'Network Error' }
    expect(subscriptionErrorText(RU, unanswered, 'fallback')).toBe(getErrorMessage(unanswered, 'fallback'))
    expect(subscriptionErrorText(RU, null, 'fallback')).toBe('fallback')
  })
})

describe('this page’s copy of the server’s range nouns', () => {
  it('is the server’s own table, noun for noun', () => {
    const source = readFileSync(resolve(REPO, 'src', 'common', 'net', 'outbound-url.ts'), 'utf8')
    const start = source.indexOf('const RANGE_NOUNS')
    expect(start, 'RANGE_NOUNS is gone from common/net/outbound-url.ts — this parse needs rewriting').toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('};', start))
    const server = [...body.matchAll(/^\s{2}([a-z_0-9]+): '([^']+)',\r?$/gm)]
      .filter((match) => match[1] !== 'unparseable')
      .map((match) => [match[2], match[1]] as const)
    expect(server.length, 'no noun parsed out of RANGE_NOUNS').toBeGreaterThanOrEqual(6)

    for (const [noun, kind] of server) {
      // Each noun, inside the server's own sentence, must land on the word for
      // the kind the server meant.
      expect(deliveryErrorText(EN, `Refused before sending: the URL points at ${noun} (192.0.2.0/24)`), kind).toBe(
        `Not sent: the URL points at ${String(EN(`errors.webhookRange_${kind}`))} (192.0.2.0/24).`,
      )
    }
  })
})
