import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { AddOnsService } from '../src/modules/add-ons/services/add-ons.service';

type AddOnRecord = {
  id: string;
  name: string;
  description: string | null;
  type: string;
  lifetime: string;
  revision: number;
  icon: string | null;
  value: number;
  isActive: boolean;
  archivedAt: Date | null;
  orderIndex: number;
  applicablePlanIds: string[];
  prices: Array<{ id: string; currency: string; price: string }>;
  createdAt: Date;
  updatedAt: Date;
};

function record(overrides: Partial<AddOnRecord> = {}): AddOnRecord {
  return {
    id: 'addon-1',
    name: 'Extra 50GB',
    description: null,
    type: 'EXTRA_TRAFFIC',
    lifetime: 'UNTIL_NEXT_RESET',
    revision: 1,
    icon: null,
    value: 50,
    isActive: true,
    archivedAt: null,
    orderIndex: 1,
    applicablePlanIds: [],
    prices: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function build(options: {
  existing?: AddOnRecord | null;
  existingPlans?: string[];
  referencingEntitlements?: number;
} = {}) {
  const findManyCalls: unknown[] = [];
  const creates: Array<{ data: Record<string, unknown> }> = [];
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const deletes: unknown[] = [];
  const prisma = {
    addOn: {
      findMany: async (args: unknown) => { findManyCalls.push(args); return []; },
      findFirst: async () => ({ orderIndex: 5 }),
      findUnique: async () => options.existing ?? null,
      create: async (args: { data: Record<string, unknown> }) => {
        creates.push(args);
        const data = args.data;
        const prices = data['prices'] as { create?: Array<{ currency: string; price: string }> } | undefined;
        return record({
          name: data['name'] as string,
          type: data['type'] as string,
          lifetime: data['lifetime'] as string,
          value: data['value'] as number,
          applicablePlanIds: (data['applicablePlanIds'] as string[]) ?? [],
          prices: (prices?.create ?? []).map((p, i) => ({ id: `price-${i}`, currency: p.currency, price: p.price })),
        });
      },
      update: async (args: { where: unknown; data: Record<string, unknown> }) => {
        updates.push(args);
        return record({ ...(options.existing ?? {}), ...(args.data as Partial<AddOnRecord>) });
      },
      delete: async (args: unknown) => { deletes.push(args); },
    },
    plan: {
      findMany: async () => (options.existingPlans ?? []).map((id) => ({ id })),
    },
    addOnEntitlement: {
      count: async () => options.referencingEntitlements ?? 0,
    },
  };
  return { service: new AddOnsService(prisma as never), prisma, findManyCalls, creates, updates, deletes };
}

describe('AddOnsService catalog (T-006)', () => {
  it('creates with an explicit lifetime and stores it', async () => {
    const { service, creates } = build();
    const result = await service.create({
      name: 'Extra device',
      type: 'EXTRA_DEVICES' as never,
      lifetime: 'UNTIL_SUBSCRIPTION_END' as never,
      value: 1,
      prices: [{ currency: 'USD' as never, price: '2.00' }],
    });
    assert.equal(result.lifetime, 'UNTIL_SUBSCRIPTION_END');
    assert.equal((creates[0]!.data as { lifetime: string }).lifetime, 'UNTIL_SUBSCRIPTION_END');
  });

  it('defaults lifetime to UNTIL_SUBSCRIPTION_END when omitted (usable today; UNTIL_NEXT_RESET is gated off)', async () => {
    const { service, creates } = build();
    await service.create({
      name: 'Extra 50GB',
      type: 'EXTRA_TRAFFIC' as never,
      value: 50,
      prices: [{ currency: 'USD' as never, price: '1.00' }],
    });
    assert.equal((creates[0]!.data as { lifetime: string }).lifetime, 'UNTIL_SUBSCRIPTION_END');
  });

  it('allows a traffic add-on with UNTIL_NEXT_RESET (traffic has a reset cycle)', async () => {
    const { service, creates } = build();
    await service.create({
      name: 'Extra 50GB',
      type: 'EXTRA_TRAFFIC' as never,
      lifetime: 'UNTIL_NEXT_RESET' as never,
      value: 50,
      prices: [{ currency: 'USD' as never, price: '1.00' }],
    });
    assert.equal((creates[0]!.data as { lifetime: string }).lifetime, 'UNTIL_NEXT_RESET');
  });

  it('allows a device add-on with UNTIL_NEXT_RESET on create (device can be one-time-until-reset; eligibility gates by plan strategy)', async () => {
    const { service, creates } = build();
    const result = await service.create({
      name: 'Extra device',
      type: 'EXTRA_DEVICES' as never,
      lifetime: 'UNTIL_NEXT_RESET' as never,
      value: 1,
      prices: [{ currency: 'USD' as never, price: '1.00' }],
    });
    assert.equal(result.lifetime, 'UNTIL_NEXT_RESET');
    assert.equal((creates[0]!.data as { lifetime: string }).lifetime, 'UNTIL_NEXT_RESET');
  });

  it('allows switching type to EXTRA_DEVICES while the (kept) lifetime is UNTIL_NEXT_RESET (no type-based rejection)', async () => {
    const { service, updates } = build({ existing: record({ type: 'EXTRA_TRAFFIC', lifetime: 'UNTIL_NEXT_RESET' }) });
    await service.update('addon-1', { type: 'EXTRA_DEVICES' as never });
    assert.equal(updates.length, 1);
    assert.equal((updates[0]!.data as { type: string }).type, 'EXTRA_DEVICES');
  });

  it('rejects a non-positive value', async () => {
    const { service } = build();
    await assert.rejects(
      () => service.create({ name: 'x', type: 'EXTRA_TRAFFIC' as never, value: 0, prices: [{ currency: 'USD' as never, price: '1' }] }),
      (e: unknown) => e instanceof BadRequestException,
    );
  });

  it('rejects unknown applicable plan ids on create', async () => {
    const { service } = build({ existingPlans: ['plan-a'] });
    await assert.rejects(
      () => service.create({
        name: 'x', type: 'EXTRA_TRAFFIC' as never, value: 10,
        applicablePlanIds: ['plan-a', 'plan-missing'],
        prices: [{ currency: 'USD' as never, price: '1' }],
      }),
      (e: unknown) => e instanceof BadRequestException,
    );
  });

  it('accepts known applicable plan ids and de-duplicates/trims them', async () => {
    const { service, creates } = build({ existingPlans: ['plan-a', 'plan-b'] });
    await service.create({
      name: 'x', type: 'EXTRA_TRAFFIC' as never, value: 10,
      applicablePlanIds: [' plan-a ', 'plan-a', 'plan-b', ''],
      prices: [{ currency: 'USD' as never, price: '1' }],
    });
    assert.deepEqual((creates[0]!.data as { applicablePlanIds: string[] }).applicablePlanIds, ['plan-a', 'plan-b']);
  });

  it('bumps revision on a commercial change (value)', async () => {
    const { service, updates } = build({ existing: record({ value: 50, revision: 3 }) });
    await service.update('addon-1', { value: 100 });
    assert.deepEqual((updates[0]!.data as { revision: unknown }).revision, { increment: 1 });
  });

  it('bumps revision on a lifetime change', async () => {
    const { service, updates } = build({ existing: record({ lifetime: 'UNTIL_NEXT_RESET' }) });
    await service.update('addon-1', { lifetime: 'UNTIL_SUBSCRIPTION_END' as never });
    assert.deepEqual((updates[0]!.data as { revision: unknown }).revision, { increment: 1 });
  });

  it('does NOT bump revision on a non-commercial change (icon/isActive/description)', async () => {
    const { service, updates } = build({ existing: record() });
    await service.update('addon-1', { icon: '🎁', isActive: false, description: 'note' });
    assert.equal((updates[0]!.data as { revision?: unknown }).revision, undefined);
  });

  it('does NOT bump revision when a commercial value is re-sent unchanged', async () => {
    const { service, updates } = build({ existing: record({ value: 50, name: 'Extra 50GB' }) });
    await service.update('addon-1', { value: 50, name: 'Extra 50GB' });
    assert.equal((updates[0]!.data as { revision?: unknown }).revision, undefined);
  });

  it('validates plan ids on update and bumps revision when the set changes', async () => {
    const { service, updates } = build({ existing: record({ applicablePlanIds: ['plan-a'] }), existingPlans: ['plan-a', 'plan-b'] });
    await service.update('addon-1', { applicablePlanIds: ['plan-a', 'plan-b'] });
    assert.deepEqual((updates[0]!.data as { revision: unknown }).revision, { increment: 1 });
  });

  it('archives (sets archivedAt + isActive false) and is idempotent', async () => {
    const active = build({ existing: record({ archivedAt: null }) });
    const result = await active.service.archive('addon-1');
    assert.equal((active.updates[0]!.data as { isActive: boolean }).isActive, false);
    assert.ok((active.updates[0]!.data as { archivedAt: Date }).archivedAt instanceof Date);
    assert.ok(result.archivedAt !== null);

    const archived = build({ existing: record({ archivedAt: new Date('2026-01-01T00:00:00.000Z') }) });
    await archived.service.archive('addon-1');
    assert.equal(archived.updates.length, 0, 'already-archived add-on is not updated again');
  });

  it('blocks hard-delete when entitlements reference the add-on', async () => {
    const { service, deletes } = build({ existing: record(), referencingEntitlements: 2 });
    await assert.rejects(
      () => service.delete('addon-1'),
      (e: unknown) => e instanceof ConflictException,
    );
    assert.equal(deletes.length, 0);
  });

  it('allows hard-delete when no entitlement references the add-on', async () => {
    const { service, deletes } = build({ existing: record(), referencingEntitlements: 0 });
    await service.delete('addon-1');
    assert.equal(deletes.length, 1);
  });

  it('rejects update/delete of a missing add-on', async () => {
    const missing = build({ existing: null });
    await assert.rejects(() => missing.service.update('nope', { value: 1 }), (e: unknown) => e instanceof NotFoundException);
    await assert.rejects(() => missing.service.delete('nope'), (e: unknown) => e instanceof NotFoundException);
  });

  it('excludes archived and inactive add-ons from the per-plan listing', async () => {
    const { service, findManyCalls } = build();
    await service.listForPlan('plan-a');
    const where = (findManyCalls[0] as { where: Record<string, unknown> }).where;
    assert.equal(where['isActive'], true);
    assert.equal(where['archivedAt'], null);
  });
});
