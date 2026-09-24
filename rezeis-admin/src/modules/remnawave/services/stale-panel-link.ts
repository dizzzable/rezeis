// NO IMPORTS, and this file must keep it that way. The admin SPA's
// `web/src/features/users/subscription-delete-stale-link.test.tsx` imports it
// across the package boundary, and CI «Web quality» installs `web/` alone: an
// import that reaches a server package — even a type out of `@prisma/client`
// through a sibling module — fails that job and no other. The refusals below
// are DATA (a code and a sentence), never an exception type, so each call site
// throws in its own transport.

/**
 * WHEN A STORED PANEL IDENTITY NAMES NOBODY ON A SUPPORTED PANEL — the safety
 * net under every destructive panel call.
 *
 * ── THE HAZARD ───────────────────────────────────────────────────────────────
 *
 * Remnawave 3.x deleted the user `uuid` column and keys every user-scoped route
 * on a decimal `id`, and this build talks to 3.x only: a 2.x panel is refused
 * outright (`LegacyPanelRefusal`, and the adapter's own gate in
 * `RemnawaveApiService`). `Subscription.remnawaveId` keeps whatever was stored
 * when the row was linked, so a row linked on a 2.x panel — or imported from the
 * dump of a bot that ran on one — still holds a uuid.
 *
 * That identity does NOT fail closed. `panelUserAddress` falls back — stored
 * decimal → `remnawavePanelId` → the subscription short uuid recovered from the
 * stored `config_url` → `remnawavePanelUsername` — which is right for a read and
 * for a write: it keeps such a row syncing. It is wrong for a verb that
 * destroys. On the duplicate pairs an old import produced, the fallback lands on
 * a paying customer's LIVE profile, and a delete, a device revocation or a link
 * rotation issued from the stale row lands there too.
 *
 * ── THE TEST, AND WHY IT READS NO PANEL VERSION ──────────────────────────────
 *
 * {@link isStalePanelIdentity}: the stored identity is not a decimal. A 3.x panel
 * issues nothing else, so a uuid, an empty string and any imported junk all name
 * nobody on a supported panel, and a decimal names the one profile it was
 * issued for.
 *
 * It deliberately asks nothing of the panel. A decimal proceeds under every
 * reading of the version and a non-decimal is refused under every reading, so an
 * unreadable version can neither loosen the net nor trip it — and no reader of
 * the version is left on a destructive path for two readings to disagree
 * about. That disagreement ("the guard saw unknown, the address builder saw 3.x")
 * is exactly how a dead uuid used to be resolved to somebody else's profile.
 *
 * ONE SPELLING FOR CODE AND FOR SQL: {@link DECIMAL_PANEL_ID_PATTERN}. The
 * per-row refusals test it here; the boot count
 * (`stale-panel-identity.census.ts`) hands the same pattern to Postgres. Two
 * spellings could drift into counting rows the refusals let through, or the
 * reverse.
 */

/**
 * A decimal with no sign, no separators and no leading `+` — the only identity
 * a 3.x panel issues. Written as a POSIX bracket expression rather than `\d` so
 * that it means the same thing to a JavaScript `RegExp` and to Postgres `~`.
 */
export const DECIMAL_PANEL_ID_PATTERN = '^[0-9]+$';

const DECIMAL_PANEL_ID = new RegExp(DECIMAL_PANEL_ID_PATTERN);

/**
 * True when the stored identity is a numeric panel id. Re-exported by
 * `panel-user-address.ts`, where most callers import it from.
 */
export function isNumericPanelIdentity(remnawaveId: string): boolean {
  return DECIMAL_PANEL_ID.test(remnawaveId);
}

/**
 * True when the stored identity names nobody on a supported panel, so a panel
 * call that destroys something must not be built from it. See the note above.
 */
export function isStalePanelIdentity(remnawaveId: string): boolean {
  return !isNumericPanelIdentity(remnawaveId);
}

/**
 * Where an operator finds the rows this net refuses, spelled once for every
 * server text that names it (the refusals below, the boot count's card, the
 * expired-profile sweep's note). The automatic link check re-links the rows
 * whose owner it can prove and lists the rest there, each with «Привязать
 * профиль». The SPA names the same tab from its own dictionaries.
 */
export const UNLINKED_SUBSCRIPTIONS_PATH =
  '«Подписки» → «Инструменты» → «Подписки без привязки к Remnawave»';

const UNLINKED_LIST_PATH = UNLINKED_SUBSCRIPTIONS_PATH;

/**
 * The machine-readable half of the SUBSCRIPTION-DELETE refusal, so a client can
 * tell it from an ordinary failure and route the operator to the remedy instead
 * of to a retry. A wire value: the SPA branches on it, and
 * `admin-safe-exception.filter.ts` must keep it in `SAFE_PRODUCT_CODES` or the
 * filter strips it and the SPA sees an untyped 409.
 */
