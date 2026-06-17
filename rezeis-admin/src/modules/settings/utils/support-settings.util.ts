/**
 * Anonymous support chat settings (panel-managed)
 * ───────────────────────────────────────────────
 * Stored in `Settings.supportSettings` (JSON). Env vars only seed the
 * defaults so an un-configured deployment keeps working; the operator
 * tunes everything from the admin panel afterwards. The Turnstile secret
 * is persisted AES-256-GCM-encrypted (`turnstileSecretEnc`) and is never
 * returned to the SPA — only a presence flag.
 */

/** Raw JSON shape persisted in the settings column. */
export interface StoredSupportSettings {
  enabled?: boolean;
  guestTokenTtlHours?: number;
  attachmentMaxMb?: number;
  attachmentMaxPerMsg?: number;
  turnstileSiteKey?: string;
  turnstileSecretEnc?: string;
}

/** Admin-safe view returned to the SPA (secret redacted to a flag). */
export interface SupportSettingsView {
  readonly enabled: boolean;
  readonly guestTokenTtlHours: number;
  readonly attachmentMaxMb: number;
  readonly attachmentMaxPerMsg: number;
  readonly turnstileSiteKey: string;
  readonly turnstileConfigured: boolean;
}

/** Limits consumed by the support services at runtime. */
export interface SupportLimits {
  readonly enabled: boolean;
  readonly guestTokenTtlHours: number;
  readonly attachmentMaxBytes: number;
  readonly attachmentMaxPerMsg: number;
}

const DEFAULT_TTL_HOURS = 72;
const DEFAULT_MAX_MB = 10;
const DEFAULT_MAX_PER_MSG = 5;

function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.trunc(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Read a stored blob into the effective values, falling back to env. */
function effective(stored: StoredSupportSettings): {
  enabled: boolean;
  guestTokenTtlHours: number;
  attachmentMaxMb: number;
  attachmentMaxPerMsg: number;
  turnstileSiteKey: string;
} {
  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : true,
    guestTokenTtlHours:
      typeof stored.guestTokenTtlHours === 'number'
        ? stored.guestTokenTtlHours
        : envInt('SUPPORT_GUEST_TOKEN_TTL_HOURS', DEFAULT_TTL_HOURS),
    attachmentMaxMb:
      typeof stored.attachmentMaxMb === 'number'
        ? stored.attachmentMaxMb
        : envInt('SUPPORT_ATTACHMENT_MAX_MB', DEFAULT_MAX_MB),
    attachmentMaxPerMsg:
      typeof stored.attachmentMaxPerMsg === 'number'
        ? stored.attachmentMaxPerMsg
        : envInt('SUPPORT_ATTACHMENT_MAX_PER_MSG', DEFAULT_MAX_PER_MSG),
    turnstileSiteKey:
      typeof stored.turnstileSiteKey === 'string'
        ? stored.turnstileSiteKey
        : (process.env.SUPPORT_TURNSTILE_SITE_KEY ?? ''),
  };
}

export function toSupportSettingsView(stored: StoredSupportSettings): SupportSettingsView {
  const e = effective(stored);
  const envSecret = (process.env.SUPPORT_TURNSTILE_SECRET ?? '').trim();
  return {
    enabled: e.enabled,
    guestTokenTtlHours: e.guestTokenTtlHours,
    attachmentMaxMb: e.attachmentMaxMb,
    attachmentMaxPerMsg: e.attachmentMaxPerMsg,
    turnstileSiteKey: e.turnstileSiteKey,
    turnstileConfigured:
      (typeof stored.turnstileSecretEnc === 'string' && stored.turnstileSecretEnc.length > 0) ||
      envSecret.length > 0,
  };
}

export function toSupportLimits(stored: StoredSupportSettings): SupportLimits {
  const e = effective(stored);
  return {
    enabled: e.enabled,
    guestTokenTtlHours: e.guestTokenTtlHours,
    attachmentMaxBytes: e.attachmentMaxMb * 1024 * 1024,
    attachmentMaxPerMsg: e.attachmentMaxPerMsg,
  };
}

export interface SupportSettingsPatch {
  enabled?: boolean;
  guestTokenTtlHours?: number;
  attachmentMaxMb?: number;
  attachmentMaxPerMsg?: number;
  turnstileSiteKey?: string;
  /** Plaintext secret to encrypt (caller supplies the cipher); '' clears it. */
  turnstileSecretEnc?: string | null;
}

/**
 * Merge a validated patch over the stored blob. Numeric fields are clamped
 * to sane bounds. `turnstileSecretEnc` is applied as-is (already encrypted
 * by the caller) or removed when explicitly null.
 */
export function mergeSupportSettings(
  previous: StoredSupportSettings,
  patch: SupportSettingsPatch,
): StoredSupportSettings {
  const next: StoredSupportSettings = { ...previous };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.guestTokenTtlHours !== undefined) {
    next.guestTokenTtlHours = clampInt(patch.guestTokenTtlHours, 1, 8760, DEFAULT_TTL_HOURS);
  }
  if (patch.attachmentMaxMb !== undefined) {
    next.attachmentMaxMb = clampInt(patch.attachmentMaxMb, 1, 50, DEFAULT_MAX_MB);
  }
  if (patch.attachmentMaxPerMsg !== undefined) {
    next.attachmentMaxPerMsg = clampInt(patch.attachmentMaxPerMsg, 1, 20, DEFAULT_MAX_PER_MSG);
  }
  if (patch.turnstileSiteKey !== undefined) {
    next.turnstileSiteKey = patch.turnstileSiteKey.trim();
  }
  if (patch.turnstileSecretEnc !== undefined) {
    if (patch.turnstileSecretEnc === null || patch.turnstileSecretEnc.length === 0) {
      delete next.turnstileSecretEnc;
    } else {
      next.turnstileSecretEnc = patch.turnstileSecretEnc;
    }
  }
  return next;
}
