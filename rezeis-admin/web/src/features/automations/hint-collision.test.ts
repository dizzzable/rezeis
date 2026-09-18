import { describe, expect, it } from 'vitest'

import { findHintCollisions, findHintCollisionsWithCompanions } from './hint-collision'
import type { AutomationRule } from './automations-api'
import type { UserHint } from '@/features/user-hints/user-hints-api'

/**
 * Four modals for one purchase
 * ════════════════════════════
 *
 * A first purchase through a referral link with a promo code emits four events
 * within a second or two. A hint bound to each is four windows for one act, and
 * a customer who meets four learns to close them unread — taking the useful
 * ones with them.
 *
 * The queue's `groupKey` already collapses that. What it cannot do is tell the
 * operator they needed one. This is what does.
 */

const GROUPS = [
  ['payment.completed', 'subscription.created', 'referral.qualified', 'promocode.activated'],
  ['payment.completed', 'subscription.renewed'],
]

function hint(over: Partial<UserHint> = {}): UserHint {
  return {
    id: 'h-' + (over.key ?? 'a'),
    key: 'a',
    titleRu: 'Подсказка',
    bodyRu: '',
    titleEn: null,
    bodyEn: null,
    mode: 'MODAL',
    tone: 'INFO',
    ctaKind: 'NONE',
    ctaLabelRu: null,
    ctaLabelEn: null,
    ctaTarget: null,
    surfaces: [],
    formFactors: [],
    groupKey: null,
    ttlHours: 168,
    isRepeatable: false,
    isActive: true,
    createdAt: '',
    updatedAt: '',
    ...over,
  }
}

function rule(over: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'r-other',
    name: 'Другое правило',
    description: null,
    isEnabled: true,
    triggerKind: 'REALTIME',
    triggerSpec: 'subscription.created',
    conditions: null,
    actions: [{ type: 'show_hint', params: { hintKey: 'b' } }],
    createdById: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunMessage: null,
    runCount: 0,
    createdAt: '',
    updatedAt: '',
    ...over,
  } as AutomationRule
}

const DRAFT: {
  id: string
  triggerKind: string
  triggerSpec: string
  actions: Array<{ type: string; params: Record<string, unknown> }>
} = {
  id: 'r-mine',
  triggerKind: 'REALTIME',
  triggerSpec: 'payment.completed',
  actions: [{ type: 'show_hint', params: { hintKey: 'a' } }],
}

function find(over: {
  draft?: Partial<typeof DRAFT>
  rules?: AutomationRule[]
  hints?: UserHint[]
} = {}) {
  return findHintCollisions({
    draft: { ...DRAFT, ...over.draft },
    rules: over.rules ?? [rule()],
    hints: over.hints ?? [hint({ key: 'a' }), hint({ key: 'b', titleRu: 'Вторая' })],
    coincidentEventGroups: GROUPS,
  })
}

describe('spotting a second hint for the same act', () => {
  it('finds a rule on an event that arrives alongside this one', () => {
    const found = find()

    expect(found).toHaveLength(1)
    expect(found[0].hintTitle).toBe('Вторая')
    expect(found[0].triggerSpec).toBe('subscription.created')
  })

  it('follows every group the trigger belongs to', () => {
    // `payment.completed` sits in both the purchase group and the renewal one:
    // they are different acts that share an event, and collapsing them into a
    // single group would warn about a pair that never co-occurs.
    const found = find({ rules: [rule({ triggerSpec: 'subscription.renewed' })] })

    expect(found).toHaveLength(1)
  })

  it('says nothing about an unrelated event', () => {
    expect(find({ rules: [rule({ triggerSpec: 'node.offline' })] })).toEqual([])
  })
})

describe('what is deliberately not a collision', () => {
  it('two hints in the same group', () => {
    // THE case the warning must stay quiet about. Supersession already leaves
    // the customer one window, and warning about something the system handles
    // is how a warning gets ignored — and the next one with it.
    const found = find({
      hints: [hint({ key: 'a', groupKey: 'purchase' }), hint({ key: 'b', groupKey: 'purchase' })],
    })

    expect(found).toEqual([])
  })

  it('two hints in DIFFERENT groups still collide', () => {
    // A group only suppresses within itself. Different groups means two rows
    // survive, which means two windows.
    const found = find({
      hints: [hint({ key: 'a', groupKey: 'purchase' }), hint({ key: 'b', groupKey: 'referral' })],
    })

    expect(found).toHaveLength(1)
  })

  it('a rule that is switched off', () => {
    expect(find({ rules: [rule({ isEnabled: false })] })).toEqual([])
  })

  it('a hint that is switched off', () => {
    const found = find({
      hints: [hint({ key: 'a' }), hint({ key: 'b', isActive: false })],
    })

    expect(found).toEqual([])
  })

  it('the rule being edited, against itself', () => {
    const found = find({ rules: [rule({ id: 'r-mine', triggerSpec: 'subscription.created' })] })

    expect(found).toEqual([])
  })

  it('a draft that shows no hint at all', () => {
    const found = find({
      draft: { actions: [{ type: 'notify_telegram', params: { text: 'hi' } }] },
    })

    expect(found).toEqual([])
  })

  it('a scheduled rule, which does not race an event', () => {
    const found = find({ draft: { triggerKind: 'CRON', triggerSpec: '0 9 * * *' } })

    expect(found).toEqual([])
  })

  it('a rule whose hint nobody authored', () => {
    // It queues nothing, so it cannot produce a second window. The engine logs
    // that separately; the editor has no reason to describe it as a collision.
    const found = find({ hints: [hint({ key: 'a' })] })

    expect(found).toEqual([])
  })
})

