// From the dependency-free util, not from `remnawave-version.service`: that
// service is constructed WITH the adapter, and importing it here would put a
// cycle between the adapter and the thing that tells it which shape to build.
import type { RemnawaveUserAddressing } from './panel-version.util';

/**
 * How rezeis names ONE panel profile when talking to a panel, across all three
 * supported versions.
 *
 * Remnawave 2.7.4 and 2.8.0 key users by a UUID. Remnawave 3.x deleted that
 * column outright — a 3.x user row has no `uuid` at all — and re-keyed every
 * user-scoped route on the numeric `id`. Handing a 2.x UUID to a 3.x panel does
 * not 404; it fails validation with `400 expected number, received NaN`. That
 * is the safe direction (nothing downstream reads a 400 as "the profile is
 * gone"), but it is still a dead integration, so the address has to be built
 * per version rather than assumed.
 *
 * The three facts this module reasons over, all stored on `Subscription`:
 *   • `remnawaveId`     — the panel's own identity as a string. A 2.x UUID, or
 *                         a 3.x numeric id in decimal. Never parsed to GUESS
 *                         the version: a profile created on 2.x keeps its UUID
 *                         here after the operator upgrades to 3.x.
 *   • `panelId`         — the numeric id. Both 2.x and 3.x expose it on every
 *                         user row, so it accumulates on its own long before
 *                         anybody upgrades.
 *   • `panelUsername`   — the name the profile was created under. The last
 *                         resort, and the only one that survives an upgrade
 *                         performed before we ever recorded the numeric id.
 *   • `panelShortUuid`  — the stable subscription short UUID, recovered from
 *                         our saved subscription URL. On 3.x it is a safer
 *                         resolver than username because customer-facing links
 *                         are unique panel material, while usernames are
 *                         deterministic and can be reused after reprovisioning.
 */
export interface StoredPanelIdentity {
  /**
   * Non-null by contract: callers establish "a profile exists" by testing this
   * for null before they get here, so a null would mean the caller skipped the
   * check rather than that the profile is missing.
   */
  readonly remnawaveId: string;
  readonly panelId: number | null;
  readonly panelUsername: string | null;
  readonly panelShortUuid?: string | null;
}

/**
 * The result of asking "what goes in the path?".
 *
 * `needsResolve` is deliberately not resolved here. This module stays free of
 * I/O so it can be reasoned about (and tested) without a panel, and so the one
 * place that performs the extra round-trip is the adapter, which can also
 * persist what it learns.
 *
 * `impossible` is never a soft failure. It means the profile cannot be named on
 * this panel at all, and the caller must surface that rather than fall through
 * to a request built from a guess — a guessed identifier addresses SOMEBODY,
 * just not necessarily the right somebody.
 */
export type PanelAddress =
  | { readonly kind: 'ready'; readonly segment: string }
  | { readonly kind: 'needsResolve'; readonly selector: PanelResolveSelector }
  | { readonly kind: 'impossible'; readonly reason: string };

export type PanelResolveSelector =
  | { readonly shortUuid: string }
  | { readonly username: string };

/**
 * How a caller names a profile to the adapter.
 *
 * A bare string is the stored `remnawaveId` and nothing more. It is enough for:
 *   • any 2.x panel — the stored string IS the uuid the path wants;
 *   • any profile CREATED on 3.x — the stored string is already the numeric id.
 *
 * It is NOT enough for exactly one case: a profile created on 2.x whose panel
 * has since been upgraded to 3.x and which nothing has touched since. There the
 * adapter needs the recorded numeric id or the recorded panel username, and a
 * caller that passes only the string gets a refusal with a log line naming the
 * profile — never a guess, and never a silent success against another user.
 *
 * Callers are migrated to the full object one module at a time; the union is
 * what makes that incremental instead of one forty-site change.
 */
export type PanelUserRef = string | StoredPanelIdentity;

/** Widens a bare stored id into the identity shape, with nothing else known. */
export function asStoredIdentity(ref: PanelUserRef): StoredPanelIdentity {
  return typeof ref === 'string'
    ? { remnawaveId: ref, panelId: null, panelUsername: null }
    : ref;
}

/**
 * The row shape every caller reads out of Prisma. The two supplementary columns
 * are optional so a caller mid-migration — one whose `select` does not list them
 * yet — still type-checks; it simply gets the same answer a bare string would.
 */
export interface PanelIdentityColumns {
  readonly remnawaveId: string | null;
  readonly remnawavePanelId?: number | null;
  readonly remnawavePanelUsername?: string | null;
  readonly configUrl?: string | null;
}

