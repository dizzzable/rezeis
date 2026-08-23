/**
 * THE MACHINE-READABLE HALF OF EVERY OPERATOR-FACING PLAN REFUSAL.
 *
 * `plans-admin.validators.ts` refuses a plan write for seventeen distinct
 * reasons, and every one of them used to leave the server as nothing but an
 * English sentence on an untyped 400. `AdminSafeExceptionFilter` forwards a
 * product `code` only when it is listed in `SAFE_PRODUCT_CODES` and strips
 * everything else, so a refusal without a code arrives at the panel SPA
 * indistinguishable from every other 400 the API can answer with. The SPA has
 * exactly one thing it can do with that: print `response.data.message` — which
 * is how an operator running a Russian UI was told, verbatim,
 *
 *     Replacement and upgrade plans must be active non-trial public plans:
 *     cmsxo98e8006r01jgn33gtpbe
 *
 * The wording is NOT this module's problem and must not become it. The server
 * does not know which language the operator reads, so it keeps writing English
 * diagnostics and adds a code beside them; the SPA owns the translation and
 * branches on the code. The sentence stays on the wire as the fallback for two
 * readers that have no branch: an older SPA during a rolling deploy, and any
 * future code this build does not recognise.
 *
 * ── WHY THE CODES LIVE IN THEIR OWN MODULE ───────────────────────────────────
 *
 * So the throw site and the allowlist check share ONE spelling. A code that is
 * restated as a string literal in the spec proves only that the spec and the
 * spec agree; `plan-write-refusal-codes.spec.ts` asserts containment in
 * `SAFE_PRODUCT_CODES` over the VALUES of this object, so a code added here and
 * forgotten in the filter fails a named test instead of shipping stripped.
 *
 * The module deliberately imports nothing. It is a table of literals, reachable
 * from a validator, a filter spec, and (by copy, never by import — the frontend
 * image contains no backend tree) the SPA.
 *
 * ── NAMING ───────────────────────────────────────────────────────────────────
 *
 * SCREAMING_SNAKE with a `PLAN_` prefix, following `USER_DELETE_PROTECTED_HISTORY`
 * and `SUBSCRIPTION_DELETE_STALE_PANEL_LINK`. The lowercase entries in
 * `SAFE_PRODUCT_CODES` (`totp_required`, `passkey_reauth_required`) are spelled
 * that way because the label IS a wire value an existing client already compares
 * against; none of these has a prior reader, so they follow the majority.
 *
 * `DELETE_REFERENCED` is here despite the module's name because the refusal it
 * codes is thrown by the same validator class, reaches the same operator through
 * the same toast, and is a write to the plan catalogue in every sense but the
 * HTTP verb. Splitting it into a second module would have bought a tidier file
 * name and a second allowlist to keep in sync.
 */
export const PLAN_WRITE_REFUSAL_CODES = Object.freeze({
  /** Another plan already holds this name. */
  NAME_TAKEN: 'PLAN_NAME_TAKEN',
  /** Two duration rows claim the same number of days. */
  DURATION_DUPLICATE: 'PLAN_DURATION_DUPLICATE',
  /** One duration prices the same currency twice. */
  CURRENCY_DUPLICATE: 'PLAN_CURRENCY_DUPLICATE',
  /** The plan names itself as an upgrade or replacement target. */
  TRANSITION_SELF_REFERENCE: 'PLAN_TRANSITION_SELF_REFERENCE',
  /** Archived + REPLACE_ON_RENEW, with nothing to replace it with. */
  TRANSITION_REPLACEMENT_REQUIRED: 'PLAN_TRANSITION_REPLACEMENT_REQUIRED',
  /** A live plan carrying an archived-only renew mode. */
  TRANSITION_RENEW_MODE_NOT_ARCHIVED: 'PLAN_TRANSITION_RENEW_MODE_NOT_ARCHIVED',
  /** A referenced upgrade/replacement plan id matches no row. */
  TRANSITION_TARGET_NOT_FOUND: 'PLAN_TRANSITION_TARGET_NOT_FOUND',
  /** The target exists but is inactive, archived, or a trial. */
  TRANSITION_TARGET_NOT_ASSIGNABLE: 'PLAN_TRANSITION_TARGET_NOT_ASSIGNABLE',
  /** An existing non-trial plan cannot be turned into the trial plan. */
  TRIAL_CONVERSION_FORBIDDEN: 'PLAN_TRIAL_CONVERSION_FORBIDDEN',
  /** A second live trial plan; only one may exist at a time. */
  TRIAL_ALREADY_EXISTS: 'PLAN_TRIAL_ALREADY_EXISTS',
  /** A trial plan must define exactly one duration. */
  TRIAL_DURATION_COUNT: 'PLAN_TRIAL_DURATION_COUNT',
  /** A paid trial with no non-zero price is not billable. */
  TRIAL_PRICE_REQUIRED: 'PLAN_TRIAL_PRICE_REQUIRED',
  /** An allowlisted user id matches no account. */
  ALLOWED_USERS_NOT_FOUND: 'PLAN_ALLOWED_USERS_NOT_FOUND',
  /** The Remnawave panel serves no internal squad by that uuid. */
  INTERNAL_SQUADS_NOT_FOUND: 'PLAN_INTERNAL_SQUADS_NOT_FOUND',
  /** The Remnawave panel serves no external squad by that uuid. */
  EXTERNAL_SQUAD_NOT_FOUND: 'PLAN_EXTERNAL_SQUAD_NOT_FOUND',
  /**
   * The only 503 in the table: the squads CHANGED and the panel could not be
   * asked whether they exist. Not "invalid" — "unverifiable". The SPA must not
   * offer the same corrections it offers for the two NOT_FOUND codes above,
   * because nothing the operator typed is known to be wrong.
   */
  SQUAD_VALIDATION_UNAVAILABLE: 'PLAN_SQUAD_VALIDATION_UNAVAILABLE',
  /** Deletion refused: subscriptions or transition rules still point here. */
  DELETE_REFERENCED: 'PLAN_DELETE_REFERENCED',
} as const);

/** Every value of {@link PLAN_WRITE_REFUSAL_CODES}, as a union of literals. */
export type PlanWriteRefusalCode =
  (typeof PLAN_WRITE_REFUSAL_CODES)[keyof typeof PLAN_WRITE_REFUSAL_CODES];
