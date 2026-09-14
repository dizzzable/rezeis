/**
 * WHAT THE DELETE DIALOG SAYS ABOUT A PLAN, AND WHY.
 *
 * Deleting a plan always succeeds for an operator holding `plans:delete`
 * (plan-deletion contract v2, 13.09.2026). What the server does is decided by
 * whether anything still uses the plan, and whether it is on sale: nothing, and
 * off sale → the row goes for good, with its durations and prices; something,
 * or a plan still on sale → the plan is hidden everywhere (panel, cabinet,
 * pickers, renewal), obligations already taken keep being honoured, and the
 * nightly sweeper removes the row once nothing uses it. An unused plan on sale
 * is hidden rather than removed because a buyer's checkout may be writing its
 * invoice at that very moment; the sweep removes it the next night.
 *
 * The dialog asks `GET /admin/plans/:planId/references` before the operator
 * confirms, and this module turns that answer into what is shown: one row per
 * kind, and the consequences that follow from the kinds present. Pure, and
 * with no imports, like `plan-write-refusals.ts` next door: the dialog passes
 * the keys to `t(...)`, this module never translates anything.
 *
 * ── AN UNKNOWN KIND IS SHOWN, NEVER DROPPED ─────────────────────────────────
 *
 * A rolling deploy WILL put a newer backend behind this panel, and a newer
 * backend may report a kind this build has no words for. Dropping that row
 * would turn "used by 4 loyalty tiers" into silence — and silence, in this
 * dialog, reads as "nothing uses it, it goes for good". The row renders with a
 * generic label, the raw kind and its count instead, and it counts as keeping
 * the plan alive, which is the conservative reading.
 *
 * ── `transitions` AND `replacementOrphans` DO NOT KEEP THE PLAN ─────────────
 *
 * The delete itself removes the plan from every other plan's upgrade and
 * replacement lists before it decides between the two outcomes, so a plan whose
 * only references are transitions is not held by them — gone for good when off
 * sale, hidden until the nightly sweep when on sale. The row is still listed —
 * the operator should know those lists are about to change — but the dialog
 * must not claim the plan lingers until "nothing uses it".
 *
 * `replacementOrphans` counts the archived REPLACE_ON_RENEW plans for which this
 * plan is the last replacement on sale. It holds nothing either; it is listed,
 * with its consequence, because their subscribers will have to choose a plan,
 * autopay stops charging them and their subscriptions end with the paid term.
 */

/**
 * The kinds this build can name, in the order the server reports them.
 * Spelled out rather than derived: the test pins this list against the
 * contract, and a list derived from the table below would agree with itself.
 */
export const PLAN_REFERENCE_KINDS = [
  'subscriptions',
  'scheduledTerms',
  'unsettledPayments',
  'recentCheckouts',
  'renewalItems',
  'trialReservations',
  'promocodes',
  'quests',
  'contests',
  'wheelSectors',
  'addOns',
  'adPlacements',
  'referralGift',
  'referralEligibility',
  'transitions',
  'replacementOrphans',
] as const

export type PlanReferenceKind = (typeof PLAN_REFERENCE_KINDS)[number]

/**
 * The consequence lines the dialog can add under the list, each stated only
 * when a kind it applies to is present. A line about invoices on a plan that is
 * used by one quest is noise the operator has to read past on a destructive
 * confirmation.
 *
 * `adBonuses` is a line of its own rather than part of `grants`. An ad
 * placement's signup bonus, unlike promo codes, quests, contests, the wheel and
 * the referral gift, stops granting a plan once it goes off sale — and the
 * server reports an ad placement only while its bonus still grants the plan
 * (on sale, or deleted while on sale). A shared sentence naming ad bonuses
 * promised a bonus that had stopped whenever any other grant held an archived
 * plan; this one is said exactly when a placement is reported.
 */
export type PlanDeleteConsequence = 'subscribers' | 'invoices' | 'grants' | 'adBonuses' | 'renewalChoice'

/** The fixed order the consequence lines are shown in. */
export const PLAN_DELETE_CONSEQUENCES: readonly PlanDeleteConsequence[] = [
  'subscribers',
  'invoices',
  'grants',
  'adBonuses',
  'renewalChoice',
]

interface PlanReferenceKindSpec {
  /**
   * The dictionary key of the row. Plural-aware where the kind is a count of
   * things; a plain sentence where the kind is a single setting.
   */
  readonly i18nKey: string
  readonly consequence: PlanDeleteConsequence | null
  /** Whether this reference keeps the plan row alive after the delete. */
  readonly keepsPlan: boolean
}

/**
 * One row per kind, keys written out rather than computed: a computed
 * `` `…references.${kind}` `` is one rename away from rendering the key path
 * itself, which i18next does without complaint for a missing key.
 */
