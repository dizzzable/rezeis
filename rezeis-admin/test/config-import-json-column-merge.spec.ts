/**
 * Re-importing a redacted export must not delete the secrets it redacted.
 *
 * The finding, verbatim
 * ─────────────────────
 * `config-export-redaction.ts` OMITS a secret rather than substituting a
 * placeholder, and both it and `ConfigExportService` say why: "importing a
 * redacted export leaves the destination's own secrets intact." That holds for
 * a secret in its own COLUMN — Prisma's `update` writes only the keys present
 * in `data`. It did NOT hold for a secret nested inside a `Json` column,
 * because Prisma replaces a `Json` value WHOLESALE. `Settings` keeps no secret
 * in a column of its own; all six live inside JSON:
 *
 *   systemNotifications.email.password        systemNotifications.botTokenEnc
 *   systemNotifications.webPush.privateKeyEnc supportSettings.turnstileSecretEnc
 *   questPartnerSettings.partners[].secretEnc aiSupportSettings.apiKeyEnc
 *
 * So export production → import it back (or into staging) and every one of them
 * was written back ABSENT. Note the shape: it is not that a `"[REDACTED]"`
 * string overwrote the secret, it is that the key's absence did. Mail stops
 * sending, push stops delivering, the bot goes dead, and the import answers
 * `status: 'imported'`.
 *
 * How these cases are built
 * ─────────────────────────
 * The redacted payload is produced by the REAL `ConfigExportService`, which
 * runs the REAL `redactSectionRows` and writes the real manifest — so the file
 * under test is the one production writes, not this file's assumption about
 * what redaction omits. It is then JSON round-tripped, because an import
 * arrives as an uploaded file and `Date`s reach the import side as strings.
 *
 * Source and destination hold DIFFERENT secrets, which is the honest scenario
 * (promote a config between environments) and makes the assertion unambiguous:
 * the destination's own value must survive, and it cannot have come from the
 * file, because the file does not contain a secret at all.
 *
 * Every case drives the real `ConfigImportService.importConfig` against a
 * recording Prisma double and asserts the `data` object that actually reached
 * `settings.update` — not that a helper returned the right thing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConfigExportService,
  type ConfigExportPayloadInterface,
  type ConfigExportSection,
} from '../src/modules/config-portability/services/config-export.service';
import { ConfigImportService } from '../src/modules/config-portability/services/config-import.service';

/** Wide enough that no case is refused by the per-section escalation gate. */
const IMPORTER = new Set([
  'config_portability:import',
  'settings:edit',
  'webhooks:create',
  'webhooks:edit',
]);

// Ciphertext-shaped so that layer 3 would catch them even if layer 2 did not;
// distinct per environment so a preserved value cannot be confused with a
// copied one.
const SOURCE_BOT_TOKEN = '0123456789abcdef01234567:aaaa:0123456789abcdef0123456789abcdef';
const DEST_BOT_TOKEN = 'fedcba9876543210fedcba98:bbbb:fedcba9876543210fedcba9876543210';
const SOURCE_VAPID = 'PGENC1:1111:2222:3333';
const DEST_VAPID = 'PGENC1:9999:8888:7777';
const SOURCE_TURNSTILE = 'PGENC1:aaaa:bbbb:cccc';
const DEST_TURNSTILE = 'PGENC1:dddd:eeee:ffff';
const SOURCE_AI_KEY = 'PGENC1:1a1a:2b2b:3c3c';
const DEST_AI_KEY = 'PGENC1:4d4d:5e5e:6f6f';
const SOURCE_ACME_SECRET = 'PGENC1:0a0a:0b0b:0c0c';
const DEST_ACME_SECRET = 'PGENC1:0d0d:0e0e:0f0f';

/**
 * The production `settings` row, as Prisma hands it back: `Json` columns are
 * plain objects/arrays, `updatedAt` is a `Date`. Column names and shapes match
 * `model Settings` and the settings module's own readers
 * (`SECRET_SYSTEM_NOTIFICATION_KEYS`, `support-settings.util.ts`,
 * `quest-partner-settings.util.ts`).
 */
