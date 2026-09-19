import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotFoundException } from '@nestjs/common';
import { PaymentGatewayType, TransactionStatus } from '@prisma/client';
import { of } from 'rxjs';

import { EVENT_PRESENTATION } from '../src/common/services/system-events.service';
import {
  AltshopImporterService,
  type AltshopTransaction,
} from '../src/modules/imports/services/altshop-importer.service';
import {
  RemnashopImporterService,
  type RemnashopTransaction,
} from '../src/modules/imports/services/remnashop-importer.service';
import { StealthnetImporterService } from '../src/modules/imports/services/stealthnet-importer.service';
import type { StealthnetPayment } from '../src/modules/imports/utils/stealthnet-backup-parser';
import { AddOnFulfillmentRecoveryService } from '../src/modules/payments/services/add-on-fulfillment-recovery.service';
import { PaymentPendingExpiryService } from '../src/modules/payments/services/payment-pending-expiry.service';
import { executeGatewayDataWrites } from './helpers/gateway-data-write-double';

/**
 * An imported payment that turns out to be paid is handed to a person.
 * ═══════════════════════════════════════════════════════════════════════
 * The STEALTHNET importer keeps a donor payment the donor never completed as a
 * PENDING row carrying the donor's YooKassa payment id. The expiry sweep polls
 * YooKassa for exactly such rows, and when YooKassa answered "succeeded" it
 * treated the row as a lost webhook: claimed it, tried to provision a plan the
 * donor's snapshot does not name, failed, released the claim and logged an
 * error — leaving a COMPLETED payment nobody had delivered and nobody was told
 * about.
 *
 * What it does now, on rows exactly as each importer writes them: the row is
 * recorded COMPLETED (the money arrived), left without a delivery stamp
 * (nothing was delivered), never provisioned and never paid out on, and one
 * operator notice names the customer and the payment. A native payment the
 * sweep finds paid is still delivered as before.
 */

type Written = Record<string, unknown>;

/** What an importer hands `transaction.create`, kept instead of written. */
function capture(): { written: Written[]; prisma: never } {
  const written: Written[] = [];
  const prisma = {
    transaction: {
      findUnique: async () => null,
      create: async ({ data }: { data: Written }) => {
        written.push(data);
        return { id: `imported-${written.length}` };
      },
    },
  };
  return { written, prisma: prisma as never };
}

function stealthnetDonor(overrides: Partial<StealthnetPayment> = {}): StealthnetPayment {
  return {
    id: 'sn-pay-31',
    client_id: 'client-31',
    order_id: 'ORD-2025-0031',
    amount: 299,
    currency: 'RUB',
    status: 'PENDING',
    provider: 'yookassa',
    external_id: '2f5c0a1e-000f-5000-8000-31a2b3c4d5e6',
    tariff_id: null,
    tariff_price_option_id: null,
    proxy_tariff_id: null,
    singbox_tariff_id: null,
    remnawave_user_id: null,
    metadata: null,
    created_at: '2025-10-01T09:00:00.000Z',
    paid_at: null,
    device_count: null,
    bot_id: null,
    ...overrides,
  };
}

async function stealthnetWrites(donors: readonly StealthnetPayment[]): Promise<Written[]> {
  const { written, prisma } = capture();
  const importer = new StealthnetImporterService(prisma, {} as never, {} as never, {} as never) as unknown as {
    importPayment(userId: string, donor: StealthnetPayment, tariffs: ReadonlyMap<string, unknown>): Promise<boolean>;
  };
  for (const donor of donors) await importer.importPayment('user-1', donor, new Map());
  return written;
}

async function remnashopWrites(donor: RemnashopTransaction): Promise<Written[]> {
  const { written, prisma } = capture();
  const importer = new RemnashopImporterService(prisma, {} as never) as unknown as {
    importTransaction(userId: string, donor: RemnashopTransaction): Promise<string>;
  };
  await importer.importTransaction('user-1', donor);
  return written;
}

async function altshopWrites(donor: AltshopTransaction): Promise<Written[]> {
  const { written, prisma } = capture();
  const importer = new AltshopImporterService(prisma, {} as never, {} as never) as unknown as {
    importTransaction(userId: string, donor: AltshopTransaction): Promise<unknown>;
  };
  await importer.importTransaction('user-1', donor);
  return written;
}

interface StoredRow {
  id: string;
  paymentId: string;
  userId: string;
  status: TransactionStatus;
  purchaseType: string;
  gatewayType: PaymentGatewayType;
  gatewayId: string | null;
  gatewayData: unknown;
  planSnapshot: unknown;
  amount: { toString(): string };
  currency: string;
  createdAt: Date;
  fulfilledAt: Date | null;
}

