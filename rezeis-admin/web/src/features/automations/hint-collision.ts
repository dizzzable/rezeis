import type { AutomationRule } from './automations-api'
import type { UserHint } from '@/features/user-hints/user-hints-api'

/**
 * One rule that will fire alongside the one being edited, and show a second hint.
 */
export interface HintCollision {
  readonly ruleId: string
  readonly ruleName: string
  /** The event that other rule listens to. */
  readonly triggerSpec: string
  /** The hint it would show. */
  readonly hintTitle: string
}

interface CollisionInput {
  /** The rule as it stands in the editor, saved or not. */
  readonly draft: {
    readonly id?: string
    readonly triggerKind: string
    readonly triggerSpec: string
    /**
     * EVERY action on the rule, not only the hint ones — the helper filters.
     * Typed loosely on purpose: a caller that had to pre-filter would need to
     * know which action type matters, which is the one thing this module is
     * for knowing.
     */
    readonly actions: ReadonlyArray<{ type: string; params: Record<string, unknown> }>
  }
  readonly rules: readonly AutomationRule[]
  readonly hints: readonly UserHint[]
  readonly coincidentEventGroups: readonly (readonly string[])[]
}

function hintKeysOf(actions: CollisionInput['draft']['actions']): string[] {
  return actions
    .filter((action) => action.type === 'show_hint')
    .map((action) => (typeof action.params?.hintKey === 'string' ? action.params.hintKey : ''))
    .filter((key) => key.length > 0)
}

/**
 * Which other rules would put a SECOND hint in front of the same customer for
 * the same act.
 *
 * ── The problem this describes ────────────────────────────────────────────
 *
 * A first purchase through a referral link with a promo code emits four events
 * within a second or two. A hint bound to each is four modals for one act, and
 * a customer who meets four modals learns to close them unread — taking the
 * useful ones with them.
 *
 * ── Why it warns instead of refusing ──────────────────────────────────────
 *
 * Because it can be right on purpose. Two hints for one purchase, shown one
 * per visit, is a defensible sequence — it is only a mistake when nobody meant
 * it. The editor says what will happen and leaves the decision.
 *
 * ── Why a shared group is NOT a collision ─────────────────────────────────
 *
 * That is exactly what `groupKey` is for: the newer hint supersedes the older
 * unshown one and the customer sees one modal. Warning about a case the system
 * already handles is how a warning gets ignored, and the next one with it. So
 * two hints sharing a non-empty group are silently fine — and the surviving
 * warnings are only the ones that will genuinely produce two windows.
 */
export function findHintCollisions(input: CollisionInput): HintCollision[] {
  const { draft, rules, hints, coincidentEventGroups } = input
  if (draft.triggerKind !== 'REALTIME') return []

  const draftHintKeys = hintKeysOf(draft.actions)
  if (draftHintKeys.length === 0) return []

  const byKey = new Map(hints.map((hint) => [hint.key, hint]))
  const draftGroups = new Set(
    draftHintKeys
      .map((key) => byKey.get(key)?.groupKey)
      .filter((group): group is string => typeof group === 'string' && group.length > 0),
  )

  // The events that arrive alongside this rule's own trigger. A trigger can sit
  // in more than one group — `payment.completed` belongs to a purchase and to a
  // renewal — so every group it appears in contributes.
  const coincident = new Set<string>()
  for (const group of coincidentEventGroups) {
    if (!group.includes(draft.triggerSpec)) continue
    for (const event of group) {
      if (event !== draft.triggerSpec) coincident.add(event)
    }
  }
  if (coincident.size === 0) return []

  const collisions: HintCollision[] = []
  for (const rule of rules) {
    if (rule.id === draft.id) continue
    if (!rule.isEnabled) continue
    if (rule.triggerKind !== 'REALTIME') continue
    if (!coincident.has(rule.triggerSpec)) continue

    for (const key of hintKeysOf(rule.actions)) {
      const hint = byKey.get(key)
      if (hint === undefined || !hint.isActive) continue
      // Handled by supersession — not a collision. See the note above.
      if (hint.groupKey !== null && draftGroups.has(hint.groupKey)) continue
      collisions.push({
        ruleId: rule.id,
        ruleName: rule.name,
        triggerSpec: rule.triggerSpec,
        hintTitle: hint.titleRu,
      })
    }
  }
  return collisions
}
