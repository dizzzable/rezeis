/**
 * HOW A REFUSED PLAN WRITE IS RECOGNISED — the code, and nothing else.
 *
 * `POST /admin/plans` and `PATCH /admin/plans/:id` refuse for seventeen
 * distinct reasons, each an English diagnostic sentence on a 400 (one 503).
 * The panel had no branch for any of them, so the operator was shown the
 * server's own prose verbatim — including, to somebody running the panel in
 * Russian:
 *
 *     Replacement and upgrade plans must be active non-trial public plans:
 *     cmsxo98e8006r01jgn33gtpbe
 *
 * — a sentence in the wrong language naming an id that appears nowhere on the
 * screen. The backend now sends a stable `code` beside that sentence
 * (`src/modules/plans/plan-write-refusal-codes.ts`); this module is the panel
 * half, turning the code into a kind the form can translate and act on.
 *
 * ── BRANCH ON THE CODE, NEVER ON THE SENTENCE ────────────────────────────────
 *
 * The prose is a diagnostic line, not operator copy, and matching it byte for
 * byte is a fragility this repository has already paid for: the three sync
 * refusals next door were told apart by their English until one copy-edit would
 * have collapsed all three into the generic branch — with a non-success notice
 * still on screen, so nothing looking broken, and the specific guidance simply
 * gone. There is deliberately NO message table here: these codes and their
 * messages were added to the backend in the same commit, so no older build
 * sends the sentence alone and a message fallback would be a fragility with no
 * rolling-deploy window to justify it.
 *
 * ── AN UNKNOWN CODE IS UNRECOGNISED, NOT GENERIC ─────────────────────────────
 *
 * {@link resolvePlanWriteRefusal} answers `recognised: false` and hands back
 * the server's own `message` for anything this build cannot name. A rolling
 * deploy WILL put a newer backend behind an older panel, and swallowing its new
 * code into "could not save the plan" would take away the one sentence that
 * says which of seventeen things went wrong. English the operator has to
 * puzzle over beats a generic sentence that tells them nothing.
 *
 * ── A MODULE WITH NO IMPORTS, ON PURPOSE ─────────────────────────────────────
 *
 * The literals below are hand-written rather than imported from
 * `src/modules/plans/plan-write-refusal-codes.ts`, because nothing the
 * PRODUCTION frontend project compiles may reach into the backend tree: the
 * Docker frontend stage is `COPY web/ .` and nothing else, and
 * `build-isolation.test.ts` pins that arrangement after exactly this mistake
 * cost a failed image build on a release tag.
 *
 * The cross-boundary link is enforced from the TEST side instead —
 * `plan-write-refusals.test.ts` imports the backend's own
 * `PLAN_WRITE_REFUSAL_CODES` and fails by name if a code is added or renamed
 * there without a row appearing here. Tests are excluded from
 * `tsconfig.app.json`, so that import never reaches the image.
 */

/** The refusals this build knows how to name and translate. */
export type PlanWriteRefusal =
  | 'nameTaken'
  | 'durationDuplicate'
  | 'currencyDuplicate'
  | 'transitionSelfReference'
  | 'transitionReplacementRequired'
  | 'transitionRenewModeNotArchived'
  | 'transitionTargetNotFound'
  | 'transitionTargetNotAssignable'
  | 'trialConversionForbidden'
  | 'trialAlreadyExists'
  | 'trialDurationCount'
  | 'trialPriceRequired'
  | 'allowedUsersNotFound'
  | 'internalSquadsNotFound'
  | 'externalSquadNotFound'
  | 'squadValidationUnavailable'
  | 'deleteReferenced'

/**
 * Mirrors `PLAN_WRITE_REFUSAL_CODES`. Allowlisted in `SAFE_PRODUCT_CODES`, so
 * the safe exception filter forwards each one as both `code` and `errorCode`
 * instead of stripping it to an untyped 400.
 *
 * A `Map` rather than an object literal because the key is server-controlled
 * text: a plain-object lookup answers `'toString'` with a function off
 * `Object.prototype`, and "the API refused with a code that happens to name a
 * prototype method" is not a branch worth having.
 */
