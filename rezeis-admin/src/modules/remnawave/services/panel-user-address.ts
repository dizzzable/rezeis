// Type-only, and it stays that way: `panelIdentityLookup` below hands back a
// `where` for callers to run, it never runs one itself, so this module remains
// reasonable (and testable) without a database.
import type { Prisma } from '@prisma/client';

// The decimal test lives in the dependency-free safety-net module, so the
// destructive paths' refusal, this module's addressing and the boot count all
// read ONE spelling of "a 3.x panel id". Re-exported: most callers import it
// from here.
import { isNumericPanelIdentity } from './stale-panel-link';

export { isNumericPanelIdentity };

/**
 * How rezeis names ONE panel profile when talking to a Remnawave 3.x panel —
 * the only version this build speaks.
 *
 * 3.x deleted the user uuid column outright and keys every user-scoped route on
 * the numeric `id`. A profile linked while the panel was still 2.x, though,
 * keeps its uuid in our database: the panel's own migration drops the uuid, we
 * do not. So the address is built from what we stored, never assumed.
 *
 * The facts this module reasons over, all stored on `Subscription`:
 *   • `remnawaveId`     — the panel's own identity as a string: the numeric id
 *                         in decimal for anything linked on 3.x, a uuid for a
 *                         row linked back on 2.x. Never parsed into a number
 *                         unless it IS a decimal (`Number.parseInt` reads
 *                         `330f2b38-…` as 330 — another customer).
 *   • `panelId`         — the numeric id. 2.x put it on every user row too, so
 *                         a row linked on 2.x has usually been carrying it.
 *   • `panelUsername`   — the name the profile was created under. The last
 *                         resort, and the only one that survives an upgrade
 *                         performed before we ever recorded the numeric id.
 *   • `panelShortUuid`  — the stable subscription short UUID, recovered from
 *                         our saved subscription URL. A safer resolver than
 *                         username: customer-facing links are unique panel
 *                         material, while usernames are deterministic and can be
 *                         reused after reprovisioning.
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
 * A bare string is the stored `remnawaveId` and nothing more. It is enough for
 * any profile CREATED on 3.x — the stored string is already the numeric id.
 *
 * It is NOT enough for a profile created on 2.x whose panel has since been
 * upgraded to 3.x. There the adapter needs the recorded numeric id, the short
 * uuid or the panel username, and a caller that passes only the string gets a
 * refusal with a log line naming the profile — never a guess, and never a
 * silent success against another user.
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
    return panelShortUuidFromPath(parsed.pathname);
  } catch {
    const path = value.split(/[?#]/, 1)[0] ?? '';
    return panelShortUuidFromPath(path);
  }
}

/** Path segments that are routes of a panel or a subscription page, never an id. */
const RESERVED_ROUTE_SEGMENT = /^(api|admin|assets?|favicon\.ico|health|metrics|subscription|subscriptions)$/i;

