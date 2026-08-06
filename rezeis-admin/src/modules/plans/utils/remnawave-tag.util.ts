/**
 * The panel's own rule for `User.tag`, restated at the admin boundary.
 *
 * Remnawave declares the field identically on every version this project
 * targets (2.7.4 and 2.8.0) — `@remnawave/backend-contract`
 * `users/create-user.command` and `users/update-user.command` both carry
 * `z.string().regex(/^[A-Z0-9_]+$/).max(16).nullable()`.
 *
 * It is restated HERE, at the DTO, rather than only inside the sync path,
 * because the two write paths disagree about what happens to a tag the panel
 * will not accept and the disagreement is invisible to the operator:
 *
 *  - the strict path (`projectionSync` rollout flag on) refuses the whole
 *    desired-state PATCH with `invalidContract` — see `isUpstreamTag` in
 *    `remnawave-api.service.ts`, and `classifyRecovery` files that as TERMINAL,
 *    so the subscription's limits stop converging entirely;
 *  - the legacy path forwards the tag verbatim and the panel answers 400.
 *
 * Either way the operator finds out hours later, in a background job, on
 * somebody else's subscription. Rejecting at the form costs one error message.
 *
 * NOTE: this is deliberately NOT applied to tags already stored on a plan. A
 * plan cloned from a donor backup (`backup-plan-cloner.service.ts`, which
 * copies `tag` verbatim from the source catalog) can hold a value that violates
 * this rule, and a patch that does not mention `tag` must keep saving — see
 * `normalizeUpdatePlanInput`, which carries the persisted value through
 * untouched when the field is absent from the patch.
 */
export const REMNAWAVE_TAG_MAX_LENGTH = 16;

/** Panel rule: one or more of A–Z, 0–9, `_`. Lowercase is rejected upstream. */
export const REMNAWAVE_TAG_PATTERN = /^[A-Z0-9_]+$/;

export const REMNAWAVE_TAG_MESSAGE =
  'tag may only contain A-Z, 0-9 and _ (max 16 characters) — the Remnawave panel rejects anything else';
