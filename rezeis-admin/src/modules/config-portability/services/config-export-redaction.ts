import type { ConfigExportSection } from './config-export.service';

/**
 * What may leave this deployment in a configuration export, and what may not.
 *
 * The problem this replaces
 * ────────────────────────
 * Every section used to be a bare `findMany({})` / `findFirst()` — no `select`,
 * no `omit`, no mapper, no denylist. That shipped the whole `settings`
 * singleton (SMTP password in the CLEAR, `botTokenEnc`, `webPush.privateKeyEnc`,
 * `turnstileSecretEnc`, quest-partner `secretEnc`, AI `apiKeyEnc`) and
 * `webhooks.secret` in the clear.
 *
 * Listing those six and stripping them would have fixed today and nothing else.
 * The structural fault was the DIRECTION OF THE DEFAULT: with select-all there
 * is no place a new secret-bearing column could be added that would be excluded
 * unless somebody remembered to exclude it. So the default is inverted, in
 * three layers that fail in different directions:
 *
 *   1. **Column allowlist** (`SECTION_FIELD_ALLOWLIST`). A column not named
 *      here does not leave, whatever it is called. A new Prisma column is
 *      excluded by default and stays excluded until a human adds it — the
 *      export logs the columns it dropped so that human finds out.
 *   2. **Key-name redaction** (`SECRET_KEY_PATTERN`), applied recursively at
 *      every depth. Layer 1 cannot see inside a JSON column, and
 *      `settings.systemNotifications` is where three of the six secrets live.
 *      A new nested `…password` / `…Secret` / `…apiKey` / `…Enc` key is dropped
 *      without anyone touching this file.
 *   3. **Value-shape redaction** (`looksLikeCiphertext`). Catches a nested
 *      secret whose NAME gives nothing away, by recognising the envelope
 *      formats this codebase actually writes (`PGENC1:…` and the
 *      `iv:ciphertext:tag` hex triple that `ai-secret-cipher.ts`,
 *      `secret-cipher.ts` and friends produce).
 *
 * The residual hole, stated rather than hidden: a NEW nested key inside an
 * allowlisted JSON column, holding a secret in plaintext, under a name that
 * looks innocent. Layers 2 and 3 both miss that. Closing it would need a
 * per-key allowlist inside every settings JSON blob, which would silently drop
 * legitimate new configuration on the promote path — trading a rare leak for a
 * routine, invisible data loss. If you are adding such a field: encrypt it (it
 * is then caught by layer 3) or name it after what it is (layer 2).
 *
 * Redaction OMITS the key; it does not substitute a placeholder. The import
 * side patches rows field-by-field, so an omitted key leaves the destination's
 * own value alone, while a `"[REDACTED]"` string would be written straight into
 * the destination's SMTP password.
 */

/**
 * Columns each section is allowed to export.
 *
 * Mirrors the Prisma models minus relation fields. Kept as data, not derived
 * from the Prisma DMMF, precisely so that adding a column to `schema.prisma`
 * does NOT silently add it to the export.
 */
export const SECTION_FIELD_ALLOWLIST: Readonly<
  Record<ConfigExportSection, readonly string[]>
