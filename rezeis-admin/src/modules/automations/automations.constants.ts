/**
 * Stable identifiers for the Automations module.
 *
 * The queue name lives here so processors and the queue service stay
 * loosely coupled; the action-type strings are the canonical names the
 * rule engine understands and the frontend exposes in its rule editor.
 */

export const AUTOMATION_QUEUE = 'automation-execution';

export const AUTOMATION_JOB_NAMES = {
  EXECUTE_RULE: 'execute-rule',
} as const;

/** Built-in action types supported by the engine. */
export const AUTOMATION_ACTION_TYPES = [
  'notify_telegram',
  'webhook_post',
  'block_ip',
  'system_event',
  'block_user',
  'show_hint',
  'show_hint_to_audience',
] as const;

export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

/** Maximum size of the trigger payload retained on `automation_executions`. */
export const AUTOMATION_PAYLOAD_TRUNCATE_BYTES = 8 * 1024;

/**
 * Hard cap on how many rules may FIRE on a single event.
 *
 * It used to be a `take` on the query that loads enabled realtime rules — that
 * is, a cap on how many were LOADED, applied before the pattern filter ran and
 * with no `orderBy` to decide which. Past 64 enabled realtime rules the
 * database returned an arbitrary 64 of them and every rule outside that slice
 * silently stopped firing; and because `persistExecution` updates a rule row on
 * every run, the arbitrary slice reshuffled as other rules fired. Nothing
 * logged it, nothing told the operator, and the only symptom was a rule with
 * `lastRunAt: null` and no explanation.
 *
 * A ready-made template library plus a trigger map is exactly what pushes an
 * install past that line, which is why it is a cap on MATCHES now: it is
 * reached only when 64 rules genuinely want the same event, it is applied in a
 * defined order, and reaching it is logged with the event that did it.
 */
export const AUTOMATION_RULES_PER_EVENT_LIMIT = 64;

/**
 * Events that arrive together, as one act by one customer.
 *
 * ── What this is for ──────────────────────────────────────────────────────
 *
 * A hint bound to each of these is four modals for one purchase. The queue's
 * `groupKey` already collapses that — but only if the operator thought to set
 * one, and nothing tells them they needed to. This is the list the editor
 * checks a new rule against so the warning arrives while they are still
 * looking at the form, rather than from a customer.
 *
 * ── Why it is a short hand-written list ───────────────────────────────────
 *
 * It is not derived and cannot be: whether two events "arrive together" is a
 * fact about the flows this product actually runs, not about the event
 * catalogue. A first purchase through a referral link with a promo code emits
 * all four of the first group inside a second or two; a renewal emits two of
 * the second. Nothing in the type system knows that.
 *
 * `payment.completed` deliberately appears twice. A purchase and a renewal are
 * different acts that share an event, and collapsing them into one group to
 * avoid the repetition would warn about a pair that never co-occurs.
 */
export const COINCIDENT_EVENT_GROUPS: readonly (readonly string[])[] = [
  // A purchase, with everything it can drag along.
  [
    'payment.completed',
    'subscription.created',
    'referral.qualified',
    'referral.reward_issued',
    'promocode.activated',
  ],
  // A renewal, manual or automatic.
  ['payment.completed', 'subscription.renewed'],
  // An upgrade.
  ['payment.completed', 'subscription.upgraded'],
  // The trial, which grants a subscription without a payment.
  ['subscription.trial_granted', 'subscription.created'],
  // Connecting for the first time. Remnawave notices it and so do we, inside
  // one webhook handler — `user.first_traffic` is emitted and then
  // `remnawave.user.first_connected`, seconds apart at most.
  ['user.first_traffic', 'remnawave.user.first_connected'],
  // Running out, then running out. The panel forwards a bandwidth threshold and
  // then the limit itself; a customer who crosses the last threshold and
  // exhausts the allowance in one session gets both.
  ['remnawave.user.bandwidth_threshold', 'remnawave.user.limited'],
  // Ending. Which of these a panel emits depends on how it is configured to
  // handle an expired profile — some disable it, some let it expire — and an
  // install that does both sends a customer whose subscription simply ran out
  // into the support queue with "your access is suspended".
  ['remnawave.user.expired', 'remnawave.user.disabled'],
  // A card that keeps failing is also what opens the fraud signal that names
  // exactly one person, which is the only shape that reaches a customer.
  ['payment.failed', 'fraud.signal_opened'],
]

// `['user.registered', 'user.web_registered']` USED TO BE HERE and is gone.
//
// The comment beside it said which of the two fires depends on the door the
// customer came through — that is, they never co-occur — while the file's own
// rule two paragraphs up is that collapsing events into a group "would warn
// about a pair that never co-occurs". Applying the library's first two cards,
// `welcome` and `welcome_web`, therefore produced a mutual collision warning
// for two rules that cannot both fire for one person. It was the first warning
// a new operator ever saw, and it was wrong, which teaches them to dismiss the
// ones that are right.

