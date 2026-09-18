import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { CLIENT_MOMENT_KEYS, TRIGGER_LANE_STAGES, buildTriggerMap } from './trigger-map'
import { HINT_TEMPLATES, HINT_TEMPLATE_STAGES } from './hint-templates'
import { matchEventPattern as serverMatch } from '../../../../src/modules/automations/event-pattern'
import type { AutomationRule } from './automations-api'
import type { UserHint } from '@/features/user-hints/user-hints-api'

/**
 * The join between a rule and the hint it names.
 *
 * Every case here is about a state that is invisible everywhere else in the
 * panel: the rules tab shows rules, the hints tab shows hints, and the string
 * connecting them was shown nowhere at all. That gap is not cosmetic — a rule
 * naming a hint nobody authored fails once per firing, in a log, and reads
 * "enabled" in the list the entire time.
 */

function rule(over: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule-1',
    name: 'Правило',
    description: null,
    isEnabled: true,
    triggerKind: 'REALTIME',
    triggerSpec: 'payment.failed',
    conditions: null,
    actions: [{ type: 'show_hint', params: { hintKey: 'tpl-payment-failed' } }],
    createdById: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunMessage: null,
    runCount: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  } as AutomationRule
}

function hint(over: Partial<UserHint> = {}): UserHint {
  return {
    id: 'hint-1',
    key: 'tpl-payment-failed',
    titleRu: 'Оплата не прошла',
    bodyRu: 'Текст',
    titleEn: null,
    bodyEn: null,
    mode: 'MODAL',
    tone: 'WARNING',
    ctaKind: 'NONE',
    ctaLabelRu: null,
    ctaLabelEn: null,
    ctaTarget: null,
    surfaces: [],
    formFactors: [],
    groupKey: null,
    ttlHours: 24,
    isRepeatable: true,
    isActive: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  } as UserHint
}

/** The node for one trigger, wherever its lane happens to be. */
function nodeFor(map: ReturnType<typeof buildTriggerMap>, type: string) {
  return map.lanes.flatMap((lane) => lane.triggers).find((node) => node.type === type)
}

describe('a path from a trigger to a pop-up', () => {
  it('says when green depends on conditions the map cannot evaluate', () => {
    // `live` is drawn green and captioned "customers are seeing this". For a
    // rule gated on `{"plan":"vip"}` that is a claim nothing here can make:
    // the conditions run server-side against a payload the map never sees, and
    // one that matches NOBODY renders exactly as green as one that matches
    // everybody. The state stays `live`, because it is; the row admits the
    // filter.
    const gated = { ...rule(), conditions: { plan: 'vip' } as Record<string, unknown> }
    const map = buildTriggerMap({ rules: [gated], hints: [hint()] })

    const path = nodeFor(map, 'payment.failed')?.paths[0]
    expect(path?.state).toBe('live')
    expect(path?.hasConditions).toBe(true)
  })

  it('does not call an empty condition object a filter', () => {
    // What the editor leaves behind when an operator clears the field. Marking
    // it would put the caveat on rules that have no filter at all, which is the
    // fastest way to teach an operator to ignore the marker.
    const empty = { ...rule(), conditions: {} as Record<string, unknown> }
    const map = buildTriggerMap({ rules: [empty], hints: [hint()] })

    expect(nodeFor(map, 'payment.failed')?.paths[0]?.hasConditions).toBe(false)
  })

  it('is live when the rule is on and the hint exists and is on', () => {
    const map = buildTriggerMap({ rules: [rule()], hints: [hint()] })

    expect(nodeFor(map, 'payment.failed')?.paths).toEqual([
      {
        ruleId: 'rule-1',
        ruleName: 'Правило',
        hintKey: 'tpl-payment-failed',
        hintTitle: 'Оплата не прошла',
        state: 'live',
        hasConditions: false,
        surfaceGap: [],
        isEnabled: true,
      },
    ])
    expect(map.counts.live).toBe(1)
  })

  it('is broken when the rule names a hint nobody authored', () => {
    // THE SILENT FAILURE THIS WHOLE VIEW EXISTS FOR. Nothing refuses it at save
    // time — the key is a free string and the hint it names may be authored
    // later — so the only other place it appears is one line in an execution
    // log, after the moment has gone.
    const map = buildTriggerMap({ rules: [rule()], hints: [] })

    expect(nodeFor(map, 'payment.failed')?.paths[0]?.state).toBe('missing-hint')
    expect(nodeFor(map, 'payment.failed')?.paths[0]?.hintTitle).toBeNull()
    expect(map.counts.broken).toBe(1)
  })

  it('is broken when the hint exists but is switched off', () => {
    // A different mistake with the same outcome, and it looks fine from both
    // tabs: the rule is enabled, the hint is written, and the customer sees
    // nothing.
    const map = buildTriggerMap({ rules: [rule()], hints: [hint({ isActive: false })] })

    expect(nodeFor(map, 'payment.failed')?.paths[0]?.state).toBe('hint-inactive')
    expect(map.counts.broken).toBe(1)
  })

  it('is paused when everything is built and the rule is off', () => {
    // Not a defect and not live either — this is the state a freshly applied
    // template leaves behind, and telling it apart from the broken ones is most
    // of the point.
    const map = buildTriggerMap({ rules: [rule({ isEnabled: false })], hints: [hint()] })

    expect(nodeFor(map, 'payment.failed')?.paths[0]?.state).toBe('paused')
    expect(map.counts.paused).toBe(1)
    expect(map.counts.broken).toBe(0)
  })
})

