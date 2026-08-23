import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, HttpException } from '@nestjs/common';

import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';

/**
 * `PATCH /admin/users/subscriptions/:id` HAS NO DTO, SO IT HAS NO VALIDATION
 * EXCEPT WHAT IS WRITTEN BY HAND.
 *
 * Its `@Body()` is `Record<string, unknown>`, whose metatype is `Object`, so the
 * global `ValidationPipe` in `main.ts` skips the route entirely: not one
 * class-validator decorator anywhere runs on this endpoint. Every field is
 * therefore whatever `Number()`, `String()` or `new Date()` made of it, and
 * each of those coercers has a way of turning a typo into a 500:
 *
 *   • `Number('abc')` is `NaN`, which Prisma rejects at the driver.
 *   • `new Date('abc')` is an Invalid Date, which Prisma rejects at the driver.
 *   • `expireDays: 'abc'` was worse than either, because the guard that follows
 *     it LOOKS like it covers the case: `NaN < Date.now()` is **false**, so the
 *     "expiry would be in the past" refusal waved the Invalid Date straight
 *     through to the write.
 *
 * An operator typing into a number box deserves a 400 naming the field, not a
 * 500 naming nothing. These specs assert the status as well as the throw,
 * because "it threw" is exactly what a 500 does too.
 *
 * ── AND THE ASYMMETRY, ASSERTED ───────────────────────────────────────────
 *
 * `deviceLimit: 0` must keep meaning UNLIMITED. `trafficLimit: 0` must keep
 * being refused. Same digit, opposite meanings, one line apart in the same
 * handler — `deviceLimit <= 0` is the product's canonical unlimited and matches
 * the panel's own `hwidDeviceLimit: 0`, while Remnawave has no encoding at all
 * for "zero bytes allowed". A "consistency" pass that raised both floors
 * together would silently uncap or refuse every unlimited-device row, so the
 * spec that keeps `0` legal for devices sits beside the ones that outlaw
 * everything Number() would have folded INTO `0`.
 */

const ACTING_ADMIN = { id: 'admin-1' } as never;

const ACTING_REQUEST = {
  headers: { 'x-request-id': 'req-1', 'user-agent': 'node:test' },
  ip: '10.0.0.7',
  socket: { remoteAddress: null },
} as never;

/** The row every spec below edits. Expiry is far future so `expireDays` works. */
const STORED_SUBSCRIPTION = {
  id: 'sub-1',
  userId: 'user-1',
  // Deliberately NOT a value any spec writes, so the audit diff is non-empty
  // and that path is exercised rather than skipped.
  trafficLimit: 10,
  deviceLimit: 3,
  internalSquads: [],
  externalSquad: null,
  remnawaveId: null,
  remnawavePanelUsername: 'rz_test_1',
  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
};

const STORED_PLAN = {
  id: 'plan-1',
  name: 'Premium',
  type: 'BOTH',
  trafficLimit: 200,
  deviceLimit: 5,
  trafficLimitStrategy: 'NO_RESET',
  internalSquads: ['squad-a'],
  externalSquad: null,
  duration: 30,
};

