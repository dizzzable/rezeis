import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import {
  strictOk,
  strictUnavailable,
} from '../src/modules/remnawave/interfaces/remnawave-strict-outcome.interface';
import {
  panelUserAddress,
  type StoredPanelIdentity,
} from '../src/modules/remnawave/services/panel-user-address';
import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';

/**
 * The one message `linkRemnawaveProfile` gives an operator whose identifier is
 * neither shape. Asserted verbatim below because it is the whole remedy: the
 * operator cannot see the regex, only this sentence.
 */
const REMNAWAVE_ID_REQUIRED_MESSAGE =
  'A valid Remnawave profile identifier is required: a UUID (panel 2.x) or a numeric profile id (panel 3.x)';

/**
 * The refusal an operator gets when the profile they pasted is already held by
 * another subscription. Asserted verbatim, and as a 400, because that pair is
 * the contract the admin SPA renders — a duplicate found by a WIDER comparison
 * must still arrive as the same answer, not as a new failure mode.
 */
const REMNAWAVE_PROFILE_TAKEN_MESSAGE =
  'This Remnawave profile is already linked to another subscription';

/**
 * A subscription row as the panel-facing endpoints select it. Both supplementary
 * columns are present because a real row has them on every supported version —
 * a fake carrying only `remnawaveId` would let a caller that drops them keep
 * passing while recording nothing the adapter can use after an upgrade.
 */
function panelBackedRow(overrides: Record<string, unknown> = {}) {
  return {
    remnawaveId: 'rem-user-1',
    remnawavePanelId: 4471,
    remnawavePanelUsername: 'rz_bob_1',
    ...overrides,
  };
}

/** What {@link panelBackedRow} must reach the panel adapter as. */
const PANEL_BACKED_IDENTITY: StoredPanelIdentity = {
  remnawaveId: 'rem-user-1',
  panelId: 4471,
  panelUsername: 'rz_bob_1',
};

/**
 * A panel profile as the link-repair verification read hands it back.
 *
 * `panelId` and `username` are set because a real row carries both on every
 * supported version — 2.x lists the numeric id beside the uuid, 3.x keys
 * everything by it. A fake that omitted them would be a panel that does not
 * exist, and would let a duplicate guard that can only compare strings look
 * sound. `telegramId` matches the fixture user below so ownership verification
 * passes and these cases exercise the guard rather than stopping short of it.
 */
function panelProfile(overrides: Record<string, unknown> = {}) {
  return {
    subscriptionUrl: 'https://panel.example.test/sub',
    telegramId: 42,
    email: null,
    description: null,
    panelId: 5150,
    username: 'rz_bob_1',
    ...overrides,
  };
}

/**
 * `subscription.findFirst` over a handful of rows, evaluating the `where` the
 * controller actually built.
 *
 * A fake answering a fixed row — or a fixed `null` — would pass exactly as
 * happily for a guard that compares nothing but the pasted string. These cases
 * are entirely about WHICH rows the `where` reaches, so the fake has to do the
 * reaching. It understands the two shapes a guard here can produce: an `OR` of
 * alternative identities, or a bare set of fields ANDed together, so a guard
 * narrowed back to one comparison still matches rows instead of silently
 * matching nothing and passing for the wrong reason.
 */
function findFirstOver(rows: ReadonlyArray<Record<string, unknown>>, calls: unknown[]) {
  return async (input: unknown) => {
    calls.push(input);
    const { NOT, OR, ...direct } = (input as { where: Record<string, unknown> }).where as {
      NOT?: { id?: string };
      OR?: Array<Record<string, unknown>>;
    } & Record<string, unknown>;
    // An empty condition object matches every row in Prisma; here it must match
    // none, so a guard that lost its comparisons fails loudly rather than
    // reporting every repair as a duplicate.
    const alternatives = (Array.isArray(OR) ? OR : [direct]).filter(
      (alternative) => Object.keys(alternative).length > 0,
    );
    const hit = rows.find(
      (row) =>
        row.id !== NOT?.id &&
        alternatives.some((alternative) =>
          Object.entries(alternative).every(([field, value]) => row[field] === value),
        ),
    );
    return hit === undefined ? null : { id: hit.id };
  };
}

