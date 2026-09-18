import { HINT_TEMPLATES, HINT_TEMPLATE_STAGES, type HintTemplateStage } from './hint-templates'
import type { AutomationRule } from './automations-api'
import {
  canCarryPopup,
  isKnownAudience,
  isWildcardPattern,
  matchEventPattern,
  surfaceGap,
  type HintSurface,
} from './popup-audience'
import type { UserHint } from '@/features/user-hints/user-hints-api'

/**
 * trigger-map
 * ───────────
 * What actually happens between an event and a customer's screen, per trigger.
 *
 * ── Why a map and not a list ─────────────────────────────────────────────────
 *
 * A pop-up is two rows in two different tables, connected by a string. The
 * rules tab shows one of them; the hints tab shows the other; nothing showed
 * the STRING. So the two ways this subsystem fails are both invisible in the
 * places an operator looks:
 *
 *   A RULE WITH NO HINT fails at firing time, in an execution log, after the
 *   moment it was written for has passed. The rule reads "enabled" in the list
 *   the whole time.
 *
 *   A HINT WITH NO RULE fails by never being mentioned. It sits in the hints
 *   tab looking finished.
 *
 * Neither is a bug in the code — both are a link an operator did not make, and
 * an operator cannot make a link they cannot see. That is the whole reason this
 * file exists: it is the join, computed from the two lists that already load.
 *
 * ── What it deliberately does not do ─────────────────────────────────────────
 *
 * It draws no edge for a rule whose actions show no pop-up. A rule that sends
 * Telegram on the same event is real and useful and is not a path to a pop-up,
 * and a map that drew it would be a map of automations rather than of pop-ups.
 *
 * ── Everything it counts, it draws ───────────────────────────────────────────
 *
 * A badge is a promise that the thing it counts is on screen to be pressed. So
 * a rule the counts include always has a place: a path on an event row, a row
 * of its own when it reaches no event row, or the scheduled list when it has no
 * event at all.
 */

/** How a path between one trigger and one pop-up is doing. */
export type TriggerPathState =
  /** Enabled rule, hint exists and is switched on. Customers are seeing this. */
  | 'live'
  /** Everything is built and the rule is switched off. One toggle away. */
  | 'paused'
  /**
   * The rule fires and names a hint key nothing answers to.
   *
   * THE SILENT ONE. It fails at run time, once, per firing, in a log — never at
   * save time, and never anywhere an operator would be looking.
   */
  | 'missing-hint'
  /** The hint exists but is switched off, so the rule fires into nothing. */
  | 'hint-inactive'
  /**
   * The rule's event is not one the panel has CHECKED a pop-up can be shown on
   * (`canCarryPopup` is false). UNCERTAIN, not broken.
   *
   * The server's list is closed, not exhaustive. Rules on the pre-fix template
   * triggers (`user.expire_soon` and its two siblings) never fire; a rule on an
   * unlisted event that does name a customer — `support.ticket_created`,
   * `partner.activated` — works. The map cannot tell which, so it says neither:
   * amber, counted apart, and pointing at the rule's run log. Drawing these red
   * told an operator to delete pop-ups that were being shown.
   */
  | 'unverified'
  /**
   * `show_hint_to_audience` on an event rule. The action refuses an event
   * trigger outright, so every run fails — certain, and red.
   */
  | 'audience-on-event'

