import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConflictException } from '@nestjs/common';
import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { InternalUserDevicesController } from '../src/modules/internal-user/controllers/internal-user-devices.controller';
import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';
import {
  assessStoredPanelLink,
  isUuidShapedPanelIdentity,
  SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE,
  SUBSCRIPTION_DELETE_STALE_PANEL_LINK_MESSAGE,
  SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE,
  SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_MESSAGE,
  SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE,
} from '../src/modules/remnawave/services/stale-panel-link';
import { SubscriptionDeletionService } from '../src/modules/subscriptions/services/subscription-deletion.service';
import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';
import { UserDeletionService } from '../src/modules/users/services/user-deletion.service';

/**
 * THE STALE-LINK DELETE GUARD.
 *
 * Remnawave 3.x dropped the user `uuid` and re-keyed every user route on the
 * numeric `id`. `Subscription.remnawaveId` keeps whichever spelling was current
 * when the row was linked and is never rewritten, so a 2.x-era row on an
 * upgraded panel holds an identity the panel does not answer to — and that
 * identity does NOT fail closed: `panelUserAddress` falls back to the
 * subscription short UUID recovered from `config_url`, which resolves to
 * whatever profile is LIVE at that address. A delete built from it destroys a
 * paying customer's account.
 *
 * EVERY CASE HERE PINS A POSITIVE SIDE. "Nothing was deleted" passes just as
 * happily for a service that reached no code at all, so each refusal also pins
 * the recorded panel call list, the write log, and the row's surviving state;
 * each ALLOWED case pins that the deletion really did happen.
 */

/** A live 2.x uuid, in the spelling a 3.x panel can no longer answer to. */
const DEAD_UUID = '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f';
/** The same profile as a 3.x panel names it. */
const LIVE_DECIMAL = '5150';

type Addressing = 'id' | 'uuid' | 'unknown';

interface PanelHarness {
  /** Every adapter method that was actually reached, in order. */
  readonly calls: string[];
  /** Every identity handed to `deletePanelUser`, when it exists at all. */
  readonly deleted: unknown[];
  readonly api: unknown;
}

/**
 * The panel adapter, answering only what the path under test may legitimately
 * ask.
 *
 * `deletePanelUser` IS ABSENT UNLESS `allowDelete` IS SET, and that absence is
 * the strongest assertion in this file. A refusing case that stubbed it would
 * record a call and pass its "no deletion" check by comparing arrays; with the
 * method missing, a deletion that slips through dies with "not a function"
 * instead of being silently recorded and then asserted away.
 */
function panelHarness(
  options: { addressing?: Addressing; throws?: boolean; allowDelete?: boolean } = {},
): PanelHarness {
  const calls: string[] = [];
  const deleted: unknown[] = [];
  const api: Record<string, unknown> = {
    getPanelShape: async () => {
      calls.push('getPanelShape');
      if (options.throws === true) {
        // Exactly how the era read fails in production: the probe goes out over
        // the same transport as everything else, so an unreachable panel, an
        // expired token or a panel mid-restart all arrive as a throw.
        throw new Error('Remnawave version could not be read');
      }
      return { addressing: options.addressing ?? 'unknown' };
    },
  };
  if (options.allowDelete === true) {
    api['deletePanelUser'] = async (ref: unknown) => {
      calls.push('deletePanelUser');
      deleted.push(ref);
      return { isDeleted: true };
    };
  }
  return { calls, deleted, api };
}

// ── SubscriptionDeletionService ─────────────────────────────────────────────

interface LockedRow {
  id: string;
  userId: string;
  status: SubscriptionStatus;
  remnawaveId: string | null;
  remnawavePanelId: number | null;
  remnawavePanelUsername: string | null;
  configUrl: string | null;
  expiresAt: Date | null;
}

