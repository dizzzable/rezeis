/**
 * `config_portability:import` was still a superset of three more permissions.
 *
 * The five security-bearing sections (settings, webhooks, automations,
 * adminIpAllowlist, blockedIps) were gated, and `test/config-import-section-permissions.spec.ts`
 * holds that line. What was NOT fixed was the mechanism that let them go
 * ungated: `SECTION_REQUIRED_PERMISSIONS` was `Partial<Record<…>>` and
 * `collectMissingSectionPermissions` read `if (required === undefined) continue`,
 * so "absent from the map" meant "no permission required". Absence is not a
 * decision. Three sections that DO have a gate on their own screen fell
 * straight through it:
 *
 *   notificationTemplates  `notifications:edit` on every write in
 *                          AdminNotificationTemplatesController — the text and
 *                          buttons of the messages sent to every subscriber
 *   faqItems               `faq:create` on POST, `faq:edit` on PATCH in
 *                          AdminFaqController — public help content
 *   legalDocuments         `settings:edit` on the one PATCH in
 *                          AdminLegalDocumentsController — and this deployment
 *                          stores `user_legal_consents` rows saying a
 *                          subscriber agreed to THESE documents, so rewriting a
 *                          body retroactively changes what every stored consent
 *                          refers to
 *
 * Every case here drives the real `ConfigImportService.importConfig` against a
 * recording Prisma double and asserts WHAT REACHED THE DATABASE. A refusal that
 * threw after touching a row would pass a test that only checked for a throw,
 * so the assertion is always on the recorded writes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';

import {
  ALL_SECTIONS,
  type ConfigExportPayloadInterface,
  type ConfigExportSection,
} from '../src/modules/config-portability/services/config-export.service';
import { ConfigImportService } from '../src/modules/config-portability/services/config-import.service';

/** What an importer holding nothing else has. */
const IMPORT_ONLY = new Set(['config_portability:import']);

interface RecordedWrite {
  readonly op: 'create' | 'update';
  readonly delegate: string;
  readonly data: Record<string, unknown>;
}

/**
 * Recording Prisma double. Every delegate resolves its lookup to `null` so the
 * CREATE branch is taken — a gate is only proven by the absence of a write, and
 * a double that could not write in the first place proves nothing.
 */
