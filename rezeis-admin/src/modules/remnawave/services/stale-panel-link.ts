// Adapter-free and Nest-free, and this module keeps it that way: it performs no
// I/O of its own, so it can be reasoned about (and tested) without a panel. The
// one fact it needs from the outside — which era the panel is — arrives as a
// value the caller has already observed, exactly as `panelUserAddress` receives
// `addressing` rather than fetching it. Its only import is the dependency-free
// version util, whose `observePanelEra` is the sanctioned way to take that
// reading; the refusals below are DATA (a code and a sentence), never an
// exception type, so the throwing stays at the call sites that know their own
// transport.
import { observePanelEra } from './panel-version.util';
import type { PanelEraObservation, RemnawaveUserAddressing } from './panel-version.util';

// Re-exported so a delete path has ONE import to reach for: the thing that
// takes the reading and the thing that judges it arrive together, and a caller
// never has to go looking for the producer in a different module and reach for
// `getPanelShape()` a second time instead.
export { observePanelEra };
export type { PanelEraObservation };

/**
 * WHEN A STORED PANEL IDENTITY CANNOT BE TRUSTED TO NAME THE RIGHT PROFILE, and
 * therefore when a panel-side deletion must be refused.
 *
 * ── THE HAZARD ───────────────────────────────────────────────────────────────
 *
 * Remnawave 3.x deleted the user `uuid` column outright and re-keyed every
 * user-scoped route on the numeric `id`. `Subscription.remnawaveId` stores
 * whichever spelling was current when the row was linked and is deliberately
 * never rewritten, so after an operator upgrades 2.x → 3.x every row linked in
 * the old era holds an identity the panel does not answer to.
 *
 * That identity does NOT fail closed. `panelUserAddress`'s `'id'` branch falls
 * back — numeric fast path → `remnawavePanelId` → the subscription short UUID
 * recovered from the stored `config_url` → `remnawavePanelUsername` — so a dead
 * 2.x uuid still resolves, through the saved subscription link, to the
 * customer's LIVE panel profile. That fallback is right for a read and right
 * for a write: it is what keeps an un-repaired row addressable. It is wrong for
 * exactly one verb. A DELETE built from a stale identity destroys whatever the
 * fallback found, and on the duplicate pairs the old importer produced, what it
 * finds is a paying customer's live profile.
 *
 * ── THE TEST, AND WHY IT IS SPELLED THIS WAY ─────────────────────────────────
 *
 * Two facts, both required:
 *
 *  1. The panel is PROVEN 3.x. Discovered from `getPanelShape().addressing`,
 *     never assumed — the same read `PanelLinkReconciliationService.detectPanelEra`
 *     performs, deriving `'2.x' | '3.x' | null` and treating a throw as `null`.
 *     This function fuses the derivation and the shape test so the two cannot
 *     drift into gating on different eras; the correspondence is one-to-one
 *     (`'uuid'` → 2.x, `'id'` → 3.x, anything else or a throw → unknown).
 *  2. The stored identity is uuid-shaped. `contains '-'` is the WHOLE test, and
 *     it is exact rather than approximate: a panel id is decimal and can never
 *     carry a hyphen, a uuid always does. It is deliberately the same spelling
 *     `selectBrokenLinks` uses for its stale population and the same claim
 *     `admin-user-subscriptions.controller.ts` states in its "which comparisons
 *     are sound" list — NOT the complementary `isNumericPanelIdentity`, which
 *     would also refuse a value that is neither form. Such a value is not in
 *     the reconciliation sweep's population, so refusing it would name a remedy
 *     that provably cannot repair it: a dead end instead of a next step.
 *
 * ── THE THIRD ANSWER IS THE ONE PEOPLE GET WRONG ─────────────────────────────
 *
 * An unreadable era is NOT read as 3.x, and NOT read as a reason to refuse.
 * Version detection fails for the same reasons requests fail — an unreachable
 * panel, an expired token, a panel mid-restart — so a refusal keyed on it would
 * fire exactly when the panel is already answering with terminal errors, and
 * would convert those into "cannot act". `panel-user-address.ts` states the
 * cost at the point where it is enforced (its `'unknown'` branch): the sync
 * layer classifies "cannot act" as TRANSIENT and retries forever with no alert.
 * So an unknown era preserves TODAY'S BEHAVIOUR exactly, and so does a 2.x
 * panel, where a uuid-shaped identity is CORRECT and this population is empty.
 * Installations still running 2.x panels must not notice this guard at all.
 */
