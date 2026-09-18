import type { TFunction } from 'i18next'

import type { AutomationRule } from './automations-api'

/**
 * popup-audience
 * ──────────────
 * WHO a pop-up reaches, as opposed to WHERE it may appear — the two questions
 * an operator confused, and the reason this file exists.
 *
 * A hint's surfaces («Telegram», «Приложение», «Браузер») say where the cabinet
 * may draw it. The EVENT of the rule that fires it says whom it is queued for.
 * Nothing on either tab put the two side by side, so a welcome bound to the
 * Telegram sign-up and limited to «Браузер» looked finished on both: its rule
 * matched only people who arrived through Telegram, who open the cabinet inside
 * Telegram, where a hint limited to the browser is never drawn. The delivery
 * sat unseen for its whole lifetime and lapsed, and the person registering in
 * the browser — the one the operator was writing for — raised a different event
 * that no rule was listening to.
 */

/** The three places the cabinet reports itself as, in the hint's own vocabulary. */
export type HintSurface = 'tma' | 'pwa' | 'browser'

/**
 * Where the customer an event names is opening the cabinet, for the events
 * where the event itself says so.
 *
 * Only the two sign-ups know. `user.registered` is raised by the bot's /start
 * and by the Mini App's first sign-in, so the person is inside Telegram;
 * `user.web_registered` by a sign-up on the site, so the person is in a browser
 * or in the app installed from it. Every other event — a payment, an expiry —
 * happens to somebody wherever they are, and claiming a place for it would be
 * inventing one.
 *
 * A LIKELY place, not a certain one: somebody who signed up in the bot can open
 * the site later. Which is why a gap is a warning and never a refusal.
 */
export const EVENT_HOME_SURFACES: ReadonlyMap<string, readonly HintSurface[]> = new Map([
  ['user.registered', ['tma']],
  ['user.web_registered', ['browser', 'pwa']],
])

/**
 * Where an event's customers are and this hint may not appear, or `[]`.
 *
 * `[]` when the hint is not limited (no surfaces ticked means everywhere), when
 * the event says nothing about where its customer is — every event but the two
 * sign-ups, and any wildcard — or when the hint is allowed in at least one of
 * the places the event's customers are.
 *
 * Partial overlap is not a gap on purpose. A site sign-up limited to «Браузер»
 * still reaches the person who is registering in the browser; leaving the
 * installed app out narrows it, it does not miss it.
 */
export function surfaceGap(
  triggerSpec: string,
  surfaces: readonly string[],
): readonly HintSurface[] {
  if (surfaces.length === 0) return []
  const home = EVENT_HOME_SURFACES.get(triggerSpec.trim())
  if (home === undefined) return []
  if (home.some((surface) => surfaces.includes(surface))) return []
  return home
}

/** One rule that fires a given hint. */
export interface HintUse {
  readonly ruleId: string
  readonly ruleName: string
  readonly isEnabled: boolean
  readonly triggerKind: AutomationRule['triggerKind']
  readonly triggerSpec: string
  /** `show_hint` fires at whoever the trigger names; the audience action picks its own people. */
  readonly action: 'show_hint' | 'show_hint_to_audience'
  /** The audience the audience action selects, or `null`. */
  readonly audience: string | null
}

/**
 * Every rule that fires `hintKey`, switched on first.
 *
 * A rule naming the hint twice is listed once per action kind: two identical
 * `show_hint` actions are one use, and a rule that both shows it on its event
 * and sends it to an audience is two different uses.
 */
export function usesOfHint(hintKey: string, rules: readonly AutomationRule[]): HintUse[] {
  const key = hintKey.trim()
  if (key.length === 0) return []
  const uses: HintUse[] = []
  for (const rule of rules) {
    const seen = new Set<string>()
    for (const action of rule.actions) {
      if (action.type !== 'show_hint' && action.type !== 'show_hint_to_audience') continue
      const params = (action.params ?? {}) as Record<string, unknown>
      const named = params['hintKey']
      if (typeof named !== 'string' || named.trim() !== key) continue
      if (seen.has(action.type)) continue
      seen.add(action.type)
      const audience = params['audience']
      uses.push({
        ruleId: rule.id,
        ruleName: rule.name,
        isEnabled: rule.isEnabled,
        triggerKind: rule.triggerKind,
        triggerSpec: rule.triggerSpec,
        action: action.type,
        audience: typeof audience === 'string' && audience.trim().length > 0 ? audience.trim() : null,
      })
    }
  }
  return uses.sort(
    (a, b) => Number(b.isEnabled) - Number(a.isEnabled) || a.ruleName.localeCompare(b.ruleName),
  )
}

/**
 * The dictionary key an event's operator-facing name lives under.
 *
 * Dots become underscores: i18next splits keys on a dot, so
 * `remnawave.user.expire_soon` would otherwise be three nested lookups.
 */
export function popupEventNameKey(eventType: string): string {
  return `automationsPage.popupEvents.${eventType.trim().replace(/\./g, '_')}`
}

/**
 * The operator's words for an event — «Регистрация через Telegram» — or `null`
 * when the panel has none, which is every event that cannot carry a pop-up and
 * every wildcard. A caller shows the raw type then; it never shows the key.
 */