function staleRow(overrides: Partial<LockedRow> = {}): LockedRow {
  return {
    id: 'sub-1',
    userId: 'user-1',
    status: SubscriptionStatus.ACTIVE,
    remnawaveId: DEAD_UUID,
    // NULL in both supplementary columns — the importer's signature, and the
    // reason `panelProfileClaimedByAnother` cannot see the duplicate that makes
    // this deletion fatal.
    remnawavePanelId: null,
    remnawavePanelUsername: null,
    configUrl: 'https://sub.example.test/OLDshortOLD',
    expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

interface DeletionHarness {
  /** Every write statement the service issued, in order. */
  readonly writes: string[];
  readonly createdJobs: Array<{ action: SyncAction; payload: Record<string, unknown> }>;
  readonly statuses: SubscriptionStatus[];
  readonly enqueued: string[];
  readonly warnings: string[];
  readonly events: Array<{ message: string; metadata: Record<string, unknown> }>;
  readonly service: SubscriptionDeletionService;
}

function deletionHarness(row: LockedRow | null, panel: PanelHarness): DeletionHarness {
  const writes: string[] = [];
  const createdJobs: DeletionHarness['createdJobs'] = [];
  const statuses: SubscriptionStatus[] = [];
  const enqueued: string[] = [];
  const warnings: string[] = [];
  const events: DeletionHarness['events'] = [];

  const tx = {
    $queryRaw: async () => (row === null ? [] : [row]),
    subscriptionEffectiveProjection: {
      updateMany: async () => {
        writes.push('projection.updateMany');
        return { count: 1 };
      },
    },
    deviceReductionPlan: {
      updateMany: async () => {
        writes.push('deviceReductionPlan.updateMany');
        return { count: 1 };
      },
    },
    profileSyncJob: {
      updateMany: async () => {
        writes.push('profileSyncJob.updateMany');
        return { count: 1 };
      },
      create: async ({ data }: { data: { action: SyncAction; payload: unknown } }) => {
        writes.push('profileSyncJob.create');
        createdJobs.push({
          action: data.action,
          payload: data.payload as Record<string, unknown>,
        });
        return { id: `job-${createdJobs.length}` };
      },
    },
    subscription: {
      update: async ({ data }: { data: { status: SubscriptionStatus } }) => {
        writes.push('subscription.update');
        statuses.push(data.status);
        return {};
      },
    },
  };
  const prisma = {
    subscription: { findUnique: async () => row },
    user: { findFirst: async () => ({ id: row?.userId ?? 'user-1' }) },
    $transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
  };
  const service = new SubscriptionDeletionService(
    prisma as never,
    {
      enqueue: async (jobId: string) => {
        enqueued.push(jobId);
      },
    } as never,
    {
      terminateForSubscriptionDeletion: async () => {
        writes.push('entitlements.terminate');
      },
    } as never,
    {
      closeForSubscriptionDeletion: async () => {
        writes.push('terms.close');
      },
    } as never,
    panel.api as never,
    {
      info: () => undefined,
      warn: (_type: string, _category: string, message: string, metadata: Record<string, unknown>) => {
        events.push({ message, metadata });
      },
    } as never,
  );
  const logger = (service as unknown as { logger: { warn: (m: string) => void } }).logger;
  logger.warn = (message: string) => {
    warnings.push(message);
  };
  return { writes, createdJobs, statuses, enqueued, warnings, events, service };
}

describe('the stale-panel-link predicate', () => {
  it('is the same shape test the reconciliation sweep selects on: a hyphen, nothing else', () => {
    assert.equal(isUuidShapedPanelIdentity(DEAD_UUID), true);
    assert.equal(isUuidShapedPanelIdentity(LIVE_DECIMAL), false);
    // A 20-digit unsigned 64-bit id is still not uuid-shaped.
    assert.equal(isUuidShapedPanelIdentity('18446744073709551615'), false);
  });

  it('refuses only on a proven 3.x panel, and answers all three eras by name', async () => {
    assert.deepEqual(await assessStoredPanelLink(async () => ({ addressing: 'id' }), DEAD_UUID), {
      trusted: false,
      because: 'uuidIdentityOn3xPanel',
    });
    assert.deepEqual(await assessStoredPanelLink(async () => ({ addressing: 'id' }), LIVE_DECIMAL), {
      trusted: true,
      because: 'identityIsCurrent',
    });
    assert.deepEqual(await assessStoredPanelLink(async () => ({ addressing: 'uuid' }), DEAD_UUID), {
      trusted: true,
      because: 'panelIs2x',
    });
    assert.deepEqual(
      await assessStoredPanelLink(async () => ({ addressing: 'unknown' }), DEAD_UUID),
      { trusted: true, because: 'panelEraUnknown' },
    );
    assert.deepEqual(
      await assessStoredPanelLink(() => Promise.reject(new Error('panel down')), DEAD_UUID),
      { trusted: true, because: 'panelEraUnknown' },
    );
  });
});

describe('SubscriptionDeletionService — the stale-link refusal', () => {
  it('THE PROOF: refuses the operator delete, writes nothing, and no panel deletion is reachable', async () => {
    // The most important case in this file. `deletePanelUser` is not stubbed at
    // all, so the only way this passes is that nothing downstream of the guard
    // ran — and `writes` pins the same property from the database side, because
    // the DELETE job is the sole route from this service to a panel deletion.
    const panel = panelHarness({ addressing: 'id' });
    const harness = deletionHarness(staleRow(), panel);

    await assert.rejects(
      () => harness.service.deleteByOperator('sub-1'),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException, 'the refusal is a 409, not a 500');
        assert.equal(error.getStatus(), 409);
        const body = error.getResponse() as { code?: string; message?: string };
        assert.equal(body.code, SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE);
        assert.equal(body.message, SUBSCRIPTION_DELETE_STALE_PANEL_LINK_MESSAGE);
        // The remedy must be NAMED. A refusal that only says something is wrong
        // sends the operator to the other half of the duplicate pair, which is
        // the same deletion wearing a different id.
        assert.match(body.message ?? '', /reconciliation/i);
        return true;
      },
    );

    assert.deepEqual(
      panel.calls,
      ['getPanelShape'],
      'the era read is the ONLY thing this path may ask the panel',
    );
    assert.deepEqual(panel.deleted, []);
    assert.deepEqual(
      harness.writes,
      [],
      'the refusal happens before the transaction: not one statement runs, so the row keeps its ' +
        'history and stays inside the panel-link reconciliation that can repair it',
    );
    assert.deepEqual(harness.createdJobs, []);
    assert.deepEqual(harness.statuses, []);
    assert.deepEqual(harness.enqueued, []);
    assert.equal(harness.events.length, 1, 'an operator-driven refusal raises exactly one event');
    assert.equal(
      harness.events[0].metadata['code'],
      SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE,
    );
  });

  it('refuses the self-service delete with the same code', async () => {
    // The cabinet's own delete reaches the same enqueue. It refuses too — the
    // alternative is a customer being able to press a button that removes
    // somebody else's service.
    const panel = panelHarness({ addressing: 'id' });
    const harness = deletionHarness(staleRow(), panel);

    await assert.rejects(
      () => harness.service.delete({ userId: 'user-1', subscriptionId: 'sub-1' }),
      (error: unknown) => {
        const body = (error as ConflictException).getResponse() as { code?: string };
        assert.equal(body.code, SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE);
        return true;
      },
    );
    assert.deepEqual(harness.writes, []);
    assert.deepEqual(panel.deleted, []);
  });

  it('2.x panel: a uuid identity is CORRECT there, and the delete behaves exactly as before', async () => {
    // The installations still on 2.x must not notice this guard at all.
    const panel = panelHarness({ addressing: 'uuid' });
    const harness = deletionHarness(staleRow(), panel);

    const result = await harness.service.deleteByOperator('sub-1');

    assert.deepEqual(result, { deleted: true, userId: 'user-1', hadRemnawaveProfile: true });
    assert.equal(harness.createdJobs.length, 1, 'the panel revocation is armed, as it always was');
    assert.equal(harness.createdJobs[0].action, SyncAction.DELETE);
    assert.equal(harness.createdJobs[0].payload['targetRemnawaveId'], DEAD_UUID);
    assert.deepEqual(harness.statuses, [SubscriptionStatus.DELETED]);
    assert.deepEqual(harness.enqueued, ['job-1']);
    assert.deepEqual(harness.events, [], 'nothing was refused, so nothing is reported');
  });

  it('unknown era: preserves today’s behaviour rather than converting "cannot tell" into "cannot act"', async () => {
    const panel = panelHarness({ addressing: 'unknown' });
    const harness = deletionHarness(staleRow(), panel);

    await harness.service.deleteByOperator('sub-1');

    assert.equal(harness.createdJobs.length, 1);
    assert.deepEqual(harness.statuses, [SubscriptionStatus.DELETED]);
  });

  it('an unreachable panel is the unknown era too, and still deletes', async () => {
    // Version detection fails for the same reasons requests fail. Refusing here
    // would fire exactly when the panel is already answering with terminal
    // errors and would turn those into "cannot act" — which the sync layer
    // classifies TRANSIENT and retries forever with no alert.
    const panel = panelHarness({ throws: true });
    const harness = deletionHarness(staleRow(), panel);

    await harness.service.deleteByOperator('sub-1');

    assert.deepEqual(panel.calls, ['getPanelShape']);
    assert.equal(harness.createdJobs.length, 1);
    assert.deepEqual(harness.statuses, [SubscriptionStatus.DELETED]);
  });

  it('3.x panel with a current decimal identity: the healthy row deletes normally', async () => {
    // The inverted-shape-test catcher. A guard that refused a decimal would
    // make every correctly-linked subscription on a 3.x panel undeletable.
    const panel = panelHarness({ addressing: 'id' });
    const harness = deletionHarness(
      staleRow({ remnawaveId: LIVE_DECIMAL, remnawavePanelId: 5150, remnawavePanelUsername: 'rz_alice_sub' }),
      panel,
    );

    await harness.service.deleteByOperator('sub-1');

    assert.equal(harness.createdJobs.length, 1);
    assert.equal(harness.createdJobs[0].payload['targetRemnawaveId'], LIVE_DECIMAL);
    assert.equal(harness.createdJobs[0].payload['targetRemnawavePanelId'], 5150);
    assert.deepEqual(harness.statuses, [SubscriptionStatus.DELETED]);
    assert.deepEqual(harness.events, []);
  });

  it('a row that never had a profile is deleted without asking the panel anything', async () => {
    const panel = panelHarness({ addressing: 'id' });
    const harness = deletionHarness(staleRow({ remnawaveId: null, configUrl: null }), panel);

    await harness.service.deleteByOperator('sub-1');

    assert.deepEqual(
      panel.calls,
      [],
      'there is no panel deletion to refuse, so the ordinary delete pays no round-trip',
    );
    assert.deepEqual(harness.createdJobs, [], 'no identity, no revocation job — unchanged');
    assert.deepEqual(harness.statuses, [SubscriptionStatus.DELETED]);
  });

  it('the expired sweep DEFERS instead of throwing, and says which deferral it was', async () => {
    // A cron has nobody to answer to and cannot run the remedy. Throwing would
    // only become an unhandled rejection the sweep logs as "failed to
    // schedule"; deferring leaves the row exactly where the reconciliation can
    // still reach it, and the flag is what lets the sweep count this apart from
    // the transient deferrals that drain on their own.
    const panel = panelHarness({ addressing: 'id' });
    const harness = deletionHarness(staleRow({ status: SubscriptionStatus.EXPIRED }), panel);

    const result = await harness.service.deleteExpiredIfUnchanged({
      subscriptionId: 'sub-1',
      expectedExpiresAt: new Date('2026-01-01T00:00:00.000Z'),
      expectedRemnawaveId: DEAD_UUID,
      cutoff: new Date('2026-06-01T00:00:00.000Z'),
    });

    assert.deepEqual(result, { deleted: false, syncJobId: null, refusedStalePanelLink: true });
    assert.deepEqual(harness.writes, []);
    assert.deepEqual(panel.deleted, []);
    assert.equal(harness.warnings.length, 1, 'the log line is unconditional');
    assert.match(harness.warnings[0], /reconciliation/i);
    assert.deepEqual(
      harness.events,
      [],
      'no event per row per sweep: the cleanup runs every thirty minutes over a population that ' +
        'stays refused until somebody repairs it, and that is how an alert stops being read',
    );
  });

  it('a healthy expired row still retires through the sweep, flag clear', async () => {
    const panel = panelHarness({ addressing: 'id' });
    const harness = deletionHarness(
      staleRow({ status: SubscriptionStatus.EXPIRED, remnawaveId: LIVE_DECIMAL, remnawavePanelId: 5150 }),
      panel,
    );

    const result = await harness.service.deleteExpiredIfUnchanged({
      subscriptionId: 'sub-1',
      expectedExpiresAt: new Date('2026-01-01T00:00:00.000Z'),
      expectedRemnawaveId: LIVE_DECIMAL,
      cutoff: new Date('2026-06-01T00:00:00.000Z'),
    });

    assert.deepEqual(result, { deleted: true, syncJobId: 'job-1', refusedStalePanelLink: false });
    assert.deepEqual(harness.statuses, [SubscriptionStatus.DELETED]);
  });
});

