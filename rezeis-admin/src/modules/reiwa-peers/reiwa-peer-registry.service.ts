import { Inject, Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';

import { RawCacheService } from '../../common/cache/raw-cache.service';
import { configReportKey } from '../bot-config/config-versions/config-versions.constants';
import {
  CABINET_FLOOR_VERSION,
  CabinetView,
  capabilityRowsHostedBy,
  compareCabinetVersions,
  impliedCapabilities,
  isCabinetCapabilityId,
  isHostedBy,
  SILENT_POLL_VERSION,
  type CabinetCapabilityId,
  type CabinetCapabilityRow,
} from './cabinet-capabilities';
import { PANEL_VERSION } from './panel-capabilities';
import {
  normalizeReiwaVersion,
  readReiwaDeclaration,
  type HeaderBag,
  type ReiwaDeclaration,
} from './reiwa-client-headers';
import {
  BOOT_GRACE_MS,
  BOOT_LOOKBACK_MS,
  HEARTBEAT_LIVE_WINDOW_MS,
  isLegacyInstance,
  LEGACY_POLL_INSTANCE,
  legacyHeartbeatInstance,
  MAX_PEER_RECORDS,
  PEER_LIVE_WINDOW_MS,
  PEER_RECORD_TTL_SECONDS,
  PEER_VIEW_CACHE_MS,
  peerIndexKey,
  peerKey,
  peerSilentIndexKey,
} from './reiwa-peers.constants';

/** How the panel knows a record: the process said so, or the evidence a silent one left. */
export type ReiwaPeerSource = 'declared' | 'poll' | 'heartbeat' | 'health';

const PEER_SOURCES: readonly ReiwaPeerSource[] = ['declared', 'poll', 'heartbeat', 'health'];

/** The two surfaces the panel compares. The optional worker hosts no capability and calls neither route. */
export type PeerSurface = 'api' | 'bot';
export const PEER_SURFACES: readonly PeerSurface[] = ['api', 'bot'];

/**
 * When this process of the panel started, for its boot grace (R1-06). Nest
 * provides nothing under it, so the registry takes the time it is built; a
 * spec passes its own.
 */
export const REIWA_PEERS_STARTED_AT = Symbol('REIWA_PEERS_STARTED_AT');

/** One cabinet process, as kept under `peerKey(surface, instance)`. */
export interface ReiwaPeerRecord {
  readonly surface: PeerSurface;
  readonly instance: string;
  /** Exact for `declared`, `heartbeat` and `health`; `poll` is 0.9.7.53, the only silent version that polls. */
  readonly version: string | null;
  readonly commit: string | null;
  /** `declared` only: the registered ids it declared; `null` for a silent process. */
  readonly capabilities: readonly CabinetCapabilityId[] | null;
  /** Well-formed ids it declared that this panel does not know. */
  readonly unknownCapabilities: number;
  readonly source: ReiwaPeerSource;
  /** Epoch ms this build of the process was first seen (kept while the record lives). */
  readonly firstSeenAt: number;
  /** Epoch ms of its last poll, heartbeat or declaration. */
  readonly lastSeenAt: number;
}

/**
 * `live`: a process of the surface was seen within its window. `quiet`: seen
 * before, not lately — the last-known answer stands. `never`: nothing in 30
 * days. `unavailable`: the panel's cache could not be read, so nothing is
 * known either way.
 */
export type ReiwaSurfaceState = 'live' | 'quiet' | 'never' | 'unavailable';

export interface ReiwaSurfaceStatus {
  readonly surface: PeerSurface;
  readonly state: ReiwaSurfaceState;
  /** Every record of the surface, the most recently seen first. */
  readonly records: readonly ReiwaPeerRecord[];
  /** The records the view is built from: the ones that count now, or the last known when none does. */
  readonly basis: readonly ReiwaPeerRecord[];
  readonly view: CabinetView;
  /** The registered capabilities of the surface the view lacks: gates first, then the degraded ones. */
  readonly missing: readonly CabinetCapabilityRow[];
  /** The oldest version in the basis — the one the missing capabilities belong to. */
  readonly version: string | null;
  readonly lastSeenAt: number | null;
  /** The most ids any basis process declared that this panel does not know. */
  readonly unknownToPanel: number;
}

/** What «WEB Reiwa» reads (`GET /api/admin/reiwa-peers`). */
export interface ReiwaPeersSnapshot {
  readonly panelVersion: string;
  readonly floorVersion: string;
  readonly checkedAt: string;
  readonly surfaces: Readonly<Record<PeerSurface, ReiwaSurfaceReport>>;
}

export interface ReiwaSurfaceReport {
  readonly state: ReiwaSurfaceState;
  /** Seen and lacking something this panel expects: what the card and the top bar say. */
  readonly behind: boolean;
  readonly version: string | null;
  readonly lastSeenAt: string | null;
  /** Every basis process declared its capabilities; `false` is «сообщает версию, но не возможности». */
  readonly declared: boolean;
  readonly capabilities: readonly CabinetCapabilityId[];
  readonly missing: ReadonlyArray<Pick<CabinetCapabilityRow, 'id' | 'kind' | 'since' | 'operatorText' | 'operatorTextEn'>>;
  readonly unknownToPanel: number;
  readonly instances: ReadonlyArray<{
    readonly instance: string;
    readonly source: ReiwaPeerSource;
    readonly version: string | null;
    readonly commit: string | null;
    readonly live: boolean;
    /** In the basis — neither stale nor superseded by the process that replaced it. */
    readonly counted: boolean;
    readonly firstSeenAt: string;
    readonly lastSeenAt: string;
    readonly unknownCapabilities: number;
  }>;
}

/** A record as stored, or `null` for anything that is not one. */
export function readPeerRecord(value: unknown): ReiwaPeerRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const surface = raw['surface'];
  const source = raw['source'];
  const instance = raw['instance'];
  const lastSeenAt = raw['lastSeenAt'];
  if (surface !== 'api' && surface !== 'bot') return null;
  if (typeof source !== 'string' || !(PEER_SOURCES as readonly string[]).includes(source)) return null;
  if (typeof instance !== 'string' || instance.length === 0) return null;
  if (typeof lastSeenAt !== 'number' || !Number.isFinite(lastSeenAt)) return null;
  const firstSeenAt = raw['firstSeenAt'];
  const declared = raw['capabilities'];
  const unknown = raw['unknownCapabilities'];
  return {
    surface,
    instance,
    version: normalizeReiwaVersion(raw['version']),
    commit: typeof raw['commit'] === 'string' ? raw['commit'] : null,
    capabilities:
      source === 'declared'
        ? (Array.isArray(declared) ? declared : []).filter(
            (id): id is CabinetCapabilityId => typeof id === 'string' && isCabinetCapabilityId(id),
          )
        : null,
    unknownCapabilities: typeof unknown === 'number' && Number.isFinite(unknown) && unknown > 0 ? Math.floor(unknown) : 0,
    source: source as ReiwaPeerSource,
    firstSeenAt: typeof firstSeenAt === 'number' && Number.isFinite(firstSeenAt) ? firstSeenAt : lastSeenAt,
    lastSeenAt,
  };
}

