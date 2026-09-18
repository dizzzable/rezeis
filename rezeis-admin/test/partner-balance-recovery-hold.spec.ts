import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';

import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Currency, PurchaseType } from '@prisma/client';

import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SystemEventsService } from '../src/common/services/system-events.service';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { InternalPartnerController } from '../src/modules/partners/controllers/internal-partner.controller';
import { PartnerNotificationsService } from '../src/modules/partners/services/partner-notifications.service';
import { PartnersService } from '../src/modules/partners/services/partners.service';
import { PartnerBalancePaymentService } from '../src/modules/payments/services/partner-balance-payment.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PaymentsTransactionsService } from '../src/modules/payments/services/payments-transactions.service';
import { ProfileSyncQueueService } from '../src/modules/profile-sync/profile-sync-queue.service';
import { AccessModeGuard } from '../src/modules/settings/services/access-mode-guard.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';
import {
  RECOVERY_WITHDRAWAL_HOLD_PURPOSE,
  WITHDRAWAL_HOLD_ERROR_CODE,
} from '../src/modules/web-auth/utils/recovery-withdrawal-hold.util';

/**
 * The 72-hour hold after a password recovery by subscription link covers
 * EVERY way money leaves a partner balance
 * ════════════════════════════════════════════════════════════════════════
 * It used to be checked by the withdraw route alone, while paying for a
 * subscription with the balance spent the same `partners.balance` and never
 * asked. Now both debits run one shared check before they debit, both refuse
 * with the same code and end-of-hold, and the refusal is asserted where the
 * cabinet actually receives it: after `AdminSafeExceptionFilter`.
 *
 * The last case inventories every debit of a partner balance in `src/`, so a
 * third customer-facing one cannot appear without being classified.
 */

const USER_ID = 'user-held';
const PARTNER_ID = 'partner-held';
const TELEGRAM_ID = 700_001n;
const DAY_MS = 24 * 60 * 60 * 1000;

interface HoldRow {
  readonly userId: string;
  readonly purpose: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

/**
 * One database for both paths. `authChallenge.findFirst` honours the hold
 * query's `where`; every debit is recorded; anything else a path reaches for
 * is not modelled and fails loudly.
 */
function database(options: {
  readonly hold: Date | null;
  readonly balance?: number;
  /** The operator's zone in Settings → Branding; absent = never set. */
  readonly timezone?: string;
}) {
  const holds: HoldRow[] =
    options.hold === null
      ? []
      : [{ userId: USER_ID, purpose: RECOVERY_WITHDRAWAL_HOLD_PURPOSE, expiresAt: options.hold, consumedAt: null }];
  const partnerRow = {
    id: PARTNER_ID,
    userId: USER_ID,
    isActive: true,
    balance: options.balance ?? 50_000,
    totalEarned: 90_000,
    totalWithdrawn: 40_000,
    createdAt: new Date(Date.now() - 30 * DAY_MS),
  };
  const debits: Array<{ where: unknown; amount: number }> = [];
  const withdrawalsCreated: unknown[] = [];

  const authChallenge = {
    findFirst: async (args: {
      where: { purpose?: string; consumedAt?: null; expiresAt?: { gt?: Date }; webAccount?: { userId?: string } };
    }) => {
      const { where } = args;
      assert.deepEqual(Object.keys(where).sort(), ['consumedAt', 'expiresAt', 'purpose', 'webAccount']);
      const live = holds
        .filter(
          (hold) =>
            hold.purpose === where.purpose &&
            hold.consumedAt === null &&
            where.expiresAt?.gt !== undefined &&
            hold.expiresAt > where.expiresAt.gt &&
            hold.userId === where.webAccount?.userId,
        )
        .sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime());
      return live[0] === undefined ? null : { expiresAt: live[0].expiresAt };
    },
  };
  const partner = {
    findUnique: async (args: { where: { id?: string; userId?: string }; select?: Record<string, boolean> }) => {
      const matches = args.where.id === PARTNER_ID || args.where.userId === USER_ID;
      return matches ? { ...partnerRow } : null;
    },
    updateMany: async (args: { where: { id: string; balance?: { gte?: number } }; data: { balance: { decrement: number } } }) => {
      const floor = args.where.balance?.gte ?? 0;
      if (args.where.id !== PARTNER_ID || partnerRow.balance < floor) return { count: 0 };
      partnerRow.balance -= args.data.balance.decrement;
      debits.push({ where: args.where, amount: args.data.balance.decrement });
      return { count: 1 };
    },
  };
  const tx = {
    authChallenge,
    partner,
    partnerWithdrawal: {
      create: async (args: { data: Record<string, unknown> }) => {
        withdrawalsCreated.push(args.data);
        return {
          id: 'withdrawal-1',
          ...args.data,
          adminComment: null,
          processedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          partner: { id: PARTNER_ID, userId: USER_ID, user: { id: USER_ID, name: 'Held', username: null, telegramId: TELEGRAM_ID } },
        };
      },
    },
  };
  const prisma = {
    authChallenge,
    partner,
    user: {
      findUnique: async (args: { where: { telegramId?: bigint; id?: string } }) =>
        args.where.telegramId === TELEGRAM_ID || args.where.id === USER_ID
          ? { id: USER_ID, points: 0, partnerBalanceCurrencyOverride: null }
          : null,
      findFirst: async () => ({ isBlocked: false }),
    },
    settings: {
      findUnique: async () => ({
        partnerSettings: { allowBalancePayment: true },
        defaultCurrency: Currency.RUB,
        platformPolicy: options.timezone === undefined ? {} : { timezone: options.timezone },
      }),
    },
    referral: { findUnique: async () => null },
    $transaction: async <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => work(tx),
  };
  return { prisma, debits, withdrawalsCreated, partnerRow };
}