export const PLAN_WRITE_REFUSAL_BY_CODE: ReadonlyMap<string, PlanWriteRefusal> = new Map<
  string,
  PlanWriteRefusal
>([
  ['PLAN_NAME_TAKEN', 'nameTaken'],
  ['PLAN_DURATION_DUPLICATE', 'durationDuplicate'],
  ['PLAN_CURRENCY_DUPLICATE', 'currencyDuplicate'],
  ['PLAN_TRANSITION_SELF_REFERENCE', 'transitionSelfReference'],
  ['PLAN_TRANSITION_REPLACEMENT_REQUIRED', 'transitionReplacementRequired'],
  ['PLAN_TRANSITION_RENEW_MODE_NOT_ARCHIVED', 'transitionRenewModeNotArchived'],
  ['PLAN_TRANSITION_TARGET_NOT_FOUND', 'transitionTargetNotFound'],
  ['PLAN_TRANSITION_TARGET_NOT_ASSIGNABLE', 'transitionTargetNotAssignable'],
  ['PLAN_TRIAL_CONVERSION_FORBIDDEN', 'trialConversionForbidden'],
  ['PLAN_TRIAL_ALREADY_EXISTS', 'trialAlreadyExists'],
  ['PLAN_TRIAL_DURATION_COUNT', 'trialDurationCount'],
  ['PLAN_TRIAL_PRICE_REQUIRED', 'trialPriceRequired'],
  ['PLAN_ALLOWED_USERS_NOT_FOUND', 'allowedUsersNotFound'],
  ['PLAN_INTERNAL_SQUADS_NOT_FOUND', 'internalSquadsNotFound'],
  ['PLAN_EXTERNAL_SQUAD_NOT_FOUND', 'externalSquadNotFound'],
  ['PLAN_SQUAD_VALIDATION_UNAVAILABLE', 'squadValidationUnavailable'],
  ['PLAN_DELETE_REFERENCED', 'deleteReferenced'],
])

/**
 * THE KEYS RESERVED IN THE DICTIONARIES, one per refusal.
 *
 * Named here and NOT added to `en.ts` / `ru.ts` — those files belong to another
 * worker. Plain strings rather than an i18n call so this module stays pure and
 * unit-testable: the caller passes the key to `t(...)`, this module never
 * translates anything.
 *
 * The key is derived from the refusal by prefix, but written out row by row on
 * purpose. A computed `` `planWriteRefusal.${refusal}` `` would make every key
 * a rename away from silently resolving to nothing, and `i18next` renders a
 * missing key as the key itself — an operator would read
 * "planWriteRefusal.trialPriceRequired" and no test would notice.
 */
export const PLAN_WRITE_REFUSAL_I18N_KEYS: Readonly<Record<PlanWriteRefusal, string>> =
  Object.freeze({
    nameTaken: 'planWriteRefusal.nameTaken',
    durationDuplicate: 'planWriteRefusal.durationDuplicate',
    currencyDuplicate: 'planWriteRefusal.currencyDuplicate',
    transitionSelfReference: 'planWriteRefusal.transitionSelfReference',
    transitionReplacementRequired: 'planWriteRefusal.transitionReplacementRequired',
    transitionRenewModeNotArchived: 'planWriteRefusal.transitionRenewModeNotArchived',
    transitionTargetNotFound: 'planWriteRefusal.transitionTargetNotFound',
    transitionTargetNotAssignable: 'planWriteRefusal.transitionTargetNotAssignable',
    trialConversionForbidden: 'planWriteRefusal.trialConversionForbidden',
    trialAlreadyExists: 'planWriteRefusal.trialAlreadyExists',
    trialDurationCount: 'planWriteRefusal.trialDurationCount',
    trialPriceRequired: 'planWriteRefusal.trialPriceRequired',
    allowedUsersNotFound: 'planWriteRefusal.allowedUsersNotFound',
    internalSquadsNotFound: 'planWriteRefusal.internalSquadsNotFound',
    externalSquadNotFound: 'planWriteRefusal.externalSquadNotFound',
    squadValidationUnavailable: 'planWriteRefusal.squadValidationUnavailable',
    deleteReferenced: 'planWriteRefusal.deleteReferenced',
  })