/** A record only the hourly heartbeat (or the boot's `/health` pull) refreshes. */
function isHeartbeatLike(record: Pick<ReiwaPeerRecord, 'source'>): boolean {
  return record.source === 'heartbeat' || record.source === 'health';
}

/** Within the first ten minutes after this process of the panel started (R1-06). */
function inBootGrace(now: number, startedAt: number): boolean {
  const sinceStart = now - startedAt;
  return sinceStart >= 0 && sinceStart < BOOT_GRACE_MS;
}

/**
 * Within its window: ten minutes, or 65 for a heartbeat-only record. And, for
 * the first ten minutes after this process of the panel started (R1-06), a
 * SILENT record seen within the last day: the panel's own downtime is not the
 * cabinet going away, and a 0.9.7.53 cabinet's backed-off poll may still be
 * minutes out. A declared record needs no grace: the money gates read a
 * declaring caller's own headers.
 */
export function isLiveRecord(
  record: Pick<ReiwaPeerRecord, 'source' | 'lastSeenAt'>,
  now: number,
  startedAt = Number.NEGATIVE_INFINITY,
): boolean {
  const age = now - record.lastSeenAt;
  if (age <= (isHeartbeatLike(record) ? HEARTBEAT_LIVE_WINDOW_MS : PEER_LIVE_WINDOW_MS)) return true;
  return record.source !== 'declared' && inBootGrace(now, startedAt) && age <= BOOT_LOOKBACK_MS;
}

/**
 * The longest ago a silent record can have been seen and still count as live
 * at `now`: its longest window, or the day the boot grace reaches back. The
 * silent index is never trimmed of a record seen since (R1-19).
 */
