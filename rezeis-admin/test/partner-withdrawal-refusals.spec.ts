import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HttpException, type ArgumentsHost } from '@nestjs/common';

import {
  AdminSafeExceptionFilter,
  CODES_CARRYING_MIN_WITHDRAWAL_AMOUNT,
  SAFE_PRODUCT_CODES,
} from '../src/common/filters/admin-safe-exception.filter';
import { InternalPartnerController } from '../src/modules/partners/controllers/internal-partner.controller';
import { PartnersService } from '../src/modules/partners/services/partners.service';
import {
  PARTNER_NOT_ACTIVE_CODE,
  PARTNER_NOT_FOUND_CODE,
  PARTNER_PROGRAM_INVITED_ONLY_CODE,
  readMinWithdrawalAmount,
  WITHDRAWAL_BELOW_MINIMUM_CODE,
  WITHDRAWAL_INSUFFICIENT_BALANCE_CODE,
} from '../src/modules/partners/utils/partner-withdrawal-rules';

/**
 * A partner withdrawal request, refused — as the cabinet receives each refusal,
 * after `AdminSafeExceptionFilter` — and the operator's minimum, enforced.
 * ═════════════════════════════════════════════════════════════════════════
 * Two things were wrong, and both reached the customer as "failed":
 *
 *   - «Правила вывода» → «Минимальная сумма вывода (копейки)» was stored and
 *     never applied. The form even promised a default of 500 ₽ that did not
 *     exist. The minimum is now read in the transaction that debits, before the
 *     debit, and a request below it is refused with the minimum on the wire;
 *     the partner info carries it too, so the cabinet can say it up front.
 *   - The internal withdraw route answered three refusals with a 2xx `{ error }`
 *     body (an unknown user, a user who is not a partner, the invited-only
 *     program), and the service's own three reached the cabinet as bare 400s.
 *     Each is now an HTTP error with an allowlisted `code`.
 *
 * The REAL controller, the REAL service and the REAL filter, over a fake Prisma
 * that holds rows and records the order of its calls. A double that only
 * counts calls cannot tell "nothing was written" from "the writer was never
 * wired", so every refusal below is checked against rows, and the first
 * describe proves the same fake records a withdrawal when one is made.
 */

const TELEGRAM_ID = 424_242n;
const USER_ID = 'user-1';
const PARTNER_ID = 'partner-1';
const OPENING_BALANCE = 80_000;
/** Deliberately not round and not the old «500 ₽» hint, so no default can pass for it. */
const MINIMUM = 30_700;

interface Fixture {
  readonly partnerSettings?: unknown;
  readonly user?: boolean;
  readonly partner?: boolean;
  readonly isActive?: boolean;
  readonly balance?: number;
  readonly invited?: boolean;
  readonly currencyOverride?: string | null;
}

