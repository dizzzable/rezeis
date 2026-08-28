import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';

/**
 * The row shape a subscription that LOST its panel link has, and why it is not
 * the same thing as a row without a profile.
 *
 * `unwrapPanelUser` used to CAST the create/update response into the typed
 * shape instead of decoding it. A Remnawave 3.x user row carries no `uuid` at
 * all and names its primary key `id`, so the cast produced an object whose
 * `uuid` and `panelId` were both `undefined`. `persistProfileLink` handed those
 * to a Prisma `update`, which reads `undefined` as "leave this column alone" —
 * while `remnawavePanelUsername` and `configUrl`, which came from arguments,
 * DID land. The write succeeded, the job reported COMPLETED, and the row was
 * left owning a live panel profile it cannot name.
 *
 * The decoder is fixed, so no new row can land in this state. Every row already
 * in it is still out there, still serving traffic, and every piece of code that
 * reads `remnawaveId === null` as "there is no profile" is wrong about it.
 */
interface SubscriptionRow {
  readonly id: string;
  readonly status: SubscriptionStatus;
  readonly remnawaveId: string | null;
  readonly remnawavePanelId: number | null;
  readonly remnawavePanelUsername: string | null;
  readonly configUrl: string | null;
}

type WhereNode = Record<string, unknown>;

/**
 * Evaluates a Prisma `where` against a row.
 *
 * The subject of both tests below is WHICH ROWS A QUERY SEES, so a fake that
 * returns a canned list would prove nothing: it could hand back a row the real
 * query filters out, and the assertion about what happens next would be about
 * an unreachable state. Supports only equality and `not`; anything else throws
 * rather than matching, so a later widening of the query cannot quietly turn
 * this back into a canned answer.
 */
function matchesWhere(row: Record<string, unknown>, where: WhereNode): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') {
      return (condition as WhereNode[]).some((branch) => matchesWhere(row, branch));
    }
    if (key === 'AND') {
      return (condition as WhereNode[]).every((branch) => matchesWhere(row, branch));
    }
    const value = row[key];
    if (condition !== null && typeof condition === 'object') {
      if ('not' in (condition as Record<string, unknown>)) {
        return value !== (condition as { not: unknown }).not;
      }
      throw new Error(`unsupported filter on ${key}: ${JSON.stringify(condition)}`);
    }
    return value === condition;
  });
}

interface Harness {
  readonly processor: ProfileSyncProcessor;
  /** Every numeric user id that actually reached `deleteUser`. */
  readonly deletedTargets: unknown[];
  readonly errorEvents: Array<readonly unknown[]>;
  readonly infoEvents: Array<readonly unknown[]>;
}

function buildDeleteHarness(input: {
  readonly payload: Record<string, unknown>;
  readonly jobSubscription: SubscriptionRow;
  readonly table: readonly SubscriptionRow[];
}): Harness {
  const deletedTargets: unknown[] = [];
  const errorEvents: Array<readonly unknown[]> = [];
  const infoEvents: Array<readonly unknown[]> = [];
  const processor = new ProfileSyncProcessor(
    {
      profileSyncJob: {
        findUnique: async () => ({
          id: 'sync-job-delete',
          action: SyncAction.DELETE,
          status: SyncJobStatus.PENDING,
          attempts: 0,
          payload: input.payload,
          subscription: {
            userId: 'user-1',
            trafficLimit: null,
            deviceLimit: 0,
            internalSquads: [],
            externalSquad: null,
            expiresAt: new Date('2020-01-01T00:00:00.000Z'),
            planSnapshot: {},
            ...input.jobSubscription,
          },
        }),
        updateMany: async () => ({ count: 1 }),
        update: async () => undefined,
      },
      subscription: {
        findMany: async (args: { where: WhereNode }) =>
          input.table
            .filter((row) => matchesWhere(row as unknown as Record<string, unknown>, args.where))
            .map((row) => ({ id: row.id, remnawaveId: row.remnawaveId })),
        updateMany: async () => ({ count: 1 }),
      },
    } as never,
    {
      deleteUser: async (userId: number) => {
        deletedTargets.push(userId);
        return { kind: 'ok', drifted: false, data: undefined };
      },
      resolveUser: async () => {
        throw new Error(
          'a row carrying a numeric identity must be addressed directly, never re-resolved',
        );
      },
    } as never,
    {} as never,
    {
      error: (...args: unknown[]) => { errorEvents.push(args); },
      info: (...args: unknown[]) => { infoEvents.push(args); },
      warn: (...args: unknown[]) => { infoEvents.push(args); },
    } as never,
  );
  return { processor, deletedTargets, errorEvents, infoEvents };
}