// ── UserDeletionService ─────────────────────────────────────────────────────

interface UserDeletionHarness {
  readonly deletedUsers: string[];
  readonly errors: string[];
  readonly service: UserDeletionService;
}

function userDeletionHarness(
  snapshots: ReadonlyArray<Record<string, unknown>>,
  panel: PanelHarness,
): UserDeletionHarness {
  const deletedUsers: string[] = [];
  const errors: string[] = [];
  const prisma = {
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        transaction: { count: async () => 0 },
        promocodeActivation: { count: async () => 0 },
        referralPointsExchange: { count: async () => 0 },
        referralReward: { count: async () => 0 },
        partnerTransaction: { count: async () => 0 },
        partnerWithdrawal: { count: async () => 0 },
        trialClaim: { count: async () => 0 },
        subscription: { findMany: async () => snapshots },
        user: {
          delete: async ({ where }: { where: { id: string } }) => {
            deletedUsers.push(where.id);
            return {};
          },
        },
      }),
  };
  const service = new UserDeletionService(prisma as never, panel.api as never);
  const logger = (
    service as unknown as { logger: { error: (m: string) => void; warn: (m: string) => void } }
  ).logger;
  logger.error = (message: string) => {
    errors.push(message);
  };
  logger.warn = (message: string) => {
    errors.push(message);
  };
  return { deletedUsers, errors, service };
}