function panelShortUuidFromPath(pathname: string): string | null {
  const match = pathname.match(/(?:^|\/)api\/sub\/([^/?#]+)$|(?:^|\/)sub\/([^/?#]+)$/);
  const explicit = match?.[1] ?? match?.[2];
  if (explicit !== undefined && explicit.length > 0) return decodePathSegment(explicit);

  // Remnawave 3.2.x renders subscription links as `https://sub-domain/<shortUuid>`.
  // Accept only one plain path segment so dashboard/API routes are never mistaken
  // for profile material.
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length !== 1) return null;
  const raw = segments[0];
  if (RESERVED_ROUTE_SEGMENT.test(raw)) {
    return null;
  }
  return decodePathSegment(raw);
}

/**
 * A path segment, percent-decoded — or `null` when its encoding is malformed.
 *
 * `decodeURIComponent` THROWS on `%E0%A4%A`, and this sits under panel
 * addressing and under recovery by subscription link: a single stored address
 * with a stray `%` used to throw out of every caller. "Cannot tell" is the
 * honest answer; the raw text would be an id nobody issued.
 */
function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Words that end a subscription address without being an id: routes and client formats. */
const NOT_A_SHORT_ID = new Set([
  'sub',
  'subs',
  'api',
  'json',
  'singbox',
  'sing-box',
  'clash',
  'mihomo',
  'stash',
  'v2ray',
  'v2ray-json',
  'xray',
  'xray-json',
  'outline',
  'info',
]);

/**
 * Every short id a STORED subscription address can be recognised by, for
 * matching the link a customer pastes during password recovery.
 *
 * Wider than `panelShortUuidFromConfigUrl` on purpose, and kept apart from it:
 * that one feeds panel ADDRESSING, and widening it would start addressing
 * profiles by whatever a custom path happens to end with. Here the answer is
 * only ever compared with the customer's own paste, and the extra case is the
 * one the strict reader misses — an operator's subscription page under a
 * custom path prefix (`https://sub.example.com/vpn/<id>`), whose customers
 * would otherwise never match and lock themselves out trying.
 *
 * The fallback takes the LAST segment, and only when it looks like an issued
 * id: 8–64 characters of the short-id alphabet, not a route, not a client
 * format. A generic last word would let anybody who typed it match every
 * address that ends with it.
 */
export function configUrlShortIds(value: string | null): string[] {
  const ids: string[] = [];
  const strict = panelShortUuidFromConfigUrl(value);
  if (strict !== null) ids.push(strict);
  if (typeof value !== 'string' || value.length === 0) return ids;
  let pathname: string;
  try {
    pathname = new URL(value).pathname;
  } catch {
    pathname = value.split(/[?#]/, 1)[0] ?? '';
  }
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  const last = segments.length === 0 ? null : decodePathSegment(segments[segments.length - 1]);
  if (
    last !== null &&
    !ids.includes(last) &&
    /^[A-Za-z0-9_-]{8,64}$/.test(last) &&
    !RESERVED_ROUTE_SEGMENT.test(last) &&
    !NOT_A_SHORT_ID.has(last.toLowerCase())
  ) {
    ids.push(last);
  }
  return ids;
}

/**
 * Both angles a BATCH of panel identities has to be matched on locally, plus
 * the map back from a fetched row to the identity the caller asked about.
 *
 * The plural sibling of `panelIdentityWhere` (`remnawave-webhook.service.ts`),
 * and it exists for the same reason: a profile created on 2.x keeps its uuid in
 * `Subscription.remnawaveId` after the operator upgrades to 3.x — the panel's
 * own migration drops the uuid, we do not — but from then on the panel names
 * that profile by its numeric id alone. Asking `remnawaveId IN (…)` with a
 * batch of 3.x decimals therefore misses that entire population, silently, and
 * the miss is not a blank field: the caller loses the rezeis user id AND the
 * device-limit-reduction stamp that excuses a legitimate downgrade. It fails in
 * the ACCUSING direction, against customers who did nothing.
 *
 * `remnawavePanelId` is a second recorded angle on the SAME identity, so adding
 * it widens the match without loosening it — this is not a fuzzy search.
 *
 * TWO BOUNDS, both load-bearing:
 *   • the numeric list is built only from identities that are ENTIRELY digits
 *     AND parse to a safe integer. Without the first test
 *     `Number.parseInt('330f2b38-…')` yields `330` — a valid-looking id
 *     belonging to somebody else; without the second, a 30-digit string rounds
 *     to a neighbour's id.
 *   • when that list comes out EMPTY the numeric arm is OMITTED, never emitted
 *     as `remnawavePanelId: null` and never as an `in` carrying a null.
 *     `remnawave_panel_id` has no unique constraint and is null on most rows
 *     (migration `20260810160000` records why one could not be added to live
 *     data), so either of those spellings matches every row that has no panel
 *     id — turning "which subscriptions are these" into "all of them" inside an
 *     anti-fraud detector.
 */
export interface PanelIdentityLookup {
  /** Finds every local row named by one of the requested identities. */
  readonly where: Prisma.SubscriptionWhereInput;
  /**
   * Which requested identities a fetched row answers to: normally one, two when
   * the row is named by both angles at once, and NONE for a row that arrived
   * for a reason the caller never asked about.
   *
   * Callers key their result map by THESE, never by `row.remnawaveId`. On a 3.x
   * panel the caller asks about `"4471"` while the row that answers is stamped
   * `"330f2b38-…"`, so keying by the row would re-lose the match the widened
   * `where` just recovered.
   */
  keysFor(row: PanelIdentityColumns): readonly string[];
}

/** `null` when there is nothing to look up; callers already return early. */
export function panelIdentityLookup(identities: readonly string[]): PanelIdentityLookup | null {
  const requested = new Set(identities.filter((v) => typeof v === 'string' && v.length > 0));
  if (requested.size === 0) return null;
  // A list rather than a single string: two spellings can share one numeric
  // angle (`'42'` and `'042'`), and attributing such a row to only one of them
  // would drop the other's grace silently — the same class of quiet miss this
  // helper exists to stop.
  const identitiesByPanelId = new Map<number, string[]>();
  for (const identity of requested) {
    if (!isNumericPanelIdentity(identity)) continue;
    const panelId = Number.parseInt(identity, 10);
    if (!Number.isSafeInteger(panelId)) continue;
    const existing = identitiesByPanelId.get(panelId);
    if (existing === undefined) identitiesByPanelId.set(panelId, [identity]);
    else if (!existing.includes(identity)) existing.push(identity);
  }
  const storedIds = [...requested];
  const panelIds = [...identitiesByPanelId.keys()];
  const where: Prisma.SubscriptionWhereInput =
    panelIds.length === 0
      ? { remnawaveId: { in: storedIds } }
      : { OR: [{ remnawaveId: { in: storedIds } }, { remnawavePanelId: { in: panelIds } }] };
  return {
    where,
    keysFor(row: PanelIdentityColumns): readonly string[] {
      const keys: string[] = [];
      if (typeof row.remnawaveId === 'string' && requested.has(row.remnawaveId)) {
        keys.push(row.remnawaveId);
      }
      const panelId = row.remnawavePanelId;
      // Tested as a safe integer, not as `!= null`: a caller whose `select`
      // omitted the column hands over `undefined`, and `undefined` must answer
      // for nobody rather than for whoever `Map.get(undefined)` finds.
      if (typeof panelId === 'number' && Number.isSafeInteger(panelId)) {
        for (const identity of identitiesByPanelId.get(panelId) ?? []) {
          if (!keys.includes(identity)) keys.push(identity);
        }
      }
      return keys;
    },
  };
}

/**
 * Builds the path segment for a user-scoped route on a 3.x panel, or says why
 * it cannot.
 *
 * ONE SET OF RULES, WHATEVER THE VERSION PROBE SAYS. This used to take the
 * panel's addressing era as a second argument and, on an unreadable version,
 * send the stored string unchanged — a uuid to a panel that answers only to
 * numbers. The only era this build speaks is 3.x (a 2.x panel is refused before
 * any request is built), so an unreadable version is addressed exactly as a
 * proven 3.x one: every request goes out in the one shape a supported panel
 * accepts.
 *
 * The chain below keeps a row linked on 2.x reachable for READS and PATCHes.
 * It must never feed a verb that destroys: a stale uuid resolved through it can
 * land on another customer's live profile, which is why every destructive
 * adapter method refuses a non-decimal identity (`isStalePanelIdentity`,
 * `stale-panel-link.ts`) BEFORE it asks this function anything.
 */
export function panelUserAddress(identity: StoredPanelIdentity): PanelAddress {
  const stored = identity.remnawaveId;
  // Fast path: the profile was created on 3.x, so what we stored IS the id.
  if (isNumericPanelIdentity(stored)) return { kind: 'ready', segment: stored };
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
  // Never touched since the upgrade. The saved subscription link carries the
  // shortUuid, which the 3.x resolver accepts and which is safer than username:
  // usernames are deterministic and can be reused after a reprovision, while a
  // stale shortUuid names the right profile or nobody.
  if (typeof identity.panelShortUuid === 'string' && identity.panelShortUuid.length > 0) {
    return { kind: 'needsResolve', selector: { shortUuid: identity.panelShortUuid } };
  }
  // The name is the last way back: the panel's 3.x migration drops the uuid
  // without preserving it anywhere.
  // An empty string is not a name — resolving by it would ask the panel "which
  // user is called nothing?" and act on whatever came back.
  if (typeof identity.panelUsername === 'string' && identity.panelUsername.length > 0) {
    return { kind: 'needsResolve', selector: { username: identity.panelUsername } };
  }
  return {
    kind: 'impossible',
    reason:
      `profile "${stored}" is not a 3.x numeric id, and neither a numeric id, ` +
      'subscription short UUID nor panel username was ever recorded for it',
  };
}

/**
 * The key half of a `PATCH /api/users` body.
 *
 * Every 3.x contract accepts `id` or `username` here (3.2.1 answers `400 At
 * least one of username, id must be provided`). We prefer the immutable
 * identifier and keep the name as a fallback — an operator who renames a
 * profile by hand in the panel would otherwise silently retarget every later
 * write.
 *
 * THE NAME IS THE FALLBACK, NOT THE PREFERENCE, and landing is not the goal —
 * landing ON THE RIGHT PROFILE is. Panel usernames are DETERMINISTIC, so a
 * profile that was deleted and re-provisioned carries the same name as the one
 * we hold an identity for, and a write keyed by that name silently retargets a
 * live profile that merely inherited it. So the name is used only when the
 * stored identity has no numeric id to give and resolving by name is the
 * address chain's own last step.
 *
 * THE FORM OF THE SEGMENT PICKS THE KEY, and a segment that is not a decimal
 * answers `null` ("cannot act"). It must never fall through to `{ id }`:
 * `Number.parseInt('330f2b38-…')` is 330, another customer's id. There is no
 * `{ uuid }` key any more — a 3.x panel drops it and answers `400 At least one
 * of username, id must be provided`.
 */
export function panelUserPatchKey(
  identity: StoredPanelIdentity,
): { readonly id: number } | { readonly username: string } | null {
  const address = panelUserAddress(identity);
  if (address.kind === 'ready') {
    if (!isNumericPanelIdentity(address.segment)) return null;
    const id = Number.parseInt(address.segment, 10);
    return Number.isSafeInteger(id) ? { id } : null;
  }
  if (address.kind === 'needsResolve') {
    // A short uuid is resolved to the numeric id by the adapter
    // (`patchKeyFor`), which can make the round-trip this pure function cannot.
    if ('username' in address.selector) return { username: address.selector.username };
    return null;
  }
  // `impossible`: no id, no short uuid and no name was ever recorded, so there
  // is nothing left to key the write by.
  return null;
}

/**
 * The owner field of a HWID device request body: `userId`, the number.
 *
 * CHOSEN BY THE FORM OF THE SEGMENT, and a segment that is not a decimal is
 * refused (`null`), never parsed. `Number.parseInt` reads a LEADING run of
 * digits and stops, so a stale 2.x uuid like `330f2b38-…` would become user 330
 * — somebody else — and the request would unbind THEIR device. The destructive
 * adapter methods refuse a non-decimal stored identity before they get here;
 * this is the check at the point where the number is actually made.
 */
export function panelDeviceOwnerKey(segment: string): { readonly userId: number } | null {
  if (!isNumericPanelIdentity(segment)) return null;
  const userId = Number.parseInt(segment, 10);
  return Number.isSafeInteger(userId) ? { userId } : null;
}