describe('a path whose customers open the cabinet where the hint may not appear', () => {
  /**
   * THE OWNER'S CASE. «Первое появление» listens to `user.registered` — the
   * Telegram sign-up — and he ticked «Браузер». Rule on, hint written and on:
   * every check this map makes said `live`, drawn green as "customers are
   * seeing this", while the people that event names were inside Telegram and
   * the hint, limited to the browser, was never drawn for any of them.
   */
  const welcome = (over: Partial<AutomationRule> = {}) =>
    rule({
      name: 'Первое появление',
      triggerSpec: 'user.registered',
      actions: [{ type: 'show_hint', params: { hintKey: 'tpl-welcome' } }],
      ...over,
    })
  const welcomeHint = (surfaces: string[], over: Partial<UserHint> = {}) =>
    hint({ key: 'tpl-welcome', titleRu: 'Добро пожаловать', surfaces, ...over })

  it('marks the Telegram sign-up welcome limited to the browser, and keeps it live', () => {
    const map = buildTriggerMap({ rules: [welcome()], hints: [welcomeHint(['browser'])] })
    const path = nodeFor(map, 'user.registered')?.paths[0]

    // A marker beside the state, not a fifth state: it is a LIKELY miss.
    expect(path?.state).toBe('live')
    expect(path?.surfaceGap).toEqual(['tma'])
  })

  it('clears the mark once the place those customers are in is ticked', () => {
    const map = buildTriggerMap({
      rules: [welcome()],
      hints: [welcomeHint(['browser', 'tma'])],
    })

    expect(nodeFor(map, 'user.registered')?.paths[0]?.surfaceGap).toEqual([])
  })

  it('does not mark a hint that is not limited at all', () => {
    const map = buildTriggerMap({ rules: [welcome()], hints: [welcomeHint([])] })

    expect(nodeFor(map, 'user.registered')?.paths[0]?.surfaceGap).toEqual([])
  })

  it('marks the site sign-up welcome limited to Telegram, on its own row', () => {
    const map = buildTriggerMap({
      rules: [welcome({ triggerSpec: 'user.web_registered' })],
      hints: [welcomeHint(['tma'])],
    })

    expect(nodeFor(map, 'user.web_registered')?.paths[0]?.surfaceGap).toEqual(['browser', 'pwa'])
  })

  it('claims nothing about an event that happens to a customer wherever they are', () => {
    // Anti-vacuity for the positive case: a map marking every limited hint
    // would satisfy it and put amber on rules that reach their people fine.
    const map = buildTriggerMap({ rules: [rule()], hints: [hint({ surfaces: ['browser'] })] })

    expect(nodeFor(map, 'payment.failed')?.paths[0]?.surfaceGap).toEqual([])
  })

  it('marks a switched-off hint too, and says nothing for a hint that does not exist', () => {
    const inactive = buildTriggerMap({
      rules: [welcome()],
      hints: [welcomeHint(['browser'], { isActive: false })],
    })
    expect(nodeFor(inactive, 'user.registered')?.paths[0]).toMatchObject({
      state: 'hint-inactive',
      surfaceGap: ['tma'],
    })

    const missing = buildTriggerMap({ rules: [welcome()], hints: [] })
    expect(nodeFor(missing, 'user.registered')?.paths[0]).toMatchObject({
      state: 'missing-hint',
      surfaceGap: [],
    })
  })

  it('changes no count', () => {
    // The badges count states. A gap is not one, and a live path with a gap is
    // still counted live — the marker is what tells it apart.
    const limited = buildTriggerMap({ rules: [welcome()], hints: [welcomeHint(['browser'])] })
    const open = buildTriggerMap({ rules: [welcome()], hints: [welcomeHint([])] })

    expect(limited.counts).toEqual(open.counts)
    expect(limited.counts).toMatchObject({ live: 1, paused: 0, broken: 0 })
  })
})

describe('a rule on an event the panel has not checked', () => {
  /**
   * UNCHECKED, NOT BROKEN. The server's list of events a pop-up is known to
   * work on is closed, not exhaustive: the pre-fix template triggers
   * (`user.expire_soon` and its siblings, on installs from 0.9.7.48 and
   * 0.9.7.50) never fire, while an unlisted event that names a customer —
   * `support.ticket_created`, `partner.activated` — works. Drawing all of them
   * red and counting them under «Не сработает» told an operator to delete
   * pop-ups that were being shown; drawing them green claimed the opposite.
   */
  const legacy = (triggerSpec: string) =>
    rule({
      id: 'legacy',
      name: 'Скоро истечёт (старый шаблон)',
      triggerSpec,
      actions: [{ type: 'show_hint', params: { hintKey: 'tpl-expire-soon' } }],
    })
  const expiryHint = () => hint({ key: 'tpl-expire-soon', titleRu: 'Скоро закончится' })

  it.each([
    'user.expire_soon',
    'subscription.expired',
    'user.bandwidth_usage_threshold_reached',
    // Unlisted and working: emitted with a `userId`.
    'support.ticket_created',
    'partner.activated',
  ])('is unchecked — not live, not broken — on %s', (spec) => {
    const map = buildTriggerMap({ rules: [legacy(spec)], hints: [expiryHint()] })

    expect(nodeFor(map, spec)?.paths[0]?.state).toBe('unverified')
    expect(map.counts).toMatchObject({ live: 0, paused: 0, broken: 0, unverified: 1 })
  })

  it("carries the rule's own switch, so a rule just switched off does not read as running", () => {
    // «Кто увидит» has always shown the badge; the map showed the same amber
    // chip as before and left «Выключено» at 0.
    const map = buildTriggerMap({
      rules: [{ ...legacy('user.expire_soon'), isEnabled: false }],
      hints: [expiryHint()],
    })

    expect(nodeFor(map, 'user.expire_soon')?.paths[0]).toMatchObject({
      state: 'unverified',
      isEnabled: false,
    })
    expect(buildTriggerMap({ rules: [legacy('user.expire_soon')], hints: [expiryHint()] }).lanes
      .flatMap((lane) => lane.triggers)
      .find((node) => node.type === 'user.expire_soon')?.paths[0]?.isEnabled).toBe(true)
  })

  it('stays unchecked while the rule is switched off: switching it on settles nothing', () => {
    const map = buildTriggerMap({
      rules: [{ ...legacy('user.expire_soon'), isEnabled: false }],
      hints: [expiryHint()],
    })

    expect(nodeFor(map, 'user.expire_soon')?.paths[0]?.state).toBe('unverified')
    expect(map.counts).toMatchObject({ paused: 0, unverified: 1 })
  })

  it('reports a missing or switched-off hint first, because that failure is certain', () => {
    const missing = buildTriggerMap({ rules: [legacy('user.expire_soon')], hints: [] })
    expect(nodeFor(missing, 'user.expire_soon')?.paths[0]?.state).toBe('missing-hint')
    expect(missing.counts).toMatchObject({ broken: 1, unverified: 0 })

    const off = buildTriggerMap({
      rules: [legacy('user.expire_soon')],
      hints: [expiryHint()].map((one) => ({ ...one, isActive: false })),
    })
    expect(nodeFor(off, 'user.expire_soon')?.paths[0]?.state).toBe('hint-inactive')
  })

  it('leaves the ready-made pop-up offered on the event it belongs to', () => {
    // The repair affordance: the text is already there, the rule is not.
    const map = buildTriggerMap({ rules: [legacy('user.expire_soon')], hints: [expiryHint()] })
    const offer = nodeFor(map, 'remnawave.user.expire_soon')?.offers.find(
      (candidate) => candidate.templateId === 'expire_soon',
    )

    expect(offer?.hintExists).toBe(true)
  })

  it('draws a star the grammar does not call a wildcard on a row of its own, unchecked', () => {
    // `payment*` is an exact string to the bridge. It was counted as a
    // working wildcard and drawn nowhere.
    const map = buildTriggerMap({ rules: [legacy('payment*')], hints: [expiryHint()] })

    expect(nodeFor(map, 'payment*')?.paths[0]?.state).toBe('unverified')
    expect(nodeFor(map, 'payment.failed')?.wildcardRuleIds).toEqual([])
    expect(map.counts).toMatchObject({ live: 0, broken: 0, unverified: 1 })
  })

  it.each(['node.*', 'support.*'])(
    'draws a wildcard that reaches no checked event (%s) on a row of its own',
    (spec) => {
      // It was counted as «1 не сработает» and drawn nowhere — a badge with
      // nothing on the map to press.
      const map = buildTriggerMap({ rules: [legacy(spec)], hints: [expiryHint()] })

      expect(nodeFor(map, spec)?.paths.map((path) => path.state)).toEqual(['unverified'])
      expect(map.counts).toMatchObject({ live: 0, broken: 0, unverified: 1 })
    },
  )

  it('still calls a capable wildcard and a capable event live', () => {
    // Anti-vacuity: a check that refused every spec would satisfy the cases above.
    const wildcard = buildTriggerMap({ rules: [legacy('remnawave.user.*')], hints: [expiryHint()] })
    expect(wildcard.counts).toMatchObject({ live: 1, broken: 0, unverified: 0 })
    // Drawn on a row of its own — where the one chip the count promises is —
    // and cross-referenced on the event rows it reaches.
    expect(nodeFor(wildcard, 'remnawave.user.*')?.paths.map((path) => path.state)).toEqual(['live'])
    expect(nodeFor(wildcard, 'remnawave.user.expire_soon')?.wildcardRuleIds).toEqual(['legacy'])

    const exact = buildTriggerMap({
      rules: [legacy('remnawave.user.expire_soon')],
      hints: [expiryHint()],
    })
    expect(nodeFor(exact, 'remnawave.user.expire_soon')?.paths[0]?.state).toBe('live')
  })
})

