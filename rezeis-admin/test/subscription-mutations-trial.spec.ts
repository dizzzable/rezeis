import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { PlanAvailability } from '@prisma/client';

import { SubscriptionMutationsService } from '../src/modules/subscriptions/services/subscription-mutations.service';

describe('SubscriptionMutationsService trial claims', () => {
  it('serializes concurrent free grants and stops exactly at maxClaims=2', async () => {
    const subscriptions: Array<Record<string, unknown>> = [];
    const trialClaims: Array<Record<string, unknown>> = [];
    let lockTail = Promise.resolve();
    let lockCalls = 0;
    let syncSequence = 0;
    const lockStatements: string[] = [];

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
          trialSettings: { free: true, maxClaims: 2, availabilityScope: 'ALL' },
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
            lockCalls += 1;
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
              return { _sum: { units: trialClaims.length } };
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
    const enqueued: string[] = [];
    const service = new SubscriptionMutationsService(prisma as never, {
      enqueue: async (id: string) => {
        enqueued.push(id);
      },
    } as never);

    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        service.grantTrial({ userId: 'user-1', planId: 'trial-plan', durationDays: 7 }),
      ),
    );

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected');
    assert.equal(rejected.reason instanceof BadRequestException, true);
    assert.equal(subscriptions.length, 2);
    assert.equal(trialClaims.length, 2);
    assert.equal(enqueued.length, 2);
    assert.equal(lockCalls, 3);
    assert.equal(lockStatements.length, 3);
  });
});
