/**
 * The two sentences under the event-pattern field, at every count they can hold.
 *
 * Both are built from numbers the panel does not control. `count` is how many
 * times the event was seen — one is the interesting case, because a trigger
 * that fired exactly once is the one an operator squints at. `windowDays` is
 * `AUDIT_RETENTION_DAYS`, which the operator sets, and `Math.max(1, ...)` means
 * 1 is a value it really takes.
 *
 * They read as prose, so they were written as prose: one string with three
 * `{{...}}` holes and no plural forms at all. The panel then told a Russian
 * operator «Происходило 1 раз за 1 дней» and an English one "Happened 1 times
 * in 1 days". i18next pluralises on ONE variable per key, so the fix is three
 * keys — and the thing that has to be checked is not that the keys exist but
 * that the finished sentence agrees, in both languages, at each CLDR category
 * Russian has and English does not.
 *
 * Rendered through a real i18next instance rather than read out of the source:
 * whether `_few` is reached at 22 is i18next's business, not ours.
 */
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/features/automations.en'
import { ru } from '@/i18n/features/automations.ru'

function build(lng: 'en' | 'ru'): I18nInstance {
  const instance = createInstance()
  void instance.init({
    lng,
    fallbackLng: 'en',
    resources: { en: { translation: en }, ru: { translation: ru } },
    interpolation: { escapeValue: false },
  })
  return instance
}

const EN = build('en')
const RU = build('ru')

/** Exactly what `trigger-catalog-hint.tsx` composes, for one pair of numbers. */
function fired(i18n: I18nInstance, count: number, windowDays: number, matched: number): string {
  return i18n.t('automationsPage.config.triggerFired', {
    count,
    window: i18n.t('automationsPage.config.triggerWindowDays', { count: windowDays }),
    matched: i18n.t('automationsPage.config.triggerMatchedTypes', { count: matched }),
  })
}

function neverFired(i18n: I18nInstance, windowDays: number): string {
  // COUNT, not a pre-rendered window. Russian agrees the adjective with the
  // number as well as the noun, so this sentence has to pluralise as a whole.
  return i18n.t('automationsPage.config.triggerNeverFired', { count: windowDays })
}

describe('the day count under the event pattern', () => {
  it('says "1 day", not "1 days"', () => {
    expect(EN.t('automationsPage.config.triggerWindowDays', { count: 1 })).toBe('1 day')
    expect(EN.t('automationsPage.config.triggerWindowDays', { count: 90 })).toBe('90 days')
  })

  it('walks the whole Russian ladder', () => {
    const say = (count: number): string =>
      RU.t('automationsPage.config.triggerWindowDays', { count })

    expect(say(1)).toBe('1 день')
    expect(say(2)).toBe('2 дня')
    expect(say(5)).toBe('5 дней')
    expect(say(11)).toBe('11 дней')
    expect(say(21)).toBe('21 день')
    expect(say(22)).toBe('22 дня')
    expect(say(90)).toBe('90 дней')
  })
})

describe('the sentence for a trigger that has never fired', () => {
  it('reaches the singular when the operator keeps one day of audit', () => {
    // AUDIT_RETENTION_DAYS=1 is a real setting and this is the sentence it
    // produced: "in the last 1 days".
    expect(neverFired(EN, 1)).toContain('in the last 1 day.')
    // «За последние 1 день» was what this case ASSERTED, and it is wrong: the
    // adjective agrees with the number too. Pinning the broken form is worse
    // than not pinning it — the guard then certifies the defect and the next
    // person reads the case as the specification.
    expect(neverFired(RU, 1)).toContain('За последний 1 день ')
  })

  it('agrees the adjective as well as the noun, all the way up', () => {
    // The whole ladder for this sentence, because the adjective and the noun
    // change on different counts and only one of them was ever checked.
    expect(neverFired(RU, 2)).toContain('За последние 2 дня ')
    expect(neverFired(RU, 5)).toContain('За последние 5 дней ')
    expect(neverFired(RU, 11)).toContain('За последние 11 дней ')
    expect(neverFired(RU, 21)).toContain('За последний 21 день ')
    expect(neverFired(RU, 22)).toContain('За последние 22 дня ')
  })

  it('still reads right at the default window', () => {
    expect(neverFired(EN, 90)).toContain('in the last 90 days.')
    expect(neverFired(RU, 90)).toContain('За последние 90 дней ')
  })
})

