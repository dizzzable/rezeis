import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALL_SECTIONS,
  ConfigExportSection,
  ConfigExportService,
} from '../src/modules/config-portability/services/config-export.service';
import {
  SECTION_FIELD_ALLOWLIST,
  redactSectionRows,
} from '../src/modules/config-portability/services/config-export-redaction';

/**
 * The config export shipped every secret the panel holds
 * ─────────────────────────────────────────────────────
 * All eleven sections were bare `findMany({})` / `findFirst()` — no `select`,
 * no `omit`, no mapper, no denylist — so `GET /admin/config/export` returned
 * the SMTP password in the CLEAR, `botTokenEnc`, `webPush.privateKeyEnc`,
 * `turnstileSecretEnc`, the quest-partner `secretEnc`, the AI `apiKeyEnc`, and
 * every `webhooks.secret`.
 *
 * WHAT THIS FILE IS FOR
 * ─────────────────────
 * Not the six. Listing the six and asserting they are gone would go green
 * again the moment somebody adds a seventh, which is exactly the failure the
 * old code had: the direction of the default. So the tests that matter here
 * are the ones that invent fields nobody has written yet —
 *
 *   * `newlyAddedProviderCredential`, a column that does not exist in
 *     `schema.prisma` at all (layer 1, the column allowlist);
 *   * `systemNotifications.someNewIntegration.password`, nested three deep
 *     inside an allowlisted JSON column (layer 2, key names);
 *   * `systemNotifications.someNewIntegration.opaqueBlob`, an innocent NAME
 *     holding one of this codebase's ciphertext envelopes (layer 3, values).
 *
 * — and each of them fails if the redaction is removed, without anyone
 * updating this file.
 */

/** Every JSON envelope format the panel actually writes at rest. */
const AES_GCM_ENVELOPE =
  '0123456789abcdef01234567:deadbeefcafe:0123456789abcdef0123456789abcdef';
const GATEWAY_ENVELOPE = 'PGENC1:0123456789abcdef01234567:beef:0123456789abcdef0123456789abcdef';

/**
 * A `settings` singleton shaped like the real one — the six secrets in the
 * places the real row keeps them, plus three fields invented for this test.
 */