describe('a checked wildcard no event row carries', () => {
  // `referral.*` reaches only the referral pair, which no template covers, so
  // no row showed it — while the badges counted it live.
  it('gets a row of its own, in the lane of the events it reaches', () => {
    const map = buildTriggerMap({
      rules: [
        rule({
          id: 'referral-rule',
          triggerSpec: 'referral.*',
          actions: [{ type: 'show_hint', params: { hintKey: 'hand-written' } }],
        }),
      ],
      hints: [hint({ key: 'hand-written', titleRu: 'Своя подсказка' })],
    })

    expect(nodeFor(map, 'referral.*')?.paths.map((path) => path.state)).toEqual(['live'])
    expect(map.lanes.find((lane) => lane.triggers.some((node) => node.type === 'referral.*'))?.stage).toBe(
      'rewards',
    )
    expect(map.counts).toMatchObject({ live: 1, broken: 0 })
  })

  it('keeps its own chip and cross-references the event rows it reaches', () => {
    // A rule naming `referral.qualified` exactly gives that event a row too.
    const map = buildTriggerMap({
      rules: [
        rule({
          id: 'referral-rule',
          triggerSpec: 'referral.*',
          actions: [{ type: 'show_hint', params: { hintKey: 'hand-written' } }],
        }),
        rule({
          id: 'exact-rule',
          triggerSpec: 'referral.qualified',
          actions: [{ type: 'show_hint', params: { hintKey: 'hand-written' } }],
        }),
      ],
      hints: [hint({ key: 'hand-written', titleRu: 'Своя подсказка' })],
    })

    expect(nodeFor(map, 'referral.*')?.paths.map((path) => path.ruleId)).toEqual(['referral-rule'])
    expect(nodeFor(map, 'referral.qualified')?.wildcardRuleIds).toEqual(['referral-rule'])
    // Two rules, two chips, two counted — the cross-reference counts nothing.
    expect(map.counts).toMatchObject({ live: 2 })
  })
})

describe('every counted rule is drawn where it can be pressed', () => {
  /** Chips on rows, plus the chips in the eventless list. */
  const drawn = (map: ReturnType<typeof buildTriggerMap>): number =>
    map.lanes.flatMap((lane) => lane.triggers).reduce((total, node) => total + node.paths.length, 0) +
    map.eventlessFailures.length
  const counted = (map: ReturnType<typeof buildTriggerMap>): number =>
    map.counts.live + map.counts.paused + map.counts.broken + map.counts.unverified

  it('draws a capable wildcard whose hint was deleted, instead of only counting it', () => {
    // «1 не сработает» in the header, «плюс 1 правило по маске» and
    // «ничего не настроено» on the rows, and no red chip anywhere to press.
    const map = buildTriggerMap({
      rules: [rule({ id: 'wild', triggerSpec: 'payment.*' })],
      hints: [],
    })

    expect(nodeFor(map, 'payment.*')?.paths.map((path) => path.state)).toEqual(['missing-hint'])
    expect(nodeFor(map, 'payment.failed')?.wildcardRuleIds).toEqual(['wild'])
    expect(map.counts).toMatchObject({ broken: 1 })
    expect(drawn(map)).toBe(counted(map))
  })

  it('draws as many chips as it counts, over every shape at once', () => {
    const map = buildTriggerMap({
      rules: [
        rule({}),
        rule({ id: 'off', isEnabled: false }),
        rule({ id: 'wild', triggerSpec: 'payment.*' }),
        rule({ id: 'unchecked', triggerSpec: 'support.ticket_created' }),
        rule({ id: 'star', triggerSpec: '*' }),
        rule({ id: 'nodes', triggerSpec: 'node.*' }),
        rule({ id: 'exactish', triggerSpec: 'payment*' }),
        rule({
          id: 'audience-event',
          actions: [{ type: 'show_hint_to_audience', params: { hintKey: 'tpl-payment-failed' } }],
        }),
        rule({ id: 'cron-hint', triggerKind: 'CRON', triggerSpec: '0 3 * * *' }),
        rule({
          id: 'cron-audience-broken',
          triggerKind: 'CRON',
          triggerSpec: '0 9 * * *',
          actions: [{ type: 'show_hint_to_audience', params: { hintKey: 'tpl-payment-failed' } }],
        }),
      ],
      hints: [hint()],
    })

    expect(counted(map), 'the fixture counts too little to prove anything').toBeGreaterThan(8)
    expect(drawn(map)).toBe(counted(map))
  })
})

