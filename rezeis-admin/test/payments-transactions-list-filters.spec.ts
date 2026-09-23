import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  IMPORTED_PAYMENT_ID_PREFIXES,
  PaymentsTransactionsService,
} from '../src/modules/payments/services/payments-transactions.service';
import { SubscriptionQuoteService } from '../src/modules/subscriptions/services/subscription-quote.service';

/**
 * What `listTransactions` asks the database, for the filters the payments page
 * and its deep links (`?userId=`, `?subscriptionId=`, `?q=`) send.
 *
 * The Prisma stand-in RECORDS the arguments it was given — typed as Prisma's
 * own argument types, so a misspelt field in an assertion fails to compile —
 * and answers with fixed rows. It is not a database: every assertion below is
 * about the question put to Postgres, which is the part this service owns.
 */

const USER_ID = 'cmfk2x9pq0000abcd1234efgh';
const OTHER_USER_ID = 'cmfk2x9pq0001abcd1234efgh';
const SUBSCRIPTION_ID = 'cmfk2x9pq0002abcd1234efgh';

interface StoredRow {
  readonly id: string;
  readonly paymentId: string;
  readonly userId: string;
  readonly subscriptionId: string | null;
  readonly status: TransactionStatus;
  readonly purchaseType: PurchaseType;
  readonly channel: PurchaseChannel;
  readonly gatewayType: PaymentGatewayType;
  readonly gatewayId: string | null;
  readonly currency: Currency;
  readonly amount: { toString(): string };
  readonly paymentAsset: string | null;
  readonly planSnapshot: Prisma.JsonValue;
  readonly gatewayData?: Prisma.JsonValue;
  readonly fulfilledAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly user: {
    readonly id: string;
    readonly telegramId: bigint | null;
    readonly username: string | null;
    readonly name: string;
    readonly email: string | null;
  };
  readonly items: readonly { readonly subscriptionId: string }[];
}

function row(overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    id: 'cmfk2x9pq0003abcd1234efgh',
    paymentId: 'cmfk2x9pq0004abcd1234efgh',
    userId: USER_ID,
    subscriptionId: null,
    status: TransactionStatus.COMPLETED,
    purchaseType: PurchaseType.RENEW,
    channel: PurchaseChannel.WEB,
    gatewayType: PaymentGatewayType.YOOKASSA,
    gatewayId: '2d8e4f1a-000f-5000-9000-1b2c3d4e5f60',
    currency: Currency.RUB,
    amount: { toString: (): string => '299' },
    paymentAsset: null,
    planSnapshot: { name: 'Pro', selectedDurationDays: 30 },
    fulfilledAt: new Date('2026-09-01T10:00:05.000Z'),
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    updatedAt: new Date('2026-09-01T10:00:06.000Z'),
    user: { id: USER_ID, telegramId: 777n, username: 'alice', name: 'Alice', email: null },
    items: [],
    ...overrides,
  };
}

function harness(input: {
  readonly rows?: readonly StoredRow[];
  readonly matchingUserIds?: readonly string[];
  /** `transaction_items` rows, with the subscription each one renews. */
  readonly lineItems?: readonly { readonly transactionId: string; readonly subscriptionId: string }[];
} = {}) {
  const findManyCalls: Prisma.TransactionFindManyArgs[] = [];
  const countCalls: Prisma.TransactionCountArgs[] = [];
  const userFindManyCalls: Prisma.UserFindManyArgs[] = [];
  const lineItemCalls: Prisma.TransactionItemFindManyArgs[] = [];
  const prisma = {
    transaction: {
      findMany: async (args: Prisma.TransactionFindManyArgs) => {
        findManyCalls.push(args);
        return input.rows ?? [];
      },
      count: async (args: Prisma.TransactionCountArgs) => {
        countCalls.push(args);
        return (input.rows ?? []).length;
      },
    },
    transactionItem: {
      findMany: async (args: Prisma.TransactionItemFindManyArgs) => {
        lineItemCalls.push(args);
        const wanted = args.where?.subscriptionId;
        return (input.lineItems ?? [])
          .filter((item) => item.subscriptionId === wanted)
          .map((item) => ({ transactionId: item.transactionId }));
      },
    },
    user: {
      findMany: async (args: Prisma.UserFindManyArgs) => {
        userFindManyCalls.push(args);
        return (input.matchingUserIds ?? []).map((id) => ({ id }));
      },
    },
  };
  const quotes = {
    getQuote: async (): Promise<never> => {
      throw new Error('listing payments must never price anything');
    },
    getSubscriptionCapacity: async (): Promise<never> => {
      throw new Error('listing payments must never read subscription capacity');
    },
  } satisfies Pick<SubscriptionQuoteService, 'getQuote' | 'getSubscriptionCapacity'>;
  // PrismaService and SubscriptionQuoteService are classes with private
  // members, so no structural stand-in can be assignable to them. The members
  // this service calls are typed above with Prisma's own argument types.
  const service = new PaymentsTransactionsService(
    prisma as unknown as PrismaService,
    quotes as unknown as SubscriptionQuoteService,
  );
  return { service, findManyCalls, countCalls, userFindManyCalls, lineItemCalls };
}