/**
 * The product code off an axios-shaped rejection, or `null`.
 *
 * BOTH SPELLINGS, `code` FIRST. `AdminSafeExceptionFilter` writes the product
 * code into `errorCode` unconditionally and adds `code` only when the thrown
 * body carried one, so `errorCode` is the field that is always present — but it
 * also carries the generic status mapping (`BAD_REQUEST`, `SERVICE_UNAVAILABLE`)
 * when there was no product code at all. Reading `code` first therefore takes
 * the unambiguous field when it exists and falls back to the one that always
 * does, and an unrecognised value in either simply does not match the table
 * above.
 *
 * Duck-typed rather than reached through axios, so this module keeps its
 * promise of having no imports. Exported because it is the half of this module
 * most likely to be got wrong in a rewrite, and a unit test that has to go
 * through a whole rejection to reach it is a unit test that stops being about
 * the fallback.
 */
export function readProductCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const body = (error as { response?: { data?: unknown } }).response?.data
  if (typeof body !== 'object' || body === null) return null
  const record = body as { code?: unknown; errorCode?: unknown }
  if (typeof record.code === 'string' && record.code.length > 0) return record.code
  if (typeof record.errorCode === 'string' && record.errorCode.length > 0) return record.errorCode
  return null
}

/**
 * The server's own sentence off an axios-shaped rejection, or `null`.
 *
 * `message` is `string | string[]` on the wire — the filter passes a
 * class-validator array through as an array — so both are read and an array is
 * joined rather than rendered as "[object Object]" or silently dropped.
 *
 * This is the fallback an UNRECOGNISED code falls through to. It is English and
 * it names raw ids, which is exactly why it is a fallback and not the primary
 * path; it is still strictly more than a generic failure sentence conveys.
 */
export function readServerMessage(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const body = (error as { response?: { data?: unknown } }).response?.data
  if (typeof body !== 'object' || body === null) return null
  const { message } = body as { message?: unknown }
  if (typeof message === 'string') return message.length > 0 ? message : null
  if (Array.isArray(message)) {
    const joined = message.filter((part): part is string => typeof part === 'string').join(' ')
    return joined.length > 0 ? joined : null
  }
  return null
}

/**
 * Which refusal a failed plan write is, or `null` for anything this build does
 * not recognise — a permission failure, a dead host, a 500, or a product code
 * added server-side later.
 *
 * `null` KEEPS THE FALLBACK PATH. A refusal this module cannot name must not be
 * dressed up as one it can: each kind carries its own remedy, and printing the
 * wrong one sends an operator to correct a field that was never the problem.
 */
export function readPlanWriteRefusal(error: unknown): PlanWriteRefusal | null {
  const code = readProductCode(error)
  if (code === null) return null
  return PLAN_WRITE_REFUSAL_BY_CODE.get(code) ?? null
}

/**
 * What the form should say, in one value.
 *
 * Recognised → the refusal and the dictionary key to render. Unrecognised →
 * the server's own sentence, or `null` when there is not even one of those
 * (a network failure with no response body), which is the only case where the
 * caller may fall back to its generic copy.
 *
 * A discriminated union rather than two calls, because "recognised" and "print
 * the server's sentence instead" is ONE decision, and splitting it across two
 * call sites is how the unrecognised branch gets forgotten.
 *
 * `serverMessage` is carried on the recognised branch too: it names the
 * offending plan id or currency, which is worth logging even when the operator
 * reads translated copy.
 */
export type PlanWriteRefusalResolution =
  | {
      readonly recognised: true
      readonly refusal: PlanWriteRefusal
      readonly i18nKey: string
      readonly serverMessage: string | null
    }
  | {
      readonly recognised: false
      readonly refusal: null
      readonly i18nKey: null
      readonly serverMessage: string | null
    }

export function resolvePlanWriteRefusal(error: unknown): PlanWriteRefusalResolution {
  const serverMessage = readServerMessage(error)
  const refusal = readPlanWriteRefusal(error)
  if (refusal === null) {
    return { recognised: false, refusal: null, i18nKey: null, serverMessage }
  }
  return {
    recognised: true,
    refusal,
    i18nKey: PLAN_WRITE_REFUSAL_I18N_KEYS[refusal],
    serverMessage,
  }
}
