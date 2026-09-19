import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/features/automations.en'
import { ru } from '@/i18n/features/automations.ru'

import {
  POPUP_CAPABLE_EVENTS,
  canCarryPopup as serverCanCarryPopup,
} from '../../../../src/modules/automations/popup-capable-events'
import { matchEventPattern as serverMatchEventPattern } from '../../../../src/modules/automations/event-pattern'

import type { AutomationRule } from './automations-api'
import { planArrival } from './hint-templates'
import {
  EVENT_HOME_SURFACES,
  HINT_AUDIENCE_NAMES,
  LEGACY_HINT_AUDIENCE,
  OFFERED_HINT_AUDIENCES,
  POPUP_CAPABLE_EVENT_TYPES,
  audiencePickerItems,
  canCarryPopup,
  isKnownAudience,
  isWildcardPattern,
  matchEventPattern,
  popupEventName,
  popupEventNameKey,
  surfaceGap,
  usesOfHint,
} from './popup-audience'

function rule(overrides: Partial<AutomationRule>): AutomationRule {
  return {
    id: 'rule-1',
    name: 'Первое появление',
    description: null,
    isEnabled: true,
    triggerKind: 'REALTIME',
    triggerSpec: 'user.registered',
    conditions: null,
    actions: [{ type: 'show_hint', params: { hintKey: 'tpl-welcome' } }],
    createdById: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunMessage: null,
    runCount: 0,
    createdAt: '2026-09-15T10:00:00.000Z',
    updatedAt: '2026-09-15T10:00:00.000Z',
    ...overrides,
  }
}

function translatorFor(bundle: unknown) {
  const i18n = createInstance()
  void i18n.init({
    lng: 'x',
    resources: { x: { translation: bundle as Record<string, unknown> } },
    // i18next 26 calls this `initAsync`; `initImmediate` is not in its types,
    // and `npm run typecheck:test` refused the whole file over it.
    initAsync: false,
  })
  return i18n.t.bind(i18n)
}

describe('surfaceGap — the case that was reported', () => {
  it('flags a Telegram sign-up welcome that may only appear in the browser', () => {
    // The owner's exact setup: «Первое появление» on `user.registered`, and
    // «Браузер» ticked. The people that rule greets are inside Telegram.
    expect(surfaceGap('user.registered', ['browser'])).toEqual(['tma'])
  })

  it('flags a site sign-up welcome that may only appear inside Telegram', () => {
    expect(surfaceGap('user.web_registered', ['tma'])).toEqual(['browser', 'pwa'])
  })

  it('says nothing when the hint is not limited at all', () => {
    expect(surfaceGap('user.registered', [])).toEqual([])
  })

  it('says nothing when the hint is allowed where the customers are', () => {
    expect(surfaceGap('user.registered', ['tma', 'browser'])).toEqual([])
    // Partial overlap narrows, it does not miss: the person registering in the
    // browser is still reached.
    expect(surfaceGap('user.web_registered', ['browser'])).toEqual([])
  })

  it('claims nothing about events that happen wherever the customer is', () => {
    expect(surfaceGap('payment.failed', ['browser'])).toEqual([])
    expect(surfaceGap('user.*', ['browser'])).toEqual([])
  })

  it('knows a place only for the two sign-ups', () => {
    expect([...EVENT_HOME_SURFACES.keys()].sort()).toEqual(['user.registered', 'user.web_registered'])
  })
})

describe('usesOfHint', () => {
  it('lists every rule that fires the hint, switched on first', () => {
    const uses = usesOfHint('tpl-welcome', [
      rule({ id: 'a', name: 'Б — сайт', isEnabled: false, triggerSpec: 'user.web_registered' }),
      rule({ id: 'b', name: 'А — Telegram' }),
      rule({ id: 'c', name: 'Чужое', actions: [{ type: 'show_hint', params: { hintKey: 'other' } }] }),
    ])

    expect(uses.map((use) => use.ruleId)).toEqual(['b', 'a'])
    expect(uses[1]).toMatchObject({ isEnabled: false, triggerSpec: 'user.web_registered', action: 'show_hint' })
  })

  it('counts the same action twice in one rule as one use, and two kinds as two', () => {
    const twice = rule({
      actions: [
        { type: 'show_hint', params: { hintKey: 'tpl-welcome' } },
        { type: 'show_hint', params: { hintKey: ' tpl-welcome ' } },
      ],
    })
    expect(usesOfHint('tpl-welcome', [twice])).toHaveLength(1)

    const both = rule({
      triggerKind: 'CRON',
      triggerSpec: '0 9 * * *',
      actions: [
        { type: 'show_hint', params: { hintKey: 'connect' } },
        { type: 'show_hint_to_audience', params: { hintKey: 'connect', audience: 'paid-not-connected' } },
      ],
    })
    const uses = usesOfHint('connect', [both])
    expect(uses.map((use) => use.action)).toEqual(['show_hint', 'show_hint_to_audience'])
    expect(uses[1]?.audience).toBe('paid-not-connected')
  })

  it('ignores actions that name no usable key, and a blank key matches nothing', () => {
    const broken = rule({ actions: [{ type: 'show_hint', params: { hintKey: 42 } }] })
    expect(usesOfHint('42', [broken])).toEqual([])
    expect(usesOfHint('  ', [rule({})])).toEqual([])
  })
})

