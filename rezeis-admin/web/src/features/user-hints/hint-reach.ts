import type { AutomationRule } from '@/features/automations/automations-api'
import {
  canCarryPopup,
  isKnownAudience,
  isWildcardPattern,
  surfaceGap,
  usesOfHint,
  type HintSurface,
  type HintUse,
} from '@/features/automations/popup-audience'
import { CLIENT_MOMENT_KEYS } from '@/features/automations/trigger-map'

/**
 * hint-reach
 * ──────────
 * «Кто увидит» — who a hint being edited reaches, computed from the rules and
 * from the DRAFT, so it changes while the operator types.
 *
 * ── Why the hint editor needs this at all ─────────────────────────────────
 *
 * A hint does not choose its audience. The rule that calls it does: its event
 * names the customer the hint is queued for. The editor only ever showed the
 * other half — «Где показывать», where the cabinet may DRAW it — and the owner
 * read that as "whom". He ticked «Браузер» on the welcome whose rule listens to
 * the Telegram sign-up, and every delivery lapsed unseen: the people that rule
 * greets open the cabinet inside Telegram. Nothing on either tab put the two
 * answers side by side, so this computes the first one where the second is
 * edited.
 *
 * ── A rule that names the key is not always a rule that shows it ──────────
 *
 * Some shapes fail on every run: an audience action with no audience or on an
 * event, a pop-up on a schedule. Such a rule is listed — the operator has to
 * see what is wrong with it — but it is not counted as a use: a hint only
 * rules like that call is a hint no customer sees.
 *
 * And one shape is UNCERTAIN: a realtime rule on an event the panel has not
 * checked. It may never fire, it may fail, or it may work — an unlisted event
 * that names a customer does. It is listed as unchecked and not counted as a
 * working use, and nothing here says customers will not see it.
 */

/** Whom one rule's use of the hint reaches, in the terms the panel can state. */
export type ReachWhom =
  /** A realtime `show_hint` on one event: whoever that event names. */
  | { readonly kind: 'event'; readonly event: string }
  /** A realtime `show_hint` on a pattern: whoever any matching event names. */
  | { readonly kind: 'wildcard'; readonly pattern: string }
  /** `show_hint` on a MANUAL rule: the customer an operator names on «Запустить сейчас». */
  | { readonly kind: 'manual' }
  /** `show_hint_to_audience`: the people its query selects, when the rule runs. */
  | {
      readonly kind: 'audience'
      readonly audience: string
      readonly when: 'schedule' | 'manual'
    }
  // ── Uncertain ─────────────────────────────────────────────────────────────
  /**
   * A realtime `show_hint` on a spec the panel has not checked (`canCarryPopup`
   * is false): only the rule's run log says whether the event arrives and names
   * a customer. `payment*` belongs here too — to the server's grammar it is an
   * exact string, not a wildcard.
   */
  | { readonly kind: 'unverified'; readonly event: string }
  // ── Shapes that fail on every run ─────────────────────────────────────────
  /**
   * `show_hint` on a CRON rule. Refused at save time now; an older install can
   * still hold one, and a schedule names nobody, so every run fails.
   */
  | { readonly kind: 'schedule-names-nobody' }
  /**
   * `show_hint_to_audience` on an event. Refused at save time now; an older row
   * fails on every event it matches.
   */
  | { readonly kind: 'audience-on-event' }
  /** `show_hint_to_audience` with no audience, or one the panel does not know. */
  | { readonly kind: 'audience-invalid' }

/** Whether a use shows the hint: yes, not known, or certainly not. */
export type ReachStatus = 'working' | 'unverified' | 'failing'

function statusOf(whom: ReachWhom): ReachStatus {
  switch (whom.kind) {
    case 'unverified':
      return 'unverified'
    case 'schedule-names-nobody':
    case 'audience-on-event':
    case 'audience-invalid':
      return 'failing'
    default:
      return 'working'
  }
}

export function whomOf(use: HintUse): ReachWhom {
  if (use.action === 'show_hint_to_audience') {
    // The server's own order: the event check refuses before the audience is read.
    if (use.triggerKind === 'REALTIME') return { kind: 'audience-on-event' }
    if (use.audience === null || !isKnownAudience(use.audience)) return { kind: 'audience-invalid' }
    return {
      kind: 'audience',
      audience: use.audience,
      when: use.triggerKind === 'MANUAL' ? 'manual' : 'schedule',
    }
  }
  if (use.triggerKind === 'MANUAL') return { kind: 'manual' }
  if (use.triggerKind === 'CRON') return { kind: 'schedule-names-nobody' }
  const spec = use.triggerSpec.trim()
  if (!canCarryPopup(spec)) return { kind: 'unverified', event: spec }
  return isWildcardPattern(spec) ? { kind: 'wildcard', pattern: spec } : { kind: 'event', event: spec }
}

/** One rule that names the hint, and whether it shows it. */
export interface ReachLine {
  readonly use: HintUse
  readonly whom: ReachWhom
  readonly status: ReachStatus
}