function buildRecordingStub(): {
  readonly prisma: unknown;
  readonly writes: RecordedWrite[];
} {
  const writes: RecordedWrite[] = [];
  const delegate = (name: string) => ({
    // `adminRole.findUnique` doubles as the orphan check for `permissions`, so
    // it has to resolve or that section could never write at all.
    findUnique: async () => (name === 'adminRole' ? { id: 'role-1', isSystem: false } : null),
    findFirst: async () => null,
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
    adminRole: delegate('adminRole'),
    adminPermission: delegate('adminPermission'),
    adminScopePolicy: delegate('adminScopePolicy'),
    automationRule: delegate('automationRule'),
    webhookSubscription: delegate('webhookSubscription'),
    notificationTemplate: delegate('notificationTemplate'),
    settings: delegate('settings'),
    blockedIp: delegate('blockedIp'),
    adminIpAllowlist: delegate('adminIpAllowlist'),
    faqItem: delegate('faqItem'),
    legalDocument: delegate('legalDocument'),
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
 * A row per section that the import will genuinely try to write. Anything that
 * `upsertById`/`upsertLegalDocuments` would skip (missing id, unknown key)
 * would make a "nothing was written" assertion pass for the wrong reason.
 */
const ROWS: Readonly<Record<ConfigExportSection, ReadonlyArray<Record<string, unknown>>>> = {
  roles: [{ id: 'role-x', name: 'ops_team', displayName: 'Ops' }],
  permissions: [{ id: 'p-1', roleId: 'role-1', resource: 'faq', action: 'view' }],
  scopePolicies: [
    { id: 'sp-1', resourceType: 'users', scopeType: 'region', scopeValue: 'eu', actions: 'read' },
  ],
  automations: [
    { id: 'auto-1', name: 'x', isEnabled: true, triggerKind: 'REALTIME', triggerSpec: '*' },
  ],
  webhooks: [
    { id: 'wh-1', name: 'w', url: 'https://attacker.example.test/x', eventTypes: ['*'], isActive: true },
  ],
  notificationTemplates: [
    {
      id: 'tpl-1',
      type: 'subscription_expiring',
      title: 'Your access has been suspended',
      body: 'Pay here to restore it: https://attacker.example.test/pay',
      isActive: true,
    },
  ],
  settings: [{ id: 1, rulesLink: 'https://attacker.example.test/rules' }],
  blockedIps: [{ id: 'b-1', address: '203.0.113.7', source: 'manual' }],
  adminIpAllowlist: [{ id: 'ip-1', address: '203.0.113.7/32', label: 'mine', isActive: true }],
  faqItems: [{ id: 'faq-1', question: 'How do I pay?', answer: 'https://attacker.example.test/pay' }],
  legalDocuments: [
    {
      key: 'USER_AGREEMENT',
      isActive: true,
      titleRu: 'Пользовательское соглашение',
      titleEn: 'User agreement',
      bodyRu: 'Вы соглашаетесь на передачу ваших данных третьим лицам.',
      bodyEn: 'You consent to the transfer of your data to third parties.',
    },
  ],
};

/** Sections whose entry in `SECTION_REQUIRED_PERMISSIONS` is deliberately empty. */
const DELIBERATELY_UNGATED: readonly ConfigExportSection[] = ['scopePolicies'];

/** The tokens each of the three newly gated sections must demand. */
const NEWLY_GATED: Readonly<Partial<Record<ConfigExportSection, readonly string[]>>> = {
  notificationTemplates: ['notifications:edit'],
  faqItems: ['faq:create', 'faq:edit'],
  legalDocuments: ['settings:edit'],
};

function payloadFor(section: ConfigExportSection): ConfigExportPayloadInterface {
  const rows = ROWS[section];
  return {
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    source: 'rezeis-admin',
    manifest: { [section]: rows.length },
    sections: { [section]: [...rows] },
  };
}

async function importSection(
  section: ConfigExportSection,
  permissions: ReadonlySet<string>,
): Promise<{
  readonly writes: RecordedWrite[];
  readonly error: Error | null;
  readonly result: Awaited<ReturnType<ConfigImportService['importConfig']>> | null;
}> {
  const { prisma, writes } = buildRecordingStub();
  const service = new ConfigImportService(prisma as never);
  try {
    const result = await service.importConfig({
      payload: payloadFor(section),
      sections: [section],
      strategy: 'overwrite',
      dryRun: false,
      importerPermissions: permissions,
    });
    return { writes, error: null, result };
  } catch (err) {
    return { writes, error: err as Error, result: null };
  }
}

describe('config import — the legal documents a subscriber consented to are not open to an importer', () => {
  it('refuses a legalDocuments section from an admin holding only config_portability:import', async () => {
    // The headline. `user_legal_consents` rows point at these two documents by
    // key; rewriting a body retroactively changes what every recorded consent
    // says the subscriber agreed to, and the panel's own screen demands
    // `settings:edit` for the same edit.
    const { writes, error } = await importSection('legalDocuments', IMPORT_ONLY);

    assert.ok(
      error instanceof BadRequestException,
      `expected a 400 refusal, got ${error === null ? 'a successful import' : String(error)}`,
    );
    assert.match(error.message, /legalDocuments/);
    assert.match(error.message, /settings:edit/);
    assert.deepEqual(
      writes,
      [],
      'the refused import still reached the database — a gate that throws after writing is not a gate',
    );
  });

  it('lets the same import through once the admin holds settings:edit', async () => {
    // The other half. A gate that refuses everyone is an outage, not a fix.
    const { writes, error, result } = await importSection(
      'legalDocuments',
      new Set(['config_portability:import', 'settings:edit']),
    );

    assert.equal(error, null);
    assert.equal(result?.summaries.find((s) => s.section === 'legalDocuments')?.status, 'imported');
    assert.equal(writes.length, 1, 'a permitted import must actually write');
    assert.equal(writes[0]!.delegate, 'legalDocument');
    assert.equal(writes[0]!.data['bodyEn'], ROWS.legalDocuments[0]!['bodyEn']);
  });
});

describe('config import — operator content sections need the permission their own screen needs', () => {
  for (const [section, tokens] of Object.entries(NEWLY_GATED) as Array<
    [ConfigExportSection, readonly string[]]
  >) {
    it(`refuses "${section}" from an admin holding only config_portability:import`, async () => {
      const { writes, error } = await importSection(section, IMPORT_ONLY);

      assert.ok(error instanceof BadRequestException, `"${section}" was imported without a gate`);
      assert.match(error.message, new RegExp(section));
      for (const token of tokens) {
        assert.match(error.message, new RegExp(token));
      }
      assert.deepEqual(writes, [], `nothing may be written for "${section}"`);
    });

    it(`allows "${section}" once the admin holds ${tokens.join(' + ')}`, async () => {
      const { writes, error, result } = await importSection(
        section,
        new Set(['config_portability:import', ...tokens]),
      );

      assert.equal(error, null, `a permitted import of "${section}" was refused`);
      assert.equal(result?.summaries.find((s) => s.section === section)?.status, 'imported');
      assert.ok(writes.length > 0, `a permitted import of "${section}" must actually write`);
    });
  }

  it('refuses faqItems from an admin holding only faq:create', async () => {
    // ALL listed tokens are required, not any one. `upsertById` both creates
    // and updates, so an admin who may add an entry but not edit one must not
    // be able to overwrite the existing set through this door.
    const { writes, error } = await importSection(
      'faqItems',
      new Set(['config_portability:import', 'faq:create']),
    );

    assert.ok(error instanceof BadRequestException, 'a partial token set was accepted');
    assert.match(error.message, /faq:edit/);
    assert.doesNotMatch(
      error.message,
      /faq:create/,
      'only the tokens the admin is MISSING should be named',
    );
    assert.deepEqual(writes, []);
  });

  it('does not demand faq:delete — the import never deletes an FAQ row', async () => {
    // Over-gating is its own outage: an admin who may create and edit FAQ
    // entries must be able to promote them between environments.
    const { writes, error } = await importSection(
      'faqItems',
      new Set(['config_portability:import', 'faq:create', 'faq:edit']),
    );

    assert.equal(error, null);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.delegate, 'faqItem');
  });
});

describe('config import — no section is gated by omission any more', () => {
  // The sweep that would have caught the original hole, and would catch the
  // next one: it asks the REAL service about every section the export knows,
  // rather than reading the map. A future section added with an empty entry
  // (the shape the compiler cannot object to) fails here.
  for (const section of ALL_SECTIONS) {
    if (DELIBERATELY_UNGATED.includes(section)) continue;

    it(`refuses "${section}" from an admin holding only config_portability:import`, async () => {
      const { writes, error } = await importSection(section, IMPORT_ONLY);

      assert.ok(
        error instanceof BadRequestException,
        `"${section}" was written with no permission beyond config_portability:import`,
      );
      assert.deepEqual(writes, [], `"${section}" reached the database before being refused`);
    });
  }

  it('keeps scopePolicies importable without an extra permission, on purpose', async () => {
    // The one deliberate exemption, proved live rather than assumed: the table
    // is read nowhere in `src/`, so importing it moves inert rows, and gating
    // it would refuse a legitimate whole-config promotion over data that does
    // nothing. Asserting the WRITE (not merely the absence of a throw) is what
    // makes this the exemption rather than a section that silently skipped.
    const { writes, error, result } = await importSection('scopePolicies', IMPORT_ONLY);

    assert.equal(error, null, 'the deliberate exemption was gated');
    assert.equal(result?.summaries.find((s) => s.section === 'scopePolicies')?.status, 'imported');
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.delegate, 'adminScopePolicy');
  });

  it('still lets a whole-config promotion through for an admin who holds every token', async () => {
    // Eleven gates that each work in isolation can still add up to an import
    // nobody can run. This is the one case that asserts the gates compose.
    const everything = new Set([
      'config_portability:import',
      'rbac_roles:edit',
      // The `permissions` row grants `faq:view`, and the self-escalation guard
      // refuses to import a grant the importer does not itself hold. Without
      // this the row is SKIPPED, not written — which is the guard working, and
      // would make this case count ten writes for a reason that has nothing to
      // do with the section gates it is about.
      'faq:view',
      'settings:edit',
      'webhooks:create',
      'webhooks:edit',
      'automations:create',
      'automations:edit',
      'notifications:edit',
      'admins:edit',
      'blocked_ips:create',
      'blocked_ips:delete',
      'faq:create',
      'faq:edit',
    ]);
    const { prisma, writes } = buildRecordingStub();
    const sections: Partial<Record<ConfigExportSection, unknown[]>> = {};
    const manifest: Partial<Record<ConfigExportSection, number>> = {};
    for (const section of ALL_SECTIONS) {
      sections[section] = [...ROWS[section]];
      manifest[section] = ROWS[section].length;
    }

    const result = await new ConfigImportService(prisma as never).importConfig({
      payload: {
        version: 1,
        exportedAt: '2026-01-01T00:00:00.000Z',
        source: 'rezeis-admin',
        manifest,
        sections,
      },
      sections: null,
      strategy: 'overwrite',
      dryRun: false,
      importerPermissions: everything,
    });

    for (const summary of result.summaries) {
      assert.equal(summary.status, 'imported', `"${summary.section}" did not import`);
    }
    assert.equal(
      writes.length,
      ALL_SECTIONS.length,
      `expected one write per section, got ${writes.map((w) => w.delegate).join(', ')}`,
    );
  });
});