describe('two rules on the same trigger', () => {
  /**
   * THE PAIRS THIS PANEL PROMISES TO WARN ABOUT.
   *
   * The library ships four deliberate alternatives that share a trigger — two
   * answers to a failed payment, a loud and a quiet expiry warning, a renewal
   * prompt and a win-back offer, a modal and a toast for a promo code — and the
   * map offers the second right beside the first, so enabling both is an
   * ordinary mistake.
   *
   * They fire together by definition, needing no coincident group at all. The
   * warning was built only out of the OTHER events in a group, so a rule whose
   * trigger equalled the draft's was never even a candidate, and all four pairs
   * were silent while a template description said the panel "says so out loud".
   */
  const hint = (over: Partial<UserHint> = {}): UserHint =>
    ({
      id: 'h1',
      key: 'tpl-payment-failed',
      titleRu: 'Оплата не прошла',
      groupKey: null,
      isActive: true,
      ...over,
    }) as UserHint

  const rule = (over: Record<string, unknown> = {}) =>
    ({
      id: 'rule-other',
      name: 'Второе окно',
      isEnabled: true,
      triggerKind: 'REALTIME',
      triggerSpec: 'payment.failed',
      actions: [{ type: 'show_hint', params: { hintKey: 'tpl-payment-failed-method' } }],
      ...over,
    }) as never

  it('warns, even with no coincident group between them', () => {
    const collisions = findHintCollisions({
      draft: {
        id: 'rule-mine',
        triggerKind: 'REALTIME',
        triggerSpec: 'payment.failed',
        actions: [{ type: 'show_hint', params: { hintKey: 'tpl-payment-failed' } }],
      },
      rules: [rule()],
      hints: [hint(), hint({ id: 'h2', key: 'tpl-payment-failed-method' })],
      coincidentEventGroups: [],
    })

    expect(collisions).toHaveLength(1)
    expect(collisions[0].ruleName).toBe('Второе окно')
  })

  it('does not warn about the rule being edited itself', () => {
    // The draft is in the saved list too, once it has been saved once. Warning
    // about itself would put a permanent warning under every rule.
    const collisions = findHintCollisions({
      draft: {
        id: 'rule-mine',
        triggerKind: 'REALTIME',
        triggerSpec: 'payment.failed',
        actions: [{ type: 'show_hint', params: { hintKey: 'tpl-payment-failed' } }],
      },
      rules: [rule({ id: 'rule-mine' })],
      hints: [hint(), hint({ id: 'h2', key: 'tpl-payment-failed-method' })],
      coincidentEventGroups: [],
    })

    expect(collisions).toEqual([])
  })

  it('warns when the key it names is stored with a trailing space', () => {
    // EVERY OTHER READER OF THIS FIELD TRIMS IT. The engine's `readString`
    // trims before it looks the hint up, so the rule fires; `trigger-map.ts`
    // trims, so the map draws it green. This one did not, found no hint under
    // `"tpl-payment-failed-method "`, and dropped the rule — so the pop-up that
    // will genuinely open beside the draft was the one the warning could not
    // see.
    const collisions = findHintCollisions({
      draft: {
        id: 'rule-mine',
        triggerKind: 'REALTIME',
        triggerSpec: 'payment.failed',
        actions: [{ type: 'show_hint', params: { hintKey: '  tpl-payment-failed ' } }],
      },
      rules: [rule({ actions: [{ type: 'show_hint', params: { hintKey: 'tpl-payment-failed-method\t' } }] })],
      hints: [hint(), hint({ id: 'h2', key: 'tpl-payment-failed-method' })],
      coincidentEventGroups: [],
    })

    expect(collisions).toHaveLength(1)
    expect(collisions[0].ruleName).toBe('Второе окно')
  })

  it('warns about a second rule showing the SAME hint on the same event — the owner’s welcome', () => {
    // The owner already has an enabled «Первое появление» on the Telegram
    // sign-up. Applying the welcome for everyone opens a draft on that very
    // event with that very hint: the most direct way to get the same window
    // twice. Checked with ONE key on both sides, which the pair above never is.
    const collisions = findHintCollisions({
      draft: {
        triggerKind: 'REALTIME',
        triggerSpec: 'user.registered',
        actions: [{ type: 'show_hint', params: { hintKey: 'tpl-welcome' } }],
      },
      rules: [
        rule({
          id: 'rule-welcome',
          name: 'Первое появление',
          triggerSpec: 'user.registered',
          actions: [{ type: 'show_hint', params: { hintKey: 'tpl-welcome' } }],
        }),
      ],
      hints: [hint({ id: 'h-welcome', key: 'tpl-welcome', titleRu: 'Добро пожаловать' })],
      coincidentEventGroups: [],
    })

    expect(collisions).toEqual([
      {
        ruleId: 'rule-welcome',
        ruleName: 'Первое появление',
        triggerSpec: 'user.registered',
        hintTitle: 'Добро пожаловать',
      },
    ])
  })

  it('still says nothing when the two share a group', () => {
    // Supersession handles that, and warning about a case the system already
    // handles is how a warning stops being read.
    const collisions = findHintCollisions({
      draft: {
        id: 'rule-mine',
        triggerKind: 'REALTIME',
        triggerSpec: 'payment.failed',
        actions: [{ type: 'show_hint', params: { hintKey: 'tpl-payment-failed' } }],
      },
      rules: [rule()],
      hints: [
        hint({ groupKey: 'payment-attempt' }),
        hint({ id: 'h2', key: 'tpl-payment-failed-method', groupKey: 'payment-attempt' }),
      ],
      coincidentEventGroups: [],
    })

    expect(collisions).toEqual([])
  })
})

