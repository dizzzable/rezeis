/**
 * remnawave-overlay.util
 * ──────────────────────
 * Bot backups (STEALTHNET / Remnashop / Altshop) are NOT the source of truth:
 * their subscription rows are a point-in-time snapshot that may already be
 * stale (the user's plan could have expired since the dump). Remnawave itself
 * is the live truth.
 *
 * So at import time we cross-check every backup subscription that carries a
 * Remnawave UUID against the live panel and, when the panel still knows the
 * profile, overlay its FRESH state (status / expiry / limits / squads / url).
 * Profiles the panel PROVES it no longer has are treated as expired — kept
 * locally so the user can re-buy through the bot, but never resurrected as
 * "active". A panel that merely failed to answer proves nothing.
 *
 * The import is READ-ONLY toward Remnawave: it never pushes the (possibly
 * stale) backup state back, so live profiles are never clobbered.
 */
import { SubscriptionStatus } from '@prisma/client';

import type {
  RemnawavePanelUser,
  RemnawavePanelUserList,
} from '../../remnawave/services/remnawave-api.service';
import {
  describeStrictOutcome,
  type RemnawaveStrictOutcome,
} from '../../remnawave/interfaces/remnawave-strict-outcome.interface';

/** Fresh subscription fields projected from a live Remnawave panel profile. */
export interface PanelSubscriptionState {
  readonly status: SubscriptionStatus;
  readonly expiresAt: Date | null;
  /** GB; `null` = unlimited (panel stores bytes, we store GB). */
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly internalSquads: string[];
  readonly externalSquad: string | null;
  readonly configUrl: string | null;
}

/** Map a Remnawave status string to our enum. Unknown → EXPIRED (not live). */
export function mapPanelStatus(raw: string | null | undefined): SubscriptionStatus {
  switch ((raw ?? '').toUpperCase()) {
    case 'ACTIVE':
      return SubscriptionStatus.ACTIVE;
    case 'DISABLED':
      return SubscriptionStatus.DISABLED;
    case 'LIMITED':
      return SubscriptionStatus.LIMITED;
    case 'EXPIRED':
      return SubscriptionStatus.EXPIRED;
    case 'DELETED':
      return SubscriptionStatus.DELETED;
    default:
      return SubscriptionStatus.EXPIRED;
  }
}

/** Statuses we treat as "live" — the user still has a usable subscription. */
export function isLivePanelStatus(status: SubscriptionStatus): boolean {
  return status === SubscriptionStatus.ACTIVE || status === SubscriptionStatus.LIMITED;
}

/**
 * Decide a subscription's status when the panel has NO profile for its UUID:
 *   • panel unreachable (we couldn't read it) → trust the backup status as-is
 *     (fail-soft — never mass-expire on a transient outage);
 *   • panel reachable but the profile is gone → a backup that still claims the
 *     sub is live is stale, so it's EXPIRED; any already-non-live backup status
 *     is kept as-is ("остальные остаются как есть").
 */
export function reconcileMissingPanelStatus(
  panelReachable: boolean,
  backupStatus: SubscriptionStatus,
): SubscriptionStatus {
  if (!panelReachable) return backupStatus;
  return isLivePanelStatus(backupStatus) ? SubscriptionStatus.EXPIRED : backupStatus;
}

/** Convert the panel's byte cap to our GB cap (0/negative → unlimited). */
export function panelTrafficGb(trafficLimitBytes: number | null | undefined): number | null {
  if (typeof trafficLimitBytes !== 'number' || !Number.isFinite(trafficLimitBytes)) return null;
  return trafficLimitBytes > 0 ? Math.max(1, Math.round(trafficLimitBytes / 1024 ** 3)) : null;
}

/** Project a live panel profile into our subscription fields (panel = truth). */
export function panelSubscriptionState(panel: RemnawavePanelUser): PanelSubscriptionState {
  return {
    status: mapPanelStatus(panel.status),
    expiresAt: panel.expireAt ? new Date(panel.expireAt) : null,
    trafficLimit: panelTrafficGb(panel.trafficLimitBytes),
    deviceLimit:
      typeof panel.hwidDeviceLimit === 'number' && panel.hwidDeviceLimit >= 0
        ? panel.hwidDeviceLimit
        : 0,
    internalSquads: (panel.activeInternalSquads ?? []).map((s) => s.uuid),
    externalSquad: panel.externalSquadUuid ?? null,
    configUrl: panel.subscriptionUrl || null,
  };
}