function settingsRow(): Record<string, unknown> {
  return {
    id: 1,
    rulesRequired: true,
    rulesLink: 'https://example.test/rules',
    accessMode: 'PUBLIC',
    systemNotifications: {
      // Finding 3, secret #1: stored in the CLEAR.
      email: {
        enabled: true,
        host: 'smtp.example.test',
        port: 587,
        username: 'notifier',
        password: 'the-actual-smtp-password',
      },
      // #2
      botTokenEnc: AES_GCM_ENVELOPE,
      // #3
      webPush: {
        publicKey: 'BPublicKeyMaterial',
        privateKeyEnc: AES_GCM_ENVELOPE,
        contactEmail: 'ops@example.test',
      },
      backup: { autoEnabled: true, maxKeep: 7, telegram: { enabled: true, chatId: '-100999' } },
      // Invented — a NEW nested secret under a conventional name. Nothing in
      // src/ writes this key; if it appears in the export, layer 2 is gone.
      someNewIntegration: {
        endpoint: 'https://new-thing.example.test',
        password: 'invented-plaintext-secret',
        // Invented — a NEW nested secret under a name that gives nothing away.
        // Only its VALUE shape betrays it. If it appears, layer 3 is gone.
        opaqueBlob: GATEWAY_ENVELOPE,
      },
    },
    // #4
    supportSettings: { enabled: true, turnstileSiteKey: '0x-site', turnstileSecretEnc: AES_GCM_ENVELOPE },
    // #5
    questPartnerSettings: {
      partners: [{ slug: 'acme', label: 'Acme', secretEnc: AES_GCM_ENVELOPE }],
    },
    // #6
    aiSupportSettings: { baseUrl: 'https://api.example.test', model: 'gpt-x', apiKeyEnc: AES_GCM_ENVELOPE },
    platformPolicy: { minVersion: '1.2.3' },
    brandingSettings: { brandName: 'Reiwa' },
    // Invented — a NEW top-level COLUMN. Not in `schema.prisma`, not in the
    // allowlist. If it appears in the export, layer 1 is gone.
    newlyAddedProviderCredential: 'invented-new-column-value',
    // Invented — a NEW top-level COLUMN whose NAME gives nothing away and
    // whose VALUE is ordinary text. Layers 2 and 3 are both blind to it. Only
    // the column allowlist keeps it out, which is the whole claim: the DEFAULT
    // for a field nobody has thought about is "does not leave".
    tenantLinkHandle: 'invented-innocent-column-value',
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function webhookRow(): Record<string, unknown> {
  return {
    id: 'wh-1',
    name: 'ops',
    url: 'https://receiver.example.test/hook',
    secret: 'the-actual-webhook-signing-secret',
    eventTypes: ['*'],
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function automationRow(): Record<string, unknown> {
  return {
    id: 'auto-1',
    name: 'exfil',
    isEnabled: true,
    triggerKind: 'REALTIME',
    triggerSpec: 'payment.*',
    actions: [
      {
        type: 'webhook_post',
        params: {
          url: 'https://attacker.example.test/collect',
          authorizationHeader: 'Bearer the-actual-bearer-token',
        },
      },
    ],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

const SECTION_DELEGATE: Readonly<Record<ConfigExportSection, string>> = {
  roles: 'adminRole',
  permissions: 'adminPermission',
  scopePolicies: 'adminScopePolicy',
  automations: 'automationRule',
  webhooks: 'webhookSubscription',
  notificationTemplates: 'notificationTemplate',
  settings: 'settings',
  blockedIps: 'blockedIp',
  adminIpAllowlist: 'adminIpAllowlist',
  faqItems: 'faqItem',
  legalDocuments: 'legalDocument',
};

function buildPrismaStub(): Record<string, unknown> {
  const rows: Partial<Record<ConfigExportSection, Record<string, unknown>[]>> = {
    settings: [settingsRow()],
    webhooks: [webhookRow()],
    automations: [automationRow()],
    roles: [{ id: 'role-1', name: 'ops', displayName: 'Ops', isSystem: false }],
    adminIpAllowlist: [{ id: 'ip-1', address: '10.0.0.1/32', label: 'office', isActive: true }],
  };
  const prisma: Record<string, unknown> = {};
  for (const section of ALL_SECTIONS) {
    const delegate = SECTION_DELEGATE[section];
    const sectionRows = rows[section] ?? [];
    if (section === 'settings') {
      prisma[delegate] = { findFirst: async () => sectionRows[0] ?? null };
      continue;
    }
    prisma[delegate] = { findMany: async () => sectionRows };
  }
  return prisma;
}

/** Every string anywhere in the payload, so a secret cannot hide in a nest. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (value === null || typeof value !== 'object' || value instanceof Date) return out;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectStrings(nested, out);
  }
  return out;
}

/** Every key name anywhere in the payload. */
function collectKeys(value: unknown, out: string[] = []): string[] {
  if (value === null || typeof value !== 'object' || value instanceof Date) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return out;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out.push(key);
    collectKeys(nested, out);
  }
  return out;
}

describe('config export redaction — a NEW secret-bearing field cannot escape by default', () => {
  it('excludes a column nobody has added to the allowlist, whatever it is called', async () => {
    // Layer 1, and the single most important assertion in this file. The
    // second column is named `tenantLinkHandle` and holds plain text: no
    // name pattern matches it, no value shape betrays it. It is excluded for
    // one reason only — nobody put it on the allowlist. That is the inverted
    // default, and a fix that merely strips today's known keys fails here.
    const payload = await new ConfigExportService(buildPrismaStub() as never).exportConfig(['settings']);
    const strings = collectStrings(payload.sections.settings);
    const keys = collectKeys(payload.sections.settings);

    assert.ok(
      !strings.includes('invented-innocent-column-value'),
      'a NEW column must not be exported just because its name looks harmless',
    );
    assert.ok(
      !keys.includes('tenantLinkHandle'),
      'not even the key name of an un-allowlisted column belongs in the file',
    );
    assert.ok(!strings.includes('invented-new-column-value'));
    assert.ok(!keys.includes('newlyAddedProviderCredential'));
  });

  it('excludes a NEW nested secret named after what it is', async () => {
    // Layer 2. `systemNotifications` is an allowlisted JSON column, so layer 1
    // cannot see inside it; the key name is what gives this one away.
    const payload = await new ConfigExportService(buildPrismaStub() as never).exportConfig(['settings']);
    const strings = collectStrings(payload.sections.settings);

    assert.ok(
      !strings.includes('invented-plaintext-secret'),
      'a nested `…password` key must be stripped at any depth',
    );
  });

  it('excludes a NEW nested secret whose name gives nothing away', async () => {
    // Layer 3. `opaqueBlob` matches no name pattern. Its VALUE is one of this
    // codebase's envelopes, and that is enough.
    const payload = await new ConfigExportService(buildPrismaStub() as never).exportConfig(['settings']);
    const strings = collectStrings(payload.sections.settings);

    assert.ok(
      !strings.includes(GATEWAY_ENVELOPE),
      'a ciphertext envelope must be stripped even under an innocent key name',
    );
  });

  it('excludes all six secrets the finding named', async () => {
    const payload = await new ConfigExportService(buildPrismaStub() as never).exportConfig(null);
    const strings = collectStrings(payload.sections);

    assert.ok(!strings.includes('the-actual-smtp-password'), 'SMTP password');
    assert.ok(!strings.includes(AES_GCM_ENVELOPE), 'every AES-GCM envelope (bot token, webPush, turnstile, quest partner, AI key)');
    assert.ok(!strings.includes('the-actual-webhook-signing-secret'), 'webhook signing secret');
    assert.ok(!strings.includes('the-actual-bearer-token'), 'automation webhook_post Authorization header');
  });

  it('omits a redacted field rather than replacing it with a placeholder', async () => {
    // The import patches field by field, so a `"[REDACTED]"` string would be
    // WRITTEN into the destination's SMTP password. Omission leaves it alone.
    const payload = await new ConfigExportService(buildPrismaStub() as never).exportConfig(['settings']);
    const row = (payload.sections.settings ?? [])[0] as Record<string, unknown>;
    const system = row.systemNotifications as Record<string, unknown>;
    const email = system.email as Record<string, unknown>;

    assert.ok(!('password' in email), 'the key itself must be absent');
    assert.equal(email.host, 'smtp.example.test', 'its innocent siblings must survive');
    assert.ok(!('botTokenEnc' in system));
  });

  it('does not over-redact the configuration the export exists to carry', async () => {
    const payload = await new ConfigExportService(buildPrismaStub() as never).exportConfig(null);
    const settings = (payload.sections.settings ?? [])[0] as Record<string, unknown>;
    const system = settings.systemNotifications as Record<string, unknown>;
    const webhook = (payload.sections.webhooks ?? [])[0] as Record<string, unknown>;
    const automation = (payload.sections.automations ?? [])[0] as Record<string, unknown>;

    assert.equal(settings.rulesLink, 'https://example.test/rules');
    assert.equal((settings.brandingSettings as Record<string, unknown>).brandName, 'Reiwa');
    assert.equal((system.backup as Record<string, unknown>).autoEnabled, true);
    assert.equal(
      ((system.webPush as Record<string, unknown>).publicKey),
      'BPublicKeyMaterial',
      'the PUBLIC half of a key pair is not a secret and is needed on the destination',
    );
    assert.equal(webhook.url, 'https://receiver.example.test/hook');
    assert.deepEqual(webhook.eventTypes, ['*']);
    assert.equal(automation.name, 'exfil');
    assert.equal(
      ((automation.actions as Record<string, unknown>[])[0]?.params as Record<string, unknown>).url,
      'https://attacker.example.test/collect',
      'the rest of an automation action must still promote',
    );
    assert.equal((payload.sections.adminIpAllowlist ?? []).length, 1);
  });
});

describe('config export redaction — the webhook secret is a choice, not a default', () => {
  it('leaves the secret out unless it is asked for', async () => {
    const payload = await new ConfigExportService(buildPrismaStub() as never).exportConfig(['webhooks']);
    const row = (payload.sections.webhooks ?? [])[0] as Record<string, unknown>;
    assert.ok(!('secret' in row), 'exporting webhooks must not hand out live signing secrets by default');
  });

  it('keeps the documented round-trip capability when the operator asks', async () => {
    // Promoting a config to a fresh environment needs the receivers to keep
    // validating. The capability is kept; it stopped being automatic.
    const payload = await new ConfigExportService(buildPrismaStub() as never).exportConfig(
      ['webhooks'],
      { includeWebhookSecrets: true },
    );
    const row = (payload.sections.webhooks ?? [])[0] as Record<string, unknown>;
    assert.equal(row.secret, 'the-actual-webhook-signing-secret');
  });

  it('does not let the opt-in reopen anything else', async () => {
    const payload = await new ConfigExportService(buildPrismaStub() as never).exportConfig(null, {
      includeWebhookSecrets: true,
    });
    const strings = collectStrings(payload.sections);
    assert.ok(!strings.includes('the-actual-smtp-password'));
    assert.ok(!strings.includes(AES_GCM_ENVELOPE));
    assert.ok(!strings.includes('the-actual-bearer-token'));
  });
});

describe('config export redaction — the allowlist is the source of truth', () => {
  it('covers every section, so no section falls through un-filtered', () => {
    for (const section of ALL_SECTIONS) {
      const allowed = SECTION_FIELD_ALLOWLIST[section];
      assert.ok(Array.isArray(allowed) && allowed.length > 0, `no allowlist for section "${section}"`);
    }
    assert.deepEqual(
      Object.keys(SECTION_FIELD_ALLOWLIST).sort(),
      [...ALL_SECTIONS].sort(),
      'a section added to ALL_SECTIONS must get an allowlist, or it exports nothing at all',
    );
  });

  it('never lists a secret-shaped column as allowed', () => {
    // Belt and braces: if somebody "fixes" a redaction complaint by adding the
    // field to the allowlist, this fails.
    for (const [section, fields] of Object.entries(SECTION_FIELD_ALLOWLIST)) {
      for (const field of fields) {
        assert.ok(
          !/(password|secret|token|apikey|privatekey|credential)/i.test(field),
          `${section}.${field} is on the allowlist and looks like a credential`,
        );
      }
    }
  });

  it('reports what it dropped, so a new column does not stay invisible', () => {
    const outcome = redactSectionRows('settings', [settingsRow()]);
    assert.ok(
      outcome.droppedColumns.includes('settings.newlyAddedProviderCredential'),
      'an un-allowlisted column must be reported, or nobody ever learns to add it',
    );
    assert.ok(outcome.redactedPaths.length > 0, 'redacted paths belong in the audit row');
  });
});
