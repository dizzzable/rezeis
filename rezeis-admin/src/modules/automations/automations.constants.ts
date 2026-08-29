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
] as const;

export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

/** Maximum size of the trigger payload retained on `automation_executions`. */
export const AUTOMATION_PAYLOAD_TRUNCATE_BYTES = 8 * 1024;

/** Hard cap on how many rules can be evaluated against a single event. */
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
  // Arriving for the first time. Which of the two fires depends on the door
  // the customer came through, but a rule usually wants both.
  ['user.registered', 'user.web_registered'],
  // The trial, which grants a subscription without a payment.
  ['subscription.trial_granted', 'subscription.created'],
]