describe('a row that is a wildcard of its own', () => {
  it('belongs to its rule only: another wildcard does not "reach" a pattern', () => {
    // `*` matches the string `node.*` as it matches any string, and listing it
    // there would say "plus 1 rule via a wildcard" about a row that is not an
    // event at all.
    const map = buildTriggerMap({
      rules: [
        rule({ id: 'everything', triggerSpec: '*' }),
        rule({ id: 'nodes', triggerSpec: 'node.*' }),
      ],
      hints: [hint()],
    })

    expect(nodeFor(map, 'node.*')?.paths.map((path) => path.ruleId)).toEqual(['nodes'])
    expect(nodeFor(map, 'node.*')?.wildcardRuleIds).toEqual([])
    // And `*` is still reaching the real event rows.
    expect(nodeFor(map, 'payment.failed')?.wildcardRuleIds).toEqual(['everything'])
  })
})

describe('rows the template library has no stage for', () => {
  it.each(['support.ticket_created', 'payment*', 'node.*', '*'])('files %s under «Прочее»', (spec) => {
    const map = buildTriggerMap({
      rules: [rule({ id: 'row', triggerSpec: spec })],
      hints: [hint()],
    })

    expect(map.lanes.find((lane) => lane.triggers.some((node) => node.type === spec))?.stage).toBe(
      'other',
    )
  })

  it('is the last lane, after every stage of the library', () => {
    expect(TRIGGER_LANE_STAGES[TRIGGER_LANE_STAGES.length - 1]).toBe('other')
    expect(TRIGGER_LANE_STAGES.slice(0, -1)).toEqual([...HINT_TEMPLATE_STAGES])
  })

  it('leaves a templated event in its own stage', () => {
    // Anti-vacuity: «Прочее» is the residual, not the answer for everything.
    const map = buildTriggerMap({ rules: [rule()], hints: [hint()] })

    expect(map.lanes.find((lane) => lane.triggers.some((node) => node.type === 'payment.failed'))?.stage).toBe(
      'payment',
    )
  })
})

describe('rules whose every automatic run fails', () => {
  it('draws no surface-gap marker on an audience action, which shows nothing anywhere', () => {
    const map = buildTriggerMap({
      rules: [
        rule({
          triggerSpec: 'user.registered',
          actions: [{ type: 'show_hint_to_audience', params: { hintKey: 'tpl-welcome' } }],
        }),
      ],
      hints: [hint({ key: 'tpl-welcome', titleRu: 'Добро пожаловать', surfaces: ['browser'] })],
    })

    expect(nodeFor(map, 'user.registered')?.paths[0]).toMatchObject({
      state: 'audience-on-event',
      surfaceGap: [],
    })
  })

  it('draws an audience action on an event red on its event row, and counts it', () => {
    // The action refuses an event trigger outright. It used to mark its hint
    // used and draw nothing, while «Кто увидит» said nobody sees the hint.
    const map = buildTriggerMap({
      rules: [
        rule({
          id: 'audience-on-event',
          actions: [
            { type: 'show_hint_to_audience', params: { hintKey: 'tpl-payment-failed', audience: 'paid-not-connected' } },
          ],
        }),
      ],
      hints: [hint()],
    })
    const node = nodeFor(map, 'payment.failed')

    expect(node?.paths.map((path) => path.state)).toEqual(['audience-on-event'])
    expect(map.counts).toMatchObject({ live: 0, broken: 1, unverified: 0 })
    // It shows nothing, so it does not stand in the way of the ready-made pop-ups.
    expect(node?.offers.length).toBeGreaterThan(0)
  })

  it('draws an audience action on a wildcard on a row of its own, hiding no offers', () => {
    const map = buildTriggerMap({
      rules: [
        rule({
          id: 'audience-everywhere',
          triggerSpec: '*',
          actions: [{ type: 'show_hint_to_audience', params: { hintKey: 'tpl-payment-failed' } }],
        }),
      ],
      hints: [hint()],
    })

    expect(nodeFor(map, '*')?.paths.map((path) => path.state)).toEqual(['audience-on-event'])
    expect(nodeFor(map, 'payment.failed')?.wildcardRuleIds).toEqual([])
    expect(nodeFor(map, 'payment.failed')?.offers.length).toBeGreaterThan(0)
    expect(map.counts).toMatchObject({ broken: 1 })
  })

  it('draws both actions of one rule that shows a hint and also sends it to an audience', () => {
    const map = buildTriggerMap({
      rules: [
        rule({
          actions: [
            { type: 'show_hint', params: { hintKey: 'tpl-payment-failed' } },
            { type: 'show_hint_to_audience', params: { hintKey: 'tpl-payment-failed' } },
          ],
        }),
      ],
      hints: [hint()],
    })

    expect(nodeFor(map, 'payment.failed')?.paths.map((path) => path.state).sort()).toEqual([
      'audience-on-event',
      'live',
    ])
    expect(map.counts).toMatchObject({ live: 1, broken: 1 })
  })

  it('lists a scheduled show_hint rule apart, counted, instead of silently using its hint', () => {
    const map = buildTriggerMap({
      rules: [
        rule({
          id: 'cron-hint',
          name: 'Ночная подсказка',
          triggerKind: 'CRON',
          triggerSpec: '0 3 * * *',
          actions: [{ type: 'show_hint', params: { hintKey: 'hand-written' } }],
        }),
      ],
      hints: [hint({ key: 'hand-written', titleRu: 'Своя подсказка' })],
    })

    expect(map.eventlessFailures).toEqual([
      {
        ruleId: 'cron-hint',
        ruleName: 'Ночная подсказка',
        hintKey: 'hand-written',
        hintTitle: 'Своя подсказка',
        reason: 'schedule-names-nobody',
        isEnabled: true,
      },
    ])
    expect(map.counts).toMatchObject({ live: 0, broken: 1 })
    expect(map.orphanHints).toEqual([])
  })

  it('carries the switch of a rule with no event, so its chip can say so too', () => {
    // Anti-vacuity for the field asserted above: a hard-coded `true` produces
    // exactly what an enabled rule does, and the chip would then draw a rule
    // just switched off the way it drew it a moment before.
    const map = buildTriggerMap({
      rules: [
        rule({
          id: 'cron-hint',
          triggerKind: 'CRON',
          triggerSpec: '0 3 * * *',
          isEnabled: false,
          actions: [{ type: 'show_hint', params: { hintKey: 'hand-written' } }],
        }),
      ],
      hints: [hint({ key: 'hand-written', titleRu: 'Своя подсказка' })],
    })

    expect(map.eventlessFailures.map((failure) => failure.isEnabled)).toEqual([false])
  })

  it.each([
    ['a scheduled audience job with no audience', 'CRON' as const, {}],
    ['a scheduled audience job with an audience the panel does not know', 'CRON' as const, { audience: 'everyone' }],
    ['a manual audience run with no audience', 'MANUAL' as const, {}],
  ])('lists %s among the rules with no event', (_label, triggerKind, extra) => {
    // Every run fails with "requires `audience`". The map used to count and
    // draw nothing, while «Кто увидит» said nobody sees the hint.
    const map = buildTriggerMap({
      rules: [
        rule({
          id: 'audience-broken',
          triggerKind,
          triggerSpec: triggerKind === 'CRON' ? '0 9 * * *' : '',
          actions: [{ type: 'show_hint_to_audience', params: { hintKey: 'hand-written', ...extra } }],
        }),
      ],
      hints: [hint({ key: 'hand-written', titleRu: 'Своя подсказка' })],
    })

    expect(map.eventlessFailures.map((failure) => failure.reason)).toEqual([
      'audience-invalid',
    ])
    expect(map.counts).toMatchObject({ broken: 1 })
    expect(map.orphanHints).toEqual([])
  })

  it('does not list a working scheduled audience job or a manual rule', () => {
    // Anti-vacuity: both are shapes the server accepts on purpose.
    const map = buildTriggerMap({
      rules: [
        rule({
          id: 'cron-audience',
          triggerKind: 'CRON',
          triggerSpec: '0 9 * * *',
          actions: [{ type: 'show_hint_to_audience', params: { hintKey: 'hand-written', audience: 'paid-not-connected' } }],
        }),
        rule({
          id: 'manual',
          triggerKind: 'MANUAL',
          triggerSpec: '',
          actions: [{ type: 'show_hint', params: { hintKey: 'hand-written' } }],
        }),
      ],
      hints: [hint({ key: 'hand-written', titleRu: 'Своя подсказка' })],
    })

    expect(map.eventlessFailures).toEqual([])
    expect(map.counts).toMatchObject({ live: 0, paused: 0, broken: 0, unverified: 0 })
  })
})

