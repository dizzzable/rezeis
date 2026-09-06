import { RemnawaveHostInterface } from '../interfaces/remnawave-host.interface';

/**
 * Normalises a raw Remnawave host row across panel versions.
 *
 * The 2.7 → 2.8 host shape drifted:
 *   • `tag: string | null`  →  `tags: string[]`  (we normalize to `tags[]`
 *     and keep `tag` = first element for back-compat),
 *   • `xHttpExtraParams`    →  `xhttpExtraParams` (not surfaced; ignored),
 *   • `allowInsecure` dropped; `pinnedPeerCertSha256` / `verifyPeerCertByName`
 *     / `mihomoIpVersion` added (not surfaced; ignored).
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
  const tags = normalizeTags(r['tags'], r['tag']);
  const inbound = record(r['inbound']);
  return {
    uuid: str(r['uuid']) ?? '',
    viewPosition: num(r['viewPosition']),
    remark: str(r['remark']) ?? '',
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
    excludedInternalSquads: normalizeStringList(r['excludedInternalSquads']),
  };
}

function normalizeTags(tagsValue: unknown, legacyTag: unknown): string[] {
  if (Array.isArray(tagsValue)) {
    return tagsValue.filter((t): t is string => typeof t === 'string' && t.length > 0);
  }
  if (typeof legacyTag === 'string' && legacyTag.length > 0) return [legacyTag];
  return [];
}

/** An object property, or an empty object for anything else. */
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
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
