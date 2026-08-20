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

import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';

const UUID = '11111111-1111-4111-8111-111111111111';

function buildController(subscriptions: ReadonlyArray<Record<string, unknown>>) {
  const panelLookups: unknown[] = [];
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
        return { kind: 'ok', user: { username: 'rz_sub_1', description: 'reiwa_id: user-1' } };
      },
    } as never,
    {} as never,
    { hasPermission: async () => false } as never,
    {} as never,
  );
  return { controller, panelLookups };
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
});