describe('the arrival plan points its rules at the events the hint editor reasons about', () => {
  it('greets Telegram sign-ups on the event whose customers are inside Telegram', () => {
    expect(planArrival('telegram').template.triggerSpec).toBe('user.registered')
    expect(EVENT_HOME_SURFACES.get('user.registered')).toEqual(['tma'])
  })

  it('greets site sign-ups on the event whose customers are in a browser', () => {
    expect(planArrival('web').template.triggerSpec).toBe('user.web_registered')
    expect(EVENT_HOME_SURFACES.get('user.web_registered')).toEqual(['browser', 'pwa'])
  })

  it('greets everyone with one hint on both events, the hint open to every surface', () => {
    const plan = planArrival('everyone')
    const events = [plan.template.triggerSpec, ...plan.companions.map((c) => c.triggerSpec)].sort()
    expect(events).toEqual(['user.registered', 'user.web_registered'])
    // The Telegram hint is the one kept: a hint limited to the browser would
    // hide the Telegram half of "everyone".
    expect(plan.template.surfaces ?? []).toEqual([])
    for (const event of events) expect(surfaceGap(event, plan.template.surfaces ?? [])).toEqual([])
  })
})

describe('an operator-facing name for every event a pop-up can be bound to', () => {
  const source = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..', '..', '..', '..',
      'src', 'modules', 'automations', 'popup-capable-events.ts',
    ),
    'utf8',
  )
  const capable = Array.from(source.matchAll(/^\s*type:\s*'([^']+)',$/gm), (match) => match[1]!)

  it('parsed the server list', () => {
    expect(capable.length, 'POPUP_CAPABLE_EVENTS was not parsed').toBeGreaterThanOrEqual(15)
  })

  it('has a name in both languages, and no name for an event the server does not list', () => {
    for (const bundle of [ru, en]) {
      const t = translatorFor(bundle)
      for (const type of capable) {
        expect(popupEventName(t, type), `${type} has no name`).not.toBeNull()
      }
      const named = Object.keys(
        (bundle as unknown as { automationsPage: { popupEvents: Record<string, string> } })
          .automationsPage.popupEvents,
      ).sort()
      expect(named).toEqual(capable.map((type) => popupEventNameKey(type).split('.').pop()).sort())
    }
  })

  it('answers null rather than a key for an event it has no words for, and for a wildcard', () => {
    const t = translatorFor(ru)
    expect(popupEventName(t, 'node.connection_lost')).toBeNull()
    expect(popupEventName(t, 'payment.*')).toBeNull()
    expect(popupEventName(t, '')).toBeNull()
  })

  it('says which door each sign-up is, in Russian', () => {
    const t = translatorFor(ru)
    expect(popupEventName(t, 'user.registered')).toMatch(/Telegram/)
    expect(popupEventName(t, 'user.web_registered')).toMatch(/сайт/)
  })
})

describe('the audience picker', () => {
  const OFFERED = ['purchase-not-connected', 'trial-not-connected']

  it('offers any rule the two buckets, and never the old «все» name', () => {
    expect([...OFFERED_HINT_AUDIENCES]).toEqual(OFFERED)
    expect(audiencePickerItems(undefined, [])).toEqual(OFFERED)
    expect(audiencePickerItems('', [])).toEqual(OFFERED)
    expect(audiencePickerItems('trial-not-connected', [])).toEqual(OFFERED)
  })

  it('adds the old name only for a rule that holds it — in the draft or as saved', () => {
    const withLegacy = [...OFFERED, 'paid-not-connected']
    expect(audiencePickerItems('paid-not-connected', [])).toEqual(withLegacy)
    expect(audiencePickerItems('  paid-not-connected ', [])).toEqual(withLegacy)
    // Switched away in the draft, still held as saved: it can be picked back.
    expect(
      audiencePickerItems('purchase-not-connected', [
        { type: 'show_hint_to_audience', params: { hintKey: 'x', audience: 'paid-not-connected' } },
      ]),
    ).toEqual(withLegacy)
    // The same string under another action is not an audience.
    expect(
      audiencePickerItems(undefined, [{ type: 'show_hint', params: { audience: 'paid-not-connected' } }]),
    ).toEqual(OFFERED)
  })

  it('covers exactly the names the server accepts', () => {
    expect(LEGACY_HINT_AUDIENCE).toBe('paid-not-connected')
    expect([...OFFERED_HINT_AUDIENCES, LEGACY_HINT_AUDIENCE].sort()).toEqual([...HINT_AUDIENCE_NAMES].sort())
  })

  it('names every audience in both languages, the old one as what it now is', () => {
    for (const bundle of [ru, en]) {
      const t = translatorFor(bundle)
      for (const audience of HINT_AUDIENCE_NAMES) {
        const label = String(t(`automationsPage.audiences.${audience}`))
        expect(label, `${audience} has no label`).not.toContain('automationsPage.')
      }
    }
    const legacy = String(translatorFor(ru)('automationsPage.audiences.paid-not-connected'))
    expect(legacy).toMatch(/все/)
    expect(legacy).toMatch(/устаревшее/)
    expect(String(translatorFor(ru)('automationsPage.audiences.purchase-not-connected'))).toBe(
      'Оплатил и не подключился',
    )
    expect(String(translatorFor(ru)('automationsPage.audiences.trial-not-connected'))).toBe(
      'Пробный период или подарок — не подключился',
    )
  })
})