export const SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE = 'SUBSCRIPTION_DELETE_STALE_PANEL_LINK';

/**
 * The human-readable half. THREE CONSTRAINTS, all mechanical, and they hold for
 * every sentence in this file:
 *
 *  1. It names the REMEDY, not just the fault — at a duplicate pair, a fault
 *     alone tempts the operator to try the other half, which is the same
 *     deletion wearing a different id.
 *  2. No interpolation and none of the words `admin-safe-exception.filter.ts`
 *     scrubs (`profile`, `token`, `password`, a uuid, a URL, …): a message that
 *     trips `SENSITIVE_HTTP_TEXT_PATTERNS` reaches the client as "Request
 *     failed".
 *  3. None of `timeout|temporar|econn|429|502|503|504|unavailable`: a worker
 *     that reads a plain `Error`'s MESSAGE to choose TRANSIENT or TERMINAL must
 *     read this one as TERMINAL, so a human is told rather than retried at.
 */
export const SUBSCRIPTION_DELETE_STALE_PANEL_LINK_MESSAGE =
  'This subscription stores a Remnawave 2.x identifier, and a 3.x panel knows only numeric ids, ' +
  'so the stored link no longer names the right customer account. Nothing was deleted. The ' +
  'automatic link check re-links such subscriptions when it can prove whose they are; the rest ' +
  `are listed in ${UNLINKED_LIST_PATH}, where «Привязать профиль» links one by hand. Then delete ` +
  'it again.';

// ═══════════════════════════════════════════════════════════════════════════
//  THE SAME HAZARD, THE OTHER VERB: HWID DEVICE DELETION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The refusal for a DEVICE deletion built from a stale stored identity.
 *
 * A second code rather than a second use of the one above because a client
 * BRANCHES on it and the branches differ: the subscription refusal means
 * "nothing was deleted, delete it again after the repair", this one means "the
 * device is still bound, revoke it again after the repair". Same allowlist rule.
 */
export const SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE =
  'SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK';

/** The operator's wording. Same three constraints as the subscription refusal. */
export const SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_MESSAGE =
  'This subscription stores a Remnawave 2.x identifier, and a 3.x panel knows only numeric ids, ' +
  'so the stored link no longer names the right customer account. No device was revoked. The ' +
  'automatic link check re-links such subscriptions when it can prove whose they are; the rest ' +
  `are listed in ${UNLINKED_LIST_PATH}. Then revoke the device again.`;

/**
 * The subscriber's wording, and the reason there are two sentences under one
 * code: a customer pressing "revoke device" in the cabinet cannot open the
 * operator panel, so naming a screen there would be a dead end. Their next step
 * is to ask a human. A reiwa build that knows the code renders its own copy; one
 * that does not prints this verbatim.
 */
export const SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE =
  'This device could not be revoked: the link between this subscription and the VPN panel must ' +
  'be repaired first, and revoking before that could remove a device from another customer’s ' +
  'account. Nothing was changed. Please contact support.';

/** Which surface is being answered — see the two messages above. */
export type StalePanelLinkAudience = 'operator' | 'subscriber';

/**
 * The refusal BODY, one spelling for every device-deletion call site. A plain
 * record: each call site throws its own `ConflictException` around it. 409,
 * matching `USER_DELETE_PROTECTED_HISTORY` — a refusal on the STATE OF THE DATA,
 * not on the request.
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
 * identity — the worst of the three by consequence: the rotation would revoke
 * the short uuid of whichever account the fallback lands on, and every client
 * that customer ever configured would stop at once, with no way back.
 *
 * A third code because what the client must say is the OPPOSITE of a
 * successful regeneration: the links were NOT rotated and all of them still
 * work, so the follow-up is "regenerate again after the repair".
 */
export const SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_CODE =
  'SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK';

/**
 * The operator's wording. No operator surface raises it today — the only
 * regeneration endpoint answers the cabinet — but the body takes the audience
 * rather than assuming one, so the sentence exists before somebody borrows a
 * sibling's.
 */
export const SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_MESSAGE =
  'This subscription stores a Remnawave 2.x identifier, and a 3.x panel knows only numeric ids, ' +
  'so the stored link no longer names the right customer account. The subscription link was NOT ' +
  'rotated and every client holding it still works. The automatic link check re-links such ' +
  `subscriptions when it can prove whose they are; the rest are listed in ${UNLINKED_LIST_PATH}. ` +
  'Then regenerate it again.';

/**
 * The subscriber's wording, and the one raised today. It says the old link
 * still works: the button was pressed to make it stop, and "nothing changed" is
 * the reassurance and the warning at once.
 */
export const SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE =
  'This subscription link could not be regenerated: the link between this subscription and the ' +
  'VPN panel must be repaired first, and regenerating before that would cut off another ' +
  'customer’s apps instead. Your current link still works and nothing was changed. Please ' +
  'contact support.';

/** The refusal BODY for the regenerate verb; same shape and status as the device one. */
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
