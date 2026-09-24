import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { PaymentGatewayType, Prisma } from '@prisma/client';

import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import {
  CHARGE_LOCK_TIMING,
  type ChargeLockTiming,
  chargeLockHoldMs,
  chargeLockWaiterTimeoutMs,
  CUSTOMER_SWITCH_LOCK_WAIT_MS,
  SAVED_PAYMENT_METHOD_BUSY,
  SavedPaymentMethodService,
} from '../src/modules/payments/services/saved-payment-method.service';

function createHarness() {
  const method = {
    id: 'method-1',
    userId: 'user-1',
    isActive: true,
    autopayEnabled: true,
    gatewayType: PaymentGatewayType.YOOKASSA,
    providerMethodId: 'pm-provider-1',
    methodType: 'bank_card',
    cardLast4: '4242',
  };
  let transactionTail = Promise.resolve();
  const tx = {
    // `SET LOCAL lock_timeout` before the charge's lock.
    $executeRaw: async () => 0,
    $queryRaw: async () => [{ id: method.id }],
    savedPaymentMethod: {
      findFirst: async () => ({ ...method }),
      update: async (args: { data: { autopayEnabled: boolean } }) => {
        method.autopayEnabled = args.data.autopayEnabled;
        return { ...method };
      },
    },
  };
  const prisma = {
    savedPaymentMethod: tx.savedPaymentMethod,
    $transaction: async <T>(callback: (client: typeof tx) => Promise<T>): Promise<T> => {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback(tx);
      } finally {
        release();
      }
    },
  };
  const service = new SavedPaymentMethodService(
    prisma as never,
    { info: () => undefined } as never,
  );
  return { service, method };
}

describe('SavedPaymentMethodService charge/disable serialization', () => {
  it('does not confirm autopay disable while a locked provider submission is in flight', async () => {
    const { service, method } = createHarness();
    let releaseProvider!: () => void;
    const providerMayFinish = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerStarted!: () => void;
    const providerDidStart = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });

    const charge = service.withActiveForCharge(
      {
        userId: 'user-1',
        savedPaymentMethodId: method.id,
        gatewayType: PaymentGatewayType.YOOKASSA,
      },
      async () => {
        providerStarted();
        await providerMayFinish;
        return 'submitted';
      },
    );
    await providerDidStart;

    let disableResolved = false;
    const disable = service.setAutopayEnabledForUser('user-1', method.id, false).then((result) => {
      disableResolved = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disableResolved, false);

    releaseProvider();
    assert.equal(await charge, 'submitted');
    assert.deepEqual(await disable, { id: method.id, autopayEnabled: false });
  });

  it('rejects a charge that starts after autopay disable acquires the lock', async () => {
    const { service, method } = createHarness();

    await service.setAutopayEnabledForUser('user-1', method.id, false);
    await assert.rejects(
      () =>
        service.withActiveForCharge(
          {
            userId: 'user-1',
            savedPaymentMethodId: method.id,
            gatewayType: PaymentGatewayType.YOOKASSA,
          },
          async () => 'must not submit',
        ),
      (error: unknown) =>
        error instanceof BadRequestException &&
        (error.getResponse() as { code?: string }).code === 'SAVED_PAYMENT_METHOD_AUTOPAY_DISABLED',
    );
  });
});

/**
 * The charge's lock outlives the submission it guards. It lasted the
 * transaction's 30 s timeout while the ЮKassa POST inside it may run 45 s —
 * and that is an idle timeout, not a deadline — so a refund's switch waiting
 * for the charge by waiting for this lock went ahead with the charge still in
 * flight. On PostgreSQL: `saved-payment-method-charge-lock-postgres.spec.ts`.
 */