describe('which triggers can carry a pop-up, as the server decides it', () => {
  /**
   * Specs an install can really hold, including the three the pre-fix
   * templates wrote (0.9.7.48, 0.9.7.50) and stars the grammar does not treat
   * as wildcards.
   */
  const CORPUS = [
    '*',
    '  *  ',
    'payment.*',
    'payment*',
    '*.failed',
    'payment',
    'payment.failed',
    ' payment.failed ',
    'user.*',
    'user.expire_soon',
    'subscription.expired',
    'user.bandwidth_usage_threshold_reached',
    'remnawave.user.*',
    'remnawave.*',
    'remnawave',
    'referral.*',
    'fraud.signal_opened',
    'node.*',
    'node.connection_lost',
    'custom.thing_happened',
    '',
    '   ',
  ]

  it('lists exactly the server capable events, in both directions', () => {
    expect([...POPUP_CAPABLE_EVENT_TYPES].sort()).toEqual(
      POPUP_CAPABLE_EVENTS.map((event) => event.type).sort(),
    )
    expect(new Set(POPUP_CAPABLE_EVENT_TYPES).size, 'a type is listed twice').toBe(
      POPUP_CAPABLE_EVENT_TYPES.length,
    )
  })

  it("answers every spec exactly as the server's canCarryPopup does", () => {
    for (const spec of CORPUS) {
      expect(canCarryPopup(spec), JSON.stringify(spec)).toBe(serverCanCarryPopup(spec))
    }
    // Anti-vacuity: the corpus holds both answers.
    expect(CORPUS.filter((spec) => canCarryPopup(spec)).length).toBeGreaterThan(3)
    expect(CORPUS.filter((spec) => !canCarryPopup(spec)).length).toBeGreaterThan(3)
  })

  it('refuses the triggers old installs still hold', () => {
    for (const spec of ['user.expire_soon', 'subscription.expired', 'user.bandwidth_usage_threshold_reached', 'payment*']) {
      expect(canCarryPopup(spec), spec).toBe(false)
    }
  })

  it('matches events with the server grammar', () => {
    const TYPES = [...POPUP_CAPABLE_EVENT_TYPES, 'payment', 'payment*', 'node.connection_lost', 'user.expire_soon']
    for (const pattern of CORPUS) {
      for (const type of TYPES) {
        expect(matchEventPattern(pattern, type), `${pattern} vs ${type}`).toBe(
          serverMatchEventPattern(pattern, type),
        )
      }
    }
  })

  it('calls only `*` and `ns.*` wildcards', () => {
    expect(['*', ' * ', 'payment.*', 'remnawave.user.*'].every(isWildcardPattern)).toBe(true)
    expect(['payment*', '*.failed', 'payment.failed', '', 'pay*ment'].some(isWildcardPattern)).toBe(false)
  })

  it('knows exactly the audiences the server accepts', () => {
    const source = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..', '..', '..', '..',
        'src', 'modules', 'user-hints', 'services', 'hint-audience.service.ts',
      ),
      'utf8',
    )
    const declared = /export const HINT_AUDIENCES = \[([^\]]*)\]/.exec(source)?.[1]
    expect(declared, 'HINT_AUDIENCES was not found').toBeDefined()
    const audiences = Array.from(declared!.matchAll(/'([^']+)'/g), (match) => match[1]!)
    expect(audiences.length, 'HINT_AUDIENCES was parsed empty').toBeGreaterThan(0)

    expect([...HINT_AUDIENCE_NAMES].sort()).toEqual(audiences.sort())
    expect(isKnownAudience(audiences[0]!)).toBe(true)
    expect(isKnownAudience(null)).toBe(false)
    expect(isKnownAudience('everyone')).toBe(false)
  })
})