function database(fixture: Fixture = {}) {
  const calls: Array<{ op: string; tx: boolean }> = [];
  const withdrawals: Array<Record<string, unknown>> = [];
  const events: unknown[] = [];
  const partnerRow = {
    id: PARTNER_ID,
    userId: USER_ID,
    isActive: fixture.isActive ?? true,
    balance: fixture.balance ?? OPENING_BALANCE,
    totalEarned: 120_000,
    totalWithdrawn: 40_000,
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  };
  // A call counts as inside the transaction only when it is made on the client
  // the transaction HANDED to its callback — as with Prisma, where the outer
  // client used inside the callback runs on another connection, outside it.
  const record = (op: string, tx: boolean) => calls.push({ op, tx });
  const project = (row: Record<string, unknown>, select?: Record<string, unknown>) =>
    select ? Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]])) : { ...row };
  const hasPartner = fixture.partner ?? true;

  const delegates = (tx: boolean) => ({
    user: {
      findUnique: async (args: { where: { telegramId?: bigint; id?: string }; select?: Record<string, unknown> }) => {
        record('user.findUnique', tx);
        if (fixture.user === false) return null;
        const row = { id: USER_ID, points: 0, partnerBalanceCurrencyOverride: fixture.currencyOverride ?? null };
        if (args.where.telegramId !== undefined && args.where.telegramId !== TELEGRAM_ID) return null;
        if (args.where.id !== undefined && args.where.id !== USER_ID) return null;
        return project(row, args.select);
      },
    },
    partner: {
      findUnique: async (args: { where: { id?: string; userId?: string }; select?: Record<string, unknown> }) => {
        record('partner.findUnique', tx);
        if (!hasPartner) return null;
        const matches = args.where.id === PARTNER_ID || args.where.userId === USER_ID;
        return matches ? project(partnerRow, args.select) : null;
      },
      updateMany: async (args: {
        where: { id?: string; isActive?: boolean; balance?: { gte?: number } };
        data: { balance: { decrement: number } };
      }) => {
        record('partner.updateMany', tx);
        const matched =
          hasPartner &&
          args.where.id === PARTNER_ID &&
          (args.where.isActive === undefined || partnerRow.isActive === args.where.isActive) &&
          partnerRow.balance >= (args.where.balance?.gte ?? 0);
        if (!matched) return { count: 0 };
        partnerRow.balance -= args.data.balance.decrement;
        return { count: 1 };
      },
    },
    partnerWithdrawal: {
      create: async (args: { data: Record<string, unknown> }) => {
        record('partnerWithdrawal.create', tx);
        const row = {
          id: `w-${withdrawals.length + 1}`,
          ...args.data,
          adminComment: null,
          processedBy: null,
          processedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          partner: { id: PARTNER_ID, isActive: true, user: null },
        };
        withdrawals.push(row);
        return row;
      },
    },
    settings: {
      findUnique: async (args: { where: { id?: number }; select?: Record<string, unknown> }) => {
        record('settings.findUnique', tx);
        assert.equal(args.where.id, 1);
        return project(
          {
            partnerSettings: fixture.partnerSettings ?? {},
            defaultCurrency: 'RUB',
            platformPolicy: {},
          },
          args.select,
        );
      },
    },
    referral: {
      findUnique: async () => {
        record('referral.findUnique', tx);
        return fixture.invited === false ? null : { id: 'edge-1' };
      },
    },
    authChallenge: {
      findFirst: async () => {
        record('authChallenge.findFirst', tx);
        return null;
      },
    },
  });
  const client = {
    ...delegates(false),
    $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
      record('$transaction.begin', true);
      const balanceBefore = partnerRow.balance;
      const rowsBefore = withdrawals.length;
      try {
        const out = await work(delegates(true));
        record('$transaction.commit', true);
        return out;
      } catch (error: unknown) {
        partnerRow.balance = balanceBefore;
        withdrawals.length = rowsBefore;
        record('$transaction.rollback', true);
        throw error;
      }
    },
  };
  const service = new PartnersService(
    client as never,
    { info: (...args: unknown[]) => void events.push(args) } as never,
    {} as never,
  );
  const controller = new InternalPartnerController(client as never, service);
  return { controller, calls, withdrawals, events, partnerRow };
}

type Db = ReturnType<typeof database>;

function ask(db: Db, amount: number) {
  return db.controller.withdraw(String(TELEGRAM_ID), { amount, method: 'card', requisites: '2200 1234 5678 9012' });
}

/** The body the filter writes for this exception — what the cabinet receives. */
function wireBody(error: unknown): Record<string, unknown> {
  let body: Record<string, unknown> | undefined;
  let status: number | undefined;
  const response = {
    status: (code: number) => {
      status = code;
      return { json: (payload: Record<string, unknown>) => void (body = payload) };
    },
  };
  const request = { headers: {}, ip: '127.0.0.1', socket: {}, originalUrl: '/api/internal/user/424242/partner/withdraw', url: '/x' };
  const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }) } as unknown as ArgumentsHost;
  new AdminSafeExceptionFilter().catch(error, host);
  assert.ok(body !== undefined, 'the filter wrote no body');
  assert.equal(status, body.statusCode);
  return body;
}

/** The refusal of `run` as the cabinet receives it. A call that went through fails the test. */
async function refusedOnTheWire(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  let answer: unknown;
  try {
    answer = await run();
  } catch (error: unknown) {
    assert.ok(error instanceof HttpException, `not an HTTP error: ${String(error)}`);
    return wireBody(error);
  }
  assert.fail(`expected a refusal, the call answered ${JSON.stringify(answer)}`);
}

