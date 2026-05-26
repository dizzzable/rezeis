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
 * Everything beyond the counters and identifying fields is dropped — the
 * raw `inbounds[*].rawInbound` block alone is several KB per squad and
 * surfacing it through the admin API would leak panel internals (raw Reality
 * keys, public/private keypairs).
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
