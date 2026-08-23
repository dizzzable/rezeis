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
import { REZEIS_AUTHORITATIVE_SUBSCRIPTION_FIELDS } from '../src/modules/remnawave/services/panel-field-ownership';
import {
  panelUserAddress,
  type StoredPanelIdentity,
} from '../src/modules/remnawave/services/panel-user-address';
import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';
import { SUBSCRIPTION_SYNC_REFUSAL_CODES } from '../src/modules/users/controllers/subscription-sync-refusals';

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
    ACTING_ADMIN,
    ACTING_REQUEST,
  );
}

/** The acting operator, as `@CurrentAdmin()` hands it to every audited route. */
const ACTING_ADMIN = { id: 'admin-1' } as never;

/**
 * Enough of an express `Request` for `extractRequestMetadata` — it reads
 * `headers['x-request-id']`, `headers['user-agent']`, `ip` and
 * `socket.remoteAddress` and nothing else.
 */
const ACTING_REQUEST = {
  headers: { 'x-request-id': 'req-1', 'user-agent': 'jest' },
  ip: '10.0.0.7',
  socket: { remoteAddress: null },
} as never;

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

    const result = await controller.updateSubscription(
      'legacy-subscription',
      { status: SubscriptionStatus.DISABLED },
      ACTING_ADMIN,
      ACTING_REQUEST,
    );

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

    const result = await controller.updateSubscription(
      'unlinked-subscription',
      { status: SubscriptionStatus.DISABLED },
      ACTING_ADMIN,
      ACTING_REQUEST,
    );

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

    await controller.updateSubscription(
      'linked-subscription',
      { status: SubscriptionStatus.DISABLED },
      ACTING_ADMIN,
      ACTING_REQUEST,
    );

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
  /**
   * `row: null` is the subscription that never had a panel profile — the
   * refusal that is decided before the panel is consulted at all. It is a
   * parameter rather than a second harness so the three refusals can be
   * asserted from one table below.
   */
  function build(
    outcome: { kind: string; user?: Record<string, unknown> },
    row: Record<string, unknown> | null = panelBackedRow({ userId: 'user-1' }),
  ) {
    const updates: unknown[] = [];
    const panelReads: string[] = [];
    const controller = new AdminUserSubscriptionsController(
      {
        subscription: {
          findUnique: async () => row,
          update: async (input: unknown) => { updates.push(input); return {}; },
        },
      } as never,
      { getPanelUserOutcome: async () => { panelReads.push('read'); return outcome; } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { controller, updates, panelReads };
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
    const { controller, updates } = build({ kind: 'ok', user: syncedPanelProfile() });
    const result = await controller.syncSubscription('sub-1');
    assert.equal(result.synced, true);
    assert.equal(updates.length, 1);
  });

  /**
   * THE MACHINE-READABLE HALF of each refusal.
   *
   * All three answer HTTP 200 — none of them is a failure — so the admin SPA
   * decides which of the three it is from the BODY. It used to decide by
   * matching this English prose byte for byte, em dash included, which made
   * every one of these sentences load-bearing copy: a typo fix or a house
   * style pass would have collapsed all three into one generic notice, the
   * operator would still have seen a non-success message, and the specific
   * guidance — link a profile / press it again / the link is genuinely broken —
   * would simply have stopped arriving with nothing failing anywhere.
   *
   * The codes are IMPORTED from `subscription-sync-refusals.ts`, never retyped.
   * A rename there moves the wire value and this assertion in the same edit, so
   * this spec cannot end up certifying a code nobody sends.
   *
   * The sentences stay asserted beside them, and not out of nostalgia: a panel
   * build older than the code still matches on them during a rolling deploy.
   */
  const REFUSALS = [
    {
      name: 'no profile is linked',
      row: null,
      // Reached only if the endpoint consults the panel about a subscription
      // that has no profile — which `panelReads` below proves it does not.
      outcome: { kind: 'ok', user: syncedPanelProfile() },
      code: SUBSCRIPTION_SYNC_REFUSAL_CODES.notLinked,
      message: 'No Remnawave profile linked',
    },
    {
      name: 'the panel could not be reached',
      row: undefined,
      outcome: { kind: 'unavailable' },
      code: SUBSCRIPTION_SYNC_REFUSAL_CODES.panelUnavailable,
      message: 'Remnawave panel could not be reached — try again',
    },
    {
      name: 'the profile is gone',
      row: undefined,
      outcome: { kind: 'missing' },
      code: SUBSCRIPTION_SYNC_REFUSAL_CODES.profileMissing,
      message: 'Profile not found on panel',
    },
  ] as const;

  for (const refusal of REFUSALS) {
    it(`carries a stable code, not only a sentence, when ${refusal.name}`, async () => {
      const { controller, updates, panelReads } = build(
        { ...refusal.outcome },
        refusal.row === null ? null : undefined,
      );

      const result = await controller.syncSubscription('sub-1');
      const body = result as Record<string, unknown>;

      assert.equal(body.synced, false);
      assert.equal(body.code, refusal.code);
      // Both halves, together. The code is what the panel branches on; the
      // message is what an older panel build falls back to and what any log
      // reader sees. Dropping either is a behaviour change.
      assert.equal(body.message, refusal.message);
      assert.deepEqual(updates, [], 'a refusal must not write');
      if (refusal.row === null) {
        assert.deepEqual(
          panelReads,
          [],
          'a subscription with no profile must not be looked up on the panel',
        );
      }
    });
  }

  it('gives the three refusals three DIFFERENT codes', () => {
    // The anchor for the table above. Three rows that all assert the same
    // literal would pass every assertion in it while leaving the SPA unable to
    // tell an outage from a broken link — which is the entire point of the
    // codes, and the exact confusion the message split was made to end.
    const codes = Object.values(SUBSCRIPTION_SYNC_REFUSAL_CODES);
    assert.equal(codes.length, 3);
    assert.equal(new Set(codes).size, 3, codes.join(', '));
  });
});