function assertNothingMoved(db: Db, balance = OPENING_BALANCE): void {
  assert.equal(db.partnerRow.balance, balance, 'the balance moved');
  assert.deepEqual(db.withdrawals, [], 'a withdrawal row was left behind');
  assert.deepEqual(db.events, [], 'an event was emitted');
}

describe('control: this fake records a withdrawal when one is made', () => {
  it('a legal request creates the row, moves the balance and emits the event', async () => {
    const db = database();

    const created = await ask(db, 12_345);

    assert.equal(created.amount, 12_345);
    assert.equal(db.withdrawals.length, 1);
    assert.equal(db.partnerRow.balance, OPENING_BALANCE - 12_345);
    assert.equal(db.events.length, 1);
  });
});

describe('the operator’s minimum is enforced', () => {
  it('refuses below it with the code and the minimum, and moves nothing', async () => {
    const db = database({ partnerSettings: { minWithdrawalAmount: MINIMUM } });

    const body = await refusedOnTheWire(() => ask(db, MINIMUM - 1));

    assert.equal(body.statusCode, 422);
    assert.equal(body.code, WITHDRAWAL_BELOW_MINIMUM_CODE);
    assert.equal(body.errorCode, WITHDRAWAL_BELOW_MINIMUM_CODE);
    assert.equal(body.minWithdrawalAmount, MINIMUM);
    assert.deepEqual(Object.keys(body).sort(), [
      'code',
      'error',
      'errorCode',
      'message',
      'minWithdrawalAmount',
      'path',
      'requestId',
      'statusCode',
      'timestamp',
    ]);
    assertNothingMoved(db);
    assert.equal(db.calls.some((call) => call.op === 'partner.updateMany'), false, 'the debit was attempted');
  });

  it('takes exactly the minimum, and more', async () => {
    const atMinimum = database({ partnerSettings: { minWithdrawalAmount: MINIMUM } });
    assert.equal((await ask(atMinimum, MINIMUM)).amount, MINIMUM);
    assert.equal(atMinimum.partnerRow.balance, OPENING_BALANCE - MINIMUM);

    const above = database({ partnerSettings: { minWithdrawalAmount: MINIMUM } });
    assert.equal((await ask(above, MINIMUM + 1)).amount, MINIMUM + 1);
  });

  it('reads it first inside the transaction that debits, never before it', async () => {
    const db = database({ partnerSettings: { minWithdrawalAmount: MINIMUM } });

    await ask(db, MINIMUM);

    const inside = db.calls.filter((call) => call.tx).map((call) => call.op);
    assert.deepEqual(inside, [
      '$transaction.begin',
      'settings.findUnique',
      'partner.updateMany',
      'partnerWithdrawal.create',
      '$transaction.commit',
    ]);
    // Outside it, the settings are read once: the controller's invited-only
    // gate, before the service runs. A minimum read there too would be a second.
    const outside = db.calls.filter((call) => !call.tx).map((call) => call.op);
    assert.equal(outside.filter((op) => op === 'settings.findUnique').length, 1);
  });

  it('is judged before the balance: a request below it is told the minimum, not "insufficient"', async () => {
    const db = database({ partnerSettings: { minWithdrawalAmount: MINIMUM }, balance: 100 });

    const body = await refusedOnTheWire(() => ask(db, 200));

    assert.equal(body.code, WITHDRAWAL_BELOW_MINIMUM_CODE);
    assertNothingMoved(db, 100);
  });

  it('reads the older form of the field, digits sent as a string', async () => {
    const db = database({ partnerSettings: { minWithdrawalAmount: String(MINIMUM) } });

    const body = await refusedOnTheWire(() => ask(db, MINIMUM - 1));

    assert.equal(body.code, WITHDRAWAL_BELOW_MINIMUM_CODE);
    assert.equal(body.minWithdrawalAmount, MINIMUM);
  });

  for (const [label, partnerSettings] of [
    ['a fresh install ({})', {}],
    ['a cleared field (null)', { minWithdrawalAmount: null }],
    ['zero', { minWithdrawalAmount: 0 }],
    ['a negative number', { minWithdrawalAmount: -500 }],
    ['junk', { minWithdrawalAmount: 'пятьсот' }],
    ['an object', { minWithdrawalAmount: { value: 500 } }],
  ] as const) {
    it(`is no minimum at all for ${label}: one minor unit goes through, and the info says 0`, async () => {
      const db = database({ partnerSettings });

      assert.equal((await ask(db, 1)).amount, 1);
      const info = await database({ partnerSettings }).controller.getInfo(String(TELEGRAM_ID));
      assert.equal(info?.minWithdrawalAmount, 0);
    });
  }
});

