import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  Currency,
  PaymentGatewayType,
  PurchaseChannel,
  PurchaseType,
  TransactionStatus,
  UserRole,
} from '@prisma/client';
import { Request } from 'express';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../src/modules/auth/interfaces/request-metadata.interface';
import { AdminPaymentTransactionsController } from '../src/modules/payments/controllers/admin-payment-transactions.controller';
import { PaymentRefundService } from '../src/modules/payments/services/payment-refund.service';
import { PaymentsTransactionsService } from '../src/modules/payments/services/payments-transactions.service';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRoutePermission,
  routeLabel,
} from './helpers/controller-routes';

/** Where the controller answers — stated once, checked below and used in labels. */
const BASE_PATH = 'admin/payments/transactions';

/**
 * The argument `PaymentRefundService.refundTransaction` actually declares, read
 * off the service rather than re-typed here.
 *
 * The stub used to declare a narrower `{ transactionId, amount }` and reach the
 * controller through `as unknown as PaymentRefundService`. That cast was not a
 * formality: it is precisely what let a stub blind to `currentAdmin` and
 * `requestMetadata` stand in for a service that requires both, so deleting the
 * audit trail from the controller would have left this spec green. Deriving the
 * type keeps stub and service in step — a field the service adds has to be
 * answered here instead of being silently dropped.
 */
type RefundInput = Parameters<PaymentRefundService['refundTransaction']>[0];

const CURRENT_ADMIN: CurrentAdminInterface = {
  id: 'admin-1',
  login: 'operator',
  email: 'operator@example.com',
  name: 'Operator',
  role: UserRole.ADMIN,
  isActive: true,
  tokenVersion: 1,
  createdAt: new Date('2026-04-01T00:00:00.000Z'),
  lastLoginAt: null,
  lastLoginIp: null,
  rbacRoleId: null,
  mustChangePassword: false,
};

/**
 * What `extractRequestMetadata` must derive from the request built below.
 * Typed as the real interface so that a field added to it fails to compile here
 * rather than quietly going unasserted.
 */
const EXPECTED_REQUEST_METADATA: RequestMetadataInterface = {
  requestId: 'request-1',
  remoteAddress: '203.0.113.5',
  userAgent: 'rezeis-admin-panel/1.0',
};

