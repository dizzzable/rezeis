/**
 * popup-capable-events
 * ────────────────────
 * The events a pop-up may be bound to, and the only list allowed to answer
 * that question.
 *
 * ── Why a list exists at all ─────────────────────────────────────────────────
 *
 * `show_hint` needs an event that NAMES A CUSTOMER — `resolveTriggerUserId`
 * reads a fixed set of metadata keys and the action refuses anything else. That
 * refusal is loud and it is correct, but it arrives at FIRING TIME, in the
 * execution log, after the moment the pop-up was written for has passed.
 *
 * A rule bound to an event that is never EMITTED is quieter still, and it is
 * the failure this file exists to end. `findMatchingRealtimeRules` filters by
 * pattern, so such a rule is simply never selected: no execution row, no error,
 * no log line. The rule sits in the operator's list saying "enabled" for ever.
 * Four of the eight ready-made pop-up templates shipped in exactly that state —
 * two naming types that are declared and emitted from nowhere, two naming
 * strings that are not event types at all but keys of Remnawave's own webhook
 * map — and the test that was meant to catch it asserted a PREFIX.
 *
 * ── Why it is hand-written and not derived ───────────────────────────────────
 *
 * Deriving it would mean parsing every emit site, and the emit sites take five
 * different shapes: a literal, a constant, a lookup table dereferenced as
 * `mapped.type`, an `alert.type` off an object built in another module, and a
 * ternary. A parser that misses one form marks a working trigger dead and
 * refuses a template that would have fired; a parser that guesses marks a dead
 * one live and ships the defect it was written to prevent.
 *
 * So the list is a decision, reviewed by a person — and
 * `popup-capable-events.spec.ts` beside it proves every entry against the
 * source: that something emits it, and that what it emits carries a key
 * `resolveTriggerUserId` reads. An entry that stops being true fails the panel
 * build rather than a customer's pop-up.
 */

import { matchEventPattern } from './event-pattern';

/**
 * One event a rule may fire a pop-up on.
 *
 * `namedBy` is the metadata key the customer arrives under. It is recorded
 * because the four keys are not interchangeable — `reiwaId` is what the
 * Telegram registration path writes, `userId` what everything else writes — and
 * because the spec checks the emit site for THIS key rather than for any of
 * them, which is what makes the check worth running.
 */
export interface PopupCapableEvent {
  readonly type: string;
  readonly namedBy: 'userId' | 'reiwaId' | 'fraudRezeisUserId' | 'affectedUserIds';
  /** Where it is emitted. The spec reads this file to check the claim. */
  readonly emittedIn: string;
  /** What an operator would call this moment. */
  readonly moment: string;
}