/** Something about the draft an operator has to be told, in the order it is drawn. */
export type ReachNotice =
  /**
   * Another hint already has this key. Saving answers 409, and every rule and
   * gap on that key belongs to the other hint, so nothing else is said.
   */
  | { readonly kind: 'key-taken'; readonly key: string }
  /** The rules could not be read. Never "no rule": that would be a guess. */
  | { readonly kind: 'rules-unreadable' }
  /** No key yet, so no rule can be matched against it. */
  | { readonly kind: 'blank-key' }
  /** The cabinet raises this key itself, with no rule. */
  | { readonly kind: 'client-moment' }
  /** The saved key is one the cabinet raises, and the draft renames it away. */
  | { readonly kind: 'renamed-client-moment'; readonly savedKey: string }
  /** Rules that show, or may show, the saved key would lose it to the rename. */
  | { readonly kind: 'renamed'; readonly savedKey: string; readonly ruleNames: readonly string[] }
  /** Nothing calls this key, so no customer will see it. */
  | { readonly kind: 'no-rule' }
  /** Rules call this key, and every one of them fails on every run. */
  | { readonly kind: 'no-working-rule' }
  /**
   * Nothing calls this key in a shape known to work, and at least one rule on an
   * event the panel has not checked does: customers see it only if that event
   * arrives and names a customer. Said instead of `no-working-rule`, which would
   * be a guess about the unchecked rule.
   */
  | { readonly kind: 'only-unverified' }
  /**
   * A realtime rule greets customers who open the cabinet somewhere this draft
   * does not allow — the owner's case.
   */
  | {
      readonly kind: 'surface-gap'
      readonly ruleId: string
      readonly ruleName: string
      readonly event: string
      /** Where that event's customers are, and the hint may not appear. */
      readonly home: readonly HintSurface[]
      /** What the draft allows. Never empty here: an unlimited hint has no gap. */
      readonly ticked: readonly string[]
    }
  /** The draft is switched off. */
  | { readonly kind: 'inactive' }

export interface HintReachInput {
  readonly key: string
  /** The key as saved, or `null` for a hint that has not been saved yet. */
  readonly savedKey: string | null
  /** The keys of every OTHER hint in the library. */
  readonly otherKeys: readonly string[]
  readonly surfaces: readonly string[]
  readonly isActive: boolean
  /** The rules, or `'loading'`, or `'unreadable'` when they could not be read. */
  readonly rules: readonly AutomationRule[] | 'loading' | 'unreadable'
}

export interface HintReach {
  /** Every rule that names the draft's key, switched on first. */
  readonly lines: readonly ReachLine[]
  readonly notices: readonly ReachNotice[]
}

function linesFor(key: string, rules: readonly AutomationRule[]): ReachLine[] {
  return usesOfHint(key, rules).map((use) => {
    const whom = whomOf(use)
    return { use, whom, status: statusOf(whom) }
  })
}

export function hintReach(input: HintReachInput): HintReach {
  const key = input.key.trim()

  // ANOTHER HINT'S KEY. Whatever calls it calls that hint, not this draft:
  // attributing its rules and its surface gaps here described a different
  // hint, and the save that followed failed with a conflict.
  if (key.length > 0 && input.otherKeys.some((other) => other.trim() === key)) {
    return { lines: [], notices: [{ kind: 'key-taken', key }] }
  }

  const savedKey = input.savedKey === null ? '' : input.savedKey.trim()
  const renamed = savedKey.length > 0 && savedKey !== key
  const isClientMoment = CLIENT_MOMENT_KEYS.has(key)

  const notices: ReachNotice[] = []
  const rules = Array.isArray(input.rules) ? (input.rules as readonly AutomationRule[]) : null

  if (input.rules === 'unreadable') notices.push({ kind: 'rules-unreadable' })
  if (key.length === 0) notices.push({ kind: 'blank-key' })
  if (isClientMoment) notices.push({ kind: 'client-moment' })
  if (renamed && CLIENT_MOMENT_KEYS.has(savedKey)) {
    notices.push({ kind: 'renamed-client-moment', savedKey })
  }

  const lines = rules === null ? [] : linesFor(key, rules)
  const working = lines.filter((line) => line.status === 'working')

  if (rules !== null) {
    if (renamed) {
      // Rules that show the old key lose it — and so may rules on an unchecked
      // event, which may well be working. Only a rule that fails on every run
      // fails the same way whatever the key is called.
      const stale = linesFor(savedKey, rules).filter((line) => line.status !== 'failing')
      if (stale.length > 0) {
        notices.push({
          kind: 'renamed',
          savedKey,
          ruleNames: [...new Set(stale.map((line) => line.use.ruleName))],
        })
      }
    }
    // Only when the rules WERE read. With the rules unknown, "nothing calls it"
    // is a guess, and a guess of that shape gets hints deleted.
    if (key.length > 0 && working.length === 0 && !isClientMoment) {
      notices.push({
        kind:
          lines.length === 0
            ? 'no-rule'
            : lines.some((line) => line.status === 'unverified')
              ? 'only-unverified'
              : 'no-working-rule',
      })
    }

    for (const line of working) {
      if (line.whom.kind !== 'event') continue
      const home = surfaceGap(line.whom.event, input.surfaces)
      if (home.length === 0) continue
      notices.push({
        kind: 'surface-gap',
        ruleId: line.use.ruleId,
        ruleName: line.use.ruleName,
        event: line.whom.event,
        home,
        ticked: [...input.surfaces],
      })
    }
  }

  // Independent of the rules: a switched-off hint queues nothing whoever calls it.
  if (!input.isActive) notices.push({ kind: 'inactive' })

  return { lines, notices }
}
