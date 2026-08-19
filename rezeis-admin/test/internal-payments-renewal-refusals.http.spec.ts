import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { InternalPaymentsController } from '../src/modules/payments/controllers/internal-payments.controller';
import { PartnerBalancePaymentService } from '../src/modules/payments/services/partner-balance-payment.service';
import { PaymentGatewayRegistryService } from '../src/modules/payments/services/payment-gateway-registry.service';
import { PaymentsCheckoutService } from '../src/modules/payments/services/payments-checkout.service';
import { PaymentsRenewalCheckoutService } from '../src/modules/payments/services/payments-renewal-checkout.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';
import {
  buildRenewalCheckoutFingerprint,
  fingerprint,
} from '../src/modules/payments/utils/checkout-fingerprint.util';

/**
 * `POST /api/internal/payments/renewal-checkout` — the three renewal refusals
 * asserted on the bytes that actually leave the process.
 *
 * WHY THIS SPEC EXISTS.
 *
 * The same defect as `admin-auth-totp.http.spec.ts`, three more times, and
 * this time it costs money. Both halves of the path were covered and both were
 * green. `payments-renewal-checkout-idempotency.spec.ts` asserts that the
 * service throws `ConflictException({ code: 'QUOTE_CHANGED' })` and its two
 * siblings; it does — it catches the exception object before any filter runs.
 * `admin-safe-exception.filter.spec.ts` asserts that the filter forwards
 * allowlisted product codes and strips the rest; it does — every code fed in
 * was one somebody had remembered to allowlist. Nobody ran the two together,
 * and none of these three labels was in `SAFE_PRODUCT_CODES`.
 *
 * What that cost, on the wire reiwa actually reads
 * (`reiwa/src/api/routes/payments-errors.ts` → `resolveRenewalCheckoutError`,
 * which `JSON.parse`s this body and looks at the top-level `code`, nothing
 * else):
 *
 *  - `IDEMPOTENCY_KEY_CONFLICT` arrived as an untyped 409, and the BFF's
 *    "any 409 is a stale quote" fallback relabelled it `QUOTE_CHANGED`. The
 *    buyer was told to refresh a quote that was fine, while the retry key
 *    bound to a different renewal — the one thing they could act on — went
 *    unmentioned. Not a vaguer message: a wrong one.
 *  - `PROVIDER_CHECKOUT_CREATION_UNRESOLVED` is a 503, which no fallback
 *    catches. The BFF found no contract and answered a generic "failed to
 *    create renewal checkout", so "the payment may already exist at the
 *    provider, check before retrying" never reached the buyer at all — and a
 *    blind retry on that advice can charge them twice.
 *
 * The rule this spec follows is the one that file set: no stubs on the path
 * under test. The real `InternalPaymentsController`, the real
 * `PaymentsRenewalCheckoutService` with its real replay, fingerprint and quote
 * checks, the real router, the real global `ValidationPipe` and the real
 * `AdminSafeExceptionFilter` all run. Only the edges are faked — Prisma, the
 * pricing service, the payment provider, the API-token guard — because they
 * are the boundary, not the seam. What is asserted is the response body, the
 * JSON reiwa parses; never an exception object, and never a filter invoked by
 * hand.
 */

const PRICED = {
  userId: 'user-1',
  currency: 'USD',
  total: '10.00',
  items: [
    {
      subscriptionId: 'sub-1',
      planId: 'plan-1',
      planName: 'Plan 1',
      durationDays: 30,
      currency: 'USD',
      amount: '10.00',
      discountPercent: 0,
      planSnapshot: { id: 'plan-1', snapshotSource: 'RENEWAL_DRAFT' },
    },
  ],
};

/** The composition fingerprints the real service recomputes for this request. */
const EXPECTED_FP = buildRenewalCheckoutFingerprint({
  contractVersion: 1,
  userId: 'user-1',
  gatewayType: 'YOOKASSA',
  channel: 'WEB',
  currency: 'USD',
  savedPaymentMethodId: null,
  lines: [{ subscriptionId: 'sub-1', planId: 'plan-1', durationDays: 30, termId: null, addOns: [] }],
});