function oldestLiveSilentSeenAt(now: number, startedAt: number): number {
  return now - (inBootGrace(now, startedAt) ? BOOT_LOOKBACK_MS : HEARTBEAT_LIVE_WINDOW_MS);
}

function isNewer(candidate: string | null, than: string | null): boolean {
  return candidate !== null && than !== null && compareCabinetVersions(candidate, than) > 0;
}

/**
 * Not refreshed since a NEWER silent record first appeared (R1-01, R1-05): the
 * same cabinet, updated in place — a 0.9.7.52 heartbeat from before a 0.9.7.53
 * cabinet's first poll or first heartbeat. A second cabinet still running the
 * older version refreshes its record, and is back in the intersection by its
 * next heartbeat.
 */
function supersededBySilent(record: ReiwaPeerRecord, silent: readonly ReiwaPeerRecord[]): boolean {
  return silent.some(
    (other) => other !== record && isNewer(other.version, record.version) && other.firstSeenAt > record.lastSeenAt,
  );
}

/**
 * Not refreshed since a DECLARING build of the surface first appeared (R1-04):
 * the same cabinet, updated to one that declares. A silent cabinet beside a
 * declaring one (production on 0.9.7.53, staging on 0.9.7.54) keeps polling,
 * so its record stays. For the panel's own view only: a silent caller's gate
 * never looks at what another process declared.
 */
function supersededByDeclared(record: ReiwaPeerRecord, declared: readonly ReiwaPeerRecord[]): boolean {
  return declared.some((other) => other.firstSeenAt > record.lastSeenAt);
}

/**
 * The silent records of one surface that count now — for a silent caller's
 * money gate (`declared: []`) and for the panel's own view:
 *
 *  1. live (`isLiveRecord`, with the boot grace);
 *  2. a heartbeat claiming 0.9.7.53 or later counts only while a silent poll
 *     of the surface is live — every such cabinet polls, so without one the
 *     claim is a rolled-back cabinet's last word (R1-05, the mirror case);
 *  3. none superseded — by a newer silent record, or by a declaring build.
 */
export function countedSilentRecords(
  records: readonly ReiwaPeerRecord[],
  now: number,
  startedAt: number,
  options: { readonly declared: readonly ReiwaPeerRecord[] },
): ReiwaPeerRecord[] {
  const live = records.filter((record) => record.source !== 'declared' && isLiveRecord(record, now, startedAt));
  const pollLive = live.some((record) => record.source === 'poll');
  const credible = live.filter(
    (record) =>
      pollLive ||
      !isHeartbeatLike(record) ||
      record.version === null ||
      compareCabinetVersions(record.version, SILENT_POLL_VERSION) < 0,
  );
  return credible.filter(
    (record) => !supersededBySilent(record, credible) && !supersededByDeclared(record, options.declared),
  );
}

/** What one record says its process can do: declared, or implied by its version — for its own surfaces only. */
export function capabilitiesOfRecord(record: ReiwaPeerRecord): readonly CabinetCapabilityId[] {
  const ids =
    record.source === 'declared'
      ? (record.capabilities ?? [])
      : impliedCapabilities(record.version ?? CABINET_FLOOR_VERSION);
  return ids.filter((id) => isHostedBy(record.surface, id));
}

function intersection(sets: ReadonlyArray<readonly CabinetCapabilityId[]>): CabinetCapabilityId[] {
  const [first, ...rest] = sets;
  if (first === undefined) return [];
  return first.filter((id) => rest.every((set) => set.includes(id)));
}

function describeRecords(records: readonly ReiwaPeerRecord[]): string {
  return records.map((record) => `${record.surface}/${record.instance} ${record.source} ${record.version ?? '?'}`).join('; ');
}

function missingFrom(surface: PeerSurface, view: CabinetView): CabinetCapabilityRow[] {
  const lacking = capabilityRowsHostedBy(surface).filter((row) => !view.can(row.id));
  return [...lacking.filter((row) => row.kind === 'gate'), ...lacking.filter((row) => row.kind !== 'gate')];
}

/**
 * A surface's status out of the records the panel holds (`null`: the cache
 * could not be read). Pure, so the rules are testable on their own:
 *
 *   counted = the live declared records + `countedSilentRecords` (declarations supersede)
 *   basis   = the counted records, or — none — every record not superseded (last known, ≤30 d)
 *   view    = ∩ over the basis of (declared ? what it declared : implied by its version)
 *   never / unavailable → the floor's implied set
 *
 * The INTERSECTION is the conservative answer for several cabinets on one
 * panel (staging and production sharing a token) and for a rolling update: a
 * behaviour the panel starts itself is turned on only when every process of
 * the surface that counts can take it.
 */
