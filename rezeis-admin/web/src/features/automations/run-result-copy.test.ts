/**
 * Every code the server writes on an action result (contract §2), worded.
 *
 * Rendered through a real i18next over the automations bundles, in both
 * languages: which plural form «из 21 клиента» reaches is i18next's business,
 * and a sentence that reads right only in English is the defect this file
 * exists to stop. Each case asserts the VALUES the sentence names — the hint's
 * key, the customer, the numbers — reach it, because a sentence that dropped
 * them would still be "a translation".
 */
import { createInstance, type TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/features/automations.en'
import { ru } from '@/i18n/features/automations.ru'

import type { AutomationActionResult, ManualRunResult } from './automations-api'
import {
  RESULT_CODES,
  actionResultText,
  executionLogNote,
  executionNoteText,
  resultCodeText,
  runHadNoAnswer,
  runToastText,
  statusText,
} from './run-result-copy'

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
    // Resources are inline; initialise synchronously (i18next 26's name for it).
    initAsync: false,
  })
  return i18n.t.bind(i18n) as TFunction
}

const EN = translator('en')
const RU = translator('ru')

function result(over: Partial<AutomationActionResult>): AutomationActionResult {
  return { index: 0, type: 'show_hint', status: 'success', message: 'english from the server', ...over }
}

/** A sentence the panel wrote itself: no key path, no brace, not the server's English. */
function expectWorded(text: string | null): string {
  expect(text).not.toBeNull()
  expect(text).not.toContain('automationsPage.')
  expect(text).not.toContain('{{')
  expect(text).not.toBe('english from the server')
  return text!
}

describe('show_hint codes', () => {
  it('hint_queued names the hint', () => {
    const entry = result({ code: 'hint_queued', details: { hintKey: 'tpl-welcome', userId: 'u1' } })
    expect(expectWorded(resultCodeText(EN, entry))).toContain('tpl-welcome')
    expect(expectWorded(resultCodeText(RU, entry))).toMatch(/«tpl-welcome».*очередь/)
  })

  it('hint_already_delivered names the hint and says it may not repeat', () => {
    const entry = result({
      status: 'skipped',
      code: 'hint_already_delivered',
      details: { hintKey: 'tpl-welcome', userId: 'u1' },
    })
    expect(expectWorded(resultCodeText(EN, entry))).toMatch(/tpl-welcome.*may not be shown again/)
    expect(expectWorded(resultCodeText(RU, entry))).toMatch(/уже выдавали.*повторно/)
  })

  it('hint_inactive names the hint', () => {
    const entry = result({ status: 'skipped', code: 'hint_inactive', details: { hintKey: 'tpl-x' } })
    expect(expectWorded(resultCodeText(EN, entry))).toMatch(/tpl-x.*switched off/)
    expect(expectWorded(resultCodeText(RU, entry))).toMatch(/«tpl-x» выключена/)
  })

  it('hint_missing names the hint', () => {
    const entry = result({ status: 'failed', code: 'hint_missing', details: { hintKey: 'tpl-gone' } })
    expect(expectWorded(resultCodeText(EN, entry))).toContain('tpl-gone')
    expect(expectWorded(resultCodeText(RU, entry))).toMatch(/«tpl-gone» не существует/)
  })

  it('hint_key_missing says the action names no hint', () => {
    const entry = result({ status: 'failed', code: 'hint_key_missing' })
    expect(expectWorded(resultCodeText(EN, entry))).toMatch(/names no hint/)
    expect(expectWorded(resultCodeText(RU, entry))).toMatch(/не выбрана подсказка/)
  })

  it('customer_missing says there is nobody to show it to', () => {
    const entry = result({ status: 'failed', code: 'customer_missing' })
    expect(expectWorded(resultCodeText(EN, entry))).toMatch(/No customer/)
    expect(expectWorded(resultCodeText(RU, entry))).toMatch(/Не указан клиент/)
  })

  it('customer_not_found names the id', () => {
    const entry = result({ status: 'failed', code: 'customer_not_found', details: { userId: 'cm-404' } })
    expect(expectWorded(resultCodeText(EN, entry))).toContain('cm-404')
    expect(expectWorded(resultCodeText(RU, entry))).toMatch(/cm-404 не найден/)
  })
})