describe('a rule that reaches a trigger through a wildcard', () => {
  it('is counted apart from the ones that name it', () => {
    // `*` covers every event. An operator looking at an empty row would
    // otherwise add a second pop-up and get two — the wildcard is the reason
    // the row is not as empty as it looks.
    const map = buildTriggerMap({
      rules: [rule({ triggerSpec: 'payment.*' })],
      hints: [hint()],
    })

    const node = nodeFor(map, 'payment.failed')
    expect(node?.paths).toEqual([])
    expect(node?.wildcardRuleIds).toEqual(['rule-1'])
  })

  it('does not reach a namespace it has nothing to do with', () => {
    const map = buildTriggerMap({
      rules: [rule({ triggerSpec: 'payment.*' })],
      hints: [hint()],
    })

    expect(nodeFor(map, 'user.registered')?.wildcardRuleIds).toEqual([])
  })

  it('agrees with the server about what a pattern means', () => {
    // THE ONLY THING THAT MAKES A SECOND COPY OF THE GRAMMAR ACCEPTABLE. The
    // authority is the bridge's `matchEventPattern`, imported here from the
    // server tree — a test may reach across the package boundary where the
    // browser bundle may not. `canCarryPopup` once held its own opinion about
    // `*` and the panel refused to save a rule that would have worked.
    //
    // Exercised through the map rather than against the copy directly: the copy
    // is not exported, and what matters is the behaviour an operator sees.
    const CORPUS = [
      '*',
      'payment.*',
      'payment',
      'payment.failed',
      'remnawave.user.*',
      // Stars the grammar does NOT treat as wildcards: exact strings to the bridge.
      'payment*',
      '*.failed',
      '',
      '  ',
    ]
    const TYPES = HINT_TEMPLATES.map((template) => template.triggerSpec)

    for (const pattern of CORPUS) {
      for (const type of TYPES) {
        const map = buildTriggerMap({
          rules: [rule({ triggerSpec: pattern })],
          hints: [hint()],
        })
        const node = nodeFor(map, type)
        // Exact matches become paths, everything else a wildcard edge — so the
        // union of the two is what the copy answered.
        const spa =
          (node?.paths.length ?? 0) > 0 || (node?.wildcardRuleIds.length ?? 0) > 0
        expect(spa, `${pattern} vs ${type}`).toBe(serverMatch(pattern, type))
      }
    }
  })
})

describe('what an operator has not built yet', () => {
  it('offers the ready-made pop-up for a trigger with no rule', () => {
    const map = buildTriggerMap({ rules: [], hints: [] })

    const node = nodeFor(map, 'payment.failed')
    expect(node?.paths).toEqual([])
    expect(node?.offers.map((offer) => offer.templateId).sort()).toEqual([
      'payment_failed',
      'payment_failed_method',
    ])
  })

  it('says when the hint is already there and only the rule is missing', () => {
    // The state a half-finished template apply leaves: the card writes the hint
    // immediately, and an operator who navigated away before pressing Create
    // has one row of the two.
    const map = buildTriggerMap({ rules: [], hints: [hint()] })

    const offer = nodeFor(map, 'payment.failed')?.offers.find(
      (candidate) => candidate.templateId === 'payment_failed',
    )
    expect(offer?.hintExists).toBe(true)
  })

  it('stops offering anything once the trigger has a pop-up', () => {
    // NOT "stops offering the one already in use", which was the wrong
    // question. With one half of an alternative pair live and green, offering
    // the other half beside it as a dashed button is an invitation to two
    // pop-ups for one act — the thing the collision panel warns about — and it
    // left the "unused" count permanently above zero unless an operator enabled
    // both halves of all four pairs.
    const map = buildTriggerMap({ rules: [rule()], hints: [hint()] })

    expect(nodeFor(map, 'payment.failed')?.offers).toEqual([])
    // The trigger next door is untouched: an offer is suppressed by ITS OWN
    // row having a path, not by any path existing anywhere.
    expect(
      (nodeFor(map, 'remnawave.user.expire_soon')?.offers.length ?? 0) > 0,
    ).toBe(true)
  })

  it('counts every trigger the templates cover, wired or not', () => {
    // Anti-emptiness anchor. An empty map agrees with every case above by
    // having nothing to disagree with.
    const map = buildTriggerMap({ rules: [], hints: [] })
    const triggers = map.lanes.flatMap((lane) => lane.triggers)

    expect(triggers.length).toBe(new Set(HINT_TEMPLATES.map((t) => t.triggerSpec)).size)
    expect(map.lanes.length).toBeGreaterThan(3)
  })
})

