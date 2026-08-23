import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  AdminAddOnCreateDto,
  AdminAddOnUpdateDto,
} from '../src/modules/add-ons/dto/admin-add-on.dto';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';

/**
 * A ZERO-GIGABYTE SUBSCRIPTION IS NOT REPRESENTABLE — THE ADD-ON ENTRY POINTS.
 *
 * `Subscription.trafficLimit` counts whole gigabytes and `null` is unlimited,
 * which leaves `0` meaning "no traffic at all". Remnawave cannot say that: its
 * `0` IS unlimited, so an outbound `0` uncaps the customer upstream and an
 * inbound `0` decodes back to `null`, which never matches a stored `0n` and so
 * reports drift on every sweep forever. "May move no traffic" is
 * `status: DISABLED`, which the panel can express.
 *
 * `test/subscription-zero-traffic-limit.spec.ts` covers the two hand-setting
 * writers (the promocode plan snapshot and the admin subscription editor).
 * These are the three ways an ADD-ON could still mint one:
 *
 *   1. `AddOn.value` was `@IsNumber()` with no bound, so a NEGATIVE
 *      EXTRA_TRAFFIC value was an authorable product.
 *   2. the legacy increment in `PaymentSubscriptionMutationService` applied
 *      that value to the raw column, guarded only against `trafficLimit ===
 *      null` — so `100 + (-100)` landed on exactly `0`. The device branch eight
 *      lines below already had an explicit guard naming the legacy `0 + N`
 *      footgun; traffic never got the equivalent.
 *   3. the paid-renewal snapshot validator accepted `trafficLimit >= 0` and
 *      then cast it straight onto `Plan.trafficLimit`, from where the renewal
 *      writes it into the subscription column.
 *
 * THE ASYMMETRY IS ASSERTED TOO. `deviceLimit: 0` must keep meaning UNLIMITED,
 * so the cases that outlaw `0` for traffic sit beside the ones that keep it
 * legal for devices. Each guard also has a case in the OTHER direction — a
 * guard that refuses everything is as wrong as one that refuses nothing, and
 * only the pair pins the behaviour.
 */

// ── 1. The catalog row: an add-on value is whole and positive ──────────────

/** A create payload valid in every field except the one under test. */
function createPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Extra 50GB',
    type: 'EXTRA_TRAFFIC',
    value: 50,
    prices: [{ currency: 'USD', price: '2.50' }],
    ...overrides,
  };
}

async function createErrors(overrides: Record<string, unknown> = {}) {
  return validate(plainToInstance(AdminAddOnCreateDto, createPayload(overrides)));
}

async function updateErrors(overrides: Record<string, unknown> = {}) {
  return validate(plainToInstance(AdminAddOnUpdateDto, { ...overrides }));
}

/** The names of the constraints that rejected `value`, for a readable failure. */
function valueConstraints(errors: readonly { property: string; constraints?: object }[]): string[] {
  const row = errors.find((error) => error.property === 'value');
  return row === undefined ? [] : Object.keys(row.constraints ?? {});
}

describe('an add-on value is a whole, positive number of units', () => {
  it('accepts an ordinary catalog row, so the refusals below are not a dead DTO', async () => {
    assert.deepEqual(await createErrors(), []);
  });

  it('accepts 1, the smallest coherent product', async () => {
    assert.deepEqual(await createErrors({ value: 1 }), []);
  });

  it('rejects value: 0 — an add-on that adds nothing is not a product', async () => {
    assert.ok(
      valueConstraints(await createErrors({ value: 0 })).includes('min'),
      'a zero-unit add-on must be refused at authoring time',
    );
  });

  it('rejects a negative value, which is what could drive a traffic column to 0', async () => {
    assert.ok(
      valueConstraints(await createErrors({ value: -100 })).includes('min'),
      'a negative EXTRA_TRAFFIC value applied to a 100 GB column lands on exactly 0, ' +
        'and the panel decodes a 0 traffic limit back to UNLIMITED',
    );
  });

  it('rejects a fractional value, which BigInt() cannot convert at all', async () => {
    assert.ok(
      valueConstraints(await createErrors({ value: 2.5 })).includes('isInt'),
      'a fractional value throws a raw RangeError inside the ledger money transaction',
    );
  });

  it('applies the same bound on update, and still lets the field be omitted', async () => {
    assert.deepEqual(await updateErrors({ name: 'Renamed' }), [], 'value stays optional on update');
    assert.deepEqual(await updateErrors({ value: 1 }), []);
    assert.ok(valueConstraints(await updateErrors({ value: 0 })).includes('min'));
    assert.ok(valueConstraints(await updateErrors({ value: -1 })).includes('min'));
    assert.ok(valueConstraints(await updateErrors({ value: 0.5 })).includes('isInt'));
  });
});