function sourceSettingsRow(): Record<string, unknown> {
  return {
    id: 1,
    rulesRequired: true,
    channelRequired: false,
    rulesLink: 'https://source.example/rules',
    channelId: null,
    channelLink: 'https://t.me/source',
    accessMode: 'PUBLIC',
    inviteModeStartedAt: null,
    defaultCurrency: 'RUB',
    paymentOpsAlerts: {},
    systemNotifications: {
      telegram: { chatId: '-1001111', topics: { billing: 7, support: 9 } },
      email: {
        host: 'smtp.source.test',
        port: 587,
        user: 'ops@source.test',
        password: 'source-smtp-password',
      },
      botTokenEnc: SOURCE_BOT_TOKEN,
      webPush: {
        publicKey: 'BSourcePublicKey',
        privateKeyEnc: SOURCE_VAPID,
        contactEmail: 'ops@source.test',
      },
    },
    platformPolicy: { maintenance: false, maintenanceMessage: null },
    userNotifications: {},
    referralSettings: {},
    partnerSettings: {},
    questPartnerSettings: {
      partners: [{ slug: 'acme', secretEnc: SOURCE_ACME_SECRET, label: 'Acme (source)' }],
    },
    multiSubscriptionSettings: {},
    brandingSettings: {},
    supportSettings: {
      enabled: true,
      turnstileSiteKey: 'source-site-key',
      turnstileSecretEnc: SOURCE_TURNSTILE,
    },
    botMenuSettings: {},
    remnawaveCleanupSettings: {},
    customIcons: [],
    aiSupportSettings: {
      baseUrl: 'https://ai.source.test',
      model: 'source-model',
      apiKeyEnc: SOURCE_AI_KEY,
    },
    antiFraudSettings: {},
    updatedAt: new Date('2026-08-01T10:00:00.000Z'),
  };
}

/**
 * The DESTINATION's own row. Its secrets are its own, and several non-secret
 * values differ from the source so the negative half has something to prove:
 * the import has to overwrite those and only those.
 *
 * `partners` carries an extra partner the source does not have, and
 * `telegram.topics` is missing the `support` key the source added.
 */
function destinationSettingsRow(): Record<string, unknown> {
  return {
    id: 1,
    rulesRequired: false,
    channelRequired: false,
    rulesLink: 'https://destination.example/old-rules',
    channelId: null,
    channelLink: 'https://t.me/destination',
    accessMode: 'PUBLIC',
    inviteModeStartedAt: null,
    defaultCurrency: 'RUB',
    paymentOpsAlerts: {},
    systemNotifications: {
      telegram: { chatId: '-1009999', topics: { billing: 3 } },
      email: {
        host: 'smtp.destination.test',
        port: 465,
        user: 'ops@destination.test',
        password: 'destination-smtp-password',
      },
      botTokenEnc: DEST_BOT_TOKEN,
      webPush: {
        publicKey: 'BDestinationPublicKey',
        privateKeyEnc: DEST_VAPID,
        contactEmail: 'ops@destination.test',
      },
    },
    platformPolicy: { maintenance: true, maintenanceMessage: 'Back at 20:00' },
    userNotifications: {},
    referralSettings: {},
    partnerSettings: {},
    questPartnerSettings: {
      partners: [
        { slug: 'acme', secretEnc: DEST_ACME_SECRET, label: 'Acme (destination)' },
        { slug: 'retired', secretEnc: 'PGENC1:dead:beef:cafe', label: 'Retired' },
      ],
    },
    multiSubscriptionSettings: {},
    brandingSettings: {},
    supportSettings: {
      enabled: false,
      turnstileSiteKey: 'destination-site-key',
      turnstileSecretEnc: DEST_TURNSTILE,
    },
    botMenuSettings: {},
    remnawaveCleanupSettings: {},
    customIcons: [],
    aiSupportSettings: {
      baseUrl: 'https://ai.destination.test',
      model: 'destination-model',
      apiKeyEnc: DEST_AI_KEY,
    },
    antiFraudSettings: {},
    updatedAt: new Date('2026-07-01T10:00:00.000Z'),
  };
}

interface RecordedWrite {
  readonly op: 'create' | 'update';
  readonly delegate: string;
  readonly data: Record<string, unknown>;
}

interface DestinationState {
  readonly settings?: Record<string, unknown> | null;
  readonly scopePolicies?: ReadonlyArray<Record<string, unknown>>;
  readonly webhooks?: ReadonlyArray<Record<string, unknown>>;
}