const EXPECTED_REQUEST_FP = fingerprint({
  kind: 'RENEWAL_REQUEST',
  contractVersion: 1,
  userId: 'user-1',
  gatewayType: 'YOOKASSA',
  channel: 'WEB',
  savedPaymentMethodId: null,
  subscriptionIds: ['sub-1'],
  durations: [],
  plans: [],
  addOns: [],
});

/**
 * A persisted renewal draft as the service reads it back. `gatewayId`,
 * `checkoutUrl` and `checkoutFingerprint` are spelled nullable because the
 * columns are: a double whose claim column cannot hold a claim cannot guard
 * the claim.
 */
function draftRow(data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    status: 'PENDING',
    purchaseType: 'RENEW',
    channel: 'WEB',
    gatewayType: 'YOOKASSA',
    gatewayId: null,
    currency: 'USD',
    amount: { toString: () => '10.00' },
    planSnapshot: {},
    gatewayData: {},
    checkoutUrl: null,
    checkoutFingerprint: null,
    items: [{ subscriptionId: 'sub-1', planId: 'plan-1', durationDays: 30, addOnLines: null }],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...data,
  };
}

/**
 * The body reiwa posts. Only DTO-declared fields: the real pipe runs with
 * `forbidNonWhitelisted`, so an invented field would 400 before the service.
 */
const BASE_BODY = {
  userId: 'user-1',
  subscriptionIds: ['sub-1'],
  gatewayType: 'YOOKASSA',
  expectedAmount: '10.00',
  expectedCurrency: 'USD',
  idempotencyKey: 'renew-key-1',
};

let application: INestApplication | undefined;

/**
 * Boots the real controller over a real `PaymentsRenewalCheckoutService`,
 * wired the way `src/main.ts` wires production: same prefix, same pipe, same
 * global filter.
 */
async function boot(
  options: {
    existing?: Record<string, unknown> | null;
    providerCreateCheckout?: () => Promise<Record<string, unknown> | null>;
  } = {},
): Promise<INestApplication> {
  const prisma = {
    paymentGateway: {
      findUnique: async () => ({
        type: 'YOOKASSA',
        isActive: true,
        currency: 'USD',
        settings: { shopId: 'test-shop', apiKey: 'test-key' },
      }),
    },
    user: { findUnique: async () => ({ id: 'user-1' }) },
    transaction: {
      findFirst: async () => options.existing ?? null,
      findMany: async () => [],
      findUnique: async () => null,
      create: async (args: { data: Record<string, unknown> }) => draftRow({ ...args.data }),
      updateMany: async () => ({ count: 1 }),
      update: async (args: { data: Record<string, unknown> }) =>
        draftRow({
          ...args.data,
          gatewayData: { checkoutUrl: 'https://pay/1', providerMode: 'REDIRECT' },
          checkoutUrl: 'https://pay/1',
        }),
    },
    transactionItem: { createMany: async () => ({ count: 1 }) },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        transaction: {
          create: async (args: { data: Record<string, unknown> }) => draftRow({ ...args.data }),
        },
        transactionItem: { createMany: async () => ({ count: 1 }) },
      }),
  };

  const renewalCheckoutService = new PaymentsRenewalCheckoutService(
    prisma as never,
    {
      priceRenewalItems: async () => PRICED,
      assertRenewalPolicy: async () => undefined,
    } as never,
    {
      createCheckout: async () =>
        options.providerCreateCheckout !== undefined
          ? options.providerCreateCheckout()
          : {
              gatewayId: 'g1',
              gatewayData: { checkoutUrl: 'https://pay/1' },
              checkoutUrl: 'https://pay/1',
              providerMode: 'REDIRECT',
            },
    } as never,
    { applyCompletedTransaction: async () => ({ syncJobs: [] }) } as never,
    { enqueue: async () => undefined } as never,
    { getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC' }) } as never,
    { evaluate: () => null } as never,
    { resolveActiveForCharge: async () => null } as never,
    { runPostFulfillmentHooksBestEffort: async () => undefined } as never,
  );

  const testingModule: TestingModule = await Test.createTestingModule({
    controllers: [InternalPaymentsController],
    providers: [
      { provide: PaymentsRenewalCheckoutService, useValue: renewalCheckoutService },
      // Controller constructor dependencies this route never touches. Present
      // so Nest can build it; were the renewal route to reach one, the call
      // would throw rather than quietly succeed.
      { provide: PaymentsCheckoutService, useValue: {} },
      { provide: PaymentGatewayRegistryService, useValue: {} },
      { provide: PartnerBalancePaymentService, useValue: {} },
      { provide: SettingsService, useValue: {} },
    ],
  })
    // API-token verification is the edge, not the seam: it decides whether the
    // request is admitted, never what the refusal body looks like.
    .overrideGuard(InternalAdminAuthGuard)
    .useValue({ canActivate: (): boolean => true })
    .compile();

  const app = testingModule.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new AdminSafeExceptionFilter());
  await app.init();
  application = app;
  return app;
}