describe('show_hint_to_audience codes', () => {
  it('audience_queued agrees «клиент» with the number matched, and names the audience by its words', () => {
    const at = (matched: number) =>
      resultCodeText(
        RU,
        result({
          type: 'show_hint_to_audience',
          code: 'audience_queued',
          details: { hintKey: 'tpl-n', audience: 'purchase-not-connected', queued: 3, matched, capped: false },
        }),
      )
    expect(at(1)).toContain('для 3 из 1 клиента аудитории «Оплатил и не подключился»')
    expect(at(21)).toContain('из 21 клиента')
    expect(at(2)).toContain('из 2 клиентов')
    expect(at(40)).toContain('из 40 клиентов')
    const english = resultCodeText(
      EN,
      result({
        type: 'show_hint_to_audience',
        code: 'audience_queued',
        details: { hintKey: 'tpl-n', audience: 'purchase-not-connected', queued: 3, matched: 40, capped: false },
      }),
    )
    expect(english).toBe('Hint "tpl-n" queued for 3 of 40 customers in the "Paid and has not connected" audience.')
  })

  it('audience_queued says when the run was capped, and only then', () => {
    const entry = (capped: boolean) =>
      result({
        type: 'show_hint_to_audience',
        code: 'audience_queued',
        details: { hintKey: 'tpl-n', audience: 'paid-not-connected', queued: 500, matched: 500, capped },
      })
    const capNote = String(RU('automationsPage.runResults.audienceCapped'))
    expect(resultCodeText(RU, entry(true))).toContain(capNote)
    expect(resultCodeText(RU, entry(false))).not.toContain(capNote)
  })

  describe('audience_partial — some queued, some threw', () => {
    /** A partly failed audience run, as contract section 2 describes it. */
    const partial = (over = {}) =>
      result({
        type: 'show_hint_to_audience',
        status: 'failed',
        message:
          'queued "tpl-n" for 34 of 40 matched account(s); 3 could not be queued — last error: db said no',
        code: 'audience_partial',
        details: {
          hintKey: 'tpl-n',
          audience: 'trial-not-connected',
          matched: 40,
          queued: 34,
          failed: 3,
          notAttempted: 0,
          stoppedEarly: false,
          stoppedBy: null,
          capped: false,
          ...over,
        },
      })

    it('names the hint, the audience and all four numbers, in the operator’s words', () => {
      const text = expectWorded(resultCodeText(RU, partial()))
      expect(text).toContain('«tpl-n»')
      expect(text).toContain('«Пробный период или подарок — не подключился»')
      expect(text).toContain('34 из 40 подошедших клиентов')
      expect(text).toContain('Ещё 3 клиентам подсказку поставить не удалось')
      expect(expectWorded(resultCodeText(EN, partial()))).toBe(
        'Hint "tpl-n", audience "Trial or gift — has not connected": 34 of 40 matched customers queued.' +
          ' Another 3 customers could not be queued — why is in the panel log.',
      )
    })

    it('says why the run stopped — three failures in a row, or the minute it gets', () => {
      const failures = String(resultCodeText(RU, partial({ stoppedEarly: true, notAttempted: 3, stoppedBy: 'failures' })))
      expect(failures).toContain('после трёх неудач подряд')
      expect(failures).toContain('до 3 клиентов очередь не дошла')

      const time = String(
        resultCodeText(RU, partial({ stoppedEarly: true, notAttempted: 6, stoppedBy: 'time', failed: 0 })),
      )
      expect(time).toContain('на один проход отводится минута')
      expect(time).toContain('до 6 клиентов очередь не дошла')
      // Nothing failed, so nothing is said about failures — least of all "0".
      expect(time).not.toContain('неудач')
      expect(time).not.toContain('поставить не удалось')
      expect(time).not.toContain(' 0 ')

      // A row written before the server said why keeps a truthful, vaguer note.
      const old = String(resultCodeText(RU, partial({ stoppedEarly: true, notAttempted: 3, stoppedBy: undefined })))
      expect(old).toContain('не дойдя до конца')
      expect(old).not.toContain('трёх неудач')

      expect(resultCodeText(RU, partial())).not.toContain('остановился')
    })

    it('adds the cap note only when the run was capped', () => {
      const capNote = String(RU('automationsPage.runResults.audienceCapped'))
      expect(resultCodeText(RU, partial({ capped: true }))).toContain(capNote)
      expect(resultCodeText(RU, partial())).not.toContain(capNote)
    })

    it('keeps the English joined line out of the run log, now that the code is known', () => {
      // The log prints its own line only while a failed action has no code the
      // panel words — which is what an unknown audience_partial did.
      expect(
        executionLogNote(RU, {
          errorMessage: '[show_hint_to_audience] queued "tpl-n" for 34 of 40 matched account(s); 3 could not be queued',
          actionResults: [partial()],
        }),
      ).toBeNull()
    })

    it('is what the toast says after an immediate run', () => {
      const text = runToastText(RU, {
        executionId: 'e1',
        status: 'FAILED',
        actionResults: [partial()],
        errorMessage: '[show_hint_to_audience] queued "tpl-n" for 34 of 40 matched account(s)',
      })
      expect(text).toContain('ОШИБКА')
      expect(text).toContain('34 из 40 подошедших клиентов')
      expect(text).not.toContain('account(s)')
      expect(text).not.toContain('could not be queued')
    })
  })

  it('audience_empty names the audience — the old «все» one by what it now honestly is', () => {
    const entry = result({ type: 'show_hint_to_audience', code: 'audience_empty', details: { audience: 'paid-not-connected' } })
    expect(expectWorded(resultCodeText(RU, entry))).toContain(
      '«Не подключился: все (оплаченные, пробные и подарки) — устаревшее»',
    )
    expect(expectWorded(resultCodeText(EN, entry))).toContain('Not connected: everyone (paid, trials and gifts) — legacy')
  })

  it('audience_blind carries the reason the server gave, when it names no cause', () => {
    // A row written before causes, or by a panel with a cause this one lacks.
    const rows: ReadonlyArray<Record<string, string>> = [
      { reason: 'no first-traffic timestamps' },
      { reason: 'no first-traffic timestamps', cause: 'tomorrow' },
    ]
    for (const details of rows) {
      const entry = result({ type: 'show_hint_to_audience', code: 'audience_blind', details })
      expect(expectWorded(resultCodeText(RU, entry))).toContain('no first-traffic timestamps')
      expect(expectWorded(resultCodeText(EN, entry))).toContain('no first-traffic timestamps')
    }
  })

  describe('audience_blind with a cause — the sentence is the panel’s, not the server’s', () => {
    const ENGLISH_REASON = 'the panel cannot tell right now who has connected'

    it('a blind signal says what to check, in Russian', () => {
      const entry = result({
        type: 'show_hint_to_audience',
        code: 'audience_blind',
        details: { reason: ENGLISH_REASON, cause: 'signal_blind' },
      })
      const text = expectWorded(resultCodeText(RU, entry))
      expect(text).toContain('не может понять, кто подключился')
      expect(text).toContain('Remnawave')
      expect(text).not.toContain(ENGLISH_REASON)
      expect(expectWorded(resultCodeText(EN, entry))).toContain('cannot tell right now who has connected')
    })

    it('is true of BOTH states the audience stands down in — webhooks arriving or not', () => {
      // `signal_blind` is written for `webhooks_only` as well as `blind`
      // (`hint-audience.service.ts`), and the entry carries no state. A sentence
      // that says no webhook arrived would be false in the first of them.
      const entry = result({
        type: 'show_hint_to_audience',
        code: 'audience_blind',
        details: { reason: ENGLISH_REASON, cause: 'signal_blind' },
      })
      const ru = expectWorded(resultCodeText(RU, entry))
      expect(ru).toContain('одних вебхуков для этого мало')
      expect(ru).not.toMatch(/не пришло ни одного вебхука/)
      const en = expectWorded(resultCodeText(EN, entry))
      expect(en).toContain('webhooks alone are not enough')
      expect(en).not.toMatch(/no user webhook has arrived/)
    })

    it('too many people names the audience and the ceiling, and points at a broadcast', () => {
      const entry = result({
        type: 'show_hint_to_audience',
        status: 'failed',
        code: 'audience_blind',
        details: { audience: 'purchase-not-connected', cause: 'too_large', reason: 'more than 20000', limit: 20000 },
      })
      const text = expectWorded(resultCodeText(RU, entry))
      expect(text).toContain('«Оплатил и не подключился»')
      expect(text).toContain('больше 20000 клиентов')
      expect(text).toContain('«Подключение VPN»')
      expect(expectWorded(resultCodeText(EN, entry))).toContain('more than 20000 customers in the "Paid and has not connected" audience')
    })

    it('a timeout names the audience and says the next run tries again', () => {
      const entry = result({
        type: 'show_hint_to_audience',
        status: 'failed',
        code: 'audience_blind',
        details: { audience: 'trial-not-connected', cause: 'timeout', reason: 'took longer than 10s', limit: null },
      })
      const text = expectWorded(resultCodeText(RU, entry))
      expect(text).toContain('«Пробный период или подарок — не подключился»')
      expect(text).toContain('при следующем запуске')
      expect(expectWorded(resultCodeText(EN, entry))).toContain('tries again on its next run')
    })
  })

  it('words every code the contract lists, in both languages', () => {
    // The table above, walked whole: a code added to `RESULT_CODES` without a
    // sentence in either bundle lands here as a key path.
    for (const code of RESULT_CODES) {
      for (const t of [EN, RU]) {
        const text = resultCodeText(
          t,
          result({ code, details: { hintKey: 'k', userId: 'u', audience: 'a', queued: 1, matched: 2, capped: false, reason: 'r' } }),
        )
        expectWorded(text)
      }
    }
  })
})

