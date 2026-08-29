import { describe, expect, it } from 'vitest'

import { findHintCollisions } from './hint-collision'
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