/** Recording Prisma double for the IMPORT side. Every write is captured whole. */
function buildImportPrisma(state: DestinationState): {
  readonly prisma: unknown;
  readonly writes: RecordedWrite[];
} {
  const writes: RecordedWrite[] = [];
  const rowsById = (rows: ReadonlyArray<Record<string, unknown>> | undefined) =>
    async ({ where }: { where: { id: string } }) =>
      rows?.find((row) => row['id'] === where.id) ?? null;

  const recorder = (name: string) => ({
    create: async ({ data }: { data: Record<string, unknown> }) => {
      writes.push({ op: 'create', delegate: name, data });
      return data;
    },
    update: async ({ data }: { data: Record<string, unknown> }) => {
      writes.push({ op: 'update', delegate: name, data });
      return data;
    },
  });

  const tx = {
    settings: {
      findFirst: async () => state.settings ?? null,
      findUnique: async () => state.settings ?? null,
      ...recorder('settings'),
    },
    adminScopePolicy: {
      findUnique: rowsById(state.scopePolicies),
      findFirst: async () => null,
      ...recorder('adminScopePolicy'),
    },
    webhookSubscription: {
      findUnique: rowsById(state.webhooks),
      findFirst: async () => null,
      ...recorder('webhookSubscription'),
    },
  };

  return {
    prisma: {
      ...tx,
      $transaction: async <T>(cb: (client: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    },
    writes,
  };
}

/**
 * Produce the export file the operator would download, through the real export
 * service, then serialise it the way an HTTP response and an uploaded file do.
 */
async function exportedPayload(
  sections: readonly ConfigExportSection[],
  source: {
    readonly settings?: Record<string, unknown> | null;
    readonly webhooks?: ReadonlyArray<Record<string, unknown>>;
  },
): Promise<ConfigExportPayloadInterface> {
  const exportPrisma = {
    settings: { findFirst: async () => source.settings ?? null },
    webhookSubscription: { findMany: async () => source.webhooks ?? [] },
  };
  const payload = await new ConfigExportService(exportPrisma as never).exportConfig([...sections]);
  return JSON.parse(JSON.stringify(payload)) as ConfigExportPayloadInterface;
}

async function runImport(
  payload: ConfigExportPayloadInterface,
  sections: readonly ConfigExportSection[],
  state: DestinationState,
  strategy: 'skip' | 'overwrite' = 'overwrite',
): Promise<{
  readonly writes: RecordedWrite[];
  readonly result: Awaited<ReturnType<ConfigImportService['importConfig']>>;
}> {
  const { prisma, writes } = buildImportPrisma(state);
  const result = await new ConfigImportService(prisma as never).importConfig({
    payload,
    sections: [...sections],
    strategy,
    dryRun: false,
    importerPermissions: IMPORTER,
  });
  return { writes, result };
}

/** The single `settings.update` the import performed, or a readable failure. */
function settingsUpdate(writes: readonly RecordedWrite[]): Record<string, unknown> {
  const updates = writes.filter((w) => w.delegate === 'settings' && w.op === 'update');
  assert.equal(
    updates.length,
    1,
    `expected exactly one settings.update, got ${JSON.stringify(writes.map((w) => `${w.delegate}.${w.op}`))}`,
  );
  return updates[0]!.data;
}

function obj(value: unknown, label: string): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} should be an object, got ${JSON.stringify(value)}`,
  );
  return value as Record<string, unknown>;
}

describe('config import — a redacted export must not erase the secrets it redacted', () => {
  it('writes back every omitted secret from the destination row, not an absent key', async () => {
    const payload = await exportedPayload(['settings'], { settings: sourceSettingsRow() });

    // Vacuity guard. If redaction ever stopped omitting one of these, the case
    // below would be testing nothing, so the file is held to the finding first.
    const exported = obj(
      (payload.sections.settings as unknown[])[0],
      'the exported settings row',
    );
    const exportedNotifications = obj(exported['systemNotifications'], 'exported systemNotifications');
    assert.ok(
      !('botTokenEnc' in exportedNotifications),
      'redaction no longer omits botTokenEnc — this case would prove nothing',
    );
    assert.ok(!('password' in obj(exportedNotifications['email'], 'exported email')));
    assert.ok(!('privateKeyEnc' in obj(exportedNotifications['webPush'], 'exported webPush')));
    assert.ok(!('turnstileSecretEnc' in obj(exported['supportSettings'], 'exported supportSettings')));
    assert.ok(!('apiKeyEnc' in obj(exported['aiSupportSettings'], 'exported aiSupportSettings')));
    const exportedPartners = obj(exported['questPartnerSettings'], 'exported questPartnerSettings')[
      'partners'
    ] as Array<Record<string, unknown>>;
    assert.ok(!('secretEnc' in exportedPartners[0]!));

    const { writes, result } = await runImport(payload, ['settings'], {
      settings: destinationSettingsRow(),
    });

    // The import has to have actually happened; a refusal would preserve the
    // secrets too, and would be a different (also broken) service.
    const summary = result.summaries.find((s) => s.section === 'settings');
    assert.equal(summary?.status, 'imported');
    assert.equal(summary?.updated, 1);

    const data = settingsUpdate(writes);
    const notifications = obj(data['systemNotifications'], 'written systemNotifications');

    assert.equal(
      obj(notifications['email'], 'written email')['password'],
      'destination-smtp-password',
      'the SMTP password was erased by the re-import',
    );
    assert.equal(
      notifications['botTokenEnc'],
      DEST_BOT_TOKEN,
      'the Telegram bot token was erased by the re-import',
    );
    assert.equal(
      obj(notifications['webPush'], 'written webPush')['privateKeyEnc'],
      DEST_VAPID,
      'the VAPID private key was erased by the re-import',
    );
    assert.equal(
      obj(data['supportSettings'], 'written supportSettings')['turnstileSecretEnc'],
      DEST_TURNSTILE,
      'the Turnstile secret was erased by the re-import',
    );
    assert.equal(
      obj(data['aiSupportSettings'], 'written aiSupportSettings')['apiKeyEnc'],
      DEST_AI_KEY,
      'the AI provider key was erased by the re-import',
    );

    const partners = obj(data['questPartnerSettings'], 'written questPartnerSettings')[
      'partners'
    ] as Array<Record<string, unknown>>;
    const acme = partners.find((p) => p['slug'] === 'acme');
    assert.equal(
      acme?.['secretEnc'],
      DEST_ACME_SECRET,
      'the quest partner HMAC secret was erased by the re-import',
    );
  });

  it('still applies every non-secret change the export carries', async () => {
    // The other half of the rule, and the reason a maximally conservative
    // "merge" is not a fix: an import that stops importing is its own outage.
    const { writes } = await runImport(
      await exportedPayload(['settings'], { settings: sourceSettingsRow() }),
      ['settings'],
      { settings: destinationSettingsRow() },
    );
    const data = settingsUpdate(writes);
    const notifications = obj(data['systemNotifications'], 'written systemNotifications');

    // Scalar columns keep plain replace semantics.
    assert.equal(data['rulesLink'], 'https://source.example/rules');
    assert.equal(data['rulesRequired'], true);
    assert.equal(data['channelLink'], 'https://t.me/source');

    // A non-secret sibling of a preserved secret, inside the same nested
    // object: preserving the whole `email` blob would pass the case above and
    // fail here, which is exactly the distinction that matters.
    const email = obj(notifications['email'], 'written email');
    assert.equal(email['host'], 'smtp.source.test');
    assert.equal(email['port'], 587);
    assert.equal(email['user'], 'ops@source.test');

    assert.equal(obj(notifications['telegram'], 'written telegram')['chatId'], '-1001111');
    assert.equal(
      obj(data['supportSettings'], 'written supportSettings')['turnstileSiteKey'],
      'source-site-key',
    );
    assert.equal(
      obj(data['supportSettings'], 'written supportSettings')['enabled'],
      true,
      'a boolean flipped on the source must flip on the destination',
    );
    assert.equal(obj(data['aiSupportSettings'], 'written ai')['model'], 'source-model');
    assert.equal(obj(data['aiSupportSettings'], 'written ai')['baseUrl'], 'https://ai.source.test');

    // A key the source ADDED and the destination has never seen.
    const topics = obj(
      obj(notifications['telegram'], 'written telegram')['topics'],
      'written topics',
    );
    assert.equal(topics['support'], 9, 'a newly added nested key must reach the database');
    assert.equal(topics['billing'], 7, 'a changed nested key must reach the database');

    // Identity-matched array elements are merged, not frozen.
    const partners = obj(data['questPartnerSettings'], 'written quest partners')[
      'partners'
    ] as Array<Record<string, unknown>>;
    assert.equal(
      partners.find((p) => p['slug'] === 'acme')?.['label'],
      'Acme (source)',
      'the source label must win on an identity-matched element',
    );
  });

  it('honours a deletion: an array element the export dropped does not come back', async () => {
    // The merge must not become a union. `questPartnerSettings.partners` has a
    // partner on the destination that the source retired; length and order
    // come from the payload, only the CONTENTS of a matched element are
    // back-filled.
    const { writes } = await runImport(
      await exportedPayload(['settings'], { settings: sourceSettingsRow() }),
      ['settings'],
      { settings: destinationSettingsRow() },
    );
    const partners = obj(settingsUpdate(writes)['questPartnerSettings'], 'written quest partners')[
      'partners'
    ] as Array<Record<string, unknown>>;

    assert.equal(partners.length, 1, `a retired partner was resurrected: ${JSON.stringify(partners)}`);
    assert.equal(partners[0]!['slug'], 'acme');
  });

  it('treats an explicit null as a value that wins, not as an absent key', async () => {
    // The deliberate distinction: ABSENT means "keep what you have" (that is
    // the whole fix), so `null` has to be the way an operator clears a value,
    // or clearing becomes inexpressible. Costs nothing against redaction —
    // `scrub()` drops a secret key outright and never leaves a `null` behind
    // at an object key.
    const { writes } = await runImport(
      await exportedPayload(['settings'], { settings: sourceSettingsRow() }),
      ['settings'],
      { settings: destinationSettingsRow() },
    );
    const policy = obj(settingsUpdate(writes)['platformPolicy'], 'written platformPolicy');

    assert.ok('maintenanceMessage' in policy);
    assert.equal(
      policy['maintenanceMessage'],
      null,
      'an explicit null in the payload must clear the destination value',
    );
    assert.equal(policy['maintenance'], false);
  });

  it('does not merge a String column that merely reads like JSON', async () => {
    // `AdminScopePolicy.actions` is a `String` in schema.prisma despite the
    // name. Deciding what to merge by NAME would corrupt it; the merge is
    // decided by SHAPE, so a string on either side replaces wholesale.
    const payload: ConfigExportPayloadInterface = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: 'rezeis-admin',
      manifest: { scopePolicies: 1 },
      sections: {
        scopePolicies: [
          { id: 'sp-1', resourceType: 'users', scopeType: 'region', scopeValue: 'eu', actions: 'read' },
        ],
      },
    };
    const { writes } = await runImport(payload, ['scopePolicies'], {
      scopePolicies: [
        { id: 'sp-1', resourceType: 'users', scopeType: 'region', scopeValue: 'apac', actions: 'read,write,delete' },
      ],
    });

    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.op, 'update');
    assert.equal(
      writes[0]!.data['actions'],
      'read',
      'a String column was merged as if it were Json',
    );
    assert.equal(writes[0]!.data['scopeValue'], 'eu');
  });

  it('leaves a secret held in its own column out of the update entirely', async () => {
    // `webhooks.secret` is a top-level `String` the allowlist withholds, and it
    // was never at risk: an absent COLUMN is simply not in `data`, so Prisma
    // leaves it alone. Pinned so the difference between the two failure modes
    // stays visible — it is why the fix belongs inside Json values only.
    const payload = await exportedPayload(['webhooks'], {
      webhooks: [
        {
          id: 'wh-1',
          name: 'Ops',
          url: 'https://hooks.source.test/ops',
          secret: 'source-signing-secret',
          eventTypes: ['payment.succeeded'],
          isActive: true,
        },
      ],
    });
    const { writes } = await runImport(payload, ['webhooks'], {
      webhooks: [{ id: 'wh-1', name: 'Ops', url: 'https://old', secret: 'destination-signing-secret', eventTypes: [] }],
    });

    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.op, 'update');
    assert.ok(
      !('secret' in writes[0]!.data),
      'the redacted export must not write the secret column at all',
    );
    assert.equal(writes[0]!.data['url'], 'https://hooks.source.test/ops');
  });

  it('leaves the create path alone when the destination has no settings row', async () => {
    // Nothing to merge against, so the payload is written verbatim under id 1 —
    // unchanged behaviour, and the branch a merge could most easily break.
    const { writes, result } = await runImport(
      await exportedPayload(['settings'], { settings: sourceSettingsRow() }),
      ['settings'],
      { settings: null },
    );

    assert.equal(result.summaries.find((s) => s.section === 'settings')?.created, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.op, 'create');
    assert.equal(writes[0]!.data['id'], 1);
    const notifications = obj(writes[0]!.data['systemNotifications'], 'created systemNotifications');
    assert.ok(
      !('botTokenEnc' in notifications),
      'a fresh row cannot invent a secret the file does not carry',
    );
    assert.equal(obj(notifications['email'], 'created email')['host'], 'smtp.source.test');
  });

  it('leaves the destination untouched under strategy=skip', async () => {
    const { writes, result } = await runImport(
      await exportedPayload(['settings'], { settings: sourceSettingsRow() }),
      ['settings'],
      { settings: destinationSettingsRow() },
      'skip',
    );

    assert.deepEqual(writes, [], 'skip must not write anything at all');
    assert.equal(result.summaries.find((s) => s.section === 'settings')?.skipped, 1);
  });
});
