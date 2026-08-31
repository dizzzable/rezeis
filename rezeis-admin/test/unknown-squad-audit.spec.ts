import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UnknownSquadAuditService } from '../src/modules/plans/services/unknown-squad-audit.service';

/**
 * The screen that answers "which subscriptions will fail their next renewal".
 *
 * A squad deleted or RECREATED in Remnawave keeps its old uuid on every
 * subscription sold against it. The panel validates squad uuids for SHAPE only,
 * so the dead one passes and then throws inside the panel: `HTTP 500 A039
 * Update user error`, naming neither field nor value. Verified against a live
 * 3.3.2 panel.
 */

type Sub = {
  id: string;
  userId?: string;
  status?: string;
  internalSquads?: string[];
  externalSquad?: string | null;
  planSnapshot?: unknown;
};

function build(options: {
  readonly panelSquads?: readonly string[] | 'unreachable';
  readonly externalSquads?: readonly string[];
  readonly subs?: readonly Sub[];
  readonly plans?: ReadonlyArray<{
    id: string;
    name: string;
    internalSquads?: string[];
    externalSquad?: string | null;
  }>;
  readonly noPanel?: boolean;
}) {
  const queries: Array<Record<string, unknown>> = [];
  const prisma = {
    subscription: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        queries.push(args.where);
        return (options.subs ?? []).map((s) => ({
          id: s.id,
          userId: s.userId ?? 'u-1',
          status: s.status ?? 'ACTIVE',
          internalSquads: s.internalSquads ?? [],
          externalSquad: s.externalSquad ?? null,
          planSnapshot: s.planSnapshot ?? { name: 'Premium' },
        }));
      },
    },
    plan: {
      findMany: async () =>
        (options.plans ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          internalSquads: p.internalSquads ?? [],
          externalSquad: p.externalSquad ?? null,
        })),
    },
  };
  const ok = (uuids: readonly string[]) => ({
    kind: 'ok' as const,
    data: uuids.map((uuid) => ({ uuid, name: `squad ${uuid}` })),
  });
  const infra =
    options.noPanel === true
      ? undefined
      : {
          getInternalSquadOptions: async () =>
            options.panelSquads === 'unreachable'
              ? { kind: 'network' as const }
              : ok(options.panelSquads ?? []),
          getExternalSquadOptions: async () => ok(options.externalSquads ?? []),
        };
  return {
    service: new UnknownSquadAuditService(prisma as never, infra as never),
    queries,
  };
}

describe('finding subscriptions on a squad the panel forgot', () => {
  it('names the dead squad and leaves the live one out of it', async () => {
    const { service } = build({
      panelSquads: ['live'],
      subs: [{ id: 's1', internalSquads: ['live', 'dead'] }],
    });

    const report = await service.audit();

    assert.equal(report.affected, 1);
    assert.deepStrictEqual(report.rows[0]?.unknownSquads, ['dead']);
    assert.equal(report.rows[0]?.subscriptionId, 's1');
  });

  it('says nothing when every squad is still served', async () => {
    const { service } = build({
      panelSquads: ['a', 'b'],
      subs: [{ id: 's1', internalSquads: ['a', 'b'] }],
    });

    const report = await service.audit();

    assert.equal(report.affected, 0);
    assert.deepStrictEqual(report.rows, []);
  });

  it('catches a dead EXTERNAL squad and marks it as one', async () => {
    // It rides the same PATCH and produces the same A039, so leaving it out
    // would report a broken subscription as healthy.
    const { service } = build({
      panelSquads: ['live'],
      externalSquads: [],
      subs: [{ id: 's1', internalSquads: ['live'], externalSquad: 'gone' }],
    });

    const report = await service.audit();

    assert.equal(report.affected, 1);
    assert.equal(report.rows[0]?.externalSquadMissing, true);
    assert.ok(report.rows[0]?.unknownSquads.includes('gone'));
  });

  it('accepts an external squad the panel serves', async () => {
    // Internal and external live in separate lists upstream; checking only the
    // internal one would flag every external squad as dead.
    const { service } = build({
      panelSquads: [],
      externalSquads: ['ext'],
      subs: [{ id: 's1', externalSquad: 'ext' }],
    });

    const report = await service.audit();

    assert.equal(report.affected, 0);
  });

  it('skips DELETED subscriptions', async () => {
    const { service, queries } = build({ panelSquads: [], subs: [] });

    await service.audit();

    assert.equal((queries[0]?.status as { not: string }).not, 'DELETED');
  });

  it('names the PLANS that still hold a dead squad', async () => {
    // Repairing subscriptions while the plan keeps the dead uuid means the next
    // purchase recreates the problem.
    const { service } = build({
      panelSquads: ['live'],
      subs: [],
      plans: [
        { id: 'p1', name: 'Broken', internalSquads: ['dead'] },
        { id: 'p2', name: 'Fine', internalSquads: ['live'] },
      ],
    });

    const report = await service.audit();

    assert.deepStrictEqual(report.affectedPlans, [{ id: 'p1', name: 'Broken' }]);
  });

  it('carries the plan name so the row is actionable', async () => {
    const { service } = build({
      panelSquads: [],
      subs: [{ id: 's1', internalSquads: ['dead'], planSnapshot: { name: 'MiniFamily' } }],
    });

    const report = await service.audit();

    assert.equal(report.rows[0]?.planName, 'MiniFamily');
  });
});

describe('an unreachable panel', () => {
  it('REFUSES rather than answering "nothing is wrong"', async () => {
    // Everywhere else a failed panel read degrades to "we could not tell". A
    // screen whose whole job is to say "these are broken" must not: an empty
    // list here is the most misleading thing it could say.
    const { service } = build({ panelSquads: 'unreachable', subs: [{ id: 's1' }] });

    await assert.rejects(() => service.audit(), /panel did not answer/i);
  });

  it('refuses when the integration is not configured at all', async () => {
    const { service } = build({ noPanel: true, subs: [{ id: 's1' }] });

    await assert.rejects(() => service.audit(), /not configured/i);
  });
});