describe('without a code the panel knows', () => {
  it('falls back to the server message for a row written before codes', () => {
    expect(actionResultText(RU, result({ message: 'queued hint "x" for u1' }))).toBe('queued hint "x" for u1')
  })

  it('falls back to the server message for a code it has no sentence for', () => {
    expect(resultCodeText(RU, result({ code: 'brand_new_code' }))).toBeNull()
    expect(actionResultText(RU, result({ code: 'brand_new_code', message: 'as written' }))).toBe('as written')
  })

  it('says nothing when there is neither', () => {
    expect(actionResultText(RU, result({ message: undefined }))).toBeNull()
    expect(actionResultText(RU, result({ message: '   ' }))).toBeNull()
  })

  it('prefers the code to the message when both are there', () => {
    const text = actionResultText(RU, result({ code: 'hint_inactive', details: { hintKey: 'k' } }))
    expect(text).toBe(String(RU('automationsPage.runResults.hint_inactive', { hintKey: 'k' })))
  })
})

describe('a run that reached no action', () => {
  it('words the two reasons the executor writes', () => {
    expect(executionNoteText(RU, 'conditions did not match')).toBe(
      String(RU('automationsPage.runResults.conditionsNotMatched')),
    )
    expect(executionNoteText(RU, 'rule disabled')).toBe(String(RU('automationsPage.runResults.ruleDisabled')))
  })

  it('shows any other reason as written, and nothing for none', () => {
    expect(executionNoteText(RU, 'rule deleted before pickup')).toBe('rule deleted before pickup')
    expect(executionNoteText(RU, null)).toBeNull()
  })
})