/** The row an importer's `create` would have stored. */
function stored(written: Written | undefined, id: string): StoredRow {
  assert.ok(written, 'the importer wrote nothing');
  const user = written['user'] as { connect?: { id?: string } } | undefined;
  return {
    id,
    paymentId: String(written['paymentId']),
    userId: user?.connect?.id ?? String(written['userId']),
    status: written['status'] as TransactionStatus,
    purchaseType: String(written['purchaseType'] ?? 'NEW'),
    gatewayType: written['gatewayType'] as PaymentGatewayType,
    gatewayId: typeof written['gatewayId'] === 'string' ? written['gatewayId'] : null,
    gatewayData: written['gatewayData'] ?? null,
    planSnapshot: written['planSnapshot'],
    amount: { toString: () => String(written['amount']) },
    currency: String(written['currency']),
    createdAt: new Date(written['createdAt'] as Date),
    fulfilledAt: (written['fulfilledAt'] as Date | undefined) ?? null,
  };
}

/** A native checkout the sweep finds paid at YooKassa: a plan snapshot of its own. */
function nativePending(): StoredRow {
  return {
    id: 'tx-native',
    paymentId: 'pay-native',
    userId: 'user-2',
    status: TransactionStatus.PENDING,
    purchaseType: 'NEW',
    gatewayType: PaymentGatewayType.YOOKASSA,
    gatewayId: '2f5c0a1e-000f-5000-8000-0000native01',
    gatewayData: { paymentMethodId: 'pm-1' },
    planSnapshot: { id: 'plan-month', name: 'Месяц', durationDays: 30, price: 299 },
    amount: { toString: () => '299.00' },
    currency: 'RUB',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    fulfilledAt: null,
  };
}

interface Seen {
  readonly updates: Array<{ readonly where: Record<string, unknown>; readonly data: Record<string, unknown> }>;
  readonly provisioned: string[];
  readonly hooks: string[];
  readonly enqueued: string[];
  readonly releases: string[];
  readonly events: Array<{
    readonly severity: string;
    readonly type: string;
    readonly message: string;
    readonly metadata: Record<string, unknown>;
  }>;
  readonly errors: string[];
}

function matches(row: StoredRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = (row as unknown as Record<string, unknown>)[key];
    if (key === 'createdAt') return row.createdAt < (expected as { lt: Date }).lt;
    if (expected === null) return actual === null || actual === undefined;
    if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
    return actual === expected;
  });
}

/**
 * The sweep over `rows`, with a prisma that keeps them. `anotherSweepMovesItFirst`
 * lets a second sweep complete the row between this one's read and its update.
 */
function sweepOver(
  rows: StoredRow[],
  providerStatus: string,
  options: { readonly anotherSweepMovesItFirst?: boolean } = {},
): { service: PaymentPendingExpiryService; seen: Seen; rows: Map<string, StoredRow> } {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const seen: Seen = { updates: [], provisioned: [], hooks: [], enqueued: [], releases: [], events: [], errors: [] };

  const transaction = {
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      [...byId.values()].filter((row) => matches(row, where)).map((row) => ({ ...row })),
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = byId.get(where.id);
      return row === undefined ? null : { ...row };
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      seen.updates.push({ where, data });
      if (options.anotherSweepMovesItFirst === true && data['status'] === TransactionStatus.COMPLETED) {
        for (const row of byId.values()) if (row.id === where['id']) row.status = TransactionStatus.COMPLETED;
      }
      const hits = [...byId.values()].filter((row) => matches(row, where));
      for (const row of hits) Object.assign(row, data);
      return { count: hits.length };
    },
  };
  const trialClaim = {
    updateMany: async ({ where }: { where: Record<string, unknown> }) => {
      seen.releases.push(String(where['transactionId']));
      return { count: 0 };
    },
  };
  const prisma = {
    transaction,
    trialClaim,
    paymentGateway: {
      findUnique: async () => ({ settings: { shopId: 'shop-1', apiKey: 'secret-1' } }),
    },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === 'user-1' ? { telegramId: 700100200n } : { telegramId: 700100201n },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ transaction, trialClaim }),
    // The sweep's `gatewayData` writes are one statement each (`writeTransactionGatewayData`).
    $executeRaw: executeGatewayDataWrites({
      currentGatewayData: (id) => byId.get(id)?.gatewayData,
      update: (args) => transaction.updateMany(args),
      updateMany: (args) => transaction.updateMany(args),
    }),
  };
  const record =
    (severity: string) =>
    (type: string, _category: string, message: string, metadata: Record<string, unknown> = {}): void => {
      seen.events.push({ severity, type, message, metadata });
    };

  const service = new PaymentPendingExpiryService(
    prisma as never,
    { info: record('INFO'), warn: record('WARNING'), error: record('ERROR') } as never,
    {
      get: (url: string) =>
        of({ status: 200, data: { id: decodeURIComponent(url.split('/').pop() ?? ''), status: providerStatus } }),
    } as never,
    {
      // What the real one does with an importer's snapshot: it names no plan
      // here, so there is nothing to provision it against.
      applyCompletedTransaction: async (row: StoredRow) => {
        seen.provisioned.push(row.id);
        const planId = (row.planSnapshot as Record<string, unknown> | null)?.['id'];
        if (typeof planId !== 'string') throw new NotFoundException('Purchased plan not found');
        return { syncJobs: [{ id: `sync-${row.id}` }] };
      },
    } as never,
    {
      enqueue: async (id: string) => {
        seen.enqueued.push(id);
      },
    } as never,
    {
      runPostFulfillmentHooks: async (row: StoredRow) => {
        seen.hooks.push(row.id);
      },
    } as never,
  );
  (service as unknown as { logger: unknown }).logger = {
    log: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: (message: string) => seen.errors.push(message),
  };
  return { service, seen, rows: byId };
}

