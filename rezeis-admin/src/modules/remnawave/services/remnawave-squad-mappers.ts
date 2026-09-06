import {
  RemnawaveExternalSquadDetailInterface,
  RemnawaveInternalSquadDetailInterface,
} from '../interfaces/remnawave-squad-detail.interface';

/**
 * Mappers for `/api/internal-squads` and `/api/external-squads` Remnawave
 * payloads → flat detail rows used by the admin Remnawave page.
 *
 * Both upstream endpoints wrap the actual list inside a `response` envelope
 * (`{ response: { total, internalSquads | externalSquads } }`) and inject
 * an `info` sub-object with the counters Remnawave's own UI shows. We
 * tolerate older panels where `info` is missing (counters fall back to 0).
 *
 * Everything beyond the counters, the identifying fields and each inbound's
 * UUID is dropped — the raw `inbounds[*].rawInbound` block alone is several KB
 * per squad and surfacing it through the admin API would leak panel internals
 * (raw Reality keys, public/private keypairs).
 *
 * The UUID is the one field taken, and it is taken deliberately: it is the only
 * link from a subscriber's squad to the hosts they can reach, because a host
 * names its inbound in `configProfileInboundUuid` and names nothing else about
 * where it belongs. It is an opaque identifier — it carries no key, no address
 * and no protocol setting. `extractInboundUuids` below reads that field and
 * refuses to walk any further into the row on purpose; widening it to take the
 * whole inbound would put the keypairs one spread operator away from a
 * customer-facing response.
 */

interface RawSquadList {
  readonly response?: {
    readonly internalSquads?: readonly RawInternalSquad[];
    readonly externalSquads?: readonly RawExternalSquad[];
  };
}

interface RawInternalSquad {
  readonly uuid?: unknown;
  readonly name?: unknown;
  readonly viewPosition?: unknown;
  readonly info?: {
    readonly membersCount?: unknown;
    readonly inboundsCount?: unknown;
  };
  readonly inbounds?: readonly unknown[];
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
}

interface RawExternalSquad {
  readonly uuid?: unknown;
  readonly name?: unknown;
  readonly viewPosition?: unknown;
  readonly info?: {
    readonly membersCount?: unknown;
  };
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
}

export function mapInternalSquadDetails(
  payload: unknown,
): readonly RemnawaveInternalSquadDetailInterface[] {
  const list = (payload as RawSquadList | null)?.response?.internalSquads ?? [];
  return list.map((squad) => ({
    uuid: toString(squad.uuid),
    name: toString(squad.name),
    viewPosition: toNumber(squad.viewPosition),
    // Newer panels carry counters under `info`. Older builds (and our own
    // option-shape mapper used by Plans) drop the block — fall back to the
    // length of the inbounds array as a best-effort approximation, otherwise 0.
    membersCount: toNumber(squad.info?.membersCount),
    inboundsCount:
      toNumber(squad.info?.inboundsCount) ||
      (Array.isArray(squad.inbounds) ? squad.inbounds.length : 0),
    inboundUuids: extractInboundUuids(squad.inbounds),
    createdAt: toIsoString(squad.createdAt),
    updatedAt: toIsoString(squad.updatedAt),
  }));
}

export function mapExternalSquadDetails(
  payload: unknown,
): readonly RemnawaveExternalSquadDetailInterface[] {
  const list = (payload as RawSquadList | null)?.response?.externalSquads ?? [];
  return list.map((squad) => ({
    uuid: toString(squad.uuid),
    name: toString(squad.name),
    viewPosition: toNumber(squad.viewPosition),
    membersCount: toNumber(squad.info?.membersCount),
    createdAt: toIsoString(squad.createdAt),
    updatedAt: toIsoString(squad.updatedAt),
  }));
}

/**
 * Reads `uuid` off each inbound and stops there.
 *
 * Written as an explicit field read rather than a pick or an omit: a pick list
 * that later gains a field, or an omit list that fails to gain one, both end
 * with `rawInbound` on the wire. Here the only way to widen it is to write
 * another line, which a reviewer sees.
 */
function extractInboundUuids(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const uuids: string[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const uuid = (entry as Record<string, unknown>)['uuid'];
    if (typeof uuid === 'string' && uuid.length > 0) uuids.push(uuid);
  }
  return uuids;
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toIsoString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return '';
}
