import { Prisma } from '@prisma/client';

/** Partner verification methods (Req 11.1). */
export type QuestPartnerMethod = 'manual_code' | 'postback' | 'timed_visit';

export interface QuestPartnerConfig {
  readonly method: QuestPartnerMethod;
  /** Slug that resolves to a per-partner secret OUTSIDE params (never the secret itself). */
  readonly partnerSlug: string;
  /** manual_code only: the code the user must enter. `null` for other methods. */
  readonly code: string | null;
  /** Operator-approved landing URL (https only). `null` when not configured. */
  readonly landingUrl: string | null;
  /** timed_visit only: minimum dwell before the visit counts. `null` otherwise. */
  readonly minDwellSeconds: number | null;
}

const PARTNER_SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const METHODS: readonly QuestPartnerMethod[] = ['manual_code', 'postback', 'timed_visit'];
const MAX_CODE_LEN = 128;
const MAX_DWELL_SECONDS = 3600;

/**
 * Parses the untrusted `Quest.params.partner` block into a strict config, or
 * `null` for any malformed / unsafe input. The per-partner HMAC secret is NEVER
 * a config field — it is resolved from `partnerSlug` server-side so it can't
 * leak through the cabinet `mapQuest` projection.
 */
export function resolveQuestPartnerConfig(value: Prisma.JsonValue): QuestPartnerConfig | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const partner = (value as Record<string, unknown>).partner;
  if (partner === null || typeof partner !== 'object' || Array.isArray(partner)) return null;
  const p = partner as Record<string, unknown>;

  const method = typeof p.method === 'string' ? (p.method as QuestPartnerMethod) : null;
  if (method === null || !METHODS.includes(method)) return null;

  const partnerSlug = typeof p.partnerSlug === 'string' ? p.partnerSlug.trim() : '';
  if (!PARTNER_SLUG_RE.test(partnerSlug)) return null;

  const landingUrl = readHttpsUrl(p.landingUrl);
  // A configured-but-invalid landing URL is corruption — reject rather than drop.
  if (p.landingUrl !== undefined && p.landingUrl !== null && p.landingUrl !== '' && landingUrl === null) {
    return null;
  }

  let code: string | null = null;
  if (method === 'manual_code') {
    if (typeof p.code !== 'string') return null;
    const trimmed = p.code.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_CODE_LEN) return null;
    code = trimmed;
  }

  let minDwellSeconds: number | null = null;
  if (method === 'timed_visit') {
    const raw = p.minDwellSeconds;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_DWELL_SECONDS) {
      return null;
    }
    minDwellSeconds = raw;
  }

  return { method, partnerSlug, code, landingUrl, minDwellSeconds };
}

function readHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  return parsed.toString();
}
