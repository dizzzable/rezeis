import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { PromocodeAvailability, PromocodeRewardType } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { PromocodePlanSnapshotDto } from '../src/modules/promocodes/dto/promocode-plan-snapshot.dto';
import { PromocodeInterface } from '../src/modules/promocodes/interfaces/promocode.interface';
import { PromocodeRewardsService } from '../src/modules/promocodes/services/promocode-rewards.service';
import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';

/**
 * A ZERO-GIGABYTE SUBSCRIPTION IS NOT REPRESENTABLE, SO NOTHING MAY MINT ONE.
 *
 * `Subscription.trafficLimit` counts whole gigabytes and `null` is unlimited,
 * which leaves `0` meaning what it says: no traffic at all. Remnawave cannot
 * say that. Its `0` IS unlimited — there is no encoding for "zero bytes
 * allowed" anywhere in the protocol — so a local `0` fails in both directions
 * of the same round trip:
 *
 *   OUTBOUND  `profile-sync.processor.ts` (CREATE and UPDATE) and the
 *             desired-state PATCH all send `(trafficLimit ?? 0) * 1024 ** 3`.
 *             The `0` goes up as `0` bytes and the panel reads UNLIMITED. The
 *             customer the row says may move nothing is uncapped upstream.
 *
 *   INBOUND   the panel answers `0`, which decodes back to `null`. A
 *             projection with `desiredTrafficLimitBytes = 0n` therefore never
 *             matches what it just sent — `bigintEq(null, 0n)` is false — so it
 *             is never stamped APPLIED and the job reports drift FOREVER, on
 *             every sweep, for the life of the subscription.
 *
 * These specs cover the two writers that could hand-set the value. They are not
 * the same kind of gate and both are load-bearing:
 *
 *   1. the promocode plan snapshot, which had `@Min(0)` while both real plan
 *      DTOs had `@Min(1)`, and whose value is copied VERBATIM into the row;
 *   2. the admin subscription editor, which has no DTO at all — its `@Body()`
 *      is `Record<string, unknown>`, a native metatype the global
 *      `ValidationPipe` skips entirely, so `Number(body.trafficLimit)` was the
 *      whole of its validation.
 *
 * THE ASYMMETRY IS ASSERTED TOO. `deviceLimit: 0` must keep meaning UNLIMITED
 * on both paths. A "consistency" pass that raised both floors together would
 * silently rewrite every unlimited-device row, so the specs that keep `0` legal
 * for devices sit right beside the ones that outlaw it for traffic.
 */

// ── 1. The promocode plan snapshot ─────────────────────────────────────────

/** A snapshot that is valid in every field except the one under test. */
function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'plan-1',
    name: 'Premium',
    type: 'BOTH',
    trafficLimit: 100,
    deviceLimit: 5,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: ['squad-a'],
    ...overrides,
  };
}

async function validationErrors(raw: Record<string, unknown>) {
  return validate(plainToInstance(PromocodePlanSnapshotDto, raw));
}

describe('the promocode plan snapshot cannot carry a zero-gigabyte traffic limit', () => {
  it('accepts a snapshot that is valid throughout', async () => {
    // THE ANCHOR. Without it every rejection below could be passing on some
    // unrelated missing field, and the specs would score a catch for nothing.
    assert.deepStrictEqual(await validationErrors(snapshot()), []);
  });

  it('rejects trafficLimit: 0', async () => {
    const errors = await validationErrors(snapshot({ trafficLimit: 0 }));

    const trafficError = errors.find((error) => error.property === 'trafficLimit');
    assert.notEqual(trafficError, undefined, 'trafficLimit: 0 was accepted');
    // The specific constraint, so a rejection that started coming from
    // `@IsInt()` or a stray `@IsPositive()` does not read as this gate holding.
    assert.equal('min' in (trafficError?.constraints ?? {}), true);
  });

  it('rejects a negative traffic limit', async () => {
    const errors = await validationErrors(snapshot({ trafficLimit: -5 }));

    assert.notEqual(
      errors.find((error) => error.property === 'trafficLimit'),
      undefined,
    );
  });

  it('still accepts the smallest expressible cap', async () => {
    // The floor is at 1, not "any positive number": the column is whole
    // gigabytes and the shared converter already floors panel readings here.
    assert.deepStrictEqual(await validationErrors(snapshot({ trafficLimit: 1 })), []);
  });

  it('leaves unlimited expressible, as null and as absence', async () => {
    // Refusing `0` must not cost the snapshot its way of saying "no cap".
    assert.deepStrictEqual(await validationErrors(snapshot({ trafficLimit: null })), []);

    const withoutKey = snapshot();
    delete withoutKey.trafficLimit;
    assert.deepStrictEqual(await validationErrors(withoutKey), []);
  });

  it('keeps deviceLimit: 0 legal, because there 0 IS unlimited', async () => {
    // The anti-harmonisation guard. `deviceLimit <= 0` is the product's
    // canonical unlimited and matches the panel's own `hwidDeviceLimit: 0`.
    // Same digit, opposite meaning, one field apart.
    assert.deepStrictEqual(await validationErrors(snapshot({ deviceLimit: 0 })), []);
  });
});