async function withdrawController(db: ReturnType<typeof database>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [InternalPartnerController],
    providers: [
      PartnersService,
      { provide: PrismaService, useValue: db.prisma },
      { provide: SystemEventsService, useValue: { info: () => undefined } },
      { provide: PartnerNotificationsService, useValue: {} },
    ],
  })
    .overrideGuard(InternalAdminAuthGuard)
    .useValue({ canActivate: () => true })
    .compile();
  return moduleRef.get(InternalPartnerController);
}

async function balancePayment(db: ReturnType<typeof database>) {
  const drafts: unknown[] = [];
  const moduleRef = await Test.createTestingModule({
    providers: [
      PartnerBalancePaymentService,
      { provide: PrismaService, useValue: db.prisma },
      {
        provide: SettingsService,
        useValue: {
          getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC', defaultCurrency: Currency.RUB }),
          getPartnerSettings: async () => ({ allowBalancePayment: true }),
        },
      },
      { provide: AccessModeGuard, useValue: { evaluate: () => null } },
      {
        provide: PaymentsTransactionsService,
        useValue: {
          createCheckoutDraft: async (input: unknown) => {
            drafts.push(input);
            throw new Error('the draft is not modelled: a held balance must be refused before it');
          },
        },
      },
      { provide: PaymentSubscriptionMutationService, useValue: {} },
      { provide: ProfileSyncQueueService, useValue: {} },
      { provide: SystemEventsService, useValue: { info: () => undefined } },
    ],
  }).compile();
  return { service: moduleRef.get(PartnerBalancePaymentService), drafts };
}

/** The body `AdminSafeExceptionFilter` writes for this exception — what the cabinet receives. */
function wireBody(error: unknown, path: string): Record<string, unknown> {
  let body: Record<string, unknown> | undefined;
  const response = { status: () => ({ json: (payload: Record<string, unknown>) => void (body = payload) }) };
  const request = { headers: {}, ip: '127.0.0.1', socket: {}, originalUrl: path, url: path };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  new AdminSafeExceptionFilter().catch(error, host);
  assert.ok(body !== undefined, 'the filter wrote no body');
  return body;
}

async function refusalOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected a refusal, the call went through');
}

