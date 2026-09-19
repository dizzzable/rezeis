import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';

import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Currency, PurchaseType } from '@prisma/client';
import * as ts from 'typescript';

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
 * The last cases inventory every WRITE of a partner balance in `src/` — read
 * as TypeScript, whatever its shape: a `decrement`, an `increment` by a
 * negative amount, an assigned or computed value, raw SQL — so a third
 * customer-facing debit cannot appear without being classified, and neither can
 * a credit whose amount may be negative.
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
  const settings = {
    findUnique: async () => ({
      partnerSettings: { allowBalancePayment: true },
      defaultCurrency: Currency.RUB,
      platformPolicy: options.timezone === undefined ? {} : { timezone: options.timezone },
    }),
  };
  const tx = {
    authChallenge,
    partner,
    // The operator's minimum is read inside the withdrawal's own transaction.
    settings,
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
    settings,
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

/** How a write moves a partner balance. */
type BalanceWriteShape = 'decrement' | 'negative increment' | 'increment' | 'assigned value' | 'raw SQL';

/** The shapes that can take money OUT of a balance whatever the numbers. */
const DEBIT_SHAPES: ReadonlySet<BalanceWriteShape> = new Set(['decrement', 'negative increment', 'assigned value', 'raw SQL']);

/** Prisma delegate methods that write an EXISTING row's columns. `create` starts a balance, it moves none. */
const PARTNER_UPDATES = new Set(['update', 'updateMany', 'upsert']);

/** `-x`, `0 - x`, `-(a + b)`: an increment by something negative. */
function isNegative(expression: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expression)) return isNegative(expression.expression);
  if (ts.isPrefixUnaryExpression(expression)) return expression.operator === ts.SyntaxKind.MinusToken;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.MinusToken) {
    return ts.isNumericLiteral(expression.left) && Number(expression.left.text) === 0;
  }
  return false;
}

/** The shape of `balance: <value>` in the data of an update. */
function balanceShape(value: ts.Expression): BalanceWriteShape {
  if (!ts.isObjectLiteralExpression(value)) return 'assigned value';
  const operations = new Map<string, ts.Expression>();
  for (const property of value.properties) {
    if (!ts.isPropertyAssignment(property)) return 'assigned value';
    operations.set(property.name.getText(), property.initializer);
  }
  if (operations.has('decrement')) return 'decrement';
  const increment = operations.get('increment');
  if (increment !== undefined && operations.size === 1) return isNegative(increment) ? 'negative increment' : 'increment';
  return 'assigned value';
}

/** The method or function a node sits in — the unit the inventory names. */
function enclosingName(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if ((ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) && current.name !== undefined) {
      return current.name.getText();
    }
  }
  return '(top level)';
}

const RAW_PARTNER_BALANCE = /\b(?:UPDATE|INSERT\s+INTO)\s+"?partners"?\b[\s\S]*\bbalance\b/i;

/**
 * Every write of a partner balance in one file: through the Prisma delegate
 * (`<client>.partner.update|updateMany|upsert` with `balance` in what it
 * writes — including a spread, which could carry it) and through raw SQL (a
 * string or template, never a comment, naming the table and the column).
 */
