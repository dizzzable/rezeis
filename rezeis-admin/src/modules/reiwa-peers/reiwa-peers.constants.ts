import type { ReiwaProcessSurface } from './cabinet-capabilities';

/**
 * Where the panel keeps what it knows about the cabinet: its own Valkey, which
 * writes an append-only file to a volume (`docker-compose.yml`), so a record
 * outlives a panel restart and a host reboot. No table, no migration.
 *
 * The prefix carries the SHAPE number: a record written by one build is read by
 * the next, so a change of what is stored is a new number, never a new meaning
 * under the old one. `v2` (review R1, 26.09.2026): silent heartbeats are filed
 * per version, and each surface has an index of its declared records and one
 * of its silent records.
 */
const PREFIX = 'rezeis:reiwa-peers:v2';

/** One cabinet process: `<surface>:<instance>`. */
export function peerKey(surface: ReiwaProcessSurface, instance: string): string {
  return `${PREFIX}:peer:${surface}:${instance}`;
}

/**
 * The DECLARED records of a surface, newest first: a sorted set of instances
 * scored by when each was last seen. Every write adds to it; a read takes the
 * newest {@link MAX_PEER_RECORDS}; past that, the oldest are dropped together
 * with their records. So however many instance names arrive — a platform that
 * gives every deployment a new container hostname, or a token holder making
 * them up — a live process is always among what is read, and the key space
 * stays bounded.
 */
export function peerIndexKey(surface: ReiwaProcessSurface): string {
  return `${PREFIX}:index:${surface}`;
}

/**
 * The SILENT records of a surface (`legacy-*`), apart from the declared ones
 * (review R1-19): made-up declaring instances push out only each other, never a
 * silent cabinet's evidence. Past {@link MAX_PEER_RECORDS} the oldest are
 * dropped with their records too, but never one that can still count as live —
 * a silent record goes only by its window.
 */
export function peerSilentIndexKey(surface: ReiwaProcessSurface): string {
  return `${PREFIX}:index:${surface}:silent`;
}

/**
 * At most this many records per index of a surface — more only in the silent
 * one, while they are live. A real cabinet has one or two, and a silent one a
 * version or two.
 */
export const MAX_PEER_RECORDS = 32;

/** How long a process record is kept after it was last refreshed: «последний раз на связи». */
export const PEER_RECORD_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * The fixed instances a SILENT cabinet (up to 0.9.7.53) is filed under — it
 * names none. A poll without headers is 0.9.7.53, the only silent version that
 * polls, so one record per surface holds it.
 */
export const LEGACY_POLL_INSTANCE = {
  api: 'legacy-poll-api',
  bot: 'legacy-poll-bot',
} as const satisfies Readonly<Record<'api' | 'bot', string>>;

/**
 * A silent heartbeat names its exact version, and each version is its OWN
 * record (review R1-01): two silent cabinets on one panel — 0.9.7.53 and
 * 0.9.7.52 — no longer overwrite each other's evidence, so the older one keeps
 * the gate closed for a silent caller instead of the last heartbeat deciding.
 */
export const LEGACY_HEARTBEAT_PREFIX = 'legacy-heartbeat-api';

export function legacyHeartbeatInstance(version: string): string {
  return `${LEGACY_HEARTBEAT_PREFIX}:${version}`;
}

/** A record the panel filed for a silent cabinet, not one a cabinet declared. */
export function isLegacyInstance(instance: string): boolean {
  return instance.startsWith('legacy-');
}

/**
 * A process counts as LIVE for this long after it was last seen. It polls every
 * ~20 s, and after failures its wait doubles up to five minutes (reiwa
 * `CONFIG_VERSION_POLL_MAX_BACKOFF_MS`), so ten minutes still counts a live
 * process sitting in its longest backoff — and a process that was stopped
 * drops out of the view ten minutes after its last poll at most.
 */
export const PEER_LIVE_WINDOW_MS = 10 * 60_000;

/** The heartbeat is hourly: a record only a heartbeat refreshes is live for 65 minutes. */
export const HEARTBEAT_LIVE_WINDOW_MS = 65 * 60_000;

/**
 * THE PANEL'S OWN RESTART (review R1-06). The live window counts the cabinet's
 * backoff, not the time the panel itself was down: after an outage longer
 * than the window, a 0.9.7.53 cabinet's records are all stale until its
 * backed-off poll lands — up to five more minutes of «до сброса» withheld. So
 * for the first {@link BOOT_GRACE_MS} after a process of this panel starts, a
 * silent record seen within {@link BOOT_LOOKBACK_MS} counts as live. The same
 * reach is what the first boot's adoption of the previous panel's poll report
 * takes (`adoptPollReports`).
 */
export const BOOT_GRACE_MS = 10 * 60_000;
export const BOOT_LOOKBACK_MS = 24 * 60 * 60_000;

/** How long one process keeps a surface's status for behaviour the panel starts itself. */
export const PEER_VIEW_CACHE_MS = 15_000;

/**
 * «🧩 Кабинет старше панели» goes out once a surface has been behind for this
 * long — the same ten minutes as the live window, so an ordinary update gap
 * (panel first, cabinet a few minutes later) sends nothing.
 */
export const BEHIND_CARD_DEBOUNCE_MS = 10 * 60_000;

/** Only a surface seen within this long is compared at all. */
export const BEHIND_RECENT_MS = 24 * 60 * 60_000;

/** How long "this version of this surface was carded" is remembered. */
export const BEHIND_CARD_CLAIM_TTL_SECONDS = 30 * 24 * 60 * 60;

/** When a surface was first found behind, and at which version: the card's debounce. */
export function behindKey(surface: ReiwaProcessSurface): string {
  return `${PREFIX}:behind:${surface}`;
}

/** One card per surface and cabinet version (`RawCacheService.claimOnce`). */
export function behindCardKey(surface: ReiwaProcessSurface, version: string): string {
  return `${PREFIX}:behind-card:${surface}:${version}`;
}