/**
 * The doomed profile, named the way this panel names profiles.
 *
 * IT IS A DECIMAL AND NOT A UUID, and that is not cosmetic. A uuid-shaped
 * target is refused outright by the stale-panel-link guard (pinned in
 * `subscription-delete-stale-panel-link.spec.ts`), so a uuid here would make
 * every case below pass for the wrong reason — the claimant search this file
 * exists to test would never run at all.
 */
const DOOMED_ID = '4711';
const DOOMED_PANEL_ID = 4711;
const SHARED_NAME = 'rz_bob_sub';

describe('profile-sync DELETE against a subscription whose panel link was lost', () => {
  it('refuses when the panel username belongs to a row that lost its id but not its profile', async () => {
    // WHY A DELETE ASKS THIS AT ALL: a DELETE job carries its target in the
    // PAYLOAD and outlives the row it came from, so nothing about the row
    // vouches for the target by the time the worker runs. Panel usernames are
    // deterministic, so a profile that was deleted and re-provisioned carries
    // the same name — and a second live row under that name is a row this
    // delete can take down.
    //
    // THE HOLE THIS PINS: the claimant search used to require
    // `remnawaveId IS NOT NULL`, reading the id column as proof that a row is
    // live on a profile. For a row whose link was lost that reading is exactly
    // backwards — it owns a live profile under this very name and has no id to
    // show for it. It was therefore invisible to the guard, the claimant list
    // came back holding only the doomed row (which is excused), and the DELETE
    // proceeded to destroy a live customer's profile. Silently: the panel
    // confirms the deletion, so the job COMPLETES.
    const harness = buildDeleteHarness({
      payload: { targetRemnawaveId: DOOMED_ID, targetRemnawavePanelUsername: SHARED_NAME },
      jobSubscription: {
        id: 'subscription-doomed',
        status: SubscriptionStatus.DELETED,
        remnawaveId: DOOMED_ID,
        remnawavePanelId: DOOMED_PANEL_ID,
        remnawavePanelUsername: SHARED_NAME,
        configUrl: null,
      },
      table: [
        {
          id: 'subscription-doomed',
          status: SubscriptionStatus.DELETED,
          remnawaveId: DOOMED_ID,
          remnawavePanelId: DOOMED_PANEL_ID,
          remnawavePanelUsername: SHARED_NAME,
          configUrl: null,
        },
        // The victim: live, holding the same panel name, and carrying the
        // decoder defect's fingerprint instead of an id.
        {
          id: 'subscription-victim',
          status: SubscriptionStatus.ACTIVE,
          remnawaveId: null,
          remnawavePanelId: null,
          remnawavePanelUsername: SHARED_NAME,
          configUrl: 'https://sub.example.test/api/sub/vvv',
        },
      ],
    });

    await assert.rejects(
      () => harness.processor.process({ data: { syncJobId: 'sync-job-delete' } } as never),
      /Refusing to delete/,
    );
    // The assertion that matters is not the message but that NOTHING was sent:
    // a refusal that still calls the panel has refused nothing.
    assert.deepStrictEqual(harness.deletedTargets, []);
  });

  it('still deletes when nobody else answers to the name', async () => {
    // The counter-check that keeps the test above honest: widening the claimant
    // search must not make every DELETE refuse. Same job, same doomed row, but
    // the other live subscription carries a DIFFERENT panel name.
    const harness = buildDeleteHarness({
      payload: { targetRemnawaveId: DOOMED_ID, targetRemnawavePanelUsername: SHARED_NAME },
      jobSubscription: {
        id: 'subscription-doomed',
        status: SubscriptionStatus.DELETED,
        remnawaveId: DOOMED_ID,
        remnawavePanelId: DOOMED_PANEL_ID,
        remnawavePanelUsername: SHARED_NAME,
        configUrl: null,
      },
      table: [
        {
          id: 'subscription-doomed',
          status: SubscriptionStatus.DELETED,
          remnawaveId: DOOMED_ID,
          remnawavePanelId: DOOMED_PANEL_ID,
          remnawavePanelUsername: SHARED_NAME,
          configUrl: null,
        },
        {
          id: 'subscription-unrelated',
          status: SubscriptionStatus.ACTIVE,
          remnawaveId: null,
          remnawavePanelId: null,
          remnawavePanelUsername: 'rz_someone_else',
          configUrl: 'https://sub.example.test/api/sub/zzz',
        },
      ],
    });

    await harness.processor.process({ data: { syncJobId: 'sync-job-delete' } } as never);

    assert.equal(harness.deletedTargets.length, 1);
  });

  it('reports a DELETE that can name no profile while the row still names one', async () => {
    // The handler's oldest silence: a DELETE whose payload carries no target and
    // whose row has no id simply `return`ed, and the job was recorded COMPLETED.
    // For a row that never had a profile that is honest. For a row that lost its
    // link it is not: the panel profile is live under the recorded username,
    // this job was the last thing that would ever have removed it, and after
    // this the row is retired out of reach of the panel-link repair.
    const harness = buildDeleteHarness({
      payload: { source: 'LEGACY_JOB_WITHOUT_TARGET' },
      jobSubscription: {
        id: 'subscription-stranded',
        status: SubscriptionStatus.DELETED,
        remnawaveId: null,
        remnawavePanelId: null,
        remnawavePanelUsername: 'rz_stranded_1',
        configUrl: 'https://sub.example.test/api/sub/sss',
      },
      table: [],
    });

    await harness.processor.process({ data: { syncJobId: 'sync-job-delete' } } as never);

    // Nothing could be sent — there is no identity to build a request from.
    assert.deepStrictEqual(harness.deletedTargets, []);
    // But an operator is now told, and told the one handle that still works.
    assert.equal(harness.errorEvents.length, 1);
    const metadata = harness.errorEvents[0]?.[3] as Record<string, unknown>;
    assert.equal(metadata['panelUsername'], 'rz_stranded_1');
    assert.equal(metadata['subscriptionId'], 'subscription-stranded');
  });

  it('stays quiet for a DELETE on a row that genuinely never had a profile', async () => {
    // The contrast that keeps the alert readable. No username, no config URL —
    // nothing was ever provisioned, so nothing was left behind, so nothing is
    // escalated. An event here would fire on ordinary traffic and teach
    // operators to scroll past the one that matters.
    const harness = buildDeleteHarness({
      payload: { source: 'LEGACY_JOB_WITHOUT_TARGET' },
      jobSubscription: {
        id: 'subscription-never-linked',
        status: SubscriptionStatus.DELETED,
        remnawaveId: null,
        remnawavePanelId: null,
        remnawavePanelUsername: null,
        configUrl: null,
      },
      table: [],
    });

    await harness.processor.process({ data: { syncJobId: 'sync-job-delete' } } as never);

    assert.deepStrictEqual(harness.deletedTargets, []);
    assert.deepStrictEqual(harness.errorEvents, []);
  });
});
