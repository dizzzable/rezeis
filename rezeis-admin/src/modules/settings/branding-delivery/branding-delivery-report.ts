/**
 * The cabinet's word on one version of the public config: which fields of the
 * appearance it did NOT take. The cabinet judges each field alone since
 * 24.09.2026 and keeps the value it served before for every field it refuses
 * (`reiwa/src/infrastructure/public-config/field-fallback.ts`); it sends this
 * report once per version (`reiwa/src/infrastructure/public-config/delivery-report.ts`),
 * with an empty list when it took everything.
 */

/** A version as the cabinet computes it (`config-version-hash.ts`): 32 hex digits. */
const VERSION_PATTERN = /^[0-9a-f]{32}$/;

/** More than this many fields is not a report the page can show; the rest is dropped. */
export const MAX_REPORTED_FIELDS = 64;
/** The guard's longest key is well under this (`branding.themeVariants.subscriptionCardText`). */
export const MAX_FIELD_PATH_LENGTH = 160;
export const MAX_REASON_LENGTH = 64;
/** The cabinet cuts the value to this; kept as a ceiling here too. */
export const MAX_FIELD_VALUE_LENGTH = 120;

/** One field the cabinet did not take. */
export interface BrandingDeliveryField {
  /** The cabinet guard's key: `branding.borderRadius`, `branding.navItems[1]`, `customIcons[0]`… */
  readonly path: string;
  /** Its reason code, e.g. `not-an-allowed-value`, `out-of-range[0.05..1]`. */
  readonly reason: string;
  /** The value the panel sent there, as JSON, at most `MAX_FIELD_VALUE_LENGTH` characters. */
  readonly value: string;
}

/** What one cabinet API process made of one version of the public config. */
export interface BrandingDeliveryReport {
  /** The panel's version of the payload it judged. */
  readonly version: string;
  /** The fields it did not take; empty when it took everything. */
  readonly rejected: readonly BrandingDeliveryField[];
}

/**
 * The report out of the request body, or `null` when the body is not one.
 * Lenient inside: an entry that is not a field is dropped rather than failing
 * the whole report, and every string is cut to its limit — the page shows
 * what arrived, and a newer cabinet may send a reason this panel does not know.
 */
export function readBrandingDeliveryReport(body: unknown): BrandingDeliveryReport | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { version, rejected } = body as { version?: unknown; rejected?: unknown };
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) return null;
  if (!Array.isArray(rejected)) return null;
  const fields: BrandingDeliveryField[] = [];
  for (const entry of rejected.slice(0, MAX_REPORTED_FIELDS)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { path, reason, value } = entry as { path?: unknown; reason?: unknown; value?: unknown };
    if (typeof path !== 'string' || path.length === 0 || typeof reason !== 'string' || typeof value !== 'string') {
      continue;
    }
    fields.push({
      path: path.slice(0, MAX_FIELD_PATH_LENGTH),
      reason: reason.slice(0, MAX_REASON_LENGTH),
      value: cut(value, MAX_FIELD_VALUE_LENGTH),
    });
  }
  return { version, rejected: fields };
}

function cut(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
