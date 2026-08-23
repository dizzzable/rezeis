/**
 * The `roles` import section writes the grant matrix itself, through Prisma,
 * past every guard in `RbacService`.
 *
 * An adversarial review of the RBAC hardening found this and proved it live:
 * an importer holding `config_portability:import` + `rbac_roles:edit` posts a
 * roles section naming its own role `superadmin` with `isSystem: true`, and
 * `RbacService.resolvePermissions` hands it `grantedAll`. Full superuser, in
 * one request, with none of `createRole`'s forced `isSystem: false`,
 * `updateRole`'s refusal to touch `name`/`isSystem`, `assertGrantsWithinActor`
 * or `RESERVED_ROLE_NAMES` ever running — because none of them is on this path.
 *
 * Both rows move inside one transaction, so the unique-name constraint does not
 * save it either: the incumbent is renamed in the same statement batch.
 *
 * These cases drive the real service against a recording Prisma double and
 * assert what actually reached the database, not that a call was refused.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigImportService } from '../src/modules/config-portability/services/config-import.service';

const FULL_ACTOR = new Set(['config_portability:import', 'rbac_roles:edit']);

interface RecordedWrite {
  readonly op: 'create' | 'update';
  readonly data: Record<string, unknown>;
}

/**
 * Minimal Prisma double that records every write to `adminRole`. Existing rows
 * are keyed by id so the update branch is reachable — the escalation needs it.
 */
function buildPrisma(existingRoleIds: readonly string[]): {
  readonly prisma: unknown;
  readonly writes: RecordedWrite[];
} {
  const writes: RecordedWrite[] = [];
  const adminRole = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      existingRoleIds.includes(where.id) ? { id: where.id } : null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      writes.push({ op: 'create', data });
      return data;
    },
    update: async ({ data }: { data: Record<string, unknown> }) => {
      writes.push({ op: 'update', data });
      return data;
    },
    findMany: async () => [],
    deleteMany: async () => ({ count: 0 }),
  };
  const tx = {
    adminRole,
    adminPermission: {
      findMany: async () => [],
      createMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 }),
      findUnique: async () => null,
      create: async () => ({}),
      update: async () => ({}),
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

function payload(roles: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
  return {
    version: 1,
    manifest: { roles: roles.length },
    sections: { roles },
  };
}

async function importRoles(
  roles: ReadonlyArray<Record<string, unknown>>,
  options?: { readonly existingIds?: readonly string[] },
): Promise<{ readonly writes: RecordedWrite[]; readonly error: Error | null }> {
  const { prisma, writes } = buildPrisma(options?.existingIds ?? []);
  const service = new ConfigImportService(prisma as never);
  let error: Error | null = null;
  try {
    await service.importConfig({
      payload: payload(roles),
      sections: ['roles'],
      strategy: 'overwrite',
      dryRun: false,
      importerPermissions: FULL_ACTOR,
    } as never);
  } catch (err) {
    error = err as Error;
  }
  return { writes, error };
}

describe('config import cannot mint authority through the roles section', () => {
  it('refuses a role named after a system role', async () => {
    // The escalation verbatim: claim the seeded name, claim the flag.
    const { writes, error } = await importRoles([
      { id: 'role-1', name: 'superadmin', displayName: 'Ops', isSystem: true },
    ]);
    assert.notEqual(error, null, 'the import accepted a reserved role name');
    assert.match(String(error?.message), /reserved/i);
    assert.deepEqual(writes, [], 'a refused import must write nothing at all');
  });

  it('refuses every seeded name, not only superadmin', async () => {
    // `RESERVED_ROLE_NAMES` covers the whole seed because the seed identifies
    // rows BY NAME — a squatter on any of them is promoted to `isSystem` on the
    // next boot and becomes undeletable through the API.
    for (const name of ['operator', 'support', 'finance']) {
      const { writes, error } = await importRoles([
        { id: `role-${name}`, name, displayName: name },
      ]);
      assert.notEqual(error, null, `the import accepted the seeded name "${name}"`);
      assert.deepEqual(writes, []);
    }
  });

  it('drops isSystem so an import cannot promote a role it created', async () => {
    // Renaming the incumbent out of the way and taking its name is the second
    // half of the attack; the flag is the half that grants.
    const { writes, error } = await importRoles([
      { id: 'role-2', name: 'ops_team', displayName: 'Ops', isSystem: true },
    ]);
    assert.equal(error, null);
    assert.equal(writes.length, 1);
    assert.ok(
      !('isSystem' in writes[0]!.data),
      'isSystem reached the database — the seed owns that flag, not the payload',
    );
    assert.equal(writes[0]!.data['name'], 'ops_team', 'an ordinary role must still import');
  });

  it('drops isSystem on the update path too', async () => {
    // `upsertById` has two branches and only one of them was ever going to be
    // used by the attack — the existing row is the interesting one.
    const { writes, error } = await importRoles(
      [{ id: 'role-3', name: 'ops_team', displayName: 'Ops', isSystem: true }],
      { existingIds: ['role-3'] },
    );
    assert.equal(error, null);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.op, 'update');
    assert.ok(!('isSystem' in writes[0]!.data));
  });

  it('still imports an ordinary role unchanged', async () => {
    // The other half of the rule. A guard that blocked legitimate promotion
    // between environments would be its own outage.
    const { writes, error } = await importRoles([
      { id: 'role-4', name: 'billing_readonly', displayName: 'Billing', description: 'RO' },
    ]);
    assert.equal(error, null);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.data['name'], 'billing_readonly');
    assert.equal(writes[0]!.data['description'], 'RO');
  });
});
