/**
 * hint-templates
 * ──────────────
 * Ready-made pop-ups for the moments where it is already obvious when one
 * should appear.
 *
 * A pop-up in this panel is two separate things that have to be built in the
 * right order: a HINT (its text, tone, button and where it may be shown) and a
 * RULE that fires it on an event. Neither does anything alone — a hint nothing
 * points at is never shown, and a `show_hint` action naming a key that does not
 * exist fails at run time, in the execution log, after the moment has passed.
 *
 * That is why the rule templates beside this file could not cover pop-ups: they
 * only seed actions, and the one action that matters here needs a row in
 * another table first. So a hint template creates both.
 *
 * ── Why these events and not others ──────────────────────────────────────────
 *
 * Every trigger below is in `POPUP_CAPABLE_EVENTS` on the server, which is the
 * only list allowed to answer the question, and `popup-capable-events.spec.ts`
 * checks this file against it. Two things have to be true of a trigger and they
 * fail in opposite ways: the event has to NAME A CUSTOMER, or `show_hint`
 * refuses it loudly at firing time; and it has to actually BE EMITTED, or the
 * rule is never selected by the pattern filter and fails in perfect silence —
 * no execution row, no error, no log line, and the rule reading "enabled" for
 * ever in the operator's list.
 *
 * FOUR OF THE EIGHT BELOW SHIPPED IN THAT SILENT STATE. Two named types that
 * were declared and emitted from nowhere (`subscription.trial_granted`,
 * `subscription.expired`); two named strings that are not event types at all
 * (`user.expire_soon`, `user.bandwidth_usage_threshold_reached`) but keys of
 * Remnawave's own webhook map — the panel forwards them under
 * `remnawave.user.*`. The prose here said the opposite, and the test beside
 * this file certified it by matching a PREFIX.
 *
 * They are also all moments a person is ALREADY looking at the cabinet, or is
 * about to be sent there. A pop-up queued for someone who will not open the app
 * for a week is a pop-up about last week.
 */
import type { AutomationActionDef } from './automations-api'
import type { HintMode, HintTone, UpsertUserHintInput } from '@/features/user-hints/user-hints-api'

/**
 * The customer's life with the product, in the order it happens.
 *
 * Ordered rather than alphabetical: the library is rendered in this sequence,
 * so an operator reads it as a journey instead of as a menu. It is also the
 * vocabulary the trigger map's lanes use, so a stage read in one place and a
 * lane read in the other are the same thing.
 */
export const HINT_TEMPLATE_STAGES = [
  'arrival',
  'start',
  'payment',
  'retention',
  'limits',
  'rewards',
  'security',
] as const

export type HintTemplateStage = (typeof HINT_TEMPLATE_STAGES)[number]