export function popupEventName(t: TFunction, eventType: string): string | null {
  const spec = eventType.trim()
  if (spec.length === 0 || spec.includes('*')) return null
  const key = popupEventNameKey(spec)
  const value = t(key, { defaultValue: '' })
  return typeof value === 'string' && value.length > 0 && value !== key ? value : null
}

// ── Which triggers can carry a pop-up at all ────────────────────────────────

/**
 * What a rule's trigger spec means — the browser's copy of the server's
 * `matchEventPattern` (`src/modules/automations/event-pattern.ts`), which is the
 * runtime: the bridge selects rules with it.
 *
 *   `*`          → every event
 *   `payment.*`  → `payment` itself, or anything under `payment.`
 *   anything else, `payment*` and `*.failed` included → that exact string
 *
 * It lives here rather than in `trigger-map.ts` (which re-exports it) because
 * the capability check below needs it and the map already imports this file.
 * A second opinion about the grammar is a defect this subsystem has shipped
 * before, so `trigger-map.test.ts` and `popup-audience.test.ts` run this copy
 * against the server's over the same corpus.
 */
export function matchEventPattern(pattern: string, eventType: string): boolean {
  const trimmed = pattern.trim()
  if (trimmed.length === 0) return false
  if (trimmed === '*') return true
  if (trimmed.endsWith('.*')) {
    const prefix = trimmed.slice(0, -2)
    return eventType === prefix || eventType.startsWith(`${prefix}.`)
  }
  return eventType === trimmed
}

/**
 * Whether a spec is a wildcard IN THE SERVER'S GRAMMAR — only `*` and `ns.*`.
 *
 * "Contains a star" is not the question: `payment*` is an exact string to the
 * bridge, matches no event ever sent, and was drawn on the map as a working
 * wildcard.
 */
export function isWildcardPattern(pattern: string): boolean {
  const trimmed = pattern.trim()
  return trimmed === '*' || trimmed.endsWith('.*')
}

/**
 * The event types the panel has CHECKED a pop-up can be shown on: the `type` of
 * every entry in the server's `POPUP_CAPABLE_EVENTS`
 * (`src/modules/automations/popup-capable-events.ts`), pinned to it in both
 * directions by `popup-audience.test.ts`.
 *
 * CLOSED, NOT EXHAUSTIVE. The server's own spec proves every entry is emitted
 * and names a customer; it proves nothing about the events left out. A custom
 * or unlisted type that does carry a `userId` works at run time — the server
 * says so beside its save-time check (`automations.service.ts`), and rules on
 * `support.ticket_created` or `partner.activated` saved before that check do
 * show their pop-ups. Absence from this list is "not checked", never "cannot".
 *
 * A LIST AND NOT A QUESTION. Ask `canCarryPopup`, never "is it in the list": a
 * wildcard such as `payment.*` is a member of no list and carries pop-ups
 * perfectly well — the server removed its own set for exactly that reason.
 */
export const POPUP_CAPABLE_EVENT_TYPES: readonly string[] = [
  'user.registered',
  'user.web_registered',
  'user.first_traffic',
  'subscription.created',
  'subscription.trial_granted',
  'payment.completed',
  'payment.failed',
  'promocode.activated',
  'remnawave.user.expire_soon',
  'remnawave.user.expired',
  'remnawave.user.bandwidth_threshold',
  'remnawave.user.limited',
  'remnawave.user.first_connected',
  'remnawave.user.enabled',
  'remnawave.user.disabled',
  'remnawave.user.traffic_reset',
  'referral.qualified',
  'referral.reward_issued',
  'fraud.signal_opened',
]

/**
 * Whether a realtime rule on this spec is on an event the panel has CHECKED a
 * pop-up can be shown on — the server's `canCarryPopup`, restated line for line
 * over the list above. The name is the server's; the answer is "checked or not".
 *
 * `true` is a fact: something emits the event and it names a customer.
 *
 * `false` is NOT the opposite fact. It means the panel does not know. The event
 * may never be sent (a rule on the pre-fix template triggers `user.expire_soon`,
 * `subscription.expired` or `user.bandwidth_usage_threshold_reached` is never
 * selected), it may be sent without a customer (`show_hint` then fails on every
 * run), or it may be an unlisted event that does name one and works. What IS
 * certain: the server refuses to save any change to such a rule until its event
 * is changed, and whether it works shows only in the rule's run log. So callers
 * draw it as unchecked — never as broken, never as "customers will not see it".
 */
export function canCarryPopup(triggerSpec: string): boolean {
  const spec = triggerSpec.trim()
  if (spec.length === 0) return false
  return POPUP_CAPABLE_EVENT_TYPES.some((type) => matchEventPattern(spec, type))
}

/**
 * The audiences `show_hint_to_audience` accepts: the server's `HINT_AUDIENCES`
 * (`src/modules/user-hints/services/hint-audience.service.ts`), pinned by
 * `popup-audience.test.ts`. Anything else — or none — fails every run with
 * "requires `audience`".
 */
export const HINT_AUDIENCE_NAMES: readonly string[] = ['paid-not-connected']

export function isKnownAudience(audience: string | null): boolean {
  return audience !== null && HINT_AUDIENCE_NAMES.includes(audience.trim())
}
