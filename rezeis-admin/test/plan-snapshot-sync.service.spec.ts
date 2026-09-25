import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Prisma } from '@prisma/client';

import { PlanSnapshotSyncService } from '../src/modules/subscriptions/services/plan-snapshot-sync.service';

/**
 * The plan edit's mirror into every subscriber's `plan_snapshot` — ONE
 * statement whatever the plan's size (review R3a-01): the four mirrored keys
 * merged into the stored JSON by the database, the previous reset rule read
 * back from the same statement. What it writes to real rows is proved against
 * PostgreSQL (`add-on-reset-rule-change-postgres.spec.ts`, «the mirror: …»);
 * here, what the statement says.
 */

const PLAN = {
  id: 'plan-1',
  name: 'Starter',
  tag: 'popular',
  type: 'BOTH',
  trafficLimit: 1024,
  deviceLimit: 2,
  trafficLimitStrategy: 'WEEK',
  internalSquads: ['11111111-1111-1111-1111-111111111111'],
  externalSquad: '22222222-2222-2222-2222-222222222222',
} as const;

type RawCall = { readonly strings: readonly string[]; readonly values: readonly unknown[] };

function capture(rows: ReadonlyArray<Record<string, unknown>>) {
  const calls: RawCall[] = [];
  const client = {
    $queryRaw: async (query: Prisma.Sql) => {
      calls.push({ strings: query.strings, values: query.values });
      return rows;
    },
  };
  return { calls, client };
}

describe('PlanSnapshotSyncService', () => {
  it('mirrors the display facts and the reset rule in ONE statement, and FREEZES the four limit keys and the icon', async () => {
    // The stored snapshot is what the plan gave THIS subscription. Display
    // facts track the live plan; the four limit keys must not, because
    // `resolveInheritedPlanLimitUpdate` compares the subscription's columns
    // against them to decide whether an operator adjusted it individually.
    const { calls, client } = capture([]);

    await new PlanSnapshotSyncService().syncPlanSnapshotMetadata(client as never, PLAN as never);

    assert.equal(calls.length, 1, 'one statement, however many subscribers the plan has');
    const text = calls[0]!.strings.join('?');
    assert.match(text, /UPDATE "subscriptions"/);
    assert.match(text, /WHERE "plan_snapshot"->>'id' = \?/, 'subscribers are found by the canonical plan-id key');
    const merged = /jsonb_build_object\(([\s\S]*?)\)\s*,/.exec(text)?.[1] ?? '';
    const keys = Array.from(merged.matchAll(/'([^']+)'/g), (match) => match[1]);
    assert.deepEqual(keys, ['name', 'tag', 'type', 'trafficLimitStrategy'], 'exactly the four mirrored keys');
    const values = calls[0]!.values;
    for (const mirrored of [PLAN.id, PLAN.name, PLAN.tag, PLAN.type, PLAN.trafficLimitStrategy]) {
      assert.ok(values.includes(mirrored), `binds ${mirrored}`);
    }
    for (const frozen of [PLAN.trafficLimit, PLAN.deviceLimit, PLAN.externalSquad, PLAN.internalSquads[0]]) {
      assert.ok(!values.some((value) => value === frozen || (Array.isArray(value) && value.includes(frozen))), `never binds ${String(frozen)}`);
    }
    assert.doesNotMatch(merged, /icon|trafficLimit'|deviceLimit|internalSquads|externalSquad/);
  });

  it('hands back, for the follow after the commit, only the subscribers whose stored rule it changed', async () => {
    const { client } = capture([
      { id: 'changed', previousStrategy: 'MONTH', status: 'ACTIVE' },
      { id: 'same', previousStrategy: 'WEEK', status: 'ACTIVE' },
      // An old import's snapshot named no rule of its own: never the panel's to date anything by.
      { id: 'no-rule', previousStrategy: null, status: 'ACTIVE' },
      { id: 'expired', previousStrategy: 'DAY', status: 'EXPIRED' },
      // Retired: its snapshot is mirrored, and nothing follows.
      { id: 'deleted', previousStrategy: 'DAY', status: 'DELETED' },
    ]);

    const result = await new PlanSnapshotSyncService().syncPlanSnapshotMetadata(client as never, PLAN as never);

    assert.equal(result.updated, 5);
    assert.deepEqual(result.followSubscriptionIds, ['changed', 'expired']);
    assert.equal(result.strategyChanged, 2);
  });
});