/**
 * A panel row as `parsePanelUserRow` builds one: EVERY field present, because
 * that parser always produces every field — it substitutes `''`, `0`, `null`
 * or `[]` for anything the panel omitted rather than leaving a key out. A fake
 * that carried only the two fields a test happens to assert on would be a
 * panel that cannot exist, and would let a writer that reads the defaults as
 * facts keep passing.
 */
function syncedPanelProfile(overrides: Record<string, unknown> = {}) {
  return {
    uuid: 'rem-user-1',
    username: 'rz_bob_1',
    status: 'ACTIVE',
    subscriptionUrl: 'https://panel.example.test/sub/fresh',
    telegramId: 42,
    panelId: 4471,
    email: null,
    expireAt: '2099-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastTrafficResetAt: null,
    trafficLimitBytes: 0,
    hwidDeviceLimit: 0,
    trafficLimitStrategy: null,
    tag: null,
    description: null,
    activeInternalSquads: [] as Array<{ uuid: string; name: string }>,
    externalSquadUuid: null,
    ...overrides,
  };
}

/**
 * The settings an operator applied in rezeis, on a subscription rezeis
 * provisions. Every one of these columns is PUSHED into the panel by
 * `ProfileSyncProcessor`; none of them may come back the other way through a
 * refresh. They are deliberately far from both the panel fixture's values and
 * from `parsePanelUserRow`'s defaults, so a writer that adopted either would
 * land on a different number rather than coincidentally on the right one.
 */
const OPERATOR_ASSIGNED = {
  status: SubscriptionStatus.DISABLED,
  trafficLimit: 200,
  deviceLimit: 3,
  internalSquads: ['squad-paid'],
  externalSquad: 'ext-paid',
  expiresAt: new Date('2027-03-01T00:00:00.000Z'),
  planSnapshot: { name: 'Pro 200' },
};

/** The stored `configUrl` the panel fixtures below must not be able to erase. */
const STORED_CONFIG_URL = 'https://panel.example.test/sub/stored';

/**
 * The sync endpoint over ONE stored row, with a Prisma-faithful `update`: a
 * column the payload omits — or sets to `undefined` — is LEFT ALONE, and one
 * set to `null` is cleared. That distinction is the entire mechanism by which
 * this endpoint refuses to erase what it could not read, so the fake has to
 * honour it; an `update` that merely recorded its argument would let a writer
 * that nulls every unread column pass every assertion below.
 */