export const PLAN_REFERENCE_KIND_SPECS: Readonly<Record<PlanReferenceKind, PlanReferenceKindSpec>> =
  Object.freeze({
    subscriptions: {
      i18nKey: 'plansPage.deleteDialog.references.subscriptions',
      consequence: 'subscribers',
      keepsPlan: true,
    },
    scheduledTerms: {
      i18nKey: 'plansPage.deleteDialog.references.scheduledTerms',
      consequence: 'subscribers',
      keepsPlan: true,
    },
    unsettledPayments: {
      i18nKey: 'plansPage.deleteDialog.references.unsettledPayments',
      consequence: 'invoices',
      keepsPlan: true,
    },
    recentCheckouts: {
      i18nKey: 'plansPage.deleteDialog.references.recentCheckouts',
      consequence: 'invoices',
      keepsPlan: true,
    },
    renewalItems: {
      i18nKey: 'plansPage.deleteDialog.references.renewalItems',
      consequence: 'invoices',
      keepsPlan: true,
    },
    trialReservations: {
      i18nKey: 'plansPage.deleteDialog.references.trialReservations',
      consequence: null,
      keepsPlan: true,
    },
    promocodes: {
      i18nKey: 'plansPage.deleteDialog.references.promocodes',
      consequence: 'grants',
      keepsPlan: true,
    },
    quests: {
      i18nKey: 'plansPage.deleteDialog.references.quests',
      consequence: 'grants',
      keepsPlan: true,
    },
    contests: {
      i18nKey: 'plansPage.deleteDialog.references.contests',
      consequence: 'grants',
      keepsPlan: true,
    },
    wheelSectors: {
      i18nKey: 'plansPage.deleteDialog.references.wheelSectors',
      consequence: 'grants',
      keepsPlan: true,
    },
    addOns: {
      i18nKey: 'plansPage.deleteDialog.references.addOns',
      consequence: null,
      keepsPlan: true,
    },
    adPlacements: {
      i18nKey: 'plansPage.deleteDialog.references.adPlacements',
      consequence: 'adBonuses',
      keepsPlan: true,
    },
    referralGift: {
      i18nKey: 'plansPage.deleteDialog.references.referralGift',
      consequence: 'grants',
      keepsPlan: true,
    },
    referralEligibility: {
      i18nKey: 'plansPage.deleteDialog.references.referralEligibility',
      consequence: null,
      keepsPlan: true,
    },
    transitions: {
      i18nKey: 'plansPage.deleteDialog.references.transitions',
      consequence: null,
      keepsPlan: false,
    },
    replacementOrphans: {
      i18nKey: 'plansPage.deleteDialog.references.replacementOrphans',
      consequence: 'renewalChoice',
      keepsPlan: false,
    },
  })

/** The row for a kind this build cannot name: `{{kind}}` and `{{count}}`. */
export const PLAN_REFERENCE_UNKNOWN_I18N_KEY = 'plansPage.deleteDialog.references.unknown'

export const PLAN_DELETE_CONSEQUENCE_I18N_KEYS: Readonly<Record<PlanDeleteConsequence, string>> =
  Object.freeze({
    subscribers: 'plansPage.deleteDialog.consequences.subscribers',
    invoices: 'plansPage.deleteDialog.consequences.invoices',
    grants: 'plansPage.deleteDialog.consequences.grants',
    adBonuses: 'plansPage.deleteDialog.consequences.adBonuses',
    renewalChoice: 'plansPage.deleteDialog.consequences.renewalChoice',
  })

/**
 * A `Map` rather than an index into the record, because the key is
 * server-controlled text: a record lookup answers `'toString'` with a function
 * off `Object.prototype`, and a kind that happens to name a prototype method
 * must render as unknown, not crash the dialog.
 */
const SPEC_BY_KIND: ReadonlyMap<string, readonly [PlanReferenceKind, PlanReferenceKindSpec]> =
  new Map(PLAN_REFERENCE_KINDS.map((kind) => [kind, [kind, PLAN_REFERENCE_KIND_SPECS[kind]]] as const))

export type PlanReferenceRow =
  | {
      readonly recognised: true
      readonly kind: PlanReferenceKind
      readonly count: number
      readonly i18nKey: string
    }
  | {
      readonly recognised: false
      readonly kind: string
      readonly count: number
      readonly i18nKey: string
    }

export interface PlanDeleteImpact {
  /** One row per reported kind, in the server's order. Never fewer than it sent. */
  readonly rows: readonly PlanReferenceRow[]
  /** The consequence lines that apply, in {@link PLAN_DELETE_CONSEQUENCES} order. */
  readonly consequences: readonly PlanDeleteConsequence[]
  /**
   * Whether something still USES the plan, so the delete leaves the row behind
   * (hidden) until it stops. Decides between "disappears, removed once nothing
   * uses it" and the unused leads — which still tell a plan on sale (hidden now,
   * removed by the nightly sweep) from one off sale (deleted for good).
   */
  readonly keepsPlan: boolean
}

export function describePlanReferences(
  references: ReadonlyArray<{ readonly kind: string; readonly count: number }>,
): PlanDeleteImpact {
  const present = new Set<PlanDeleteConsequence>()
  let keepsPlan = false
  const rows = references.map((reference): PlanReferenceRow => {
    const known = SPEC_BY_KIND.get(reference.kind)
    if (known === undefined) {
      keepsPlan = true
      return {
        recognised: false,
        kind: reference.kind,
        count: reference.count,
        i18nKey: PLAN_REFERENCE_UNKNOWN_I18N_KEY,
      }
    }
    const [kind, spec] = known
    if (spec.consequence !== null) present.add(spec.consequence)
    if (spec.keepsPlan) keepsPlan = true
    return { recognised: true, kind, count: reference.count, i18nKey: spec.i18nKey }
  })
  return {
    rows,
    consequences: PLAN_DELETE_CONSEQUENCES.filter((consequence) => present.has(consequence)),
    keepsPlan,
  }
}

/**
 * Whether a failed delete means the plan is already gone. The contract answers
 * 404 for an unknown or already-deleted plan — another tab, another operator —
 * which is the outcome the operator asked for, and is reported as such rather
 * than as a failure. Duck-typed, so this module keeps its promise of no imports.
 */
export function isPlanAlreadyGone(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const response = (error as { response?: unknown }).response
  if (typeof response !== 'object' || response === null) return false
  return (response as { status?: unknown }).status === 404
}