function buildEditor(): {
  readonly controller: AdminUserSubscriptionsController;
  readonly updates: Array<Record<string, unknown>>;
} {
  const updates: Array<Record<string, unknown>> = [];
  const controller = new AdminUserSubscriptionsController(
    {
      subscription: { findUnique: async () => ({ ...STORED_SUBSCRIPTION }) },
      plan: { findUnique: async () => ({ ...STORED_PLAN }) },
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

/**
 * A rejection is only the right rejection when it carries HTTP 400 AND names
 * the field. `assert.rejects(fn)` on its own passes for a 500 — which is the
 * very outcome under test — so every refusal below goes through here.
 */
async function assertRefusedAsBadRequest(
  body: Record<string, unknown>,
  field: string,
): Promise<void> {
  const { controller, updates } = buildEditor();
  await assert.rejects(
    editSubscription(controller, body),
    (error: unknown) => {
      assert.equal(
        error instanceof BadRequestException,
        true,
        `${field}: expected a BadRequestException, got ${String(error)}`,
      );
      assert.equal(
        (error as HttpException).getStatus(),
        400,
        `${field}: refused with the wrong status — a 500 is the defect, not the fix`,
      );
      const response = (error as HttpException).getResponse();
      const message =
        typeof response === 'string'
          ? response
          : String((response as { message?: unknown }).message ?? '');
      assert.equal(
        message.includes(field),
        true,
        `${field}: the 400 does not name the field, so the operator cannot tell what to fix — got "${message}"`,
      );
      return true;
    },
  );
  // Refused BEFORE the write, not refused after a partial one.
  assert.equal(updates.length, 0, `${field}: a write happened despite the refusal`);
}

describe('deviceLimit on the DTO-less subscription editor', () => {
  it('writes an ordinary device count, so the refusals below are not a dead endpoint', async () => {
    // THE ANCHOR. An endpoint that threw on everything would satisfy every
    // rejection spec in this file.
    const { controller, updates } = buildEditor();

    await editSubscription(controller, { deviceLimit: 5 });

    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.deviceLimit, 5);
  });

  it('refuses a non-numeric device count as a 400 rather than letting NaN reach Prisma', async () => {
    // THE DEFECT. `Number('abc')` is `NaN`, `NaN` reached Prisma, and the
    // operator got a 500 for a typo in a number box.
    await assertRefusedAsBadRequest({ deviceLimit: 'abc' }, 'deviceLimit');
  });

  it('keeps deviceLimit: 0 legal, because there 0 IS unlimited', async () => {
    // THE ANTI-HARMONISATION GUARD. Copying the traffic gate across — where
    // `0` is refused — would delete the only way this endpoint has of clearing
    // a device cap, and would put it out of step with `deviceLimit <= 0`, the
    // rule every reader in the product implements.
    const { controller, updates } = buildEditor();

    await editSubscription(controller, { deviceLimit: 0 });

    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.deviceLimit, 0);
  });

  it('takes null as unlimited and stores the canonical 0', async () => {
    // The column is `Int`, not `Int?`, so a raw `null` would fail at the driver.
    const { controller, updates } = buildEditor();

    await editSubscription(controller, { deviceLimit: null });

    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.deviceLimit, 0);
  });

  it('keeps a negative device count as written, because <= 0 is the read convention', async () => {
    // Plan fixtures already spell unlimited `-1`; rewriting it to `0` here
    // would make this one endpoint disagree with every reader of the column.
    const { controller, updates } = buildEditor();

    await editSubscription(controller, { deviceLimit: -1 });

    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.deviceLimit, -1);
  });

  it('refuses the empty string instead of reading it as unlimited', async () => {
    // The trap that makes this field different from traffic: `Number('')` is
    // `0`, and `0` here is not an error value, it is UNLIMITED. Coercing would
    // silently uncap the customer, and the operator would see a successful save.
    await assertRefusedAsBadRequest({ deviceLimit: '' }, 'deviceLimit');
  });

  it('refuses false and [], which Number() also folds into unlimited', async () => {
    await assertRefusedAsBadRequest({ deviceLimit: false }, 'deviceLimit');
    await assertRefusedAsBadRequest({ deviceLimit: [] }, 'deviceLimit');
  });

  it('refuses a fractional device count', async () => {
    await assertRefusedAsBadRequest({ deviceLimit: 1.5 }, 'deviceLimit');
  });

  it('refuses a count wider than the column, rather than 500ing at the driver', async () => {
    // `Subscription.deviceLimit` is a 32-bit `Int`. Past that the write fails
    // in Postgres, which is a 500 for a request we can answer here.
    await assertRefusedAsBadRequest({ deviceLimit: 3_000_000_000 }, 'deviceLimit');
  });

  it('still accepts a numeric string, which the editor sends', async () => {
    const { controller, updates } = buildEditor();

    await editSubscription(controller, { deviceLimit: '7' });

    assert.equal(updates[0]?.deviceLimit, 7);
  });
});

