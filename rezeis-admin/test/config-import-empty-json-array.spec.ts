/**
 * An empty top-level `Json` array in an import must not wipe the destination.
 *
 * The finding
 * ───────────
 * `stripRelationFields` keeps a top-level array only when every element is a
 * string — the shape of a `String[]` column (`webhooks.eventTypes`,
 * `faqItems.mediaUrls`). The three top-level `Json` array columns in the import
 * hold OBJECTS, so their arrays are dropped and never reach the destination:
 *
 *   settings.customIcons            [{ id, name, url, color }]
 *   notificationTemplates.buttons   [{ labelRu, kind, target, … }]
 *   automations.actions             [{ type, params }]
 *
 * But `[].every(...)` is true. An EMPTY array of any of them passed the filter
 * and replaced the destination's list with nothing. Promote a staging config
 * that never had custom icons, and production's icon library was gone — while a
 * staging config with even one icon would have left production's alone. The
 * same for a template's buttons, and for an automation's actions together with
 * the Authorization headers the export had redacted out of them.
 *
 * The rule now: an empty array replaces only a stored list of strings, which is
 * what an emptied `String[]` column is. Over anything else it is left out of the
 * write, exactly like the non-empty arrays of that column.
 *
 * Every case drives the real `ConfigImportService.importConfig` against a
 * recording Prisma double, and reads the destination row as Prisma would leave
 * it: the stored row with the written columns replaced.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  ConfigExportPayloadInterface,
  ConfigExportSection,
} from '../src/modules/config-portability/services/config-export.service';
import { ConfigImportService } from '../src/modules/config-portability/services/config-import.service';

const IMPORTER = new Set([
  'config_portability:import',
  'settings:edit',
  'notifications:edit',
  'automations:create',
  'automations:edit',
  'webhooks:create',
  'webhooks:edit',
  'faq:create',
  'faq:edit',
]);

type Row = Record<string, unknown>;

/** The destination, one delegate per table; `settings` is the singleton. */
interface Destination {
  settings?: Row;
  notificationTemplate?: Row[];
  automationRule?: Row[];
  webhookSubscription?: Row[];
  faqItem?: Row[];
}

interface RecordedWrite {
  readonly delegate: string;
  readonly op: 'create' | 'update';
  readonly data: Row;
}

/**
 * A Prisma double that applies writes the way Prisma does: `update` replaces the
 * columns present in `data` and leaves every other column as it was.
 */
function buildPrisma(destination: Destination): { readonly prisma: unknown; readonly writes: RecordedWrite[] } {
  const writes: RecordedWrite[] = [];
  const table = (name: 'notificationTemplate' | 'automationRule' | 'webhookSubscription' | 'faqItem') => ({
    findUnique: async ({ where }: { where: { id: string } }) =>
      destination[name]?.find((row) => row['id'] === where.id) ?? null,
    findFirst: async () => null,
    create: async ({ data }: { data: Row }) => {
      writes.push({ delegate: name, op: 'create', data });
      (destination[name] ??= []).push({ ...data });
      return data;
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      writes.push({ delegate: name, op: 'update', data });
      const rows = destination[name] ?? [];
      const index = rows.findIndex((row) => row['id'] === where.id);
      rows[index] = { ...rows[index], ...data };
      return rows[index];
    },
  });
  const tx = {
    // The settings row lock and the savepoint of the create path; not writes.
    $queryRaw: async () => (destination.settings ? [{ id: destination.settings['id'] }] : []),
    $executeRaw: async () => 0,
    settings: {
      findFirst: async () => destination.settings ?? null,
      findUnique: async () => destination.settings ?? null,
      create: async ({ data }: { data: Row }) => {
        writes.push({ delegate: 'settings', op: 'create', data });
        destination.settings = { ...data };
        return data;
      },
      update: async ({ data }: { data: Row }) => {
        writes.push({ delegate: 'settings', op: 'update', data });
        destination.settings = { ...destination.settings, ...data };
        return destination.settings;
      },
    },
    notificationTemplate: table('notificationTemplate'),
    automationRule: table('automationRule'),
    webhookSubscription: table('webhookSubscription'),
    faqItem: table('faqItem'),
  };
  return {
    prisma: { ...tx, $transaction: async <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => work(tx) },
    writes,
  };
}

async function importOverwrite(
  destination: Destination,
  sections: Partial<Record<ConfigExportSection, Row[]>>,
): Promise<RecordedWrite[]> {
  const { prisma, writes } = buildPrisma(destination);
  const names = Object.keys(sections) as ConfigExportSection[];
  const payload: ConfigExportPayloadInterface = {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: 'rezeis-admin',
    manifest: Object.fromEntries(names.map((name) => [name, sections[name]!.length])),
    sections,
  };
  const result = await new ConfigImportService(prisma as never).importConfig({
    payload,
    sections: names,
    strategy: 'overwrite',
    dryRun: false,
    importerPermissions: IMPORTER,
  });
  for (const summary of result.summaries) {
    // The import has to have happened: a refused or failed section would keep
    // the destination too, and prove nothing.
    assert.equal(summary.status, 'imported', `${summary.section}: ${summary.errors.join(' ')}`);
    assert.equal(summary.updated, sections[summary.section]!.length, `${summary.section} must update its rows`);
  }
  return writes;
}

function update(writes: readonly RecordedWrite[], delegate: string): Row {
  const matching = writes.filter((write) => write.delegate === delegate && write.op === 'update');
  assert.equal(matching.length, 1, `one ${delegate}.update: ${JSON.stringify(writes.map((w) => `${w.delegate}.${w.op}`))}`);
  return matching[0]!.data;
}