export interface TriggerPath {
  readonly ruleId: string
  readonly ruleName: string
  readonly hintKey: string
  /** The hint's own title, or null when there is no such hint. */
  readonly hintTitle: string | null
  readonly state: TriggerPathState
  /**
   * The rule carries conditions, so the event firing is not the whole story.
   *
   * `live` is defined here as "enabled rule, hint switched on" and drawn in
   * green with the words "customers are seeing this". For a rule gated on
   * `{"plan": "vip"}` that is a claim this view has no way to make: the
   * conditions are evaluated server-side against a payload the map never sees,
   * they can narrow the audience to a handful, and a condition that matches
   * NOBODY renders exactly as green as one that matches everybody. The state
   * stays `live` — it is live — and the row says out loud that there is a
   * filter in front of it.
   */
  readonly hasConditions: boolean
  /**
   * Where the customers this trigger names open the cabinet, and the hint may
   * not appear — `[]` when there is no such place (see `surfaceGap`).
   *
   * The state is not changed by it, on purpose. A welcome on the Telegram
   * sign-up limited to «Браузер» is `live` in every sense the map can check —
   * rule on, hint written and on — and it reaches nobody, because the people
   * that event names are inside Telegram. That is the case the owner hit, and
   * it was green here. A LIKELY miss rather than a certain one (somebody who
   * signed up in the bot can open the site later), so it is a marker beside
   * the state, not a state of its own and not a count.
   */
  readonly surfaceGap: readonly HintSurface[]
  /**
   * The rule's own switch.
   *
   * `paused` says it by being that state, and every other state used to hide
   * it: an operator who had just switched a legacy rule off saw the same amber
   * chip as before, «Выключено» stayed at 0, and the explanation still talked
   * about what happens when the event arrives. The map and «Кто увидит», which
   * has always carried the badge, disagreed about the one thing just changed.
   */
  readonly isEnabled: boolean
}

/** A template an operator could apply to this trigger but has not. */
export interface TriggerOffer {
  readonly templateId: string
  readonly hintKey: string
  /** True when the hint already exists — applying the template only adds a rule. */
  readonly hintExists: boolean
}

/**
 * The lanes of the map: the customer-life stages the template library names,
 * and «Прочее» for the rows it does not — a rule on an unlisted event, a
 * wildcard, a legacy trigger. They used to land in the LAST stage, which is
 * headed «Безопасность» and holds one template about a fraud signal, so a
 * support-ticket rule was filed under Security.
 *
 * `HINT_TEMPLATE_STAGES` is not touched: it is the template library's own
 * vocabulary, and `other` is a lane of this map, not a stage a template can
 * have.
 */
export type TriggerLaneStage = HintTemplateStage | 'other'

export const TRIGGER_LANE_STAGES: readonly TriggerLaneStage[] = [...HINT_TEMPLATE_STAGES, 'other']

export interface TriggerNode {
  readonly type: string
  readonly stage: TriggerLaneStage
  /** Paths that exist, whatever state they are in. */
  readonly paths: readonly TriggerPath[]
  /** Ready-made pop-ups for this trigger that nothing is using yet. */
  readonly offers: readonly TriggerOffer[]
  /**
   * Rules that reach this trigger through a wildcard rather than by naming it.
   *
   * A CROSS-REFERENCE, not a count: each wildcard rule is drawn and counted on
   * a row of its own, and this is what tells an operator staring at a bare row
   * that a wildcard already covers it — before they add a second pop-up and
   * get two. Counting here as well multiplied one rule by the rows it reaches;
   * counting only in the pre-loop left a badge with nothing to press.
   */
  readonly wildcardRuleIds: readonly string[]
}

export interface TriggerLane {
  readonly stage: TriggerLaneStage
  readonly triggers: readonly TriggerNode[]
}

/** Why a rule with no event of its own can never show the hint it names. */
export type EventlessFailureReason =
  /** `show_hint` on a CRON rule: a schedule names no customer. */
  | 'schedule-names-nobody'
  /** `show_hint_to_audience` with no audience, or one the panel does not know. */
  | 'audience-invalid'

/**
 * A rule that names a hint, has no event to put on a row, and fails on every
 * automatic run. Listed on its own — counted, and in sight — instead of
 * letting it mark its hint as used in silence, which is what the hints tab
 * already reports as a rule that shows nobody anything.
 */
