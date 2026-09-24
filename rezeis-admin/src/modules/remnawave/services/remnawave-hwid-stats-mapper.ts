/**
 * Which client apps the panel's devices run, summed across platforms.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `/api/hwid/devices/stats` NESTS the per-app counts: every `byPlatform` entry
 * carries its own `byApp`, and there is no top-level list at all (the 3.3.2
 * and 3.4.3 specs, and every 3.x contract through 3.4.4). The sum across
 * platforms is what the dashboard needs, and nothing upstream computes it.
 *
 * The top-level `byApp` 2.7.x sent instead is not read: no supported panel
 * sends it.
 *
 * ── What is counted ─────────────────────────────────────────────────────────
 *
 * DEVICES, not subscription fetches. The request-history endpoint has a
 * `byParsedApp` of its own, but it counts requests, so an app that refreshes
 * hourly outweighs one that refreshes daily twenty-four to one. A device is
 * counted once. The price, which the screen states: a client that sends no
 * HWID is not a device here at all.
 *
 * Names are merged case-insensitively (the first spelling seen is kept), a
 * blank name becomes the empty string so the screen can label it instead of
 * dropping it, and anything that is not a positive finite count is ignored
 * rather than trusted.
 */
export interface HwidAppCount {
  readonly app: string;
  readonly count: number;
}

export function summariseHwidApps(raw: unknown): HwidAppCount[] {
  const root = asRecord(raw);
  if (root === null) return [];

  const platforms = Array.isArray(root['byPlatform']) ? root['byPlatform'] : [];
  const source = platforms
    .map((platform) => asRecord(platform)?.['byApp'])
    .filter((list): list is unknown[] => Array.isArray(list))
    .reduce<unknown[]>((all, list) => all.concat(list), []);

  const byKey = new Map<string, { app: string; count: number }>();
  for (const entry of source) {
    const row = asRecord(entry);
    if (row === null) continue;
    const count = row['count'];
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue;
    const app = typeof row['app'] === 'string' ? row['app'].trim() : '';
    const key = app.toLowerCase();
    const existing = byKey.get(key);
    if (existing) existing.count += count;
    else byKey.set(key, { app, count });
  }

  // By count, then by name: two loads of the same numbers must draw the same
  // ring, or the chart reads as if the data were moving.
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.app.localeCompare(b.app));
}

/**
 * The stats object with `apps` added beside what Remnawave sent. Anything that
 * is not an object comes back untouched, so a panel that answers `null` still
 * answers `null` — the screen already treats that as "unavailable".
 */
export function withHwidApps<T>(raw: T): T {
  const root = asRecord(raw);
  if (root === null) return raw;
  return { ...root, apps: summariseHwidApps(root) } as T;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