describe('AdminPaymentTransactionsController', () => {
  it('exposes transaction admin routes behind explicit payment RBAC', () => {
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminPaymentTransactionsController),
      BASE_PATH,
    );
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminPaymentTransactionsController),
      [AdminJwtAuthGuard, RbacGuard],
    );
    // Read off the class instead of remembered here: a fifth endpoint — a
    // cancel, a re-capture, a status override — otherwise joins a money-moving
    // controller past the one test that claims every route on it is gated.
    assertRouteHandlers(AdminPaymentTransactionsController, [
      'listTransactions',
      'createDraft',
      'getRefundEligibility',
      'refundTransaction',
    ]);

    const listRoute = `${routeLabel(BASE_PATH, RequestMethod.GET, '/')} (list transactions)`;
    assertRoute(
      AdminPaymentTransactionsController.prototype.listTransactions,
      { method: RequestMethod.GET, path: '/' },
      listRoute,
    );
    assertRoutePermission(
      AdminPaymentTransactionsController.prototype.listTransactions,
      { resource: 'payments', action: 'view' },
      listRoute,
    );

    const draftRoute = `${routeLabel(BASE_PATH, RequestMethod.POST, 'draft')} (create draft)`;
    assertRoute(
      AdminPaymentTransactionsController.prototype.createDraft,
      { method: RequestMethod.POST, path: 'draft' },
      draftRoute,
    );
    assertRoutePermission(
      AdminPaymentTransactionsController.prototype.createDraft,
      { resource: 'payments', action: 'create' },
      draftRoute,
    );

    const eligibilityRoute = `${routeLabel(
      BASE_PATH,
      RequestMethod.GET,
      ':transactionId/refund-eligibility',
    )} (refund eligibility)`;
    assertRoute(
      AdminPaymentTransactionsController.prototype.getRefundEligibility,
      { method: RequestMethod.GET, path: ':transactionId/refund-eligibility' },
      eligibilityRoute,
    );
    assertRoutePermission(
      AdminPaymentTransactionsController.prototype.getRefundEligibility,
      { resource: 'payments', action: 'view' },
      eligibilityRoute,
    );

    // Issuing money back is gated on its own permission, NOT on `edit` — a role
    // that may correct transaction metadata must not inherit the ability to
    // refund.
    const refundRoute = `${routeLabel(BASE_PATH, RequestMethod.POST, ':transactionId/refund')} (issue refund)`;
    assertRoute(
      AdminPaymentTransactionsController.prototype.refundTransaction,
      { method: RequestMethod.POST, path: ':transactionId/refund' },
      refundRoute,
    );
    assertRoutePermission(
      AdminPaymentTransactionsController.prototype.refundTransaction,
      { resource: 'payments', action: 'refund' },
      refundRoute,
    );
    // The rows above say what each LISTED route costs; this says no route
    // escaped having a cost at all. The two are not the same check: the
    // enumeration forces a new route to be noticed, but it is satisfied by
    // adding a name to it — and a route that never gets a row here is one
    // `RbacGuard` waves through (`rbac.guard.ts:41`), open to any signed-in
    // admin rather than refused. On this controller that is the ledger and the
    // refund button. No route here is exempt, hence no list.
    assertEveryRouteGuarded(AdminPaymentTransactionsController);
  });

  it('delegates current transaction list and draft endpoints', async () => {
    const calls: unknown[] = [];
    // Recorded separately from `calls` as well, so the audit-trail assertions
    // below can name what went missing instead of only reporting a diff.
    const refundInputs: RefundInput[] = [];
    const transactionsService: Pick<PaymentsTransactionsService, 'listTransactions' | 'createDraft'> = {
      listTransactions: async (query: unknown) => {
        calls.push(['list', query]);
        return { items: [], total: 0 };
      },
      createDraft: async (input: unknown) => {
        calls.push(['createDraft', input]);
        return {
          id: 'transaction-1',
          paymentId: 'payment-1',
          userId: 'user-1',
          userTelegramId: null,
          userUsername: null,
          userName: null,
          userEmail: null,
          subscriptionId: null,
          status: TransactionStatus.PENDING,
          purchaseType: PurchaseType.NEW,
          channel: PurchaseChannel.WEB,
          gatewayType: PaymentGatewayType.YOOKASSA,
          currency: Currency.USD,
          amount: '8',
          paymentAsset: null,
          gatewayId: null,
          planSnapshot: {},
          createdAt: '2026-04-19T12:00:00.000Z',
          updatedAt: '2026-04-19T12:00:00.000Z',
        };
      },
    };
    const refundService: Pick<PaymentRefundService, 'getEligibility' | 'refundTransaction'> = {
      getEligibility: async (transactionId: string) => {
        calls.push(['refundEligibility', transactionId]);
        return {
          refundable: true,
          reason: null,
          refundableAmount: '8.00',
          currency: 'USD',
          refundedAmount: '0.00',
        };
      },
      refundTransaction: async (input: RefundInput) => {
        // The WHOLE input is recorded. Recording only `transactionId` and
        // `amount` is how the audit trail stopped being watched: the controller
        // could have dropped who refunded and from where, and nothing here
        // would have noticed.
        refundInputs.push(input);
        calls.push(['refund', input]);
        return {
          transactionId: input.transactionId,
          refundId: 'refund-1',
          amount: '8.00',
          currency: 'USD',
          providerStatus: 'succeeded',
        };
      },
    };
    // Both services are classes with private members, so no structural stub can
    // ever be assignable to them. These assertions are the narrowest ones that
    // compile — from the picked members, never through `unknown` — so every
    // signature the stubs claim to implement is still compiler-checked.
    const controller = new AdminPaymentTransactionsController(
      transactionsService as PaymentsTransactionsService,
      refundService as PaymentRefundService,
    );
    const query = {
      userSearch: 'alice',
      status: TransactionStatus.PENDING,
      gatewayType: PaymentGatewayType.YOOKASSA,
      purchaseType: PurchaseType.NEW,
      limit: 25,
      offset: 5,
    } as Parameters<AdminPaymentTransactionsController['listTransactions']>[0];
    const draft = {
      userId: 'user-1',
      purchaseType: PurchaseType.NEW,
      planId: 'plan-1',
      durationDays: 30,
      gatewayType: PaymentGatewayType.YOOKASSA,
      channel: PurchaseChannel.WEB,
    } as Parameters<AdminPaymentTransactionsController['createDraft']>[0];

    assert.deepStrictEqual(await controller.listTransactions(query), { items: [], total: 0 });
    assert.equal((await controller.createDraft(draft)).id, 'transaction-1');
    assert.equal((await controller.getRefundEligibility('transaction-1')).refundable, true);
    assert.equal(
      (
        await controller.refundTransaction(
          'transaction-1',
          { amount: '5.00', reason: 'duplicate charge' },
          CURRENT_ADMIN,
          buildRefundRequest(),
        )
      ).refundId,
      'refund-1',
    );

    // Refunds move real money, so the audit trail is asserted on its own and
    // BEFORE the delegation array below: a controller that stops forwarding one
    // of the two halves has to say WHICH half it lost, not hand back a diff of
    // every call the test made.
    assert.equal(
      refundInputs.length,
      1,
      'the refund endpoint must call PaymentRefundService.refundTransaction exactly once',
    );
    const [refundInput] = refundInputs;
    assert.deepStrictEqual(
      refundInput.currentAdmin,
      CURRENT_ADMIN,
      'the refund reached the service without the acting admin: the money would go back with nobody recorded behind it',
    );
    assert.deepStrictEqual(
      refundInput.requestMetadata,
      EXPECTED_REQUEST_METADATA,
      'the refund reached the service without its request metadata: the audit log would lose the origin of the refund',
    );

    assert.deepStrictEqual(calls, [
      ['list', query],
      ['createDraft', draft],
      ['refundEligibility', 'transaction-1'],
      [
        'refund',
        {
          transactionId: 'transaction-1',
          amount: '5.00',
          reason: 'duplicate charge',
          currentAdmin: CURRENT_ADMIN,
          requestMetadata: EXPECTED_REQUEST_METADATA,
        },
      ],
    ]);
  });
});

/**
 * The refund endpoint takes the raw express request and hands it straight to
 * `extractRequestMetadata`, so the stub only carries what that function reads.
 *
 * `Pick` keeps both fields checked against the real `Request`; the assertion
 * back to `Request` is the narrowest one that compiles (a full express request
 * cannot be built here) and, unlike `as unknown as`, still breaks if either
 * member disappears or changes type.
 */
function buildRefundRequest(): Request {
  const request: Pick<Request, 'headers' | 'ip'> = {
    headers: {
      'x-request-id': 'request-1',
      'user-agent': 'rezeis-admin-panel/1.0',
      // `req.ip` (trust-proxy resolved) is the only trusted source; a spoofable
      // X-Forwarded-For is deliberately ignored. It carries a DIFFERENT address
      // on purpose, so the metadata assertions fail the moment anyone starts
      // trusting the header again.
      'x-forwarded-for': '198.51.100.9',
    },
    ip: '203.0.113.5',
  };
  return request as Request;
}