describe('a hint nothing points at', () => {
  it('is listed, because it looks finished from the hints tab', () => {
    const map = buildTriggerMap({
      rules: [],
      hints: [hint({ key: 'hand-written', titleRu: 'Своя подсказка' })],
    })

    expect(map.orphanHints).toEqual([
      { key: 'hand-written', title: 'Своя подсказка', isActive: true },
    ])
  })

  it('is not listed when a rule names it', () => {
    const map = buildTriggerMap({
      rules: [rule({ actions: [{ type: 'show_hint', params: { hintKey: 'hand-written' } }] })],
      hints: [hint({ key: 'hand-written' })],
    })

    expect(map.orphanHints).toEqual([])
  })

  it('is not listed for a template hint, which the trigger row already reports', () => {
    // Otherwise one gap is reported twice: as an unused offer on the trigger,
    // and again down here as an orphan.
    const map = buildTriggerMap({ rules: [], hints: [hint()] })

    expect(map.orphanHints).toEqual([])
  })
})

describe('what is not a path', () => {
  it('ignores a rule whose actions show no hint', () => {
    // A Telegram notification on the same event is real and useful and is not a
    // pop-up. Drawing it would make this a map of automations, which is a
    // different question with a different answer.
    const map = buildTriggerMap({
      rules: [rule({ actions: [{ type: 'notify_telegram', params: { text: 'x' } }] })],
      hints: [hint()],
    })

    expect(nodeFor(map, 'payment.failed')?.paths).toEqual([])
  })

  it('draws no event edge for a scheduled rule that carries one anyway', () => {
    // Refused at save time now; an older install may still hold one. A cron run
    // names nobody, so the pop-up cannot fire — an edge from an event would
    // promise something the run does not deliver. It is listed apart instead
    // (see "rules whose every automatic run fails").
    const map = buildTriggerMap({
      rules: [rule({ triggerKind: 'CRON', triggerSpec: '0 3 * * *' })],
      hints: [hint()],
    })

    expect(map.counts.live).toBe(0)
    expect(nodeFor(map, 'payment.failed')?.paths).toEqual([])
    expect(map.eventlessFailures.map((failure) => failure.ruleId)).toEqual(['rule-1'])
  })
})

describe('a rule that reaches its hint only through a wildcard', () => {
  /**
   * The wildcard branch used to `continue` before recording anything, and that
   * one line produced two contradictions on one screen.
   */
  const wildcard = () =>
    rule({
      triggerSpec: 'remnawave.user.*',
      actions: [{ type: 'show_hint', params: { hintKey: 'hand-written' } }],
    })

  it('does not call its hint abandoned', () => {
    // It was listed under "hints nothing points at" — beside the very row
    // saying a wildcard rule points at it — under a sentence telling the
    // operator no customer will ever see it. Deleting it on that advice kills a
    // live pop-up.
    const map = buildTriggerMap({
      rules: [wildcard()],
      hints: [hint({ key: 'hand-written', titleRu: 'Своя подсказка' })],
    })

    expect(map.orphanHints).toEqual([])
  })

  it('still counts as broken when it names a hint nobody authored', () => {
    // The red "will not fire" badge never appeared for a wildcard rule — and
    // that failure, silent and once per firing, is what this view exists for.
    const map = buildTriggerMap({ rules: [wildcard()], hints: [] })

    expect(map.counts.broken).toBeGreaterThan(0)
  })

  it('counts it once, not once per trigger it reaches', () => {
    // THIS CASE USED TO ASSERT THE OPPOSITE, and the opposite is what an
    // operator saw: one `*` rule naming a hint nobody wrote rendered
    // «17 не сработают» — a red alarm about seventeen things for one mistake,
    // because the count ran inside the per-trigger loop.
    //
    // A rule is one rule. The row it reaches is told separately, by the "plus
    // N rules via a wildcard" line under the trigger.
    const map = buildTriggerMap({ rules: [wildcard()], hints: [] })
    const reached = map.lanes
      .flatMap((lane) => lane.triggers)
      .filter((node) => node.wildcardRuleIds.length > 0).length

    expect(reached, 'the wildcard reached only one trigger, so this proves nothing').toBeGreaterThan(
      1,
    )
    expect(map.counts.broken).toBe(1)
  })

  it('counts as LIVE once its hint exists and is switched on', () => {
    // The other half of the same asymmetry, and the more expensive one. The
    // wildcard branch touched `broken` and nothing else, so an operator who
    // fixed the hint watched the red badge go to zero and the green badge stay
    // at zero — while that rule was firing a pop-up on every event in the
    // product. The map said nothing was running; everything was.
    const map = buildTriggerMap({
      rules: [wildcard()],
      hints: [hint({ key: 'hand-written', titleRu: 'Своя подсказка' })],
    })

    expect(map.counts.broken).toBe(0)
    expect(map.counts.live).toBe(1)
  })

  it('counts as PAUSED when the rule is switched off', () => {
    const map = buildTriggerMap({
      rules: [{ ...wildcard(), isEnabled: false }],
      hints: [hint({ key: 'hand-written', titleRu: 'Своя подсказка' })],
    })

    expect(map.counts.live).toBe(0)
    expect(map.counts.paused).toBe(1)
  })
})

describe("the cabinet's own moment", () => {
  it('is not an orphan, though no rule names it', () => {
    // The hints tab tells operators in as many words to author a hint keyed
    // `subscription-ready`; the cabinet raises it itself with no rule involved.
    // The orphan filter then told them no customer would ever see it — two
    // screens of one panel contradicting each other.
    const map = buildTriggerMap({
      rules: [],
      hints: [hint({ key: 'subscription-ready', titleRu: 'Подписка готова' })],
    })

    expect(map.orphanHints).toEqual([])
  })

  it('still lists a genuinely abandoned hand-written hint', () => {
    // The other half: a filter that excused everything would satisfy both cases
    // above while making the section useless.
    const map = buildTriggerMap({
      rules: [],
      hints: [hint({ key: 'hand-written', titleRu: 'Своя подсказка' })],
    })

    expect(map.orphanHints.map((orphan) => orphan.key)).toEqual(['hand-written'])
  })

  it('names exactly the moments the panel lets a cabinet raise', () => {
    // Two screens now read this set: the orphan list here, and «Кто увидит» in
    // the hint editor, which tells the operator "the cabinet shows it by
    // itself" instead of "no rule shows it". Read from the server's closed list
    // rather than restated, so a moment added there cannot come back as a false
    // orphan AND a false "customers will not see it".
    const source = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..', '..', '..', '..',
        'src', 'modules', 'user-hints', 'controllers', 'internal-user-hints.controller.ts',
      ),
      'utf8',
    )
    const declared = /const CLIENT_MOMENTS = \[([^\]]*)\]/.exec(source)?.[1]
    expect(declared, 'CLIENT_MOMENTS was not found in the internal hints controller').toBeDefined()
    const moments = Array.from(declared!.matchAll(/'([^']+)'/g), (match) => match[1]!)
    expect(moments.length, 'CLIENT_MOMENTS was parsed empty').toBeGreaterThan(0)

    expect([...CLIENT_MOMENT_KEYS].sort()).toEqual(moments.sort())
  })
})