// ── 2. What the promocode reward does with the snapshot it is given ────────

function buildPromocode(plan: PromocodeInterface['plan']): PromocodeInterface {
  return {
    id: 'promo-1',
    code: 'PROMO',
    isActive: true,
    availability: PromocodeAvailability.ALL,
    rewardType: PromocodeRewardType.SUBSCRIPTION,
    // Mirrors the legacy reward, which is exactly what the mapper produces
    // for a code with no rows in `promocode_actions` — every code written by
    // an older panel, and everything a donor import writes.
    actions: [
      {
        type: PromocodeRewardType.SUBSCRIPTION,
        value: null,
        plan: null,
        discountAllowedPlanIds: [],
        discountValidForDays: null,
      },
    ],
    reward: null,
    plan,
    lifetime: null,
    expiresAt: null,
    maxActivations: null,
    allowedTelegramIds: [],
    allowedPlanIds: [],
    activationsCount: 0,
    createdAt: '2026-04-20T10:00:00.000Z',
    updatedAt: '2026-04-20T10:00:00.000Z',
  };
}

async function mintFromPromocode(trafficLimit: number | null): Promise<number | null | undefined> {
  const createCalls: Array<{ data: { trafficLimit?: number | null } }> = [];
  const service = new PromocodeRewardsService();

  await service.applyReward({
    transactionClient: {
      subscription: {
        create: async (args: { data: { trafficLimit?: number | null } }) => {
          createCalls.push(args);
          return { id: 'new-sub-1' };
        },
      },
      user: { updateMany: async () => ({ count: 1 }) },
      profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
    } as never,
    promocode: buildPromocode({
      id: 'plan-1',
      name: 'Premium',
      type: 'BOTH',
      trafficLimit,
      deviceLimit: 5,
      trafficLimitStrategy: 'NO_RESET',
      internalSquads: ['squad-a'],
      externalSquad: null,
      duration: 30,
    }),
    userId: 'user-1',
    targetSubscriptionId: null,
  });

  assert.equal(createCalls.length, 1, 'no subscription was created');
  return createCalls[0]?.data.trafficLimit;
}

describe('a promocode-granted subscription takes its snapshot verbatim', () => {
  it('copies a real cap through unchanged', async () => {
    // WHY THIS MATTERS FOR THE GATE ABOVE. The reward does not re-derive,
    // clamp or convert anything — `trafficLimit: plan.trafficLimit ?? null` is
    // the whole of it. So the snapshot validator is the ONLY thing between an
    // operator's number and the column, which is what makes `@Min(1)` there
    // load-bearing rather than cosmetic.
    assert.equal(await mintFromPromocode(50), 50);
  });

  it('copies unlimited through as unlimited', async () => {
    assert.equal(await mintFromPromocode(null), null);
  });
});

// ── 3. The admin subscription editor — the route with no DTO ──────────────

const ACTING_ADMIN = { id: 'admin-1' } as never;

const ACTING_REQUEST = {
  headers: { 'x-request-id': 'req-1', 'user-agent': 'node:test' },
  ip: '10.0.0.7',
  socket: { remoteAddress: null },
} as never;