/** Resolved bulk view of the panel for an import run. */
export interface PanelLookup {
  readonly map: ReadonlyMap<string, RemnawavePanelUser>;
  /** False when the panel could not be read at all (fail-soft to backup). */
  readonly reachable: boolean;
  /**
   * True when the bulk read walked the list to its end. False when it stopped
   * at the adapter's page ceiling: the map is then a PREFIX of the panel and a
   * miss says nothing until it is confirmed per-UUID.
   */
  readonly complete: boolean;
  /**
   * Which NAMESPACE the map's keys live in, read off the rows themselves.
   *
   * This exists because a miss only means "gone" when the key we looked up
   * COULD have been in the map. Remnawave 3.x dropped the user uuid, so its
   * rows decode to their numeric id, while `Subscription.remnawaveId` keeps the
   * 2.x uuid it was created with — deliberately, it is the design invariant.
   * Look a uuid up in an id-keyed map and it misses every time, for every
   * subscription, and a `complete` list turns that into "the panel proves this
   * profile is gone" → EXPIRED written over every live paying customer on the
   * first import after an upgrade.
   *
   * `'mixed'` when the rows disagree and `'unknown'` when there are none; both
   * are treated as "cannot rule out a namespace mismatch", which costs a
   * per-profile confirmation and nothing else.
   */
  readonly keyKind: 'id' | 'uuid' | 'mixed' | 'unknown';
}

/** Whole-string digits — the shape a 3.x identity decodes to. */
function looksNumeric(key: string): boolean {
  return /^\d+$/.test(key);
}

/**
 * Bulk-load the panel once into a {@link PanelLookup}.
 *
 * Two independent facts, and conflating them is what cost us data before:
 *
 * `reachable` — we understood what the panel sent. Granted ONLY for a strict
 *   `ok`, because every other outcome is a read we cannot vouch for: an empty
 *   array used to mean "no users on the panel", "we dropped every row" and "a
 *   page never arrived" all at once, and the shortfall was then taken as the
 *   evidence of completeness — the worse the read, the more confident the map.
 *   Unreachable yields no verdict at all and the import keeps its backup values.
 *
 * `complete` — the read reached the END of the list. Only the adapter knows
 *   this (it is the one that either exhausted the list or ran out of pages), so
 *   it is taken from the outcome rather than re-derived here: a row count says
 *   nothing about truncation once a panel may serve pages smaller than we ask
 *   for. A TRUNCATED read is still perfectly reachable — those rows are real —
 *   so it stays usable and only its misses need the extra per-UUID call.
 *
 * Note the ceiling on what `reachable && complete` licenses: the adapter proves
 * every row it was served decoded, not that the list is a consistent snapshot
 * of an offset-paginated, mutating panel. A miss is strong evidence a profile
 * is gone, not proof — see {@link RemnawavePanelUserList}.
 */
export async function buildPanelLookup(
  fetchAll: () => Promise<RemnawaveStrictOutcome<RemnawavePanelUserList>>,
): Promise<PanelLookup> {
  let outcome: RemnawaveStrictOutcome<RemnawavePanelUserList>;
  try {
    outcome = await fetchAll();
  } catch {
    return { map: new Map(), reachable: false, complete: false, keyKind: 'unknown' };
  }
  if (outcome.kind !== 'ok') {
    return { map: new Map(), reachable: false, complete: false, keyKind: 'unknown' };
  }

  const map = new Map<string, RemnawavePanelUser>();
  let numeric = 0;
  for (const user of outcome.value.users) {
    if (typeof user.uuid === 'string' && user.uuid.length > 0) {
      map.set(user.uuid, user);
      if (looksNumeric(user.uuid)) numeric += 1;
    }
  }
  const keyKind: PanelLookup['keyKind'] =
    map.size === 0 ? 'unknown' : numeric === map.size ? 'id' : numeric === 0 ? 'uuid' : 'mixed';
  // `!== false` rather than a bare read: a hand-built list (a test double, a
  // producer written before the flag existed) carries no `complete`, and the
  // adapter — the only real producer — always sets it, so absence means "not
  // truncated" and never silently switches the whole overlay into per-UUID mode.
  return { map, reachable: true, complete: outcome.value.complete !== false, keyKind };
}

/**
 * The second half of a per-UUID confirmation: the read that may PROVE absence.
 *
 * Separate from `fetchOne` because the two answer different questions and only
 * one of them can be trusted with a destructive verdict. `fetchOne` is the
 * best-effort profile read (`getPanelUser`) — it returns the full panel shape
 * the overlay needs, but it is `try { … } catch { return null }`, so its `null`
 * means "gone" AND "outage" AND "expired token" AND "401" AND "5xx" AND
 * "timeout" AND "integration not configured". `confirmAbsence` is a STRICT read
 * whose outcomes stay apart, so `notFound` (HTTP 404) — and nothing else — may
 * be read as "the panel really does not have this profile".
 *
 * Required, not optional: the only way to reach the EXPIRED verdict from a miss
 * is to hand in something that can prove it. A future importer that forgets to
 * wire this cannot compile, let alone quietly expire a paying customer.
 */
export interface PanelAbsenceProbe {
  /** Strict per-UUID read; only its `notFound` may mean "gone". */
  readonly confirmAbsence: (uuid: string) => Promise<RemnawaveStrictOutcome<unknown>>;
  /**
   * Called once per subscription whose panel state could NOT be settled, with
   * a one-line reason. A degrade nobody can see in the log is how this defect
   * class kept coming back: the run reports success either way.
   */
  readonly onUnconfirmed: (uuid: string, reason: string) => void;
}

