import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';

import { ConflictException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PaymentGatewayType, Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  type ChargeLockTiming,
  chargeLockHoldMs,
  CUSTOMER_SWITCH_LOCK_WAIT_MS,
  SAVED_PAYMENT_METHOD_BUSY,
  SavedPaymentMethodService,
} from '../src/modules/payments/services/saved-payment-method.service';

/**
 * The lock an off-session ЮKassa charge holds on its saved method, on
 * PostgreSQL.
 *
 * `withActiveForCharge` submits the charge inside an interactive transaction
 * that holds the method's row lock. Prisma ends such a transaction at its
 * timeout whatever the callback is still doing, and the timeout was 30 s
 * while the POST inside may run 45 s: the lock lapsed with the charge still in
 * flight, and a refund's switch-off — which waits for a charge by waiting for
 * this lock — went ahead under it.
 *
 * With a spec's short timing (the same shape as the real one: the wait for the
 * lock, the submission, a margin), the lock is taken before the POST starts
 * and is let go only after it has ended, as another connection sees it.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec; CI's PostgreSQL job
 * runs it.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `lock-${process.pid}-${Date.now()}`;

const TIMING: ChargeLockTiming = { lockWaitMs: 800, submitMs: 1500, marginMs: 700 };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

run('the ЮKassa charge lock, on PostgreSQL', () => {
  let db: PrismaService;
  let service: SavedPaymentMethodService;
  const users: string[] = [];
  let counter = 0;

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '6';
    db = new PrismaService();
    await db.$connect();
    service = new SavedPaymentMethodService(db, { info: () => undefined, warn: () => undefined } as never, TIMING);
  });

  after(async () => {
    mock.restoreAll();
    if (db === undefined) return;
    await db.savedPaymentMethod.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  });

  async function savedMethod(): Promise<{ readonly userId: string; readonly methodId: string }> {
    counter += 1;
    const userId = `${prefix}-user-${counter}`;
    await db.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId } });
    users.push(userId);
    const method = await db.savedPaymentMethod.create({
      data: {
        userId,
        gatewayType: PaymentGatewayType.YOOKASSA,
        providerMethodId: `${prefix}-pm-${counter}`,
        methodType: 'bank_card',
      },
    });
    return { userId, methodId: method.id };
  }

  /** Whether another connection can take the method's lock right now. */
  async function lockIsFree(methodId: string): Promise<boolean> {
    try {
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "saved_payment_methods" WHERE "id" = ${methodId} FOR UPDATE NOWAIT`;
      });
      return true;
    } catch (error: unknown) {
      if (JSON.stringify((error as { meta?: unknown }).meta ?? '').includes('55P03') || /55P03/.test(String(error))) return false;
      throw error;
    }
  }

  /**
   * One look at the lock from another connection: when it started and ended.
   * Free means free at some moment in between, so a free look proves the lock
   * was let go before it ENDED, and a held one that it was held after it STARTED.
   */
  interface Look {
    readonly startedAt: number;
    readonly endedAt: number;
    readonly free: boolean;
  }

  /** Looks at the lock from another connection until `until` settles, and a few times after. */
  function watchLock(methodId: string, until: Promise<unknown>): Promise<Look[]> {
    const looks: Look[] = [];
    let done = false;
    void until.finally(() => {
      done = true;
    }).catch(() => undefined);
    const look = async (): Promise<void> => {
      const startedAt = Date.now();
      const free = await lockIsFree(methodId);
      looks.push({ startedAt, endedAt: Date.now(), free });
    };
    return (async () => {
      while (!done) {
        await look();
        await sleep(25);
      }
      // A few more once the charge is over: the lock has to come free.
      for (let index = 0; index < 8; index += 1) {
        await look();
        await sleep(25);
      }
      return looks;
    })();
  }

  it('control: Prisma lets a transaction’s lock go at its timeout, whatever the callback is still doing', async () => {
    // What made the lock lapse under a slow POST. Measured here, not assumed:
    // if this ever stops holding, the timing below is protecting nothing.
    mock.method(Logger.prototype, 'error', () => undefined);
    const { methodId } = await savedMethod();
    let callbackEnded = 0;
    const holder = db
      .$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "saved_payment_methods" WHERE "id" = ${methodId} FOR UPDATE`;
          await sleep(1500);
          callbackEnded = Date.now();
        },
        { timeout: 500 },
      )
      .catch(() => 'timed out');
    await sleep(900);

    assert.equal(await lockIsFree(methodId), true, 'the lock outlived its transaction’s timeout');
    assert.equal(callbackEnded, 0, 'the callback had already ended');
    assert.equal(await holder, 'timed out');
  });

  it('holds the lock from before the POST starts until after it ends, the POST aborted at its deadline', async () => {
    const { userId, methodId } = await savedMethod();
    const post: { startedAt: number; endedAt: number; ended: 'aborted' | 'by itself' | null } = { startedAt: 0, endedAt: 0, ended: null };
    const charge = service.withActiveForCharge(
      { userId, savedPaymentMethodId: methodId, gatewayType: PaymentGatewayType.YOOKASSA },
      (_method, signal) =>
        new Promise<never>((_resolve, reject) => {
          post.startedAt = Date.now();
          // A POST that does not answer: it ends when aborted, or by itself
          // well after the transaction's whole time — what a slow provider
          // behind an idle-only socket timeout looks like.
          const ownEnd = setTimeout(() => {
            post.endedAt = Date.now();
            post.ended = 'by itself';
            reject(new Error('the POST ended by itself'));
          }, chargeLockHoldMs(TIMING) + 1000);
          signal.addEventListener('abort', () => {
            clearTimeout(ownEnd);
            post.endedAt = Date.now();
            post.ended = 'aborted';
            reject(new Error('the POST was aborted at its deadline'));
          });
        }),
    );
    const looks = await watchLock(methodId, charge);

    await assert.rejects(charge, /the POST was aborted at its deadline/);
    assert.equal(post.ended, 'aborted');
    const took = post.endedAt - post.startedAt;
    assert.ok(took >= TIMING.submitMs - 50 && took < chargeLockHoldMs(TIMING), `the POST ran ${took} ms`);
    // Every look taken wholly while the POST ran found the lock held.
    const whilePosting = looks.filter((look) => look.startedAt > post.startedAt && look.endedAt < post.endedAt);
    assert.ok(whilePosting.length > 10, `only ${whilePosting.length} looks while the POST ran`);
    assert.deepEqual(
      whilePosting.filter((look) => look.free).map((look) => look.endedAt - post.startedAt),
      [],
      'another connection took the lock while the POST was still running',
    );
    const firstFree = looks.find((look) => look.free && look.startedAt >= post.startedAt);
    assert.ok(firstFree !== undefined, 'the lock never came free after the charge');
    assert.ok(firstFree.endedAt >= post.endedAt, `free ${post.endedAt - firstFree.endedAt} ms before the POST ended`);
  });

  it('a refund’s switch that waits for the charge waits for all of it, and then switches the method off', async () => {
    const { userId, methodId } = await savedMethod();
    let chargeEnded = 0;
    const charge = service.withActiveForCharge(
      { userId, savedPaymentMethodId: methodId, gatewayType: PaymentGatewayType.YOOKASSA },
      async () => {
        await sleep(TIMING.submitMs - 200);
        chargeEnded = Date.now();
        return 'submitted';
      },
    );
    await sleep(150);

    const switched = await service.disableAutopayForRefund({ userId, providerSubscriptionId: 'none', waitForCharges: true });
    const switchedAt = Date.now();

    assert.equal(await charge, 'submitted');
    assert.deepEqual(switched, { switched: 1, busy: 0 }, 'the switch gave up waiting for the charge');
    assert.ok(switchedAt >= chargeEnded, 'the switch went ahead under a charge in flight');
    assert.equal((await db.savedPaymentMethod.findUniqueOrThrow({ where: { id: methodId } })).autopayEnabled, false);
  });

  it('refuses a charge whose lock is not free within lock_timeout — 55P03 from PostgreSQL — and submits nothing', async () => {
    mock.method(Logger.prototype, 'error', () => undefined);
    const { userId, methodId } = await savedMethod();
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // Another decision holds the method longer than a charge may wait for it.
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "saved_payment_methods" WHERE "id" = ${methodId} FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 10_000 },
    );
    await holding;
    let submitted = false;
    const startedAt = Date.now();

    try {
      await assert.rejects(
        service.withActiveForCharge(
          { userId, savedPaymentMethodId: methodId, gatewayType: PaymentGatewayType.YOOKASSA },
          async () => {
            submitted = true;
            return 'submitted';
          },
        ),
        (error: unknown) =>
          error instanceof ServiceUnavailableException &&
          (error.getResponse() as { code?: string }).code === SAVED_PAYMENT_METHOD_BUSY,
      );
      const waited = Date.now() - startedAt;
      assert.ok(waited >= TIMING.lockWaitMs - 50 && waited < TIMING.lockWaitMs + 1500, `waited ${waited} ms for the lock`);
      assert.equal(submitted, false);
    } finally {
      release();
      await holder;
    }
  });

  it('answers the customer’s switch and «Отвязать» as busy at once while a charge holds the method, and lets them through after it', async () => {
    mock.method(Logger.prototype, 'error', () => undefined);
    const { userId, methodId } = await savedMethod();
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // A charge being submitted: it holds the method for as long as its POST runs.
    const charge = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "saved_payment_methods" WHERE "id" = ${methodId} FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 20_000 },
    );
    await holding;
    const busy = (error: unknown) =>
      error instanceof ConflictException &&
      (error.getResponse() as { code?: string }).code === SAVED_PAYMENT_METHOD_BUSY;

    try {
      for (const attempt of [
        () => service.setAutopayEnabledForUser(userId, methodId, false),
        () => service.unbindForUser(userId, methodId),
      ]) {
        const startedAt = Date.now();
        await assert.rejects(attempt(), busy);
        const waited = Date.now() - startedAt;
        assert.ok(
          waited >= CUSTOMER_SWITCH_LOCK_WAIT_MS - 100 && waited < CUSTOMER_SWITCH_LOCK_WAIT_MS + 1500,
          `answered after ${waited} ms`,
        );
      }
      const untouched = await db.savedPaymentMethod.findUniqueOrThrow({ where: { id: methodId } });
      assert.equal(untouched.autopayEnabled, true, 'a refused switch changed the method');
      assert.equal(untouched.isActive, true, 'a refused unbind changed the method');
    } finally {
      release();
      await charge;
    }

    assert.deepEqual(await service.setAutopayEnabledForUser(userId, methodId, false), { id: methodId, autopayEnabled: false });
    assert.equal((await service.unbindForUser(userId, methodId)).unbound, true);
  });

  it('leaves the pool’s next borrower without the charge’s lock_timeout', async () => {
    const { userId, methodId } = await savedMethod();
    await service.withActiveForCharge(
      { userId, savedPaymentMethodId: methodId, gatewayType: PaymentGatewayType.YOOKASSA },
      async () => 'submitted',
    );
    const settings = await Promise.all(
      Array.from({ length: 6 }, () => db.$queryRaw<Array<{ lock_timeout: string }>>(Prisma.sql`SHOW lock_timeout`)),
    );
    for (const [row] of settings) assert.equal(row?.lock_timeout, '0', 'SET LOCAL leaked into the pool');
  });
});