function syncOver(options: {
  outcome: { kind: string; user?: Record<string, unknown> };
  stored?: Record<string, unknown>;
}) {
  const stored: Record<string, unknown> = {
    ...panelBackedRow({ userId: 'user-1' }),
    configUrl: STORED_CONFIG_URL,
    ...OPERATOR_ASSIGNED,
    ...options.stored,
  };
  const updates: Array<Record<string, unknown>> = [];
  const controller = new AdminUserSubscriptionsController(
    {
      subscription: {
        findUnique: async () => ({ ...stored }),
        update: async (input: unknown) => {
          const data = (input as { data: Record<string, unknown> }).data;
          updates.push(data);
          for (const [column, value] of Object.entries(data)) {
            if (value === undefined) continue;
            stored[column] = value;
          }
          return { ...stored };
        },
      },
    } as never,
    { getPanelUserOutcome: async () => options.outcome } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { controller, updates, stored };
}

/**
 * A panel that has drifted away from the plan on every column rezeis owns, and
 * that names itself on every column only the panel can know.
 */
const DRIFTED_PANEL = syncedPanelProfile({
  status: 'LIMITED',
  trafficLimitBytes: 5 * 1024 * 1024 * 1024,
  hwidDeviceLimit: 12,
  activeInternalSquads: [{ uuid: 'squad-free', name: 'Free' }],
  externalSquadUuid: 'ext-free',
});

describe('syncSubscription — a refresh adopts panel facts without rewriting the plan', () => {
  it('adopts the columns only the panel can know', async () => {
    const { controller, stored } = syncOver({
      outcome: { kind: 'ok', user: syncedPanelProfile() },
      stored: { configUrl: null, remnawavePanelId: null, remnawavePanelUsername: null },
    });

    const result = await controller.syncSubscription('sub-1');

    assert.equal(result.synced, true);
    assert.deepEqual(result.refreshed, {
      configUrl: 'https://panel.example.test/sub/fresh',
      remnawavePanelId: 4471,
      remnawavePanelUsername: 'rz_bob_1',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    });
    assert.equal(stored.configUrl, 'https://panel.example.test/sub/fresh');
    // Not cosmetic: `ProfileSyncProcessor.panelProfileClaimedByAnother` is the
    // one guard between a DELETE and somebody else's live panel profile, and it
    // can only see a claimant through these two columns.
    assert.equal(stored.remnawavePanelId, 4471);
    assert.equal(stored.remnawavePanelUsername, 'rz_bob_1');
  });

  it('writes no column rezeis owns, however far the panel has drifted', async () => {
    const { controller, updates } = syncOver({
      outcome: { kind: 'ok', user: DRIFTED_PANEL },
    });

    await controller.syncSubscription('sub-1');

    // Anchor first: a refresh that wrote nothing at all would satisfy the
    // direction-complete assertion below for the wrong reason.
    assert.equal(updates.length, 1, 'the refresh must reach a write to be worth checking');
    const written = new Set(updates.flatMap((payload) => Object.keys(payload)));
    const trespass = REZEIS_AUTHORITATIVE_SUBSCRIPTION_FIELDS.filter((field) =>
      written.has(field),
    );
    assert.deepEqual(
      trespass,
      [],
      `a refresh must not write columns rezeis pushes into the panel: ${trespass.join(', ')}`,
    );
  });

  it('leaves the limits, squads and status an operator assigned exactly as they were', async () => {
    const { controller, stored } = syncOver({
      outcome: { kind: 'ok', user: DRIFTED_PANEL },
    });

    await controller.syncSubscription('sub-1');

    // The panel says 12 devices, 5 GB, one free squad and LIMITED. rezeis sold
    // 3 devices, 200 GB, a paid squad, and an operator disabled the row. The
    // panel is DOWNSTREAM of all four — `ProfileSyncProcessor` pushes them —
    // so adopting them back would replace the plan with its own echo, drifted.
    assert.equal(stored.deviceLimit, 3);
    assert.equal(stored.trafficLimit, 200);
    assert.deepEqual(stored.internalSquads, ['squad-paid']);
    assert.equal(stored.externalSquad, 'ext-paid');
    assert.equal(stored.status, SubscriptionStatus.DISABLED);
    // `planSnapshot` carries `name`, which the cabinet, the bot and every
    // invoice render as the customer's plan. Prisma writes a `Json` column
    // wholesale, so any second writer built from panel facts alone drops it.
    assert.deepEqual(stored.planSnapshot, { name: 'Pro 200' });
  });

  it('shows the operator what the panel reports for the columns it did not adopt', async () => {
    const { controller } = syncOver({ outcome: { kind: 'ok', user: DRIFTED_PANEL } });

    const result = await controller.syncSubscription('sub-1');

    // Refusing to adopt the drift is only half the answer: an operator who
    // pressed "sync" because a customer is complaining still has to be able to
    // SEE that the panel is enforcing 12 devices against a 3-device plan.
    assert.deepEqual(result.panelReports, {
      status: 'LIMITED',
      trafficLimitBytes: 5 * 1024 * 1024 * 1024,
      hwidDeviceLimit: 12,
      internalSquads: ['squad-free'],
      externalSquad: 'ext-free',
    });
  });

  it('does not erase a recorded panel identity, config URL or expiry with an answer that states none', async () => {
    // Everything `parsePanelUserRow` substitutes for a field the panel omitted:
    // `''` for the URL and the expiry, `null` for the numeric id, `''` for the
    // username. None of them is a statement about the profile.
    const { controller, stored } = syncOver({
      outcome: {
        kind: 'ok',
        user: syncedPanelProfile({
          subscriptionUrl: '',
          panelId: null,
          username: '',
          expireAt: '',
        }),
      },
    });

    const result = await controller.syncSubscription('sub-1');

    assert.equal(result.synced, true);
    assert.deepEqual(result.refreshed, {});
    assert.equal(stored.remnawavePanelId, 4471);
    assert.equal(stored.remnawavePanelUsername, 'rz_bob_1');
    assert.equal(stored.configUrl, STORED_CONFIG_URL);
    // And the expiry an operator sold, against the unguarded
    // `new Date(panelUser.expireAt)` this replaced: on `''` that is an Invalid
    // Date, which Prisma refuses at the driver — a 500 from the one endpoint an
    // operator presses to reassure themselves.
    assert.deepEqual(stored.expiresAt, new Date('2027-03-01T00:00:00.000Z'));
  });

  it('adopts an expiry the panel actually states', async () => {
    const { controller, stored } = syncOver({
      outcome: {
        kind: 'ok',
        user: syncedPanelProfile({ expireAt: '2099-01-01T00:00:00.000Z' }),
      },
    });

    const result = await controller.syncSubscription('sub-1');

    assert.deepEqual(stored.expiresAt, new Date('2099-01-01T00:00:00.000Z'));
    assert.deepEqual(result.refreshed?.expiresAt, new Date('2099-01-01T00:00:00.000Z'));
  });
});

// ── The subscription editor's limit edits leave a durable trace ────────────
//
// `resolveInheritedPlanLimitUpdate`
// (`subscriptions/services/plan-inherited-limits.util.ts`) decides at renewal
// whether a limit column was individually adjusted by comparing it against
// `plan_snapshot`. It is sound going forward and blind backwards: for a row
// whose column and snapshot already disagree it cannot tell an operator's
// deliberate value from drift (an import, a mirrored snapshot from before the
// freeze), which is exactly why a one-off repair of existing rows is not safely
// derivable. The editor changed limits for years and wrote NOTHING — `auditLog`
// was called for `remnawave_linked`, `deleted`, `given`, `trial.granted` and
// `sync.requested`, and for neither PATCH that moves a limit.
//
// These pin the evidence: that it names WHICH limit moved and to what, that a
// no-op PATCH manufactures none, and that a plan assignment is distinguishable
// from an individual edit — a replay that confused the two would read every
// legitimate reset as an override.

/** A complete subscription row: the editor reads all four limit columns. */
function editableRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    userId: 'user-1',
    remnawaveId: 'panel-user-1',
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    trafficLimit: 100,
    deviceLimit: 3,
    internalSquads: ['squad-a'],
    externalSquad: null,
    ...overrides,
  };
}