const DESTINATION_ICONS = [
  { id: 'icon-crown', name: 'Crown', url: '/uploads/icons/crown.svg', color: '#f5b301' },
  { id: 'icon-rocket', name: 'Rocket', url: '/uploads/icons/rocket.png', color: null },
];

function destinationSettings(): Row {
  return {
    id: 1,
    rulesLink: 'https://destination.example/rules',
    customIcons: structuredClone(DESTINATION_ICONS),
    updatedAt: new Date('2026-07-01T10:00:00.000Z'),
  };
}

describe('config import — an empty top-level Json array does not overwrite the destination', () => {
  it('settings: customIcons [] keeps the destination’s icons, as a source with icons of its own does', async () => {
    // A staging config that never had icons, and one that has an icon of its
    // own: the destination's library must come out of both the same.
    for (const customIcons of [[], [{ id: 'icon-staging', name: 'Staging', url: '/uploads/icons/s.svg', color: null }]]) {
      const destination: Destination = { settings: destinationSettings() };

      const writes = await importOverwrite(destination, {
        settings: [{ id: 1, rulesLink: 'https://source.example/rules', customIcons }],
      });

      const written = update(writes, 'settings');
      assert.equal(written['rulesLink'], 'https://source.example/rules', 'the rest of the row is still imported');
      assert.ok(!('customIcons' in written), `customIcons ${JSON.stringify(customIcons)} must not be written: ${JSON.stringify(written['customIcons'])}`);
      assert.deepStrictEqual(destination.settings!['customIcons'], DESTINATION_ICONS);
    }
  });

  it('notificationTemplates: buttons [] keeps the destination’s buttons', async () => {
    const buttons = [
      { labelRu: 'Продлить', labelEn: 'Renew', kind: 'webApp', target: '/renew', style: 'primary', row: 0 },
      { labelRu: 'Поддержка', labelEn: 'Support', kind: 'url', target: 'https://t.me/support', row: 1 },
    ];
    const destination: Destination = {
      notificationTemplate: [
        { id: 'tpl-expiring', type: 'SUBSCRIPTION_EXPIRING', title: 'Old title', body: 'Old body', buttons: structuredClone(buttons), isActive: true },
      ],
    };

    const writes = await importOverwrite(destination, {
      notificationTemplates: [
        { id: 'tpl-expiring', type: 'SUBSCRIPTION_EXPIRING', title: 'New title', body: 'New body', buttons: [], isActive: true },
      ],
    });

    const written = update(writes, 'notificationTemplate');
    assert.equal(written['title'], 'New title', 'the rest of the template is still imported');
    assert.ok(!('buttons' in written), `buttons [] must not be written: ${JSON.stringify(written['buttons'])}`);
    assert.deepStrictEqual(destination.notificationTemplate![0]!['buttons'], buttons);
  });

  it('automations: actions [] keeps the destination’s actions, and the Authorization header inside them', async () => {
    const actions = [
      { type: 'webhook_post', params: { url: 'https://ops.example/hook', authorizationHeader: 'Bearer destination-token' } },
    ];
    const destination: Destination = {
      automationRule: [
        { id: 'auto-1', name: 'Old name', isEnabled: true, triggerKind: 'REALTIME', triggerSpec: 'payment.succeeded', actions: structuredClone(actions) },
      ],
    };

    const writes = await importOverwrite(destination, {
      automations: [
        { id: 'auto-1', name: 'New name', isEnabled: false, triggerKind: 'REALTIME', triggerSpec: 'payment.succeeded', actions: [] },
      ],
    });

    const written = update(writes, 'automationRule');
    assert.equal(written['name'], 'New name', 'the rest of the rule is still imported');
    assert.equal(written['isEnabled'], false);
    assert.ok(!('actions' in written), `actions [] must not be written: ${JSON.stringify(written['actions'])}`);
    assert.deepStrictEqual(destination.automationRule![0]!['actions'], actions);
  });

  it('an emptied String[] column still clears: eventTypes [] and mediaUrls [] replace the destination’s lists (control)', async () => {
    // The other half of the rule. An empty list of strings is a real value — a
    // FAQ entry whose media were all removed — and must still reach the
    // destination.
    const destination: Destination = {
      webhookSubscription: [
        { id: 'wh-1', name: 'Ops', url: 'https://hooks.example/ops', secret: 'destination-secret', eventTypes: ['payment.succeeded'], isActive: true },
      ],
      faqItem: [
        { id: 'faq-1', question: 'Q', answer: 'A', mediaUrls: ['/uploads/faq/1.png', '/uploads/faq/2.png'], orderIndex: 0, isActive: true, locale: 'ru' },
      ],
    };

    const writes = await importOverwrite(destination, {
      webhooks: [{ id: 'wh-1', name: 'Ops', url: 'https://hooks.example/ops', eventTypes: [], isActive: true }],
      faqItems: [{ id: 'faq-1', question: 'Q', answer: 'A', mediaUrls: [], orderIndex: 0, isActive: true, locale: 'ru' }],
    });

    assert.deepStrictEqual(update(writes, 'webhookSubscription')['eventTypes'], []);
    assert.deepStrictEqual(destination.webhookSubscription![0]!['eventTypes'], []);
    assert.deepStrictEqual(update(writes, 'faqItem')['mediaUrls'], []);
    assert.deepStrictEqual(destination.faqItem![0]!['mediaUrls'], []);
  });
});
