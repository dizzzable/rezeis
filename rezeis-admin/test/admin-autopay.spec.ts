import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';

import { Logger, NotFoundException, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Currency, PaymentGatewayType, Prisma, ProviderSubscriptionStatus } from '@prisma/client';
import { from, of, throwError } from 'rxjs';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminPaymentAutopayController } from '../src/modules/payments/controllers/admin-payment-autopay.controller';
import {
  AdminAutopayService,
  describeOperatorProviderCancel,
  describeOperatorYookassaDisable,
} from '../src/modules/payments/services/admin-autopay.service';
import { AFTER_RESPONSE_SHUTDOWN_WAIT_MS } from '../src/modules/payments/services/payment-reconciliation.service';
import {
  OPERATOR_CANCELLED_BY,
  ProviderSubscriptionService,
  STRANDED_BY_OPERATOR,
  STRANDED_BY_REFUND,
  strandedReason,
} from '../src/modules/payments/services/provider-subscription.service';
import { REFUND_CANCELLED_BY } from '../src/modules/payments/utils/refund-autopay.util';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRoutePermission,
  routeLabel,
} from './helpers/controller-routes';

/**
 * The operator's «Отменить автосписание» on the user's card, without a refund.
 * A customer who asked support to stop the charges had to be sent to the
 * provider's dashboard: the panel had no such button.
 *
 * - A Platega or RollyPay subscription is marked in the request and cancelled
 *   at the provider after the answer (`cancel()` with `OPERATOR`); a provider
 *   that does not take it is retried by the sweep.
 * - The ЮKassa autopay goes off on every saved method, without waiting for a
 *   charge that holds one — that one goes off after the answer.
 * - The customer is told nothing; the operator gets a card once the provider
 *   answered, and the audit log a row.
 *
 * On PostgreSQL: `provider-subscriptions-postgres.spec.ts`.
 */

afterEach(() => mock.restoreAll());

const BASE_PATH = 'admin/payments/autopay';
const OPERATOR = { id: 'admin-1', login: 'operator' } as never;
const REQUEST = { requestId: 'request-1', remoteAddress: '203.0.113.5', userAgent: 'spec' };

type Row = {
  id: string;
  userId: string | null;
  gatewayType: PaymentGatewayType;
  providerSubscriptionId: string;
  status: ProviderSubscriptionStatus;
  planId: string;
  subscriptionId: string | null;
  amount: Prisma.Decimal;
  currency: Currency;
  intervalUnit: string;
  intervalCount: number;
  durationDays: number;
  nextChargeAt: Date | null;
  lastChargeAt: Date | null;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  createdAt: Date;
};

function autopayRow(id: string, fields: Partial<Row> = {}): Row {
  return {
    id,
    userId: 'user-1',
    gatewayType: PaymentGatewayType.PLATEGA,
    providerSubscriptionId: `platega-${id}`,
    status: ProviderSubscriptionStatus.ACTIVE,
    planId: 'plan-1',
    subscriptionId: 'sub-1',
    amount: new Prisma.Decimal('299'),
    currency: Currency.RUB,
    intervalUnit: 'month',
    intervalCount: 1,
    durationDays: 30,
    nextChargeAt: new Date('2026-10-24T00:00:00.000Z'),
    lastChargeAt: null,
    cancelledAt: null,
    cancelledBy: null,
    createdAt: new Date('2026-09-24T00:00:00.000Z'),
    ...fields,
  };
}