export interface HintTemplate {
  readonly id: string
  /** The event, verbatim. Shown to the operator before they apply it. */
  readonly triggerSpec: string
  /** Stable key shared by the created hint and the rule that fires it. */
  readonly hintKey: string
  readonly mode: HintMode
  readonly tone: HintTone
  /** Where the button goes, or null for a pop-up that only says something. */
  readonly route: string | null
  /** Surfaces the pop-up may appear on; empty means anywhere. */
  readonly surfaces?: readonly string[]
  /**
   * A hint that may be shown again on a later occurrence of the same event.
   * "Your payment failed" is repeatable — it is about this payment, not about
   * the customer. "Welcome" is not.
   */
  readonly repeatable: boolean
  /**
   * Pop-ups about the same fact, so a newer one replaces an older one nobody
   * has seen yet instead of queueing behind it.
   *
   * THIS IS NOT COSMETIC. One panel warning cycle emits `expires_in_72_hours`,
   * then `_48`, then `_24`, and the panel forwards all three — plus
   * `user.expiration` — under the SINGLE type `remnawave.user.expire_soon`.
   * With no group and `repeatable: true`, a customer who does not open the app
   * for three days is met by three identical renewal modals in a row, each
   * needing its own dismissal, the first two of them about a deadline that has
   * already moved. The same is true of every bandwidth threshold Remnawave is
   * configured with.
   *
   * Supersession only lapses UNSHOWN deliveries, so nothing a person has
   * actually read is ever rewritten, and lapsing (rather than deleting) keeps
   * the row countable — which is what makes `repeatable: false` still mean once.
   *
   * Left undefined for a pop-up that is about a distinct act rather than a
   * standing state: activating two promocodes is two rewards, and the second
   * must not silently erase the first.
   *
   * ── TWO POP-UPS THAT FIRE FOR ONE ACT MUST NOT SHARE A GROUP ──────────────
   *
   * This rule decides every value below, and breaking it is worse than having
   * no group at all. Supersession is unconditional and the order is decided
   * nowhere — the bridge schedules each event on its own `setImmediate` and
   * awaits a database read before enqueuing — so whichever `raise()` lands
   * second lapses the first, by coin toss.
   *
   * `subscription.trial_granted` and `subscription.created` are exactly such a
   * pair: `automations.constants.ts` lists them as one act by one customer, and
   * the sync processor emits them one line apart. The first draft put both in
   * one group, which made the outcome a toss-up between "the new customer never
   * sees the modal that leads them to the connect screen" and — because the
   * trial hint is `repeatable: false` and a LAPSED row still counts as a prior
   * delivery — "the customer is never told their trial started, and never can
   * be." The second is unrecoverable.
   */
  readonly groupKey?: string
  /**
   * Where this moment sits in a customer's life with the product.
   *
   * Only the card list uses it, and only to group — but the grouping is the
   * difference between a library and a wall. Eight cards read as a list;
   * twenty-one read as nothing at all unless the moments they belong to are
   * visible, and the moment is what an operator is actually shopping for.
   */
  readonly stage: HintTemplateStage
  /** How long the pop-up stays worth showing if the person does not open the app. */
  readonly ttlHours: number
}

/**
 * The clock running down: running out, then gone.
 *
 * Two readings of one fact where the later is always the true one, so "it has
 * expired" supersedes "it expires soon" instead of queueing behind it. Neither
 * fires for the same act as the other, which is what makes sharing safe.
 *
 * WHAT THIS GROUP DOES NOT DO, stated because the opposite is the natural
 * assumption: it does not clear a renewal warning when the customer renews. A
 * renewal extends an existing row, which takes the sync processor's UPDATE path
 * and emits only `payment.completed`. `subscription.renewed` is declared and
 * emitted from nowhere, and `subscription.created` fires only for a
 * subscription that has no panel profile yet. So nothing a paying customer does
 * cancels a queued warning — a gap in the EVENTS, which no group key can paper
 * over, and which a comment claiming otherwise would only hide.
 */
const EXPIRY = 'subscription-expiry'

