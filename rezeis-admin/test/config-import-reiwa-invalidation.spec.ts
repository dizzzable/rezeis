import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ReiwaCacheInvalidatorService } from '../src/modules/bot-config/services/reiwa-cache-invalidator.service';
import { ConfigPortabilityModule } from '../src/modules/config-portability/config-portability.module';
import {
  CONFIG_EXPORT_VERSION,
  type ConfigExportPayloadInterface,
  type ConfigExportSection,
} from '../src/modules/config-portability/services/config-export.service';
import {
  ConfigImportService,
  type ConfigImportResultInterface,
  type ImportStrategy,
} from '../src/modules/config-portability/services/config-import.service';
import { ReiwaRelayModule } from '../src/modules/notifications/reiwa-relay.module';
import { readSettingsRowGeneration } from '../src/modules/settings/utils/settings-row-write.util';

/**
 * A config import reaches the cabinet and the bot as soon as it commits
 * ════════════════════════════════════════════════════════════════════
 * The settings section writes the whole settings row: branding, custom icons,
 * the default currency, `platformPolicy` (project name, web title, the access
 * gates beside it) and `systemNotifications` (SMTP, custom emoji packs, the
 * premium-emoji switch). Each of those has a screen of its own, and each screen
 * tells reiwa after its save — `reiwa.branding.invalidate` for the cabinet's
 * public-config and pack list, `reiwa.platform.policy_invalidated` for the
 * access policy, `reiwa.bot.invalidate` for the bot's config. The import sent
 * none of them, so after it the cabinet served the old public-config for up to
 * 60 seconds and the bot the old emoji for up to five minutes. Legal documents
 * likewise: their own save drops the policy (which carries the bot's copy of
 * the documents), the import did not.
 *
 * Only what COMMITTED is announced: not a dry run, not a skipped row, not a
 * section that rolled back. And only after the commit, when the settings-write
 * generation has already moved, so the cabinet's re-read cannot be answered
 * from the panel's pre-import row cache.
 */

const IMPORTER = new Set([
  'config_portability:import',
  'settings:edit',
  'webhooks:create',
  'webhooks:edit',
]);

function storedSettings(): Record<string, unknown> {
  return {
    id: 1,
    rulesRequired: false,
    channelRequired: false,
    rulesLink: null,
    channelId: null,
    channelLink: null,
    accessMode: 'PUBLIC',
    inviteModeStartedAt: null,
    defaultCurrency: 'USD',
    systemNotifications: { customEmojiPacks: [] },
    platformPolicy: { projectName: 'Destination' },
    brandingSettings: { brandName: 'Destination' },
    customIcons: [],
    updatedAt: new Date('2026-08-01T10:00:00.000Z'),
  };
}

function importedSettings(): Record<string, unknown> {
  return {
    id: 1,
    rulesRequired: true,
    channelRequired: false,
    rulesLink: 'https://source.example/rules',
    channelId: null,
    channelLink: null,
    accessMode: 'INVITED',
    inviteModeStartedAt: null,
    defaultCurrency: 'RUB',
    systemNotifications: {
      customEmojiPacks: [{ slug: 'source', name: 'Source', emojis: [] }],
      botEmoji: { ownerHasPremium: false },
    },
    platformPolicy: { projectName: 'Source', webTitle: 'Source VPN' },
    brandingSettings: { brandName: 'Source' },
    updatedAt: '2026-08-02T10:00:00.000Z',
  };
}

function payloadOf(sections: Partial<Record<ConfigExportSection, unknown[]>>): ConfigExportPayloadInterface {
  return JSON.parse(
    JSON.stringify({
      version: CONFIG_EXPORT_VERSION,
      exportedAt: '2026-08-02T10:00:00.000Z',
      source: 'rezeis-admin',
      sections,
    }),
  ) as ConfigExportPayloadInterface;
}

interface Harness {
  readonly service: ConfigImportService;
  /** Writes, 'commit' / 'rollback', and every invalidation as `<event>:<reason>`, in order. */
  readonly log: string[];
  /** The settings-write generation each invalidation was enqueued under. */
  readonly generationAtEnqueue: number[];
}