export interface EventlessFailure {
  readonly ruleId: string
  readonly ruleName: string
  readonly hintKey: string
  /** The hint's own title, or null when there is no such hint. */
  readonly hintTitle: string | null
  readonly reason: EventlessFailureReason
  readonly isEnabled: boolean
}

/**
 * Hints the CABINET raises for itself, with no rule involved.
 *
 * The panel teaches operators to author these — the hints tab says in as many
 * words that a hint keyed `subscription-ready` fires when the cabinet has
 * finished provisioning a purchase — and no rule names them, so the orphan
 * filter reported them as hints no customer will ever see. Two screens of one
 * panel, one telling the operator to create it and the other telling them it is
 * dead.
 *
 * Mirrors `CLIENT_MOMENTS` in the panel's internal hints controller. A moment
 * added there and not here comes back as a false orphan — and, in the hint
 * editor's «Кто увидит», as "no rule shows this hint" about one the cabinet
 * shows by itself.
 */
export const CLIENT_MOMENT_KEYS: ReadonlySet<string> = new Set(['subscription-ready'])

/** A hint nothing points at, from any rule or any template. */
export interface OrphanHint {
  readonly key: string
  readonly title: string
  readonly isActive: boolean
}

export interface TriggerMap {
  readonly lanes: readonly TriggerLane[]
  readonly orphanHints: readonly OrphanHint[]
  /** Rules with no event that fail on every automatic run. */
  readonly eventlessFailures: readonly EventlessFailure[]
  /** Totals, so the card can say what it is worth opening for. */
  readonly counts: {
    readonly live: number
    readonly paused: number
    /** Certain failures. */
    readonly broken: number
    /** Rules on events the panel has not checked — uncertain, not broken. */
    readonly unverified: number
    readonly unused: number
  }
}

/**
 * What a rule's trigger spec means — the SECOND copy of this grammar, and the
 * only one that is allowed to exist.
 *
 * The first lives in `src/modules/automations/event-pattern.ts` and is the
 * authority: the bridge selects rules with it at run time, and the save-time
 * pop-up check answers with it. This one exists because the two halves are
 * separate packages and importing the server module here would pull NestJS
 * source into the browser bundle to evaluate nine lines of string comparison.
 *
 * The implementation moved to `popup-audience.ts`, which needs it for the
 * capability check and is imported by this file — defining it here would have
 * made the two modules import each other. It is re-exported so every existing
 * `from './trigger-map'` import keeps working.
 *
 * A second opinion about what a pattern means is the shape of defect this
 * subsystem has already been bitten by — `canCarryPopup` once disagreed with
 * the bridge about `*`, so the panel refused to save a rule that would have
 * worked. What stops it recurring is not care: `trigger-map.test.ts` imports
 * BOTH functions and runs them over the same corpus, so a change to either
 * that the other does not follow fails the build.
 */
export { matchEventPattern }


/** One pop-up action of a rule: which kind, which hint, which audience. */
interface PopupAction {
  readonly kind: 'show_hint' | 'show_hint_to_audience'
  readonly hintKey: string
  /** Only the audience action has one; trimmed, or `null`. */
  readonly audience: string | null
}

/**
 * The pop-up actions a rule carries, one entry per kind and key.
 *
 * Deduplicated on purpose, and the reason is the action picker: it does not
 * exclude a key the rule already uses, so one rule can carry the same action
 * twice — which is one path, not two.
 */
function popupActionsOf(rule: AutomationRule): PopupAction[] {
  const seen = new Set<string>()
  const actions: PopupAction[] = []
  for (const action of rule.actions) {
    if (action.type !== 'show_hint' && action.type !== 'show_hint_to_audience') continue
    const params = (action.params ?? {}) as Record<string, unknown>
    const rawKey = params['hintKey']
    const hintKey =
      typeof rawKey === 'string' && rawKey.trim().length > 0
        ? rawKey.trim()
        : unusableKeyLabel(rawKey)
    const token = `${action.type}:${hintKey}`
    if (seen.has(token)) continue
    seen.add(token)
    const rawAudience = params['audience']
    const kind: PopupAction['kind'] =
      action.type === 'show_hint' ? 'show_hint' : 'show_hint_to_audience'
    actions.push({
      kind,
      hintKey,
      audience:
        typeof rawAudience === 'string' && rawAudience.trim().length > 0
          ? rawAudience.trim()
          : null,
    })
  }
  return actions
}

