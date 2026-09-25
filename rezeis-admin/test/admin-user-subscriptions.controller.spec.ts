import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  BadRequestException,
  ConflictException,
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
import {
  staleDeviceDeleteRefusalBody,
  SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE,
} from '../src/modules/remnawave/services/stale-panel-link';
import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';
import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import { OPERATOR_LIMIT_SOURCE } from '../src/modules/anti-fraud/detectors/sharing-detectors';
import { SUBSCRIPTION_SYNC_REFUSAL_CODES } from '../src/modules/users/controllers/subscription-sync-refusals';
import { NOT_IN_TERM_MODEL } from './helpers/term-model-hooks';

/**
 * The one message `linkRemnawaveProfile` gives an operator whose identifier is
 * not the numeric profile id. Asserted verbatim below because it is the whole
 * remedy: the operator cannot see the regex, only this sentence.
 */
const REMNAWAVE_ID_REQUIRED_MESSAGE =
  'A valid Remnawave profile identifier is required: the numeric profile id shown by panel 3.x';

/**
 * The refusal an operator gets when the profile they pasted is already held by
 * another subscription. Asserted verbatim, and as a 400, because that pair is
 * the contract the admin SPA renders — a duplicate found by a WIDER comparison
 * must still arrive as the same answer, not as a new failure mode.
 */
const REMNAWAVE_PROFILE_TAKEN_MESSAGE =
  'This Remnawave profile is already linked to another subscription';

/**
 * The 409 an operator gets when the subscription's link changed between the
 * endpoint's read and its write (review R2b-05). Asserted verbatim and THROUGH
 * the safe filter: its English twin would carry the word the filter scrubs.
 */
const REMNAWAVE_LINK_CHANGED_MESSAGE =
  'Привязка этой подписки к Remnawave изменилась, пока шла проверка (например, её только что записала ' +
  'автоматическая проверка привязки). Ничего не изменено — обновите страницу и посмотрите, какая привязка ' +
  'у подписки сейчас.';

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
  /** Overrides on the subscription's owner: Telegram id 42, no e-mail, no web account. */
  user?: Record<string, unknown>;
  /** Other local accounts, for naming the customer a `reiwa_id` line points at. */
  knownUsers?: ReadonlyArray<{ id: string; telegramId: bigint | null }>;
}) {
  const updateCalls: unknown[] = [];
  const guardQueries: unknown[] = [];
  const locks: string[] = [];
  const auditWrites: Array<{ data: { action: string; metadata: Record<string, unknown>; adminUser: unknown } }> = [];
  const subscription = {
    findUnique: async () => ({
      id: 'legacy-subscription',
      userId: 'user-1',
      remnawaveId: null,
      configUrl: null,
      user: { id: 'user-1', telegramId: BigInt(42), email: null, webAccount: null, ...options.user },
    }),
    findFirst: findFirstOver(options.rows, guardQueries),
    // The write, whichever way it is spelled: a write that happened is recorded.
    update: async (input: unknown) => {
      updateCalls.push(input);
      return { id: 'legacy-subscription' };
    },
    updateMany: async (input: unknown) => {
      updateCalls.push(input);
      return { count: 1 };
    },
    findUniqueOrThrow: async () => ({ id: 'legacy-subscription' }),
  };
  const controller = new AdminUserSubscriptionsController(
    {
      subscription,
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          $executeRaw: async (query: { values?: unknown[] }) => {
            locks.push(String(query.values?.[0]));
            return 1;
          },
          subscription,
        }),
      adminAuditLog: {
        create: async (input: (typeof auditWrites)[number]) => {
          auditWrites.push(input);
        },
      },
      user: {
        findMany: async (input: { where: { id: { in: string[] } } }) =>
          (options.knownUsers ?? []).filter((row) => input.where.id.in.includes(row.id)),
      },
    } as never,
    { getPanelUserOutcome: async () => ({ kind: 'ok', user: options.panelUser }) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    NOT_IN_TERM_MODEL as never,
  );
  return { controller, updateCalls, guardQueries, auditWrites, locks };
}