export type StoredPanelLinkTrust =
  | {
      readonly trusted: true;
      /**
       * Why the stored identity may be used:
       *   • `identityIsCurrent` — 3.x panel, decimal identity. The ordinary case.
       *   • `panelIs2x`         — a uuid is what a 2.x panel issued. Unchanged.
       *   • `panelEraUnknown`   — the probe could not tell. Deliberately NOT a
       *                           refusal; see the note above.
       */
      readonly because: 'identityIsCurrent' | 'panelIs2x' | 'panelEraUnknown';
    }
  | { readonly trusted: false; readonly because: 'uuidIdentityOn3xPanel' };

/**
 * The machine-readable half of the refusal, so a UI can tell it from an
 * ordinary failure and route the operator to the repair instead of to a retry.
 *
 * SCREAMING_SNAKE, following `USER_DELETE_PROTECTED_HISTORY` — its nearest
 * neighbour in every way: also a deletion refusal, also a 409, also a pair of
 * exported constants beside the service that throws it. The lowercase entries
 * in `SAFE_PRODUCT_CODES` (`totp_required`, `passkey_reauth_required`) are
 * spelled that way because the label IS a wire value an existing client
 * compares against; this code has no such prior reader.
 *
 * It must ALSO be listed in `admin-safe-exception.filter.ts`'s
 * `SAFE_PRODUCT_CODES` or the filter strips it from the response body and the
 * SPA sees an untyped 409.
 */
export const SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE = 'SUBSCRIPTION_DELETE_STALE_PANEL_LINK';

/**
 * The human-readable half. THREE CONSTRAINTS ON THIS WORDING, all mechanical:
 *
 *  1. It names the REMEDY, not just the fault. "Something is wrong with this
 *     link" leaves an operator with nothing to do and, at a duplicate pair, a
 *     strong temptation to try the other half — which is the same deletion
 *     wearing a different id.
 *  2. It carries no interpolation and none of the words
 *     `admin-safe-exception.filter.ts` scrubs (`profile`, `token`, `password`,
 *     a bare uuid, a URL, …). A message that trips `SENSITIVE_HTTP_TEXT_PATTERNS`
 *     is replaced with "Request failed" on the way out — the refusal would
 *     still be correct and the operator would still learn nothing.
 *  3. It contains none of `timeout|temporar|econn|429|502|503|504|unavailable`.
 *     `classifyRecovery` reads the MESSAGE of a plain `Error` to decide
 *     TRANSIENT vs TERMINAL, and the worker-side refusal built from this text
 *     must classify TERMINAL so an operator is told rather than retried at.
 */
export const SUBSCRIPTION_DELETE_STALE_PANEL_LINK_MESSAGE =
  'This subscription still stores a 2.x Remnawave identifier while the panel now answers only ' +
  'to 3.x numeric ids, so its stored link can no longer be trusted to name the right customer ' +
  'account. Nothing was deleted. Run the panel link reconciliation on the Subscriptions page, ' +
  'then delete it again.';

/**
 * True when the stored identity carries the shape only a 2.x panel ever issued.
 *
 * Exported so the delete paths and their tests share ONE spelling; see the
 * type docstring above for why `contains '-'` is the whole of it.
 */
export function isUuidShapedPanelIdentity(remnawaveId: string): boolean {
  return remnawaveId.includes('-');
}

/**
 * Reads the panel era and answers the one question every delete path asks — for
 * the ONE caller that has no panel call of its own to align with.
 *
 * `SubscriptionDeletionService` refuses at job-CREATION time and never touches
 * the panel afterwards, so there is no address for its era to have to agree
 * with: the reading is used once and discarded. Every path that goes on to
 * ISSUE a panel call must use {@link observePanelEra} plus
 * {@link assessObservedPanelLink} instead, and hand the same observation to the
 * adapter — see that function for what the split buys.
 *
 * `readPanelShape` is a thunk rather than the adapter itself so this module
 * stays free of the adapter (and of Nest): the callers pass
 * `() => this.remnawaveApiService.getPanelShape()`, which is cached for five
 * minutes and shared with every other version-gated feature, so this costs a
 * read of an existing fact rather than a probe of its own.
 *
 * A THROW FROM THE THUNK IS THE UNKNOWN ERA, not an error to propagate. That
 * includes a caller wired without a working adapter: the guard's job is to stop
 * one specific deletion, never to become a second way for deletion to fail.
 */