export function surfaceStatusOf(
  surface: PeerSurface,
  records: readonly ReiwaPeerRecord[] | null,
  now: number,
  startedAt = Number.NEGATIVE_INFINITY,
): ReiwaSurfaceStatus {
  if (records === null || records.every((record) => record.surface !== surface)) {
    const view =
      records === null
        ? CabinetView.floor(`the panel's cache cannot be read: the floor, Reiwa ${CABINET_FLOOR_VERSION}`)
        : CabinetView.floor(`${surface}: never seen: the floor, Reiwa ${CABINET_FLOOR_VERSION}`);
    return {
      surface,
      state: records === null ? 'unavailable' : 'never',
      records: [],
      basis: [],
      view,
      missing: missingFrom(surface, view),
      version: null,
      lastSeenAt: null,
      unknownToPanel: 0,
    };
  }
  const own = records.filter((record) => record.surface === surface).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const declared = own.filter((record) => record.source === 'declared');
  const silent = own.filter((record) => record.source !== 'declared');
  const counted = [
    ...declared.filter((record) => isLiveRecord(record, now, startedAt)),
    ...countedSilentRecords(own, now, startedAt, { declared }),
  ].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const lastKnown = own.filter(
    (record) =>
      record.source === 'declared' ||
      (!supersededBySilent(record, silent) && !supersededByDeclared(record, declared)),
  );
  const basis = counted.length > 0 ? counted : lastKnown;
  const view = CabinetView.of(
    intersection(basis.map(capabilitiesOfRecord)),
    `${counted.length > 0 ? 'live' : 'last known'}: ${describeRecords(basis)}`,
  );
  const versions = basis.map((record) => record.version).filter((version): version is string => version !== null);
  return {
    surface,
    state: counted.length > 0 ? 'live' : 'quiet',
    records: own,
    basis,
    view,
    missing: missingFrom(surface, view),
    version: versions.length === 0 ? null : versions.reduce((oldest, v) => (compareCabinetVersions(v, oldest) < 0 ? v : oldest)),
    lastSeenAt: own[0]?.lastSeenAt ?? null,
    unknownToPanel: basis.reduce((most, record) => Math.max(most, record.unknownCapabilities), 0),
  };
}

/** Seen within its record's lifetime and lacking something this panel expects. */
export function isSurfaceBehind(status: ReiwaSurfaceStatus): boolean {
  return (status.state === 'live' || status.state === 'quiet') && status.missing.length > 0;
}

/**
 * ReiwaPeerRegistry
 * ═════════════════
 * What the panel knows about the cabinet connected to it, and the one answer
 * every gate asks: can the cabinet do this?
 *
 * ── Two kinds of answer ───────────────────────────────────────────────────
 *
 *  - `viewOfRequest(headers)` — for a MONEY gate. The caller's own headers,
 *    exact per caller, no storage: a cabinet that declares is judged by what
 *    it declared on this very request. A silent caller is judged by the silent
 *    evidence of its surface that counts (`countedSilentRecords`) — never by
 *    what another, declaring process said — and without any, by the floor.
 *  - `view(surface)` — for behaviour the panel starts itself (a notification,
 *    the operator page, the card): the intersection over the processes of the
 *    surface that count, from the records below; cached 15 s per process.
 *
 * ── Recording, only where the cabinet calls anyway ────────────────────────
 *
 * Not in `InternalAdminAuthGuard`: callers without the headers are not all
 * cabinets — rezeis-subpage and an operator's own API-token scripts call too,
 * and "a call without headers means an old cabinet is present" would hold
 * features back for ever. The cabinet's two periodic calls are the evidence:
 * the settings poll (`observePoll`, every ~20 s per process, api and bot) and
 * the version heartbeat (`observeHeartbeat`, api, at boot and hourly).
 *
 * A silent process is filed under a fixed instance: `legacy-poll-api`,
 * `legacy-poll-bot`, and one `legacy-heartbeat-api:<version>` per version
 * heard. NOTHING IS DELETED when a declaring process writes (R1-04): a record
 * another process replaced is superseded when it is READ — it was not
 * refreshed since the replacement first appeared — so a second cabinet that
 * keeps running keeps its evidence. Declared and silent records are indexed
 * apart, so no number of declaring instances pushes a silent record out
 * (R1-19). A record written after a gap longer than its window counts as first
 * seen at that write (R1-17).
 *
 * Best-effort throughout, like every record the settings delivery keeps: a
 * Redis problem is "no evidence", logged, and never fails the cabinet's call
 * or a gate — the gates then fall back to the floor, which sells nothing new.
 */
