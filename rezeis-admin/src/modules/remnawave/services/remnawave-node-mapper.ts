import { RemnawaveNodeInterface } from '../interfaces/remnawave-node.interface';

/**
 * Maps a raw `/api/nodes` row to `RemnawaveNodeInterface`.
 *
 * Tolerates two distinct upstream layouts seen across Remnawave versions:
 *
 *   • 2.7.x and earlier: `activeConfigProfileUuid` is nested inside a
 *     `configProfile` block; counters like `xrayUptime` and `usersOnline`
 *     are not exposed on `/api/nodes` at all (the Remnawave UI fetches them
 *     from a separate realtime endpoint).
 *
 *   • 2.8+ (newer panels): the same fields surface at the top level.
 *
 * Everything that's missing falls back to neutral defaults (0 for counters,
 * null for ids), so the admin SPA always sees a uniform shape regardless of
 * the live panel version.
 */

interface RawNode {
  readonly uuid?: unknown;
  readonly name?: unknown;
  readonly address?: unknown;
  readonly port?: unknown;
  readonly isConnected?: unknown;
  readonly isDisabled?: unknown;
  readonly isConnecting?: unknown;
  readonly isTrafficTrackingActive?: unknown;
  readonly trafficResetDay?: unknown;
  readonly trafficLimitBytes?: unknown;
  readonly trafficUsedBytes?: unknown;
  readonly notifyPercent?: unknown;
  readonly viewPosition?: unknown;
  readonly countryCode?: unknown;
  readonly consumptionMultiplier?: unknown;
  readonly tags?: unknown;
  readonly lastStatusChange?: unknown;
  readonly lastStatusMessage?: unknown;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
  readonly xrayUptime?: unknown;
  readonly usersOnline?: unknown;
  readonly activeConfigProfileUuid?: unknown;
  readonly configProfile?: {
    readonly activeConfigProfileUuid?: unknown;
  };
}

export function mapNode(raw: unknown): RemnawaveNodeInterface {
  const r = (raw ?? {}) as RawNode;
  return {
    uuid: toString(r.uuid),
    name: toString(r.name),
    address: toString(r.address),
    port: toNullableNumber(r.port),
    isConnected: Boolean(r.isConnected),
    isDisabled: Boolean(r.isDisabled),
    isConnecting: Boolean(r.isConnecting),
    isTrafficTrackingActive: Boolean(r.isTrafficTrackingActive),
    trafficResetDay: toNullableNumber(r.trafficResetDay),
    trafficLimitBytes: toNullableNumber(r.trafficLimitBytes),
    trafficUsedBytes: toNullableNumber(r.trafficUsedBytes),
    notifyPercent: toNullableNumber(r.notifyPercent),
    viewPosition: toNumber(r.viewPosition),
    countryCode: toString(r.countryCode),
    consumptionMultiplier: toNumber(r.consumptionMultiplier),
    tags: Array.isArray(r.tags) ? r.tags.map((t) => toString(t)) : [],
    lastStatusChange: toNullableString(r.lastStatusChange),
    lastStatusMessage: sanitizeStatusMessage(r.lastStatusMessage),
    createdAt: toString(r.createdAt),
    updatedAt: toString(r.updatedAt),
    xrayUptime: toNumber(r.xrayUptime),
    usersOnline: toNumber(r.usersOnline),
    activeConfigProfileUuid:
      toNullableString(r.activeConfigProfileUuid) ??
      toNullableString(r.configProfile?.activeConfigProfileUuid),
  };
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function sanitizeStatusMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (
    /https?:\/\//i.test(value) ||
    /(?:^|[?&\s])(token|auth|authorization|subscriptionUrl|configUrl)=/i.test(value) ||
    /\bBearer\s+\S+/i.test(value)
  ) {
    return 'REMNAWAVE_NODE_STATUS_MESSAGE_HIDDEN';
  }
  return value;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
