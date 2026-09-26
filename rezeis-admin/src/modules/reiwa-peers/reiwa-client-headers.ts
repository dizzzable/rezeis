import {
  HOSTED_CAPABILITY_SURFACES,
  isCabinetCapabilityId,
  isReiwaProcessSurface,
  type CabinetCapabilityId,
  type CabinetCapabilitySurface,
  type ReiwaProcessSurface,
} from './cabinet-capabilities';

/**
 * The two headers every internal call of a Reiwa cabinet from 0.9.7.54 on
 * carries (reiwa `AdminTransport`):
 *
 *   x-reiwa-client:       surface=api; version=0.9.7.54; commit=0123456789ab; instance=reiwa
 *   x-reiwa-capabilities: web.addon-reset-end,web.lifetime-subscription,…
 *
 * HEADERS, not body fields, and that is what lets the pair update in either
 * order: the global pipe answers 400 to a body field its DTO has not learned
 * (`whitelist` + `forbidNonWhitelisted`), while an unknown header is simply not
 * read — the precedent is `x-reiwa-hint-modes` / `x-reiwa-hint-doors`
 * (`internal-user-hints.controller.ts`), whose parser shape this copies.
 *
 * ADVISORY. The bearer token already authorises the call; the headers can only
 * turn on, toward that caller, something the panel shows or sells. So the
 * request signature does not need to cover them, and nothing here ever throws:
 * a newer cabinet's header this panel cannot read is dropped, never a 400.
 */
export const REIWA_CLIENT_HEADER = 'x-reiwa-client';
export const REIWA_CAPABILITIES_HEADER = 'x-reiwa-capabilities';

/** How much of `x-reiwa-client` is read at all. */
export const CLIENT_HEADER_MAX_CHARACTERS = 256;

/**
 * How much of `x-reiwa-capabilities` is read, and how many names in it. It
 * arrives from the network, so it is bounded twice — in characters before it is
 * split, in names after. A real cabinet sends a few hundred characters.
 */
export const CAPABILITIES_HEADER_MAX_CHARACTERS = 2048;
export const CAPABILITIES_HEADER_MAX_NAMES = 64;

/** The shape of an id, whoever registered it: `<surface>.<kebab-name>[.v2…]`, at most 48 characters. */
export const CAPABILITY_ID_PATTERN = /^(web|api|bot|panel)\.[a-z0-9]+(-[a-z0-9]+)*(\.v[2-9]\d*)?$/;
export const CAPABILITY_ID_MAX_LENGTH = 48;

/** The heartbeat DTO's own version rule (`report-reiwa-version.dto.ts`). */
const VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/;
const VERSION_MAX_LENGTH = 32;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;
/** A container hostname. `legacy-*` is reserved for the panel's own records of silent cabinets. */
const INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const RESERVED_INSTANCE_PREFIX = 'legacy-';

/** The instance a declaration is filed under when it names none this panel can use. */
export const UNNAMED_INSTANCE = 'unnamed';

/** Request headers as Express hands them over (`@Headers()`): lower-case names. */
export type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>;

/** What one cabinet process said about itself on one request. */
export interface ReiwaDeclaration {
  /** `null`: the header names no surface this panel knows, so it vouches for nothing. */
  readonly surface: ReiwaProcessSurface | null;
  readonly version: string | null;
  readonly commit: string | null;
  /** The container hostname — an in-place restart replaces its own record. */
  readonly instance: string;
  /** The registered ids it declared, for the surfaces it hosts only. */
  readonly capabilities: readonly CabinetCapabilityId[];
  /** Well-formed ids of its surfaces that this panel does not know — a cabinet newer than the panel. */
  readonly unknownCapabilities: number;
}

/** One header's value, a repeated header joined. */
export function readHeader(headers: HeaderBag | undefined, name: string): string | undefined {
  const raw = headers?.[name];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.join(',');
  return undefined;
}