export async function assessStoredPanelLink(
  readPanelShape: () => Promise<{ readonly addressing: RemnawaveUserAddressing }>,
  remnawaveId: string,
): Promise<StoredPanelLinkTrust> {
  return assessObservedPanelLink(await observePanelEra(readPanelShape), remnawaveId);
}

/**
 * The same question, asked of an era the caller ALREADY HOLDS.
 *
 * THIS IS THE ONE EVERY DELETE PATH USES, and the reason it is separate from
 * the thunk form above is that it is SYNCHRONOUS AND PURE: it cannot read the
 * panel, so the era it judges is provably the era it was handed. A path that
 * calls this and then passes the SAME `PanelEraObservation` into
 * `deletePanelUser` / `deletePanelUserDevice` / `deleteAllPanelUserDevices` —
 * all three of which take it as a REQUIRED argument and, given one, never read
 * the shape again — has made one observation and used it twice, not two reads
 * that usually agree.
 *
 * The defect this shape closes: `assessStoredPanelLink` and the address builder
 * each performed their own `getPanelShape()`, adjacent awaits apart. The
 * fifteen-second negative cache can expire between them, so the guard could
 * answer "era unknown, proceed" (safe, because on `'unknown'` the address
 * builder emits the stored string unchanged and a 3.x panel answers 400) while
 * the builder, a moment later, saw `'id'`, took the `'id'` branch, resolved the
 * dead uuid through `panelId` — or the short uuid, or the username — to a LIVE
 * profile, and deleted it.
 *
 * NOTE THAT THE FAIL-OPEN IS PRESERVED EXACTLY. An unreadable era is still
 * trusted, for the reason spelled out in the type docstring above; what changed
 * is only that the guard and the builder now share ONE observation of it
 * instead of taking two. Turning `'unknown'` into a refusal is a separate
 * product decision and is deliberately not made here.
 */
export function assessObservedPanelLink(
  era: PanelEraObservation,
  remnawaveId: string,
): StoredPanelLinkTrust {
  const { addressing } = era;
  // `'uuid'` FIRST and by name. Asking `!== 'id'` alone would collapse a proven
  // 2.x panel into the same bucket as an unreadable one — the same answer
  // today, and a silent change of meaning the first time a third era appears.
  if (addressing === 'uuid') return { trusted: true, because: 'panelIs2x' };
  if (addressing !== 'id') return { trusted: true, because: 'panelEraUnknown' };
  if (!isUuidShapedPanelIdentity(remnawaveId)) {
    return { trusted: true, because: 'identityIsCurrent' };
  }
  return { trusted: false, because: 'uuidIdentityOn3xPanel' };
}

// ═══════════════════════════════════════════════════════════════════════════
//  THE SAME HAZARD, THE OTHER VERB: HWID DEVICE DELETION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The refusal for a DEVICE deletion built from a stale stored identity.
 *
 * WHY THIS IS A SECOND CODE AND NOT A SECOND USE OF
 * {@link SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE}. The hazard is identical —
 * `deletePanelUserDevice` names its owner through the SAME `panelUserAddress`
 * fallback, so on an unrepaired pair an HWID revocation issued against the
 * stale row reaches the live customer's device list and frees a slot they are
 * using. The CONSEQUENCE a client has to describe is not identical, and a
 * client branches on the code:
 *
 *   • the subscription refusal means "your subscription is intact, nothing was
 *     deleted"; its follow-up is "delete it again after the repair".
 *   • this one means "the device is still bound and the slot is still taken";
 *     its follow-up is "revoke it again after the repair".
 *
 * Reusing the first code would put subscription-deletion copy on a device
 * dialog and offer the wrong retry. It MUST be listed in
 * `admin-safe-exception.filter.ts`'s `SAFE_PRODUCT_CODES` or the filter strips
 * it and both SPAs receive an untyped 409.
 */
export const SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE =
  'SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK';

