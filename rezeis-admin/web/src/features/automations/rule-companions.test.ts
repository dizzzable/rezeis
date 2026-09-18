import { describe, expect, it } from 'vitest'

import type { UpsertRulePayload } from './automations-api'
import { companionPayload, companionsInForce, type DraftCompanion } from './rule-companions'

/**
 * Which companion rules «Создать» still saves for the draft as it stands, and
 * what each is saved with.
 */

const SITE: DraftCompanion = { triggerSpec: 'user.web_registered', name: 'Первое появление — на сайте' }

describe('companionsInForce', () => {
  it('keeps a companion on another event while the draft fires on an event', () => {
    expect(companionsInForce({ triggerKind: 'REALTIME', triggerSpec: 'user.registered' }, [SITE])).toEqual([SITE])
  })

  it('drops every companion once the draft runs on a schedule or by hand', () => {
    expect(companionsInForce({ triggerKind: 'CRON', triggerSpec: '0 9 * * *' }, [SITE])).toEqual([])
    expect(companionsInForce({ triggerKind: 'MANUAL', triggerSpec: '' }, [SITE])).toEqual([])
  })

  it('drops a companion on the draft’s own event, spaces or not', () => {
    expect(companionsInForce({ triggerKind: 'REALTIME', triggerSpec: ' user.web_registered ' }, [SITE])).toEqual([])
  })
})

describe('companionPayload', () => {
  it('is the draft’s payload under the companion’s name and event', () => {
    const payload: UpsertRulePayload = {
      name: 'Первое появление — через Telegram',
      description: 'Для обоих',
      isEnabled: false,
      triggerKind: 'REALTIME',
      triggerSpec: 'user.registered',
      conditions: { '==': ['$source', 'bot'] },
      actions: [{ type: 'show_hint', params: { hintKey: 'tpl-welcome' } }],
    }
    expect(companionPayload(payload, SITE)).toEqual({
      ...payload,
      name: SITE.name,
      triggerSpec: SITE.triggerSpec,
    })
  })
})