/**
 * Resolve one subscription's live panel profile + whether we actually KNOW its
 * panel state:
 *   • bulk map hit                         → { panel, known: true }
 *   • miss on a COMPLETE bulk map          → { panel: null, known: true } (gone)
 *   • miss on an INCOMPLETE map            → targeted `fetchOne(uuid)`:
 *       – a profile came back              → { panel, known: true } (overlay it)
 *       – nothing came back, and a strict
 *         read says `notFound`             → { panel: null, known: true } (gone)
 *       – nothing came back, unconfirmed   → { panel: null, known: false } + log
 *   • panel unreachable / lookup failed    → { panel: null, known: false } (keep backup)
 *
 * `known === false` means "couldn't determine" → callers must keep the backup
 * value rather than expiring a subscription on incomplete information.
 *
 * The `fetchOne` branch is the live path for every panel bigger than the
 * adapter's page budget — it is what lets a truncated read keep overlaying live
 * state instead of the import silently keeping stale values for the whole run.
 * It is also, for exactly the same reason, the branch that can DESTROY: this
 * function's `known: true` is what `reconcileMissingPanelStatus` turns into
 * EXPIRED, and stealthnet hands it a hardcoded ACTIVE, so an unproven miss
 * expires unconditionally. Reading the best-effort `fetchOne`'s `null` as proof
 * therefore made one flaky per-UUID call — a 502, a token that lapsed mid-run,
 * a rate limit — write EXPIRED onto a live paying customer, and the run still
 * reported success. So the `null` is now only a QUESTION; `confirmAbsence`
 * answers it, and anything short of `notFound` leaves the subscription unknown
 * and the backup value in place.
 *
 * Order matters: `fetchOne` runs FIRST and a hit ends it. On a truncated panel
 * the misses are dominated by users living past the page ceiling — users who
 * DO exist — so confirming first would buy nothing and cost every one of them a
 * second round trip. A healthy 2.7.4/2.8.0 run makes exactly the calls it made
 * before; only the path that used to lose data pays for the extra read.
 */
export async function resolvePanelProfile(
  uuid: string,
  lookup: PanelLookup,
  fetchOne: (uuid: string) => Promise<RemnawavePanelUser | null>,
  probe: PanelAbsenceProbe,
): Promise<{ panel: RemnawavePanelUser | null; known: boolean }> {
  if (!lookup.reachable) return { panel: null, known: false };
  const hit = lookup.map.get(uuid);
  if (hit !== undefined) return { panel: hit, known: true };

  // A miss only means "gone" if this key could have been in the map at all.
  // After a 2.x → 3.x panel upgrade the rows are keyed by numeric id while the
  // stored identifiers are still 2.x uuids, so EVERY lookup misses — and a
  // `complete` list would turn that into "the panel proves it is gone" for the
  // whole customer base at once. Namespace mismatch is not evidence; fall
  // through to the per-profile confirmation, which addresses the profile
  // properly and can actually prove absence.
  const keysCouldMatch =
    lookup.keyKind === 'mixed' ||
    lookup.keyKind === 'unknown' ||
    (lookup.keyKind === 'id') === looksNumeric(uuid);
  if (!keysCouldMatch) {
    probe.onUnconfirmed(
      uuid,
      `panel list is keyed by ${lookup.keyKind}, this identifier is not — a miss proves nothing`,
    );
    return { panel: null, known: false };
  }

  if (lookup.complete) return { panel: null, known: true };

  let profile: RemnawavePanelUser | null;
  try {
    profile = await fetchOne(uuid);
  } catch (err: unknown) {
    probe.onUnconfirmed(uuid, `per-UUID panel read threw: ${errorText(err)}`);
    return { panel: null, known: false };
  }
  // A profile came back: the panel served it, so it is a real hit — overlay it.
  if (profile !== null) return { panel: profile, known: true };

  // Nothing came back. That is the ambiguous answer, so ask the strict reader.
  let outcome: RemnawaveStrictOutcome<unknown>;
  try {
    outcome = await probe.confirmAbsence(uuid);
  } catch (err: unknown) {
    probe.onUnconfirmed(uuid, `absence confirmation threw: ${errorText(err)}`);
    return { panel: null, known: false };
  }
  // The one outcome that proves the profile is gone. Unchanged verdict: the
  // caller expires a still-live backup row exactly as it did before.
  if (outcome.kind === 'notFound') return { panel: null, known: true };
  probe.onUnconfirmed(
    uuid,
    outcome.kind === 'ok'
      ? 'the panel still HAS this profile but the overlay read returned nothing'
      : `absence unconfirmed: ${describeStrictOutcome(outcome)}`,
  );
  return { panel: null, known: false };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}
