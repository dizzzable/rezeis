import { RemnawaveHostInterface } from '../interfaces/remnawave-host.interface';

/**
 * Normalises a raw Remnawave host row across panel versions.
 *
 * A host's labels are `tags: string[]` (optional in the 3.3.2 and 3.4.3
 * specs). `tag` is surfaced as the first of them because the admin SPA still
 * reads it; the single `tag` string 2.7 sent instead is not read.
 *
 * THE CONFIG-PROFILE LINK IS NESTED, and this mapper read it flat for as long
 * as it existed:
 *
 *     { uuid, remark, ..., inbound: { configProfileUuid,
 *                                     configProfileInboundUuid } }
 *
 * `r['configProfileInboundUuid']` is therefore `undefined` on every host of
 * every panel version, and both fields came out null. It had no symptom for
 * just as long, because nothing read them -- until the subscriber server list
 * did, and that list drops any host with no inbound uuid. Which was all of
 * them. Every customer saw "no servers for this subscription" regardless of
 * what the operator had set up.
 *
 * The top-level names are still read as a fallback. They are what the previous
 * author expected, this mapper's whole job is tolerating shape drift between
 * panel versions, and a value found there is unambiguous.
 *
 * Defensive: accepts `unknown`, never throws, fills sane defaults.
 */
export function mapHost(raw: unknown): RemnawaveHostInterface {
  const r = (raw ?? {}) as Record<string, unknown>;
  const tags = normalizeStringList(r['tags']);
  const inbound = record(r['inbound']);
  return {
    uuid: str(r['uuid']) ?? '',
    viewPosition: num(r['viewPosition']),
    remark: str(r['remark']) ?? '',
    serverDescription: str(r['serverDescription']) ?? null,
    address: str(r['address']) ?? '',
    port: num(r['port']),
    isDisabled: Boolean(r['isDisabled']),
    isHidden: Boolean(r['isHidden']),
    securityLayer: str(r['securityLayer']) ?? 'DEFAULT',
    tag: tags.length > 0 ? tags[0] : null,
    tags,
    configProfileUuid: str(inbound['configProfileUuid']) ?? str(r['configProfileUuid']),
    configProfileInboundUuid:
      str(inbound['configProfileInboundUuid']) ?? str(r['configProfileInboundUuid']),
    nodes: normalizeNodes(r['nodes']),
    internalSquads: normalizeInternalSquads(r['internalSquads'], r['excludedInternalSquads']),
    excludeFromSubscriptionTypes: normalizeStringList(r['excludeFromSubscriptionTypes']),
  };
}

/** An object property, or an empty object for anything else. */
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * The host's squad rule from either shape: 3.4's `{ mode, squads }` or the
 * `excludedInternalSquads` array every earlier version sends.
 *
 * Only a COMPLETE 3.4 rule wins: a mode we were given, paired with a list that
 * is actually a list. Both are `required` in the 3.4 contract, so a half of one
 * is not a rule a newer panel sent — it is a proxy that dropped a key or a row
 * edited by hand, and the legacy array is then the better answer because it is
 * the only rule we did receive.
 *
 * Every remaining judgement call leans the same way, and the reason is always
 * the same: showing a host to a squad that should not have it costs a confused
 * customer, hiding one costs a paying customer a server that works.
 *
 *   • an unknown mode (a direction Remnawave has not shipped) reads as
 *     `exclude`, not as an allow list;
 *   • `squads` that is not an array reads as "no rule", not as "allowed to
 *     nobody", which is what an empty allow list would otherwise mean.
 *
 * An allow list that is genuinely EMPTY is the one case read literally — see
 * `InternalSquadAccessInterface`, which explains why that is not a guess.
 */
function normalizeInternalSquads(
  value: unknown,
  legacy: unknown,
): { readonly mode: 'exclude' | 'allow-only'; readonly squads: readonly string[] } {
  const fresh = record(value);
  const squads = fresh['squads'];
  // An own-property test, not `in`: `in` walks the prototype chain, so a
  // polluted `Object.prototype.mode` would turn every pre-3.4 row into a 3.4
  // one and drop its exclusions. No vector reaches here today; the guard is
  // free. (`Object.hasOwn` would read better and is ES2022; this project
  // targets ES2021.)
  if (Object.prototype.hasOwnProperty.call(fresh, 'mode') && Array.isArray(squads)) {
    return {
      mode: fresh['mode'] === 'ALLOW_ONLY' ? 'allow-only' : 'exclude',
      squads: normalizeStringList(squads),
    };
  }
  return { mode: 'exclude', squads: normalizeStringList(legacy) };
}

/** A string array, dropping anything that is not a non-empty string. */
function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
}

/** Hosts reference nodes either as UUID strings or `{ uuid }` objects. */
function normalizeNodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) out.push(entry);
    else if (entry !== null && typeof entry === 'object') {
      const u = (entry as Record<string, unknown>)['uuid'];
      if (typeof u === 'string' && u.length > 0) out.push(u);
    }
  }
  return out;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
