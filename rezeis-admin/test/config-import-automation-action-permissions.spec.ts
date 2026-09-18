import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

import type { ConfigExportPayloadInterface } from '../src/modules/config-portability/services/config-export.service';
import { ConfigImportService } from '../src/modules/config-portability/services/config-import.service';

/**
 * An import may not do to a rule what the rules screen would refuse
 * ═════════════════════════════════════════════════════════════════
 *
 * The `automations` section was gated on `automations:create` +
 * `automations:edit` alone. Saving a rule now also needs the permission of
 * every action in it, and switching one on needs the same — so an import that
 * could do either without them would be the way around both.
 *
 * The case that makes this more than a formality: the import never writes the
 * `actions` column (`stripRelationFields` drops a JSON list of objects), but it
 * DOES write `isEnabled`, the trigger and the conditions over a rule that
 * already exists. A file whose rule carries no actions at all could switch on a
 * destination rule that blocks addresses and let it fire as the system. So the
 * import is asked about the actions the destination's rule will keep, too.
 */

type Row = Record<string, unknown>;

const BASE = new Set(['config_portability:import', 'automations:create', 'automations:edit']);

function payload(rows: Row[]): ConfigExportPayloadInterface {
  return {
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    source: 'rezeis-admin',
    manifest: { automations: rows.length },
    sections: { automations: rows },
  };
}

function build(destination: Row[], options: { readonly unreadable?: boolean } = {}) {
  const writes: Array<{ op: string; data: Row }> = [];
  const automationRule = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      if (options.unreadable === true) throw new Error('connect ECONNREFUSED 10.0.0.9:5432');
      return destination.find((row) => row['id'] === where.id) ?? null;
    },
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
  const tx = { automationRule, $queryRaw: async () => [], $executeRaw: async () => 0 };
  const prisma = { $transaction: async <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => work(tx) };
  return { service: new ConfigImportService(prisma as never), writes };
}

const BLOCKING_RULE: Row = {
  id: 'auto-block',
  name: 'Fraud block',
  isEnabled: false,
  triggerKind: 'REALTIME',
  triggerSpec: 'fraud.signal_opened',
  actions: [{ type: 'block_ip', params: { address: '203.0.113.9' } }],
};

/** A file row that switches the rule on and re-aims it — and carries no actions. */
const SWITCH_ON: Row = { id: 'auto-block', name: 'Fraud block', isEnabled: true, triggerKind: 'REALTIME', triggerSpec: '*' };

describe('the rule an overwrite would switch on or re-aim', () => {
  it('refuses to switch on a destination rule that blocks addresses, without blocked_ips:create', async () => {
    const { service, writes } = build([BLOCKING_RULE]);

    await assert.rejects(
      () =>
        service.importConfig({
          payload: payload([SWITCH_ON]),
          sections: ['automations'],
          strategy: 'overwrite',
          dryRun: false,
          importerPermissions: BASE,
        }),
      (err: unknown) => {
        assert.ok(err instanceof BadRequestException, String(err));
        // The importer holds the section's own two tokens; only what is absent is named.
        assert.equal(
          err.message,
          'Importing these sections requires permissions this admin does not hold: automations needs blocked_ips:create',
        );
        return true;
      },
    );
    assert.deepStrictEqual(writes, [], 'refused, but the rule was written');
  });

  it('lets an importer who holds the permission switch it on — the actions stay as they were', async () => {
    const { service, writes } = build([BLOCKING_RULE]);

    const result = await service.importConfig({
      payload: payload([SWITCH_ON]),
      sections: ['automations'],
      strategy: 'overwrite',
      dryRun: false,
      importerPermissions: new Set([...BASE, 'blocked_ips:create']),
    });

    assert.equal(result.summaries[0]?.status, 'imported');
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.op, 'update');
    assert.equal(writes[0]?.data['isEnabled'], true);
    assert.ok(!('actions' in (writes[0]?.data ?? {})), 'the import wrote the actions column');
  });

  it('asks nothing more of a destination rule whose actions need nothing', async () => {
    const { service, writes } = build([{ ...BLOCKING_RULE, actions: [{ type: 'notify_telegram', params: {} }] }]);

    const result = await service.importConfig({
      payload: payload([SWITCH_ON]),
      sections: ['automations'],
      strategy: 'overwrite',
      dryRun: false,
      importerPermissions: BASE,
    });

    assert.equal(result.summaries[0]?.status, 'imported');
    assert.equal(writes.length, 1);
  });

  it('does not ask about the destination under "skip", which leaves an existing rule alone', async () => {
    const { service, writes } = build([BLOCKING_RULE]);

    const result = await service.importConfig({
      payload: payload([SWITCH_ON]),
      sections: ['automations'],
      strategy: 'skip',
      dryRun: false,
      importerPermissions: BASE,
    });

    assert.equal(result.summaries[0]?.status, 'imported');
    assert.equal(result.summaries[0]?.skipped, 1);
    assert.deepStrictEqual(writes, []);
  });

  it('refuses the whole import when the destination cannot be read, and writes nothing', async () => {
    const { service, writes } = build([BLOCKING_RULE], { unreadable: true });

    await assert.rejects(
      () =>
        service.importConfig({
          payload: payload([SWITCH_ON]),
          sections: ['automations'],
          strategy: 'overwrite',
          dryRun: false,
          importerPermissions: new Set([...BASE, 'blocked_ips:create']),
        }),
      (err: unknown) => err instanceof ServiceUnavailableException,
    );
    assert.deepStrictEqual(writes, []);
  });
});

describe('the actions the file itself carries', () => {
  it('asks for the permission of every action in the file, even for a rule that is new here', async () => {
    const { service, writes } = build([]);

    await assert.rejects(
      () =>
        service.importConfig({
          payload: payload([{ id: 'auto-new', name: 'Ban', isEnabled: true, triggerKind: 'MANUAL', triggerSpec: '', actions: [{ type: 'block_user', params: {} }] }]),
          sections: ['automations'],
          strategy: 'overwrite',
          dryRun: true,
          importerPermissions: BASE,
        }),
      (err: unknown) => err instanceof BadRequestException && /users:edit/.test(err.message),
    );
    assert.deepStrictEqual(writes, []);
  });
});