/**
 * A transaction-aware double: 'commit' is logged only when the section's
 * transaction callback resolved, 'rollback' when it threw.
 */
function harness(options: {
  readonly settingsRow?: Record<string, unknown> | null;
  readonly legalDocument?: Record<string, unknown> | null;
  readonly failSettingsWrite?: boolean;
} = {}): Harness {
  const log: string[] = [];
  const generationAtEnqueue: number[] = [];
  const settingsRow = options.settingsRow === undefined ? storedSettings() : options.settingsRow;
  const writer = (name: string, fail = false) => async ({ data }: { data: Record<string, unknown> }) => {
    if (fail) throw new Error(`${name} rejected the write`);
    log.push(name);
    return { id: 1, ...data };
  };
  const tx = {
    $queryRaw: async () => (settingsRow === null ? [] : [{ id: settingsRow.id }]),
    $executeRaw: async () => 0,
    settings: {
      findFirst: async () => settingsRow,
      update: writer('settings.update', options.failSettingsWrite === true),
      create: writer('settings.create', options.failSettingsWrite === true),
    },
    legalDocument: {
      findUnique: async () => options.legalDocument ?? null,
      update: writer('legalDocument.update'),
      create: writer('legalDocument.create'),
    },
    webhookSubscription: {
      findUnique: async () => null,
      update: writer('webhookSubscription.update'),
      create: writer('webhookSubscription.create'),
    },
  };
  const prisma = {
    ...tx,
    $transaction: async <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => {
      try {
        const result = await work(tx);
        log.push('commit');
        return result;
      } catch (error) {
        log.push('rollback');
        throw error;
      }
    },
  };
  const record = (event: string) => async (reason: string): Promise<void> => {
    log.push(`${event}:${reason}`);
    generationAtEnqueue.push(readSettingsRowGeneration());
  };
  const invalidator = {
    invalidate: record('bot'),
    invalidatePolicy: record('policy'),
    invalidateBranding: record('branding'),
  } satisfies Pick<ReiwaCacheInvalidatorService, 'invalidate' | 'invalidatePolicy' | 'invalidateBranding'>;
  const service = new ConfigImportService(prisma as never, invalidator as unknown as ReiwaCacheInvalidatorService);
  return { service, log, generationAtEnqueue };
}

function runImport(
  target: Harness,
  payload: ConfigExportPayloadInterface,
  sections: ConfigExportSection[],
  overrides: { readonly strategy?: ImportStrategy; readonly dryRun?: boolean } = {},
): Promise<ConfigImportResultInterface> {
  return target.service.importConfig({
    payload,
    sections,
    strategy: overrides.strategy ?? 'overwrite',
    dryRun: overrides.dryRun ?? false,
    importerPermissions: IMPORTER,
  });
}

function statusOf(result: ConfigImportResultInterface, section: ConfigExportSection): string | undefined {
  return result.summaries.find((entry) => entry.section === section)?.status;
}

const invalidations = (log: readonly string[]): string[] =>
  log.filter((entry) => /^(bot|policy|branding):/.test(entry));