/**
 * The operator's wording. Same three mechanical constraints as
 * {@link SUBSCRIPTION_DELETE_STALE_PANEL_LINK_MESSAGE}: it names the remedy, it
 * trips none of `admin-safe-exception.filter.ts`'s
 * `SENSITIVE_HTTP_TEXT_PATTERNS` (no `profile`, no `token`, no bare uuid, no
 * URL — a message that trips them is replaced with "Request failed" on the way
 * out), and it carries none of `timeout|temporar|econn|429|502|503|504|
 * unavailable`, so nothing reading it classifies this as a retryable blip.
 */
export const SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_MESSAGE =
  'This subscription still stores a 2.x Remnawave identifier while the panel now answers only ' +
  'to 3.x numeric ids, so its stored link can no longer be trusted to name the right customer ' +
  'account. No device was revoked. Run the panel link reconciliation on the Subscriptions page, ' +
  'then revoke the device again.';

/**
 * The subscriber's wording, and the reason there are two sentences under one
 * code.
 *
 * THE SUBSCRIBER CANNOT RUN THE REMEDY. "Run the panel link reconciliation on
 * the Subscriptions page" names a screen inside the operator panel; a customer
 * pressing "revoke device" in the cabinet has no such page, no such permission
 * and no way to act on the sentence — which is exactly the "a dead end instead
 * of a next step" failure the shape test above is spelled to avoid, arriving
 * from the other side. Their only real next step is to ask a human, so that is
 * what this says.
 *
 * IT IS THE FALLBACK THAT MAKES THIS LOAD-BEARING, not the happy path. A reiwa
 * build that knows the code renders its own copy; a build that does not prints
 * `data.message` verbatim, and THAT is the string a customer would otherwise
 * read. Same scrub and same classifier constraints as its operator sibling.
 */
export const SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE =
  'This device could not be revoked: the link between this subscription and the VPN panel must ' +
  'be repaired first, and revoking before that could remove a device from another customer’s ' +
  'account. Nothing was changed. Please contact support.';

/** Which surface is being answered — see the two messages above. */
export type StalePanelLinkAudience = 'operator' | 'subscriber';

/**
 * The refusal BODY, one spelling for all three device-deletion call sites.
 *
 * A plain record rather than an exception: this module stays Nest-free (see the
 * file header), so each call site throws its own `ConflictException` around
 * this. That also keeps the three guards individually removable, which is what
 * makes "is this site covered?" a question a test can answer per site rather
 * than one test standing in for three.
 *
 * 409, matching `USER_DELETE_PROTECTED_HISTORY` and the subscription-delete
 * refusal: all three are refusals on the STATE OF THE DATA, not on the request.
 */
