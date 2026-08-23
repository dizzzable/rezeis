/**
 * HOW A SYNC REFUSAL IS CLASSIFIED — the two tables, and nothing else.
 *
 * `POST /admin/users/subscriptions/:id/sync` answers HTTP 200 for its three
 * refusals as well as for its successes, because none of them is a failure:
 * nothing is linked, the panel merely blinked, or the profile is genuinely
 * gone. The operator's next action differs for each — link a profile / press it
 * again / repair the link — and telling an outage apart from a broken link is
 * the whole reason the backend keeps the three separate.
 *
 * A MODULE OF ITS OWN, for two reasons that both matter:
 *
 *   1. `subscription-sync-outcome.test.tsx` imports `SYNC_REFUSAL_BY_CODE` and
 *      compares it against the backend's own `SUBSCRIPTION_SYNC_REFUSAL_CODES`,
 *      so a code added or renamed on the server fails a test by name instead of
 *      quietly losing the operator their guidance. Exporting it from
 *      `user-detail-panel.tsx` worked, and cost that file the only
 *      `react-refresh/only-export-components` warning in `web/src` — an export
 *      somebody would eventually tidy away, taking the drift guard with it.
 *   2. The two tables are one decision in two halves and read better side by
 *      side than buried in a four-thousand-line component.
 */

/** The three refusals this build knows how to give specific guidance for. */
export type SyncRefusalKind = 'notLinked' | 'panelUnavailable' | 'profileMissing'

/**
 * THE FALLBACK HALF: the exact sentences the controller returns, mapped to the
 * outcome each one means.
 *
 * A `Map` rather than an object literal because the key is server-controlled
 * text: a plain-object lookup answers `'toString'` with a function off
 * `Object.prototype`, and "the panel refused with a message that happens to
 * name a prototype method" is not a branch worth having.
 *
 * KEPT, and deliberately not deleted now that a `code` arrives beside the
 * sentence: during a rolling deploy this panel runs against a backend build
 * that predates the code and sends the sentence alone. Without these rows that
 * window degrades all three refusals to `refused` — exactly the defect the code
 * was added to end — and the two halves can be shipped in either order because
 * of them.
 *
 * This table is therefore a HISTORICAL RECORD of what older builds say, not a
 * mirror of the current backend copy. Do not "re-sync" it when somebody rewords
 * a message: the reworded build is by definition one that also sends a code, and
 * overwriting these rows would drop the fallback for the build actually running
 * on the other side of the deploy. Add, never replace.
 *
 * Matched EXACTLY. A sentence that is neither a known code nor one of these
 * falls through to `refused`, which still shows the operator the server's own
 * sentence in a visibly non-success notice — less specific guidance, never a
 * false green.
 */
export const SYNC_REFUSAL_BY_MESSAGE = new Map<string, SyncRefusalKind>([
  ['No Remnawave profile linked', 'notLinked'],
  ['Remnawave panel could not be reached — try again', 'panelUnavailable'],
  ['Profile not found on panel', 'profileMissing'],
])

/**
 * THE PREFERRED HALF: the stable codes the controller sends BESIDE the
 * sentence, mapped to the outcome each one means.
 *
 * The sentences above are what this card matched on originally, and matching
 * them was one copy-edit away from silently collapsing all three refusals into
 * the generic `refused` branch — a typo fix, a house-style pass, an em dash
 * replaced by a hyphen. The operator would still see a non-success notice, so
 * nothing would look broken; they would just quietly stop being told which of
 * the three had happened, which is the only part that tells them what to do
 * next. A code the wording cannot move is the fix.
 *
 * Hand-written literals, NOT imported from the backend: nothing the production
 * frontend project compiles may reach into `src/` (`build-isolation.test.ts`
 * pins that, and the Dockerfile stage that copies `web/` alone is why). The
 * link is enforced from the TEST side instead —
 * `subscription-sync-outcome.test.tsx` imports the backend's own
 * `SUBSCRIPTION_SYNC_REFUSAL_CODES` and fails by name if a code is added or
 * renamed there without a row appearing here.
 *
 * A `Map` for exactly the reason its neighbour is one: the key is
 * server-controlled text.
 */
export const SYNC_REFUSAL_BY_CODE = new Map<string, SyncRefusalKind>([
  ['sync_no_profile_linked', 'notLinked'],
  ['sync_panel_unavailable', 'panelUnavailable'],
  ['sync_profile_missing', 'profileMissing'],
])