export const POPUP_CAPABLE_EVENTS: readonly PopupCapableEvent[] = [
  // ── Arriving ───────────────────────────────────────────────────────────────
  {
    type: 'user.registered',
    namedBy: 'reiwaId',
    emittedIn: 'src/modules/internal-user/services/internal-user-edge.service.ts',
    moment: 'Registered through the Telegram bot',
  },
  {
    type: 'user.web_registered',
    namedBy: 'userId',
    emittedIn: 'src/modules/external-auth/services/external-auth.service.ts',
    moment: 'Registered through the cabinet',
  },
  {
    type: 'user.first_traffic',
    namedBy: 'userId',
    emittedIn: 'src/modules/remnawave/services/remnawave-webhook.service.ts',
    moment: 'Traffic used for the first time, once per person ever',
  },

  // ── Buying ─────────────────────────────────────────────────────────────────
  {
    type: 'subscription.created',
    namedBy: 'userId',
    emittedIn: 'src/modules/profile-sync/profile-sync.processor.ts',
    moment: 'A subscription was provisioned',
  },
  {
    type: 'subscription.trial_granted',
    namedBy: 'userId',
    emittedIn: 'src/modules/profile-sync/profile-sync.processor.ts',
    moment: 'A trial was provisioned',
  },
  {
    type: 'payment.completed',
    namedBy: 'userId',
    emittedIn: 'src/modules/payments/services/payment-subscription-mutation.service.ts',
    moment: 'Money arrived and the order was fulfilled',
  },
  {
    type: 'payment.failed',
    namedBy: 'userId',
    emittedIn: 'src/modules/payments/services/payment-reconciliation.service.ts',
    moment: 'A payment did not go through',
  },
  {
    type: 'promocode.activated',
    namedBy: 'userId',
    emittedIn: 'src/modules/promocodes/services/promocode-lifecycle.service.ts',
    moment: 'A promo code was redeemed',
  },

  // ── Running out ────────────────────────────────────────────────────────────
  //
  // These four carry the customer only since the webhook forwarder began
  // resolving them for every user-scoped event rather than for the first
  // connection alone. Before that they named the Remnawave profile and nothing
  // else, which is why the retention half of the template library was inert.
  {
    type: 'remnawave.user.expire_soon',
    namedBy: 'userId',
    emittedIn: 'src/modules/remnawave/services/remnawave-webhook.service.ts',
    moment: 'The subscription expires within 24-72 hours',
  },
  {
    type: 'remnawave.user.expired',
    namedBy: 'userId',
    emittedIn: 'src/modules/remnawave/services/remnawave-webhook.service.ts',
    moment: 'The subscription has expired',
  },
  {
    type: 'remnawave.user.bandwidth_threshold',
    namedBy: 'userId',
    emittedIn: 'src/modules/remnawave/services/remnawave-webhook.service.ts',
    moment: 'Traffic is running out',
  },
  {
    type: 'remnawave.user.limited',
    namedBy: 'userId',
    emittedIn: 'src/modules/remnawave/services/remnawave-webhook.service.ts',
    moment: 'The traffic limit was reached',
  },

  // ── Using it ───────────────────────────────────────────────────────────────
  //
  // The rest of the forwarded `user.*` family. They carry the customer for the
  // same reason the four above do, and leaving them out was an oversight with
  // teeth: `remnawave.user.first_connected` has named the customer since long
  // before this list existed — it was the ONE branch that enriched — so a rule
  // an operator already had would have been refused the next time they opened
  // and saved it, while `remnawave.user.*` was accepted beside it.
  {
    type: 'remnawave.user.first_connected',
    namedBy: 'userId',
    emittedIn: 'src/modules/remnawave/services/remnawave-webhook.service.ts',
    moment: 'Connected for the first time',
  },
  {
    type: 'remnawave.user.enabled',
    namedBy: 'userId',
    emittedIn: 'src/modules/remnawave/services/remnawave-webhook.service.ts',
    moment: 'The profile was switched back on',
  },
  {
    type: 'remnawave.user.disabled',
    namedBy: 'userId',
    emittedIn: 'src/modules/remnawave/services/remnawave-webhook.service.ts',
    moment: 'The profile was switched off',
  },
  {
    type: 'remnawave.user.traffic_reset',
    namedBy: 'userId',
    emittedIn: 'src/modules/remnawave/services/remnawave-webhook.service.ts',
    moment: 'The traffic counter was reset',
  },

  // ── Invitations ────────────────────────────────────────────────────────────
  //
  // Both name the REFERRER — the person whose invitation paid off — under
  // `userId`, which is who a pop-up about it is for. They were already grouped
  // as coincident with a purchase while being unable to carry a pop-up at all,
  // so the collision warning covered a pair one half of which was unreachable.
  {
    type: 'referral.qualified',
    namedBy: 'userId',
    emittedIn: 'src/modules/referrals/services/referral-qualification.service.ts',
    moment: 'Somebody they invited made a qualifying purchase',
  },
  {
    type: 'referral.reward_issued',
    namedBy: 'userId',
    emittedIn: 'src/modules/referrals/services/admin-rewards.service.ts',
    moment: 'A referral reward was credited to them',
  },

  // ── Under review ───────────────────────────────────────────────────────────
  {
    type: 'fraud.signal_opened',
    // The one event in the panel that names its customer this way, and the
    // reason `resolveTriggerUserId` reads the key at all — its own comment
    // calls this one of the two bindings an operator is most likely to reach
    // for. `fraudRezeisUserId` is set only when the signal names exactly one
    // person, which is precisely when acting on it is defensible.
    namedBy: 'fraudRezeisUserId',
    emittedIn: 'src/modules/anti-fraud/services/anti-fraud.service.ts',
    moment: 'An anti-fraud signal was opened about one customer',
  },
];

// A `POPUP_CAPABLE_EVENT_TYPES` set used to live here, exported and imported
// by nobody. It is gone rather than kept for convenience: a second way to ask
// "is this capable?" would answer differently from `canCarryPopup` for every
// wildcard — `payment.*` is a member of no set — and the whole point of this
// change set is that the question has one answer.

/**
 * Whether a rule's trigger can fire a pop-up.
 *
 * A wildcard is answered by whether ANY capable event matches it, because that
 * is what the runtime will do: a rule written `ns.*` fires for every event
 * under the namespace, capable or not, and the action refuses the ones that
 * name nobody — loudly, at run time, which is the right place for a decision
 * the operator made on purpose.
 *
 * `matchEventPattern` IS the runtime, imported rather than restated. The first
 * version of this function reimplemented the grammar and got two things wrong
 * that a second implementation always gets wrong eventually: it sliced one
 * character instead of two, and it silently dropped the bare `*` — the one
 * wildcard the rule editor's own help text advertises — so a pop-up rule
 * matching everything was refused at save time while the engine would have run
 * it against every capable event.
 */
export function canCarryPopup(triggerSpec: string): boolean {
  const spec = triggerSpec.trim();
  if (spec.length === 0) return false;
  return POPUP_CAPABLE_EVENTS.some((event) => matchEventPattern(spec, event.type));
}