interface AuditEntry {
  readonly action: string;
  readonly metadata: Record<string, unknown>;
  readonly adminUser: { readonly connect: { readonly id: string } };
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

/**
 * The subscription editor over an in-memory row, recording audit writes.
 *
 * The transaction client gets its OWN update recorder, separate from the base
 * client's: `updateSubscription` writes inside a transaction and `updateSquads`
 * writes outside one, and a shared recorder could not tell those apart — a
 * write that escaped its transaction would look identical to one that did not.
 * Audit writes are collected from both sides and read as one list, because
 * WHERE the entry is written is not what these cases are about.
 */
function editorHarness(options: {
  readonly row?: Record<string, unknown>;
  readonly plan?: Record<string, unknown> | null;
} = {}) {
  const row = options.row ?? editableRow();
  const baseAudits: AuditEntry[] = [];
  const txAudits: AuditEntry[] = [];
  const baseUpdates: Array<Record<string, unknown>> = [];
  const txUpdates: Array<Record<string, unknown>> = [];

  const applyUpdate = (input: unknown, sink: Array<Record<string, unknown>>) => {
    const data = (input as { readonly data: Record<string, unknown> }).data;
    sink.push(data);
    return { ...row, ...data };
  };

  const controller = new AdminUserSubscriptionsController(
    {
      subscription: {
        findUnique: async () => row,
        update: async (input: unknown) => applyUpdate(input, baseUpdates),
      },
      plan: { findUnique: async () => options.plan ?? null },
      profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
      adminAuditLog: {
        create: async (input: unknown) => {
          baseAudits.push((input as { readonly data: AuditEntry }).data);
        },
      },
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          subscription: { update: async (input: unknown) => applyUpdate(input, txUpdates) },
          profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
          adminAuditLog: {
            create: async (input: unknown) => {
              txAudits.push((input as { readonly data: AuditEntry }).data);
            },
          },
        }),
    } as never,
    {} as never,
    { enqueue: async () => undefined } as never,
    { warn: () => undefined } as never,
    {} as never,
    {} as never,
  );

  return {
    controller,
    get audits() {
      return [...baseAudits, ...txAudits];
    },
    get baseUpdates() {
      return baseUpdates;
    },
    get txUpdates() {
      return txUpdates;
    },
  };
}