function buildEditor(): {
  readonly controller: AdminUserSubscriptionsController;
  readonly updates: Array<Record<string, unknown>>;
} {
  const updates: Array<Record<string, unknown>> = [];
  const controller = new AdminUserSubscriptionsController(
    {
      subscription: {
        findUnique: async () => ({
          id: 'sub-1',
          userId: 'user-1',
          // Deliberately NOT the value any spec below writes, so the audit
          // diff is non-empty and that path is exercised rather than skipped.
          trafficLimit: 10,
          deviceLimit: 3,
          internalSquads: [],
          externalSquad: null,
          remnawaveId: null,
          remnawavePanelUsername: 'rz_test_1',
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        }),
      },
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          subscription: {
            update: async ({ data }: { data: Record<string, unknown> }) => {
              updates.push(data);
              return { id: 'sub-1', remnawaveId: null };
            },
          },
          profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
        }),
      adminAuditLog: { create: async () => ({}) },
    } as never,
    {} as never,
    { enqueue: async () => undefined } as never,
    { warn: () => undefined } as never,
    {} as never,
    {} as never,
  );
  return { controller, updates };
}

function editSubscription(
  controller: AdminUserSubscriptionsController,
  body: Record<string, unknown>,
) {
  return controller.updateSubscription('sub-1', body, ACTING_ADMIN, ACTING_REQUEST);
}

describe('the admin subscription editor refuses an unrepresentable traffic limit', () => {
  it('writes an ordinary cap, so the refusals below are not a dead endpoint', async () => {
    // THE ANCHOR again. An endpoint that threw on everything would satisfy
    // every rejection spec in this block.
    const { controller, updates } = buildEditor();

    await editSubscription(controller, { trafficLimit: 50 });

    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.trafficLimit, 50);
  });

  it('refuses trafficLimit: 0 instead of storing it', async () => {
    const { controller, updates } = buildEditor();

    await assert.rejects(
      editSubscription(controller, { trafficLimit: 0 }),
      (error: unknown) => error instanceof BadRequestException,
    );
    // Refused BEFORE the write, not refused after a partial one.
    assert.equal(updates.length, 0);
  });

  it('refuses the empty string, which Number() used to turn into 0', async () => {
    // `Number('')`, `Number(null)`, `Number(false)` and `Number([])` are all
    // `0`. The editor's field is a text input, so the empty string is the one
    // an operator can actually produce.
    const { controller, updates } = buildEditor();

    await assert.rejects(
      editSubscription(controller, { trafficLimit: '' }),
      (error: unknown) => error instanceof BadRequestException,
    );
    assert.equal(updates.length, 0);
  });

  it('refuses a negative cap', async () => {
    const { controller, updates } = buildEditor();

    await assert.rejects(
      editSubscription(controller, { trafficLimit: -5 }),
      (error: unknown) => error instanceof BadRequestException,
    );
    assert.equal(updates.length, 0);
  });

  it('refuses a non-numeric cap as a 400 rather than letting NaN reach Prisma', async () => {
    const { controller, updates } = buildEditor();

    await assert.rejects(
      editSubscription(controller, { trafficLimit: 'abc' }),
      (error: unknown) => error instanceof BadRequestException,
    );
    assert.equal(updates.length, 0);
  });

  it('accepts null as unlimited, which is how this endpoint says it at all', async () => {
    // Before the gate, `Number(null)` was `0` — so the payload that most
    // plainly means "no cap" was the very one that minted the unrepresentable
    // value. Unlimited has to remain sayable, or the refusal above just
    // removes a capability.
    const { controller, updates } = buildEditor();

    await editSubscription(controller, { trafficLimit: null });

    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.trafficLimit, null);
  });

  it('still accepts a numeric string, which the editor sends', async () => {
    const { controller, updates } = buildEditor();

    await editSubscription(controller, { trafficLimit: '50' });

    assert.equal(updates[0]?.trafficLimit, 50);
  });

  it('leaves deviceLimit: 0 alone, because there 0 IS unlimited', async () => {
    // The asymmetry, at the other writer. One line below the traffic gate in
    // the controller, `deviceLimit` keeps its bare `Number(...)` on purpose.
    const { controller, updates } = buildEditor();

    await editSubscription(controller, { deviceLimit: 0 });

    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.deviceLimit, 0);
  });
});
