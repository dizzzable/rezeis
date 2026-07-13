import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConflictException } from '@nestjs/common';

import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';

type Term = {
  id: string;
  baseTrafficLimitBytes: bigint | null;
  baseDeviceLimit: number | null;
};
type Contribution = { type: 'EXTRA_TRAFFIC' | 'EXTRA_DEVICES'; totalValue: bigint };
type Projection = {
  id: string;
  baselineTermId: string;
  desiredRevision: bigint;
  baseTrafficLimitBytes: bigint | null;
  baseDeviceLimit: number | null;
  activeTrafficContributionBytes: bigint;
  activeDeviceContribution: number;
  desiredTrafficLimitBytes: bigint | null;
  desiredDeviceLimit: number | null;
  state: string;
};

function build(options: {
  status?: 'ACTIVE' | 'DELETED';
  activeTerms?: Term[];
  contributions?: Contribution[];
  existing?: Projection | null;
}) {
  const creates: Array<{ data: Record<string, unknown> }> = [];
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  let queryRawCall = 0;
  const tx = {
    $queryRaw: async () => {
      queryRawCall += 1;
      // 1st raw query: subscription lock; 2nd: active term(s).
      if (queryRawCall === 1) {
        return [{ id: 'sub-1', status: options.status ?? 'ACTIVE' }];
      }
      return options.activeTerms ?? [{ id: 'term-1', baseTrafficLimitBytes: null, baseDeviceLimit: null }];
    },
    addOnEntitlement: {
      findMany: async () => options.contributions ?? [],
    },
    subscriptionEffectiveProjection: {
      findUnique: async () => options.existing ?? null,
      create: async (args: { data: Record<string, unknown> }) => {
        creates.push(args);
        return args.data;
      },
      update: async (args: { where: unknown; data: Record<string, unknown> }) => {
        updates.push(args);
        return { ...(options.existing ?? {}), ...args.data };
      },
    },
  };
  return { service: new EffectiveProjectionService(), tx, creates, updates };
}

describe('EffectiveProjectionService.recomputeInTransaction', () => {
  it('creates a shadow baseline projection at revision 0 for an unlimited-traffic term', async () => {
    const { service, tx, creates } = build({
      activeTerms: [{ id: 'term-1', baseTrafficLimitBytes: null, baseDeviceLimit: 3 }],
      contributions: [{ type: 'EXTRA_DEVICES', totalValue: 2n }],
      existing: null,
    });

    const result = await service.recomputeInTransaction(tx as never, { subscriptionId: 'sub-1' });

    assert.equal(result.desiredRevision, 0n);
    assert.equal(result.state, 'SHADOW');
    assert.equal(result.changed, true);
    // Unlimited traffic base is absorbing → stays unlimited despite no traffic add-ons.
    assert.equal(result.desiredTrafficLimitBytes, null);
    // Devices: base 3 + 2 contributed = 5.
    assert.equal(result.desiredDeviceLimit, 5);
    assert.equal(result.activeDeviceContribution, 2);
    assert.equal(result.activeTrafficContributionBytes, 0n);
    assert.equal(creates.length, 1);
    assert.equal((creates[0]!.data as { desiredRevision: bigint }).desiredRevision, 0n);
  });

  it('sums finite traffic contributions in bytes on top of the baseline', async () => {
    const gb = 1024n * 1024n * 1024n;
    const { service, tx } = build({
      activeTerms: [{ id: 'term-1', baseTrafficLimitBytes: 100n * gb, baseDeviceLimit: 5 }],
      contributions: [
        { type: 'EXTRA_TRAFFIC', totalValue: 50n * gb },
        { type: 'EXTRA_TRAFFIC', totalValue: 10n * gb },
      ],
      existing: null,
    });

    const result = await service.recomputeInTransaction(tx as never, { subscriptionId: 'sub-1' });

    assert.equal(result.desiredTrafficLimitBytes, 160n * gb);
    assert.equal(result.activeTrafficContributionBytes, 60n * gb);
    assert.equal(result.desiredDeviceLimit, 5);
  });

  it('is value-idempotent: identical desired state does not advance the revision', async () => {
    const existing: Projection = {
      id: 'proj-1',
      baselineTermId: 'term-1',
      desiredRevision: 7n,
      baseTrafficLimitBytes: 100n,
      baseDeviceLimit: 2,
      activeTrafficContributionBytes: 50n,
      activeDeviceContribution: 1,
      desiredTrafficLimitBytes: 150n,
      desiredDeviceLimit: 3,
      state: 'SHADOW',
    };
    const { service, tx, updates } = build({
      activeTerms: [{ id: 'term-1', baseTrafficLimitBytes: 100n, baseDeviceLimit: 2 }],
      contributions: [
        { type: 'EXTRA_TRAFFIC', totalValue: 50n },
        { type: 'EXTRA_DEVICES', totalValue: 1n },
      ],
      existing,
    });

    const result = await service.recomputeInTransaction(tx as never, { subscriptionId: 'sub-1' });

    assert.equal(result.changed, false);
    assert.equal(result.desiredRevision, 7n);
    assert.equal(updates.length, 0);
  });

  it('advances the revision by one when the desired state changes', async () => {
    const existing: Projection = {
      id: 'proj-1',
      baselineTermId: 'term-1',
      desiredRevision: 7n,
      baseTrafficLimitBytes: 100n,
      baseDeviceLimit: 2,
      activeTrafficContributionBytes: 0n,
      activeDeviceContribution: 0,
      desiredTrafficLimitBytes: 100n,
      desiredDeviceLimit: 2,
      state: 'SHADOW',
    };
    const { service, tx, updates } = build({
      activeTerms: [{ id: 'term-1', baseTrafficLimitBytes: 100n, baseDeviceLimit: 2 }],
      contributions: [{ type: 'EXTRA_TRAFFIC', totalValue: 50n }],
      existing,
    });

    const result = await service.recomputeInTransaction(tx as never, {
      subscriptionId: 'sub-1',
      mode: 'ACTIVE',
    });

    assert.equal(result.changed, true);
    assert.equal(result.desiredRevision, 8n);
    assert.equal(result.desiredTrafficLimitBytes, 150n);
    assert.equal(result.state, 'PENDING');
    assert.equal(updates.length, 1);
    assert.equal((updates[0]!.data as { desiredRevision: bigint }).desiredRevision, 8n);
  });

  it('rejects recompute when the subscription is deleted', async () => {
    const { service, tx } = build({ status: 'DELETED' });
    await assert.rejects(
      () => service.recomputeInTransaction(tx as never, { subscriptionId: 'sub-1' }),
      (error: unknown) => error instanceof ConflictException,
    );
  });

  it('rejects recompute when there is no single active term', async () => {
    const { service, tx } = build({ activeTerms: [] });
    await assert.rejects(
      () => service.recomputeInTransaction(tx as never, { subscriptionId: 'sub-1' }),
      (error: unknown) => error instanceof ConflictException,
    );
  });

  it('keeps a finite device baseline unlimited when the baseline is unlimited (null absorbs)', async () => {
    const { service, tx } = build({
      activeTerms: [{ id: 'term-1', baseTrafficLimitBytes: 100n, baseDeviceLimit: null }],
      contributions: [{ type: 'EXTRA_DEVICES', totalValue: 3n }],
      existing: null,
    });

    const result = await service.recomputeInTransaction(tx as never, { subscriptionId: 'sub-1' });

    // Device baseline unlimited → adding device add-ons cannot make it finite.
    assert.equal(result.desiredDeviceLimit, null);
    assert.equal(result.activeDeviceContribution, 3);
  });
});
