import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConfigExportService,
  type ConfigExportPayloadInterface,
  type ConfigExportSection,
} from '../src/modules/config-portability/services/config-export.service';
import { ConfigImportService } from '../src/modules/config-portability/services/config-import.service';
import { readSettingsRowGeneration } from '../src/modules/settings/utils/settings-row-write.util';

/**
 * A config import of the settings section invalidates the settings row cache
 * ══════════════════════════════════════════════════════════════════════════
 * `SettingsService` serves the settings row from a five-second cache, valid only
 * while the settings-write generation it was fetched under is current. An
 * import rewrites that row in a transaction of its own, so `runSection` opens
 * the settings section's transaction through `runSettingsWriteTransaction` —
 * the call that bumps the generation once it settles. Opened any other way, the
 * API kept serving the pre-import row after the import answered.
 *
 * `settings-row-write-invariant.spec.ts` only proves the file calls the helper
 * SOMEWHERE; the condition choosing it (`section === 'settings'`) could name
 * any other section and still type-check. This pins it by behaviour: the
 * generation moves across a settings import, and does not across an import of
 * a section that never touches the row.
 */

const IMPORTER = new Set(['config_portability:import', 'settings:edit', 'webhooks:create', 'webhooks:edit']);

function settingsRow(): Record<string, unknown> {
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
    systemNotifications: {},
    platformPolicy: {},
    userNotifications: {},
    referralSettings: {},
    partnerSettings: {},
    questPartnerSettings: {},
    multiSubscriptionSettings: {},
    brandingSettings: { brandName: 'Imported' },
    supportSettings: {},
    botMenuSettings: {},
    remnawaveCleanupSettings: {},
    customIcons: [],
    aiSupportSettings: {},
    antiFraudSettings: {},
    updatedAt: new Date('2026-08-01T10:00:00.000Z'),
  };
}

async function exportedPayload(
  sections: readonly ConfigExportSection[],
  source: { readonly settings?: Record<string, unknown>; readonly webhooks?: ReadonlyArray<Record<string, unknown>> },
): Promise<ConfigExportPayloadInterface> {
  const exportPrisma = {
    settings: { findFirst: async () => source.settings ?? null },
    webhookSubscription: { findMany: async () => source.webhooks ?? [] },
  };
  const payload = await new ConfigExportService(exportPrisma as never).exportConfig([...sections]);
  return JSON.parse(JSON.stringify(payload)) as ConfigExportPayloadInterface;
}

function importPrisma(destination: Record<string, unknown>) {
  const writes: string[] = [];
  const record = (name: string) => ({
    create: async ({ data }: { data: Record<string, unknown> }) => {
      writes.push(`${name}.create`);
      return data;
    },
    update: async ({ data }: { data: Record<string, unknown> }) => {
      writes.push(`${name}.update`);
      return data;
    },
  });
  const tx = {
    $queryRaw: async () => [{ id: destination.id }],
    $executeRaw: async () => 0,
    settings: {
      findFirst: async () => destination,
      findUnique: async () => destination,
      ...record('settings'),
    },
    webhookSubscription: {
      findUnique: async () => null,
      findFirst: async () => null,
      ...record('webhookSubscription'),
    },
  };
  return {
    writes,
    prisma: { ...tx, $transaction: async <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => work(tx) },
  };
}

describe('config import — the settings section bumps the settings-write generation', () => {
  it('moves the generation across an import of the settings section', async () => {
    const payload = await exportedPayload(['settings'], { settings: settingsRow() });
    const { prisma, writes } = importPrisma(settingsRow());

    const before = readSettingsRowGeneration();
    const result = await new ConfigImportService(prisma as never).importConfig({
      payload,
      sections: ['settings'],
      strategy: 'overwrite',
      dryRun: false,
      importerPermissions: IMPORTER,
    });

    assert.equal(result.summaries.find((s) => s.section === 'settings')?.status, 'imported');
    assert.deepStrictEqual(writes, ['settings.update'], 'the import did rewrite the row');
    assert.ok(
      readSettingsRowGeneration() > before,
      'the settings section must run in runSettingsWriteTransaction, or the API keeps serving the pre-import row',
    );
  });

  it('leaves the generation alone for a section that never writes the row (control)', async () => {
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
    const { prisma, writes } = importPrisma(settingsRow());

    const before = readSettingsRowGeneration();
    await new ConfigImportService(prisma as never).importConfig({
      payload,
      sections: ['webhooks'],
      strategy: 'overwrite',
      dryRun: false,
      importerPermissions: IMPORTER,
    });

    assert.deepStrictEqual(writes, ['webhookSubscription.create'], 'the webhooks section did run');
    assert.equal(readSettingsRowGeneration(), before);
  });
});
