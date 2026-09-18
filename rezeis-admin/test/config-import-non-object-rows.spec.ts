import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ConfigExportPayloadInterface } from '../src/modules/config-portability/services/config-export.service';
import {
  collectMissingSectionPermissions,
  ConfigImportService,
} from '../src/modules/config-portability/services/config-import.service';

/**
 * An `automations` row that is not an object fails its section, not the import
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The permission gate this change put in front of the import read `row.actions`
 * and `row.id` straight off every automations row. A file whose section held
 * `null` there threw a TypeError OUTSIDE the per-section try/catch — the whole
 * import answered 500, its dry-run preview too — where every other malformed
 * row has always cost only its own section.
 *
 * Now the gate reads fields off object rows only and leaves everything else to
 * the section's own run, which answers exactly as it did before the gate
 * existed: `null` fails the section (its run cannot read an id off it) and a
 * number, a string or a list is skipped (it has no id). Either way the import
 * answers, the other sections are untouched, and nothing is written.
 */

type Row = Record<string, unknown>;

const PERMISSIONS = new Set([
  'config_portability:import',
  'automations:create',
  'automations:edit',
  'faq:create',
  'faq:edit',
]);

const GOOD_FAQ: Row = { id: 'faq-1', question: 'Q', answer: 'A', sortOrder: 0, isActive: true };

function payload(automations: unknown[]): ConfigExportPayloadInterface {
  return {
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    source: 'rezeis-admin',
    manifest: { automations: automations.length },
    sections: { automations: automations as Row[] },
  };
}

function build() {
  const writes: Array<{ op: string; data: Row }> = [];
  const delegate = {
    findUnique: async () => null,
    findFirst: async () => null,
    create: async ({ data }: { data: Row }) => {
      writes.push({ op: 'create', data });
      return data;
    },
    update: async ({ data }: { data: Row }) => {
      writes.push({ op: 'update', data });
      return data;
    },
  };
  const tx = { automationRule: delegate, faqItem: delegate, $queryRaw: async () => [], $executeRaw: async () => 0 };
  const prisma = { $transaction: async <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => work(tx) };
  return { service: new ConfigImportService(prisma as never), writes };
}

const CASES: ReadonlyArray<readonly [string, unknown, 'failed' | 'imported']> = [
  ['null', null, 'failed'],
  ['a number', 1, 'imported'],
  ['a string', 'x', 'imported'],
  ['a list', [], 'imported'],
];

describe('an automations row that is not an object', () => {
  for (const dryRun of [false, true]) {
    for (const [what, row, status] of CASES) {
      it(`answers per section for ${what}${dryRun ? ', in a dry run' : ''}, and writes nothing`, async () => {
        const { service, writes } = build();

        for (const strategy of ['overwrite', 'skip'] as const) {
          const result = await service.importConfig({
            payload: payload([row]),
            sections: ['automations'],
            strategy,
            dryRun,
            importerPermissions: PERMISSIONS,
          });
          const summary = result.summaries.find((entry) => entry.section === 'automations');
          assert.equal(summary?.status, status, `${strategy}: ${JSON.stringify(result.summaries)}`);
          assert.equal(summary?.created, 0);
          assert.equal(summary?.updated, 0);
          if (status === 'imported') assert.equal(summary?.skipped, 1, 'a row without an id is skipped');
        }
        assert.deepStrictEqual(writes, []);
      });
    }
  }

  it('costs only its own section: the rest of the file still imports', async () => {
    const { service, writes } = build();
    const result = await service.importConfig({
      payload: {
        version: 1,
        exportedAt: '2026-01-01T00:00:00.000Z',
        source: 'rezeis-admin',
        manifest: { automations: 1, faqItems: 1 },
        sections: { automations: [null] as unknown as Row[], faqItems: [GOOD_FAQ] },
      },
      sections: ['automations', 'faqItems'],
      strategy: 'overwrite',
      dryRun: false,
      importerPermissions: PERMISSIONS,
    });
    assert.equal(result.summaries.find((entry) => entry.section === 'automations')?.status, 'failed');
    assert.equal(result.summaries.find((entry) => entry.section === 'faqItems')?.status, 'imported');
    assert.deepStrictEqual(writes.map((write) => write.data['id']), ['faq-1']);
  });

  it('never makes the gate itself throw — the function the gate calls, directly', () => {
    for (const [, row] of CASES) {
      assert.doesNotThrow(() =>
        collectMissingSectionPermissions(
          [{ section: 'automations', status: 'imported', rows: [row as Row], manifestViolation: false, errors: [] }],
          PERMISSIONS,
          { automationActionsInPlace: [] },
        ),
      );
    }
  });
});