/** The donor statuses the STEALTHNET importer keeps as a pending payment. */
const PENDING_DONOR_STATUSES = ['PENDING', 'CREATED', 'WAITING'] as const;

async function importedStillPending(): Promise<StoredRow[]> {
  const written = await stealthnetWrites(
    PENDING_DONOR_STATUSES.map((status, index) =>
      stealthnetDonor({
        id: `sn-pay-${index}`,
        order_id: `ORD-2025-00${index}`,
        status,
        external_id: `2f5c0a1e-000f-5000-8000-00000000000${index}`,
      }),
    ),
  );
  assert.equal(written.length, PENDING_DONOR_STATUSES.length, 'the importer skipped a pending donor payment');
  return written.map((row, index) => {
    const kept = stored(row, `tx-imported-${index}`);
    assert.equal(kept.status, TransactionStatus.PENDING, `donor status ${PENDING_DONOR_STATUSES[index]}`);
    assert.equal(kept.gatewayType, PaymentGatewayType.YOOKASSA);
    assert.ok(kept.gatewayId, 'the sweep polls only a row with a provider payment id');
    assert.equal((kept.planSnapshot as Record<string, unknown>)['importedFrom'], 'stealthnet');
    return kept;
  });
}

function notices(seen: Seen): Seen['events'] {
  return seen.events.filter((event) => event.severity !== 'INFO');
}