/**
 * The link-repair endpoint with a table-backed duplicate guard behind it:
 * `rows` is every OTHER subscription in the database, `panelUser` is what the
 * verification read answers. The subscription under repair is unlinked, which
 * is the only state this endpoint accepts.
 */
function linkRepairFor(options: {
  rows: ReadonlyArray<Record<string, unknown>>;
  panelUser: Record<string, unknown>;
}) {
  const updateCalls: unknown[] = [];
  const guardQueries: unknown[] = [];
  const controller = new AdminUserSubscriptionsController(
    {
      subscription: {
        findUnique: async () => ({
          id: 'legacy-subscription',
          userId: 'user-1',
          remnawaveId: null,
          configUrl: null,
          user: { id: 'user-1', telegramId: BigInt(42), email: null },
        }),
        findFirst: findFirstOver(options.rows, guardQueries),
        update: async (input: unknown) => {
          updateCalls.push(input);
          return { id: 'legacy-subscription' };
        },
      },
      adminAuditLog: { create: async () => undefined },
    } as never,
    { getPanelUserOutcome: async () => ({ kind: 'ok', user: options.panelUser }) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { controller, updateCalls, guardQueries };
}

/** The endpoint call itself, so each case shows only the identifier it pastes. */
function repairLink(controller: AdminUserSubscriptionsController, pastedIdentity: string) {
  return controller.linkRemnawaveProfile(
    'legacy-subscription',
    { remnawaveId: pastedIdentity },
    { id: 'admin-1' } as never,
    { headers: {}, ip: null, socket: { remoteAddress: null } } as never,
  );
}

/** One profile, under both of the names the two panel eras give it. */
const PROFILE_P_UUID = '330f2b38-6bb1-4b0e-9d4c-2a6c2a2f1b77';
const PROFILE_P_PANEL_ID = 5150;

describe('AdminUserSubscriptionsController', () => {
  it('persists and enqueues an explicit legacy subscription status update for Remnawave', async () => {
    const jobs: unknown[] = [];
    const enqueued: string[] = [];
    const controller = new AdminUserSubscriptionsController(
      {
        subscription: {
          findUnique: async () => ({
            id: 'legacy-subscription',
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          }),
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          subscription: {
            update: async () => ({ id: 'legacy-subscription', remnawaveId: 'panel-user-1' }),
          },
          profileSyncJob: {
            create: async (input: unknown) => {
              jobs.push(input);
              return { id: 'sync-status-1' };
            },
          },
        }),
      } as never,
      {} as never,
      { enqueue: async (jobId: string) => enqueued.push(jobId) } as never,
      { warn: () => undefined } as never,
      {} as never,
      {} as never,
    );

    const result = await controller.updateSubscription('legacy-subscription', {
      status: SubscriptionStatus.DISABLED,
    });

    assert.deepStrictEqual(result, {
      id: 'legacy-subscription',
      remnawaveId: 'panel-user-1',
      syncPending: true,
      remnawaveLinkRequired: false,
    });
    assert.deepStrictEqual(jobs, [{
      data: {
        subscriptionId: 'legacy-subscription',
        action: SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        payload: { source: 'ADMIN_MUTATION', propagateStatus: true },
      },
      select: { id: true },
    }]);
    assert.deepStrictEqual(enqueued, ['sync-status-1']);
  });

  it('keeps a legacy subscription local when its Remnawave link is absent instead of creating a duplicate profile', async () => {
    let jobCreated = false;
    const warned: Array<readonly unknown[]> = [];
    const controller = new AdminUserSubscriptionsController(
      {
        subscription: {
          findUnique: async () => ({ id: 'unlinked-subscription', expiresAt: null }),
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          subscription: {
            update: async () => ({
              id: 'unlinked-subscription',
              userId: 'user-9',
              remnawaveId: null,
              remnawavePanelUsername: 'rz_gina_1',
            }),
          },
          profileSyncJob: { create: async () => { jobCreated = true; return { id: 'must-not-exist' }; } },
        }),
      } as never,
      {} as never,
      { enqueue: async () => undefined } as never,
      { warn: (...args: unknown[]) => { warned.push(args); } } as never,
      {} as never,
      {} as never,
    );

    const result = await controller.updateSubscription('unlinked-subscription', {
      status: SubscriptionStatus.DISABLED,
    });

    assert.deepStrictEqual(result, {
      id: 'unlinked-subscription',
      userId: 'user-9',
      remnawaveId: null,
      remnawavePanelUsername: 'rz_gina_1',
      syncPending: false,
      remnawaveLinkRequired: true,
    });
    assert.equal(jobCreated, false);

    // THE DIVERGENCE OUTLIVES THE SCREEN THAT ANNOUNCED IT. The response flag
    // above drives a toast, and a toast is gone the moment the panel closes —
    // while the row now holds a status its panel profile does not, with no job
    // queued and nothing that will ever reconcile them. Without a durable
    // event, "why is this customer still enabled upstream" has no record to
    // answer it.
    assert.equal(warned.length, 1);
    assert.equal(warned[0]?.[1], 'SYSTEM');
    assert.deepStrictEqual(warned[0]?.[3], {
      subscriptionId: 'unlinked-subscription',
      userId: 'user-9',
      remnawavePanelUsername: 'rz_gina_1',
    });
  });

  it('says nothing extra when the admin edit did reach the panel', async () => {
    // The counter-check: this event must fire on the divergence and not on the
    // ordinary edit, or it is noise in the same feed operators watch for the
    // real thing.
    const warned: Array<readonly unknown[]> = [];
    const controller = new AdminUserSubscriptionsController(
      {
        subscription: {
          findUnique: async () => ({ id: 'linked-subscription', expiresAt: null }),
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          subscription: {
            update: async () => ({
              id: 'linked-subscription',
              userId: 'user-9',
              remnawaveId: 'panel-user-1',
              remnawavePanelUsername: 'rz_gina_1',
            }),
          },
          profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
        }),
      } as never,
      {} as never,
      { enqueue: async () => undefined } as never,
      { warn: (...args: unknown[]) => { warned.push(args); } } as never,
      {} as never,
      {} as never,
    );

    await controller.updateSubscription('linked-subscription', {
      status: SubscriptionStatus.DISABLED,
    });

    assert.deepStrictEqual(warned, []);
  });

  it('repairs an unlinked legacy subscription only after verifying a unique panel UUID', async () => {
    const updateCalls: unknown[] = [];
    const auditCalls: unknown[] = [];
    const controller = new AdminUserSubscriptionsController(
      {
        subscription: {
          findUnique: async () => ({
            id: 'legacy-subscription',
            userId: 'user-1',
            remnawaveId: null,
            configUrl: null,
            user: { id: 'user-1', telegramId: BigInt(42), email: null },
          }),
          findFirst: async () => null,
          update: async (input: unknown) => {
            updateCalls.push(input);
            return { id: 'legacy-subscription', remnawaveId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' };
          },
        },
        adminAuditLog: { create: async (input: unknown) => auditCalls.push(input) },
      } as never,
      {
        getPanelUserOutcome: async () => ({
          kind: 'ok',
          user: {
            subscriptionUrl: 'https://panel.example.test/sub',
            telegramId: 42,
            email: null,
            description: null,
            // A real panel row carries both on every supported version, and the
            // verification read already has them in hand. Recording them is what
            // keeps a link repaired on 2.x addressable after the upgrade that
            // destroys the uuid it was repaired with.
            panelId: 4471,
            username: 'rz_bob_1',
          },
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await controller.linkRemnawaveProfile(
      'legacy-subscription',
      { remnawaveId: ' f47ac10b-58cc-4372-a567-0e02b2c3d479 ' },
      { id: 'admin-1' } as never,
      { headers: {}, ip: null, socket: { remoteAddress: null } } as never,
    );

    assert.deepStrictEqual(result, { id: 'legacy-subscription', remnawaveId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' });
    assert.deepStrictEqual(updateCalls, [{
      where: { id: 'legacy-subscription' },
      data: {
        remnawaveId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        remnawavePanelId: 4471,
        remnawavePanelUsername: 'rz_bob_1',
        configUrl: 'https://panel.example.test/sub',
      },
    }]);
    assert.equal(auditCalls.length, 1);
  });

  it('rejects a malformed identifier before querying Remnawave', async () => {
    let queried = false;
    const controller = new AdminUserSubscriptionsController(
      {} as never,
      { getPanelUserOutcome: async () => { queried = true; return { kind: 'missing' }; } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await assert.rejects(
      () => controller.linkRemnawaveProfile(
        'legacy-subscription',
        { remnawaveId: 'not-a-uuid' },
        { id: 'admin-1' } as never,
        { headers: {}, ip: null, socket: { remoteAddress: null } } as never,
      ),
      { message: REMNAWAVE_ID_REQUIRED_MESSAGE },
    );
    assert.equal(queried, false);
  });

  // ── Panel identity gate: both eras accepted, nothing else ────────────────
  //
  // Remnawave 3.x deleted the uuid column; a 3.x profile is named by its
  // numeric `id`. This endpoint is the ONLY operator-facing repair for a broken
  // profile link, and its gate used to be uuid-only — so on a 3.x panel it
  // refused every identifier the operator could possibly have, i.e. it failed
  // exactly where it was needed. Widening it is not "accept anything": the
  // value is interpolated into a panel URL path segment, so the rejection cases
  // below are the half of this behaviour that actually guards something. The
  // accept cases alone would pass a gate with no gate in it.

  it('links a Remnawave 3.x numeric profile id, which has no uuid form to offer', async () => {
    const panelReads: unknown[] = [];
    const updateCalls: unknown[] = [];
    const controller = new AdminUserSubscriptionsController(
      {
        subscription: {
          findUnique: async () => ({
            id: 'legacy-subscription',
            userId: 'user-1',
            remnawaveId: null,
            configUrl: null,
            user: { id: 'user-1', telegramId: BigInt(42), email: null },
          }),
          findFirst: async () => null,
          update: async (input: unknown) => {
            updateCalls.push(input);
            return { id: 'legacy-subscription', remnawaveId: '4471' };
          },
        },
        adminAuditLog: { create: async () => undefined },
      } as never,
      {
        getPanelUserOutcome: async (ref: unknown) => {
          panelReads.push(ref);
          return {
            kind: 'ok',
            user: {
              subscriptionUrl: 'https://panel.example.test/sub',
              telegramId: 42,
              email: null,
              description: null,
              // On 3.x the numeric id IS the identity, so `panelId` simply agrees
              // with what the operator typed; the username is the extra material
              // that makes the row survive a rollback to 2.x.
              panelId: 4471,
              username: 'rz_bob_1',
            },
          };
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await controller.linkRemnawaveProfile(
      'legacy-subscription',
      { remnawaveId: ' 4471 ' },
      { id: 'admin-1' } as never,
      { headers: {}, ip: null, socket: { remoteAddress: null } } as never,
    );

    assert.deepStrictEqual(result, { id: 'legacy-subscription', remnawaveId: '4471' });
    // The trimmed decimal reaches the panel verbatim — a bare string is a valid
    // `PanelUserRef`, and nothing along the way reshapes it into a uuid.
    assert.deepStrictEqual(panelReads, ['4471']);
    assert.deepStrictEqual(updateCalls, [{
      where: { id: 'legacy-subscription' },
      data: {
        remnawaveId: '4471',
        remnawavePanelId: 4471,
        remnawavePanelUsername: 'rz_bob_1',
        configUrl: 'https://panel.example.test/sub',
      },
    }]);
  });

  it('refuses an identifier that is neither a uuid nor a numeric panel id, before touching Prisma or the panel', async () => {
    const refused = [
      { label: 'empty', value: '' },
      { label: 'whitespace only', value: '   ' },
      { label: 'a hex fragment that is not a number', value: '12a' },
      // The two that matter most: this value ends up in a panel URL path
      // segment, so a separator would address a different route entirely.
      { label: 'a uuid with a trailing slash', value: 'f47ac10b-58cc-4372-a567-0e02b2c3d479/' },
      { label: 'a path traversal', value: '../users/1' },
    ];

    for (const { label, value } of refused) {
      const prismaReads: unknown[] = [];
      const panelReads: unknown[] = [];
      const controller = new AdminUserSubscriptionsController(
        {
          subscription: {
            findUnique: async (input: unknown) => { prismaReads.push(input); return null; },
            findFirst: async (input: unknown) => { prismaReads.push(input); return null; },
          },
        } as never,
        { getPanelUserOutcome: async (ref: unknown) => { panelReads.push(ref); return { kind: 'missing' }; } } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );

      await assert.rejects(
        () => controller.linkRemnawaveProfile(
          'legacy-subscription',
          { remnawaveId: value },
          { id: 'admin-1' } as never,
          { headers: {}, ip: null, socket: { remoteAddress: null } } as never,
        ),
        (error: unknown) => {
          // A 400, not a 404: the input is wrong, the subscription is not
          // missing. The fake above answers `null` to every read, so a gate
          // that let the value through would surface as "Subscription not
          // found" and look like an unrelated failure.
          assert.equal(
            error instanceof BadRequestException,
            true,
            `${label}: expected a BadRequestException, got ${String(error)}`,
          );
          assert.equal((error as Error).message, REMNAWAVE_ID_REQUIRED_MESSAGE, `${label}: wrong message`);
          return true;
        },
        `expected ${label} to be refused`,
      );
      assert.deepStrictEqual(prismaReads, [], `${label}: reached Prisma`);
      assert.deepStrictEqual(panelReads, [], `${label}: reached the panel`);
    }
  });

  // ── Duplicate guard: one profile, two names ──────────────────────────────
  //
  // `Subscription.remnawaveId` carries no `@unique` and no index, so the check
  // in this endpoint is the ONLY thing stopping two subscriptions from
  // addressing one panel profile — after which a delete on either destroys the
  // other's live profile and every limit/device write races. The check used to
  // compare the pasted STRING, which cannot see the collision the two panel
  // eras make possible: one profile is named by a 2.x uuid in a row linked back
  // then, and by its numeric id on the 3.x screen the operator is reading from.
  // The ownership check does not cover this either — it verifies the USER, and
  // both rows can legitimately belong to the same one, as they do below.

  it('refuses a numeric repair when another subscription already holds that profile as its 2.x uuid', async () => {
    const { controller, updateCalls } = linkRepairFor({
      rows: [{
        id: 'sibling-subscription',
        // Linked while the panel was 2.7.4 and never re-synced since the
        // upgrade: the string is a uuid the 3.x panel has no column for any
        // more, and the recorded numeric id is the only thing left that still
        // names the same profile.
        remnawaveId: PROFILE_P_UUID,
        remnawavePanelId: PROFILE_P_PANEL_ID,
        remnawavePanelUsername: 'rz_bob_1',
      }],
      panelUser: panelProfile({ panelId: PROFILE_P_PANEL_ID }),
    });

    const failure = await captureRejection(() => repairLink(controller, String(PROFILE_P_PANEL_ID)));

    assert.equal(failure instanceof BadRequestException, true, String(failure));
    assert.equal((failure as Error).message, REMNAWAVE_PROFILE_TAKEN_MESSAGE);
    // A guard that refuses only AFTER pointing a second row at the profile has
    // refused nothing — the damage is the row, not the response.
    assert.deepStrictEqual(updateCalls, [], 'the refusal must land before any write');
  });

  it('refuses a uuid repair when another subscription already holds that profile by its 3.x numeric id', async () => {
    const { controller, updateCalls } = linkRepairFor({
      rows: [{
        id: 'sibling-subscription',
        // Linked on 3.x, so the identity string IS the numeric id. The
        // supplementary column is null on purpose: it is only ever filled by a
        // panel read that recorded it, so for this row the comparison against
        // the stored STRING is the only one that can see the collision.
        remnawaveId: String(PROFILE_P_PANEL_ID),
        remnawavePanelId: null,
        remnawavePanelUsername: 'rz_bob_1',
      }],
      // The operator is on a panel that still shows uuids and pastes one; the
      // same profile answers with the same numeric id it always had.
      panelUser: panelProfile({ panelId: PROFILE_P_PANEL_ID }),
    });

    const failure = await captureRejection(() => repairLink(controller, PROFILE_P_UUID));

    assert.equal(failure instanceof BadRequestException, true, String(failure));
    assert.equal((failure as Error).message, REMNAWAVE_PROFILE_TAKEN_MESSAGE);
    assert.deepStrictEqual(updateCalls, [], 'the refusal must land before any write');
  });

  it('still refuses a duplicate named exactly as the other subscription stored it', async () => {
    const { controller, updateCalls } = linkRepairFor({
      rows: [{
        id: 'sibling-subscription',
        // Neither supplementary column ever recorded: the same-era string
        // comparison is the whole answer here, and widening the guard must not
        // have quietly replaced it.
        remnawaveId: PROFILE_P_UUID,
        remnawavePanelId: null,
        remnawavePanelUsername: null,
      }],
      panelUser: panelProfile({ panelId: PROFILE_P_PANEL_ID }),
    });

    const failure = await captureRejection(() => repairLink(controller, PROFILE_P_UUID));

    assert.equal(failure instanceof BadRequestException, true, String(failure));
    assert.equal((failure as Error).message, REMNAWAVE_PROFILE_TAKEN_MESSAGE);
    assert.deepStrictEqual(updateCalls, []);
  });

  it('still links a profile no other subscription names, in either identifier form', async () => {
    for (const pasted of [PROFILE_P_UUID, String(PROFILE_P_PANEL_ID)]) {
      const { controller, updateCalls, guardQueries } = linkRepairFor({
        rows: [{
          id: 'namesake-subscription',
          // A DIFFERENT profile wearing the same operator-visible name. This is
          // the case that says why the username is not compared: a name can be
          // changed in the panel, and a name freed by a rename or a delete can
          // be taken by another profile — so a stored one proves nothing about
          // identity. Matching on it would refuse this repair, and this endpoint
          // is the operator's only way out of a broken link.
          remnawaveId: 'c0ffee00-1111-4222-8333-444455556666',
          remnawavePanelId: 6060,
          remnawavePanelUsername: 'rz_bob_1',
        }],
        panelUser: panelProfile({ panelId: PROFILE_P_PANEL_ID }),
      });

      await repairLink(controller, pasted);

      // Self-check: the guard really did query, so the pass above means "no row
      // matched" rather than "the guard never ran".
      assert.equal(guardQueries.length, 1, `${pasted}: the duplicate guard did not query`);
      assert.deepStrictEqual(
        updateCalls,
        [{
          where: { id: 'legacy-subscription' },
          data: {
            remnawaveId: pasted,
            remnawavePanelId: PROFILE_P_PANEL_ID,
            remnawavePanelUsername: 'rz_bob_1',
            configUrl: 'https://panel.example.test/sub',
          },
        }],
        `${pasted}: expected a genuine non-duplicate to be linked`,
      );
    }
  });

  it('rejects linking a panel profile that is not owned by the subscription user', async () => {
    let updated = false;
    const controller = new AdminUserSubscriptionsController(
      {
        subscription: {
          findUnique: async () => ({
            id: 'legacy-subscription',
            userId: 'user-1',
            remnawaveId: null,
            configUrl: null,
            user: { id: 'user-1', telegramId: BigInt(42), email: 'owner@example.test' },
          }),
          findFirst: async () => null,
          update: async () => { updated = true; return {}; },
        },
      } as never,
      {
        getPanelUserOutcome: async () => ({
          kind: 'ok',
          user: {
            subscriptionUrl: 'https://panel.example.test/sub',
            telegramId: 99,
            email: 'another@example.test',
            description: 'reiwa_id: another-user',
            panelId: 9901,
            username: 'rz_someone_else',
          },
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await assert.rejects(
      () => controller.linkRemnawaveProfile(
        'legacy-subscription',
        { remnawaveId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' },
        { id: 'admin-1' } as never,
        { headers: {}, ip: null, socket: { remoteAddress: null } } as never,
      ),
      { message: 'Remnawave profile does not belong to this subscription user' },
    );
    assert.equal(updated, false);
  });

  // ── Link repair: an unreachable panel is not a wrong identifier ──────────
  //
  // The pair below runs the SAME endpoint with the SAME identifier and differs
  // only in what the panel answered. `getPanelUser` collapsed both into `null`,
  // so an operator repairing a link during a panel blip was told their
  // identifier was wrong — during the one outage they were most likely to be
  // repairing a link in. If these two ever agree again, that is back.

  it('answers 503, NOT 404, when the panel could not be reached during a link repair', async () => {
    let updated = false;
    const controller = new AdminUserSubscriptionsController(
      {
        subscription: {
          findUnique: async () => ({
            id: 'legacy-subscription',
            userId: 'user-1',
            remnawaveId: null,
            configUrl: null,
            user: { id: 'user-1', telegramId: BigInt(42), email: null },
          }),
          findFirst: async () => null,
          update: async () => { updated = true; return {}; },
        },
      } as never,
      { getPanelUserOutcome: async () => ({ kind: 'unavailable' }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const failure = await captureRejection(() =>
      controller.linkRemnawaveProfile(
        'legacy-subscription',
        { remnawaveId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' },
        { id: 'admin-1' } as never,
        { headers: {}, ip: null, socket: { remoteAddress: null } } as never,
      ),
    );

    assert.equal(failure instanceof ServiceUnavailableException, true);
    assert.equal((failure as ServiceUnavailableException).getStatus(), 503);
    assert.equal(failure instanceof NotFoundException, false);
    // The operator has to be told to retry, not to go hunting for a better id.
    assert.match(String((failure as Error).message), /could not be reached/i);
    // "Unavailable" must never be acted on as "the profile is gone": nothing is
    // linked, detached or written.
    assert.equal(updated, false);
  });

  it('still answers 404 when the panel positively reports the profile missing', async () => {
    const controller = new AdminUserSubscriptionsController(
      {
        subscription: {
          findUnique: async () => ({
            id: 'legacy-subscription',
            userId: 'user-1',
            remnawaveId: null,
            configUrl: null,
            user: { id: 'user-1', telegramId: BigInt(42), email: null },
          }),
          findFirst: async () => null,
          update: async () => ({}),
        },
      } as never,
      { getPanelUserOutcome: async () => ({ kind: 'missing' }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const failure = await captureRejection(() =>
      controller.linkRemnawaveProfile(
        'legacy-subscription',
        { remnawaveId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' },
        { id: 'admin-1' } as never,
        { headers: {}, ip: null, socket: { remoteAddress: null } } as never,
      ),
    );

    assert.equal(failure instanceof NotFoundException, true);
    assert.equal((failure as NotFoundException).getStatus(), 404);
    assert.equal((failure as Error).message, 'Remnawave profile was not found');
  });

  // ── The one row a bare `remnawaveId` cannot name ─────────────────────────
  //
  // Created on 2.x, panel since upgraded to 3.x, nothing re-synced. The stored
  // string is a uuid the panel has no column for any more, so only the recorded
  // numeric id can still reach the profile.

  it('hands the panel adapter the recorded numeric id when remnawaveId is a stale 2.x uuid', async () => {
    const panelReads: unknown[] = [];
    const staleUuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const controller = new AdminUserSubscriptionsController(
      {
        subscription: {
          findUnique: async () => panelBackedRow({ remnawaveId: staleUuid }),
        },
      } as never,
      {
        strictGetPanelUserDevices: async (ref: StoredPanelIdentity) => {
          panelReads.push(ref);
          return strictOk({ devices: [], total: 0 });
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await controller.getDevices('subscription-1');

    assert.equal(panelReads.length, 1);
    // Asserted through the real addressing function, not by eyeballing the
    // object: what matters is that a 3.x panel path can be BUILT from what the
    // controller handed over.
    assert.deepStrictEqual(panelUserAddress(panelReads[0] as StoredPanelIdentity, 'id'), {
      kind: 'ready',
      segment: '4471',
    });
    // Counter-check: the stored string alone — what this call site used to pass
    // — names nothing on that panel.
    assert.equal(
      panelUserAddress({ remnawaveId: staleUuid, panelId: null, panelUsername: null }, 'id').kind,
      'impossible',
    );
  });

  // ── Device list: outage vs genuinely empty (operator audience) ───────────
  //
  // Both cases below hit the SAME method with the SAME subscription and differ
  // only in the panel's answer. The operator triaging "the customer cannot add
  // a device" must not read a confident `deviceCount: 0` off a panel that
  // never answered — the admin SPA renders `devicesList.loadError` on a failed
  // query and `devicesList.empty` on a successful empty one, so these two
  // outcomes have to stay distinguishable at the HTTP boundary.

  it('does not report "0 devices" to the operator when the panel is unreachable', async () => {
    const panelReads: unknown[] = [];
    const controller = new AdminUserSubscriptionsController(
      {
        subscription: {
          findUnique: async () => panelBackedRow(),
        },
      } as never,
      {
        strictGetPanelUserDevices: async (ref: StoredPanelIdentity) => {
          panelReads.push(ref);
          return strictUnavailable(null);
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    let thrown: unknown = null;
    try {
      await controller.getDevices('subscription-1');
      assert.fail('expected the device read to reject');
    } catch (err: unknown) {
      if (err instanceof assert.AssertionError) throw err;
      thrown = err;
    }

    // Self-check: the panel really was consulted.
    assert.deepStrictEqual(panelReads, [PANEL_BACKED_IDENTITY]);
    assert.equal(thrown instanceof ServiceUnavailableException, true);
    assert.equal((thrown as ServiceUnavailableException).getStatus(), 503);
  });

  it('still reports a genuinely empty panel device list to the operator as an empty list', async () => {
    const panelReads: unknown[] = [];
    const controller = new AdminUserSubscriptionsController(
      {
        subscription: {
          findUnique: async () => panelBackedRow(),
        },
      } as never,
      {
        strictGetPanelUserDevices: async (ref: StoredPanelIdentity) => {
          panelReads.push(ref);
          return strictOk({ devices: [], total: 0 });
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    assert.deepStrictEqual(await controller.getDevices('subscription-1'), {
      devices: [],
      deviceCount: 0,
    });
    assert.deepStrictEqual(panelReads, [PANEL_BACKED_IDENTITY]);
  });
});

/**
 * Runs `action` and returns whatever it threw, failing the test if it did not
 * throw — otherwise a "must reject with 503" assertion would pass on a method
 * that quietly succeeded.
 */
async function captureRejection(action: () => Promise<unknown>): Promise<unknown> {
  try {
    const resolved = await action();
    assert.fail(`expected a rejection, got ${JSON.stringify(resolved)}`);
  } catch (err: unknown) {
    if (err instanceof assert.AssertionError) throw err;
    return err;
  }
}

describe('syncSubscription — an unreachable panel is not a missing profile', () => {
  function build(outcome: { kind: string; user?: Record<string, unknown> }) {
    const updates: unknown[] = [];
    const controller = new AdminUserSubscriptionsController(
      {
        subscription: {
          findUnique: async () => panelBackedRow({ userId: 'user-1' }),
          update: async (input: unknown) => { updates.push(input); return {}; },
        },
      } as never,
      { getPanelUserOutcome: async () => outcome } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { controller, updates };
  }

  it('says the panel could not be reached, and writes nothing', async () => {
    // The old code answered "Profile not found on panel" for an outage, an
    // expired token, a 5xx and a timeout alike — and "gone" is what makes an
    // operator start repairing a link that was never broken.
    const { controller, updates } = build({ kind: 'unavailable' });
    const result = await controller.syncSubscription('sub-1');
    assert.equal(result.synced, false);
    assert.match(String(result.message), /could not be reached/i);
    // And specifically NOT the missing-profile wording — that is the sentence
    // that sends an operator off to repair a link that was never broken.
    assert.equal(/not found/i.test(String(result.message)), false, String(result.message));
    assert.deepEqual(updates, [], 'a read that failed must not write an expiry');
  });

  it('still reports a genuinely missing profile as missing', async () => {
    const { controller, updates } = build({ kind: 'missing' });
    const result = await controller.syncSubscription('sub-1');
    assert.equal(result.synced, false);
    assert.equal(result.message, 'Profile not found on panel');
    assert.deepEqual(updates, []);
  });

  it('syncs from the panel row when the read succeeds', async () => {
    const { controller, updates } = build({
      kind: 'ok',
      user: { expireAt: '2099-01-01T00:00:00.000Z', subscriptionUrl: 'https://sub/x' },
    });
    const result = await controller.syncSubscription('sub-1');
    assert.equal(result.synced, true);
    assert.equal(updates.length, 1);
  });
});