export function staleDeviceDeleteRefusalBody(
  audience: StalePanelLinkAudience,
): { readonly code: string; readonly message: string } {
  return {
    code: SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE,
    message:
      audience === 'operator'
        ? SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_MESSAGE
        : SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  THE SAME HAZARD, THE THIRD VERB: SUBSCRIPTION LINK REGENERATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The refusal for a subscription-link REGENERATION built from a stale stored
 * identity — the same hazard as its two siblings, and the worst of the three by
 * consequence.
 *
 * `regeneratePanelUserSubscription` names its target through the SAME
 * `panelUserAddress` fallback — numeric fast path → `remnawavePanelId` → the
 * subscription short uuid recovered from `config_url` → `remnawavePanelUsername`
 * — so on an unrepaired duplicate pair the rotation reaches whatever account is
 * LIVE at that address and revokes ITS short uuid. Every client the real
 * customer has ever configured stops working at once, and there is no way back:
 * the panel discards the old short uuid, cannot re-issue it, and rezeis never
 * held it in a form that could be restored. The other two verbs cost a deletion
 * that can be re-provisioned or a device slot that can be re-bound; this one is
 * irreversible and lands on somebody who did nothing.
 *
 * WHY REFUSING IS THE RIGHT ANSWER, stated here because it is a product
 * decision and not a mechanical one. The whole of this work refuses LOUDLY with
 * a named remedy rather than silently doing the wrong thing. The cost of
 * refusing is one more click once the link is repaired. The cost of proceeding
 * is irreversible and is paid by a paying customer who did nothing. There is no
 * version of that trade in which proceeding wins.
 *
 * WHY A THIRD CODE AND NOT A REUSE OF EITHER SIBLING — the same test that split
 * the device code out of the subscription one: a client BRANCHES on the code
 * and the branches differ.
 *
 *   • the subscription refusal means "nothing was deleted"; retry "delete".
 *   • the device refusal means "the device is still bound"; retry "revoke".
 *   • this one means "your links were NOT rotated and every one of them still
 *     works"; retry "regenerate".
 *
 * The third is not a rewording of the first two. It is the OPPOSITE of what a
 * successful regeneration means, and that opposite is the fact the reader most
 * needs: somebody who pressed regenerate because they believe their link leaked
 * has to learn the leaked link is still live. A shared code would offer them
 * "delete it again" or "revoke it again" — neither of which is the action — and
 * would leave that fact unsaid.
 *
 * It MUST be listed in `admin-safe-exception.filter.ts`'s `SAFE_PRODUCT_CODES`
 * or the filter strips it and the cabinet receives an untyped 409.
 */
export const SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_CODE =
  'SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK';

/**
 * The operator's wording. Same three mechanical constraints as both siblings:
 * it names the REMEDY, it trips none of `admin-safe-exception.filter.ts`'s
 * `SENSITIVE_HTTP_TEXT_PATTERNS` (no `profile`, no `token`, no bare uuid, no
 * URL — a message that trips them is replaced with "Request failed" on the way
 * out), and it carries none of `timeout|temporar|econn|429|502|503|504|
 * unavailable`, so nothing reading it classifies this as a retryable blip.
 *
 * NO OPERATOR SURFACE RAISES IT TODAY: the only regeneration endpoint in the
 * codebase answers the cabinet. It is written and tested anyway, because
 * {@link staleRegenerateRefusalBody} takes the audience rather than assuming
 * one, and an audience with no sentence of its own is exactly how a sibling's
 * sentence gets borrowed the first time an operator-side regenerate lands.
 */
export const SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_MESSAGE =
  'This subscription still stores a 2.x Remnawave identifier while the panel now answers only ' +
  'to 3.x numeric ids, so its stored link can no longer be trusted to name the right customer ' +
  'account. The subscription link was NOT rotated and every client holding it still works. ' +
  'Run the panel link reconciliation on the Subscriptions page, then regenerate it again.';

/**
 * The subscriber's wording, and the one that is actually raised today.
 *
 * THE SUBSCRIBER CANNOT RUN THE REMEDY. "Run the panel link reconciliation on
 * the Subscriptions page" names a screen inside the operator panel; a customer
 * pressing "regenerate" in the cabinet has no such page, no such permission and
 * no way to act on the sentence — a dead end instead of a next step. Their only
 * real next step is to ask a human, so that is what this says.
 *
 * IT SAYS THE OLD LINK STILL WORKS, and that clause is the load-bearing one.
 * The button was pressed to make the previous link stop working; a refusal that
 * only reported failure would leave the reader believing it might have half
 * happened. It did not happen at all, and on this verb "nothing changed" is the
 * reassurance and the warning at the same time.
 *
 * IT IS THE FALLBACK THAT MAKES THIS LOAD-BEARING, not the happy path. A reiwa
 * build that knows the code renders its own copy; a build that does not prints
 * `data.message` verbatim, and THAT is the string a customer would otherwise
 * read. Same scrub and same classifier constraints as its operator sibling.
 */
export const SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE =
  'This subscription link could not be regenerated: the link between this subscription and the ' +
  'VPN panel must be repaired first, and regenerating before that would cut off another ' +
  'customer’s apps instead. Your current link still works and nothing was changed. Please ' +
  'contact support.';

/**
 * The refusal BODY for the regenerate verb.
 *
 * A plain record rather than an exception, for the reason the file header gives:
 * this module stays Nest-free, so the call site throws its own
 * `ConflictException` around this. 409, matching both siblings and
 * `USER_DELETE_PROTECTED_HISTORY`: all of them refuse on the STATE OF THE DATA,
 * not on the request.
 */
export function staleRegenerateRefusalBody(
  audience: StalePanelLinkAudience,
): { readonly code: string; readonly message: string } {
  return {
    code: SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_CODE,
    message:
      audience === 'operator'
        ? SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_MESSAGE
        : SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE,
  };
}