describe('a rule that reaches the same event through a wildcard', () => {
  /**
   * THE HOLE THE WARNING WAS BLIND TO.
   *
   * The bridge selects rules with `matchEventPattern`, so `payment.*` fires for
   * `payment.failed` and `*` fires for everything — and the editor's own help
   * text advertises both. This module compared the two SPECS as strings, which
   * answers "different event" for every pair where one of them is a wildcard.
   *
   * So the operator with a `*` rule already delivering a pop-up on every event
   * in the product added a second one on a concrete trigger, got two windows
   * for one act, and the one panel built to say so said nothing.
   */
  const wildHint = (over: Partial<UserHint> = {}): UserHint =>
    ({
      id: 'h1',
      key: 'tpl-payment-failed',
      titleRu: 'Оплата не прошла',
      groupKey: null,
      isActive: true,
      ...over,
    }) as UserHint

  const wildRule = (over: Record<string, unknown> = {}) =>
    ({
      id: 'rule-other',
      name: 'Второе окно',
      isEnabled: true,
      triggerKind: 'REALTIME',
      triggerSpec: 'payment.*',
      actions: [{ type: 'show_hint', params: { hintKey: 'tpl-payment-failed-method' } }],
      ...over,
    }) as never

  const both = () => [wildHint(), wildHint({ id: 'h2', key: 'tpl-payment-failed-method' })]

  function collide(draftSpec: string, ruleSpec: string, groups: string[][] = []) {
    return findHintCollisions({
      draft: {
        id: 'rule-mine',
        triggerKind: 'REALTIME',
        triggerSpec: draftSpec,
        actions: [{ type: 'show_hint', params: { hintKey: 'tpl-payment-failed' } }],
      },
      rules: [wildRule({ triggerSpec: ruleSpec })],
      hints: both(),
      coincidentEventGroups: groups,
    })
  }

  it('warns when the SAVED rule is the wildcard', () => {
    expect(collide('payment.failed', 'payment.*')).toHaveLength(1)
  })

  it('warns when the DRAFT is the wildcard', () => {
    // The other direction, and the one an operator is least likely to catch
    // unaided: they are looking at `payment.*` and the concrete rule is
    // somewhere down a list.
    expect(collide('payment.*', 'payment.failed')).toHaveLength(1)
  })

  it('warns about a rule bound to everything', () => {
    // `*` is the wildcard the rule editor's own help text advertises, and it
    // collides with every pop-up rule in the install.
    expect(collide('subscription.created', '*')).toHaveLength(1)
    expect(collide('*', 'subscription.created')).toHaveLength(1)
  })

  it('warns about two namespaces where one contains the other', () => {
    expect(collide('payment.*', 'payment.gateway.*')).toHaveLength(1)
  })

  it('follows a wildcard into the events that arrive beside the one it selects', () => {
    // `payment.*` selects `payment.completed`, so everything declared to arrive
    // beside a purchase arrives beside this rule too — the coincident groups
    // have to be reached through the pattern, not by looking the spec up in
    // them verbatim.
    expect(
      collide('payment.*', 'subscription.created', [
        ['payment.completed', 'subscription.created'],
      ]),
    ).toHaveLength(1)
  })

  it('says nothing about a namespace it has no event in common with', () => {
    // Anti-vacuity: an overlap test that answered "yes" to everything would
    // satisfy every case above and put a permanent warning under every rule.
    expect(collide('payment.failed', 'referral.*')).toEqual([])
    expect(collide('referral.*', 'payment.failed')).toEqual([])
    expect(collide('payment.*', 'subscription.*')).toEqual([])
  })

  it('says nothing for a rule with no trigger at all', () => {
    // An empty pattern selects nothing at run time, so it cannot be a second
    // window — and reading it as "matches everything" would warn about every
    // half-typed rule in the list.
    expect(collide('payment.failed', '   ')).toEqual([])
    expect(collide('   ', 'payment.failed')).toEqual([])
  })
})