@Injectable()
export class ReiwaPeerRegistry implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReiwaPeerRegistry.name);

  /**
   * `firstSeenAt` per record key, with when this process last wrote it — so a
   * poll is one write rather than a read and a write, and a gap is still seen.
   */
  private readonly firstSeen = new Map<
    string,
    { readonly build: string; readonly at: number; readonly source: ReiwaPeerSource; readonly lastSeenAt: number }
  >();

  /** `view()`'s cache: one status per surface for {@link PEER_VIEW_CACHE_MS}. */
  private readonly statusCache = new Map<PeerSurface, { readonly at: number; readonly status: ReiwaSurfaceStatus }>();

  /** When this process started: the start of its boot grace (R1-06). */
  public readonly startedAt: number;

  public constructor(
    private readonly store: RawCacheService,
    @Optional() @Inject(REIWA_PEERS_STARTED_AT) startedAt?: number,
  ) {
    this.startedAt = startedAt ?? Date.now();
  }

  // ── Recording ──────────────────────────────────────────────────────────────

  /**
   * The settings poll (`POST /api/internal/config-versions`). A declaration
   * refreshes the process's own record; a silent poll from `consumer` (`api`
   * or `bot`, from the body) is a 0.9.7.53 process of that surface.
   */
  public async observePoll(consumer: unknown, headers: HeaderBag | undefined, now: number = Date.now()): Promise<void> {
    try {
      const declaration = readReiwaDeclaration(headers);
      if (declaration !== null) {
        await this.recordDeclared(declaration, null, now);
        return;
      }
      if (consumer !== 'api' && consumer !== 'bot') return;
      await this.recordSilent(consumer, LEGACY_POLL_INSTANCE[consumer], 'poll', SILENT_POLL_VERSION, now);
    } catch (err: unknown) {
      this.logger.warn(`Could not record the cabinet's poll: ${describe(err)}`);
    }
  }

  /**
   * The version heartbeat (`POST /api/internal/system/reiwa-version`), sent by
   * reiwa-api only. With the headers it only refreshes the declared record and
   * files no silent one; without them it names its exact version, filed under
   * that version (R1-01).
   */
  public async observeHeartbeat(version: string, headers: HeaderBag | undefined, now: number = Date.now()): Promise<void> {
    try {
      const reported = normalizeReiwaVersion(version);
      const declaration = readReiwaDeclaration(headers);
      if (declaration !== null) {
        await this.recordDeclared(declaration, reported, now);
        return;
      }
      if (reported === null) return;
      await this.recordSilent('api', legacyHeartbeatInstance(reported), 'heartbeat', reported, now);
    } catch (err: unknown) {
      this.logger.warn(`Could not record the cabinet's heartbeat: ${describe(err)}`);
    }
  }

  /**
   * reiwa's public `/health`, pulled by the update checker when it knows no
   * version at all — right after the panel's first boot on this release. Filed
   * as a heartbeat would be, and only while nothing is known about the api
   * surface: it never overwrites what the cabinet itself said.
   */
  public async observeHealth(version: string, now: number = Date.now()): Promise<void> {
    try {
      const reported = normalizeReiwaVersion(version);
      if (reported === null) return;
      const records = await this.readSurfaceRecords('api');
      if (records === null || records.length > 0) return;
      await this.recordSilent('api', legacyHeartbeatInstance(reported), 'health', reported, now);
    } catch (err: unknown) {
      this.logger.warn(`Could not record reiwa's /health version: ${describe(err)}`);
    }
  }

  /**
   * The first boot of this release. The panel that ran before it kept each
   * polling process's last report (`ConfigDeliveryState`, 1 h), and a report is
   * exactly the evidence a silent poll leaves — so a surface with no record yet
   * takes it as a `legacy-poll-*` record, stamped with the report's own time.
   * Without it a 0.9.7.53 cabinet, the one in every "panel first" gap, would
   * be judged by the floor until its first poll here. The boot grace
   * (`isLiveRecord`) then counts it however long the update took, within a
   * day. A record is only ever ADDED for a surface that has none, so this never
   * undoes what a poll already said.
   *
   * `false` when the cache could not be read, so the boot retries.
   */
  public async adoptPollReports(now: number = Date.now()): Promise<boolean> {
    for (const surface of PEER_SURFACES) {
      const records = await this.readSurfaceRecords(surface);
      if (records === null) return false;
      if (records.length > 0) continue;
      const report = await this.store.get<{ readonly reportedAt?: unknown }>(configReportKey(surface));
      const reportedAt = report?.reportedAt;
      if (typeof reportedAt !== 'number' || !Number.isFinite(reportedAt) || reportedAt > now) continue;
      if (now - reportedAt > BOOT_LOOKBACK_MS) continue;
      await this.recordSilent(surface, LEGACY_POLL_INSTANCE[surface], 'poll', SILENT_POLL_VERSION, reportedAt);
      this.logger.log(`Took the ${surface} poll report of the previous panel as a silent Reiwa ${SILENT_POLL_VERSION}`);
    }
    return true;
  }

  /** Runs {@link adoptPollReports} once, retrying a few times while the cache is still connecting. */
  public onApplicationBootstrap(): void {
    const delays = [0, 2_000, 5_000, 10_000, 20_000];
    const attempt = (index: number): void => {
      const delay = delays[index];
      if (delay === undefined) return;
      const timer = setTimeout(() => {
        this.adoptPollReports()
          .then((done) => {
            if (!done) attempt(index + 1);
          })
          .catch((err: unknown) => this.logger.warn(`Could not adopt the previous poll reports: ${describe(err)}`));
      }, delay);
      timer.unref?.();
    };
    attempt(0);
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  /**
   * What THIS caller can do — for a money gate. A declaring caller is judged by
   * the headers of the request itself; a silent one by the silent evidence of
   * `surface` (the surface the route serves) that counts, whatever other,
   * declaring processes said; and without any, by the floor. Never throws.
   */
  public async viewOfRequest(headers: HeaderBag | undefined, surface: PeerSurface, now: number = Date.now()): Promise<CabinetView> {
    const declaration = readReiwaDeclaration(headers);
    if (declaration !== null) {
      return CabinetView.of(
        declaration.capabilities,
        `declared by ${declaration.surface ?? 'an unknown surface'}/${declaration.instance} ${declaration.version ?? '?'}`,
      );
    }
    try {
      const records = await this.readSurfaceRecords(surface);
      if (records === null) {
        return CabinetView.floor(`silent ${surface} caller, records unreadable: the floor, Reiwa ${CABINET_FLOOR_VERSION}`);
      }
      const counted = countedSilentRecords(records, now, this.startedAt, { declared: [] });
      if (counted.length === 0) {
        return CabinetView.floor(`silent ${surface} caller, no live evidence: the floor, Reiwa ${CABINET_FLOOR_VERSION}`);
      }
      return CabinetView.of(intersection(counted.map(capabilitiesOfRecord)), `silent ${surface} caller: ${describeRecords(counted)}`);
    } catch (err: unknown) {
      this.logger.warn(`Could not read the silent cabinet's records: ${describe(err)}`);
      return CabinetView.floor(`silent ${surface} caller, records unreadable: the floor, Reiwa ${CABINET_FLOOR_VERSION}`);
    }
  }

  /**
   * What a surface can do — for behaviour the panel starts itself. `web` is
   * what reiwa-api declares for the SPA it serves. Cached 15 s. Never throws.
   */
  public async view(surface: 'web' | PeerSurface, now: number = Date.now()): Promise<CabinetView> {
    return (await this.cachedStatus(surface === 'bot' ? 'bot' : 'api', now)).view;
  }

  /**
   * {@link view}, or `null` when the panel does not know the surface — never
   * heard from, or its records unreadable. For an answer that is WRITTEN DOWN
   * (R1-08): the floor stands in for "unknown" at a gate, but recorded in a
   * notice it would outlast the moment it was true.
   */
  public async knownView(surface: 'web' | PeerSurface, now: number = Date.now()): Promise<CabinetView | null> {
    const status = await this.cachedStatus(surface === 'bot' ? 'bot' : 'api', now);
    return status.state === 'live' || status.state === 'quiet' ? status.view : null;
  }

  /** The surfaces that are behind this panel, from the cached statuses — the top bar's line. */
  public async behindSurfaces(now: number = Date.now()): Promise<readonly PeerSurface[]> {
    const statuses = await Promise.all(PEER_SURFACES.map((surface) => this.cachedStatus(surface, now)));
    return statuses.filter(isSurfaceBehind).map((status) => status.surface);
  }

  /** A surface's status, read now (the card's sweep; the page reads `snapshot`). Never throws. */
  public async surfaceStatus(surface: PeerSurface, now: number = Date.now()): Promise<ReiwaSurfaceStatus> {
    return surfaceStatusOf(surface, await this.readSurfaceRecordsSafely(surface), now, this.startedAt);
  }

  /**
   * The running version of a surface, for the update checker: of the records
   * that count (or, none counting, the last known) the most recently seen one
   * that knows its version exactly, else the poll's 0.9.7.53. `null` when
   * nothing is known. Never throws.
   */
  public async runningVersion(surface: PeerSurface, now: number = Date.now()): Promise<string | null> {
    const status = await this.surfaceStatus(surface, now);
    const exact = status.basis.find((record) => record.source !== 'poll' && record.version !== null);
    return exact?.version ?? status.basis.find((record) => record.version !== null)?.version ?? null;
  }

  /** Everything «WEB Reiwa» shows. Read now, never cached. */
  public async snapshot(now: number = Date.now()): Promise<ReiwaPeersSnapshot> {
    const report = async (surface: PeerSurface): Promise<ReiwaSurfaceReport> => {
      const status = await this.surfaceStatus(surface, now);
      const counted = new Set(status.basis);
      return {
        state: status.state,
        behind: isSurfaceBehind(status),
        version: status.version,
        lastSeenAt: status.lastSeenAt === null ? null : new Date(status.lastSeenAt).toISOString(),
        declared: status.basis.length > 0 && status.basis.every((record) => record.source === 'declared'),
        capabilities: status.view.capabilities.filter((id) => isHostedBy(surface, id)),
        missing: status.missing.map(({ id, kind, since, operatorText, operatorTextEn }) => ({
          id,
          kind,
          since,
          operatorText,
          operatorTextEn,
        })),
        unknownToPanel: status.unknownToPanel,
        instances: status.records.map((record) => ({
          instance: record.instance,
          source: record.source,
          version: record.version,
          commit: record.commit,
          live: isLiveRecord(record, now, this.startedAt),
          counted: counted.has(record),
          firstSeenAt: new Date(record.firstSeenAt).toISOString(),
          lastSeenAt: new Date(record.lastSeenAt).toISOString(),
          unknownCapabilities: record.unknownCapabilities,
        })),
      };
    };
    const [api, bot] = await Promise.all([report('api'), report('bot')]);
    return {
      panelVersion: PANEL_VERSION,
      floorVersion: CABINET_FLOOR_VERSION,
      checkedAt: new Date(now).toISOString(),
      surfaces: { api, bot },
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async recordDeclared(declaration: ReiwaDeclaration, reportedVersion: string | null, now: number): Promise<void> {
    const surface = declaration.surface;
    // A surface this panel does not know vouches for nothing, and the worker
    // hosts no capability and calls neither route: nothing to file.
    if (surface !== 'api' && surface !== 'bot') return;
    const version = declaration.version ?? reportedVersion;
    // Only its own record is written. The silent records of the surface stay
    // (R1-04): if this build replaced a silent cabinet, the read sees they were
    // not refreshed since it first appeared; if another cabinet is still
    // silent beside it, they are that cabinet's evidence.
    await this.write({
      surface,
      instance: declaration.instance,
      version,
      commit: declaration.commit,
      capabilities: declaration.capabilities,
      unknownCapabilities: declaration.unknownCapabilities,
      source: 'declared',
      firstSeenAt: await this.firstSeenAt(peerKey(surface, declaration.instance), 'declared', version, declaration.commit, now),
      lastSeenAt: now,
    });
  }

  private async recordSilent(
    surface: PeerSurface,
    instance: string,
    source: Exclude<ReiwaPeerSource, 'declared'>,
    version: string,
    seenAt: number,
  ): Promise<void> {
    await this.write({
      surface,
      instance,
      version,
      commit: null,
      capabilities: null,
      unknownCapabilities: 0,
      source,
      firstSeenAt: await this.firstSeenAt(peerKey(surface, instance), source, version, null, seenAt),
      lastSeenAt: seenAt,
    });
  }

  /**
   * The record, and its place in its surface's index (R1-07). A declared record
   * goes to the declared index, trimmed to the newest {@link MAX_PEER_RECORDS}
   * with the records dropped; a silent one to the silent index, where the trim
   * never drops a record that can still count as live (R1-19). So however many
   * instances a token holder makes up, they only ever push out each other, and
   * a silent cabinet's evidence goes only by its window.
   */
  private async write(record: ReiwaPeerRecord): Promise<void> {
    await this.store.set(peerKey(record.surface, record.instance), record, PEER_RECORD_TTL_SECONDS);
    const options = { cap: MAX_PEER_RECORDS, ttlSeconds: PEER_RECORD_TTL_SECONDS };
    const dropped =
      record.source === 'declared'
        ? await this.store.sortedIndexAdd(peerIndexKey(record.surface), record.instance, record.lastSeenAt, options)
        : await this.store.sortedIndexAdd(peerSilentIndexKey(record.surface), record.instance, record.lastSeenAt, {
            ...options,
            keepFrom: oldestLiveSilentSeenAt(record.lastSeenAt, this.startedAt),
          });
    // A silent entry left in the declared index by an earlier build of this
    // branch is dropped from it, never deleted: its record is the silent index's.
    const gone = dropped.filter((instance) => record.source !== 'declared' || !isLegacyInstance(instance));
    if (gone.length > 0) await this.store.delMany(gone.map((instance) => peerKey(record.surface, instance)));
  }

  /**
   * When this build of the process was first seen: kept across its refreshes,
   * started again by a new version or commit — and by a GAP (review R1-17): a
   * record written after it was not live, by its own window without the boot
   * grace, is a process that appeared again now. Kept across a gap, a cabinet
   * updated, rolled back and updated again within the record's 30 days kept its
   * first period's time, so the rolled-back version's heartbeats, newer than
   * that, were not superseded for up to 65 minutes after the re-update.
   */
  private async firstSeenAt(
    key: string,
    source: ReiwaPeerSource,
    version: string | null,
    commit: string | null,
    now: number,
  ): Promise<number> {
    const build = `${version ?? ''}@${commit ?? ''}`;
    const memo = this.firstSeen.get(key);
    let at: number;
    if (memo !== undefined && memo.build === build && isLiveRecord(memo, now)) {
      at = memo.at;
    } else {
      // Not in memory, or a gap in what this process saw: the stored record says
      // (another process of the panel may have written it meanwhile).
      const stored = readPeerRecord(await this.store.get<unknown>(key));
      const same = stored !== null && stored.version === version && stored.commit === commit;
      at = same && isLiveRecord(stored, now) ? stored.firstSeenAt : now;
    }
    if (this.firstSeen.size >= 64) this.firstSeen.clear();
    this.firstSeen.set(key, { build, at, source, lastSeenAt: now });
    return at;
  }

  private async cachedStatus(surface: PeerSurface, now: number): Promise<ReiwaSurfaceStatus> {
    const cached = this.statusCache.get(surface);
    if (cached !== undefined && now >= cached.at && now - cached.at < PEER_VIEW_CACHE_MS) return cached.status;
    const status = await this.surfaceStatus(surface, now);
    this.statusCache.set(surface, { at: now, status });
    return status;
  }

  /**
   * The newest {@link MAX_PEER_RECORDS} records of each of a surface's two
   * indexes, declared and silent, or `null` when the cache cannot be read.
   * Throws a command error.
   */
  private async readSurfaceRecords(surface: PeerSurface): Promise<ReiwaPeerRecord[] | null> {
    const silent = await this.store.sortedIndexNewest(peerSilentIndexKey(surface), MAX_PEER_RECORDS);
    if (silent === null) return null;
    const declared = await this.store.sortedIndexNewest(peerIndexKey(surface), MAX_PEER_RECORDS);
    if (declared === null) return null;
    const instances = [...new Set([...silent, ...declared])];
    const values = await this.store.getMany<unknown>(instances.map((instance) => peerKey(surface, instance)));
    if (values === null) return null;
    return values
      .map(readPeerRecord)
      .filter((record): record is ReiwaPeerRecord => record !== null && record.surface === surface);
  }

  private async readSurfaceRecordsSafely(surface: PeerSurface): Promise<ReiwaPeerRecord[] | null> {
    try {
      return await this.readSurfaceRecords(surface);
    } catch (err: unknown) {
      this.logger.warn(`Could not read the cabinet's ${surface} records: ${describe(err)}`);
      return null;
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