describe('expireDays on the DTO-less subscription editor', () => {
  it('moves the expiry for a real number of days', async () => {
    // THE ANCHOR for this block.
    const { controller, updates } = buildEditor();

    await editSubscription(controller, { expireDays: 30 });

    assert.equal(updates.length, 1);
    const written = updates[0]?.expiresAt;
    assert.equal(written instanceof Date, true);
    assert.equal(
      (written as Date).toISOString(),
      new Date(
        STORED_SUBSCRIPTION.expiresAt.getTime() + 30 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    );
  });

  it('refuses a non-numeric nudge that the "in the past" guard waved through', async () => {
    // THE DEFECT, and the subtlest one in the handler. `Number('abc')` is
    // `NaN`; `base + NaN` is `NaN`; `new Date(NaN)` is an Invalid Date; and
    // `NaN < Date.now()` is FALSE, so the refusal that reads like it covers
    // this case passed it on to Prisma as a 500.
    await assertRefusedAsBadRequest({ expireDays: 'abc' }, 'expireDays');
  });

  it('refuses a nudge that overflows the representable date range', async () => {
    // No NaN in the payload at all: ECMAScript caps a Date at ±8.64e15 ms, so
    // a large enough finite `days` becomes an Invalid Date by arithmetic and
    // then takes exactly the same path as `'abc'` did.
    await assertRefusedAsBadRequest({ expireDays: 1e15 }, 'expireDays');
  });

  it('refuses blanks and booleans rather than reading them as a zero-day nudge', async () => {
    // `Number('')` is `0`, and a `0`-day nudge is not a no-op: it rewrites
    // `expiresAt` to `max(expiresAt, now)`, which for an already-expired row
    // silently moves the expiry to this instant.
    await assertRefusedAsBadRequest({ expireDays: '' }, 'expireDays');
    await assertRefusedAsBadRequest({ expireDays: true }, 'expireDays');
  });

  it('still refuses a nudge that lands in the past, with the original message', async () => {
    // The pre-existing guard has to survive the new one placed in front of it:
    // a finite, perfectly parseable `-100000` must reach it and be refused
    // there, not swallowed by the range check.
    const { controller, updates } = buildEditor();

    await assert.rejects(
      editSubscription(controller, { expireDays: -100_000 }),
      (error: unknown) => {
        assert.equal(error instanceof BadRequestException, true);
        const response = (error as HttpException).getResponse();
        const message = String((response as { message?: unknown }).message ?? response);
        assert.equal(
          message.includes('past'),
          true,
          `the new range check swallowed the "in the past" refusal — got "${message}"`,
        );
        return true;
      },
    );
    assert.equal(updates.length, 0);
  });
});

describe('expiresAt on the DTO-less subscription editor', () => {
  it('writes a real timestamp', async () => {
    // THE ANCHOR for this block.
    const { controller, updates } = buildEditor();

    await editSubscription(controller, { expiresAt: '2030-01-01T00:00:00.000Z' });

    assert.equal(updates.length, 1);
    assert.equal((updates[0]?.expiresAt as Date).toISOString(), '2030-01-01T00:00:00.000Z');
  });

  it('refuses an unparseable date as a 400 rather than storing an Invalid Date', async () => {
    // THE DEFECT. `new Date('nope')` does not throw — it produces an Invalid
    // Date, which Prisma rejects at the driver as a 500.
    await assertRefusedAsBadRequest({ expiresAt: 'nope' }, 'expiresAt');
  });

  it('refuses an object, which String() turns into "[object Object]"', async () => {
    await assertRefusedAsBadRequest({ expiresAt: {} }, 'expiresAt');
  });
});

describe('planId on the DTO-less subscription editor', () => {
  it('assigns a plan and takes all four limits from it', async () => {
    // THE ANCHOR, and it also pins the precedence: a plan assignment wins over
    // a hand-typed limit in the same body.
    const { controller, updates } = buildEditor();

    await editSubscription(controller, { planId: 'plan-1', trafficLimit: 999, deviceLimit: 9 });

    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.trafficLimit, STORED_PLAN.trafficLimit);
    assert.equal(updates[0]?.deviceLimit, STORED_PLAN.deviceLimit);
  });

  it('refuses a non-string plan id as a 400 instead of answering "Plan not found"', async () => {
    // `String({})` is `'[object Object]'`, which no plan can match, so this
    // used to surface as a 404. That is the wrong account of what happened:
    // the plan is not missing, the request is malformed.
    await assertRefusedAsBadRequest({ planId: {} }, 'planId');
    await assertRefusedAsBadRequest({ planId: 42 }, 'planId');
  });
});