describe('UserDeletionService — deleting a customer must stay possible', () => {
  it('THE PROOF: one stale subscription does not block the deletion, it only skips the panel call', async () => {
    // If a whole-user deletion could be blocked by one un-repaired row, that
    // would be a worse outcome than the bug: the operator could not remove a
    // customer at all. The local rows are committed BEFORE this loop by design,
    // so there is nothing left to refuse — only the upstream call is skipped.
    // `deletePanelUser` is again not stubbed, so reaching it is a crash.
    const panel = panelHarness({ addressing: 'id' });
    const harness = userDeletionHarness(
      [
        {
          id: 'sub-1',
          remnawaveId: DEAD_UUID,
          remnawavePanelId: null,
          remnawavePanelUsername: 'rz_alice_sub',
          configUrl: 'https://sub.example.test/OLDshortOLD',
        },
      ],
      panel,
    );

    await harness.service.deleteUser('user-1');

    assert.deepEqual(harness.deletedUsers, ['user-1'], 'the customer IS deleted');
    assert.deepEqual(panel.calls, ['getPanelShape']);
    assert.deepEqual(panel.deleted, []);
    assert.equal(harness.errors.length, 1);
    assert.match(harness.errors[0], new RegExp(SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE));
    assert.match(
      harness.errors[0],
      /rz_alice_sub/,
      'the orphan is named, because removing it by hand is now the only way it goes',
    );
  });

  it('still deletes the panel account when the stored identity is current on 3.x', async () => {
    const panel = panelHarness({ addressing: 'id', allowDelete: true });
    const harness = userDeletionHarness(
      [
        {
          id: 'sub-1',
          remnawaveId: LIVE_DECIMAL,
          remnawavePanelId: 5150,
          remnawavePanelUsername: 'rz_alice_sub',
          configUrl: null,
        },
      ],
      panel,
    );

    await harness.service.deleteUser('user-1');

    assert.deepEqual(harness.deletedUsers, ['user-1']);
    assert.deepEqual(panel.calls, ['getPanelShape', 'deletePanelUser']);
    assert.deepEqual(panel.deleted, [
      { remnawaveId: LIVE_DECIMAL, panelId: 5150, panelUsername: 'rz_alice_sub' },
    ]);
    assert.deepEqual(harness.errors, []);
  });

  it('one stale subscription does not stop a sibling row from being removed upstream', async () => {
    // The skip is per row. Folding it into "abandon the loop" would strand
    // every profile after the first damaged one.
    const panel = panelHarness({ addressing: 'id', allowDelete: true });
    const harness = userDeletionHarness(
      [
        { id: 'sub-stale', remnawaveId: DEAD_UUID, remnawavePanelId: null, remnawavePanelUsername: 'rz_old', configUrl: null },
        { id: 'sub-live', remnawaveId: LIVE_DECIMAL, remnawavePanelId: 5150, remnawavePanelUsername: 'rz_new', configUrl: null },
      ],
      panel,
    );

    await harness.service.deleteUser('user-1');

    assert.deepEqual(harness.deletedUsers, ['user-1']);
    assert.deepEqual(panel.calls, ['getPanelShape', 'getPanelShape', 'deletePanelUser']);
    assert.deepEqual(panel.deleted, [
      { remnawaveId: LIVE_DECIMAL, panelId: 5150, panelUsername: 'rz_new' },
    ]);
  });

  it('2.x panel: a uuid identity is deleted upstream exactly as before', async () => {
    const panel = panelHarness({ addressing: 'uuid', allowDelete: true });
    const harness = userDeletionHarness(
      [
        {
          id: 'sub-1',
          remnawaveId: DEAD_UUID,
          remnawavePanelId: null,
          remnawavePanelUsername: 'rz_alice_sub',
          configUrl: null,
        },
      ],
      panel,
    );

    await harness.service.deleteUser('user-1');

    assert.deepEqual(panel.calls, ['getPanelShape', 'deletePanelUser']);
    assert.deepEqual(panel.deleted, [
      { remnawaveId: DEAD_UUID, panelId: null, panelUsername: 'rz_alice_sub' },
    ]);
    assert.deepEqual(harness.errors, []);
  });
});