/** A version as the cabinet reports it, without its `v`; `null` for anything that is not one. */
export function normalizeReiwaVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > VERSION_MAX_LENGTH || !VERSION_PATTERN.test(trimmed)) return null;
  return trimmed.replace(/^v/i, '');
}

/**
 * `x-reiwa-client` as its `key=value` pairs: `surface`, `version`, `commit`,
 * `instance`. Keys are exact; the first of a repeated key wins; a value that is
 * not what its key allows reads as absent. `null` when the header is absent —
 * the caller is silent.
 */
export function parseReiwaClient(
  header: string | undefined,
): Omit<ReiwaDeclaration, 'capabilities' | 'unknownCapabilities'> | null {
  if (typeof header !== 'string') return null;
  const fields = new Map<string, string>();
  for (const pair of header.slice(0, CLIENT_HEADER_MAX_CHARACTERS).split(';')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim();
    if (!fields.has(key)) fields.set(key, pair.slice(at + 1).trim());
  }
  const surface = fields.get('surface');
  const commit = fields.get('commit')?.toLowerCase();
  const instance = fields.get('instance');
  return {
    surface: isReiwaProcessSurface(surface) ? surface : null,
    version: normalizeReiwaVersion(fields.get('version')),
    commit: commit !== undefined && COMMIT_PATTERN.test(commit) ? commit : null,
    instance:
      instance !== undefined && INSTANCE_PATTERN.test(instance) && !instance.startsWith(RESERVED_INSTANCE_PREFIX)
        ? instance
        : UNNAMED_INSTANCE,
  };
}

/**
 * `x-reiwa-capabilities` for a process hosting `hosted`: the ids this panel
 * registered, and a count of the well-formed ones it did not.
 *
 * CASE-SENSITIVE and exact, like the hint doors: `Web.addon-reset-end` is not
 * an id. An id of a surface the process does not host is not its to declare and
 * is dropped, counted nowhere.
 */
export function parseReiwaCapabilities(
  header: string | undefined,
  hosted: readonly CabinetCapabilitySurface[],
): { readonly known: readonly CabinetCapabilityId[]; readonly unknown: number } {
  const known = new Set<CabinetCapabilityId>();
  const unknown = new Set<string>();
  if (typeof header === 'string') {
    for (const name of header.slice(0, CAPABILITIES_HEADER_MAX_CHARACTERS).split(',', CAPABILITIES_HEADER_MAX_NAMES)) {
      const id = name.trim();
      if (id.length === 0 || id.length > CAPABILITY_ID_MAX_LENGTH || !CAPABILITY_ID_PATTERN.test(id)) continue;
      const prefix = id.slice(0, id.indexOf('.'));
      if (!(hosted as readonly string[]).includes(prefix)) continue;
      if (isCabinetCapabilityId(id)) known.add(id);
      else unknown.add(id);
    }
  }
  return { known: [...known], unknown: unknown.size };
}

/**
 * The caller's declaration, or `null` when it sent no `x-reiwa-client` —
 * a cabinet up to 0.9.7.53, or something that is not a cabinet at all.
 *
 * A PRESENT header is a declaration even when it says little: a surface this
 * panel does not know hosts nothing, so it declares nothing, and every gate
 * stays closed toward it. Only silence falls back to the evidence the panel
 * recorded about silent cabinets.
 */
export function readReiwaDeclaration(headers: HeaderBag | undefined): ReiwaDeclaration | null {
  const client = parseReiwaClient(readHeader(headers, REIWA_CLIENT_HEADER));
  if (client === null) return null;
  const hosted = client.surface === null ? [] : HOSTED_CAPABILITY_SURFACES[client.surface];
  const declared = parseReiwaCapabilities(readHeader(headers, REIWA_CAPABILITIES_HEADER), hosted);
  return { ...client, capabilities: declared.known, unknownCapabilities: declared.unknown };
}