/** The endpoint call itself, so each case shows only the identifier it pastes. */
function repairLink(
  controller: AdminUserSubscriptionsController,
  pastedIdentity: string,
  extra: Record<string, unknown> = {},
) {
  return controller.linkRemnawaveProfile(
    'legacy-subscription',
    { remnawaveId: pastedIdentity, ...extra },
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
      NOT_IN_TERM_MODEL as never,
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
      NOT_IN_TERM_MODEL as never,
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
      // The operator card prints no message, so the consequence rides as a note.
      note: 'Изменения сохранены только в rezeis: у подписки нет привязки к профилю Remnawave, и панель их не получит.',
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
      NOT_IN_TERM_MODEL as never,
    );

    await controller.updateSubscription(
      'linked-subscription',
      { status: SubscriptionStatus.DISABLED },
      ACTING_ADMIN,
      ACTING_REQUEST,
    );

    assert.deepStrictEqual(warned, []);
  });

  // ── A stale link is repaired here too, under the same proof ──────────────
  //
  // A row that still stores a 2.x uuid names nobody on a 3.x panel, and every
  // destructive path refuses it. The automatic link check re-links the ones it
  // can prove; the rest are listed for an operator, whose remedy is this
  // endpoint (owner's decision, 24.09.2026). Only a STALE id is overwritten — a
  // decimal is a working link, and replacing it here would move a paying
  // customer onto a profile somebody typed.

  it('overwrites a stale 2.x link with the same ownership proof, and the audit row keeps the id it replaced', async () => {
    const staleUuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const updateCalls: unknown[] = [];
    const auditCalls: Array<{ data: { metadata: Record<string, unknown> } }> = [];
    const subscription = {
      findUnique: async () => ({
        id: 'legacy-subscription',
        userId: 'user-1',
        remnawaveId: staleUuid,
        configUrl: null,
        user: { id: 'user-1', telegramId: BigInt(42), email: null },
      }),
      findFirst: async () => null,
      updateMany: async (input: unknown) => {
        updateCalls.push(input);
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ id: 'legacy-subscription', remnawaveId: '4471' }),
    };
    const controller = new AdminUserSubscriptionsController(
      {
        subscription,
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
          callback({ $executeRaw: async () => 1, subscription }),
        adminAuditLog: {
          create: async (input: { data: { metadata: Record<string, unknown> } }) => auditCalls.push(input),
        },
      } as never,
      {
        getPanelUserOutcome: async () => ({
          kind: 'ok',
          user: {
            subscriptionUrl: 'https://panel.example.test/sub',
            // The proof: the Telegram id matches the customer's.
            telegramId: 42,
            email: null,
            description: null,
            panelId: 4471,
            username: 'rz_bob_1',
          },
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      NOT_IN_TERM_MODEL as never,
    );

    const result = await controller.linkRemnawaveProfile(
      'legacy-subscription',
      { remnawaveId: ' 4471 ' },
      { id: 'admin-1' } as never,
      { headers: {}, ip: null, socket: { remoteAddress: null } } as never,
    );

    assert.deepStrictEqual(result, { id: 'legacy-subscription', remnawaveId: '4471' });
    assert.deepStrictEqual(updateCalls, [{
      // Written only over the stale id it read (review R2b-05).
      where: { id: 'legacy-subscription', remnawaveId: staleUuid },
      data: {
        remnawaveId: '4471',
        remnawavePanelId: 4471,
        remnawavePanelUsername: 'rz_bob_1',
        configUrl: 'https://panel.example.test/sub',
        remnawavePendingUsername: null,
        remnawavePendingOwnerId: null,
      },
    }]);
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0]?.data.metadata['previousRemnawaveId'], staleUuid);
    assert.equal(auditCalls[0]?.data.metadata['remnawaveId'], '4471');
    assert.equal(auditCalls[0]?.data.metadata['ownershipVerifiedBy'], 'telegram_id');
  });

  it('an overwrite of a stale link needs the same proof: with none, it refuses and writes nothing', async () => {
    let updated = false;
    const controller = new AdminUserSubscriptionsController(
      {
        subscription: {
          findUnique: async () => ({
            id: 'legacy-subscription',
            userId: 'user-1',
            remnawaveId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
            configUrl: null,
            user: { id: 'user-1', telegramId: BigInt(42), email: null },
          }),
          findFirst: async () => null,
          update: async () => { updated = true; return {}; },
        },
        // The write runs in its own transaction: starting it is writing.
        $transaction: async () => { updated = true; return {}; },
      } as never,
      {
        getPanelUserOutcome: async () => ({
          kind: 'ok',
          user: {
            subscriptionUrl: 'https://panel.example.test/sub',
            telegramId: 99,
            email: null,
            description: null,
            panelId: 4471,
            username: 'rz_somebody',
          },
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      NOT_IN_TERM_MODEL as never,
    );

    const failure = await captureRejection(() =>
      controller.linkRemnawaveProfile(
        'legacy-subscription',
        { remnawaveId: '4471' },
        { id: 'admin-1' } as never,
        { headers: {}, ip: null, socket: { remoteAddress: null } } as never,
      ),
    );

    assert.equal(failure instanceof BadRequestException, true, String(failure));
    assert.match((failure as Error).message, /^Nothing proves/);
    assert.equal(updated, false);
  });

  it('never overwrites a NUMERIC link, and does not even ask the panel', async () => {
    for (const current of ['4471', '0']) {
      let panelAsked = false;
      let updated = false;
      const controller = new AdminUserSubscriptionsController(
        {
          subscription: {
            findUnique: async () => ({
              id: 'legacy-subscription',
              userId: 'user-1',
              remnawaveId: current,
              configUrl: null,
              user: { id: 'user-1', telegramId: BigInt(42), email: null },
            }),
            findFirst: async () => null,
            update: async () => { updated = true; return {}; },
          },
          $transaction: async () => { updated = true; return {}; },
        } as never,
        {
          getPanelUserOutcome: async () => {
            panelAsked = true;
            return { kind: 'missing' };
          },
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        NOT_IN_TERM_MODEL as never,
      );

      const failure = await captureRejection(() =>
        controller.linkRemnawaveProfile(
          'legacy-subscription',
          { remnawaveId: '5150' },
          { id: 'admin-1' } as never,
          { headers: {}, ip: null, socket: { remoteAddress: null } } as never,
        ),
      );

      assert.equal(failure instanceof BadRequestException, true, `${current}: ${String(failure)}`);
      assert.equal((failure as Error).message, 'Subscription already has a Remnawave profile linked');
      assert.equal(panelAsked, false, `${current}: the panel was asked`);
      assert.equal(updated, false, `${current}: a working link was overwritten`);
    }
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
      NOT_IN_TERM_MODEL as never,
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

  // ── Panel identity gate: the 3.x numeric id, nothing else ────────────────
  //
  // Remnawave 3.x deleted the uuid column; a 3.x profile is named by its
  // numeric `id`, and this build speaks 3.x only. A 2.x uuid names nobody on
  // such a panel, and linking one would re-create exactly the stale row the
  // destructive paths refuse. The value is also interpolated into a panel URL
  // path segment, so the rejection cases below are the half of this behaviour
  // that actually guards something. The accept cases alone would pass a gate
  // with no gate in it.

  it('links a Remnawave 3.x numeric profile id, which has no uuid form to offer', async () => {
    const panelReads: unknown[] = [];
    const updateCalls: unknown[] = [];
    const subscription = {
      findUnique: async () => ({
        id: 'legacy-subscription',
        userId: 'user-1',
        remnawaveId: null,
        configUrl: null,
        user: { id: 'user-1', telegramId: BigInt(42), email: null },
      }),
      findFirst: async () => null,
      updateMany: async (input: unknown) => {
        updateCalls.push(input);
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ id: 'legacy-subscription', remnawaveId: '4471' }),
    };
    const controller = new AdminUserSubscriptionsController(
      {
        subscription,
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
          callback({ $executeRaw: async () => 1, subscription }),
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
              // with what the operator typed; the username is recorded as the
              // address chain's last resort.
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
      NOT_IN_TERM_MODEL as never,
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
      where: { id: 'legacy-subscription', remnawaveId: null },
      data: {
        remnawaveId: '4471',
        remnawavePanelId: 4471,
        remnawavePanelUsername: 'rz_bob_1',
        configUrl: 'https://panel.example.test/sub',
        remnawavePendingUsername: null,
        remnawavePendingOwnerId: null,
      },
    }]);
  });

  it('refuses anything but a decimal profile id — a 2.x uuid included — before touching Prisma or the panel', async () => {
    const refused = [
      { label: 'empty', value: '' },
      { label: 'whitespace only', value: '   ' },
      { label: 'a hex fragment that is not a number', value: '12a' },
      // What the endpoint accepted until the 2.x cut. It names nobody on a 3.x
      // panel, and `parseInt` would read it as profile 4047 — somebody else.
      { label: 'a 2.x uuid', value: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' },
      { label: 'a signed number', value: '-4471' },
      { label: 'an exponent', value: '4e3' },
      // Longer than any 64-bit id: `^[0-9]+$` alone would take a megabyte.
      { label: 'twenty-one digits', value: '1'.repeat(21) },
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
        NOT_IN_TERM_MODEL as never,
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

  it('refuses a repair when another subscription stores that profile as the same decimal', async () => {
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
      panelUser: panelProfile({ panelId: PROFILE_P_PANEL_ID }),
    });

    const failure = await captureRejection(() => repairLink(controller, String(PROFILE_P_PANEL_ID)));

    assert.equal(failure instanceof BadRequestException, true, String(failure));
    assert.equal((failure as Error).message, REMNAWAVE_PROFILE_TAKEN_MESSAGE);
    assert.deepStrictEqual(updateCalls, [], 'the refusal must land before any write');
  });

  it('still refuses a zero-padded paste of a decimal another subscription already stores', async () => {
    const { controller, updateCalls } = linkRepairFor({
      rows: [{
        id: 'sibling-subscription',
        // Neither supplementary column ever recorded: the stored string is the
        // whole answer here, so `05150` has to be read as the `5150` it is.
        remnawaveId: String(PROFILE_P_PANEL_ID),
        remnawavePanelId: null,
        remnawavePanelUsername: null,
      }],
      panelUser: panelProfile({ panelId: PROFILE_P_PANEL_ID }),
    });

    const failure = await captureRejection(() => repairLink(controller, `0${PROFILE_P_PANEL_ID}`));

    assert.equal(failure instanceof BadRequestException, true, String(failure));
    assert.equal((failure as Error).message, REMNAWAVE_PROFILE_TAKEN_MESSAGE);
    assert.deepStrictEqual(updateCalls, []);
  });

  it('still links a profile no other subscription names, stored as the panel spells its id', async () => {
    for (const pasted of [String(PROFILE_P_PANEL_ID), `00${PROFILE_P_PANEL_ID}`]) {
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
      // matched" rather than "the guard never ran" — once after the panel read,
      // and once more under the profile lock, right before the write.
      assert.equal(guardQueries.length, 2, `${pasted}: the duplicate guard did not query twice`);
      assert.deepStrictEqual(
        updateCalls,
        [{
          where: { id: 'legacy-subscription', remnawaveId: null },
          data: {
            // Never `005150`: every later lookup compares the stored string.
            remnawaveId: String(PROFILE_P_PANEL_ID),
            remnawavePanelId: PROFILE_P_PANEL_ID,
            remnawavePanelUsername: 'rz_bob_1',
            configUrl: 'https://panel.example.test/sub',
            remnawavePendingUsername: null,
            remnawavePendingOwnerId: null,
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
        $transaction: async () => { updated = true; return {}; },
        // No local account carries the id the line names.
        user: { findMany: async () => [] },
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
      NOT_IN_TERM_MODEL as never,
    );

    await assert.rejects(
      () => controller.linkRemnawaveProfile(
        'legacy-subscription',
        { remnawaveId: '9901' },
        { id: 'admin-1' } as never,
        { headers: {}, ip: null, socket: { remoteAddress: null } } as never,
      ),
      // Its marker line names somebody else: refused, and that customer named —
      // here, as an account this panel does not have.
      { message: /names another customer: an account this panel does not have\./ },
    );
    assert.equal(updated, false);
  });

  // ── Link repair: the reiwa_id proof is the marker LINE, every line agreeing ──
  //
  // The customer here has Telegram id 42 and no e-mail, and every profile below
  // answers with Telegram id 99 — so the `reiwa_id` line is the only proof on
  // offer. It proves ownership only when every marker line names this customer:
  // a second line naming somebody else means the description proves nobody.

  it('refuses when one marker line names this customer and another names somebody else', async () => {
    const { controller, updateCalls } = linkRepairFor({
      rows: [],
      panelUser: panelProfile({ telegramId: 99, description: 'name: Bob\nreiwa_id: user-1\nreiwa_id: user-999' }),
    });

    const failure = await captureRejection(() => repairLink(controller, String(PROFILE_P_PANEL_ID)));

    assert.equal(failure instanceof BadRequestException, true, String(failure));
    assert.match((failure as Error).message, /names another customer: an account this panel does not have\./);
    assert.deepStrictEqual(updateCalls, [], 'a description that proves nobody links nothing');
  });

  it('refuses a display name that forges this customer\'s marker above somebody else\'s', async () => {
    const { controller, updateCalls } = linkRepairFor({
      rows: [],
      panelUser: panelProfile({ telegramId: 99, description: 'name: reiwa_id: user-1\nreiwa_id: user-999' }),
    });

    const failure = await captureRejection(() => repairLink(controller, String(PROFILE_P_PANEL_ID)));

    assert.equal(failure instanceof BadRequestException, true, String(failure));
    assert.deepStrictEqual(updateCalls, []);
  });

  it('links a profile whose marker lines all name this customer', async () => {
    const { controller, updateCalls } = linkRepairFor({
      rows: [],
      panelUser: panelProfile({ telegramId: 99, description: 'name: Bob\r\nreiwa_id: user-1\r\nnote\r\nreiwa_id: user-1' }),
    });

    await repairLink(controller, String(PROFILE_P_PANEL_ID));

    assert.equal(updateCalls.length, 1);
  });

  // ── Link repair: proof, and the operator's word when there is none ───────
  //
  // The panel-link repair and the duplicate merge refuse every profile whose
  // description proves no owner — stale 2.x-era imports among them — and send
  // the operator here (owner's decision, 19.09.2026). So this endpoint has to be
  // able to link one: by the verified e-mail on the customer's web account, the
  // only address a web-only customer has, or — with no proof at all — by the
  // operator's explicit confirmation, which the audit row records. A line naming
  // ANOTHER customer refuses whatever else matches and whatever is confirmed.

  it('a marker naming another customer refuses even when the Telegram id matches, and names that customer', async () => {
    const { controller, updateCalls } = linkRepairFor({
      rows: [],
      knownUsers: [{ id: 'user-999', telegramId: 777000222n }],
      panelUser: panelProfile({ telegramId: 42, description: 'name: Bob\nreiwa_id: user-999' }),
    });

    const failure = await captureRejection(() => repairLink(controller, String(PROFILE_P_PANEL_ID)));

    assert.equal(failure instanceof BadRequestException, true, String(failure));
    // By the Telegram ID the customer card opens by.
    assert.match((failure as Error).message, /names another customer: the customer with Telegram ID 777000222\./);
    assert.deepStrictEqual(updateCalls, []);
  });

  it('the operator\'s confirmation does not override a marker naming another customer', async () => {
    const { controller, updateCalls } = linkRepairFor({
      rows: [],
      panelUser: panelProfile({ telegramId: 99, description: 'reiwa_id: user-999' }),
    });

    const failure = await captureRejection(() =>
      repairLink(controller, String(PROFILE_P_PANEL_ID), { confirmedWithoutProof: true }),
    );

    assert.match((failure as Error).message, /names another customer/);
    assert.deepStrictEqual(updateCalls, []);
  });

  it('names the other customer without their id, so no id shape blanks the refusal on its way out', async () => {
    // The line's value is text from the panel. Quoted in the sentence, one that
    // looks like hex, a UUID, `sub_…` or the word "token" made the safe filter
    // replace the WHOLE message, and the operator learned nothing.
    const shapes = [
      `c${'4f'.repeat(12)}`,
      'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      'sub_4fe1d8c2a9',
      'token',
      'user-999',
    ];
    for (const known of [true, false]) {
      for (const ownerId of shapes) {
        const { controller } = linkRepairFor({
          rows: [],
          knownUsers: known ? [{ id: ownerId, telegramId: 777000222n }] : [],
          panelUser: panelProfile({ telegramId: 99, description: `reiwa_id: ${ownerId}` }),
        });

        const failure = await captureRejection(() => repairLink(controller, String(PROFILE_P_PANEL_ID)));
        const sent = sentToOperator(failure);

        assert.equal(sent, (failure as Error).message, `${ownerId}: the filter left the refusal whole`);
        assert.equal(String(sent).includes(ownerId), false, `${ownerId}: the raw id is not in the sentence`);
        assert.match(
          String(sent),
          known ? /the customer with Telegram ID 777000222/ : /an account this panel does not have/,
          ownerId,
        );
      }
    }
  });

  it('links a web-only customer by the VERIFIED e-mail on their web account', async () => {
    const { controller, updateCalls, auditWrites } = linkRepairFor({
      rows: [],
      user: {
        telegramId: null,
        webAccount: {
          email: 'Owner@Example.test',
          emailNormalized: 'owner@example.test',
          emailVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
        },
      },
      panelUser: panelProfile({ telegramId: null, email: 'owner@example.test ', description: 'imported from a 2.x panel' }),
    });

    await repairLink(controller, String(PROFILE_P_PANEL_ID));

    assert.equal(updateCalls.length, 1);
    assert.equal(auditWrites[0]?.data.metadata['ownershipVerifiedBy'], 'web_account_email');
    assert.equal(auditWrites[0]?.data.metadata['confirmedWithoutProof'], false);
  });

  it('an UNVERIFIED web-account e-mail proves nothing', async () => {
    const { controller, updateCalls } = linkRepairFor({
      rows: [],
      user: {
        telegramId: null,
        webAccount: { email: 'owner@example.test', emailNormalized: 'owner@example.test', emailVerifiedAt: null },
      },
      panelUser: panelProfile({ telegramId: null, email: 'owner@example.test', description: null }),
    });

    const failure = await captureRejection(() => repairLink(controller, String(PROFILE_P_PANEL_ID)));

    assert.equal(failure instanceof BadRequestException, true, String(failure));
    assert.match((failure as Error).message, /^Nothing proves/);
    assert.deepStrictEqual(updateCalls, []);
  });

  it('with no proof at all it refuses and says the operator may confirm; confirmed, it links and the audit row says so', async () => {
    const setup = () =>
      linkRepairFor({
        rows: [],
        panelUser: panelProfile({ telegramId: 99, email: null, description: 'imported from a 2.x panel' }),
      });

    const refused = setup();
    const failure = await captureRejection(() => repairLink(refused.controller, String(PROFILE_P_PANEL_ID)));
    assert.match((failure as Error).message, /If you have checked that it is theirs, confirm that and link again/);
    assert.deepStrictEqual(refused.updateCalls, []);

    const confirmed = setup();
    await repairLink(confirmed.controller, String(PROFILE_P_PANEL_ID), { confirmedWithoutProof: true });
    assert.equal(confirmed.updateCalls.length, 1);
    assert.equal(confirmed.auditWrites.length, 1);
    const audit = confirmed.auditWrites[0].data;
    assert.equal(audit.action, 'user.subscription.remnawave_linked');
    assert.deepEqual(audit.adminUser, { connect: { id: 'admin-1' } }, 'who confirmed it');
    assert.equal(audit.metadata['remnawaveId'], String(PROFILE_P_PANEL_ID), 'which profile');
    assert.equal(audit.metadata['remnawaveUsername'], 'rz_bob_1');
    assert.equal(audit.metadata['confirmedWithoutProof'], true, 'and that nothing proved it');
    assert.equal(audit.metadata['ownershipVerifiedBy'], 'operator_confirmation');
  });

  it('a confirmation sent when proof exists changes nothing: the proof is what the audit row records', async () => {
    const { controller, auditWrites } = linkRepairFor({
      rows: [],
      panelUser: panelProfile({ telegramId: 42 }),
    });

    await repairLink(controller, String(PROFILE_P_PANEL_ID), { confirmedWithoutProof: true });

    assert.equal(auditWrites[0]?.data.metadata['ownershipVerifiedBy'], 'telegram_id');
    assert.equal(auditWrites[0]?.data.metadata['confirmedWithoutProof'], false);
  });

  it('only a literal true confirms: a string or a number from a stray client proves nothing', async () => {
    for (const notTrue of ['true', 1, 'yes']) {
      const { controller, updateCalls } = linkRepairFor({
        rows: [],
        panelUser: panelProfile({ telegramId: 99, description: null }),
      });

      const failure = await captureRejection(() =>
        repairLink(controller, String(PROFILE_P_PANEL_ID), { confirmedWithoutProof: notTrue }),
      );

      assert.equal(failure instanceof BadRequestException, true, JSON.stringify(notTrue));
      assert.deepStrictEqual(updateCalls, [], JSON.stringify(notTrue));
    }
  });

  it('both refusals reach the operator in their own words: the safe filter passes them through', async () => {
    for (const panelUser of [
      panelProfile({ telegramId: 99, description: 'reiwa_id: user-999' }),
      panelProfile({ telegramId: 99, description: null }),
    ]) {
      const { controller } = linkRepairFor({ rows: [], panelUser });

      const failure = await captureRejection(() => repairLink(controller, String(PROFILE_P_PANEL_ID)));

      assert.equal(sentToOperator(failure), (failure as Error).message);
    }
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
        $transaction: async () => { updated = true; return {}; },
      } as never,
      { getPanelUserOutcome: async () => ({ kind: 'unavailable' }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      NOT_IN_TERM_MODEL as never,
    );

    const failure = await captureRejection(() =>
      controller.linkRemnawaveProfile(
        'legacy-subscription',
        { remnawaveId: '4471' },
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
      NOT_IN_TERM_MODEL as never,
    );

    const failure = await captureRejection(() =>
      controller.linkRemnawaveProfile(
        'legacy-subscription',
        { remnawaveId: '4471' },
        { id: 'admin-1' } as never,
        { headers: {}, ip: null, socket: { remoteAddress: null } } as never,
      ),
    );

    assert.equal(failure instanceof NotFoundException, true);
    assert.equal((failure as NotFoundException).getStatus(), 404);
    assert.equal((failure as Error).message, 'Remnawave profile was not found');
  });

  // ── A link written while the operator's was in flight (review R2b-05) ────
  //
  // Between this endpoint's read of the row and its write sits a panel
  // round-trip. The automatic check links rows by itself — the walk and the
  // comparison, each under the profile lock and a compare-and-swap — so a row
  // read as empty or stale can hold a working numeric link by the time the
  // operator's write lands. That write is a compare-and-swap too now, under the
  // same lock: a link that changed meanwhile is never overwritten.

  /**
   * The endpoint over ONE table row and the rows around it. `update` is kept
   * beside `updateMany` so the case can tell an unconditional write from a
   * fenced one on any version of the code: whatever the controller writes lands
   * on `row`.
   */
  function racingLink(options: {
    /** What the automatic check writes onto the row during the panel read. */
    readonly linkedMeanwhile?: Record<string, unknown>;
    /**
     * Another row that takes the profile AFTER the endpoint's duplicate check
     * answered "nobody" — so only a question asked again under the lock sees it.
     */
    readonly takenAfterCheck?: { readonly id: string };
  }) {
    const row: Record<string, unknown> = {
      id: 'legacy-subscription',
      userId: 'user-1',
      remnawaveId: null,
      remnawavePanelId: null,
      remnawavePanelUsername: null,
      configUrl: null,
    };
    let guardQuestions = 0;
    const locks: string[] = [];
    const matchesRow = (where: Record<string, unknown>) =>
      Object.entries(where).every(([field, value]) => row[field] === value);
    const subscription = {
      findUnique: async () => ({ ...row, user: { id: 'user-1', telegramId: BigInt(42), email: null, webAccount: null } }),
      findFirst: async () => {
        guardQuestions += 1;
        return guardQuestions > 1 && options.takenAfterCheck !== undefined ? { ...options.takenAfterCheck } : null;
      },
      update: async (input: { data: Record<string, unknown> }) => {
        Object.assign(row, input.data);
        return { ...row };
      },
      updateMany: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!matchesRow(input.where)) return { count: 0 };
        Object.assign(row, input.data);
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ ...row }),
    };
    const controller = new AdminUserSubscriptionsController(
      {
        subscription,
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
          callback({
            $executeRaw: async (query: { values?: unknown[] }) => {
              locks.push(String(query.values?.[0]));
              return 1;
            },
            subscription,
          }),
        adminAuditLog: { create: async () => undefined },
      } as never,
      {
        getPanelUserOutcome: async () => {
          if (options.linkedMeanwhile !== undefined) Object.assign(row, options.linkedMeanwhile);
          return { kind: 'ok', user: panelProfile({ panelId: PROFILE_P_PANEL_ID }) };
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      NOT_IN_TERM_MODEL as never,
    );
    return { controller, row, locks };
  }

  it('R2b-05: a numeric link written during the panel read wins — 409 in words, the numeric link survives', async () => {
    const { controller, row } = racingLink({ linkedMeanwhile: { remnawaveId: '7777', remnawavePanelId: 7777 } });

    const failure = await captureRejection(() => repairLink(controller, String(PROFILE_P_PANEL_ID)));

    assert.equal(failure instanceof ConflictException, true, String(failure));
    assert.equal((failure as ConflictException).getStatus(), 409);
    assert.equal((failure as Error).message, REMNAWAVE_LINK_CHANGED_MESSAGE);
    assert.equal(sentToOperator(failure), REMNAWAVE_LINK_CHANGED_MESSAGE, 'the operator reads it as written');
    assert.equal(row['remnawaveId'], '7777', 'the working numeric link is not overwritten');
    assert.equal(row['remnawavePanelId'], 7777);
  });

  it('R2b-05: a profile another row took after the duplicate check is refused under the lock, and nothing is written', async () => {
    const { controller, row } = racingLink({ takenAfterCheck: { id: 'other-subscription' } });

    const failure = await captureRejection(() => repairLink(controller, String(PROFILE_P_PANEL_ID)));

    assert.equal(failure instanceof BadRequestException, true, String(failure));
    assert.equal((failure as Error).message, REMNAWAVE_PROFILE_TAKEN_MESSAGE);
    assert.equal(row['remnawaveId'], null, 'one profile never lands on two rows');
  });

  it('R2b-05 control: with nothing in between, it links — under the lock every link writer takes', async () => {
    const { controller, row, locks } = racingLink({});

    await repairLink(controller, String(PROFILE_P_PANEL_ID));

    assert.equal(row['remnawaveId'], String(PROFILE_P_PANEL_ID));
    assert.deepStrictEqual(locks, [`remnawave-profile:${PROFILE_P_PANEL_ID}`]);
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
      NOT_IN_TERM_MODEL as never,
    );

    await controller.getDevices('subscription-1');

    assert.equal(panelReads.length, 1);
    // Asserted through the real addressing function, not by eyeballing the
    // object: what matters is that a 3.x panel path can be BUILT from what the
    // controller handed over.
    assert.deepStrictEqual(panelUserAddress(panelReads[0] as StoredPanelIdentity), {
      kind: 'ready',
      segment: '4471',
    });
    // Counter-check: the stored string alone — what this call site used to pass
    // — names nothing on that panel.
    assert.equal(
      panelUserAddress({ remnawaveId: staleUuid, panelId: null, panelUsername: null }).kind,
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
      NOT_IN_TERM_MODEL as never,
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
      NOT_IN_TERM_MODEL as never,
    );

    assert.deepStrictEqual(await controller.getDevices('subscription-1'), {
      devices: [],
      deviceCount: 0,
    });
    assert.deepStrictEqual(panelReads, [PANEL_BACKED_IDENTITY]);
  });

  // ── «Удалить» on one device: the stale-link refusal, with no era ─────────
  //
  // The device verb names its owner through the same address fallback as every
  // other, so a stored 2.x uuid resolves through the recorded panel id to
  // whoever is LIVE at that address — and would unbind THEIR device. The refusal
  // reads no panel version: a non-decimal is refused however the panel answers.

  function deviceRevoker(remnawaveId: string) {
    const deletes: unknown[] = [];
    const controller = new AdminUserSubscriptionsController(
      {
        subscription: {
          findUnique: async () => ({
            ...panelBackedRow({ remnawaveId }),
            configUrl: null,
            planSnapshot: null,
            userId: 'user-1',
            user: { telegramId: BigInt(42), username: 'bob', name: 'Bob' },
          }),
        },
        adminAuditLog: { create: async () => undefined },
      } as never,
      {
        deletePanelUserDevice: async (ref: unknown, hwid: string) => {
          deletes.push({ ref, hwid });
          return { total: 1 };
        },
      } as never,
      {} as never,
      { info: () => undefined } as never,
      {} as never,
      {} as never,
      NOT_IN_TERM_MODEL as never,
    );
    return { controller, deletes };
  }

  it('refuses «Удалить» on a device of a subscription whose stored id is a 2.x uuid, and asks the panel nothing', async () => {
    const { controller, deletes } = deviceRevoker('f47ac10b-58cc-4372-a567-0e02b2c3d479');

    const failure = await captureRejection(() =>
      controller.revokeDevice('subscription-1', 'hwid-1', ACTING_ADMIN, ACTING_REQUEST),
    );

    assert.equal(failure instanceof ConflictException, true, String(failure));
    assert.deepStrictEqual((failure as ConflictException).getResponse(), staleDeviceDeleteRefusalBody('operator'));
    assert.equal(
      ((failure as ConflictException).getResponse() as { code: string }).code,
      SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE,
    );
    assert.deepStrictEqual(deletes, [], 'the device was not unbound from anybody');
  });

  it('control: a decimal link reaches the panel through the same handler', async () => {
    const { controller, deletes } = deviceRevoker('4471');

    const result = await controller.revokeDevice('subscription-1', 'hwid-1', ACTING_ADMIN, ACTING_REQUEST);

    assert.deepStrictEqual(result, { revoked: true, remainingDevices: 1 });
    assert.equal(deletes.length, 1);
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

/**
 * The `message` the admin API actually sends for a refusal. The safe filter
 * replaces a 4xx message that trips any of its patterns — the word "profile"
 * among them — with a generic one, so a refusal written for the operator has
 * to be checked THROUGH it, not only where it is thrown.
 */
function sentToOperator(exception: unknown): unknown {
  let body: { message?: unknown } = {};
  const response = {
    status: () => response,
    json: (sent: { message?: unknown }) => {
      body = sent;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ originalUrl: '/api/admin/users/subscriptions/legacy-subscription/remnawave-link', headers: {} }),
      getResponse: () => response,
    }),
  };
  new AdminSafeExceptionFilter().catch(exception, host as never);
  return body.message;
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
    const db = {
      subscription: {
        findUnique: async () => row,
        update: async (input: unknown) => { updates.push(input); return {}; },
      },
      // The audit sink these routes now write to. Inert here: what these
      // cases are about is what the panel refresh adopts, and the operator
      // trail has its own coverage.
      adminAuditLog: { create: async () => ({}) },
      // The refresh writes in a transaction, beside the term alignment an
      // adopted expiry needs (a no-op here: nothing is in the term model).
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(db),
    };
    const controller = new AdminUserSubscriptionsController(
      db as never,
      { getPanelUserOutcome: async () => { panelReads.push('read'); return outcome; } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      NOT_IN_TERM_MODEL as never,
    );
    return { controller, updates, panelReads };
  }

  it('says the panel could not be reached, and writes nothing', async () => {
    // The old code answered "Profile not found on panel" for an outage, an
    // expired token, a 5xx and a timeout alike — and "gone" is what makes an
    // operator start repairing a link that was never broken.
    const { controller, updates } = build({ kind: 'unavailable' });
    const result = await controller.syncSubscription('sub-1', ACTING_ADMIN, ACTING_REQUEST);
    assert.equal(result.synced, false);
    assert.match(String(result.message), /could not be reached/i);
    // And specifically NOT the missing-profile wording — that is the sentence
    // that sends an operator off to repair a link that was never broken.
    assert.equal(/not found/i.test(String(result.message)), false, String(result.message));
    assert.deepEqual(updates, [], 'a read that failed must not write an expiry');
  });

  it('still reports a genuinely missing profile as missing', async () => {
    const { controller, updates } = build({ kind: 'missing' });
    const result = await controller.syncSubscription('sub-1', ACTING_ADMIN, ACTING_REQUEST);
    assert.equal(result.synced, false);
    assert.equal(result.message, 'Profile not found on panel');
    assert.deepEqual(updates, []);
  });

  it('syncs from the panel row when the read succeeds', async () => {
    const { controller, updates } = build({ kind: 'ok', user: syncedPanelProfile() });
    const result = await controller.syncSubscription('sub-1', ACTING_ADMIN, ACTING_REQUEST);
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

      const result = await controller.syncSubscription('sub-1', ACTING_ADMIN, ACTING_REQUEST);
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
    // An ordinary far date. Not 2099: a profile in 2099 has no end
    // (`panel-expiry.ts`), which the refresh does not copy as a date.
    expireAt: '2098-01-01T00:00:00.000Z',
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
  const db = {
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
    // The audit sink the refresh now writes to. Inert here: these cases are
    // about which columns a refresh adopts, and the operator trail has its
    // own coverage.
    adminAuditLog: { create: async () => ({}) },
    // The refresh writes in a transaction, beside the term alignment an
    // adopted expiry needs (a no-op here: nothing is in the term model).
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(db),
  };
  const controller = new AdminUserSubscriptionsController(
    db as never,
    { getPanelUserOutcome: async () => options.outcome } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    NOT_IN_TERM_MODEL as never,
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

    const result = await controller.syncSubscription('sub-1', ACTING_ADMIN, ACTING_REQUEST);

    assert.equal(result.synced, true);
    assert.deepEqual(result.refreshed, {
      configUrl: 'https://panel.example.test/sub/fresh',
      remnawavePanelId: 4471,
      remnawavePanelUsername: 'rz_bob_1',
      expiresAt: new Date('2098-01-01T00:00:00.000Z'),
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

    await controller.syncSubscription('sub-1', ACTING_ADMIN, ACTING_REQUEST);

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

    await controller.syncSubscription('sub-1', ACTING_ADMIN, ACTING_REQUEST);

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

    const result = await controller.syncSubscription('sub-1', ACTING_ADMIN, ACTING_REQUEST);

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

    const result = await controller.syncSubscription('sub-1', ACTING_ADMIN, ACTING_REQUEST);

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
        user: syncedPanelProfile({ expireAt: '2098-01-01T00:00:00.000Z' }),
      },
    });

    const result = await controller.syncSubscription('sub-1', ACTING_ADMIN, ACTING_REQUEST);

    assert.deepEqual(stored.expiresAt, new Date('2098-01-01T00:00:00.000Z'));
    assert.deepEqual(result.refreshed?.expiresAt, new Date('2098-01-01T00:00:00.000Z'));
  });

  it('copies no date from a profile with no end: 2099 is Remnawave’s «for ever»', async () => {
    const { controller, stored } = syncOver({
      outcome: {
        kind: 'ok',
        user: syncedPanelProfile({ expireAt: '2099-12-31T00:00:00.000Z' }),
      },
    });

    const result = await controller.syncSubscription('sub-1', ACTING_ADMIN, ACTING_REQUEST);

    assert.equal('expiresAt' in (result.refreshed ?? {}), false);
    assert.deepEqual(stored.expiresAt, new Date('2027-03-01T00:00:00.000Z'), 'the row keeps the date it was sold');
  });

  it('writes no date over a subscription with no end: the thirty days an older CREATE gave its profile are not its own', async () => {
    const { controller, stored } = syncOver({
      outcome: {
        kind: 'ok',
        user: syncedPanelProfile({ expireAt: '2026-10-24T00:00:00.000Z' }),
      },
      stored: { expiresAt: null },
    });

    const result = await controller.syncSubscription('sub-1', ACTING_ADMIN, ACTING_REQUEST);

    assert.equal(result.synced, true);
    assert.equal('expiresAt' in (result.refreshed ?? {}), false);
    assert.equal(stored.expiresAt, null, 'still sold for ever');
    assert.equal(stored.configUrl, 'https://panel.example.test/sub/fresh', 'the rest is refreshed as before');
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

  const settings: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];

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
          // Captured, not ignored: this is where the route tells the trigger
          // WHO moved the device limit, and the whole anti-fraud excuse for an
          // operator-set limit hangs off it arriving.
          $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            settings.push({ sql: strings.join('?'), values });
            return 1;
          },
          // A plan assignment re-reads the row under its lock to carry what it
          // holds above its old plan (`resolvePlanChangeLimitCarryInTransaction`).
          $queryRaw: async () => [{ id: row.id }],
          subscription: {
            findUnique: async () => row,
            update: async (input: unknown) => applyUpdate(input, txUpdates),
          },
          subscriptionEffectiveProjection: { findUnique: async () => null },
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
    NOT_IN_TERM_MODEL as never,
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
    get settings() {
      return settings;
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

  it('tells the trigger that a human set the device limit', async () => {
    // WHY THE ROUTE SAYS ANYTHING AT ALL. `sharing-detectors.ts` refuses to
    // excuse a device overage when the limit was reduced FROM "unlimited",
    // because `0` is the column default and the "never synced" value as much
    // as it is unlimited — one importer sweep writing `0 → N` would otherwise
    // hand the entire customer base a fortnight of silence.
    //
    // That refusal is about a downgrade the CUSTOMER chose. This route is a
    // human typing a number, and the devices the customer already held were
    // not an overage until they typed it. The provenance is the only thing
    // that tells the two apart, and it travels in a transaction-local setting
    // the stamping trigger copies.
    const harness = editorHarness();

    await harness.controller.updateSubscription(
      'sub-1',
      { deviceLimit: 2 },
      ACTING_ADMIN,
      ACTING_REQUEST,
    );

    assert.equal(harness.settings.length, 1, 'the trigger was told nothing');
    const [setting] = harness.settings;
    assert.match(setting.sql, /set_config\('rezeis\.device_limit_source'/);
    assert.deepStrictEqual(setting.values, [OPERATOR_LIMIT_SOURCE]);
    // Transaction-local. A `false` here leaves the value set on a pooled
    // connection, and the NEXT writer of any subscription's device limit —
    // an importer sweep, a renewal — inherits it and is excused as if an
    // operator had typed it.
    assert.match(setting.sql, /,\s*true\)/);
  });

  it('names the setting the trigger in the migration actually reads', () => {
    // The one half of this agreement that CAN drift. The token is a shared
    // constant, so the route and the detector cannot disagree about it — but
    // the GUC name is a string in the route and a string in SQL, and a rename
    // on either side leaves both halves working and nothing attributed. The
    // failure is silent in the only direction that matters: every operator-set
    // limit quietly stops being excused.
    const migration = readFileSync(
      join(process.cwd(), 'prisma', 'migrations',
        '20260907090000_device_limit_reduction_provenance', 'migration.sql'),
      'utf8',
    );
    const route = readFileSync(
      join(process.cwd(), 'src', 'modules', 'users', 'controllers',
        'admin-user-subscriptions.controller.ts'),
      'utf8',
    );
    const named = /current_setting\('([^']+)'/.exec(migration);
    assert.notEqual(named, null, 'the trigger reads no setting at all');
    assert.ok(
      route.includes(`set_config('${(named as RegExpExecArray)[1]}'`),
      `the route sets a different setting than the trigger reads: ${(named as RegExpExecArray)[1]}`,
    );
  });

  it('says nothing when the edit does not touch the device limit', async () => {
    // A traffic edit is not a device-limit change, the trigger will not fire,
    // and a setting left behind by an unrelated edit is how provenance starts
    // describing a reduction nobody made.
    const harness = editorHarness();

    await harness.controller.updateSubscription(
      'sub-1',
      { trafficLimit: 500 },
      ACTING_ADMIN,
      ACTING_REQUEST,
    );

    assert.deepStrictEqual(harness.settings, []);
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
