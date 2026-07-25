import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { of } from 'rxjs';

import {
  PaymentMethodSetupService,
  YOOKASSA_STANDALONE_SETUP_CONSENT_VERSION,
} from '../src/modules/payments/services/payment-method-setup.service';

describe('PaymentMethodSetupService', () => {
  it('starts a hosted zero-amount YooKassa binding with explicit consent', async () => {
    const calls: unknown[] = [];
    const updates: Array<{ data: Record<string, unknown> }> = [];
    const service = new PaymentMethodSetupService(
      {
        paymentGateway: {
          findUnique: async () => ({
            isActive: true,
            settings: { shopId: 'shop-1', apiKey: 'secret-1', savePaymentMethod: true },
          }),
        },
        paymentMethodSetup: {
          // No in-flight PENDING session yet.
          findFirst: async () => null,
          create: async (args: { data: Record<string, unknown> }) => ({
            id: 'setup-1',
            ...args.data,
          }),
          update: async (args: { data: Record<string, unknown> }) => {
            updates.push(args);
            return args;
          },
        },
      } as never,
      {
        post: (url: string, body: unknown, options: unknown) => {
          calls.push({ url, body, options });
          return of({
            status: 200,
            data: {
              id: 'pm-1',
              status: 'pending',
              confirmation: { confirmation_url: 'https://checkout.example/bind' },
            },
          });
        },
      } as never,
      { upsertFromYookassaPaymentMethod: async () => undefined } as never,
    );

    const result = await service.startYookassaSetup({
      userId: 'user-1',
      returnUrl: 'https://reiwa.example/settings/payment-methods',
      consent: true,
    });

    assert.equal(result.setupId, 'setup-1');
    assert.equal(result.checkoutUrl, 'https://checkout.example/bind');
    const call = calls[0] as {
      url: string;
      body: { type: string; confirmation: { return_url: string }; metadata: Record<string, unknown> };
      options: { headers: Record<string, string> };
    };
    assert.equal(call.url, 'https://api.yookassa.ru/v3/payment_methods');
    assert.equal(call.body.type, 'bank_card');
    assert.equal(call.body.confirmation.return_url, 'https://reiwa.example/settings/payment-methods?setupId=setup-1');
    assert.equal(call.body.metadata.consentVersion, YOOKASSA_STANDALONE_SETUP_CONSENT_VERSION);
    assert.equal(call.options.headers['Idempotence-Key'], 'setup-1');
    // Provider-method update, no FAILED update.
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.data.providerMethodId, 'pm-1');
  });

  it('reuses an in-flight PENDING binding instead of opening a second YooKassa request', async () => {
    let postCalled = false;
    const service = new PaymentMethodSetupService(
      {
        paymentGateway: {
          findUnique: async () => ({
            isActive: true,
            settings: { shopId: 'shop-1', apiKey: 'secret-1', savePaymentMethod: true },
          }),
        },
        paymentMethodSetup: {
          findFirst: async () => ({
            id: 'setup-existing',
            expiresAt: new Date(Date.now() + 60_000),
            rawSnapshot: { confirmation: { confirmation_url: 'https://checkout.example/existing' } },
          }),
          create: async () => {
            throw new Error('should not create a second session');
          },
        },
      } as never,
      {
        post: () => {
          postCalled = true;
          return of({ status: 200, data: {} });
        },
      } as never,
      { upsertFromYookassaPaymentMethod: async () => undefined } as never,
    );

    const result = await service.startYookassaSetup({
      userId: 'user-1',
      returnUrl: 'https://reiwa.example/settings/payment-methods',
      consent: true,
    });
    assert.equal(result.setupId, 'setup-existing');
    assert.equal(result.checkoutUrl, 'https://checkout.example/existing');
    assert.equal(postCalled, false, 'must not hit YooKassa when a pending session exists');
  });

  it('rejects a binding attempt without explicit consent', async () => {
    const service = new PaymentMethodSetupService({} as never, {} as never, {} as never);
    await assert.rejects(
      () =>
        service.startYookassaSetup({
          userId: 'user-1',
          returnUrl: 'https://reiwa.example/settings/payment-methods',
          consent: false,
        }),
      /consent/i,
    );
  });

  it('marks the setup FAILED when YooKassa rejects the binding request', async () => {
    const updates: Array<{ data: Record<string, unknown> }> = [];
    const service = new PaymentMethodSetupService(
      {
        paymentGateway: {
          findUnique: async () => ({
            isActive: true,
            settings: { shopId: 'shop-1', apiKey: 'secret-1', savePaymentMethod: true },
          }),
        },
        paymentMethodSetup: {
          findFirst: async () => null,
          create: async (args: { data: Record<string, unknown> }) => ({ id: 'setup-1', ...args.data }),
          update: async (args: { data: Record<string, unknown> }) => {
            updates.push(args);
            return args;
          },
        },
      } as never,
      { post: () => of({ status: 500, data: { type: 'error' } }) } as never,
      { upsertFromYookassaPaymentMethod: async () => undefined } as never,
    );

    await assert.rejects(() =>
      service.startYookassaSetup({
        userId: 'user-1',
        returnUrl: 'https://reiwa.example/settings/payment-methods',
        consent: true,
      }),
    );
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.data.status, 'FAILED');
    assert.ok(updates[0]?.data.completedAt);
  });

  it('persists an active provider method after the return-page status check', async () => {
    let upserted: unknown = null;
    const updateManyCalls: Array<Record<string, unknown>> = [];
    const service = new PaymentMethodSetupService(
      {
        paymentGateway: {
          findUnique: async () => ({
            isActive: true,
            settings: { shopId: 'shop-1', apiKey: 'secret-1' },
          }),
        },
        paymentMethodSetup: {
          findFirst: async () => ({
            id: 'setup-1',
            userId: 'user-1',
            status: 'PENDING',
            providerMethodId: 'pm-1',
            lastCheckedAt: null,
            expiresAt: new Date(Date.now() + 60_000),
          }),
          updateMany: async (args: { data: Record<string, unknown> }) => {
            updateManyCalls.push(args.data);
            return { count: 1 };
          },
          findUniqueOrThrow: async () => ({
            id: 'setup-1',
            status: 'ACTIVE',
            expiresAt: new Date(Date.now() + 60_000),
          }),
        },
      } as never,
      {
        get: () =>
          of({
            status: 200,
            data: {
              id: 'pm-1',
              status: 'active',
              saved: true,
              type: 'bank_card',
              card: { last4: '4242' },
            },
          }),
      } as never,
      {
        upsertFromYookassaPaymentMethod: async (input: unknown) => {
          upserted = input;
        },
      } as never,
    );

    const result = await service.getStatusForUser({ userId: 'user-1', setupId: 'setup-1' });
    assert.equal(result.status, 'ACTIVE');
    assert.equal(updateManyCalls[0]?.status, 'ACTIVE');
    assert.deepEqual(upserted, {
      userId: 'user-1',
      rawPaymentMethod: {
        id: 'pm-1',
        status: 'active',
        saved: true,
        type: 'bank_card',
        card: { last4: '4242' },
      },
    });
  });

  it('expires a stale PENDING setup on status check without hitting the provider', async () => {
    let getCalled = false;
    const service = new PaymentMethodSetupService(
      {
        paymentGateway: { findUnique: async () => ({ isActive: true, settings: {} }) },
        paymentMethodSetup: {
          findFirst: async () => ({
            id: 'setup-1',
            userId: 'user-1',
            status: 'PENDING',
            providerMethodId: 'pm-1',
            lastCheckedAt: null,
            expiresAt: new Date(Date.now() - 1_000),
          }),
          update: async () => ({
            status: 'EXPIRED',
            expiresAt: new Date(Date.now() - 1_000),
          }),
        },
      } as never,
      {
        get: () => {
          getCalled = true;
          return of({ status: 200, data: {} });
        },
      } as never,
      { upsertFromYookassaPaymentMethod: async () => undefined } as never,
    );

    const result = await service.getStatusForUser({ userId: 'user-1', setupId: 'setup-1' });
    assert.equal(result.status, 'EXPIRED');
    assert.equal(getCalled, false, 'expired setup must not poll the provider');
  });

  it('skips the provider poll while the refresh throttle is warm', async () => {
    let getCalled = false;
    const service = new PaymentMethodSetupService(
      {
        paymentGateway: { findUnique: async () => ({ isActive: true, settings: {} }) },
        paymentMethodSetup: {
          findFirst: async () => ({
            id: 'setup-1',
            userId: 'user-1',
            status: 'PENDING',
            providerMethodId: 'pm-1',
            lastCheckedAt: new Date(), // just checked
            expiresAt: new Date(Date.now() + 60_000),
          }),
        },
      } as never,
      {
        get: () => {
          getCalled = true;
          return of({ status: 200, data: {} });
        },
      } as never,
      { upsertFromYookassaPaymentMethod: async () => undefined } as never,
    );

    const result = await service.getStatusForUser({ userId: 'user-1', setupId: 'setup-1' });
    assert.equal(result.status, 'PENDING');
    assert.equal(getCalled, false, 'must not poll again within the throttle window');
  });

  it('completes a binding from a payment_method.active webhook (no user return needed)', async () => {
    let upserted: unknown = null;
    const updateManyCalls: Array<Record<string, unknown>> = [];
    const service = new PaymentMethodSetupService(
      {
        paymentMethodSetup: {
          findUnique: async () => ({ id: 'setup-1', userId: 'user-1' }),
          updateMany: async (args: { data: Record<string, unknown> }) => {
            updateManyCalls.push(args.data);
            return { count: 1 };
          },
          findUniqueOrThrow: async () => ({ id: 'setup-1', status: 'ACTIVE' }),
        },
      } as never,
      {} as never,
      {
        upsertFromYookassaPaymentMethod: async (input: unknown) => {
          upserted = input;
        },
      } as never,
    );

    await service.handleYookassaPaymentMethodEvent({
      id: 'pm-1',
      status: 'active',
      saved: true,
      type: 'bank_card',
      metadata: { paymentMethodSetupId: 'setup-1' },
      card: { last4: '4242' },
    });

    assert.equal(updateManyCalls[0]?.status, 'ACTIVE');
    assert.deepEqual((upserted as { userId: string }).userId, 'user-1');
  });

  it('ignores a webhook for an unknown setup without throwing', async () => {
    let upsertCalled = false;
    const service = new PaymentMethodSetupService(
      {
        paymentMethodSetup: {
          findUnique: async () => null,
        },
      } as never,
      {} as never,
      {
        upsertFromYookassaPaymentMethod: async () => {
          upsertCalled = true;
        },
      } as never,
    );

    await service.handleYookassaPaymentMethodEvent({
      id: 'pm-unknown',
      status: 'active',
      saved: true,
      metadata: {},
    });
    assert.equal(upsertCalled, false);
  });

  it('does not advertise setup when YooKassa is inactive', async () => {
    const service = new PaymentMethodSetupService(
      {
        paymentGateway: {
          findUnique: async () => ({ isActive: false, settings: {} }),
        },
      } as never,
      {} as never,
      {} as never,
    );
    assert.deepEqual(await service.getCapabilities(), { yookassaStandaloneSetup: false });
  });
});
