import type { AutomationRule, UpsertRulePayload } from './automations-api'

/**
 * rule-companions
 * ───────────────
 * Rules a draft brings with it, created together with it when «Создать» is
 * pressed.
 *
 * Only one plan produces them today: «Первое появление» for everyone is one
 * hint and TWO rules, because the trigger grammar has no "either of these
 * events" and the two sign-ups are two different events (`planArrival` in
 * `hint-templates.ts`). The draft is the rule on one of them; each companion is
 * the same rule — same actions, same conditions, same switch — on another.
 */

/** A further rule the draft creates, named and aimed. */
export interface DraftCompanion {
  /** The event the companion rule fires on. */
  readonly triggerSpec: string
  /** Its name in the rule list, already in the operator's language. */
  readonly name: string
}

/** The unsaved rule the editor opens, and the rules «Создать» adds to it. */
export interface DraftSeed {
  readonly rule: AutomationRule
  readonly companions: readonly DraftCompanion[]
}

/**
 * The companions that still apply to the draft as it stands.
 *
 * ONLY WHILE THE DRAFT FIRES ON AN EVENT. A companion is "this rule, on another
 * event"; a draft switched to a schedule or to manual runs has no event for a
 * companion to be the other half of.
 *
 * AND NEVER ON THE DRAFT'S OWN EVENT. An operator who retargets the draft onto
 * the companion's event would otherwise create two identical rules on one event
 * — two windows for one sign-up.
 *
 * Derived on every render rather than written back into state, so undoing the
 * edit brings the companion back.
 */
export function companionsInForce(
  draft: { readonly triggerKind: string; readonly triggerSpec: string },
  companions: readonly DraftCompanion[],
): readonly DraftCompanion[] {
  if (draft.triggerKind !== 'REALTIME') return []
  const own = draft.triggerSpec.trim()
  return companions.filter((companion) => companion.triggerSpec.trim() !== own)
}

/** What a companion is created with: the draft's payload, under its own name and event. */
export function companionPayload(
  payload: UpsertRulePayload,
  companion: DraftCompanion,
): UpsertRulePayload {
  return { ...payload, name: companion.name, triggerSpec: companion.triggerSpec }
}