/** Prisma's where-input as these services write it, evaluated on a row. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return (condition as Record<string, unknown>[]).some((part) => matches(row, part));
    const value = row[key];
    if (condition === null) return value === null;
    if (typeof condition === 'object' && !(condition instanceof Date)) {
      const ops = condition as { in?: unknown[]; not?: unknown };
      if (ops.in !== undefined) return ops.in.includes(value);
      if ('not' in ops) return value !== ops.not;
      return true;
    }
    return value === condition;
  });
}

function world(options: { readonly rows?: Row[]; readonly cancelHangs?: boolean; readonly providerDown?: boolean } = {}) {
  const rows = options.rows ?? [autopayRow('psub-1')];
  const events: Array<{ type: string; metadata: Record<string, unknown> }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const cancelCalls: string[] = [];
  const savedAsks: Array<{ userId: string; waitForCharges: boolean }> = [];
  const savedAnswers: Array<{ switched: Array<{ id: string; methodType: string; title: string }>; busy: number } | Error> = [];
  let release: () => void = () => undefined;
  const answered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prisma = {
    user: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === 'user-1' ? { id: 'user-1' } : null) },
    plan: {
      findMany: async () => [{ id: 'plan-1', name: 'Pro' }],
      findUnique: async () => ({ name: 'Pro' }),
    },
    paymentGateway: { findUnique: async () => ({ type: PaymentGatewayType.PLATEGA, settings: { merchantId: 'm-1', secret: 's-1' } }) },
    providerSubscription: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => matches(row as unknown as Record<string, unknown>, where)) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((row) => row.id === where.id) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((row) => matches(row as unknown as Record<string, unknown>, where)).map((row) => ({ ...row })),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = rows.filter((row) => matches(row as unknown as Record<string, unknown>, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        assert.ok(row);
        Object.assign(row, data);
        return { ...row };
      },
    },
    adminAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      },
    },
  };
  const http = {
    post: (url: string) => {
      cancelCalls.push(url);
      if (options.providerDown === true) return throwError(() => new Error('Platega is not answering'));
      return options.cancelHangs === true
        ? from(answered.then(() => ({ data: { status: 'cancelled' } })))
        : of({ data: { status: 'cancelled' } });
    },
  };
  const systemEvents = {
    warn: (type: string, _category: string, _message: string, metadata: Record<string, unknown>) => {
      events.push({ type, metadata });
    },
    info: () => undefined,
    error: () => undefined,
  };
  const providerSubscriptions = new ProviderSubscriptionService(prisma as never, http as never, {} as never, {} as never);
  const savedMethods = {
    listActiveForUser: async () => ({
      methods: [
        { id: 'pm-card', gatewayType: PaymentGatewayType.YOOKASSA, title: 'Visa •••• 4242', methodType: 'bank_card', cardLast4: '4242', autopayEnabled: true },
        { id: 'pm-other', gatewayType: 'SOMETHING_ELSE', title: 'Other', methodType: 'other', cardLast4: null, autopayEnabled: true },
      ],
      total: 2,
    }),
    disableAutopayForOperator: async (input: { userId: string; waitForCharges: boolean }) => {
      savedAsks.push({ userId: input.userId, waitForCharges: input.waitForCharges });
      const next = savedAnswers.shift() ?? { switched: [], busy: 0 };
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const service = new AdminAutopayService(prisma as never, providerSubscriptions, savedMethods as never, systemEvents as never);
  return { service, providerSubscriptions, rows, events, audits, cancelCalls, savedAsks, savedAnswers, release };
}

const quiet = (): void => {
  mock.method(Logger.prototype, 'warn', () => undefined);
  mock.method(Logger.prototype, 'error', () => undefined);
  mock.method(Logger.prototype, 'log', () => undefined);
};

describe('AdminPaymentAutopayController', () => {
  it('reads on payments:view and ends an autopay on payments:edit, every route guarded', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminPaymentAutopayController), BASE_PATH);
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, AdminPaymentAutopayController), [AdminJwtAuthGuard, RbacGuard]);
    assertRouteHandlers(AdminPaymentAutopayController, ['listForUser', 'cancelProviderSubscription', 'disableYookassaAutopay']);

    const list = routeLabel(BASE_PATH, RequestMethod.GET, 'users/:userId');
    assertRoute(AdminPaymentAutopayController.prototype.listForUser, { method: RequestMethod.GET, path: 'users/:userId' }, list);
    assertRoutePermission(AdminPaymentAutopayController.prototype.listForUser, { resource: 'payments', action: 'view' }, list);

    const cancelPath = 'users/:userId/provider-subscriptions/:providerSubscriptionRowId/cancel';
    const cancel = routeLabel(BASE_PATH, RequestMethod.POST, cancelPath);
    assertRoute(AdminPaymentAutopayController.prototype.cancelProviderSubscription, { method: RequestMethod.POST, path: cancelPath }, cancel);
    assertRoutePermission(AdminPaymentAutopayController.prototype.cancelProviderSubscription, { resource: 'payments', action: 'edit' }, cancel);

    const disablePath = 'users/:userId/yookassa/disable';
    const disable = routeLabel(BASE_PATH, RequestMethod.POST, disablePath);
    assertRoute(AdminPaymentAutopayController.prototype.disableYookassaAutopay, { method: RequestMethod.POST, path: disablePath }, disable);
    assertRoutePermission(AdminPaymentAutopayController.prototype.disableYookassaAutopay, { resource: 'payments', action: 'edit' }, disable);

    assertEveryRouteGuarded(AdminPaymentAutopayController);
  });
});

describe('the customer’s autopays on the user’s card', () => {
  it('lists the live provider autopays, whether a cancel waits for the provider, and the ЮKassa methods', async () => {
    const w = world({
      rows: [
        autopayRow('psub-live'),
        autopayRow('psub-marked', { cancelledBy: OPERATOR_CANCELLED_BY }),
        autopayRow('psub-refund', { cancelledBy: REFUND_CANCELLED_BY }),
        autopayRow('psub-gone', { status: ProviderSubscriptionStatus.CANCELLED, cancelledBy: 'CUSTOMER' }),
      ],
    });

    const autopay = await w.service.listForUser('user-1');

    assert.deepEqual(
      autopay.providerSubscriptions.map((row) => [row.id, row.cancelRequestedBy, row.planName]),
      [
        ['psub-live', null, 'Pro'],
        ['psub-marked', OPERATOR_CANCELLED_BY, 'Pro'],
        ['psub-refund', REFUND_CANCELLED_BY, 'Pro'],
      ],
    );
    assert.deepEqual(autopay.yookassaMethods.map((method) => method.id), ['pm-card'], 'a method of another gateway');
    await assert.rejects(w.service.listForUser('nobody'), NotFoundException);
  });
});

describe('«Отменить автосписание» of a provider subscription', () => {
  it('marks it, answers before the provider does, cancels it after, and tells the operator — not the customer', async () => {
    quiet();
    const w = world({ cancelHangs: true });
    let timer: NodeJS.Timeout | undefined;

    const answered = await Promise.race([
      w.service
        .cancelProviderSubscription({ userId: 'user-1', providerSubscriptionRowId: 'psub-1', currentAdmin: OPERATOR, requestMetadata: REQUEST })
        .then((result) => result.state),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('waited for the provider'), 1000);
      }),
    ]);
    clearTimeout(timer);

    try {
      assert.equal(answered, 'CANCELLING');
      assert.equal(w.rows[0]?.cancelledBy, OPERATOR_CANCELLED_BY, 'not marked before the answer: a lost cancel is lost');
      assert.equal(w.rows[0]?.status, ProviderSubscriptionStatus.ACTIVE);
      assert.equal(w.events.length, 0, 'the card went out before the provider said what it did');
      assert.equal(w.audits.length, 1);
      assert.equal(w.audits[0]?.action, 'payments.autopay.provider_subscription_cancelled');
      assert.deepEqual(w.audits[0]?.adminUser, { connect: { id: 'admin-1' } });
    } finally {
      w.release();
      await w.service.settleAfterResponse();
    }

    assert.equal(w.rows[0]?.status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(w.rows[0]?.cancelledBy, OPERATOR_CANCELLED_BY);
    assert.deepEqual(w.cancelCalls, ['https://app.platega.io/subscription/platega-psub-1/cancel']);
    assert.deepEqual(w.events.map((event) => event.type), ['payment.autopay_stopped_by_operator']);
    const card = w.events[0]?.metadata ?? {};
    assert.equal(card['adminId'], 'admin-1');
    assert.equal(card['providerSubscriptionId'], 'platega-psub-1');
    assert.equal(card['planName'], 'Pro');
    assert.match(String(card['note']), /^Автосписание отменено у Platega: новых списаний не будет\./);
    assert.match(String(card['note']), /Клиенту панель ничего не сообщала/);
    assert.equal(
      w.events.some((event) => event.type === 'payment.method_autopay_updated'),
      false,
      'the customer’s own event: a letter bound to it would say they did it',
    );
  });

  it('a provider that does not answer: the card says so, and the sweep finishes the cancel', async () => {
    quiet();
    const w = world({ providerDown: true });

    await w.service.cancelProviderSubscription({ userId: 'user-1', providerSubscriptionRowId: 'psub-1', currentAdmin: OPERATOR, requestMetadata: REQUEST });
    await w.service.settleAfterResponse();

    assert.equal(w.rows[0]?.status, ProviderSubscriptionStatus.ACTIVE);
    assert.equal(w.rows[0]?.cancelledBy, OPERATOR_CANCELLED_BY);
    assert.match(String(w.events[0]?.metadata['note']), /Отменить автосписание у Platega сразу не удалось: панель повторяет отмену каждые 10 минут/);

    assert.equal(
      strandedReason({
        operatorRequested: true,
        userDeleted: false,
        userBlocked: false,
        subscription: { status: 'ACTIVE', planId: 'plan-1' },
        planId: 'plan-1',
      }),
      STRANDED_BY_OPERATOR,
    );
  });

  it('leaves a refund’s cancel alone, answers a cancelled one as ended, and refuses another customer’s', async () => {
    quiet();
    const w = world({
      rows: [
        autopayRow('psub-refund', { cancelledBy: REFUND_CANCELLED_BY }),
        autopayRow('psub-gone', { status: ProviderSubscriptionStatus.CANCELLED }),
        autopayRow('psub-other', { userId: 'user-2' }),
      ],
    });

    const refund = await w.service.cancelProviderSubscription({ userId: 'user-1', providerSubscriptionRowId: 'psub-refund', currentAdmin: OPERATOR, requestMetadata: REQUEST });
    const gone = await w.service.cancelProviderSubscription({ userId: 'user-1', providerSubscriptionRowId: 'psub-gone', currentAdmin: OPERATOR, requestMetadata: REQUEST });
    await assert.rejects(
      w.service.cancelProviderSubscription({ userId: 'user-1', providerSubscriptionRowId: 'psub-other', currentAdmin: OPERATOR, requestMetadata: REQUEST }),
      NotFoundException,
    );
    await w.service.settleAfterResponse();

    assert.equal(refund.state, 'REFUND_ENDING');
    assert.equal(gone.state, 'ENDED');
    assert.equal(w.rows[0]?.cancelledBy, REFUND_CANCELLED_BY, 'the refund’s mark was written over');
    assert.equal(w.rows[2]?.cancelledBy, null);
    assert.deepEqual(w.cancelCalls, []);
    assert.deepEqual(w.audits, []);
    assert.deepEqual(w.events, []);
  });

  it('a stop never loses the card: it goes out saying the provider had not answered', async () => {
    quiet();
    const w = world({ cancelHangs: true });
    await w.service.cancelProviderSubscription({ userId: 'user-1', providerSubscriptionRowId: 'psub-1', currentAdmin: OPERATOR, requestMetadata: REQUEST });

    mock.timers.enable({ apis: ['setTimeout'] });
    const stop = w.service.onModuleDestroy();
    await Promise.resolve();
    mock.timers.tick(AFTER_RESPONSE_SHUTDOWN_WAIT_MS);
    await stop;
    mock.timers.reset();

    assert.equal(w.events.length, 1);
    assert.match(String(w.events[0]?.metadata['note']), /не успела завершиться до перезапуска панели/);
    w.release();
    await w.service.settleAfterResponse();
    assert.equal(w.events.length, 1, 'a second card once the provider answered');
  });
});

describe('«Выключить автосписание ЮKassa»', () => {
  it('switches every method off without waiting for a charge, then the busy one after the answer, and tells the operator once', async () => {
    quiet();
    const w = world();
    w.savedAnswers.push(
      { switched: [{ id: 'pm-card', methodType: 'bank_card', title: 'Visa •••• 4242' }], busy: 1 },
      { switched: [{ id: 'pm-sbp', methodType: 'sbp', title: 'СБП' }], busy: 0 },
    );

    const result = await w.service.disableYookassaAutopay({ userId: 'user-1', currentAdmin: OPERATOR, requestMetadata: REQUEST });

    assert.deepEqual(result, { switched: 1, pending: 1 });
    assert.deepEqual(w.savedAsks[0], { userId: 'user-1', waitForCharges: false }, 'the request waited for a charge');
    assert.equal(w.audits[0]?.action, 'payments.autopay.yookassa_disabled');
    await w.service.settleAfterResponse();
    assert.deepEqual(w.savedAsks[1], { userId: 'user-1', waitForCharges: true });
    assert.deepEqual(w.events.map((event) => event.type), ['payment.autopay_stopped_by_operator']);
    assert.equal(w.events[0]?.metadata['gatewayType'], PaymentGatewayType.YOOKASSA);
    assert.match(String(w.events[0]?.metadata['note']), /^Автосписание через ЮKassa выключено: Visa •••• 4242, СБП\./);
    assert.match(String(w.events[0]?.metadata['note']), /переключатель «Автосписание», и клиент может включить его снова/);
  });

  it('says nothing and writes nothing when there was nothing to switch off', async () => {
    const w = world();

    assert.deepEqual(await w.service.disableYookassaAutopay({ userId: 'user-1', currentAdmin: OPERATOR, requestMetadata: REQUEST }), {
      switched: 0,
      pending: 0,
    });
    await w.service.settleAfterResponse();
    assert.deepEqual(w.audits, []);
    assert.deepEqual(w.events, []);
  });

  it('a busy method whose switch then fails is on the card, with what to press', async () => {
    quiet();
    const w = world();
    w.savedAnswers.push({ switched: [], busy: 1 }, new Error('P2028'));

    await w.service.disableYookassaAutopay({ userId: 'user-1', currentAdmin: OPERATOR, requestMetadata: REQUEST });
    await w.service.settleAfterResponse();

    assert.match(String(w.events[0]?.metadata['note']), /выключить на нём автосписание потом не удалось/);
    assert.match(String(w.events[0]?.metadata['note']), /Нажмите «Выключить автосписание ЮKassa» в карточке клиента ещё раз\./);
  });
});

describe('the operator’s cancel, beside a refund’s', () => {
  it('the sweep retries an operator’s cancel, and a refund’s mark says more', () => {
    const base = { userDeleted: false, userBlocked: false, subscription: 'NOT_YET' as const, planId: 'plan-1' };
    assert.equal(strandedReason({ ...base, operatorRequested: true }), STRANDED_BY_OPERATOR);
    assert.equal(strandedReason({ ...base, operatorRequested: true, refundRequested: true }), STRANDED_BY_REFUND);
    assert.equal(strandedReason(base), null);
  });

  it('cancels a stranded operator’s row as the operator’s at the next sweep', async () => {
    quiet();
    const w = world({ rows: [autopayRow('psub-stranded', { cancelledBy: OPERATOR_CANCELLED_BY })] });
    const store = (w.providerSubscriptions as unknown as { prismaService: Record<string, Record<string, unknown>> }).prismaService;
    store['subscription'] = { findMany: async () => [{ id: 'sub-1', status: 'ACTIVE', planSnapshot: { id: 'plan-1' }, isTrial: false }] };
    store['transaction'] = { findMany: async () => [] };
    store['providerSubscription']['findMany'] = async () =>
      w.rows.filter((row) => row.status === ProviderSubscriptionStatus.ACTIVE).map((row) => ({ ...row, user: { isBlocked: false } }));

    assert.equal(await w.providerSubscriptions.cancelStranded(), 1);

    assert.equal(w.rows[0]?.status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(w.rows[0]?.cancelledBy, OPERATOR_CANCELLED_BY);
  });
});

describe('what the operator’s notes say', () => {
  it('each outcome of a provider cancel', () => {
    assert.match(describeOperatorProviderCancel('ROLLYPAY', { cancelled: [{ gatewayType: 'ROLLYPAY', providerSubscriptionId: 'r-1' }], failed: [] }), /Автосписание отменено у RollyPay/);
    assert.match(describeOperatorProviderCancel('PLATEGA', { cancelled: [], failed: [{ gatewayType: 'UNKNOWN', providerSubscriptionId: '' }] }), /Проверить автосписание не удалось/);
    assert.equal(describeOperatorProviderCancel('PLATEGA', { cancelled: [], failed: [] }), 'Автосписание уже было отменено раньше — отменять было нечего.');
    assert.equal(describeOperatorYookassaDisable([], { failed: false, interrupted: false }), 'Автосписание через ЮKassa уже было выключено.');
    assert.match(describeOperatorYookassaDisable([], { failed: false, interrupted: true }), /панель перезапустилась раньше/);
  });

  it('names the button and the cabinet’s switch as they are shown', () => {
    const card = readFileSync(resolve(__dirname, '..', 'web/src/i18n/features/userDetail.ru.ts'), 'utf8');
    assert.match(card, /yookassaDisable: 'Выключить автосписание ЮKassa'/);
    assert.match(card, /cancel: 'Отменить автосписание'/);
    const cabinet = resolve(__dirname, '..', '..', '..', 'reiwa', 'web', 'src', 'i18n', 'ru.ts');
    let cabinetDictionary: string | null;
    try {
      cabinetDictionary = readFileSync(cabinet, 'utf8');
    } catch {
      cabinetDictionary = null;
    }
    // The cabinet sits beside this repository on a developer's machine, and
    // not in CI; there, its words are pinned by the cabinet's own tests.
    if (cabinetDictionary !== null) {
      assert.match(cabinetDictionary, /paymentMethods: 'Способы оплаты'/);
      assert.match(cabinetDictionary, /autopay: 'Автосписание'/);
      assert.match(cabinetDictionary, /autopayCaption: 'для автоматического списания'/);
    }
  });
});
