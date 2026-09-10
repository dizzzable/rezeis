import { HINT_TEMPLATES, HINT_TEMPLATE_STAGES, type HintTemplateStage } from './hint-templates'
import type { AutomationRule } from './automations-api'
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
 * It draws no edge for anything but a REALTIME rule whose action is `show_hint`.
 * A rule that sends Telegram on the same event is real and useful and is not a
 * path to a pop-up, and a map that drew it would be a map of automations rather
 * than of pop-ups — at which point it stops answering the question it is for.
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
}

/** A template an operator could apply to this trigger but has not. */
export interface TriggerOffer {
  readonly templateId: string
  readonly hintKey: string
  /** True when the hint already exists — applying the template only adds a rule. */
  readonly hintExists: boolean
}

export interface TriggerNode {
  readonly type: string
  readonly stage: HintTemplateStage
  /** Paths that exist, whatever state they are in. */
  readonly paths: readonly TriggerPath[]
  /** Ready-made pop-ups for this trigger that nothing is using yet. */
  readonly offers: readonly TriggerOffer[]
  /**
   * Rules that reach this trigger through a wildcard rather than by naming it.
   *
   * Counted separately because they are the reason a trigger with no paths of
   * its own can still fire a pop-up: one `*` rule covers everything, and an
   * operator staring at an empty row needs to know that before they add a
   * second one and get two.
   */
  readonly wildcardRuleIds: readonly string[]
}