> = {
  roles: ['id', 'name', 'displayName', 'description', 'isSystem', 'createdAt', 'updatedAt'],
  permissions: ['id', 'roleId', 'resource', 'action', 'createdAt'],
  scopePolicies: [
    'id',
    'roleId',
    'adminUserId',
    'resourceType',
    'scopeType',
    'scopeValue',
    'actions',
    'createdAt',
    'updatedAt',
  ],
  automations: [
    'id',
    'name',
    'description',
    'isEnabled',
    'triggerKind',
    'triggerSpec',
    'conditions',
    // Arbitrary operator JSON, and the `webhook_post` action carries an
    // operator-supplied `authorizationHeader`. Layer 2 strips that (see
    // `SECRET_KEY_PATTERN`) while the rest of the rule travels.
    'actions',
    'createdById',
    'lastRunAt',
    'lastRunStatus',
    'lastRunMessage',
    'runCount',
    'createdAt',
    'updatedAt',
  ],
  webhooks: [
    'id',
    'name',
    'url',
    // `secret` is deliberately NOT here. It is re-admitted only when the
    // operator asks for it — see `WEBHOOK_SECRET_FIELD` below.
    'eventTypes',
    'description',
    'isActive',
    'createdById',
    'lastDeliveredAt',
    'consecutiveFailures',
    'totalDeliveries',
    'totalFailures',
    'autoDisabledAt',
    'createdAt',
    'updatedAt',
  ],
  notificationTemplates: [
    'id',
    'type',
    'title',
    'body',
    'titleEn',
    'bodyEn',
    'buttons',
    'bannerUrl',
    'isActive',
    'createdAt',
    'updatedAt',
  ],
  settings: [
    'id',
    'rulesRequired',
    'channelRequired',
    'rulesLink',
    'channelId',
    'channelLink',
    'accessMode',
    'inviteModeStartedAt',
    'defaultCurrency',
    'paymentOpsAlerts',
    'systemNotifications',
    'platformPolicy',
    'userNotifications',
    'referralSettings',
    'partnerSettings',
    'questPartnerSettings',
    'multiSubscriptionSettings',
    'brandingSettings',
    'supportSettings',
    'botMenuSettings',
    'remnawaveCleanupSettings',
    'customIcons',
    'aiSupportSettings',
    'antiFraudSettings',
    'updatedAt',
  ],
  blockedIps: [
    'id',
    'address',
    'reason',
    'source',
    'createdById',
    'expiresAt',
    'createdAt',
    'updatedAt',
  ],
  adminIpAllowlist: [
    'id',
    'address',
    'label',
    'isActive',
    'createdById',
    'createdAt',
    'updatedAt',
  ],
  faqItems: [
    'id',
    'question',
    'answer',
    'mediaUrls',
    'orderIndex',
    'isActive',
    'locale',
    'createdAt',
    'updatedAt',
  ],
  legalDocuments: ['key', 'isActive', 'titleRu', 'titleEn', 'bodyRu', 'bodyEn', 'updatedAt'],
};

/** The one secret an operator can choose to export. See `ConfigExportOptions`. */
const WEBHOOK_SECRET_FIELD = 'secret';

/**
 * Key names that name a credential.
 *
 * Deliberately generous — a false positive costs one field that the operator
 * re-enters on the destination, a false negative costs the credential. Each
 * alternative is a substring match on the lower-cased key, except `enc$`
 * which anchors so that ordinary words are not swept up.
 */
export const SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|apikey|api_key|privatekey|private_key|credential|passphrase|authorization|bearer|signingkey|signing_key|salt|enc$)/i;

/**
 * Whether a string is one of this codebase's encryption envelopes.
 *
 * Two shapes, both written by the panel itself:
 *   - `PGENC1:<iv>:<ct>:<tag>` — `payment-gateway-secret-cipher.ts`
 *   - `<iv-hex>:<ct-hex>:<tag-hex>` — `ai-secret-cipher.ts`, `secret-cipher.ts`
 *
 * The bare triple is matched with the EXACT AES-GCM widths (12-byte IV,
 * 16-byte tag) rather than `isEncryptedApiKey`'s loose "three hex parts", so an
 * ordinary colon-separated value cannot be mistaken for ciphertext and silently
 * dropped from a promoted config.
 */
export function looksLikeCiphertext(value: string): boolean {
  if (value.startsWith('PGENC1:')) return true;
  return /^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$/i.test(value);
}

export interface ConfigExportOptions {
  /**
   * Include `webhooks.secret` in the clear.
   *
   * The capability is real and was documented: promoting a config to a fresh
   * environment needs the receivers to keep validating signatures. What was
   * wrong is that it was the DEFAULT, so every export of the webhooks section
   * — including one taken to diff two environments — shipped live signing
   * secrets whether or not anybody wanted them. Now the operator asks.
   */
  readonly includeWebhookSecrets?: boolean;
}