// ── 2. The legacy increment: the last place a raw column is written ────────

const ORIGINAL_DIRECT_PURCHASE = process.env['ADDON_ENTITLEMENT_DIRECT_PURCHASE'];
afterEach(() => {
  if (ORIGINAL_DIRECT_PURCHASE === undefined) delete process.env['ADDON_ENTITLEMENT_DIRECT_PURCHASE'];
  else process.env['ADDON_ENTITLEMENT_DIRECT_PURCHASE'] = ORIGINAL_DIRECT_PURCHASE;
});

/**
 * Drives the REAL `applyAddOnTopUp` with the direct-purchase rollout flag OFF,
 * which is its default and which sends every capture down the legacy increment.
 */
function legacyTopUpEnv(input: {
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly addOnType: 'EXTRA_TRAFFIC' | 'EXTRA_DEVICES';
  readonly addOnValue: number;
  /**
   * Turn the direct-purchase rollout flag ON and give the target an ACTIVE
   * durable term, which sends the capture through `applyAddOnViaLedger` first.
   * An incoherent value has to be refused there too — `BigInt()` throws a raw
   * `RangeError` on a fractional one — and refusing means falling back to this
   * same legacy branch, so the outcome stays one shape.
   */
  readonly viaLedger?: boolean;
}) {
  if (input.viaLedger === true) process.env['ADDON_ENTITLEMENT_DIRECT_PURCHASE'] = 'true';
  else delete process.env['ADDON_ENTITLEMENT_DIRECT_PURCHASE'];

  const subUpdates: Array<Record<string, unknown>> = [];
  const transactionWrites: Array<Record<string, unknown>> = [];
  const entitlementsCreated: Array<Record<string, unknown>> = [];
  const staged: Record<string, unknown> = {
    id: 'sub-1',
    userId: 'user-1',
    status: 'ACTIVE',
    remnawaveId: 'rw-1',
    planSnapshot: {},
    trafficLimit: input.trafficLimit,
    deviceLimit: input.deviceLimit,
  };

  const prismaService = {
    transactionItem: { findMany: async () => [] },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        subscription: {
          findUnique: async () => ({ ...staged }),
          update: async ({ data }: { data: Record<string, unknown> }) => {
            subUpdates.push(data);
            // Mirror what Prisma would do for `{ increment }` so the committed
            // column is a real number and not the operation object.
            for (const [key, value] of Object.entries(data)) {
              const increment = (value as { increment?: number } | null)?.increment;
              staged[key] = increment === undefined ? value : (staged[key] as number) + increment;
            }
            return { ...staged };
          },
        },
        subscriptionTerm: {
          findFirst: async () => ({
            id: 'term-active',
            endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            baseTrafficLimitBytes: 100n * 1024n * 1024n * 1024n,
            baseDeviceLimit: 3,
            trafficResetStrategy: 'NO_RESET',
            resetAnchorAt: new Date('2026-01-01T00:00:00.000Z'),
          }),
        },
        subscriptionEffectiveProjection: { findUnique: async () => null },
        profileSyncJob: { create: async ({ data }: { data: object }) => ({ id: 'job-1', ...data }) },
        transaction: {
          update: async ({ data }: { data: Record<string, unknown> }) => {
            transactionWrites.push(data);
            return {};
          },
        },
      }),
  };

  const entitlements = {
    createPendingInTransaction: async (_tx: unknown, created: Record<string, unknown>) => {
      entitlementsCreated.push(created);
      return { entitlementId: 'ent-1', state: 'PENDING_ACTIVATION', created: true, eventId: 'ev' };
    },
    transitionInTransaction: async () => ({ entitlementId: 'ent-1', state: 'ACTIVE', changed: true, eventId: 'ev2' }),
  };
  const projections = {
    recomputeInTransaction: async () => ({
      desiredRevision: 1n,
      desiredTrafficLimitBytes: 150n * 1024n * 1024n * 1024n,
      desiredDeviceLimit: 5,
    }),
  };

  const service = new PaymentSubscriptionMutationService(
    prismaService as never,
    { info: () => undefined } as never,
    entitlements as never,
    projections as never,
    {} as never,
  );

  const transaction = {
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    subscriptionId: null,
    purchaseType: 'ADDITIONAL',
    gatewayType: 'YOOKASSA',
    currency: 'USD',
    amount: { toString: () => '2.50' },
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    planSnapshot: {
      snapshotSource: 'ADDON_PURCHASE',
      addOnId: 'addon-1',
      addOnType: input.addOnType,
      addOnValue: input.addOnValue,
      name: 'Extra',
      targetSubscriptionId: 'sub-1',
      // The two fields `applyAddOnViaLedger` requires before it will engage.
      lifetime: 'UNTIL_SUBSCRIPTION_END',
      sourceLineKey: 'addon-1',
    },
  };

  return { service, transaction, subUpdates, transactionWrites, entitlementsCreated, committed: staged };
}

