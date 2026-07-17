import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { PaymentGatewayType } from '@prisma/client';

import { SavedPaymentMethodService } from '../src/modules/payments/services/saved-payment-method.service';

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