describe('the sentence for a trigger that has fired', () => {
  it('says a single occurrence once', () => {
    expect(fired(EN, 1, 1, 1)).toBe('Happened 1 time in 1 day (1 event type matched)')
    expect(fired(RU, 1, 1, 1)).toBe('Произошло 1 раз за 1 день (совпал 1 тип события)')
  })

  it('agrees on every count Russian distinguishes', () => {
    expect(fired(RU, 2, 2, 2)).toBe('Происходило 2 раза за 2 дня (совпало 2 типа события)')
    expect(fired(RU, 5, 5, 5)).toBe('Происходило 5 раз за 5 дней (совпало 5 типов события)')
    expect(fired(RU, 21, 21, 21)).toBe(
      'Произошло 21 раз за 21 день (совпал 21 тип события)',
    )
  })

  it('agrees in English too', () => {
    expect(fired(EN, 12, 90, 3)).toBe('Happened 12 times in 90 days (3 event types matched)')
  })

  it('never leaves a brace on screen', () => {
    // A key renamed on one side of the pair renders the raw path; a
    // placeholder renamed renders the braces. Both look like a crash to the
    // operator and neither fails any assertion above about a DIFFERENT count.
    for (const i18n of [EN, RU]) {
      for (const count of [0, 1, 2, 5, 21, 100]) {
        const sentence = fired(i18n, count, count, count)
        expect(sentence).not.toContain('{{')
        expect(sentence).not.toContain('automationsPage.')
        expect(neverFired(i18n, count)).not.toContain('{{')
      }
    }
  })
})

describe('the counts across the top of the map', () => {
  // Every one of these is drawn unconditionally except `broken`, which is
  // hidden at zero. So ZERO is the first thing a new operator sees, on a
  // panel where nothing has been built yet — and Russian sends 0 to the
  // `_many` form, which had been written for 5 and 11.
  const badge = (i18n: I18nInstance, name: string, count: number): string =>
    i18n.t(`automationsPage.triggerMap.counts.${name}`, { count })

  // `unused` is NOT walked here any more. Its noun is decided by the mode of
  // the templates it counts — nine of the twenty-one are a line, not a window —
  // so its ladder belongs beside the check that reads those modes out of
  // `HINT_TEMPLATES`, and it lives in
  // `i18n/features/automations-copy-truth.test.ts` under I10, over a wider
  // ladder than this file walked (0, 1, 2, 5, 11, 21, 22, 100). A second copy
  // here would pin the wording twice and go red twice for one correction,
  // which is exactly what happened to it.

  it('reads as Russian on a panel with nothing on it', () => {
    expect(badge(RU, 'live', 0)).toBe('0 работает')
    expect(badge(RU, 'paused', 0)).toBe('0 выключено')
  })

  it('still reads as Russian once there is something to count', () => {
    // The other end: a form that agrees at 0 must not disagree at 1 or 2.
    expect(badge(RU, 'live', 1)).toBe('1 работает')
    expect(badge(RU, 'live', 2)).toBe('2 работают')
    expect(badge(RU, 'live', 5)).toBe('5 работает')
  })

  it('never leaves a brace or a key path on a badge', () => {
    for (const i18n of [EN, RU]) {
      for (const name of ['live', 'paused', 'broken', 'unused']) {
        for (const count of [0, 1, 2, 5, 11, 21, 100]) {
          const text = badge(i18n, name, count)
          expect(text).not.toContain('{{')
          expect(text).not.toContain('automationsPage.')
        }
      }
    }
  })
})