/**
 * What to draw in place of a `hintKey` no rule can use.
 *
 * ── Why this exists at all ────────────────────────────────────────────────
 *
 * `params` is `Record<string, unknown>` because that is what the API returns:
 * the column is JSON, nothing validates the shape of an action's parameters at
 * save time, and an older install, a hand-edited row or a half-finished form
 * can leave `hintKey` as null, a number, an object, or an empty string.
 *
 * Every such key used to be mapped to `''` and filtered out, which took the
 * whole RULE with it — only rules with at least one key were drawn — and the
 * consequences were the opposite of harmless. The rule vanished from the map,
 * its trigger row went back to looking bare, and the map then OFFERED a
 * ready-made pop-up on it, because "nothing is working here" is exactly the
 * state that opens the offers. The operator applied the offer and now had two
 * rules on one trigger, one of which fires into nothing. Neither the rules tab
 * nor the hints tab shows any of that; this view is the only one that could.
 *
 * So a broken key is drawn instead of dropped: the row keeps its rule, the
 * state resolves to `missing-hint` (no hint can answer to this), and the red
 * "will not fire" badge counts it — which is the failure the whole view exists
 * to surface.
 *
 * ── Why it renders the value ──────────────────────────────────────────────
 *
 * "Something is wrong here" sends an operator to the database. `null` or `42`
 * or `{"key":"x"}` tells them which mistake it was. The rendering is JSON so it
 * is the same in both languages, and it is bracketed because `<` cannot occur
 * in a hint key (`/^[a-z0-9][a-z0-9-]*$/` in the DTO) — without the brackets a
 * rule carrying the literal `null` would be matched against a real hint keyed
 * `null`, which that pattern permits, and drawn green.
 */
function unusableKeyLabel(value: unknown): string {
  let rendered: string
  try {
    rendered = JSON.stringify(value) ?? String(value)
  } catch {
    // Circular, or a `toJSON` that throws. The shape still tells the operator
    // more than silence does.
    rendered = Object.prototype.toString.call(value)
  }
  // Bounded: an action payload can hold an arbitrarily large object, and this
  // string goes into a badge on a row.
  const clipped = rendered.length > 40 ? `${rendered.slice(0, 40)}…` : rendered
  return `<${clipped}>`
}

/**
 * The state of a `show_hint` path.
 *
 * Certain failures first: a hint that does not exist or is switched off shows
 * nothing whatever the event does. Only when the hint side is sound does the
 * event's uncertainty decide — and it decides for a switched-off rule too,
 * because switching it on would not settle whether the event names a customer.
 */
function pathState(rule: AutomationRule, hint: UserHint | undefined): TriggerPathState {
  if (hint === undefined) return 'missing-hint'
  if (!hint.isActive) return 'hint-inactive'
  if (!canCarryPopup(rule.triggerSpec)) return 'unverified'
  return rule.isEnabled ? 'live' : 'paused'
}

