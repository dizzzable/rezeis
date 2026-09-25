import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Prisma } from '@prisma/client';

import {
  PLAN_STRATEGY_UPDATE_CAUSE,
  PlanSnapshotSyncService,
} from '../src/modules/subscriptions/services/plan-snapshot-sync.service';

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

/** A client answering each statement, in order, with the next of `answers` (then nothing). */
function capture(...answers: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>) {
  const calls: RawCall[] = [];
  const client = {
    $queryRaw: async (query: Prisma.Sql) => {
      calls.push({ strings: query.strings, values: query.values });
      return answers[calls.length - 1] ?? [];
    },
  };
  return { calls, client };
}

/** A mirrored row as the statement returns it: live, linked and in the term model unless said. */
function mirrored(id: string, previousStrategy: string | null, patch: Record<string, unknown> = {}) {
  return { id, previousStrategy, status: 'ACTIVE', linked: true, inModel: true, ...patch };
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

  it('hands back, for the follow after the commit, only the subscribers in the term model whose stored rule it changed', async () => {
    const { calls, client } = capture([
      mirrored('changed', 'MONTH'),
      mirrored('same', 'WEEK'),
      // An old import's snapshot named no rule of its own: never the panel's to date anything by.
      mirrored('no-rule', null),
      mirrored('expired', 'DAY', { status: 'EXPIRED' }),
      // Retired: its snapshot is mirrored, and nothing follows.
      mirrored('deleted', 'DAY', { status: 'DELETED' }),
    ]);

    const result = await new PlanSnapshotSyncService().syncPlanSnapshotMetadata(client as never, PLAN as never);

    assert.equal(result.updated, 5);
    assert.deepEqual(result.followSubscriptionIds, ['changed', 'expired']);
    assert.equal(result.strategyChanged, 2);
    assert.deepEqual(result.syncJobIds, []);
    assert.equal(calls.length, 1, 'nothing outside the model: no push is written');
  });

  it('asks the database, in the same statement, which rows the follow\'s sweep can find: an ACTIVE or SCHEDULED term of the snapshot\'s plan', async () => {
    const { calls, client } = capture([]);

    await new PlanSnapshotSyncService().syncPlanSnapshotMetadata(client as never, PLAN as never);

    const text = calls[0]!.strings.join('?');
    const returning = text.slice(text.indexOf('RETURNING'));
    assert.match(returning, /"remnawave_id" IS NOT NULL AS "linked"/);
    assert.match(returning, /FROM "subscription_terms" t/);
    assert.match(returning, /t\."status" IN \('ACTIVE', 'SCHEDULED'\)/);
    // The sweep's own test (`selectResetRuleFollowCandidates`), so a row it
    // cannot find is exactly a row pushed here.
    assert.match(returning, /t\."plan_id" IS NOT DISTINCT FROM s\."plan_snapshot"->>'id'/);
    assert.match(returning, /AS "inModel"/);
  });

  it('writes the push, with the rule, for every live linked subscriber OUTSIDE the term model whose rule it changed (review R4-01)', async () => {
    const { calls, client } = capture(
      [
        mirrored('in-model', 'MONTH'),
        mirrored('outside', 'MONTH', { inModel: false }),
        mirrored('outside-limited', 'DAY', { inModel: false, status: 'LIMITED' }),
        // No profile to push to: the CREATE that links it sends the rule.
        mirrored('outside-unlinked', 'MONTH', { inModel: false, linked: false }),
        // Not live: whatever makes it live pushes it.
        mirrored('outside-expired', 'MONTH', { inModel: false, status: 'EXPIRED' }),
        mirrored('outside-disabled', 'MONTH', { inModel: false, status: 'DISABLED' }),
        mirrored('outside-same', 'WEEK', { inModel: false }),
        mirrored('outside-no-rule', null, { inModel: false }),
        mirrored('outside-deleted', 'MONTH', { inModel: false, status: 'DELETED' }),
      ],
      [{ id: 'push-1' }, { id: 'push-2' }],
    );
    const now = new Date('2026-09-25T12:00:00.000Z');

    const result = await new PlanSnapshotSyncService().syncPlanSnapshotMetadata(client as never, PLAN as never, { now });

    assert.deepEqual(result.followSubscriptionIds, ['in-model'], 'the model follows first, then pushes');
    assert.deepEqual(result.syncJobIds, ['push-1', 'push-2'], 'handed back for the caller to enqueue');
    assert.equal(result.strategyChanged, 6, 'the audit counts every subscriber whose rule changed');
    assert.equal(calls.length, 2, 'ONE more statement, whatever their number');
    const text = calls[1]!.strings.join('?');
    assert.match(text, /INSERT INTO "profile_sync_jobs"/);
    assert.match(text, /'UPDATE'::"SyncAction", 'PENDING'::"SyncJobStatus"/);
    const values = calls[1]!.values;
    const bound = values.filter(Array.isArray) as string[][];
    assert.ok(bound.length > 0);
    for (const ids of bound) assert.deepEqual(ids, ['outside', 'outside-limited']);
    assert.ok(values.includes(PLAN_STRATEGY_UPDATE_CAUSE), 'marked with the cause the runner reuses');
    assert.ok(values.includes(PLAN.id), 'names the plan, as the runner\'s push does');
    assert.ok(values.some((value) => value instanceof Date && value.getTime() === now.getTime()));
  });

  it('keeps a push of that cause already waiting, instead of a second one, and holds it until the commit', async () => {
    const { calls, client } = capture([mirrored('outside', 'MONTH', { inModel: false })], [{ id: 'waiting-1' }]);

    await new PlanSnapshotSyncService().syncPlanSnapshotMetadata(client as never, PLAN as never);

    const text = calls[1]!.strings.join('?');
    const waiting = text.slice(text.indexOf('"waiting" AS'), text.indexOf('"written" AS'));
    assert.match(waiting, /j\."status" = 'PENDING'/);
    assert.match(waiting, /j\."superseded_at" IS NULL/);
    assert.match(waiting, /j\."cause" = \?/);
    // A worker that claimed it before the commit would push the OLD rule.
    assert.match(waiting, /FOR UPDATE/);
    const written = text.slice(text.indexOf('"written" AS'));
    assert.match(written, /WHERE NOT EXISTS \(SELECT 1 FROM "waiting" w WHERE w\."subscription_id" = x\."id"\)/);
    assert.match(written, /SELECT "id" FROM "written"\s+UNION ALL\s+SELECT "id" FROM "waiting"/);
  });
});