// ── DEVICE DELETION: THE SAME ADDRESS MECHANISM, A DIFFERENT VERB ───────────

/**
 * `deletePanelUserDevice` names its owner through the SAME `panelUserAddress`
 * fallback the subscription delete does — numeric fast path → `remnawavePanelId`
 * → the short uuid recovered from `config_url` → `remnawavePanelUsername`. So on
 * a 3.x panel an HWID revocation issued against an unrepaired row reaches
 * whatever account is LIVE at that address and unbinds a device from it. The
 * subscription delete has been guarded since the stale-link work; these three
 * call sites were not guarded at all.
 *
 * WHY THE STUB RECORDS RATHER THAN BEING ABSENT. The refusal cases assert that
 * `deletedDevices` is empty, and an empty array is only evidence if the fake
 * would have filled it — so `deletePanelUserDevice` is always present, always
 * records, and the `INERTNESS CONTROL` case beside each refusal proves it does
 * by driving the same harness with a healthy link and asserting the exact
 * arguments that arrive. Every "nothing was called" below is therefore a real
 * zero rather than a method that does not exist.
 */

interface DevicePanelHarness {
  /** Every adapter method reached, in order. */
  readonly calls: string[];
  /** Every `(identity, hwid, era)` triple that reached the adapter. */
  readonly deletedDevices: Array<{ ref: unknown; hwid: string; era: unknown }>;
  readonly api: unknown;
}

function devicePanelHarness(
  options: { addressing?: Addressing; throws?: boolean } = {},
): DevicePanelHarness {
  const calls: string[] = [];
  const deletedDevices: DevicePanelHarness['deletedDevices'] = [];
  const api = {
    getPanelShape: async () => {
      calls.push('getPanelShape');
      if (options.throws === true) throw new Error('Remnawave version could not be read');
      return { addressing: options.addressing ?? 'unknown' };
    },
    deletePanelUserDevice: async (ref: unknown, hwid: string, era: unknown) => {
      calls.push('deletePanelUserDevice');
      deletedDevices.push({ ref, hwid, era });
      return { total: 2 };
    },
  };
  return { calls, deletedDevices, api };
}

interface DeviceRow {
  id: string;
  userId: string;
  remnawaveId: string | null;
  remnawavePanelId: number | null;
  remnawavePanelUsername: string | null;
  configUrl: string | null;
}

/** The unrepaired importer row: a dead 2.x uuid and no supplementary columns. */
function staleDeviceRow(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: 'sub-1',
    userId: 'user-1',
    remnawaveId: DEAD_UUID,
    remnawavePanelId: null,
    remnawavePanelUsername: null,
    // The saved subscription link is what makes the fallback resolve rather
    // than refuse — it is the route from a dead uuid to a live account.
    configUrl: 'https://sub.example.test/OLDshortOLD',
    ...overrides,
  };
}