/**
 * Turns a `Subscription` row into the identity the adapter wants, or `null` when
 * there is no panel profile at all.
 *
 * ONE implementation for every call site on purpose. Every caller has to do the
 * same three things — check `remnawaveId` for null, carry the numeric id, carry
 * the panel username — and a per-module copy of that is three chances to omit
 * the third field and silently lose the only route back to a profile whose panel
 * has been upgraded.
 *
 * `?? null` is not decoration: a caller whose `select` omits a column hands over
 * `undefined`, which passes a null check and reaches the addressing layer as a
 * value. `String(undefined)` is a path segment that 404s against a panel where
 * the profile is very much alive, and a 404 is exactly what callers read as
 * "the profile is gone".
 */
export function storedIdentityOf(row: PanelIdentityColumns | null): StoredPanelIdentity | null {
  if (row === null || row.remnawaveId === null) return null;
  const panelShortUuid = panelShortUuidFromConfigUrl(row.configUrl ?? null);
  return {
    remnawaveId: row.remnawaveId,
    panelId: row.remnawavePanelId ?? null,
    panelUsername: row.remnawavePanelUsername ?? null,
    ...(panelShortUuid === null ? {} : { panelShortUuid }),
  };
}

export function panelShortUuidFromConfigUrl(value: string | null): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = new URL(value);
    const match = parsed.pathname.match(/(?:^|\/)api\/sub\/([^/?#]+)$|(?:^|\/)sub\/([^/?#]+)$/);
    const raw = match?.[1] ?? match?.[2];
    return raw !== undefined && raw.length > 0 ? decodeURIComponent(raw) : null;
  } catch {
    const match = value.match(/(?:^|\/)api\/sub\/([^/?#]+)$|(?:^|\/)sub\/([^/?#]+)$/);
    const raw = match?.[1] ?? match?.[2];
    return raw !== undefined && raw.length > 0 ? decodeURIComponent(raw) : null;
  }
}

/** A decimal integer with no sign, no separators, no leading `+`. */
const DECIMAL_ID = /^\d+$/;

/** True when the stored identity is a numeric panel id rather than a 2.x UUID. */
export function isNumericPanelIdentity(remnawaveId: string): boolean {
  return DECIMAL_ID.test(remnawaveId);
}

/**
 * Builds the path segment for a user-scoped route, or says why it cannot.
 *
 * WHAT `'unknown'` DOES, since this docstring used to claim the opposite: it
 * yields the STORED identity unchanged, not `impossible`. Refusing was the first
 * design and it was wrong for a reason worth keeping written down — version
 * detection folds every failure (401, timeout, DNS, an unconfigured token) into
 * "no version", so a refusal would fire exactly when the panel is already
 * answering with terminal errors, and would convert those into "cannot act",
 * which the sync layer classifies as TRANSIENT. Forever-retry with no alert.
 *
 * What stays impossible on `'unknown'` is the thing that was actually dangerous:
 * CONVERTING between the two identity forms without the material to do it. The
 * stored string names the right profile or nobody; a converted one can name
 * somebody else. See the `'unknown'` branch below, which says this again at the
 * point where it is enforced, and the test that pins it.
 */
export function panelUserAddress(
  identity: StoredPanelIdentity,
  addressing: RemnawaveUserAddressing,
): PanelAddress {
  const stored = identity.remnawaveId;
  const storedIsNumeric = isNumericPanelIdentity(stored);

  switch (addressing) {
    case 'id': {
      // Fast path: the profile was created on 3.x, so what we stored IS the id.
      if (storedIsNumeric) return { kind: 'ready', segment: stored };
      // Created on 2.x, panel since upgraded. The numeric id is usually already
      // here, because every ordinary read of a 2.x row carried one.
      //
      // Tested as a safe integer, not merely as `!== null`. A caller that built
      // this object from a row it selected WITHOUT the column hands over
      // `undefined`, which passes a null check and produces the path segment
      // `"undefined"` — a request that 404s against a panel where the profile is
      // very much alive, and reads to the caller as "the profile is gone".
      if (Number.isSafeInteger(identity.panelId)) {
        return { kind: 'ready', segment: String(identity.panelId) };
      }
      // Never touched since the upgrade. The saved subscription link carries
      // the shortUuid, which the 3.x resolver still accepts and which is safer
      // than username: usernames are deterministic and can be reused after a
      // reprovision, while a stale shortUuid names the right profile or nobody.
      if (typeof identity.panelShortUuid === 'string' && identity.panelShortUuid.length > 0) {
        return { kind: 'needsResolve', selector: { shortUuid: identity.panelShortUuid } };
      }
      // The name is the last way back: the panel's 3.x migration drops the uuid
      // without preserving it anywhere.
      // An empty string is not a name — resolving by it would ask the panel
      // "which user is called nothing?" and act on whatever came back.
      if (typeof identity.panelUsername === 'string' && identity.panelUsername.length > 0) {
        return { kind: 'needsResolve', selector: { username: identity.panelUsername } };
      }
      return {
        kind: 'impossible',
        reason:
          `profile "${stored}" is a 2.x uuid, the panel is 3.x, and neither a numeric id, ` +
          'subscription short UUID nor panel username was ever recorded for it',
      };
    }
    case 'uuid': {
      // Fast path: created on 2.x, still on 2.x.
      if (!storedIsNumeric) return { kind: 'ready', segment: stored };
      // A numeric identity on a uuid-addressed panel means the profile was made
      // on 3.x and the operator has since rolled back. We never stored a uuid
      // for it — 3.x had none to give — so only the name can recover it.
      if (typeof identity.panelShortUuid === 'string' && identity.panelShortUuid.length > 0) {
        return { kind: 'needsResolve', selector: { shortUuid: identity.panelShortUuid } };
      }
      if (typeof identity.panelUsername === 'string' && identity.panelUsername.length > 0) {
        return { kind: 'needsResolve', selector: { username: identity.panelUsername } };
      }
      return {
        kind: 'impossible',
        reason:
          `profile "${stored}" is a 3.x numeric id, the panel is 2.x, and no panel username ` +
          'was recorded for it',
      };
    }
    case 'unknown':
      // Use the stored identity unchanged. This is NOT the guess this module
      // exists to prevent — that guess is CONVERTING between the two forms
      // without the material to do it, which can name a different profile. The
      // stored string names either the right profile or nobody: on the panel
      // that issued it, it is correct; on the other era it fails validation with
      // `400 expected number, received NaN` or a plain 404, and no caller reads
      // either as "the profile is gone".
      //
      // Refusing here instead looked safer and was worse. Version detection
      // fails for the same reasons a request fails — an unreachable panel, a bad
      // token — so a refusal would fire exactly when the panel is already
      // answering with terminal errors, and would convert those into "cannot
      // act", which the sync layer classifies as TRANSIENT. That is the
      // forever-retry-with-no-alert hole, entered on purpose.
      return { kind: 'ready', segment: stored };
  }
}

/**
 * The key half of a `PATCH /api/users` body.
 *
 * This request is the one write that needs no version branch at all: every
 * supported panel accepts `username` as an alternative key (2.7.3's own
 * contract declares `uuid` and `username` both optional under an "at least one
 * of" refinement, and 3.2.1 answers `400 At least one of username, id must be
 * provided`). We still prefer the immutable identifier and keep the name as a
 * fallback — an operator who renames a profile by hand in the panel would
 * otherwise silently retarget every later write.
 *
 * ON AN UNIDENTIFIED PANEL THE NAME IS STILL THE FALLBACK, NOT THE PREFERENCE.
 * This function used to invert its own rule there, reasoning that `{uuid}` is
 * dropped by 3.x and `{id}` by 2.x, so only the name is certain to land. It is —
 * and that is the problem. Landing is not the goal; landing ON THE RIGHT PROFILE
 * is. Panel usernames are DETERMINISTIC, so a profile that was deleted and
 * re-provisioned carries the same name as the one we are holding an identity
 * for, and a write keyed by that name silently retargets a live profile that
 * merely inherited the name. Keying by the stored identifier instead names the
 * right profile or NOBODY: the wrong-era key is dropped and the panel answers
 * `400 At least one of …`, which no caller reads as success. That is the same
 * "names the right profile or nobody" rule {@link panelUserAddress} states for
 * its own `'unknown'` branch, and this was the one place that broke it.
 */
export function panelUserPatchKey(
  identity: StoredPanelIdentity,
  addressing: RemnawaveUserAddressing,
): { readonly uuid: string } | { readonly id: number } | { readonly username: string } | null {
  const address = panelUserAddress(identity, addressing);
  if (address.kind === 'ready') {
    // The FORM of the segment picks the key, not the addressing. On an
    // identified panel the two agree by construction — a uuid always carries
    // hyphens and a panel id is always decimal, so `'uuid'` addressing can only
    // produce a non-numeric segment and `'id'` only a numeric one. On
    // `'unknown'` the segment is the stored string unchanged, and its form is
    // the only honest evidence of which era issued it.
    return isNumericPanelIdentity(address.segment)
      ? { id: Number.parseInt(address.segment, 10) }
      : { uuid: address.segment };
  }
  if (address.kind === 'needsResolve') {
    if ('username' in address.selector) return { username: address.selector.username };
    return null;
  }
  if (typeof identity.panelUsername === 'string' && identity.panelUsername.length > 0) {
    return { username: identity.panelUsername };
  }
  return null;
}

/**
 * The owner field of a HWID device request body.
 *
 * 2.x names it `userUuid`, 3.x names it `userId` and wants the number. Same
 * split as the path segment, different key, so it gets its own helper rather
 * than a second `if` at each of the three call sites.
 */
export function panelDeviceOwnerKey(
  segment: string,
  addressing: RemnawaveUserAddressing,
): { readonly userUuid: string } | { readonly userId: number } {
  return addressing === 'id'
    ? { userId: Number.parseInt(segment, 10) }
    : { userUuid: segment };
}