describe('the legacy add-on increment cannot land a traffic column on zero', () => {
  it('still raises an ordinary cap, so the refusals below are not a dead branch', async () => {
    const env = legacyTopUpEnv({
      trafficLimit: 100,
      deviceLimit: 3,
      addOnType: 'EXTRA_TRAFFIC',
      addOnValue: 50,
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.subUpdates.length, 1, 'a coherent add-on must still be applied');
    assert.equal(env.committed['trafficLimit'], 150);
  });

  it('refuses a negative traffic value instead of writing 0 to the column', async () => {
    // 100 + (-100) = 0. The row would then say "may move no traffic" while the
    // panel, which has no encoding for zero bytes, hands the customer an
    // UNLIMITED profile — and the projection reports drift forever after.
    const env = legacyTopUpEnv({
      trafficLimit: 100,
      deviceLimit: 3,
      addOnType: 'EXTRA_TRAFFIC',
      addOnValue: -100,
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(
      env.subUpdates.length,
      0,
      'an incoherent add-on value must leave the limit column untouched, not write a 0',
    );
    assert.equal(env.committed['trafficLimit'], 100, 'the customer keeps the cap they had');
    assert.ok(
      env.transactionWrites.some((write) => write['fulfilledAt'] !== undefined),
      'fulfillment is still stamped so the webhook does not re-process the payment forever',
    );
  });

  it('refuses a fractional traffic value rather than letting it reach the column', async () => {
    const env = legacyTopUpEnv({
      trafficLimit: 100,
      deviceLimit: 3,
      addOnType: 'EXTRA_TRAFFIC',
      addOnValue: 2.5,
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.subUpdates.length, 0);
    assert.equal(env.committed['trafficLimit'], 100);
  });

  it('refuses a negative device value, the mirror of the same footgun', async () => {
    // 3 + (-3) = 0, and `deviceLimit <= 0` is the product's canonical UNLIMITED:
    // a finite profile would silently become uncapped.
    const env = legacyTopUpEnv({
      trafficLimit: 100,
      deviceLimit: 3,
      addOnType: 'EXTRA_DEVICES',
      addOnValue: -3,
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.subUpdates.length, 0);
    assert.equal(env.committed['deviceLimit'], 3);
  });

  it('leaves an unlimited traffic row alone rather than making it finite', async () => {
    const env = legacyTopUpEnv({
      trafficLimit: null,
      deviceLimit: 3,
      addOnType: 'EXTRA_TRAFFIC',
      addOnValue: 50,
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.subUpdates.length, 0);
    assert.equal(env.committed['trafficLimit'], null);
  });

  it('refuses an incoherent value on the LEDGER path too, before BigInt() can throw', async () => {
    // With direct purchase on, the capture reaches `applyAddOnViaLedger` first,
    // where `BigInt(2.5)` throws a raw RangeError inside the money transaction
    // and `BigInt(-50)` mints a negative `totalValue` the projection rejects
    // deep inside a recompute. It has to refuse before either.
    const env = legacyTopUpEnv({
      trafficLimit: 100,
      deviceLimit: 3,
      addOnType: 'EXTRA_TRAFFIC',
      addOnValue: 2.5,
      viaLedger: true,
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.entitlementsCreated.length, 0, 'no ledger row may be minted from an incoherent value');
    assert.equal(env.subUpdates.length, 0);
    assert.equal(env.committed['trafficLimit'], 100);
  });

  it('still captures a coherent value on the LEDGER path (the other direction)', async () => {
    const env = legacyTopUpEnv({
      trafficLimit: 100,
      deviceLimit: 3,
      addOnType: 'EXTRA_TRAFFIC',
      addOnValue: 50,
      viaLedger: true,
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(
      env.entitlementsCreated.length,
      1,
      'refusing every value would withhold paid goods just as badly as accepting a broken one',
    );
  });

  it('keeps deviceLimit 0 meaning unlimited, so a device add-on is a no-op there', async () => {
    const env = legacyTopUpEnv({
      trafficLimit: 100,
      deviceLimit: 0,
      addOnType: 'EXTRA_DEVICES',
      addOnValue: 2,
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.subUpdates.length, 0, '0 + 2 must not turn an unlimited profile finite');
    assert.equal(env.committed['deviceLimit'], 0);
  });
});

// ── 3. The paid-renewal snapshot validator ─────────────────────────────────

/** Drives the REAL `applyCombinedRenewal` over one paid item. */
function renewalSnapshotEnv(planTrafficLimit: number | null) {
  const currentExpiry = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  const subUpdates: Array<Record<string, unknown>> = [];
  const appliedItems: string[] = [];
  const staged: Record<string, unknown> = {
    id: 'sub-1',
    status: 'ACTIVE',
    isTrial: false,
    expiresAt: currentExpiry,
    remnawaveId: 'rw-1',
    trafficLimit: 100,
    deviceLimit: 3,
    internalSquads: [],
    externalSquad: null,
    // All four inherited keys present and equal to the columns, so every one of
    // them reads as INHERITED and the paid plan's values really are applied.
    // A snapshot without them is UNDECIDABLE, the renewal PRESERVES the columns
    // (see `resolveInheritedPlanLimitUpdate`), and these cases would then pass
    // without the validator's answer reaching the subscription at all.
    planSnapshot: {
      id: 'plan-1',
      trafficLimit: 100,
      deviceLimit: 3,
      internalSquads: [],
      externalSquad: null,
    },
  };

  const item = {
    id: 'it-1',
    subscriptionId: 'sub-1',
    planId: 'plan-1',
    durationDays: 30,
    appliedAt: null,
    amount: '10',
    currency: 'USD',
    addOnLines: null,
    planSnapshot: {
      snapshotVersion: 1,
      snapshotSource: 'RENEWAL_DRAFT',
      purchaseType: 'RENEW',
      id: 'plan-1',
      name: 'P',
      description: null,
      tag: null,
      type: 'BOTH',
      trafficLimit: planTrafficLimit,
      deviceLimit: 1,
      trafficLimitStrategy: 'NO_RESET',
      internalSquads: [],
      externalSquad: null,
      selectedDurationDays: 30,
      gatewayType: 'YOOKASSA',
      amount: '10',
      currency: 'USD',
    },
  };

  const prismaService = {
    transactionItem: { findMany: async () => [item] },
    user: { updateMany: async () => ({ count: 0 }) },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        $queryRaw: async () => [{ id: 'sub-1', status: 'ACTIVE' }],
        subscriptionTerm: { findFirst: async () => null },
        plan: { findUnique: async () => null },
        subscription: {
          findUnique: async () => ({ ...staged }),
          update: async ({ data }: { data: Record<string, unknown> }) => {
            subUpdates.push(data);
            Object.assign(staged, data);
            return { ...staged };
          },
        },
        // No projection row: this subscription holds no add-on, so the recorded
        // contribution the renewal subtracts before comparing a column with the
        // stored snapshot is zero. Reading it is not optional — the renewal asks
        // every time, because a hard zero where a row might exist is a second,
        // divergent derivation of the baseline.
        subscriptionEffectiveProjection: { findUnique: async () => null },
        profileSyncJob: { create: async ({ data }: { data: object }) => ({ id: 'job-1', ...data }) },
        transactionItem: {
          updateMany: async ({ where }: { where: { id: string } }) => {
            appliedItems.push(where.id);
            return { count: 1 };
          },
          findUnique: async () => ({ ...item }),
        },
        transaction: { update: async () => ({}) },
      }),
  };

  const service = new PaymentSubscriptionMutationService(
    prismaService as never,
    { info: () => undefined } as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const transaction = {
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    subscriptionId: null,
    purchaseType: 'RENEW',
    gatewayType: 'YOOKASSA',
    currency: 'USD',
    amount: { toString: () => '10' },
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    planSnapshot: { combinedRenewal: true, snapshotVersion: 1 },
  };

  return { service, transaction, subUpdates, committed: staged };
}

describe('a paid renewal snapshot cannot carry a zero-gigabyte traffic limit', () => {
  it('fulfills an ordinary cap, so the refusal below is not a dead validator', async () => {
    const env = renewalSnapshotEnv(1024);

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.committed['trafficLimit'], 1024);
  });

  it('fulfills 1 GB, the smallest expressible cap', async () => {
    const env = renewalSnapshotEnv(1);

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.committed['trafficLimit'], 1, 'the floor is 1, not "no finite cap at all"');
  });

  it('fulfills unlimited, which stays null and must not be caught by the floor', async () => {
    const env = renewalSnapshotEnv(null);

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.committed['trafficLimit'], null);
  });

  it('refuses a zero-gigabyte snapshot instead of casting it onto the plan', async () => {
    // Accepting `0` casts it onto `Plan.trafficLimit` and the renewal writes it
    // into the subscription column — a row that reads as "entitled to nothing"
    // locally while the panel hands out everything. Refusing rolls the paid
    // fulfillment back for remediation, which is where every other shape
    // violation in this validator already lands: the money is held and
    // recoverable, an unlimited profile given out by mistake is not.
    const env = renewalSnapshotEnv(0);

    await assert.rejects(
      () => env.service.applyCompletedTransaction(env.transaction as never),
      /snapshot/i,
    );
    assert.equal(
      env.subUpdates.length,
      0,
      'the refusal must come before anything is written, not after a partial renewal',
    );
    assert.equal(env.committed['trafficLimit'], 100, 'the subscription keeps the cap it had');
  });

  it('refuses a negative snapshot cap too', async () => {
    const env = renewalSnapshotEnv(-1);

    await assert.rejects(
      () => env.service.applyCompletedTransaction(env.transaction as never),
      /snapshot/i,
    );
    assert.equal(env.subUpdates.length, 0);
  });
});