function balanceWrites(fileName: string, text: string): Array<{ readonly method: string; readonly shape: BalanceWriteShape; readonly at: number }> {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: Array<{ method: string; shape: BalanceWriteShape; at: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const owner = node.expression.expression;
      const argument = node.arguments[0];
      if (
        PARTNER_UPDATES.has(node.expression.name.text) &&
        ts.isPropertyAccessExpression(owner) &&
        owner.name.text === 'partner' &&
        argument !== undefined &&
        ts.isObjectLiteralExpression(argument)
      ) {
        for (const property of argument.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const key = property.name.getText();
          if (key !== 'data' && key !== 'update') continue;
          const data = property.initializer;
          if (!ts.isObjectLiteralExpression(data)) {
            found.push({ method: enclosingName(node), shape: 'assigned value', at: node.getStart() });
            continue;
          }
          for (const field of data.properties) {
            if (ts.isSpreadAssignment(field)) {
              found.push({ method: enclosingName(node), shape: 'assigned value', at: field.getStart() });
            } else if (ts.isPropertyAssignment(field) && field.name.getText() === 'balance') {
              found.push({ method: enclosingName(node), shape: balanceShape(field.initializer), at: field.getStart() });
            } else if (ts.isShorthandPropertyAssignment(field) && field.name.text === 'balance') {
              found.push({ method: enclosingName(node), shape: 'assigned value', at: field.getStart() });
            }
          }
        }
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      if (RAW_PARTNER_BALANCE.test(node.getText())) found.push({ method: enclosingName(node), shape: 'raw SQL', at: node.getStart() });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('every write of a partner balance in src/ is classified', () => {
  const SRC = join(__dirname, '..', 'src');

  /**
   * The customer-initiated debits: each must run the shared hold check before
   * its write. Keyed `file#method#shape`.
   */
  const CUSTOMER_DEBITS: Readonly<Record<string, string>> = {
    'modules/partners/services/partners.service.ts#createWithdrawalRequest#decrement': 'a withdrawal request',
    'modules/payments/services/partner-balance-payment.service.ts#pay#decrement': 'a subscription paid with the balance',
  };
  /**
   * System-initiated: a commission clawed back when the payment it was earned
   * on is refunded. Nobody holding the account chooses it, so it is not money
   * leaving at anybody's request.
   */
  const SYSTEM_DEBITS: Readonly<Record<string, string>> = {
    'modules/partners/services/partner-earnings.service.ts#reverseEarningsForTransaction#decrement': 'refund clawback',
  };
  /**
   * Increments. Listed, not waved through: an increment by an amount that can
   * be negative IS a debit, and only a reading of the call site can tell.
   */
  const INCREMENTS: Readonly<Record<string, string>> = {
    'modules/account-merge/services/account-merge.service.ts#merge#increment':
      'an operator merging two accounts: the source balance moves to the survivor, and the source hold moves with it',
    'modules/partners/services/partner-earnings.service.ts#processPartnerEarning#increment': 'a commission earned',
    'modules/partners/services/partners.service.ts#applyBalanceAdjustment#increment':
      'an OPERATOR adjustment, signed: it may debit, by the operator and never the customer, so no hold check',
    'modules/partners/services/partners.service.ts#processWithdrawalWithBalanceMutation#increment': 'a rejected withdrawal handed back',
    'modules/payments/services/partner-balance-payment.service.ts#restoreBalanceAndReleaseTrial#increment':
      'a balance payment whose purchase failed, handed back',
    'modules/payments/services/partner-balance-payment.service.ts#settleOwedBalanceRestore#increment':
      'a hand-back that failed at the time, settled later',
  };

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
    });
  }

  it('reads every shape a debit can take — the inventory is only as good as its reader', () => {
    const shapesOf = (body: string): string[] =>
      balanceWrites('probe.ts', `async function probe(tx, amount, current) { ${body} }`).map((write) => write.shape);

    assert.deepEqual(shapesOf('await tx.partner.updateMany({ where: {}, data: { balance: { decrement: amount } } });'), ['decrement']);
    assert.deepEqual(shapesOf('await tx.partner.update({ where: {}, data: { balance: { increment: -amount } } });'), ['negative increment']);
    assert.deepEqual(shapesOf('await tx.partner.update({ where: {}, data: { balance: { increment: 0 - amount } } });'), ['negative increment']);
    assert.deepEqual(shapesOf('await tx.partner.update({ where: {}, data: { balance: current - amount } });'), ['assigned value']);
    assert.deepEqual(shapesOf('await tx.partner.update({ where: {}, data: { balance: { set: 0 } } });'), ['assigned value']);
    assert.deepEqual(shapesOf('await tx.partner.upsert({ where: {}, create: { balance: 0 }, update: { balance: { decrement: amount } } });'), ['decrement']);
    assert.deepEqual(shapesOf('await tx.partner.update({ where: {}, data: { ...patch } });'), ['assigned value']);
    assert.deepEqual(
      shapesOf('await tx.$executeRaw`UPDATE "partners" SET "balance" = "balance" - ${amount} WHERE "id" = ${current}`;'),
      ['raw SQL'],
    );
    assert.deepEqual(shapesOf('await tx.$executeRawUnsafe(\'UPDATE partners SET balance = balance - $1\', amount);'), ['raw SQL']);
    // A credit is still seen — and a new partner row moves no existing balance.
    assert.deepEqual(shapesOf('await tx.partner.update({ where: {}, data: { balance: { increment: amount } } });'), ['increment']);
    assert.deepEqual(shapesOf('await tx.partner.create({ data: { userId: current, balance: 0 } });'), []);
    // A comment that names the table and the column is not a write.
    assert.deepEqual(shapesOf('// UPDATE partners SET balance = 0 was the old way\n return amount;'), []);
  });

  it('finds exactly the known writes, and the customer debits check the hold first', () => {
    const found: string[] = [];
    const positions = new Map<string, number>();
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      const name = relative(SRC, file).split(sep).join('/');
      for (const write of balanceWrites(name, text)) {
        const key = `${name}#${write.method}#${write.shape}`;
        found.push(key);
        positions.set(key, write.at);
      }
    }
    assert.deepEqual(
      [...new Set(found)].sort(),
      [...Object.keys(CUSTOMER_DEBITS), ...Object.keys(SYSTEM_DEBITS), ...Object.keys(INCREMENTS)].sort(),
      'a write of a partner balance nobody classified — decide whether it is a customer debit (then it checks the recovery hold first), a system one, or a credit',
    );
    for (const key of [...Object.keys(CUSTOMER_DEBITS), ...Object.keys(SYSTEM_DEBITS)]) {
      assert.ok(DEBIT_SHAPES.has(key.split('#')[2] as BalanceWriteShape), `${key} is listed as a debit and is not one`);
    }
    assert.equal(found.filter((key) => key in CUSTOMER_DEBITS).length, Object.keys(CUSTOMER_DEBITS).length, 'a customer debit occurs twice');

    for (const key of Object.keys(CUSTOMER_DEBITS)) {
      const [file, method] = key.split('#');
      const text = readFileSync(join(SRC, file), 'utf8');
      const start = text.search(new RegExp(`public async ${method}\\(`));
      assert.ok(start >= 0, `${file}: ${method} not found`);
      const check = text.indexOf('await assertPartnerBalanceNotHeld(', start);
      const debit = positions.get(key) ?? -1;
      assert.ok(check > start && check < debit, `${file}: ${method} debits before it checks the recovery hold`);
    }
  });
});