describe('rules that name a hint but can never be a path', () => {
  // The map draws a PATH as "this event happens, this pop-up follows". Two
  // kinds of rule name a hint and have no event to hang it from, and the
  // server permits both deliberately — so both were falling through into the
  // orphan list under a sentence saying no customer will ever see the hint.

  it('keeps a MANUAL rule from making its hint look abandoned', () => {
    // How an operator sends one pop-up to one customer. `automations.service`
    // allows `show_hint` on MANUAL in as many words.
    const map = buildTriggerMap({
      rules: [
        rule({
          id: 'manual-1',
          triggerKind: 'MANUAL',
          triggerSpec: '',
          actions: [{ type: 'show_hint', params: { hintKey: 'hand-written' } }],
        }),
      ],
      hints: [hint({ key: 'hand-written', titleRu: 'Своя подсказка' })],
    })

    expect(map.orphanHints).toEqual([])
  })

  it('keeps the nightly audience job from making its hint look abandoned', () => {
    // The flagship CRON pop-up — "paid a day ago and still never connected".
    // Deleting its hint on that advice leaves the job logging "hint was raised
    // but no such hint exists" once per matched customer, nightly, with
    // nothing on any screen.
    const map = buildTriggerMap({
      rules: [
        rule({
          id: 'cron-1',
          triggerKind: 'CRON',
          triggerSpec: '0 9 * * *',
          actions: [{ type: 'show_hint_to_audience', params: { hintKey: 'hand-written' } }],
        }),
      ],
      hints: [hint({ key: 'hand-written', titleRu: 'Своя подсказка' })],
    })

    expect(map.orphanHints).toEqual([])
  })

  it('still calls a hint nothing at all points at an orphan', () => {
    // Anti-vacuity: widening the search must not empty the orphan list.
    const map = buildTriggerMap({
      rules: [],
      hints: [hint({ key: 'hand-written', titleRu: 'Своя подсказка' })],
    })

    expect(map.orphanHints.map((orphan) => orphan.key)).toEqual(['hand-written'])
  })
})

describe('a wildcard rule on a namespace no template covers', () => {
  // `referral.*` is a rule the panel accepts and really fires — both referral
  // events can carry a pop-up. No template names either, so no row on the map
  // is built for them, and the rule matched nothing anywhere: no lane, no
  // count, no `wildcardRuleIds`. Its hint then dropped into "hints nothing
  // points at", captioned "no customer will ever see them".
  const referral = () =>
    rule({
      id: 'referral-rule',
      triggerSpec: 'referral.*',
      actions: [{ type: 'show_hint', params: { hintKey: 'hand-written' } }],
    })

  it('does not report its hint as one nothing points at', () => {
    const map = buildTriggerMap({
      rules: [referral()],
      hints: [hint({ key: 'hand-written', titleRu: 'Своя подсказка' })],
    })

    expect(map.orphanHints).toEqual([])
  })

  it('counts it, so the badges are not silent about a rule that fires', () => {
    const map = buildTriggerMap({
      rules: [referral()],
      hints: [hint({ key: 'hand-written', titleRu: 'Своя подсказка' })],
    })

    expect(map.counts.live).toBe(1)
  })

  it('shows the red badge when its hint does not exist', () => {
    const map = buildTriggerMap({ rules: [referral()], hints: [] })

    expect(map.counts.broken).toBe(1)
  })
})

describe('what a trigger row offers when its only path is broken', () => {
  it('still offers the ready-made pop-ups', () => {
    // The state the map exists to surface: a rule names a hint that has been
    // deleted. The row went red AND lost both templates, so the one screen
    // that reports the failure took away the way to repair it.
    const map = buildTriggerMap({ rules: [rule()], hints: [] })
    const node = nodeFor(map, 'payment.failed')

    expect(node?.paths[0]?.state).toBe('missing-hint')
    // BOTH of them, by name. "At least one" is satisfied by offering only the
    // first template per trigger — which silently drops the second half of all
    // four alternative pairs, and is exactly the regression the sibling case
    // above pins the pair against for a row that is merely bare. A broken row
    // is not a different rule about which offers appear, so it is asserted the
    // same way.
    expect(node?.offers.map((offer) => offer.templateId).sort()).toEqual([
      'payment_failed',
      'payment_failed_method',
    ])
  })

  it('offers nothing while a path is live', () => {
    // Unchanged, and the reason the predicate is not simply "has a path":
    // offering the other half of an alternative pair beside a working one is
    // an invitation to two pop-ups for one act.
    const map = buildTriggerMap({ rules: [rule()], hints: [hint()] })

    expect(nodeFor(map, 'payment.failed')?.offers).toEqual([])
  })

  it('offers nothing while a path is merely paused', () => {
    const map = buildTriggerMap({
      rules: [{ ...rule(), isEnabled: false }],
      hints: [hint()],
    })

    expect(nodeFor(map, 'payment.failed')?.offers).toEqual([])
  })
})

describe('a rule that names the same hint twice', () => {
  it('is one path, not two', () => {
    // The action picker does not exclude a key the rule already uses, so an
    // operator can pick "show a hint" twice and choose the same one. That drew
    // two identical badges under one duplicate React key and read as two live
    // pop-ups in the count.
    const map = buildTriggerMap({
      rules: [
        rule({
          actions: [
            { type: 'show_hint', params: { hintKey: 'tpl-payment-failed' } },
            { type: 'show_hint', params: { hintKey: 'tpl-payment-failed' } },
          ],
        }),
      ],
      hints: [hint()],
    })

    expect(nodeFor(map, 'payment.failed')?.paths).toHaveLength(1)
    expect(map.counts.live).toBe(1)
  })

  it('is still two paths when it names two different hints', () => {
    const map = buildTriggerMap({
      rules: [
        rule({
          actions: [
            { type: 'show_hint', params: { hintKey: 'tpl-payment-failed' } },
            { type: 'show_hint', params: { hintKey: 'hand-written' } },
          ],
        }),
      ],
      hints: [hint(), hint({ id: 'hint-2', key: 'hand-written', titleRu: 'Вторая' })],
    })

    expect(nodeFor(map, 'payment.failed')?.paths).toHaveLength(2)
  })
})