/** The one audit entry a case expects, or a loud failure naming what it got. */
function soleAudit(audits: readonly AuditEntry[]): AuditEntry {
  assert.equal(audits.length, 1, `expected exactly one audit entry, got ${JSON.stringify(audits)}`);
  return audits[0] as AuditEntry;
}

describe('subscription limit edits are recorded', () => {
  it('names the limit that moved, and both of its values', async () => {
    const harness = editorHarness();

    await harness.controller.updateSubscription(
      'sub-1',
      { deviceLimit: 5 },
      ACTING_ADMIN,
      ACTING_REQUEST,
    );

    const entry = soleAudit(harness.audits);
    assert.equal(entry.action, 'user.subscription.limits_changed');
    // WHICH limit moved, and to what. An entry that only said "limits changed"
    // could not drive the repair it exists to enable.
    assert.deepStrictEqual(entry.metadata, {
      requestId: 'req-1',
      userId: 'user-1',
      subscriptionId: 'sub-1',
      source: 'operator_edit',
      assignedPlanId: null,
      changes: { deviceLimit: { from: 3, to: 5 } },
    });
    // The actor and the request are recorded the same way every other audited
    // route in this controller records them.
    assert.deepStrictEqual(entry.adminUser, { connect: { id: 'admin-1' } });
    assert.equal(entry.ipAddress, '10.0.0.7');
    assert.equal(entry.userAgent, 'jest');
  });

  it('records only the fields the request actually moved', async () => {
    const harness = editorHarness();

    await harness.controller.updateSubscription(
      // `deviceLimit` is re-sent at the value the row already holds — the admin
      // SPA posts the whole form — so only traffic may appear.
      'sub-1',
      { trafficLimit: 250, deviceLimit: 3 },
      ACTING_ADMIN,
      ACTING_REQUEST,
    );

    const entry = soleAudit(harness.audits);
    assert.deepStrictEqual(entry.metadata['changes'], {
      trafficLimit: { from: 100, to: 250 },
    });
  });

  it('writes nothing for a PATCH that changes no limit', async () => {
    const harness = editorHarness();

    // A save that re-sends the values the row already holds must not
    // manufacture evidence of an override: a replay would then read this row as
    // deliberately adjusted and pin its limits for the rest of its life.
    await harness.controller.updateSubscription(
      'sub-1',
      { trafficLimit: 100, deviceLimit: 3 },
      ACTING_ADMIN,
      ACTING_REQUEST,
    );

    assert.deepStrictEqual(harness.audits, []);
    // …and the edit itself still happened, so this is "nothing to record", not
    // "the endpoint refused".
    assert.equal(harness.txUpdates.length, 1);
  });

  it('writes nothing when the request touches no limit at all', async () => {
    const harness = editorHarness();

    await harness.controller.updateSubscription(
      'sub-1',
      { status: SubscriptionStatus.DISABLED },
      ACTING_ADMIN,
      ACTING_REQUEST,
    );

    assert.deepStrictEqual(harness.audits, []);
  });

  it('distinguishes a plan assignment from an individual edit', async () => {
    const harness = editorHarness({
      plan: {
        id: 'plan-2',
        name: 'Pro',
        tag: null,
        type: 'TRAFFIC',
        icon: null,
        trafficLimit: 500,
        deviceLimit: 10,
        trafficLimitStrategy: 'MONTH',
        internalSquads: ['squad-b'],
        externalSquad: null,
      },
    });

    await harness.controller.updateSubscription(
      'sub-1',
      { planId: 'plan-2' },
      ACTING_ADMIN,
      ACTING_REQUEST,
    );

    const entry = soleAudit(harness.audits);
    // A plan assignment legitimately resets all four AND rewrites the snapshot
    // with them, so a replay must read it as "back to inherited", never as four
    // individual overrides. `source` is what says so — it is taken from
    // `assignedPlanId`, not inferred from the shape of the change set.
    assert.equal(entry.metadata['source'], 'plan_assignment');
    assert.equal(entry.metadata['assignedPlanId'], 'plan-2');
    assert.deepStrictEqual(entry.metadata['changes'], {
      trafficLimit: { from: 100, to: 500 },
      deviceLimit: { from: 3, to: 10 },
      internalSquads: { from: ['squad-a'], to: ['squad-b'] },
    });
    // The snapshot went with it, which is what makes the reset real rather than
    // four columns that now disagree with what the plan gave them.
    assert.equal(
      (harness.txUpdates[0]?.planSnapshot as { readonly deviceLimit: number }).deviceLimit,
      10,
    );
  });

  it('records a squad edit made through the squads endpoint', async () => {
    const harness = editorHarness();

    await harness.controller.updateSquads(
      'sub-1',
      { internalSquads: ['squad-b', 'squad-c'], externalSquad: 'ext-1' },
      ACTING_ADMIN,
      ACTING_REQUEST,
    );

    const entry = soleAudit(harness.audits);
    assert.equal(entry.action, 'user.subscription.limits_changed');
    // No plan can be assigned on this route, so every change it records is an
    // individual override.
    assert.equal(entry.metadata['source'], 'operator_edit');
    assert.equal(entry.metadata['assignedPlanId'], null);
    assert.deepStrictEqual(entry.metadata['changes'], {
      internalSquads: { from: ['squad-a'], to: ['squad-b', 'squad-c'] },
      externalSquad: { from: null, to: 'ext-1' },
    });
  });

  it('does not read a reordered squad list as an override', async () => {
    const harness = editorHarness({
      row: editableRow({ internalSquads: ['squad-a', 'squad-b'] }),
    });

    await harness.controller.updateSquads(
      'sub-1',
      { internalSquads: ['squad-b', 'squad-a'] },
      ACTING_ADMIN,
      ACTING_REQUEST,
    );

    // Order is not significant to `resolveInheritedPlanLimitUpdate` either
    // (`sameSquadSet`), so recording this as a change would declare an override
    // that the renewal reader does not agree exists.
    assert.deepStrictEqual(harness.audits, []);
  });
});