describe('every refusal is an HTTP error with its code — never a 2xx `{ error }` body', () => {
  it('an unknown user: 409 PARTNER_NOT_FOUND', async () => {
    const body = await refusedOnTheWire(() => ask(database({ user: false }), 5_000));
    assert.equal(body.statusCode, 409);
    assert.equal(body.code, PARTNER_NOT_FOUND_CODE);
  });

  it('a user who is not a partner: 409 PARTNER_NOT_FOUND', async () => {
    const db = database({ partner: false });
    const body = await refusedOnTheWire(() => ask(db, 5_000));
    assert.equal(body.statusCode, 409);
    assert.equal(body.code, PARTNER_NOT_FOUND_CODE);
    assert.deepEqual(db.withdrawals, []);
  });

  it('the program open to invited users only: 409 PARTNER_PROGRAM_INVITED_ONLY', async () => {
    const db = database({ partnerSettings: { invitedOnly: true }, invited: false });
    const body = await refusedOnTheWire(() => ask(db, 5_000));
    assert.equal(body.statusCode, 409);
    assert.equal(body.code, PARTNER_PROGRAM_INVITED_ONLY_CODE);
    assertNothingMoved(db);
  });

  it('a partner the operator switched off: 409 PARTNER_NOT_ACTIVE', async () => {
    const db = database({ isActive: false });
    const body = await refusedOnTheWire(() => ask(db, 5_000));
    assert.equal(body.statusCode, 409);
    assert.equal(body.code, PARTNER_NOT_ACTIVE_CODE);
    assert.equal(body.message, 'Partner is not active');
    assertNothingMoved(db);
  });

  it('more than the balance: 422 WITHDRAWAL_INSUFFICIENT_BALANCE', async () => {
    const db = database();
    const body = await refusedOnTheWire(() => ask(db, OPENING_BALANCE + 1));
    assert.equal(body.statusCode, 422);
    assert.equal(body.code, WITHDRAWAL_INSUFFICIENT_BALANCE_CODE);
    assert.equal(body.message, 'Insufficient partner balance');
    assertNothingMoved(db);
  });

  it('uses no 401 or 403 for any of them — the cabinet reads those as its own token refused', async () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['unknown user', () => ask(database({ user: false }), 5_000)],
      ['not a partner', () => ask(database({ partner: false }), 5_000)],
      ['invited only', () => ask(database({ partnerSettings: { invitedOnly: true }, invited: false }), 5_000)],
      ['switched off', () => ask(database({ isActive: false }), 5_000)],
      ['insufficient', () => ask(database(), OPENING_BALANCE + 1)],
      ['below the minimum', () => ask(database({ partnerSettings: { minWithdrawalAmount: MINIMUM } }), 1)],
    ];
    const statuses: Record<string, unknown> = {};
    for (const [label, run] of cases) statuses[label] = (await refusedOnTheWire(run)).statusCode;
    assert.deepEqual(statuses, {
      'unknown user': 409,
      'not a partner': 409,
      'invited only': 409,
      'switched off': 409,
      insufficient: 422,
      'below the minimum': 422,
    });
  });

  it('carries no minimum on any refusal but the minimum’s', async () => {
    const db = database({ partnerSettings: { minWithdrawalAmount: MINIMUM }, isActive: false });
    const body = await refusedOnTheWire(() => ask(db, MINIMUM));
    assert.equal(body.code, PARTNER_NOT_ACTIVE_CODE);
    assert.equal('minWithdrawalAmount' in body, false);
  });
});

