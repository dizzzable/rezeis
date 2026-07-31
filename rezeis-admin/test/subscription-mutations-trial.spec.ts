import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { PlanAvailability } from '@prisma/client';

import { TRIAL_CLAIM_LIMIT_MESSAGE } from '../src/modules/plans/utils/trial-settings.util';
import { SubscriptionMutationsService } from '../src/modules/subscriptions/services/subscription-mutations.service';

describe('SubscriptionMutationsService trial claims', () => {
  it('serializes concurrent free grants and stops exactly at maxClaims=2', async () => {
    const harness = createTrialGrantHarness({ maxClaims: 2 });

    const results = await harness.grantConcurrently(3);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected');
    assert.equal(rejected.reason instanceof BadRequestException, true);
    assert.equal(harness.subscriptions.length, 2);
    assert.equal(harness.trialClaims.length, 2);
    assert.equal(harness.enqueued.length, 2);
    assert.equal(harness.stats.lockCalls, 3);
    assert.equal(harness.lockStatements.length, 3);
  });

  it('commits exactly one claim unit when a single-claim trial is requested concurrently', async () => {
    const harness = createTrialGrantHarness({ maxClaims: 1 });

    const results = await harness.grantConcurrently(4);

    // Exactly one caller wins, and it wins cleanly: the winner must not be
    // punished with a limit error for a slot it legitimately took.
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    assert.equal(fulfilled.length, 1);
    assert.equal(
      (fulfilled[0] as PromiseFulfilledResult<{ readonly subscriptionId: string }>).value
        .subscriptionId,
      'sub-1',
    );
    assert.equal(harness.trialClaims.length, 1);
    assert.equal(
      harness.trialClaims.reduce((total, claim) => total + Number(claim['units'] ?? 1), 0),
      1,
    );
    assert.equal(harness.subscriptions.length, 1);
    assert.equal(harness.enqueued.length, 1);

    // Every loser is refused for the one honest reason, not with a raw unique
    // constraint violation leaking out of the ledger write.
    const rejections = results.filter((result) => result.status === 'rejected');
    assert.equal(rejections.length, 3);
    for (const rejection of rejections as PromiseRejectedResult[]) {
      assert.equal(rejection.reason instanceof BadRequestException, true);
      assert.equal((rejection.reason as BadRequestException).message, TRIAL_CLAIM_LIMIT_MESSAGE);
    }

    // Each attempt still took the per-user row lock before deciding.
    assert.equal(harness.stats.lockCalls, 4);
  });
});

/**
 * Serializes every `$transaction` on a shared tail promise, so the fake row
 * lock behaves like `SELECT ... FOR UPDATE`: overlapping grants queue instead
 * of all reading the same pre-grant claim count.
 */
function createTrialGrantHarness(input: { readonly maxClaims: number }) {
  const subscriptions: Array<Record<string, unknown>> = [];
  const trialClaims: Array<Record<string, unknown>> = [];
  const lockStatements: string[] = [];
  const enqueued: string[] = [];
  const stats = { lockCalls: 0 };
  let lockTail = Promise.resolve();
  let syncSequence = 0;

  const prisma = {
    plan: {
      findUnique: async () => ({
        id: 'trial-plan',
        name: 'Trial',
        type: 'BOTH',
        icon: null,
        trafficLimit: 10,
        deviceLimit: 1,
        trafficLimitStrategy: 'NO_RESET',
        internalSquads: [],
        externalSquad: null,
        tag: null,
        availability: PlanAvailability.TRIAL,
        trialSettings: { free: true, maxClaims: input.maxClaims, availabilityScope: 'ALL' },
      }),
    },
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
      const previousLock = lockTail;
      let releaseLock!: () => void;
      lockTail = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      let locked = false;
      const tx = {
        $queryRaw: async (query: unknown) => {
          const statement =
            typeof query === 'object' && query !== null && 'sql' in query
              ? String((query as { readonly sql: unknown }).sql)
              : String(query);
          lockStatements.push(statement);
          assert.match(
            statement.replace(/\s+/g, ' '),
            /\bFOR\s+UPDATE\b/i,
            'trial claim must issue a real row-locking SQL statement',
          );
          await previousLock;
          locked = true;
          stats.lockCalls += 1;
          return [{ id: 'user-1' }];
        },
        subscription: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            assert.equal(locked, true, 'trial creation must remain under the user row lock');
            const created = { id: `sub-${subscriptions.length + 1}`, ...data };
            subscriptions.push(created);
            return created;
          },
        },
        trialClaim: {
          aggregate: async () => {
            assert.equal(locked, true, 'claim count must run only after the user row lock');
            return {
              _sum: {
                units: trialClaims.reduce(
                  (total, claim) => total + Number(claim['units'] ?? 1),
                  0,
                ),
              },
            };
          },
          create: async ({ data }: { data: Record<string, unknown> }) => {
            assert.equal(locked, true, 'ledger write must remain under the user row lock');
            const created = { id: `claim-${trialClaims.length + 1}`, ...data };
            trialClaims.push(created);
            return created;
          },
        },
        trialGrant: { upsert: async () => undefined },
        profileSyncJob: {
          create: async () => ({ id: `sync-${++syncSequence}` }),
        },
      };
      try {
        return await callback(tx);
      } finally {
        if (locked) {
          releaseLock();
        } else {
          await previousLock;
          releaseLock();
        }
      }
    },
  };
  const service = new SubscriptionMutationsService(prisma as never, {
    enqueue: async (id: string) => {
      enqueued.push(id);
    },
  } as never);

  return {
    subscriptions,
    trialClaims,
    lockStatements,
    enqueued,
    stats,
    grantConcurrently: (attempts: number) =>
      Promise.allSettled(
        Array.from({ length: attempts }, () =>
          service.grantTrial({ userId: 'user-1', planId: 'trial-plan', durationDays: 7 }),
        ),
      ),
  };
}