export const HINT_TEMPLATES: readonly HintTemplate[] = [
  // ── Знакомство ─────────────────────────────────────────────────────────────
  {
    id: 'welcome',
    stage: 'arrival',
    triggerSpec: 'user.registered',
    hintKey: 'tpl-welcome',
    mode: 'MODAL',
    tone: 'INFO',
    route: '/plans',
    repeatable: false,
    ttlHours: 168,
  },
  {
    id: 'welcome_web',
    stage: 'arrival',
    // The OTHER door. `user.registered` is the Telegram path; this one fires for
    // somebody who signed up on the site or through a social login, and they
    // are the only ones who can be told to install anything — which is why the
    // surfaces are restricted rather than left open.
    triggerSpec: 'user.web_registered',
    hintKey: 'tpl-welcome-web',
    mode: 'MODAL',
    tone: 'INFO',
    route: '/plans',
    surfaces: ['browser', 'pwa'],
    repeatable: false,
    ttlHours: 168,
  },

  // ── От покупки до первого подключения ──────────────────────────────────────
  {
    id: 'subscription_created',
    stage: 'start',
    triggerSpec: 'subscription.created',
    hintKey: 'tpl-subscription-created',
    mode: 'MODAL',
    tone: 'SUCCESS',
    // Straight to the connect screen: this is the one moment where the next
    // thing the person needs is unambiguous.
    route: '/subscription',
    repeatable: true,
    // Its OWN group, deliberately not the expiry one. It collapses repeats of
    // itself — a customer provisioned twice — while staying clear of
    // `trial_granted`, which fires for the very same act.
    groupKey: 'subscription-start',
    ttlHours: 72,
  },
  {
    id: 'trial_granted',
    stage: 'start',
    triggerSpec: 'subscription.trial_granted',
    hintKey: 'tpl-trial-granted',
    // Good news that needs no decision. A modal for it stops somebody who was
    // about to use the thing they were just given.
    mode: 'TOAST',
    tone: 'SUCCESS',
    route: '/subscription',
    repeatable: false,
    // NO GROUP, and that is the safe choice rather than an omission.
    // `repeatable: false` already caps this at one delivery ever, so there is
    // nothing to collapse — and a group could only expose the one delivery a
    // customer will ever get to being lapsed by a neighbour, after which
    // `raise()` counts the lapsed row and never queues another.
    ttlHours: 72,
  },
  {
    id: 'first_connected',
    stage: 'start',
    // Remnawave saw the first connection. The moment worth marking is not that
    // the subscription exists — that was two events ago — but that it WORKS.
    triggerSpec: 'remnawave.user.first_connected',
    hintKey: 'tpl-first-connected',
    mode: 'TOAST',
    tone: 'SUCCESS',
    route: null,
    repeatable: false,
    // NO GROUP, and this is the file's own rule applied to itself.
    //
    // These two DO fire for one act — the webhook handler emits
    // `user.first_traffic` and then `remnawave.user.first_connected` inside one
    // `handleEvent` — and both are `repeatable: false`. That is the
    // unrecoverable combination spelt out at the top of this file: whichever
    // `raise()` lands second lapses the other, and a lapsed row still counts as
    // a prior delivery, so the loser can never be queued for that customer
    // again. An operator who later switched to the other template would find it
    // permanently unreachable for everyone who had already connected.
    //
    // They are ALTERNATIVES. Enabling both shows two, which the collision panel
    // now says out loud — a visible annoyance instead of a silent, permanent
    // loss.
    ttlHours: 24,
  },
  {
    id: 'first_traffic_devices',
    stage: 'start',
    // Our own reading of the same fact, and the alternative to the one above:
    // it points somewhere instead of only saying well done.
    triggerSpec: 'user.first_traffic',
    hintKey: 'tpl-first-traffic-devices',
    mode: 'TOAST',
    tone: 'SUCCESS',
    route: '/subscription/devices',
    repeatable: false,
    // No group, for the reason on its twin above.
    ttlHours: 24,
  },

  // ── Оплата ─────────────────────────────────────────────────────────────────
  {
    id: 'payment_completed',
    stage: 'payment',
    triggerSpec: 'payment.completed',
    hintKey: 'tpl-payment-completed',
    // A receipt, not an interruption. The customer pressed pay and is watching
    // the screen; a modal here asks them to dismiss their own success.
    mode: 'TOAST',
    tone: 'SUCCESS',
    route: '/subscription',
    repeatable: true,
    groupKey: 'payment-attempt',
    ttlHours: 24,
  },
  {
    id: 'payment_failed',
    stage: 'payment',
    triggerSpec: 'payment.failed',
    hintKey: 'tpl-payment-failed',
    mode: 'MODAL',
    tone: 'WARNING',
    route: '/plans',
    repeatable: true,
    // Its own group: a failed payment is about a payment, and it must survive
    // an expiry notice arriving beside it. Grouped at all because a gateway
    // that retries three times is otherwise three modals — and shared with the
    // receipt above, so a retry that finally goes through replaces the warning
    // about the attempt that did not.
    groupKey: 'payment-attempt',
    // A failed payment is worth raising for a day. After that the person has
    // either paid another way or given up, and a pop-up about it is noise.
    ttlHours: 24,
  },
  {
    id: 'payment_failed_method',
    stage: 'payment',
    // The same moment, aimed at the likeliest cause. An alternative to the one
    // above rather than an addition — enabling both means two rules firing on
    // one event, which the collision panel says out loud.
    triggerSpec: 'payment.failed',
    hintKey: 'tpl-payment-failed-method',
    mode: 'MODAL',
    tone: 'WARNING',
    route: '/settings/payment-methods',
    repeatable: true,
    // Its own group: a gateway that retries three times is three modals here
    // too, and the pair's other half must not lapse it.
    groupKey: 'payment-attempt-method',
    ttlHours: 24,
  },

  // ── Удержание ──────────────────────────────────────────────────────────────
  {
    id: 'expire_soon',
    stage: 'retention',
    triggerSpec: 'remnawave.user.expire_soon',
    hintKey: 'tpl-expire-soon',
    mode: 'MODAL',
    tone: 'WARNING',
    route: '/renew',
    repeatable: true,
    // THE TEMPLATE THIS GROUP EXISTS FOR. Three panel warnings per cycle arrive
    // under this one type; without the group they are three modals.
    groupKey: EXPIRY,
    // ONE DAY, WHICH IS THE LAST WARNING'S OWN DISTANCE FROM EXPIRY.
    //
    // 48 was reasoned from the wrong end of the window. Remnawave's warnings
    // arrive at 72, 48 and 24 hours, all four forwarded under this one type,
    // and the LAST one is what sets the ceiling: a hint raised at the 24-hour
    // mark and kept showable for 48 is still showable a full day AFTER the
    // subscription ended. The customer then meets "your subscription ends
    // soon" on an account that already expired — while `subscription_expired`,
    // which shares this group, is telling them the opposite.
    //
    // At 24 the window can never outlive its own subject: each warning stays
    // valid exactly until the next one replaces it (same group, so the newer
    // raise lapses the older), and the last one until expiry itself.
    ttlHours: 24,
  },
  {
    id: 'expire_soon_quiet',
    stage: 'retention',
    // The same warning without taking the screen, for an operator who would
    // rather nudge than interrupt. An alternative to the modal above.
    triggerSpec: 'remnawave.user.expire_soon',
    hintKey: 'tpl-expire-soon-quiet',
    mode: 'TOAST',
    tone: 'WARNING',
    route: '/renew',
    repeatable: true,
    // ITS OWN GROUP, which it needs for exactly the reason the modal does.
    // Remnawave sends `expires_in_72_hours`, `_48`, `_24` and
    // `user.expiration`, and the panel forwards all four under this one type —
    // so an operator who read "the same warning, quietly" and picked this one
    // got three identical toasts per cycle, the first two about a deadline that
    // had already moved.
    //
    // Not the modal's group: an alternative must not depend on which of the
    // pair raised last, and a MODAL lapsing a TOAST is destructive on a cabinet
    // that can only draw the modal.
    groupKey: 'subscription-expiry-quiet',
    // Same ceiling as the modal, for the same reason: the quiet half is the
    // same warning about the same deadline.
    ttlHours: 24,
  },
  {
    id: 'subscription_expired',
    stage: 'retention',
    triggerSpec: 'remnawave.user.expired',
    hintKey: 'tpl-subscription-expired',
    mode: 'MODAL',
    tone: 'DANGER',
    route: '/renew',
    repeatable: true,
    // Last reading of the clock, so it wins over any warning still queued —
    // which is the whole point of the group being shared with expire_soon.
    groupKey: EXPIRY,
    ttlHours: 168,
  },
  {
    id: 'expired_comeback',
    stage: 'retention',
    // For an operator running a win-back offer: the same moment pointed at the
    // promo screen rather than the renewal screen.
    triggerSpec: 'remnawave.user.expired',
    hintKey: 'tpl-expired-comeback',
    mode: 'MODAL',
    tone: 'INFO',
    route: '/promo',
    repeatable: true,
    // Its own group, so repeats of itself collapse. NOT the expiry group, for
    // the alternative-pair reason above.
    groupKey: 'subscription-comeback',
    // ONE WEEK, not two. Nothing a paying customer does cancels a queued
    // warning — a renewal takes the UPDATE path and emits only
    // `payment.completed` — so this hint's TTL is the whole window in which it
    // can reach somebody who has already come back. At fourteen days a customer
    // who renewed the day after expiry and opened the app four days later read
    // "Мы вас ждём — подписка закончилась" while paying. A week still covers a
    // win-back and halves that window.
    ttlHours: 168,
  },

  // ── Лимиты и доступ ────────────────────────────────────────────────────────
  {
    id: 'traffic_running_out',
    stage: 'limits',
    triggerSpec: 'remnawave.user.bandwidth_threshold',
    hintKey: 'tpl-traffic-running-out',
    // A TOAST, which is what it always wanted to be: nothing is broken yet and
    // the person is mid-task. It shipped as a modal only because the cabinet
    // could draw nothing else — two templates asked for a toast and neither
    // could be created at all until the cabinet learned the mode.
    mode: 'TOAST',
    tone: 'WARNING',
    route: null,
    repeatable: true,
    // Separate from the clock — being low on traffic and being close to expiry
    // are two different facts and a person can be in both. Grouped with itself
    // because every configured threshold forwards under this same type.
    //
    // ITS OWN GROUP, NOT `traffic-usage`, AND THAT WAS A DESTRUCTIVE DEFECT.
    //
    // `automations.constants.ts` declares this trigger and
    // `remnawave.user.limited` COINCIDENT: the panel forwards a bandwidth
    // threshold and then the limit itself, and a customer who crosses the last
    // threshold and exhausts the allowance in one session gets both, seconds
    // apart. Sharing a group made supersession decide between them by coin
    // toss — the bridge schedules each event on its own `setImmediate` — and
    // when this TOAST landed second it lapsed the unshown `traffic_exhausted`
    // MODAL. The customer was then told their traffic was "running out" while
    // it was in fact gone, and lost the only button that could sell them more,
    // permanently and in silence. This is the file's own rule two hundred lines
    // up: TWO POP-UPS THAT FIRE FOR ONE ACT MUST NOT SHARE A GROUP.
    //
    // Enabling both now shows both — a visible annoyance the collision panel
    // warns about out loud, because the pair is declared coincident — instead
    // of a silent, unrecoverable loss of the informative half.
    groupKey: 'traffic-threshold',
    ttlHours: 24,
  },
  {
    id: 'traffic_exhausted',
    stage: 'limits',
    // Now something IS broken, so this one takes the screen where the warning
    // above does not.
    triggerSpec: 'remnawave.user.limited',
    hintKey: 'tpl-traffic-exhausted',
    mode: 'MODAL',
    tone: 'DANGER',
    route: '/addons',
    repeatable: true,
    // KEEPS `traffic-usage`, shared with the reset below and with nothing that
    // fires for the same act. Repeats of the limit itself collapse, and a reset
    // — which is not coincident with anything — lapses this modal while it is
    // still unshown. That direction is the one worth keeping: telling somebody
    // they are cut off after the counter has rolled over is the same mistake as
    // telling them their access is suspended after it was restored.
    groupKey: 'traffic-usage',
    ttlHours: 72,
  },
  {
    id: 'traffic_reset',
    stage: 'limits',
    // The counter rolled over. Worth one line, because a customer who was cut
    // off yesterday has no other way to learn that they are not any more.
    triggerSpec: 'remnawave.user.traffic_reset',
    hintKey: 'tpl-traffic-reset',
    mode: 'TOAST',
    tone: 'SUCCESS',
    route: null,
    repeatable: true,
    groupKey: 'traffic-usage',
    ttlHours: 24,
  },
  {
    id: 'access_paused',
    stage: 'limits',
    // Fires for an operator switching somebody off as readily as for anything
    // else, so the copy states the fact and points at support rather than
    // guessing at a reason it does not know.
    triggerSpec: 'remnawave.user.disabled',
    hintKey: 'tpl-access-paused',
    mode: 'MODAL',
    tone: 'WARNING',
    route: '/support',
    repeatable: true,
    groupKey: 'access-state',
    ttlHours: 168,
  },
  {
    id: 'access_restored',
    stage: 'limits',
    triggerSpec: 'remnawave.user.enabled',
    hintKey: 'tpl-access-restored',
    mode: 'TOAST',
    tone: 'SUCCESS',
    route: null,
    repeatable: true,
    // Shared with the pause: two readings of one state, and being switched back
    // on has to beat a pause notice nobody has read yet. Telling somebody their
    // access is suspended after it has been restored is worse than saying
    // nothing at all.
    groupKey: 'access-state',
    ttlHours: 72,
  },

  // ── Бонусы ─────────────────────────────────────────────────────────────────
  {
    id: 'promocode_activated',
    stage: 'rewards',
    triggerSpec: 'promocode.activated',
    hintKey: 'tpl-promocode-activated',
    mode: 'MODAL',
    tone: 'SUCCESS',
    route: null,
    repeatable: true,
    // ONE ACTIVATION CAN EMIT TWICE. When the reward's sync enqueue fails, the
    // lifecycle service emits `promocode.activated` from its catch AND again on
    // the normal path, and the bridge dispatches on type alone — so a Redis
    // blip during a redemption produced two identical modals for one code.
    groupKey: 'promocode-activation',
    ttlHours: 12,
  },
  {
    id: 'promocode_activated_quiet',
    stage: 'rewards',
    // The customer typed the code themselves and is looking at the screen, so
    // most operators will want this one. The modal above stays for the offers
    // worth stopping somebody for.
    triggerSpec: 'promocode.activated',
    hintKey: 'tpl-promocode-activated-quiet',
    mode: 'TOAST',
    tone: 'SUCCESS',
    route: null,
    repeatable: true,
    // Its own, for the double-emit above; separate from the modal's for the
    // alternative-pair reason.
    groupKey: 'promocode-activation-quiet',
    ttlHours: 12,
  },

  // ── Безопасность ───────────────────────────────────────────────────────────
  {
    id: 'fraud_signal',
    stage: 'security',
    // ONLY REACHES ANYBODY WHEN THE SIGNAL NAMES EXACTLY ONE PERSON.
    //
    // `fraudRezeisUserId` is set on a signal about a single account; the
    // shared-device and multi-account detectors name several, and the action
    // refuses those out loud rather than picking one of them. So this fires for
    // the "too many failed payments" shape and stays quiet for the rest — which
    // is the right side to fail on, because the alternative is telling one of
    // five people that they are the suspect.
    triggerSpec: 'fraud.signal_opened',
    hintKey: 'tpl-fraud-signal',
    mode: 'MODAL',
    tone: 'WARNING',
    route: '/support',
    repeatable: true,
    ttlHours: 72,
  },
]
/**
 * The hint this template creates.
 *
 * `text` is the page's translator, so the copy lives beside every other string
 * in the panel and an operator editing it afterwards edits a normal hint — the
 * template is a starting point, not a managed object.
 */