describe('the partner info says the minimum and the currency before anybody asks', () => {
  it('the minimum in minor units, and the balance currency, override first', async () => {
    const info = await database({
      partnerSettings: { minWithdrawalAmount: MINIMUM },
      currencyOverride: 'USD',
    }).controller.getInfo(String(TELEGRAM_ID));

    assert.equal(info?.minWithdrawalAmount, MINIMUM);
    assert.equal(info?.balanceCurrency, 'USD');
  });

  it('the operator’s default currency without an override', async () => {
    const info = await database().controller.getInfo(String(TELEGRAM_ID));
    assert.equal(info?.balanceCurrency, 'RUB');
  });
});

describe('the filter forwards the minimum only for its code, and only as a whole number', () => {
  const run = (body: Record<string, unknown>) => wireBody(new HttpException(body, 400));

  it('forwards a safe whole number on WITHDRAWAL_BELOW_MINIMUM', () => {
    const body = run({ message: 'x', code: WITHDRAWAL_BELOW_MINIMUM_CODE, minWithdrawalAmount: 0 });
    assert.equal(body.minWithdrawalAmount, 0);
  });

  it('drops anything that is not one', () => {
    for (const minWithdrawalAmount of ['30700', 307.5, -1, Number.NaN, 2 ** 60, { v: 1 }, null]) {
      const body = run({ message: 'x', code: WITHDRAWAL_BELOW_MINIMUM_CODE, minWithdrawalAmount });
      assert.equal(body.code, WITHDRAWAL_BELOW_MINIMUM_CODE);
      assert.equal('minWithdrawalAmount' in body, false, String(minWithdrawalAmount));
    }
  });

  it('drops it riding on any other code', () => {
    const body = run({ message: 'x', code: 'SUBSCRIPTION_LIMIT_REACHED', minWithdrawalAmount: MINIMUM });
    assert.equal(body.code, 'SUBSCRIPTION_LIMIT_REACHED');
    assert.equal('minWithdrawalAmount' in body, false);
  });

  it('carries it only for codes that are themselves allowlisted', () => {
    assert.ok(CODES_CARRYING_MIN_WITHDRAWAL_AMOUNT.size > 0);
    for (const code of CODES_CARRYING_MIN_WITHDRAWAL_AMOUNT) {
      assert.equal(SAFE_PRODUCT_CODES.has(code), true, `${code} carries the minimum but is not a safe product code`);
    }
    for (const code of [
      PARTNER_NOT_FOUND_CODE,
      PARTNER_PROGRAM_INVITED_ONLY_CODE,
      PARTNER_NOT_ACTIVE_CODE,
      WITHDRAWAL_INSUFFICIENT_BALANCE_CODE,
      WITHDRAWAL_BELOW_MINIMUM_CODE,
    ]) {
      assert.equal(SAFE_PRODUCT_CODES.has(code), true, `${code} is stripped by the filter`);
    }
  });
});

describe('readMinWithdrawalAmount', () => {
  it('reads whole numbers and digit strings, and nothing else', () => {
    assert.equal(readMinWithdrawalAmount({ minWithdrawalAmount: 50_000 }), 50_000);
    assert.equal(readMinWithdrawalAmount({ minWithdrawalAmount: '50000' }), 50_000);
    assert.equal(readMinWithdrawalAmount({ minWithdrawalAmount: ' 700 ' }), 700);
    assert.equal(readMinWithdrawalAmount({ minWithdrawalAmount: 499.9 }), 499);
    assert.equal(readMinWithdrawalAmount({ minWithdrawalAmount: 1e12 }), 2_147_483_647);
    for (const junk of [undefined, null, 0, -1, '', '5e4', '-5', 'abc', [], {}, true, Number.POSITIVE_INFINITY]) {
      assert.equal(readMinWithdrawalAmount({ minWithdrawalAmount: junk }), 0, String(junk));
    }
    for (const settings of [null, undefined, 'x', 7, []]) {
      assert.equal(readMinWithdrawalAmount(settings), 0);
    }
  });
});