describe('a rule whose hint key is not a usable string', () => {
  /**
   * THE RULE THAT ERASED ITSELF.
   *
   * `params` is JSON and nothing validates an action's parameters at save time,
   * so `hintKey` can come back null, a number, an object or an empty string —
   * from an older install, a hand-edited row, or a form abandoned half way.
   *
   * Every such key was mapped to `''` and filtered out, which took the whole
   * rule with it: `popupRules` keeps only entries that have at least one key.
   * The rule then vanished from the map, its trigger row read as bare, and the
   * row OFFERED a ready-made pop-up — because "nothing is working here" is
   * exactly the state that opens the offers. An operator who accepted the offer
   * had two rules on one trigger, one of them firing into nothing. The rules
   * tab shows the rule as enabled; the hints tab knows nothing about it; this
   * view was the only one that could have said so, and it was the one that
   * deleted the evidence.
   */
  const broken = (hintKey: unknown) =>
    rule({ actions: [{ type: 'show_hint', params: { hintKey } as Record<string, unknown> }] })

  it.each([
    ['null', null],
    ['a number', 42],
    ['an object', { key: 'tpl-payment-failed' }],
    ['an empty string', ''],
    ['blanks', '   '],
    ['nothing at all', undefined],
  ])('keeps the rule on the map when the key is %s', (_label, hintKey) => {
    const map = buildTriggerMap({ rules: [broken(hintKey)], hints: [hint()] })
    const node = nodeFor(map, 'payment.failed')

    expect(node?.paths).toHaveLength(1)
    expect(node?.paths[0]?.ruleId).toBe('rule-1')
    // No hint can answer to it, so it is the state the red badge is for.
    expect(node?.paths[0]?.state).toBe('missing-hint')
    expect(map.counts.broken).toBe(1)
    expect(map.counts.live).toBe(0)
  })

  it('shows the operator WHICH mistake it was', () => {
    // "Something is wrong here" sends somebody to the database. The value does
    // not. It is rendered as JSON so it reads the same in both languages.
    const map = buildTriggerMap({ rules: [broken(null)], hints: [hint()] })

    expect(nodeFor(map, 'payment.failed')?.paths[0]?.hintKey).toBe('<null>')
  })

  it('cannot be mistaken for a hint that really is keyed "null"', () => {
    // `/^[a-z0-9][a-z0-9-]*$/` is the server's key pattern, and `null` passes
    // it. Rendering the broken value unbracketed would have matched a real
    // hint and drawn the rule green.
    const map = buildTriggerMap({
      rules: [broken(null)],
      hints: [hint({ id: 'hint-2', key: 'null', titleRu: 'Ложное совпадение' })],
    })

    expect(nodeFor(map, 'payment.failed')?.paths[0]?.state).toBe('missing-hint')
    expect(nodeFor(map, 'payment.failed')?.paths[0]?.hintTitle).toBeNull()
  })

  it('does not draw a path for a rule that shows no hint at all', () => {
    // Anti-vacuity. Widening this must not turn every Telegram rule into a
    // broken pop-up path — that would put a red badge on rules that are working
    // perfectly, which is how a badge stops being read.
    const map = buildTriggerMap({
      rules: [rule({ actions: [{ type: 'notify_telegram', params: { text: 'x' } }] })],
      hints: [hint()],
    })

    expect(nodeFor(map, 'payment.failed')?.paths).toEqual([])
    expect(map.counts.broken).toBe(0)
  })
})

describe('a trigger the template library does not cover', () => {
  /**
   * THE LANE IT USED TO GET: `'security'`, for everything.
   *
   * The comment called it "the last lane", which is true of the ORDER and false
   * of the MEANING — that lane is headed «Безопасность» and holds one template,
   * about a fraud signal. The events that actually reach it are the referral
   * pair, so an operator's referral pop-up was filed under Security, which is
   * not where anybody looks for it.
   */
  const referralRule = (triggerSpec: string) =>
    rule({
      id: 'referral-rule',
      triggerSpec,
      actions: [{ type: 'show_hint', params: { hintKey: 'hand-written' } }],
    })

  const laneOf = (map: ReturnType<typeof buildTriggerMap>, type: string) =>
    map.lanes.find((lane) => lane.triggers.some((node) => node.type === type))?.stage

  it('files a referral rule under rewards', () => {
    for (const type of ['referral.qualified', 'referral.reward_issued']) {
      const map = buildTriggerMap({
        rules: [referralRule(type)],
        hints: [hint({ key: 'hand-written', titleRu: 'Своя подсказка' })],
      })

      expect(laneOf(map, type), type).toBe('rewards')
    }
  })

  it('knows a lane for every capable event no template covers', () => {
    // THE DURABLE HALF. A capable event added on the server with no template
    // here lands in whatever the residual happens to be, silently — which is
    // exactly how the referral pair ended up under Security. The list is read
    // from the server rather than restated, and this case fails the panel build
    // until somebody decides which lane the new moment belongs to.
    const source = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..', '..', '..', '..',
        'src', 'modules', 'automations', 'popup-capable-events.ts',
      ),
      'utf8',
    )
    const capable = Array.from(
      source.matchAll(/^\s*type:\s*'([^']+)',$/gm),
      (match) => match[1]!,
    )
    expect(capable.length, 'POPUP_CAPABLE_EVENTS was not parsed').toBeGreaterThanOrEqual(10)

    const templated = new Set(HINT_TEMPLATES.map((template) => template.triggerSpec))
    const untemplated = capable.filter((type) => !templated.has(type)).sort()

    expect(untemplated).toEqual(['referral.qualified', 'referral.reward_issued'])
  })

  it('gives a legacy rule the lane its namespace agrees on', () => {
    // Only an install carrying a rule from before the save-time capability
    // check can reach this. Every `payment.*` template is in the payment lane,
    // so a rule on `payment.refunded` belongs there too — it used to be filed
    // under Security beside the fraud signals.
    const map = buildTriggerMap({
      rules: [referralRule('payment.refunded')],
      hints: [hint({ key: 'hand-written', titleRu: 'Своя подсказка' })],
    })

    expect(laneOf(map, 'payment.refunded')).toBe('payment')
  })

  it('lands in «Прочее» when the namespace spans several lanes', () => {
    // `remnawave.user.*` templates sit in start, retention AND limits, so
    // picking one would be picking whichever is declared first. Anti-vacuity
    // for the case above: a rule that always answered "the neighbour's lane"
    // would satisfy it while inventing a lane here.
    const map = buildTriggerMap({
      rules: [referralRule('remnawave.user.online')],
      hints: [hint({ key: 'hand-written', titleRu: 'Своя подсказка' })],
    })

    expect(laneOf(map, 'remnawave.user.online')).toBe('other')
  })
})
