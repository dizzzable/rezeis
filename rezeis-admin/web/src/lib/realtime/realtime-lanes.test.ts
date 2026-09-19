/**
 * The lanes a realtime event arrives in, and what a toast calls them.
 *
 * Everything a rule's `system_event` action emits is filed under AUTOMATION —
 * the words are the rule author's, and a toast must not present them as the
 * panel's own «Система». So the SPA subscribes to that lane (the panel drops an
 * event whose lane a screen did not ask for), and every lane has a name of its
 * own in both languages: an unnamed one would reach the toast as its raw code.
 */
import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'

import { REALTIME_TOPICS } from './realtime-types'

describe('the realtime lanes', () => {
  it('include AUTOMATION, where a rule’s own events arrive', () => {
    expect(REALTIME_TOPICS).toContain('AUTOMATION')
  })

  it('each have a name in both languages, and a rule’s lane is never called what the panel’s own is', () => {
    for (const [language, dictionary] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      const names = dictionary.realtime.categories as Readonly<Record<string, string>>
      for (const topic of REALTIME_TOPICS) {
        expect(names[topic], `${language}: ${topic} has no name`).toBeTruthy()
      }
      expect(names['AUTOMATION'], language).not.toBe(names['SYSTEM'])
    }
  })
})
