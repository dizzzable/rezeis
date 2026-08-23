/**
 * HOW A SUBSCRIPTION DELETE REFUSAL IS RECOGNISED — the code, and nothing else.
 *
 * `DELETE /admin/users/subscriptions/:subscriptionId` answers HTTP 409 with
 * `code: 'SUBSCRIPTION_DELETE_STALE_PANEL_LINK'` when the row's stored panel
 * identity is a 2.x uuid on a panel that has been PROVEN to be 3.x. That is not
 * "something went wrong": the request is well formed and will succeed unchanged
 * once the link is repaired, and the refusal exists to stop a deletion that
 * would remove whatever the address fallback resolves to — which, on an
 * unrepaired duplicate pair, is a paying customer's live profile.
 *
 * Until this module existed the SPA rendered that 409 as a generic conflict —
 * in fact `deleteSubMutation` had no `onError` at all — so the operator saw a
 * failure with no route to the fix, and the one thing the backend went to the
 * trouble of saying (run the panel link reconciliation, then delete again)
 * never reached them.
 *
 * ── BRANCH ON THE CODE, NEVER ON THE SENTENCE ────────────────────────────────
 *
 * The refusal carries a hand-written English paragraph beside the code. It is a
 * diagnostic line, not operator copy, and matching it byte for byte is the
 * fragility this repository has already paid for once next door: the three sync
 * refusals were told apart by their English prose until a single copy-edit
 * would have collapsed all three into the generic branch — with a non-success
 * notice still on screen, so nothing looking broken, and the specific guidance
 * simply gone. `subscription-sync-refusals.ts` is the fix and this is the same
 * fix. There is deliberately NO message table here: unlike the sync refusals,
 * this code and its message were added to the backend in the same commit, so
 * there is no older build that sends the sentence alone and a message fallback
 * would be a fragility with no rolling-deploy window to justify it.
 *
 * ── A MODULE WITH NO IMPORTS, ON PURPOSE ─────────────────────────────────────
 *
 * The literal below is hand-written rather than imported from
 * `src/modules/remnawave/services/stale-panel-link.ts`, because nothing the
 * PRODUCTION frontend project compiles may reach into the backend tree: the
 * Docker frontend stage is `COPY web/ .` and nothing else, and
 * `build-isolation.test.ts` pins that arrangement after exactly this mistake
 * cost a failed image build on a release tag.
 *
 * The cross-boundary link is enforced from the TEST side instead —
 * `subscription-delete-stale-link.test.tsx` imports the backend's own
 * `SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE` and fails by name if it is
 * renamed there without this literal following. Tests are excluded from
 * `tsconfig.app.json`, so that import never reaches the image.
 */

/** The one refusal this build knows how to give specific guidance for. */
export type SubscriptionDeleteRefusal = 'stalePanelLink'

/**
 * Mirrors `SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE`. Allowlisted in
 * `SAFE_PRODUCT_CODES`, so the safe exception filter lets it through as both
 * `code` and `errorCode` instead of stripping it to an untyped 409.
 */
export const SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE = 'SUBSCRIPTION_DELETE_STALE_PANEL_LINK'

const REFUSAL_BY_CODE = new Map<string, SubscriptionDeleteRefusal>([
  [SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE, 'stalePanelLink'],
])

/**
 * The product code off an axios-shaped rejection, or `null`.
 *
 * BOTH SPELLINGS, `code` FIRST. `AdminSafeExceptionFilter` writes the product
 * code into `errorCode` unconditionally and adds `code` only when the thrown
 * body carried one, so `errorCode` is the field that is always present — but it
 * also carries the generic status mapping (`CONFLICT`, `BAD_REQUEST`) when
 * there was no product code at all. Reading `code` first therefore takes the
 * unambiguous field when it exists and falls back to the one that always does,
 * and an unrecognised value in either simply does not match the table below.
 *
 * Duck-typed rather than reached through axios, so this module keeps its
 * promise of having no imports.
 */
function readProductCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const body = (error as { response?: { data?: unknown } }).response?.data
  if (typeof body !== 'object' || body === null) return null
  const record = body as { code?: unknown; errorCode?: unknown }
  if (typeof record.code === 'string' && record.code.length > 0) return record.code
  if (typeof record.errorCode === 'string' && record.errorCode.length > 0) return record.errorCode
  return null
}

/**
 * Which refusal a failed delete is, or `null` for anything this build does not
 * recognise — a permission failure, a dead host, a 500, or a product code added
 * server-side later.
 *
 * `null` KEEPS THE GENERIC PATH. A refusal this module cannot name must not be
 * dressed up as the one it can: the guidance attached to `stalePanelLink` names
 * a specific remedy, and printing it for an unrelated failure would send an
 * operator to run a bulk repair that has nothing to do with what stopped them.
 */
export function readSubscriptionDeleteRefusal(error: unknown): SubscriptionDeleteRefusal | null {
  const code = readProductCode(error)
  if (code === null) return null
  return REFUSAL_BY_CODE.get(code) ?? null
}