export interface RedactionOutcome {
  readonly rows: unknown[];
  /**
   * Columns present on the rows but absent from the allowlist. Reported so a
   * new Prisma column does not stay silently un-exported forever.
   */
  readonly droppedColumns: readonly string[];
  /** Key paths removed by layer 2 or 3, for the audit row. Values never included. */
  readonly redactedPaths: readonly string[];
}

interface RedactionState {
  readonly droppedColumns: Set<string>;
  readonly redactedPaths: Set<string>;
}

/**
 * Apply all three layers to one section's rows.
 *
 * `rows` is whatever Prisma returned. Returns plain JSON-ready objects; `Date`
 * values pass through untouched because the export serialises them itself, as
 * it always has.
 */
export function redactSectionRows(
  section: ConfigExportSection,
  rows: readonly unknown[],
  options: ConfigExportOptions = {},
): RedactionOutcome {
  const allowed = new Set(SECTION_FIELD_ALLOWLIST[section]);
  const exemptAtTopLevel = new Set<string>();
  /**
   * Withheld on purpose, so it is reported as REDACTED rather than as a column
   * somebody forgot to allowlist — the "add it if it is safe" advice attached
   * to `droppedColumns` would be exactly the wrong thing to tell an operator
   * about a live signing secret.
   */
  const deliberatelyWithheld = new Set<string>();
  if (section === 'webhooks') {
    if (options.includeWebhookSecrets === true) {
      allowed.add(WEBHOOK_SECRET_FIELD);
      exemptAtTopLevel.add(WEBHOOK_SECRET_FIELD);
    } else {
      deliberatelyWithheld.add(WEBHOOK_SECRET_FIELD);
    }
  }

  const state: RedactionState = { droppedColumns: new Set(), redactedPaths: new Set() };
  const out: unknown[] = [];

  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      // Not a row shape this export understands. Dropping is the fail-closed
      // answer: a value that is not an object cannot be filtered field-wise.
      state.droppedColumns.add(`${section}:<non-object row>`);
      continue;
    }
    const source = row as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (!allowed.has(key)) {
        if (deliberatelyWithheld.has(key)) {
          state.redactedPaths.add(`${section}.${key}`);
        } else {
          state.droppedColumns.add(`${section}.${key}`);
        }
        continue;
      }
      if (!exemptAtTopLevel.has(key) && SECRET_KEY_PATTERN.test(key)) {
        state.redactedPaths.add(`${section}.${key}`);
        continue;
      }
      const scrubbed = scrub(value, `${section}.${key}`, state);
      if (scrubbed === OMIT) {
        continue;
      }
      kept[key] = scrubbed;
    }
    out.push(kept);
  }

  return {
    rows: out,
    droppedColumns: [...state.droppedColumns].sort(),
    redactedPaths: [...state.redactedPaths].sort(),
  };
}

/** Sentinel meaning "this value must not be written at all". */
const OMIT = Symbol('omit');

/**
 * Recursively remove secret-shaped keys and ciphertext-shaped values.
 *
 * Depth is bounded implicitly by the JSON that Postgres accepted; there is no
 * cycle risk because these values arrive deserialised from JSONB.
 */
function scrub(value: unknown, path: string, state: RedactionState): unknown | typeof OMIT {
  if (typeof value === 'string') {
    if (looksLikeCiphertext(value)) {
      state.redactedPaths.add(path);
      return OMIT;
    }
    return value;
  }
  if (value === null || value instanceof Date || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const scrubbed = scrub(value[index], `${path}[${index}]`, state);
      // An omitted ARRAY element is replaced with null rather than dropped:
      // shrinking an array silently re-indexes everything after it, and the
      // import writes the array back verbatim.
      items.push(scrubbed === OMIT ? null : scrubbed);
    }
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nestedPath = `${path}.${key}`;
    if (SECRET_KEY_PATTERN.test(key)) {
      state.redactedPaths.add(nestedPath);
      continue;
    }
    const scrubbed = scrub(nested, nestedPath, state);
    if (scrubbed === OMIT) continue;
    out[key] = scrubbed;
  }
  return out;
}