describe('the recovery hold covers every way money leaves a partner balance', () => {
  const holdUntil = new Date(Date.now() + 2 * DAY_MS);
  const expectedMessage = `The partner balance is on hold until ${holdUntil.toISOString()} after an account recovery`;

  it('refuses a withdrawal request before its debit', async () => {
    const db = database({ hold: holdUntil });
    const controller = await withdrawController(db);

    const refusal = await refusalOf(() =>
      controller.withdraw(String(TELEGRAM_ID), { amount: 10_000, method: 'card', requisites: '4242' }),
    );

    assert.ok(refusal instanceof BadRequestException, `not a 400: ${String(refusal)}`);
    assert.deepEqual(db.debits, [], 'the balance was debited during the hold');
    assert.deepEqual(db.withdrawalsCreated, []);
    assert.equal(db.partnerRow.balance, 50_000);
  });

  it('refuses paying with the balance before the draft and before the debit', async () => {
    const db = database({ hold: holdUntil });
    const { service, drafts } = await balancePayment(db);

    const refusal = await refusalOf(() =>
      service.pay({ userId: USER_ID, purchaseType: PurchaseType.NEW, planId: 'plan-1', durationDays: 30 }),
    );

    assert.ok(refusal instanceof BadRequestException, `not a 400: ${String(refusal)}`);
    assert.deepEqual(drafts, [], 'a draft was reserved for a held balance');
    assert.deepEqual(db.debits, []);
  });

  it('answers both with the same code and end of hold — as the cabinet receives them, after the filter', async () => {
    const withdrawDb = database({ hold: holdUntil });
    const withdrawRefusal = await refusalOf(async () =>
      (await withdrawController(withdrawDb)).withdraw(String(TELEGRAM_ID), {
        amount: 10_000,
        method: 'card',
        requisites: '4242',
      }),
    );
    const payDb = database({ hold: holdUntil });
    const payRefusal = await refusalOf(async () =>
      (await balancePayment(payDb)).service.pay({
        userId: USER_ID,
        purchaseType: PurchaseType.RENEW,
        planId: 'plan-1',
        durationDays: 30,
      }),
    );

    const onWithdraw = wireBody(withdrawRefusal, '/api/internal/user/700001/partner/withdraw');
    const onPay = wireBody(payRefusal, '/api/internal/payments/partner-balance/checkout');
    for (const body of [onWithdraw, onPay]) {
      // Key for key: the cabinet replays exactly this body through its own
      // transport and routes (`reiwa/test/api/partner-balance-hold-route.test.ts`).
      assert.deepEqual(Object.keys(body).sort(), [
        'code',
        'error',
        'errorCode',
        'holdUntil',
        'message',
        'path',
        'requestId',
        'statusCode',
        'timestamp',
      ]);
      assert.equal(body.statusCode, 400);
      assert.equal(body.code, WITHDRAWAL_HOLD_ERROR_CODE);
      assert.equal(body.errorCode, WITHDRAWAL_HOLD_ERROR_CODE);
      assert.equal(body.holdUntil, holdUntil.toISOString());
      assert.equal(body.message, expectedMessage);
    }
  });

  it('lets both through once the hold has ended', async () => {
    const ended = new Date(Date.now() - 1000);
    const withdrawDb = database({ hold: ended });
    await (await withdrawController(withdrawDb)).withdraw(String(TELEGRAM_ID), {
      amount: 10_000,
      method: 'card',
      requisites: '4242',
    });
    assert.deepEqual(withdrawDb.debits.map((debit) => debit.amount), [10_000]);

    const payDb = database({ hold: ended });
    const { service, drafts } = await balancePayment(payDb);
    await refusalOf(() =>
      service.pay({ userId: USER_ID, purchaseType: PurchaseType.NEW, planId: 'plan-1', durationDays: 30 }),
    );
    assert.equal(drafts.length, 1, 'with no hold the payment went on to price the purchase');
  });
});