describe('the line a run log row prints above its actions', () => {
  it('words the executor’s reasons for reaching no action', () => {
    expect(executionLogNote(RU, { errorMessage: 'conditions did not match', actionResults: [] })).toBe(
      String(RU('automationsPage.runResults.conditionsNotMatched')),
    )
  })

  it('does not repeat in English what the worded lines below already say', () => {
    const joined = '[show_hint] show_hint: hint "tpl-gone" does not exist'
    expect(
      executionLogNote(RU, {
        errorMessage: joined,
        actionResults: [
          result({ status: 'success', code: 'hint_queued', details: { hintKey: 'a' } }),
          result({ index: 1, status: 'failed', code: 'hint_missing', details: { hintKey: 'tpl-gone' } }),
        ],
      }),
    ).toBeNull()
  })

  it('keeps the joined line while a failed action has no code the panel words', () => {
    const joined = '[show_hint] hint missing; [webhook_post] 500 from https://example.com'
    const note = executionLogNote(RU, {
      errorMessage: joined,
      actionResults: [
        result({ status: 'failed', code: 'hint_missing', details: { hintKey: 'x' } }),
        result({ index: 1, type: 'webhook_post', status: 'failed', message: '500 from https://example.com' }),
      ],
    })
    expect(note).toBe(joined)
  })
})

