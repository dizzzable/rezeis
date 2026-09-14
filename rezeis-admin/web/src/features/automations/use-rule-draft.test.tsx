/**
 * The rule editor's draft always belongs to the rule it is drawn with.
 *
 * Every render the hook runs is recorded, INCLUDING the one React re-runs
 * because it set state: that render's output is thrown away, so nothing on
 * screen shows what it drew — and it is exactly the render that built the
 * Automations header out of the wrong rule and took the page down after Create
 * (see `use-rule-draft.ts`). Recording from inside the render is the only place
 * it can be seen.
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { AutomationRule } from './automations-api'
import { useRuleDraft } from './use-rule-draft'

function saved(id: string, name: string, updatedAt = '2026-06-04T10:00:00.000Z'): AutomationRule {
  return {
    id,
    name,
    description: null,
    isEnabled: true,
    triggerKind: 'REALTIME',
    triggerSpec: 'payment.failed',
    conditions: null,
    actions: [{ type: 'notify_telegram', params: { text: name } }],
    createdById: 'admin-1',
    lastRunAt: null,
    lastRunStatus: null,
    lastRunMessage: null,
    runCount: 0,
    createdAt: '2026-06-04T10:00:00.000Z',
    updatedAt,
  }
}

interface Drawn {
  readonly given: string | undefined
  readonly rule: string | undefined
  readonly draftName: string | undefined
}

/** Renders the hook for `first`, recording what every render had in hand. */
function renderRecorded(first: AutomationRule | undefined) {
  const drawn: Drawn[] = []
  const hook = renderHook(
    ({ rule }: { rule: AutomationRule | undefined }) => {
      const result = useRuleDraft(rule)
      drawn.push({
        given: rule?.id,
        rule: result.inHand?.rule.id,
        draftName: result.inHand?.draft.name,
      })
      return result
    },
    { initialProps: { rule: first } },
  )
  return { ...hook, drawn }
}

describe('useRuleDraft', () => {
  it("never pairs a rule with another rule's draft, not even in the render that notices the switch", () => {
    const first = saved('rule-first', 'Payment failure alert')
    const second = saved('rule-second', 'Node down alert')
    const nameOf: Record<string, string> = { [first.id]: first.name, [second.id]: second.name }
    const { rerender, drawn } = renderRecorded(first)

    rerender({ rule: second })
    rerender({ rule: first })

    const mismatched = drawn.filter(
      (entry) =>
        entry.rule !== undefined && (entry.rule !== entry.given || entry.draftName !== nameOf[entry.rule]),
    )
    expect(mismatched, 'a draft was drawn with a rule it was not taken from').toEqual([])
    // Anti-vacuity: both rules were actually drawn, the second one included.
    expect(drawn.filter((entry) => entry.rule === second.id)).not.toHaveLength(0)
    expect(drawn.at(-1)).toEqual({ given: first.id, rule: first.id, draftName: first.name })
  })

  it('has nothing to draw while the rule is unread, and draws it in the render it arrives', () => {
    const rule = saved('rule-created', 'First arrival')
    const { rerender, drawn } = renderRecorded(undefined)
    expect(drawn.at(-1)).toEqual({ given: undefined, rule: undefined, draftName: undefined })

    const before = drawn.length
    rerender({ rule })

    expect(drawn[before]).toEqual({ given: rule.id, rule: rule.id, draftName: rule.name })
  })

  it('draws nothing once the rule is gone, rather than the draft it left behind', () => {
    const rule = saved('rule-first', 'Payment failure alert')
    const { rerender, result, drawn } = renderRecorded(rule)

    const before = drawn.length
    rerender({ rule: undefined })

    expect(drawn.slice(before)).not.toHaveLength(0)
    expect(drawn.slice(before).filter((entry) => entry.rule !== undefined)).toEqual([])
    expect(result.current.inHand).toBeNull()
  })

  it("keeps the operator's typing across a re-read that changed nothing", () => {
    const rule = saved('rule-first', 'Payment failure alert')
    const { rerender, result } = renderRecorded(rule)

    act(() => {
      result.current.setDraft({ ...result.current.inHand!.draft, name: 'Typed by the operator' })
    })
    // A refetch hands over a NEW object for the same save.
    rerender({ rule: { ...rule, actions: [...rule.actions] } })

    expect(result.current.inHand?.draft.name).toBe('Typed by the operator')
  })

  it('takes the newer copy when the same rule comes back saved again', () => {
    const rule = saved('rule-first', 'Payment failure alert')
    const { rerender, result } = renderRecorded(rule)

    act(() => {
      result.current.setDraft({ ...result.current.inHand!.draft, name: 'Typed by the operator' })
    })
    rerender({ rule: saved(rule.id, 'Saved elsewhere', '2026-06-05T10:00:00.000Z') })

    expect(result.current.inHand?.draft.name).toBe('Saved elsewhere')
  })

  it("keeps the operator's typing when the rule comes back having only run", () => {
    const rule = saved('rule-first', 'Payment failure alert')
    const { rerender, result } = renderRecorded(rule)

    act(() => {
      result.current.setDraft({ ...result.current.inHand!.draft, name: 'Typed by the operator' })
    })
    // What an execution writes to the rule: its run columns — and, through
    // `@updatedAt`, its `updatedAt`. Nothing the operator edits.
    rerender({
      rule: {
        ...rule,
        runCount: 1,
        lastRunAt: '2026-06-05T10:00:00.000Z',
        lastRunStatus: 'SUCCEEDED',
        updatedAt: '2026-06-05T10:00:00.000Z',
      },
    })

    expect(result.current.inHand?.draft.name).toBe('Typed by the operator')
    // The rule in hand is still the newer read, so the header counts the run.
    expect(result.current.inHand?.rule.runCount).toBe(1)
  })

  it('starts an unsaved draft over when one is opened again, even with the same words', () => {
    // A draft has no id yet; the page stamps each one with the moment it opened.
    function opened(at: string): AutomationRule {
      return { ...saved('', 'Untitled rule', at), createdById: null, isEnabled: false, createdAt: at }
    }
    const { rerender, result } = renderRecorded(opened('2026-06-04T10:00:00.000Z'))

    act(() => {
      result.current.setDraft({ ...result.current.inHand!.draft, name: 'Typed by the operator' })
    })
    rerender({ rule: opened('2026-06-04T10:00:07.000Z') })

    expect(result.current.inHand?.draft.name).toBe('Untitled rule')
  })
})