export interface TriggerLane {
  readonly stage: HintTemplateStage
  readonly triggers: readonly TriggerNode[]
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
 * added there and not here comes back as a false orphan.
 */
const CLIENT_MOMENT_KEYS: ReadonlySet<string> = new Set(['subscription-ready'])

/** A hint nothing points at, from any rule or any template. */
export interface OrphanHint {
  readonly key: string
  readonly title: string
  readonly isActive: boolean
}

export interface TriggerMap {
  readonly lanes: readonly TriggerLane[]
  readonly orphanHints: readonly OrphanHint[]
  /** Totals, so the card can say what it is worth opening for. */
  readonly counts: {
    readonly live: number
    readonly paused: number
    readonly broken: number
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
 * A second opinion about what a pattern means is the shape of defect this
 * subsystem has already been bitten by — `canCarryPopup` once disagreed with
 * the bridge about `*`, so the panel refused to save a rule that would have
 * worked. What stops it recurring is not care: `trigger-map.test.ts` imports
 * BOTH functions and runs them over the same corpus, so a change to either
 * that the other does not follow fails the build.
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

/** Every `show_hint` key a rule's actions name. */
/**
 * The hint keys a rule names.
 *
 * `includeAudience` widens it to `show_hint_to_audience`, the CRON action that
 * sends one pop-up to everyone matching a query. That action can never be drawn
 * as a PATH — there is no event on the map to hang it from — but the hint it
 * names is very much in use, and the orphan list is built from what is left
 * over. Without this the flagship nightly audience pop-up was reported as a
 * hint no customer will ever see.
 *
 * Duplicates are removed. An operator can add "show a hint" twice and pick the
 * same hint both times — the picker does not exclude a key the rule already
 * uses — and counting that as two paths inflated the live count and drew two
 * identical badges under one duplicate React key.
 *
 * A KEY THAT IS NOT A USABLE STRING STILL COUNTS — see `unusableKeyLabel`.
 */
function hintKeysOf(
  rule: AutomationRule,
  options: { readonly includeAudience?: boolean } = {},
): string[] {
  const wanted = options.includeAudience === true
    ? ['show_hint', 'show_hint_to_audience']
    : ['show_hint']
  const keys = rule.actions
    .filter((action) => wanted.includes(action.type))
    .map((action) => {
      const params = (action.params ?? {}) as Record<string, unknown>
      const key = params['hintKey']
      if (typeof key === 'string' && key.trim().length > 0) return key.trim()
      return unusableKeyLabel(key)
    })
  return [...new Set(keys)]
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
 * whole RULE with it — `popupRules` keeps only entries with at least one key —
 * and the consequences were the opposite of harmless. The rule vanished from
 * the map, its trigger row went back to looking bare, and the map then OFFERED
 * a ready-made pop-up on it, because "nothing is working here" is exactly the
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

function pathState(rule: AutomationRule, hint: UserHint | undefined): TriggerPathState {
  if (hint === undefined) return 'missing-hint'
  if (!hint.isActive) return 'hint-inactive'
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
 * Only an install carrying a rule from before the save-time capability check
 * can reach it — `subscription.renewed`, say, on a rule written years ago. A
 * neighbour in the same namespace is the best available answer and it is a good
 * one when the namespace agrees with itself: every `payment.*` template is in
 * `payment`, so a legacy `payment.refunded` rule lands in «Оплата» instead of
 * «Безопасность». Where the namespace disagrees — `remnawave.user.*` spans
 * three lanes — there is no honest answer, and the last lane is taken for want
 * of one.
 *
 * TODO(i18n): the honest answer is a lane of its own, headed «Прочее» /
 * "Other", which needs `automationsPage.hintTemplates.stages.other` in both
 * bundles. Until that key exists this reuses a real heading, which is the one
 * thing this function is trying to stop doing.
 */
function laneForUntemplated(spec: string): HintTemplateStage {
  const named = UNTEMPLATED_TRIGGER_LANE.get(spec)
  if (named !== undefined) return named

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

  return HINT_TEMPLATE_STAGES[HINT_TEMPLATE_STAGES.length - 1]!
}

/**
 * The map, from the two lists the page already has.
 *
 * Triggers come from the TEMPLATES rather than from a list of their own: those
 * are the events the panel ships a ready-made pop-up for, which is exactly the
 * set an operator can build a path on without writing anything. A rule bound to
 * some other capable event still appears — under the trigger it names — because
 * the trigger set is the union of both.
 */
export function buildTriggerMap(input: {
  readonly rules: readonly AutomationRule[]
  readonly hints: readonly UserHint[]
}): TriggerMap {
  const hintByKey = new Map(input.hints.map((hint) => [hint.key, hint]))

  // Only REALTIME rules with a `show_hint` action can be drawn as a PATH on a
  // trigger row: a path says "this event happens and this pop-up follows", and
  // a rule with no event has no row to sit on.
  const popupRules = input.rules
    .filter((rule) => rule.triggerKind === 'REALTIME')
    .map((rule) => ({ rule, keys: hintKeysOf(rule) }))
    .filter((entry) => entry.keys.length > 0)

  // EVERY OTHER RULE THAT NAMES A HINT STILL USES IT.
  //
  // Two kinds were being ignored, and the server permits both on purpose:
  // `show_hint` on a MANUAL rule, which is how an operator sends one pop-up to
  // one customer, and `show_hint_to_audience` on a CRON rule, which is the
  // nightly "paid a day ago and never connected" job.
  //
  // Neither can be drawn as a path — there is no event to draw it from — but
  // both are rules that fire the hint, and the orphan list is built from what
  // is left over. So the flagship audience pop-up appeared under "hints nothing
  // points at", captioned "no customer will ever see them". An operator who
  // takes that advice deletes the hint, and the nightly job then logs "hint was
  // raised but no such hint exists" once per matched customer, up to five
  // hundred times a night, with nothing at all on screen.
  const otherRulesUsingHints = input.rules
    .filter((rule) => rule.triggerKind !== 'REALTIME' || hintKeysOf(rule).length === 0)
    .flatMap((rule) => hintKeysOf(rule, { includeAudience: true }))

  const stageOf = new Map<string, HintTemplateStage>()
  for (const template of HINT_TEMPLATES) {
    stageOf.set(template.triggerSpec, template.stage)
  }

  // A rule may name an event no template covers. It belongs on the map — an
  // operator who wrote it wants to see it — and it has no stage of its own.
  for (const { rule } of popupRules) {
    const spec = rule.triggerSpec.trim()
    if (spec.length === 0 || spec.includes('*')) continue
    if (!stageOf.has(spec)) stageOf.set(spec, laneForUntemplated(spec))
  }

  const counts = { live: 0, paused: 0, broken: 0, unused: 0 }
  const nodes: TriggerNode[] = []
  const usedKeys = new Set<string>()

  // WILDCARD RULES ARE COUNTED ONCE, HERE, BEFORE THE PER-TRIGGER LOOP.
  //
  // They used to be counted inside it, which multiplied them by the number of
  // triggers they reach: a single `*` rule naming a hint that does not exist
  // rendered a red badge reading "17 will not fire" for ONE mistake. The other
  // half of that asymmetry was worse — the same branch never touched `live` or
  // `paused`, so an operator who fixed the hint watched the red badge drop to
  // zero and the green one stay at zero, while that rule was delivering a
  // pop-up on every event in the product.
  //
  // Counting here also reaches the wildcards the loop below never sees at all.
  // The loop runs over trigger types drawn from templates and from EXACT rule
  // specs, so a rule on `referral.*` — which the server accepts, and which
  // fires — matched no row, contributed to no count, and its hint dropped
  // through into "hints nothing points at" with the sentence saying no customer
  // will ever see it.
  for (const { rule, keys } of popupRules) {
    const spec = rule.triggerSpec.trim()
    if (!spec.includes('*')) continue
    for (const key of keys) {
      usedKeys.add(key)
      const state = pathState(rule, hintByKey.get(key))
      if (state === 'live') counts.live += 1
      else if (state === 'paused') counts.paused += 1
      else counts.broken += 1
    }
  }

  // And the keys named by rules that are not paths at all — MANUAL, and the
  // CRON audience job. Used, therefore not orphans.
  for (const key of otherRulesUsingHints) usedKeys.add(key)

  for (const [type, stage] of stageOf) {
    const paths: TriggerPath[] = []
    const wildcardRuleIds: string[] = []

    for (const { rule, keys } of popupRules) {
      const spec = rule.triggerSpec.trim()
      const exact = spec === type
      if (!exact && !matchEventPattern(spec, type)) continue
      if (!exact) {
        wildcardRuleIds.push(rule.id)
        // ITS KEYS STILL COUNT, and skipping them was two defects in one line.
        //
        // A hint reached only through a wildcard rule was reported under "hints
        // nothing points at" — beside the very row saying a wildcard rule
        // points at it — with a sentence telling the operator no customer will
        // ever see it. Deleting it on that advice kills a live pop-up.
        //
        // And a wildcard rule naming a key nothing answers to was invisible:
        // the red "will not fire" badge never appeared for it, which is the one
        // failure this whole view exists to surface.
        for (const key of keys) {
          usedKeys.add(key)
        }
        continue
      }
      for (const key of keys) {
        usedKeys.add(key)
        const hint = hintByKey.get(key)
        const state = pathState(rule, hint)
        if (state === 'live') counts.live += 1
        else if (state === 'paused') counts.paused += 1
        else counts.broken += 1
        paths.push({
          ruleId: rule.id,
          ruleName: rule.name,
          hintKey: key,
          hintTitle: hint?.titleRu ?? null,
          state,
          // `null` and `{}` both mean "no filter". An empty object is what the
          // editor leaves behind when an operator clears the field, and calling
          // that "conditional" would put the marker on rules that have none.
          hasConditions:
            rule.conditions !== null &&
            typeof rule.conditions === 'object' &&
            Object.keys(rule.conditions as Record<string, unknown>).length > 0,
        })
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
    // paused path is working or one toggle from it; a broken one is not.
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

  const lanes = HINT_TEMPLATE_STAGES.map((stage) => ({
    stage,
    triggers: nodes.filter((node) => node.stage === stage),
  })).filter((lane) => lane.triggers.length > 0)

  return { lanes, orphanHints, counts }
}
