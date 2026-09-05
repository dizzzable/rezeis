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
 * Every trigger below names a customer. `show_hint` refuses an event that does
 * not carry a `userId` — correctly, and with a clear message — but an operator
 * only finds that out after the rule has failed once. The list is filtered to
 * events where the answer to "who sees this?" is not a guess.
 *
 * They are also all moments a person is ALREADY looking at the cabinet, or is
 * about to be sent there. A pop-up queued for someone who will not open the app
 * for a week is a pop-up about last week.
 */
import type { AutomationActionDef } from './automations-api'
import type { HintMode, HintTone, UpsertUserHintInput } from '@/features/user-hints/user-hints-api'

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
  /** How long the pop-up stays worth showing if the person does not open the app. */
  readonly ttlHours: number
}

export const HINT_TEMPLATES: readonly HintTemplate[] = [
  {
    id: 'payment_failed',
    triggerSpec: 'payment.failed',
    hintKey: 'tpl-payment-failed',
    mode: 'MODAL',
    tone: 'WARNING',
    route: '/plans',
    repeatable: true,
    // A failed payment is worth raising for a day. After that the person has
    // either paid another way or given up, and a pop-up about it is noise.
    ttlHours: 24,
  },
  {
    id: 'subscription_created',
    triggerSpec: 'subscription.created',
    hintKey: 'tpl-subscription-created',
    mode: 'MODAL',
    tone: 'SUCCESS',
    // Straight to the connect screen: this is the one moment where the next
    // thing the person needs is unambiguous.
    route: '/subscription/connect',
    repeatable: true,
    ttlHours: 72,
  },
  {
    id: 'trial_granted',
    triggerSpec: 'subscription.trial_granted',
    hintKey: 'tpl-trial-granted',
    mode: 'MODAL',
    tone: 'SUCCESS',
    route: '/subscription/connect',
    repeatable: false,
    ttlHours: 72,
  },
  {
    id: 'expire_soon',
    triggerSpec: 'user.expire_soon',
    hintKey: 'tpl-expire-soon',
    mode: 'MODAL',
    tone: 'WARNING',
    route: '/renew',
    repeatable: true,
    // Shorter than the warning window itself on purpose: a renewal prompt that
    // outlives the subscription it was about is a prompt for the wrong screen.
    ttlHours: 48,
  },
  {
    id: 'subscription_expired',
    triggerSpec: 'subscription.expired',
    hintKey: 'tpl-subscription-expired',
    mode: 'MODAL',
    tone: 'DANGER',
    route: '/renew',
    repeatable: true,
    ttlHours: 168,
  },
  {
    id: 'traffic_running_out',
    triggerSpec: 'user.bandwidth_usage_threshold_reached',
    hintKey: 'tpl-traffic-running-out',
    mode: 'MODAL',
    tone: 'WARNING',
    // Wanted as a toast — nothing is broken yet and the person is mid-task —
    // and it is a modal because a toast is not a mode the cabinet draws:
    // `hint-controller.tsx` skips anything that is not `MODAL`, and the panel
    // refuses it on the way in (`RENDERABLE_HINT_MODES`). Two templates
    // shipped asking for it and neither could be created at all. Change this
    // back in the same commit that teaches the cabinet to render a toast.
    route: null,
    repeatable: true,
    ttlHours: 24,
  },
  {
    id: 'welcome',
    triggerSpec: 'user.registered',
    hintKey: 'tpl-welcome',
    mode: 'MODAL',
    tone: 'INFO',
    route: '/plans',
    repeatable: false,
    ttlHours: 168,
  },
  {
    id: 'promocode_activated',
    triggerSpec: 'promocode.activated',
    hintKey: 'tpl-promocode-activated',
    mode: 'MODAL',
    tone: 'SUCCESS',
    route: null,
    repeatable: true,
    ttlHours: 12,
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