describe('PaymentsTransactionsService.listTransactions filters', () => {
  it('finds one payment by a reference matched exactly against paymentId, gatewayId and id', async () => {
    const { service, findManyCalls, countCalls } = harness({ rows: [row()] });

    await service.listTransactions({ q: '2d8e4f1a-000f-5000-9000-1b2c3d4e5f60' });

    const reference = '2d8e4f1a-000f-5000-9000-1b2c3d4e5f60';
    const expected: Prisma.TransactionWhereInput = {
      AND: [
        {
          OR: [
            {
              paymentId: {
                in: [reference, `altshop:${reference}`, `bedolaga:${reference}`, `remnashop:${reference}`],
              },
            },
            { gatewayId: reference },
            { id: reference },
          ],
        },
      ],
    };
    assert.deepStrictEqual(findManyCalls[0]?.where, expected);
    // The count has to describe the same set the page shows.
    assert.deepStrictEqual(countCalls[0]?.where, expected);
  });

  it("finds a subscription's payments including the combined renewals that carry it as a line item", async () => {
    const { service, findManyCalls, countCalls, lineItemCalls } = harness({
      lineItems: [
        { transactionId: 'combined-1', subscriptionId: SUBSCRIPTION_ID },
        // Two lines of one payment name that payment once.
        { transactionId: 'combined-1', subscriptionId: SUBSCRIPTION_ID },
        { transactionId: 'combined-2', subscriptionId: SUBSCRIPTION_ID },
        { transactionId: 'someone-else', subscriptionId: 'cmfk2x9pq0009abcd1234efgh' },
      ],
    });

    await service.listTransactions({ subscriptionId: SUBSCRIPTION_ID });

    // The line items are looked up by their own indexed column…
    assert.deepStrictEqual(lineItemCalls, [
      { where: { subscriptionId: SUBSCRIPTION_ID }, select: { transactionId: true } },
    ]);
    // …and joined in as ids — never as a subquery, which Postgres could not
    // combine with the other branch and answered with a full scan.
    const expected: Prisma.TransactionWhereInput = {
      AND: [
        {
          OR: [{ subscriptionId: SUBSCRIPTION_ID }, { id: { in: ['combined-1', 'combined-2'] } }],
        },
      ],
    };
    assert.deepStrictEqual(findManyCalls[0]?.where, expected);
    assert.deepStrictEqual(countCalls[0]?.where, expected);
  });

  it('asks only for the subscription itself when no combined renewal carries it', async () => {
    const { service, findManyCalls } = harness({ lineItems: [] });

    await service.listTransactions({ subscriptionId: SUBSCRIPTION_ID });

    assert.deepStrictEqual(findManyCalls[0]?.where, {
      AND: [{ OR: [{ subscriptionId: SUBSCRIPTION_ID }] }],
    });
  });

  it('looks a bare number up under every importer namespace, the form the cabinet shows it in', async () => {
    const { service, findManyCalls } = harness();

    await service.listTransactions({ q: '4821' });

    assert.deepStrictEqual(findManyCalls[0]?.where, {
      AND: [
        {
          OR: [
            { paymentId: { in: ['4821', 'altshop:4821', 'bedolaga:4821', 'remnashop:4821'] } },
            { gatewayId: '4821' },
            { id: '4821' },
          ],
        },
      ],
    });
  });

  it('does not namespace a reference that already carries a namespace', async () => {
    const { service, findManyCalls } = harness();

    await service.listTransactions({ q: 'bedolaga:4821' });

    assert.deepStrictEqual(findManyCalls[0]?.where, {
      AND: [
        {
          OR: [
            { paymentId: { in: ['bedolaga:4821'] } },
            { gatewayId: 'bedolaga:4821' },
            { id: 'bedolaga:4821' },
          ],
        },
      ],
    });
  });

  it('knows exactly the namespaces the importers write', () => {
    // Read off the importers themselves: an importer that starts namespacing
    // its ids, or renames its namespace, has to be named in the service too,
    // or the number the cabinet shows a subscriber would find nothing here.
    const importers = join(__dirname, '..', 'src', 'modules', 'imports', 'services');
    const written = new Set<string>();
    for (const file of ['altshop', 'bedolaga', 'remnashop', 'stealthnet', 'threexui', 'remnawave']) {
      const source = readFileSync(join(importers, `${file}-importer.service.ts`), 'utf8');
      for (const match of source.matchAll(/const paymentId = (?:`([a-z]+):\$\{|'([a-z]+):' \+)/g)) {
        written.add(match[1] ?? match[2] ?? '');
      }
    }
    assert.deepStrictEqual([...written].sort(), [...IMPORTED_PAYMENT_ID_PREFIXES].sort());
  });

  it('keeps both choices when a reference and a subscription are asked for together', async () => {
    const { service, findManyCalls } = harness({
      lineItems: [{ transactionId: 'combined-1', subscriptionId: SUBSCRIPTION_ID }],
    });

    await service.listTransactions({
      subscriptionId: SUBSCRIPTION_ID,
      q: 'ref-1',
      userId: USER_ID,
      status: TransactionStatus.REFUNDED,
    });

    assert.deepStrictEqual(findManyCalls[0]?.where, {
      userId: USER_ID,
      status: TransactionStatus.REFUNDED,
      AND: [
        { OR: [{ subscriptionId: SUBSCRIPTION_ID }, { id: { in: ['combined-1'] } }] },
        {
          OR: [
            { paymentId: { in: ['ref-1', 'altshop:ref-1', 'bedolaga:ref-1', 'remnashop:ref-1'] } },
            { gatewayId: 'ref-1' },
            { id: 'ref-1' },
          ],
        },
      ],
    });
  });

  it('adds no AND clause when neither choice filter is asked for', async () => {
    const { service, findManyCalls } = harness();

    await service.listTransactions({ userId: USER_ID });

    assert.deepStrictEqual(findManyCalls[0]?.where, { userId: USER_ID });
  });

  describe('a Telegram id longer than Postgres int8', () => {
    it('matches nobody without asking the database, which would fail the request', async () => {
      // Reproduced against Postgres 17: binding this value made Prisma throw
      // P2020 / SQLSTATE 22003 "value out of range for type bigint" — a 500.
      const { service, findManyCalls, userFindManyCalls } = harness({ matchingUserIds: [USER_ID] });

      const result = await service.listTransactions({ userSearch: '99999999999999999999' });

      assert.deepStrictEqual(result, { items: [], total: 0 });
      assert.equal(userFindManyCalls.length, 0);
      assert.equal(findManyCalls.length, 0);
    });

    it('still searches the largest id int8 can hold', async () => {
      const { service, userFindManyCalls } = harness({ matchingUserIds: [USER_ID] });

      await service.listTransactions({ userSearch: '9223372036854775807' });

      assert.deepStrictEqual(userFindManyCalls[0]?.where, { telegramId: 9223372036854775807n });
    });
  });

  describe('a client link combined with the user search box', () => {
    it('answers nothing when the search names a different customer, and never widens to them', async () => {
      const { service, findManyCalls, countCalls } = harness({
        rows: [row({ userId: OTHER_USER_ID })],
        matchingUserIds: [OTHER_USER_ID],
      });

      const result = await service.listTransactions({ userId: USER_ID, userSearch: 'bob' });

      assert.deepStrictEqual(result, { items: [], total: 0 });
      assert.equal(findManyCalls.length, 0);
      assert.equal(countCalls.length, 0);
    });

    it('keeps the linked client when the search names the same customer', async () => {
      const { service, findManyCalls } = harness({ matchingUserIds: [OTHER_USER_ID, USER_ID] });

      await service.listTransactions({ userId: USER_ID, userSearch: 'alice' });

      assert.deepStrictEqual(findManyCalls[0]?.where, { userId: USER_ID });
    });

    it('still narrows to every matching customer when no client link is set', async () => {
      const { service, findManyCalls } = harness({ matchingUserIds: [USER_ID, OTHER_USER_ID] });

      await service.listTransactions({ userSearch: 'a' });

      assert.deepStrictEqual(findManyCalls[0]?.where, { userId: { in: [USER_ID, OTHER_USER_ID] } });
    });
  });

  it('returns the gateway id, the fulfilment time and the renewed subscriptions with each row', async () => {
    const combined = row({
      subscriptionId: null,
      fulfilledAt: null,
      items: [
        { subscriptionId: SUBSCRIPTION_ID },
        { subscriptionId: 'cmfk2x9pq0009abcd1234efgh' },
        // Two lines renewing one subscription name it once.
        { subscriptionId: SUBSCRIPTION_ID },
      ],
    });
    const { service, findManyCalls } = harness({ rows: [row(), combined] });

    const { items } = await service.listTransactions({});

    assert.equal(items[0]?.gatewayId, '2d8e4f1a-000f-5000-9000-1b2c3d4e5f60');
    assert.equal(items[0]?.fulfilledAt, '2026-09-01T10:00:05.000Z');
    assert.deepStrictEqual(items[0]?.lineItemSubscriptionIds, []);
    assert.equal(items[1]?.fulfilledAt, null);
    assert.deepStrictEqual(items[1]?.lineItemSubscriptionIds, [
      SUBSCRIPTION_ID,
      'cmfk2x9pq0009abcd1234efgh',
    ]);
    // …because the query asked for them, not because the stand-in volunteered them.
    assert.deepStrictEqual(findManyCalls[0]?.include, {
      user: { select: { id: true, telegramId: true, username: true, name: true, email: true } },
      items: { select: { subscriptionId: true } },
    });
  });

  it('marks a trial conversion withheld for refund, with its refund once it is recorded, and nothing else', async () => {
    // COMPLETED and fulfilled, yet applied to nothing: without the mark the
    // list shows it as an ordinary delivered sale.
    const withheld = row({
      id: 'cmfk2x9pq0010abcd1234efgh',
      purchaseType: PurchaseType.UPGRADE,
      gatewayData: {
        providerStatus: 'CONFIRMED',
        conversionWithheldAt: '2026-09-01T10:00:05.000Z',
        trialConvertedByPaymentId: 'payment-first',
      },
    });
    const refunded = row({
      id: 'cmfk2x9pq0011abcd1234efgh',
      status: TransactionStatus.CANCELED,
      purchaseType: PurchaseType.UPGRADE,
      gatewayData: {
        conversionWithheldAt: '2026-09-01T10:00:05.000Z',
        trialConvertedByPaymentId: 'payment-first',
        refundReversedAt: '2026-09-02T09:00:00.000Z',
      },
    });
    const ordinary = row({ gatewayData: { providerStatus: 'succeeded', refundReversedAt: '2026-09-03T09:00:00.000Z' } });
    const { service } = harness({ rows: [ordinary, withheld, refunded, row({ gatewayData: null })] });

    const { items } = await service.listTransactions({});

    assert.equal(items[0]?.conversionWithheld, null);
    assert.deepStrictEqual(items[1]?.conversionWithheld, {
      reason: 'TRIAL_ALREADY_CONVERTED',
      withheldAt: '2026-09-01T10:00:05.000Z',
      convertedByPaymentId: 'payment-first',
      refundedAt: null,
    });
    assert.deepStrictEqual(items[2]?.conversionWithheld, {
      reason: 'TRIAL_ALREADY_CONVERTED',
      withheldAt: '2026-09-01T10:00:05.000Z',
      convertedByPaymentId: 'payment-first',
      refundedAt: '2026-09-02T09:00:00.000Z',
    });
    assert.equal(items[3]?.conversionWithheld, null);
    // The column itself stays on the server: provider payloads live in it.
    assert.equal(items.some((item) => 'gatewayData' in item), false);
  });

  it('says an autopay charge taken after a refund was withheld for that reason', async () => {
    // The same mark, another reason: the SPA explains it differently.
    const charge = row({
      purchaseType: PurchaseType.RENEW,
      gatewayData: { conversionWithheldAt: '2026-09-02T10:00:05.000Z', withheldReason: 'AUTOPAY_AFTER_REFUND' },
    });
    const { service } = harness({ rows: [charge] });

    const { items } = await service.listTransactions({});

    assert.deepStrictEqual(items[0]?.conversionWithheld, {
      reason: 'AUTOPAY_AFTER_REFUND',
      withheldAt: '2026-09-02T10:00:05.000Z',
      convertedByPaymentId: null,
      refundedAt: null,
    });
  });
});