/** The repaired row, as a 3.x panel names it. */
function healthyDeviceRow(): DeviceRow {
  return {
    id: 'sub-1',
    userId: 'user-1',
    remnawaveId: LIVE_DECIMAL,
    remnawavePanelId: 5150,
    remnawavePanelUsername: 'rz_alice_sub',
    configUrl: null,
  };
}

const STALE_IDENTITY = {
  remnawaveId: DEAD_UUID,
  panelId: null,
  panelUsername: null,
  panelShortUuid: 'OLDshortOLD',
};
const HEALTHY_IDENTITY = {
  remnawaveId: LIVE_DECIMAL,
  panelId: 5150,
  panelUsername: 'rz_alice_sub',
};

function internalDeviceController(row: DeviceRow | null, panel: DevicePanelHarness) {
  const errors: string[] = [];
  const prisma = {
    user: { findUnique: async () => ({ id: 'user-1', telegramId: null, username: null, name: null }) },
    subscription: { findFirst: async () => row },
  };
  const controller = new InternalUserDevicesController(
    prisma as never,
    panel.api as never,
    { info: () => undefined, error: () => undefined } as never,
  );
  const logger = (controller as unknown as { logger: { error: (m: string) => void } }).logger;
  logger.error = (message: string) => {
    errors.push(message);
  };
  return { controller, errors };
}

function adminSubscriptionsController(row: DeviceRow | null, panel: DevicePanelHarness) {
  const prisma = {
    subscription: {
      findUnique: async () => (row === null ? null : { ...row, user: null }),
    },
    // Revoking a device is now audited. Inert here: this file is about the
    // stale-link refusal, and the row is written only on the paths that get
    // past it.
    adminAuditLog: { create: async () => ({}) },
  };
  const controller = new AdminUserSubscriptionsController(
    prisma as never,
    panel.api as never,
    {} as never,
    { info: () => undefined } as never,
    {} as never,
    {} as never,
  );
  return { controller };
}

/** Both halves of the refusal a caller sees, from whichever surface raised it. */
function refusalBodyOf(error: unknown): { code?: string; message?: string; status: number } {
  assert.ok(error instanceof ConflictException, `expected a 409 ConflictException, got ${String(error)}`);
  const body = error.getResponse() as { code?: string; message?: string };
  return { code: body.code, message: body.message, status: error.getStatus() };
}