describe('config import — the cabinet and the bot hear about what the import committed', () => {
  it('settings: drops the public-config, the platform policy and the bot config, after the commit', async () => {
    const target = harness();
    const before = readSettingsRowGeneration();

    const result = await runImport(target, payloadOf({ settings: [importedSettings()] }), ['settings']);

    assert.equal(statusOf(result, 'settings'), 'imported');
    assert.deepStrictEqual(
      [...invalidations(target.log)].sort(),
      ['bot:config-import.settings', 'branding:config-import.settings', 'policy:config-import.settings'],
      `got ${JSON.stringify(target.log)}`,
    );
    const committedAt = target.log.indexOf('commit');
    assert.ok(committedAt >= 0 && target.log.indexOf('settings.update') < committedAt, JSON.stringify(target.log));
    for (const entry of invalidations(target.log)) {
      assert.ok(target.log.indexOf(entry) > committedAt, `${entry} must follow the commit: ${JSON.stringify(target.log)}`);
    }
    assert.ok(
      target.generationAtEnqueue.every((generation) => generation > before),
      'enqueued before the settings-write generation moved: the re-read would get the pre-import row',
    );
  });

  it('settings created from the payload on an empty table: the same three', async () => {
    const target = harness({ settingsRow: null });

    await runImport(target, payloadOf({ settings: [importedSettings()] }), ['settings']);

    assert.ok(target.log.includes('settings.create'), JSON.stringify(target.log));
    assert.deepStrictEqual(
      [...invalidations(target.log)].sort(),
      ['bot:config-import.settings', 'branding:config-import.settings', 'policy:config-import.settings'],
    );
  });

  it('legalDocuments: drops the platform policy, which carries the documents, after the commit', async () => {
    const target = harness({ legalDocument: { key: 'USER_AGREEMENT', isActive: false, titleRu: '', titleEn: '', bodyRu: '', bodyEn: '' } });
    const documents = [{ key: 'USER_AGREEMENT', isActive: true, titleRu: 'Соглашение', titleEn: 'Agreement', bodyRu: 'Текст', bodyEn: 'Text' }];

    const result = await runImport(target, payloadOf({ legalDocuments: documents }), ['legalDocuments']);

    assert.equal(statusOf(result, 'legalDocuments'), 'imported');
    assert.deepStrictEqual(invalidations(target.log), ['policy:config-import.legalDocuments'], JSON.stringify(target.log));
    assert.ok(target.log.indexOf('commit') < target.log.indexOf('policy:config-import.legalDocuments'));
  });

  it('a dry run drops nothing: nothing was committed (control)', async () => {
    const target = harness();

    const result = await runImport(target, payloadOf({ settings: [importedSettings()] }), ['settings'], { dryRun: true });

    assert.equal(statusOf(result, 'settings'), 'imported');
    assert.ok(target.log.includes('rollback'), JSON.stringify(target.log));
    assert.deepStrictEqual(invalidations(target.log), []);
  });

  it('skip on an existing settings row drops nothing: nothing was written (control)', async () => {
    const target = harness();

    await runImport(target, payloadOf({ settings: [importedSettings()] }), ['settings'], { strategy: 'skip' });

    assert.ok(!target.log.includes('settings.update'), JSON.stringify(target.log));
    assert.deepStrictEqual(invalidations(target.log), []);
  });

  it('a settings section that rolled back drops nothing (control)', async () => {
    const target = harness({ failSettingsWrite: true });

    const result = await runImport(target, payloadOf({ settings: [importedSettings()] }), ['settings']);

    assert.equal(statusOf(result, 'settings'), 'failed');
    assert.deepStrictEqual(invalidations(target.log), []);
  });

  it('a section only the panel reads drops nothing (control)', async () => {
    const target = harness();
    const webhooks = [{ id: 'wh-1', name: 'Ops', url: 'https://hooks.example/ops', secret: 's', eventTypes: ['*'], isActive: true }];

    await runImport(target, payloadOf({ webhooks }), ['webhooks']);

    assert.ok(target.log.includes('webhookSubscription.create'), JSON.stringify(target.log));
    assert.deepStrictEqual(invalidations(target.log), []);
  });
});

describe('ConfigPortabilityModule wiring for the invalidations', () => {
  // The service takes the invalidator as `@Optional()` (specs construct it
  // positionally), so a module that forgot to provide it would boot cleanly and
  // inject `undefined`: no import would ever reach reiwa while every case above
  // stayed green.
  it('declares ReiwaCacheInvalidatorService and imports the relay queue it enqueues through', () => {
    const providers = Reflect.getMetadata('providers', ConfigPortabilityModule) as readonly unknown[];
    const imports = Reflect.getMetadata('imports', ConfigPortabilityModule) as readonly unknown[];
    assert.ok(providers.includes(ReiwaCacheInvalidatorService), 'the module must provide the invalidator');
    assert.ok(imports.includes(ReiwaRelayModule), 'the invalidator enqueues through ReiwaRelayModule');
    const params = Reflect.getMetadata('design:paramtypes', ConfigImportService) as readonly unknown[];
    assert.ok(params.includes(ReiwaCacheInvalidatorService), 'the service must take it by injection');
  });
});