describe('an imported payment still pending there, that YooKassa reports paid', () => {
  it('is recorded COMPLETED and left undelivered — never provisioned, never paid out on', async () => {
    for (const row of await importedStillPending()) {
      const { service, seen, rows } = sweepOver([row], 'succeeded');

      await service.expireStalePending();

      const after = rows.get(row.id)!;
      assert.equal(after.status, TransactionStatus.COMPLETED, `${row.paymentId}: the money arrived`);
      assert.equal(after.fulfilledAt, null, `${row.paymentId}: nothing was delivered`);
      assert.deepEqual(
        seen.updates.filter((update) => 'fulfilledAt' in update.data),
        [],
        `${row.paymentId}: claimed for fulfilment`,
      );
      assert.deepEqual(seen.provisioned, [], `${row.paymentId}: provisioned`);
      assert.deepEqual(seen.enqueued, [], `${row.paymentId}: a profile sync was queued`);
      assert.deepEqual(seen.hooks, [], `${row.paymentId}: post-payment hooks ran`);
      assert.deepEqual(seen.errors, [], `${row.paymentId}: logged as a failure`);
      const gatewayData = after.gatewayData as Record<string, unknown>;
      assert.equal(gatewayData['providerStatus'], 'succeeded');
      assert.equal(gatewayData['polledSucceededWithoutWebhook'], true);
      assert.equal(typeof gatewayData['paidAfterImportAt'], 'string');
    }
  });

  it('raises exactly one operator notice, naming the customer and the payment', async () => {
    const [row] = await importedStillPending();
    const { service, seen } = sweepOver([row!], 'succeeded');

    await service.expireStalePending();

    const raised = notices(seen);
    assert.equal(raised.length, 1, JSON.stringify(raised));
    const notice = raised[0]!;
    assert.equal(notice.severity, 'WARNING');
    assert.equal(notice.type, 'payment.amount_mismatch');
    assert.deepEqual(
      {
        userId: notice.metadata['userId'],
        telegramId: notice.metadata['telegramId'],
        paymentId: notice.metadata['paymentId'],
        amount: notice.metadata['amount'],
        currency: notice.metadata['currency'],
        importedFrom: notice.metadata['importedFrom'],
        providerStatus: notice.metadata['providerStatus'],
      },
      {
        userId: 'user-1',
        telegramId: '700100200',
        paymentId: row!.paymentId,
        amount: '299',
        currency: 'RUB',
        importedFrom: 'stealthnet',
        providerStatus: 'succeeded',
      },
    );
    // Titled as what it is, not as the underpayment the type was named for.
    const header = EVENT_PRESENTATION['payment.amount_mismatch']?.variants?.find((variant) =>
      variant.when(notice.metadata),
    );
    assert.equal(header?.title, 'Перенесённый платёж оплачен, выдачи не было');
  });

  it('says nothing again and delivers nothing on the next sweep, or to a sweep that lost the move', async () => {
    const [row] = await importedStillPending();
    const twice = sweepOver([row!], 'succeeded');
    await twice.service.expireStalePending();
    await twice.service.expireStalePending();
    assert.equal(notices(twice.seen).length, 1, 'the next tick raised it again');
    assert.deepEqual(twice.seen.provisioned, []);

    const [racing] = await importedStillPending();
    const lost = sweepOver([racing!], 'succeeded', { anotherSweepMovesItFirst: true });
    await lost.service.expireStalePending();
    assert.deepEqual(notices(lost.seen), [], 'the sweep that moved nothing raised a notice');
    assert.deepEqual(lost.seen.provisioned, []);
    assert.deepEqual(lost.seen.hooks, []);
  });

  it('is not picked up by the add-on recovery sweep afterwards', async () => {
    const [row] = await importedStillPending();
    const { service, rows } = sweepOver([row!], 'succeeded');
    await service.expireStalePending();

    const claims: unknown[] = [];
    const recovery = new AddOnFulfillmentRecoveryService(
      {
        transaction: {
          findMany: async ({ where }: { where: Record<string, unknown> }) =>
            [...rows.values()].filter((candidate) => matches(candidate, where)),
          updateMany: async (args: unknown) => {
            claims.push(args);
            return { count: 0 };
          },
        },
      } as never,
      {
        applyCompletedTransaction: async () => {
          throw new Error('provisioned');
        },
      } as never,
      {} as never,
      { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
      { runPostFulfillmentHooks: async () => undefined } as never,
    );

    assert.deepEqual(await recovery.recoverStrandedFulfillments(), { recovered: 0, failed: 0 });
    assert.deepEqual(claims, []);
  });

  it('leaves a payment it cannot poll to the TTL as before — RemnaShop and AltShop keep no provider id', async () => {
    const remnashop = stored(
      (
        await remnashopWrites({
          id: 42,
          payment_id: 'plat-pending-42',
          user_telegram_id: 7001,
          status: 'PENDING',
          is_test: false,
          purchase_type: 'NEW',
          gateway_type: 'YOOKASSA',
          pricing: { final_amount: 349 },
          currency: 'RUB',
          plan_snapshot: { name: 'Месяц' },
          created_at: '2025-11-03T08:15:00.000Z',
        })
      )[0],
      'tx-remnashop',
    );
    const altshop = stored(
      (
        await altshopWrites({
          id: 58,
          payment_id: 'plat-pending-58',
          user_telegram_id: 7002,
          status: 'PENDING',
          purchase_type: 'NEW',
          gateway_type: 'YOOKASSA',
          pricing: { final_amount: 149 },
          currency: 'RUB',
          plan_snapshot: { name: 'Месяц' },
          channel: 'TELEGRAM',
          created_at: '2025-12-14T19:40:00.000Z',
        })
      )[0],
      'tx-altshop',
    );
    for (const row of [remnashop, altshop]) assert.equal(row.gatewayId, null, row.paymentId);
    const { service, seen, rows } = sweepOver([remnashop, altshop], 'succeeded');

    await service.expireStalePending();

    for (const id of ['tx-remnashop', 'tx-altshop']) {
      assert.equal(rows.get(id)!.status, TransactionStatus.CANCELED, id);
    }
    assert.deepEqual(notices(seen), []);
    assert.deepEqual(seen.provisioned, []);
  });
});

describe('a native payment the sweep finds paid is delivered as before', () => {
  it('claims it, delivers it, queues its sync and runs its post-payment hooks — and raises no notice', async () => {
    const { service, seen, rows } = sweepOver([nativePending()], 'succeeded');

    await service.expireStalePending();

    const after = rows.get('tx-native')!;
    assert.equal(after.status, TransactionStatus.COMPLETED);
    assert.ok(after.fulfilledAt instanceof Date, 'the claim was released or never taken');
    assert.deepEqual(seen.provisioned, ['tx-native']);
    assert.deepEqual(seen.enqueued, ['sync-tx-native']);
    assert.deepEqual(seen.hooks, ['tx-native']);
    assert.deepEqual(notices(seen), []);
    assert.deepEqual(seen.errors, []);
  });
});
