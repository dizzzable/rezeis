import { RemnawaveSystemStatsInterface } from '../interfaces/remnawave-system-stats.interface';

/**
 * Normalises `/api/system/stats` payloads produced by different Remnawave
 * panel versions into the shape declared by `RemnawaveSystemStatsInterface`.
 *
 * Observed upstream variations:
 *
 *   1. `onlineStats` may live at the top level of `response` (current
 *      production builds, e.g. v274) instead of nested under `users`
 *      where older panel versions kept it. The frontend always reads
 *      `stats.users.onlineStats.*`, so we always nest it.
 *
 *   2. `nodes.totalBytesLifetime` is sometimes a string because the value
 *      can exceed `Number.MAX_SAFE_INTEGER`. The internal contract is a
 *      `number` to keep the chart math simple — converting via `Number()`
 *      preserves precision up to 2^53 which is enough for petabyte-range
 *      counters.
 *
 * The function never throws on missing fields — it returns sensible zeros
 * so the admin dashboard renders without crashes when the upstream is
 * partially degraded.
 */

interface RawOnlineStats {
  readonly lastDay?: unknown;
  readonly lastWeek?: unknown;
  readonly neverOnline?: unknown;
  readonly onlineNow?: unknown;
}

interface RawUsers {
  readonly totalUsers?: unknown;
  readonly statusCounts?: unknown;
  readonly onlineStats?: RawOnlineStats;
}

interface RawNodes {
  readonly totalOnline?: unknown;
  readonly totalBytesLifetime?: unknown;
}

interface RawSystemStats {
  readonly users?: RawUsers;
  readonly onlineStats?: RawOnlineStats;
  readonly nodes?: RawNodes;
  readonly cpu?: { readonly cores?: unknown };
  readonly memory?: {
    readonly total?: unknown;
    readonly free?: unknown;
    readonly used?: unknown;
  };
  readonly uptime?: unknown;
  readonly timestamp?: unknown;
}

export function normalizeSystemStats(raw: unknown): RemnawaveSystemStatsInterface {
  const root = (raw ?? {}) as RawSystemStats;

  const rawUsers = root.users ?? {};
  // Newer Remnawave keeps `onlineStats` at the response root; older panels
  // nested it inside `users`. Either form is accepted.
  const rawOnline = rawUsers.onlineStats ?? root.onlineStats ?? {};

  const statusCounts = isPlainRecord(rawUsers.statusCounts)
    ? (rawUsers.statusCounts as Record<string, number>)
    : {};

  return {
    users: {
      totalUsers: toNumber(rawUsers.totalUsers),
      statusCounts,
      onlineStats: {
        lastDay: toNumber(rawOnline.lastDay),
        lastWeek: toNumber(rawOnline.lastWeek),
        neverOnline: toNumber(rawOnline.neverOnline),
        onlineNow: toNumber(rawOnline.onlineNow),
      },
    },
    nodes: {
      totalOnline: toNumber(root.nodes?.totalOnline),
      // Strings (BigInt-as-text) are coerced to a number; plain numbers pass
      // through. Anything else falls back to 0.
      totalBytesLifetime: toNumber(root.nodes?.totalBytesLifetime),
    },
    cpu: { cores: toNumber(root.cpu?.cores) },
    memory: {
      total: toNumber(root.memory?.total),
      free: toNumber(root.memory?.free),
      used: toNumber(root.memory?.used),
    },
    uptime: toNumber(root.uptime),
    timestamp: toNumber(root.timestamp),
  };
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