describe('a manual run that went unanswered', () => {
  const axiosError = (over: Record<string, unknown>) => ({ isAxiosError: true, message: 'x', ...over })

  it('is a timeout, a proxy timeout, or no answer at all', () => {
    expect(runHadNoAnswer(axiosError({ code: 'ECONNABORTED' }))).toBe(true)
    expect(runHadNoAnswer(axiosError({ code: 'ERR_NETWORK' }))).toBe(true)
    expect(runHadNoAnswer(axiosError({ response: { status: 408, data: {} } }))).toBe(true)
    expect(runHadNoAnswer(axiosError({ response: { status: 504, data: {} } }))).toBe(true)
  })

  it('is not a refusal the panel answered, nor an error that is not a request', () => {
    expect(runHadNoAnswer(axiosError({ response: { status: 400, data: { message: 'x' } } }))).toBe(false)
    expect(runHadNoAnswer(axiosError({ response: { status: 403, data: {} } }))).toBe(false)
    expect(runHadNoAnswer(axiosError({ response: { status: 500, data: {} } }))).toBe(false)
    expect(runHadNoAnswer(new Error('boom'))).toBe(false)
    expect(runHadNoAnswer(null)).toBe(false)
  })
})

describe('the toast after an immediate run', () => {
  function answer(over: Partial<ManualRunResult>): ManualRunResult {
    return { executionId: 'e1', status: 'SUCCEEDED', actionResults: [], errorMessage: null, ...over }
  }

  it('translates the status', () => {
    expect(statusText(RU, 'SUCCEEDED')).toBe('УСПЕШНО')
    expect(runToastText(RU, answer({}))).toBe('Запуск завершён: УСПЕШНО')
  })

  it('names the first failed action over an earlier skipped one', () => {
    const text = runToastText(
      RU,
      answer({
        status: 'FAILED',
        actionResults: [
          result({ index: 0, type: 'show_hint', status: 'skipped', code: 'hint_inactive', details: { hintKey: 'a' } }),
          result({ index: 1, type: 'show_hint', status: 'failed', code: 'hint_missing', details: { hintKey: 'b' } }),
        ],
      }),
    )
    expect(text).toBe(
      String(
        RU('automationsPage.toast.runFinishedAction', {
          status: 'ОШИБКА',
          action: 'Показать подсказку в кабинете',
          note: RU('automationsPage.runResults.hint_missing', { hintKey: 'b' }),
        }),
      ),
    )
  })

  it('names a skipped action when nothing failed', () => {
    const text = runToastText(
      RU,
      answer({
        status: 'SKIPPED',
        actionResults: [result({ status: 'skipped', code: 'hint_inactive', details: { hintKey: 'a' } })],
      }),
    )
    expect(text).toContain('ПРОПУЩЕНО')
    expect(text).toContain(String(RU('automationsPage.runResults.hint_inactive', { hintKey: 'a' })))
  })

  it('says why a run reached no action', () => {
    expect(runToastText(RU, answer({ status: 'SKIPPED', errorMessage: 'conditions did not match' }))).toBe(
      `Запуск завершён: ПРОПУЩЕНО. ${String(RU('automationsPage.runResults.conditionsNotMatched'))}`,
    )
  })
})