describe('the partner info tells the cabinet about the hold before anybody presses a button', () => {
  it('carries the end of the hold and the operator’s time zone while the hold stands', async () => {
    const holdUntil = new Date(Date.now() + 2 * DAY_MS);
    const controller = await withdrawController(database({ hold: holdUntil, timezone: 'Europe/Moscow' }));

    const info = await controller.getInfo(String(TELEGRAM_ID));

    assert.deepEqual(info?.balanceHold, { until: holdUntil.toISOString(), timezone: 'Europe/Moscow' });
    assert.equal(info?.balancePaymentEnabled, true, 'the neighbouring flag still says what it said');
  });

  it('says the zone is not set when the operator never chose one — the cabinet then labels the time UTC', async () => {
    const holdUntil = new Date(Date.now() + DAY_MS);
    const controller = await withdrawController(database({ hold: holdUntil }));

    const info = await controller.getInfo(String(TELEGRAM_ID));

    assert.deepEqual(info?.balanceHold, { until: holdUntil.toISOString(), timezone: null });
  });

  it('sends null, not nothing, once the hold has ended', async () => {
    const controller = await withdrawController(database({ hold: new Date(Date.now() - 1000), timezone: 'Europe/Moscow' }));

    const info = await controller.getInfo(String(TELEGRAM_ID));

    assert.ok(info !== null && 'balanceHold' in info);
    assert.equal(info.balanceHold, null);
  });
});

describe('the filter forwards the end of the hold only for this code, and only as an instant', () => {
  const run = (body: Record<string, unknown>) => wireBody(new BadRequestException(body), '/api/internal/x');

  it('drops a holdUntil that is not an exact ISO instant', () => {
    for (const holdUntil of ['tomorrow', '2026-09-21', '2026-09-21T12:00:00Z', '<script>', 42]) {
      const body = run({ message: 'x', code: WITHDRAWAL_HOLD_ERROR_CODE, holdUntil });
      assert.equal(body.code, WITHDRAWAL_HOLD_ERROR_CODE);
      assert.equal(body.holdUntil, undefined, String(holdUntil));
    }
  });

  it('drops a holdUntil riding on any other code', () => {
    const body = run({ message: 'x', code: 'SUBSCRIPTION_LIMIT_REACHED', holdUntil: new Date().toISOString() });
    assert.equal(body.code, 'SUBSCRIPTION_LIMIT_REACHED');
    assert.equal(body.holdUntil, undefined);
  });
});

describe('every debit of a partner balance in src/ is classified', () => {
  const SRC = join(__dirname, '..', 'src');

  /** The customer-initiated debits: each must run the shared hold check before its decrement. */
  const CUSTOMER_DEBITS: Readonly<Record<string, string>> = {
    'modules/partners/services/partners.service.ts': 'createWithdrawalRequest',
    'modules/payments/services/partner-balance-payment.service.ts': 'pay',
  };
  /**
   * System-initiated: a commission clawed back when the payment it was earned
   * on is refunded. Nobody holding the account chooses it, so it is not money
   * leaving at anybody's request.
   */
  const SYSTEM_DEBITS: Readonly<Record<string, string>> = {
    'modules/partners/services/partner-earnings.service.ts': 'refund clawback',
  };

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
    });
  }

  it('finds exactly the known debits, and the customer ones check the hold first', () => {
    const found: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      if (!/balance:\s*\{\s*decrement/.test(text)) continue;
      found.push(relative(SRC, file).split(sep).join('/'));
    }
    assert.deepEqual(found.sort(), [...Object.keys(CUSTOMER_DEBITS), ...Object.keys(SYSTEM_DEBITS)].sort());

    for (const [file, method] of Object.entries(CUSTOMER_DEBITS)) {
      const text = readFileSync(join(SRC, file), 'utf8');
      const start = text.search(new RegExp(`public async ${method}\\(`));
      assert.ok(start >= 0, `${file}: ${method} not found`);
      const check = text.indexOf('await assertPartnerBalanceNotHeld(', start);
      const debit = text.slice(start).search(/balance:\s*\{\s*decrement/) + start;
      assert.ok(check > start && check < debit, `${file}: ${method} debits before it checks the recovery hold`);
    }
  });
});