describe('a draft that «Создать» saves with companion rules', () => {
  /**
   * «Первое появление» for everyone is a draft on the Telegram sign-up and a
   * companion — the same rule — on the site sign-up. The companion exists only
   * as a line on the draft until «Создать», so it is in no rule list, and a
   * check over the draft's own event could not see the second window it adds.
   */
  const welcome = (over: Partial<UserHint> = {}): UserHint =>
    ({ id: 'h-welcome', key: 'tpl-welcome', titleRu: 'Добро пожаловать', groupKey: null, isActive: true, ...over }) as UserHint

  const onSite = (over: Record<string, unknown> = {}) =>
    ({
      id: 'rule-site',
      name: 'Приветствие на сайте',
      isEnabled: true,
      triggerKind: 'REALTIME',
      triggerSpec: 'user.web_registered',
      actions: [{ type: 'show_hint', params: { hintKey: 'tpl-welcome-web' } }],
      ...over,
    }) as never

  const input = (rules: never[]) => ({
    draft: {
      triggerKind: 'REALTIME',
      triggerSpec: 'user.registered',
      actions: [{ type: 'show_hint', params: { hintKey: 'tpl-welcome' } }],
    },
    rules,
    hints: [welcome(), welcome({ id: 'h-web', key: 'tpl-welcome-web', titleRu: 'Добро пожаловать на сайт' })],
    coincidentEventGroups: [] as string[][],
  })

  it('warns about a rule on a companion’s event', () => {
    expect(findHintCollisions(input([onSite()]))).toEqual([])
    expect(findHintCollisionsWithCompanions(input([onSite()]), ['user.web_registered'])).toEqual([
      {
        ruleId: 'rule-site',
        ruleName: 'Приветствие на сайте',
        triggerSpec: 'user.web_registered',
        hintTitle: 'Добро пожаловать на сайт',
      },
    ])
  })

  it('still warns about the draft’s own event', () => {
    const onTelegram = onSite({
      id: 'rule-telegram',
      name: 'Приветствие в Telegram',
      triggerSpec: 'user.registered',
      actions: [{ type: 'show_hint', params: { hintKey: 'tpl-welcome' } }],
    })
    expect(
      findHintCollisionsWithCompanions(input([onTelegram]), ['user.web_registered']).map((c) => c.ruleId),
    ).toEqual(['rule-telegram'])
  })

  it('lists a rule once when it collides through more than one of the events', () => {
    // A `user.*` rule fires beside the draft AND beside its companion.
    const everySignUp = onSite({ id: 'rule-wild', name: 'Все регистрации', triggerSpec: 'user.*' })
    expect(
      findHintCollisionsWithCompanions(input([everySignUp]), ['user.web_registered']).map((c) => c.ruleId),
    ).toEqual(['rule-wild'])
  })

  it('is the plain check when there are no companions', () => {
    // Inputs where the answer is not empty either way: a rule on the draft's
    // own event collides, and a rule on the site sign-up only would through a
    // companion that is not there.
    const onTelegram = onSite({
      id: 'rule-telegram',
      name: 'Приветствие в Telegram',
      triggerSpec: 'user.registered',
      actions: [{ type: 'show_hint', params: { hintKey: 'tpl-welcome' } }],
    })
    const both = input([onTelegram, onSite()])

    const plain = findHintCollisions(both)
    expect(plain.map((c) => c.ruleId)).toEqual(['rule-telegram'])
    expect(findHintCollisionsWithCompanions(both, [])).toEqual(plain)
    // Anti-vacuity: the same inputs with the companion reach the site rule too.
    expect(findHintCollisionsWithCompanions(both, ['user.web_registered']).map((c) => c.ruleId)).toEqual([
      'rule-telegram',
      'rule-site',
    ])
  })
})