export function buildHint(
  template: HintTemplate,
  text: (key: string) => string,
): UpsertUserHintInput {
  const at = (field: string): string => text(`automationsPage.hintTemplates.${template.id}.${field}`)
  return {
    key: template.hintKey,
    titleRu: at('titleRu'),
    bodyRu: at('bodyRu'),
    titleEn: at('titleEn'),
    bodyEn: at('bodyEn'),
    mode: template.mode,
    tone: template.tone,
    ctaKind: template.route === null ? 'NONE' : 'ROUTE',
    ...(template.route === null
      ? {}
      : { ctaLabelRu: at('ctaRu'), ctaLabelEn: at('ctaEn'), ctaTarget: template.route }),
    surfaces: [...(template.surfaces ?? [])],
    // Omitted rather than sent empty when there is none: the server trims an
    // empty string to null anyway, and sending one would read as a deliberate
    // "no group" in the request body.
    ...(template.groupKey === undefined ? {} : { groupKey: template.groupKey }),
    ttlHours: template.ttlHours,
    isRepeatable: template.repeatable,
    // Created switched ON. The rule that fires it is created as a DRAFT the
    // operator still has to save, so nothing reaches a customer until they
    // press Create — and an inactive hint behind an active rule is a rule that
    // silently does nothing, which is harder to notice than either.
    isActive: true,
  }
}

/** The one action the rule needs: fire this hint at whoever the event names. */
export function buildHintAction(template: HintTemplate): AutomationActionDef[] {
  return [{ type: 'show_hint', params: { hintKey: template.hintKey } }]
}