/**
 * Which lane an event the template library does not cover belongs in.
 *
 * ── The lane it used to get ───────────────────────────────────────────────
 *
 * `'security'`, for everything. The comment said it "lands in the last lane
 * rather than vanishing", which is true of the ORDER — `HINT_TEMPLATE_STAGES`
 * ends there — and false of the MEANING: that lane is headed «Безопасность»,
 * it holds exactly one template (a fraud signal about one customer), and the
 * two events that actually reach this function are `referral.qualified` and
 * `referral.reward_issued`. An operator's referral pop-up was filed under
 * Security, which is not merely untidy: the map is the screen somebody scans
 * when they are looking for the rule they wrote, and it was never where they
 * looked.
 *
 * ── Why these two events and no others ────────────────────────────────────
 *
 * The server refuses to SAVE a realtime `show_hint` rule whose trigger is not
 * in `POPUP_CAPABLE_EVENTS` (`automations.service.ts`, "cannot show a pop-up"),
 * so the set that can arrive here is exactly the capable events the library has
 * no template for. Today that is the referral pair, and
 * `trigger-map.test.ts` reads the server list and fails if a capable event is
 * added over there with neither a template nor a lane here — rather than
 * silently landing in the wrong one, which is how this was missed.
 *
 * The pair belongs in `rewards` for the same reason `promocode.activated` does:
 * both are a bonus arriving because of something the customer did, and the
 * server's own catalogue groups them under "Invitations". This is a product
 * fact and not a derivable one, which is why it is written down rather than
 * computed — the same reason `COINCIDENT_EVENT_GROUPS` is hand-written.
 */
const UNTEMPLATED_TRIGGER_LANE: ReadonlyMap<string, HintTemplateStage> = new Map([
  ['referral.qualified', 'rewards'],
  ['referral.reward_issued', 'rewards'],
])

/**
 * The residual, for a trigger no template covers and no entry above names.
 *
 * A WILDCARD row first asks the events it reaches: `referral.*` reaches only the
 * referral pair, so it belongs where they do rather than under «Безопасность».
 *
 * Otherwise only an install carrying a rule from before the save-time capability
 * check can reach it — `subscription.renewed`, say, on a rule written years ago.
 * A neighbour in the same namespace is the best available answer and it is a
 * good one when the namespace agrees with itself: every `payment.*` template is
 * in `payment`, so a legacy `payment.refunded` rule lands in «Оплата» instead of
 * «Безопасность». Where the namespace disagrees — `remnawave.user.*` spans
 * three lanes — there is no honest answer, and the last lane is taken for want
 * of one.
 *
 * What is left lands in «Прочее» — a lane of this map rather than a stage a
 * template can have. It used to land in the LAST stage, and that is a real
 * heading: «Безопасность», one template, about a fraud signal. A rule on
 * `support.ticket_created`, a legacy `*` audience rule and every wildcard row
 * were filed under Security, which is not where anybody looks for them.
 */
function laneForUntemplated(spec: string): TriggerLaneStage {
  const named = UNTEMPLATED_TRIGGER_LANE.get(spec)
  if (named !== undefined) return named

  if (isWildcardPattern(spec)) {
    const reached = new Set<HintTemplateStage>([
      ...HINT_TEMPLATES.filter((template) => matchEventPattern(spec, template.triggerSpec)).map(
        (template) => template.stage,
      ),
      ...[...UNTEMPLATED_TRIGGER_LANE]
        .filter(([type]) => matchEventPattern(spec, type))
        .map(([, stage]) => stage),
    ])
    if (reached.size === 1) return [...reached][0]!
  }

  const dot = spec.indexOf('.')
  const namespace = dot > 0 ? spec.slice(0, dot) : ''
  if (namespace.length > 0) {
    const neighbours = new Set(
      HINT_TEMPLATES.filter((template) => template.triggerSpec.startsWith(`${namespace}.`)).map(
        (template) => template.stage,
      ),
    )
    // Unanimity only. A namespace whose templates disagree would otherwise be
    // decided by whichever template happens to be declared first.
    if (neighbours.size === 1) return [...neighbours][0]!
  }

  return 'other'
}

/** One realtime rule's pop-up action, and the spec it is drawn on. */
interface RealtimeEntry {
  readonly rule: AutomationRule
  readonly spec: string
  readonly action: PopupAction
}