/**
 * `resolveRenewalCheckoutError` does exactly this and no more: parse the raw
 * upstream text, read the top-level `code`. Reading `response.text` rather
 * than supertest's pre-parsed `body` keeps the assertion on the bytes, so a
 * body that only looks right after re-serialisation cannot pass.
 */
function wireCode(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  assert.ok(parsed !== null && typeof parsed === 'object', 'upstream body was not a JSON object');
  return (parsed as { code?: unknown }).code;
}

describe('POST internal/payments/renewal-checkout — the refusal labels on the wire', () => {
  afterEach(async () => {
    await application?.close();
    application = undefined;
  });

  after(async () => {
    await application?.close();
  });

  it('delivers code: "QUOTE_CHANGED" when the pinned quote no longer matches', async () => {
    const app = await boot({ existing: null });

    const response = await request(app.getHttpServer())
      .post('/api/internal/payments/renewal-checkout')
      .send({ ...BASE_BODY, expectedAmount: '9.99' });

    // Asserted before the status, because the status was never the broken
    // part. A failure here reads "the code is missing", which is the defect.
    assert.equal(
      wireCode(response.text),
      'QUOTE_CHANGED',
      'the renewal 409 reached reiwa without `code: "QUOTE_CHANGED"`. ' +
        'resolveRenewalCheckoutError reads exactly this field; add the label ' +
        'to SAFE_PRODUCT_CODES in admin-safe-exception.filter.ts.',
    );
    assert.equal(response.status, 409);
    assert.equal(
      (response.body as { message?: string }).message,
      'Renewal quote changed; refresh the review before paying',
    );
    assert.equal((response.body as { errorCode?: string }).errorCode, 'QUOTE_CHANGED');

    // The exception body also carries `currentAmount` / `currentCurrency`.
    // They must NOT appear: this fix is one allowlist entry per label, not a
    // licence to forward arbitrary exception fields.
    assert.equal(
      (response.body as { currentAmount?: unknown }).currentAmount,
      undefined,
      'the filter forwarded a non-allowlisted exception field',
    );
    assert.equal((response.body as { currentCurrency?: unknown }).currentCurrency, undefined);
  });

  it('delivers code: "IDEMPOTENCY_KEY_CONFLICT" instead of letting it pass for a stale quote', async () => {
    // A retry key already bound to a different renewal request.
    const app = await boot({
      existing: draftRow({
        checkoutFingerprint: EXPECTED_FP,
        checkoutUrl: 'https://pay/existing',
        planSnapshot: { renewalRequestFingerprint: 'a-different-renewal' },
      }),
    });

    const response = await request(app.getHttpServer())
      .post('/api/internal/payments/renewal-checkout')
      .send(BASE_BODY);

    assert.equal(response.status, 409);
    assert.equal(
      wireCode(response.text),
      'IDEMPOTENCY_KEY_CONFLICT',
      'the key conflict reached reiwa as an untyped 409. reiwa relabels ANY ' +
        'untyped 409 as QUOTE_CHANGED, so the buyer is told to refresh a quote ' +
        'that is fine while the key bound to another renewal — the one thing ' +
        'they can act on — is never mentioned.',
    );
    // The mis-labelling stated directly: an untyped 409 here is not merely
    // vaguer, it is read as the other code.
    assert.notEqual(
      wireCode(response.text),
      'QUOTE_CHANGED',
      'a key conflict must never arrive wearing the stale-quote label',
    );
    assert.equal(
      (response.body as { message?: string }).message,
      'Idempotency key was already used for a different renewal request',
    );
  });

  it('delivers code: "PROVIDER_CHECKOUT_CREATION_UNRESOLVED" on a 503, not a generic 500 label', async () => {
    // A keyed replay whose draft is PENDING with no checkout URL: the provider
    // may or may not be holding a payment, and the buyer has to be told so.
    const app = await boot({
      existing: draftRow({
        checkoutFingerprint: EXPECTED_FP,
        planSnapshot: { renewalRequestFingerprint: EXPECTED_REQUEST_FP },
      }),
    });

    const response = await request(app.getHttpServer())
      .post('/api/internal/payments/renewal-checkout')
      .send(BASE_BODY);

    assert.equal(response.status, 503);
    assert.equal(
      wireCode(response.text),
      'PROVIDER_CHECKOUT_CREATION_UNRESOLVED',
      'the 503 reached reiwa with no `code`, so no contract matched and the ' +
        'buyer saw a generic "failed to create renewal checkout" instead of ' +
        '"the payment may already exist — check before retrying". Retrying on ' +
        'that advice can charge them twice.',
    );
    // The status-independence claim, made explicit. `errorCode` used to read
    // INTERNAL_SERVER_ERROR here purely because 5xx falls through
    // `mapStatusToErrorCode`; the product code has to win at 503 exactly as it
    // does at the 401 of the login form and at the 409 above.
    assert.equal(
      (response.body as { errorCode?: string }).errorCode,
      'PROVIDER_CHECKOUT_CREATION_UNRESOLVED',
      'at 5xx the filter still fell back to the status-derived error code',
    );
    // 5xx is also the only band where the filter substitutes a generic message
    // for anything it deems sensitive. The warning IS the payload here — a
    // correct code with the text redacted would still leave the buyer nothing
    // to act on.
    assert.equal(
      (response.body as { message?: string }).message,
      'Provider checkout creation is unresolved; awaiting reconciliation',
      'the filter redacted the 503 message the warning is made of',
    );
  });

  it('still strips a non-allowlisted product code at the same 503', async () => {
    // `PROVIDER_CHECKOUT_RESULT_INVALID` is a real 503 from this very service
    // and is deliberately NOT allowlisted — reiwa has no branch for it. It is
    // the control proving the three additions above are one allowlist entry
    // each, not a general "forward any code at 5xx".
    const app = await boot({ existing: null, providerCreateCheckout: async () => null });

    const response = await request(app.getHttpServer())
      .post('/api/internal/payments/renewal-checkout')
      .send({ userId: 'user-1', subscriptionIds: ['sub-1'], gatewayType: 'YOOKASSA' });

    assert.equal(response.status, 503);
    assert.equal(
      wireCode(response.text),
      undefined,
      'a code with no consumer was forwarded — the allowlist has stopped being ' +
        'an allowlist',
    );
    assert.equal((response.body as { errorCode?: string }).errorCode, 'INTERNAL_SERVER_ERROR');
  });

  it('keeps the safe filter installed on the real entrypoint', () => {
    // This file installs `AdminSafeExceptionFilter` itself. That is evidence
    // about production only while production installs it too — otherwise every
    // body asserted above is test-only fiction.
    const mainSource = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8');
    assert.match(
      mainSource,
      /useGlobalFilters\(\s*new AdminSafeExceptionFilter\(\)\s*\)/u,
      'src/main.ts no longer installs AdminSafeExceptionFilter globally',
    );
  });
});