describe('SavedPaymentMethodService charge lock timing', () => {
  const TIMING: ChargeLockTiming = { lockWaitMs: 40, submitMs: 60, marginMs: 30 };
  const METHOD = {
    id: 'method-1',
    userId: 'user-1',
    isActive: true,
    autopayEnabled: true,
    gatewayType: PaymentGatewayType.YOOKASSA,
    providerMethodId: 'pm-provider-1',
  };
  const CHARGE = { userId: 'user-1', savedPaymentMethodId: 'method-1', gatewayType: PaymentGatewayType.YOOKASSA };

  function timed(options: { readonly lock?: () => Promise<unknown> } = {}) {
    const statements: string[] = [];
    const timeouts: Array<number | undefined> = [];
    const tx = {
      $executeRaw: async (query: { readonly strings?: readonly string[]; readonly sql?: string }) => {
        statements.push(query.sql ?? (query.strings ?? []).join('?'));
        return 0;
      },
      $queryRaw: async (query: { readonly strings?: readonly string[]; readonly sql?: string }) => {
        statements.push(query.sql ?? (query.strings ?? []).join('?'));
        if (options.lock !== undefined) await options.lock();
        return [{ id: METHOD.id }];
      },
      savedPaymentMethod: {
        findFirst: async () => ({ ...METHOD }),
        findMany: async () => [{ id: METHOD.id }],
        update: async () => ({ ...METHOD }),
      },
    };
    const prisma = {
      ...tx,
      $transaction: async <T>(callback: (client: typeof tx) => Promise<T>, txOptions?: { readonly timeout?: number }) => {
        timeouts.push(txOptions?.timeout);
        return callback(tx);
      },
    };
    const service = new SavedPaymentMethodService(prisma as never, { info: () => undefined } as never, TIMING);
    return { service, statements, timeouts };
  }

  it('holds the lock for the wait, the submission and a margin, bounding the wait first', async () => {
    const { service, statements, timeouts } = timed();

    await service.withActiveForCharge(CHARGE, async () => 'submitted');

    assert.deepEqual(timeouts, [chargeLockHoldMs(TIMING)]);
    assert.equal(chargeLockHoldMs(TIMING), TIMING.lockWaitMs + TIMING.submitMs + TIMING.marginMs);
    assert.match(statements[0] ?? '', /SET LOCAL lock_timeout = '40ms'/, 'the wait for the lock is not bounded');
    assert.match(statements[1] ?? '', /FOR UPDATE/);
  });

  it('aborts the submission at its deadline, inside the lock', async () => {
    const { service } = timed();
    const startedAt = Date.now();
    let abortedAt: number | null = null;

    await assert.rejects(
      service.withActiveForCharge(CHARGE, (_method, signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            abortedAt = Date.now();
            reject(new Error('the POST was aborted'));
          });
        }),
      ),
      /the POST was aborted/,
    );

    assert.ok(abortedAt !== null, 'the submission was never told its deadline');
    const took = (abortedAt as number) - startedAt;
    assert.ok(took >= TIMING.submitMs - 5, `aborted after ${took} ms, before its deadline`);
    assert.ok(
      took < TIMING.lockWaitMs + TIMING.submitMs,
      `aborted after ${took} ms: the lock would have gone with the POST still running`,
    );
  });

  it('refuses a charge that got its lock too late to submit inside it, without submitting', async () => {
    const { service } = timed({ lock: () => new Promise((resolve) => setTimeout(resolve, TIMING.lockWaitMs + 20)) });
    let submitted = false;

    await assert.rejects(
      service.withActiveForCharge(CHARGE, async () => {
        submitted = true;
        return 'submitted';
      }),
      (error: unknown) =>
        error instanceof ServiceUnavailableException &&
        (error.getResponse() as { code?: string }).code === SAVED_PAYMENT_METHOD_BUSY,
    );
    assert.equal(submitted, false);
  });

  it('refuses a charge whose lock was not free within lock_timeout (55P03) as busy', async () => {
    const lockNotAvailable = new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `55P03`.', {
      code: 'P2010',
      clientVersion: 'spec',
      meta: { driverAdapterError: { cause: { code: '55P03' } } },
    });
    const { service } = timed({
      lock: async () => {
        throw lockNotAvailable;
      },
    });

    await assert.rejects(
      service.withActiveForCharge(CHARGE, async () => 'submitted'),
      (error: unknown) =>
        error instanceof ServiceUnavailableException &&
        (error.getResponse() as { code?: string }).code === SAVED_PAYMENT_METHOD_BUSY,
    );
  });

  it('gives every transaction that waits for the lock longer than a charge can hold it', async () => {
    const { service, timeouts } = timed();

    await service.setAutopayEnabledForUser('user-1', 'method-1', false);
    await service.unbindForUser('user-1', 'method-1');
    await service.disableAutopayForRefund({ userId: 'user-1', transactionId: 'tx-1', waitForCharges: true });

    assert.ok(timeouts.length >= 3);
    for (const timeout of timeouts) {
      assert.equal(timeout, chargeLockWaiterTimeoutMs(TIMING));
      assert.ok((timeout ?? 0) > chargeLockHoldMs(TIMING), 'a waiter behind a slow charge is rolled back as it gets the lock');
    }
  });

  it('lets the customer’s «Автосписание» and «Отвязать» wait only briefly for the lock, never for a charge', async () => {
    const { service, statements } = timed();

    await service.setAutopayEnabledForUser('user-1', 'method-1', false);
    await service.unbindForUser('user-1', 'method-1');

    const bounded = new RegExp(`SET LOCAL lock_timeout = '${CUSTOMER_SWITCH_LOCK_WAIT_MS}ms'`);
    assert.match(statements[0] ?? '', bounded, 'the switch waits as long as the lock is held');
    assert.match(statements[1] ?? '', /FOR UPDATE/);
    assert.match(statements[2] ?? '', bounded, '«Отвязать» waits as long as the lock is held');
    assert.match(statements[3] ?? '', /FOR UPDATE/);
    // Shorter than a charge holds it, and than the 30 s the panel gives a request.
    assert.ok(CUSTOMER_SWITCH_LOCK_WAIT_MS < CHARGE_LOCK_TIMING.submitMs);
    assert.ok(CUSTOMER_SWITCH_LOCK_WAIT_MS < 30_000);
  });

  it('answers the customer’s switch and «Отвязать» as busy (409) while a charge holds the method, changing nothing', async () => {
    const lockNotAvailable = new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `55P03`.', {
      code: 'P2010',
      clientVersion: 'spec',
      meta: { driverAdapterError: { cause: { code: '55P03' } } },
    });
    const { service } = timed({
      lock: async () => {
        throw lockNotAvailable;
      },
    });
    const busy = (error: unknown) =>
      error instanceof ConflictException &&
      (error.getResponse() as { code?: string }).code === SAVED_PAYMENT_METHOD_BUSY;

    await assert.rejects(service.setAutopayEnabledForUser('user-1', 'method-1', false), busy);
    await assert.rejects(service.unbindForUser('user-1', 'method-1'), busy);
  });

  it('lets the busy code through the panel’s safe filter, so the cabinet can say a payment is in progress', async () => {
    const lockNotAvailable = new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `55P03`.', {
      code: 'P2010',
      clientVersion: 'spec',
      meta: { driverAdapterError: { cause: { code: '55P03' } } },
    });
    const { service } = timed({
      lock: async () => {
        throw lockNotAvailable;
      },
    });
    const refusal = await service.setAutopayEnabledForUser('user-1', 'method-1', false).then(
      () => null,
      (error: unknown) => error,
    );
    const captured: { statusCode?: number; body?: Record<string, unknown> } = {};
    const response = {
      status(statusCode: number) {
        captured.statusCode = statusCode;
        return response;
      },
      json(body: Record<string, unknown>) {
        captured.body = body;
        return response;
      },
    };
    new AdminSafeExceptionFilter().catch(refusal, {
      switchToHttp: () => ({
        getRequest: () => ({ originalUrl: '/api/internal/user/u/payment-methods/m', headers: {} }),
        getResponse: () => response,
      }),
    } as never);

    assert.equal(captured.statusCode, 409);
    assert.equal(captured.body?.['code'], SAVED_PAYMENT_METHOD_BUSY, 'the cabinet reads this code; stripped, it can only say «failed»');
  });
});