describe('device deletion is refused on a stale panel link, at every call site', () => {
  it('SITE 1 — internal deleteDevice (cabinet, current subscription): refuses and calls no panel deletion', async () => {
    const panel = devicePanelHarness({ addressing: 'id' });
    const { controller, errors } = internalDeviceController(staleDeviceRow(), panel);

    const refusal = refusalBodyOf(
      await controller.deleteDevice('123456789', 'hwid-x').then(() => null, (e: unknown) => e),
    );

    assert.equal(refusal.status, 409);
    assert.equal(refusal.code, SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE);
    assert.equal(
      refusal.message,
      SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE,
      'reiwa serves a customer, who cannot open the Subscriptions page the operator sentence names',
    );
    assert.deepEqual(
      panel.calls,
      ['getPanelShape'],
      'the era read is the ONLY thing this path may ask the panel',
    );
    assert.deepEqual(panel.deletedDevices, [], 'no device was unbound on the panel');
    assert.equal(errors.length, 1, 'the refusal is said out loud once, so the orphan is traceable');
    assert.match(errors[0], /reconciliation/i);
  });

  it('SITE 1 — INERTNESS CONTROL: the same harness DOES record a legitimate revocation', async () => {
    const panel = devicePanelHarness({ addressing: 'id' });
    const { controller, errors } = internalDeviceController(healthyDeviceRow(), panel);

    const result = await controller.deleteDevice('123456789', 'hwid-x');

    assert.deepEqual(result, { revoked: true, remainingDevices: 2 });
    assert.deepEqual(panel.calls, ['getPanelShape', 'deletePanelUserDevice']);
    assert.deepEqual(panel.deletedDevices, [
      // The identity, the hwid, AND the era: the observation the guard judged is
      // the observation the adapter builds the request from. One `getPanelShape`
      // above is the other half of that claim.
      { ref: HEALTHY_IDENTITY, hwid: 'hwid-x', era: { addressing: 'id' } },
    ]);
    assert.deepEqual(errors, []);
  });

  it('SITE 2 — internal deleteSubscriptionDevice (cabinet, selected card): refuses and calls no panel deletion', async () => {
    const panel = devicePanelHarness({ addressing: 'id' });
    const { controller, errors } = internalDeviceController(staleDeviceRow(), panel);

    const refusal = refusalBodyOf(
      await controller
        .deleteSubscriptionDevice('123456789', 'sub-1', 'hwid-x')
        .then(() => null, (e: unknown) => e),
    );

    assert.equal(refusal.status, 409);
    assert.equal(refusal.code, SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE);
    assert.equal(refusal.message, SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE);
    assert.deepEqual(panel.calls, ['getPanelShape']);
    assert.deepEqual(panel.deletedDevices, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /reconciliation/i);
  });

  it('SITE 2 — INERTNESS CONTROL: the same harness DOES record a legitimate revocation', async () => {
    const panel = devicePanelHarness({ addressing: 'id' });
    const { controller } = internalDeviceController(healthyDeviceRow(), panel);

    const result = await controller.deleteSubscriptionDevice('123456789', 'sub-1', 'hwid-x');

    assert.deepEqual(result, { revoked: true, remainingDevices: 2 });
    assert.deepEqual(panel.calls, ['getPanelShape', 'deletePanelUserDevice']);
    assert.deepEqual(panel.deletedDevices, [
      { ref: HEALTHY_IDENTITY, hwid: 'hwid-x', era: { addressing: 'id' } },
    ]);
  });

  it('SITE 3 — admin revokeDevice (operator panel): refuses with the OPERATOR sentence', async () => {
    const panel = devicePanelHarness({ addressing: 'id' });
    const { controller } = adminSubscriptionsController(staleDeviceRow(), panel);

    const refusal = refusalBodyOf(
      await controller
        .revokeDevice('sub-1', 'hwid-x', { id: 'admin-1' } as never, { headers: {}, socket: {} } as never)
        .then(() => null, (e: unknown) => e),
    );

    assert.equal(refusal.status, 409);
    assert.equal(refusal.code, SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE);
    assert.equal(
      refusal.message,
      SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_MESSAGE,
      'this reader CAN run the repair, so the refusal names it',
    );
    assert.match(refusal.message ?? '', /reconciliation/i);
    assert.deepEqual(panel.calls, ['getPanelShape']);
    assert.deepEqual(panel.deletedDevices, []);
  });

  it('SITE 3 — INERTNESS CONTROL: the same harness DOES record a legitimate revocation', async () => {
    const panel = devicePanelHarness({ addressing: 'id' });
    const { controller } = adminSubscriptionsController(healthyDeviceRow(), panel);

    const result = await controller.revokeDevice('sub-1', 'hwid-x', { id: 'admin-1' } as never, { headers: {}, socket: {} } as never);

    assert.deepEqual(result, { revoked: true, remainingDevices: 2 });
    assert.deepEqual(panel.calls, ['getPanelShape', 'deletePanelUserDevice']);
    assert.deepEqual(panel.deletedDevices, [
      { ref: HEALTHY_IDENTITY, hwid: 'hwid-x', era: { addressing: 'id' } },
    ]);
  });

  it('the two audiences get one code and two sentences, and the customer is never sent to an operator screen', () => {
    // One code, because a client BRANCHES on it and both clients face the same
    // situation. Two sentences, because the fallback a client prints when it
    // does not know the code yet must be sayable to whoever is reading.
    assert.notEqual(
      SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_MESSAGE,
      SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE,
    );
    assert.match(SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_MESSAGE, /reconciliation/i);
    assert.doesNotMatch(
      SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE,
      /reconciliation|Subscriptions page/i,
      'naming a screen the customer cannot open is a dead end, not a next step',
    );
    // And it is a DIFFERENT code from the subscription refusal: a client that
    // shared them would offer "delete it again" on a device dialog.
    assert.notEqual(
      SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE,
      SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE,
    );
  });
});

describe('device deletion on a link that is NOT stale is untouched', () => {
  it('2.x panel: a uuid identity is what that panel issued, so the revocation goes through', async () => {
    // Installations still on 2.x must not notice this guard at all.
    const panel = devicePanelHarness({ addressing: 'uuid' });
    const { controller } = internalDeviceController(staleDeviceRow(), panel);

    const result = await controller.deleteDevice('123456789', 'hwid-x');

    assert.deepEqual(result, { revoked: true, remainingDevices: 2 });
    assert.deepEqual(panel.deletedDevices, [
      { ref: STALE_IDENTITY, hwid: 'hwid-x', era: { addressing: 'uuid' } },
    ]);
  });

  it('an unreadable era still revokes — the fail-open is the same on this verb', async () => {
    // Same stance as the subscription delete, and for the same reason: version
    // detection fails for the reasons requests fail, so refusing on it would
    // fire exactly when the panel is already answering with terminal errors.
    const panel = devicePanelHarness({ throws: true });
    const { controller } = adminSubscriptionsController(staleDeviceRow(), panel);

    const result = await controller.revokeDevice('sub-1', 'hwid-x', { id: 'admin-1' } as never, { headers: {}, socket: {} } as never);

    assert.deepEqual(result, { revoked: true, remainingDevices: 2 });
    assert.deepEqual(panel.calls, ['getPanelShape', 'deletePanelUserDevice']);
    assert.deepEqual(panel.deletedDevices, [
      { ref: STALE_IDENTITY, hwid: 'hwid-x', era: { addressing: 'unknown' } },
    ]);
  });
});

// ── ProfileSyncProcessor.handleDelete ───────────────────────────────────────

/**
 * The panel client the DELETE worker calls, and nothing else.
 *
 * `deleteUser` IS ABSENT UNLESS `allowDelete` IS SET, and that absence is the
 * strongest assertion in this block. A refusing case that stubbed it would
 * record a call and then pass its "no deletion" check by comparing arrays; with
 * the method missing, a deletion that slips through dies with "not a function"
 * instead of being silently recorded and asserted away.
 *
 * THERE IS NO ERA READ TO STUB ANY MORE. The worker used to observe the panel
 * shape and hand that observation to the adapter; a 2.x panel is now refused
 * centrally by `LegacyPanelRefusal`, so the guard tests the STORED identity
 * alone and the client is only ever asked to delete.
 */
