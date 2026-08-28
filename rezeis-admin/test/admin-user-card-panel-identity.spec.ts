/**
 * The admin "User → Subscription" card names the panel profile the SAME way
 * every other caller does.
 *
 * It used to hand the adapter the bare `remnawaveId` string. On a 2.x panel
 * that is the uuid the path wants and nothing is wrong; on a 3.x panel a
 * profile provisioned before the upgrade still stores that uuid — the panel's
 * own migration drops the column and we do not — and a uuid in an id slot earns
 * `400 expected number, received NaN`. `getPanelUser` swallows every failure
 * into `null`, so the card rendered a blank name and description with no error
 * anywhere. The recorded numeric id and panel username are the second and third
 * angles on the same identity, and the row already carries them.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SyncAction, SyncJobStatus } from '@prisma/client';

import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';

const UUID = '11111111-1111-4111-8111-111111111111';

interface ProfileSyncJobRow {
  readonly subscriptionId: string;
  readonly status: SyncJobStatus;
  readonly action: SyncAction;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly updatedAt: Date;
}

interface ProfileSyncJobQuery {
  readonly where?: {
    readonly subscriptionId?: { readonly in?: readonly string[] };
    readonly supersededAt?: Date | null;
  };
}

function buildController(
  subscriptions: ReadonlyArray<Record<string, unknown>>,
  outcome: { kind: string; user?: Record<string, unknown> } = {
    kind: 'ok',
    user: { username: 'rz_sub_1', description: 'reiwa_id: user-1' },
  },
  // The delegate the ORIGINAL mock left out entirely. Its absence took the
  // controller's own `profileSyncJobDelegate === undefined ? []` guard, so no
  // job ever reached the state machine and the four-state half of it was
  // unreachable from this file. `profileSyncJobCalls` exists so a test can
  // prove the delegate was consulted rather than quietly skipped again.
  profileSyncJobs: ReadonlyArray<ProfileSyncJobRow> = [],
) {
  const panelLookups: unknown[] = [];
  const profileSyncJobCalls: ProfileSyncJobQuery[] = [];
  const controller = new AdminUserManagementController(
    {
      user: {
        findFirst: async () => ({
          id: 'user-1',
          telegramId: 123,
          acquisitionPlacementId: null,
          acquisitionAt: null,
          currentSubscriptionId: null,
          referralInviteSettings: null,
        }),
      },
      subscription: { findMany: async () => subscriptions },
      profileSyncJob: {
        findMany: async (query: ProfileSyncJobQuery) => {
          profileSyncJobCalls.push(query);
          return profileSyncJobs;
        },
      },
      transaction: { findMany: async () => [] },
      referral: { findFirst: async () => null, findMany: async () => [] },
      partner: { findUnique: async () => null },
      webAccount: { findFirst: async () => null },
      partnerReferral: { findFirst: async () => null },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { getEffectiveLimitsForUser: async () => ({}) } as never,
    {
      getPanelUserOutcome: async (ref: unknown) => {
        panelLookups.push(ref);
        return outcome;
      },
    } as never,
    {} as never,
    { hasPermission: async () => false } as never,
    {} as never,
    {} as never,
    {} as never, // PlansAdminService
    undefined as never, // UserBlockService
  );
  return { controller, panelLookups, profileSyncJobCalls };
}

const ADMIN = { id: 'admin-1', role: 'ADMIN', rbacRoleId: null } as never;

describe('AdminUserManagementController — the subscription card addresses the panel by full identity', () => {
  it('passes the recorded numeric id, panel username and short uuid, not the bare string', async () => {
    const { controller, panelLookups } = buildController([
      {
        id: 'subscription-1',
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        planSnapshot: {},
        // Provisioned on 2.x — `remnawaveId` is the uuid — but every supplementary
        // column has since been recorded, which is what keeps it addressable on
        // an upgraded panel.
        remnawaveId: UUID,
        remnawavePanelId: 4471,
        remnawavePanelUsername: 'rz_sub_1',
        configUrl: 'https://panel.example/sub/abc',
      },
    ]);

    const result = await controller.getUser('123', ADMIN);

    assert.deepStrictEqual(panelLookups, [
      {
        remnawaveId: UUID,
        panelId: 4471,
        panelUsername: 'rz_sub_1',
        // Recovered from the saved subscription URL — on 3.x a safer resolver
        // than the username, which is deterministic and therefore reusable.
        panelShortUuid: 'abc',
      },
    ]);
    assert.equal(result.subscriptions[0]!.remnawaveProfileName, 'rz_sub_1');
    assert.equal(result.subscriptions[0]!.remnawaveProfileDescription, 'reiwa_id: user-1');
  });

  it('still asks nothing for a subscription with no panel profile yet', async () => {
    const { controller, panelLookups } = buildController([
      {
        id: 'subscription-1',
        expiresAt: null,
        planSnapshot: {},
        remnawaveId: null,
        remnawavePanelId: null,
        remnawavePanelUsername: null,
        configUrl: null,
      },
    ]);

    const result = await controller.getUser('123', ADMIN);

    assert.deepStrictEqual(panelLookups, []);
    assert.equal(result.subscriptions[0]!.remnawaveProfileName, null);
  });

  it('reports a missing profile separately from an unavailable panel', async () => {
    const subscription = {
      id: 'subscription-1',
      expiresAt: null,
      planSnapshot: {},
      remnawaveId: '4471',
      remnawavePanelId: 4471,
      remnawavePanelUsername: 'rz_sub_1',
      configUrl: null,
    };

    const missing = await buildController([subscription], { kind: 'missing' }).controller.getUser('123', ADMIN);
    assert.equal(missing.subscriptions[0]!.remnawaveSyncState, 'MISSING');

    const unavailable = await buildController([subscription], { kind: 'unavailable' }).controller.getUser('123', ADMIN);
    assert.equal(unavailable.subscriptions[0]!.remnawaveSyncState, 'UNAVAILABLE');
  });

  /**
   * Every state the card can report, enumerated FROM THE CONTROLLER'S OWN TYPE.
   *
   * The test this replaces was named for pending and failed jobs and asserted
   * neither: its prisma mock carried no `profileSyncJob` delegate, so the
   * controller's `profileSyncJobDelegate === undefined ? []` guard fired, `job`
   * was permanently `null`, and the only state reachable from here was the one
   * it asserted. Four of the six states — in a change whose entire subject is
   * sync state — were guarded by nothing.
   *
   * `Record<RemnawaveSyncState, ...>` is the part that keeps this honest: the
   * key set is derived from what `getUser` actually returns, so a seventh state
   * added to the controller fails `npm run typecheck:test` until someone says
   * which fixtures produce it. A hand-written list of six strings would have
   * gone on passing.
   */
  type SubscriptionCard = Awaited<
    ReturnType<AdminUserManagementController['getUser']>
  >['subscriptions'][number];
  type RemnawaveSyncState = SubscriptionCard['remnawaveSyncState'];

  const JOB_AT = new Date('2026-02-03T04:05:06.000Z');
  const OK_OUTCOME = { kind: 'ok', user: { username: 'rz_sub_1', description: 'reiwa_id: user-1' } };

  const LINKED = {
    id: 'subscription-1',
    expiresAt: null,
    planSnapshot: {},
    remnawaveId: '4471',
    remnawavePanelId: 4471,
    remnawavePanelUsername: 'rz_sub_1',
    configUrl: null,
  };
  // `storedIdentityOf` answers null on a null `remnawaveId` alone, which is what
  // sends a row down the unlinked branch.
  const UNLINKED = { ...LINKED, remnawaveId: null, remnawavePanelId: null, remnawavePanelUsername: null };

  const job = (status: SyncJobStatus, overrides: Partial<ProfileSyncJobRow> = {}): ProfileSyncJobRow => ({
    subscriptionId: 'subscription-1',
    status,
    action: SyncAction.UPDATE,
    attempts: 2,
    lastError: status === SyncJobStatus.FAILED ? 'panel refused the update' : null,
    updatedAt: JOB_AT,
    ...overrides,
  });

  interface StateCase {
    readonly name: string;
    readonly subscription: Record<string, unknown>;
    readonly outcome: { kind: string; user?: Record<string, unknown> };
    readonly job: ProfileSyncJobRow | null;
  }

  const SYNC_STATE_CASES: Record<RemnawaveSyncState, readonly StateCase[]> = {
    UNLINKED: [
      { name: 'never provisioned, no job', subscription: UNLINKED, outcome: OK_OUTCOME, job: null },
      { name: 'never provisioned, last job completed', subscription: UNLINKED, outcome: OK_OUTCOME, job: job(SyncJobStatus.COMPLETED) },
    ],
    PENDING: [
      { name: 'linked, job queued', subscription: LINKED, outcome: OK_OUTCOME, job: job(SyncJobStatus.PENDING) },
      // RUNNING is a distinct status the mapping folds into the same state; a
      // fixture for only one of the two would leave the `||` arm unguarded.
      { name: 'linked, job running', subscription: LINKED, outcome: OK_OUTCOME, job: job(SyncJobStatus.RUNNING) },
      { name: 'not yet linked, create queued', subscription: UNLINKED, outcome: OK_OUTCOME, job: job(SyncJobStatus.PENDING, { action: SyncAction.CREATE }) },
    ],
    SYNCED: [
      { name: 'linked, panel answers, no job', subscription: LINKED, outcome: OK_OUTCOME, job: null },
      { name: 'linked, panel answers, last job completed', subscription: LINKED, outcome: OK_OUTCOME, job: job(SyncJobStatus.COMPLETED) },
    ],
    MISSING: [
      { name: 'panel says no such profile', subscription: LINKED, outcome: { kind: 'missing' }, job: null },
      // The panel's answer outranks the job on the not-ok side. Worth pinning:
      // a queued job must not soften "this profile is gone" into "hang on".
      { name: 'panel says no such profile while a job is queued', subscription: LINKED, outcome: { kind: 'missing' }, job: job(SyncJobStatus.PENDING) },
    ],
    UNAVAILABLE: [
      // The 400-is-not-404 case: an unreachable or unaddressable panel must not
      // read as a deleted profile.
      { name: 'panel unreachable', subscription: LINKED, outcome: { kind: 'unavailable' }, job: null },
      { name: 'panel unreachable while a job failed', subscription: LINKED, outcome: { kind: 'unavailable' }, job: job(SyncJobStatus.FAILED) },
    ],
    FAILED: [
      { name: 'linked, panel answers, last job failed', subscription: LINKED, outcome: OK_OUTCOME, job: job(SyncJobStatus.FAILED) },
      { name: 'not linked, create failed', subscription: UNLINKED, outcome: OK_OUTCOME, job: job(SyncJobStatus.FAILED, { action: SyncAction.CREATE }) },
    ],
  };

  it('classifies every sync state the card can report, from a delegate it provably consulted', async () => {
    const observed = new Set<RemnawaveSyncState>();

    for (const [expected, cases] of Object.entries(SYNC_STATE_CASES)) {
      for (const testCase of cases) {
        const where = expected + ' / ' + testCase.name;
        const { controller, profileSyncJobCalls } = buildController(
          [testCase.subscription],
          testCase.outcome,
          testCase.job === null ? [] : [testCase.job],
        );

        const card = (await controller.getUser('123', ADMIN)).subscriptions[0]!;
        assert.equal(card.remnawaveSyncState, expected, where);
        observed.add(card.remnawaveSyncState);

        // ANTI-VACUITY 1 — the failure mode this test is a repair for was a
        // mock that answered nothing and still passed. Assert the delegate was
        // reached, and that it was asked the question the feature depends on:
        // live jobs only, scoped to this subscription.
        assert.equal(profileSyncJobCalls.length, 1, where + ': sync-job delegate was never consulted');
        assert.deepStrictEqual(
          profileSyncJobCalls[0]?.where,
          { subscriptionId: { in: ['subscription-1'] }, supersededAt: null },
          where + ': wrong sync-job query',
        );

        // ANTI-VACUITY 2 — and that what it answered reached the response. A
        // swallowed delegate leaves this null while the state above can still
        // land on SYNCED or UNLINKED by accident, which is exactly how the
        // original passed.
        assert.deepStrictEqual(
          card.remnawaveSyncJob,
          testCase.job === null ? null : {
            status: testCase.job.status,
            action: testCase.job.action,
            attempts: testCase.job.attempts,
            lastError: testCase.job.lastError,
            updatedAt: JOB_AT.toISOString(),
          },
          where + ': job did not reach the card',
        );
      }
    }

    // ANTI-VACUITY 3 — a mapping that returned one constant would satisfy any
    // single row above. Six distinct states must have actually been observed.
    assert.deepStrictEqual([...observed].sort(), Object.keys(SYNC_STATE_CASES).sort());

    // ANTI-VACUITY 4, at compile time — `Record<RemnawaveSyncState, ...>` only
    // enforces exhaustiveness while that type is a literal union. Had `getUser`
    // inference widened it to `string`, `Record<string, ...>` would accept any
    // key set and this file would be back to guarding nothing by a different
    // route. Assigning the derived type INTO the named six is what catches the
    // widening; it also fails if a seventh state arrives unnamed here.
    const closedStateType: 'UNLINKED' | 'PENDING' | 'SYNCED' | 'MISSING' | 'UNAVAILABLE' | 'FAILED' =
      [...observed][0]!;
    assert.ok(SYNC_STATE_CASES[closedStateType].length > 0);
  });

  it('does not report SYNCED while the newest live job for the subscription failed', async () => {
    const { controller } = buildController([LINKED], OK_OUTCOME, [job(SyncJobStatus.FAILED)]);

    const card = (await controller.getUser('123', ADMIN)).subscriptions[0]!;

    // The panel answers `ok`: the profile is there and addressable. That alone
    // used to be the whole story, and it is the reading this control forbids —
    // the state the absent delegate could only ever produce.
    assert.notEqual(card.remnawaveSyncState, 'SYNCED');
    assert.equal(card.remnawaveSyncState, 'FAILED');
    assert.equal(card.remnawaveSyncJob?.lastError, 'panel refused the update');
  });

  it('asks the sync-job table nothing when the user has no subscriptions', async () => {
    const { controller, profileSyncJobCalls } = buildController([], OK_OUTCOME, []);

    const result = await controller.getUser('123', ADMIN);

    assert.deepStrictEqual(result.subscriptions, []);
    // `in: []` can only answer nothing, and this runs on every user-card open.
    assert.deepStrictEqual(profileSyncJobCalls, []);
  });
});