/**
 * The map, from the two lists the page already has.
 *
 * Triggers come from the TEMPLATES rather than from a list of their own: those
 * are the events the panel ships a ready-made pop-up for, which is exactly the
 * set an operator can build a path on without writing anything. Every spec a
 * rule names gets a row too — an event, a wildcard, or a string the bridge will
 * never match — because a rule an operator wrote has to be somewhere they can
 * see it.
 *
 * ── Everything counted is drawn, exactly once ─────────────────────────────
 *
 * Each pop-up action is counted where its chip is: on the row named by its own
 * spec. A wildcard used to be counted before this loop and drawn nowhere, so
 * one `payment.*` rule naming a deleted hint read «1 не сработает» with no red
 * chip anywhere and nothing to press. The rows such a rule reaches keep a
 * cross-reference — «плюс N правил по маске» — which is not a count.
 */
export function buildTriggerMap(input: {
  readonly rules: readonly AutomationRule[]
  readonly hints: readonly UserHint[]
}): TriggerMap {
  const hintByKey = new Map(input.hints.map((hint) => [hint.key, hint]))

  const realtime: RealtimeEntry[] = []
  const eventlessFailures: EventlessFailure[] = []
  const usedKeys = new Set<string>()
  const counts = { live: 0, paused: 0, broken: 0, unverified: 0, unused: 0 }
  const count = (state: TriggerPathState): void => {
    if (state === 'live') counts.live += 1
    else if (state === 'paused') counts.paused += 1
    else if (state === 'unverified') counts.unverified += 1
    else counts.broken += 1
  }

  for (const rule of input.rules) {
    const spec = rule.triggerSpec.trim()
    for (const action of popupActionsOf(rule)) {
      // A HINT NOTHING POINTS AT means no rule of ANY kind names it. MANUAL
      // rules (one pop-up to one customer) and the nightly audience job have no
      // event to draw and do fire their hint: reporting those under "hints
      // nothing points at" once got the flagship nightly pop-up deleted.
      usedKeys.add(action.hintKey)

      if (rule.triggerKind === 'REALTIME') {
        // A realtime rule with no pattern is selected by nothing, and the server
        // refuses to save one, so there is no row to draw it on.
        if (spec.length > 0) realtime.push({ rule, spec, action })
        continue
      }

      // No event of its own. Two shapes fail on every automatic run and are
      // listed apart; the rest work and simply are not a path on any event.
      const reason: EventlessFailureReason | null =
        action.kind === 'show_hint'
          ? rule.triggerKind === 'CRON'
            ? 'schedule-names-nobody'
            : null
          : isKnownAudience(action.audience)
            ? null
            : 'audience-invalid'
      if (reason === null) continue
      counts.broken += 1
      eventlessFailures.push({
        ruleId: rule.id,
        ruleName: rule.name,
        hintKey: action.hintKey,
        hintTitle: hintByKey.get(action.hintKey)?.titleRu ?? null,
        reason,
        isEnabled: rule.isEnabled,
      })
    }
  }

  // ── Rows ─────────────────────────────────────────────────────────────────
  //
  // Every template event, and every spec a rule names — a wildcard included,
  // because that is where its own chip goes.
  const stageOf = new Map<string, TriggerLaneStage>()
  for (const template of HINT_TEMPLATES) stageOf.set(template.triggerSpec, template.stage)
  for (const entry of realtime) {
    if (!stageOf.has(entry.spec)) stageOf.set(entry.spec, laneForUntemplated(entry.spec))
  }

  const pathOf = (entry: RealtimeEntry, state: TriggerPathState, type: string): TriggerPath => {
    const hint = hintByKey.get(entry.action.hintKey)
    return {
      ruleId: entry.rule.id,
      ruleName: entry.rule.name,
      hintKey: entry.action.hintKey,
      hintTitle: hint?.titleRu ?? null,
      state,
      isEnabled: entry.rule.isEnabled,
      // `null` and `{}` both mean "no filter". An empty object is what the
      // editor leaves behind when an operator clears the field, and calling
      // that "conditional" would put the marker on rules that have none.
      hasConditions:
        entry.rule.conditions !== null &&
        typeof entry.rule.conditions === 'object' &&
        Object.keys(entry.rule.conditions as Record<string, unknown>).length > 0,
      // Nothing to compare against when the hint does not exist, and nothing to
      // warn about on an action that shows nothing on any surface.
      surfaceGap:
        hint === undefined || state === 'audience-on-event'
          ? []
          : surfaceGap(type, hint.surfaces),
    }
  }

  const nodes: TriggerNode[] = []
  for (const [type, stage] of stageOf) {
    const paths: TriggerPath[] = []
    const wildcardRuleIds: string[] = []
    // A row that is itself a pattern belongs to the rule that owns it; other
    // wildcards are not "reaching" a pattern.
    const isEventRow = !isWildcardPattern(type)

    for (const entry of realtime) {
      if (entry.spec === type) {
        const state =
          entry.action.kind === 'show_hint_to_audience'
            ? 'audience-on-event'
            : pathState(entry.rule, hintByKey.get(entry.action.hintKey))
        count(state)
        paths.push(pathOf(entry, state, type))
      } else if (
        // A cross-reference only, and never for an action that shows nothing
        // anywhere: an audience rule listed here would claim to cover the row
        // and would take its ready-made pop-ups away.
        entry.action.kind === 'show_hint' &&
        isEventRow &&
        isWildcardPattern(entry.spec) &&
        matchEventPattern(entry.spec, type)
      ) {
        wildcardRuleIds.push(entry.rule.id)
      }
    }

    // OFFERED WHILE NOTHING ON THIS TRIGGER ACTUALLY WORKS.
    //
    // The first version asked "is THIS template's key already in use", which is
    // not the question: with one half of an alternative pair live and green, it
    // offered the other half beside it as a dashed button, and pressing that is
    // two pop-ups for one act.
    //
    // The second asked "does this trigger have any path", which is not the
    // question either — it conflates "served" with "has a row". Delete a hint
    // that a rule still names and the row shows one red badge saying the key
    // resolves to nothing AND loses both ready-made templates, so the map's own
    // repair affordance disappeared in precisely the state the map exists to
    // surface. `unused` quietly dropped by two at the same time.
    //
    // The question is whether anything on this trigger is WORKING. A live or
    // paused path is working or one toggle from it; a broken or unchecked one is
    // not. A wildcard reaching the row counts too: it already shows a pop-up
    // here, and a template applied beside it would make two.
    const served = paths.some((path) => path.state === 'live' || path.state === 'paused')
    const offers = (served || wildcardRuleIds.length > 0
      ? []
      : HINT_TEMPLATES.filter((template) => template.triggerSpec === type)
    ).map((template) => ({
      templateId: template.id,
      hintKey: template.hintKey,
      hintExists: hintByKey.has(template.hintKey),
    }))
    counts.unused += offers.length

    nodes.push({ type, stage, paths, offers, wildcardRuleIds })
  }

  // A hint nothing points at. Templates are excluded on purpose: applying one
  // creates the hint before the rule is saved, so a half-finished template is
  // an unused OFFER — which the trigger row already says — and listing it here
  // as well would report one gap twice.
  const templateKeys = new Set(HINT_TEMPLATES.map((template) => template.hintKey))
  const orphanHints = input.hints
    .filter(
      (hint) =>
        !usedKeys.has(hint.key) &&
        !templateKeys.has(hint.key) &&
        !CLIENT_MOMENT_KEYS.has(hint.key),
    )
    .map((hint) => ({ key: hint.key, title: hint.titleRu, isActive: hint.isActive }))

  const lanes = TRIGGER_LANE_STAGES.map((stage) => ({
    stage,
    triggers: nodes.filter((node) => node.stage === stage),
  })).filter((lane) => lane.triggers.length > 0)

  return { lanes, orphanHints, eventlessFailures, counts }
}