function panelUsersHarness(options: { allowDelete?: boolean } = {}): {
  readonly calls: string[];
  readonly deleted: number[];
  readonly client: unknown;
} {
  const calls: string[] = [];
  const deleted: number[] = [];
  const client: Record<string, unknown> = {};
  if (options.allowDelete === true) {
    client['deleteUser'] = async (userId: number) => {
      calls.push('deleteUser');
      deleted.push(userId);
      return { kind: 'ok', drifted: false, data: undefined };
    };
  }
  return { calls, deleted, client };
}

/**
 * The DELETE worker, built around one durable job.
 *
 * This is the LAST LINE OF DEFENCE, and it is not redundant with the
 * creation-time guard: every DELETE job written before that guard existed is
 * still sitting in `profile_sync_jobs` as PENDING or FAILED, carrying a target
 * nobody re-examines. The creation-time refusal cannot reach those.
 */
function deleteWorker(
  payloadTarget: string,
  panel: { readonly client: unknown },
): { processor: ProfileSyncProcessor; failures: unknown[] } {
  const failures: unknown[] = [];
  const processor = new ProfileSyncProcessor(
    {
      profileSyncJob: {
        findUnique: async () => ({
          id: 'sync-job-delete',
          action: SyncAction.DELETE,
          status: SyncJobStatus.PENDING,
          attempts: 0,
          supersededAt: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          payload: { targetRemnawaveId: payloadTarget, targetRemnawavePanelUsername: 'rz_alice_sub' },
          subscription: {
            id: 'subscription-1',
            userId: 'user-1',
            remnawaveId: payloadTarget,
            status: SubscriptionStatus.DELETED,
            trafficLimit: null,
            deviceLimit: 0,
            internalSquads: [],
            externalSquad: null,
            expiresAt: new Date('2020-01-01T00:00:00.000Z'),
            planSnapshot: {},
          },
        }),
        updateMany: async (input: unknown) => {
          const data = (input as { data?: { status?: unknown } }).data;
          if (data?.status === SyncJobStatus.FAILED) failures.push(input);
          return { count: 1 };
        },
        update: async () => undefined,
      },
      subscription: {
        // No other row claims the profile, so the pre-existing collision guard
        // is disarmed — which is precisely the state the importer left behind.
        findMany: async () => [],
        updateMany: async () => ({ count: 1 }),
      },
    } as never,
    panel.client as never,
    {} as never,
    { error: () => undefined, info: () => undefined } as never,
  );
  return { processor, failures };
}

describe('ProfileSyncProcessor.handleDelete — the queued-job backlog', () => {
  it('THE PROOF: refuses a queued DELETE whose target is a 2.x uuid', async () => {
    const panel = panelUsersHarness();
    const { processor, failures } = deleteWorker(DEAD_UUID, panel);

    await assert.rejects(
      () => processor.process({ data: { syncJobId: 'sync-job-delete' } } as never),
      // Matched on the CODE, not merely on "it threw". `deleteUser` is not
      // stubbed, so an unguarded build also throws — with a TypeError — and a
      // bare `assert.rejects` would score that as a pass.
      new RegExp(SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE),
    );

    // NOTHING went to the panel — not even the resolve that would turn the
    // recorded username into a numeric id. That resolve is the dangerous half:
    // panel usernames are deterministic, so it lands on whatever profile now
    // carries the name, which on a re-provisioned customer is a live one.
    assert.deepEqual(panel.calls, []);
    assert.deepEqual(panel.deleted, []);
    assert.equal(failures.length, 1, 'the job is recorded FAILED so an operator is told');
  });

  it('refuses WITHOUT asking the panel what version it is', async () => {
    // The guard used to observe the panel era and refuse only on a proven 3.x
    // answer, which meant an unreadable era let the delete through. There is one
    // era now, so the refusal turns on the STORED identity alone — and the
    // client this worker holds has no version call on it at all, so a build that
    // reintroduced the probe would fail here rather than pass quietly.
    const panel = panelUsersHarness({ allowDelete: true });
    const { processor } = deleteWorker(DEAD_UUID, panel);

    await assert.rejects(
      () => processor.process({ data: { syncJobId: 'sync-job-delete' } } as never),
      new RegExp(SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE),
    );

    assert.deepEqual(panel.deleted, [], 'a uuid target is refused however the panel answers');
  });

  it('a current decimal target is deleted, so ordinary retirement still works', async () => {
    const panel = panelUsersHarness({ allowDelete: true });
    const { processor } = deleteWorker(LIVE_DECIMAL, panel);

    await processor.process({ data: { syncJobId: 'sync-job-delete' } } as never);

    assert.deepEqual(panel.calls, ['deleteUser']);
    // Addressed by the numeric id the row already stores — no resolve, no
    // username, no second chance to land on somebody else's profile.
    assert.deepEqual(panel.deleted, [Number(LIVE_DECIMAL)]);
  });
});
