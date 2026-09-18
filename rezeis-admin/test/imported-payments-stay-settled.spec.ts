import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotFoundException } from '@nestjs/common';
import {
  AddOnType,
  PaymentWebhookLifecycleStatus,
  Prisma,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';

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
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';

/**
 * A payment imported as completed stays settled.
 * ══════════════════════════════════════════════
 * `fulfilledAt: null` is not inert: every path that fulfils a payment reads it
 * as "paid, not delivered yet". The Bedolaga importer stamps it for that
 * reason; the RemnaShop, AltShop and STEALTHNET importers left it null on the
 * payments they imported as COMPLETED — payments the donor bot had already
 * delivered. What that null did, shown below on rows exactly as each importer
 * writes them:
 *
 *   - the add-on recovery sweep reads the hundred OLDEST completed ADDITIONAL
 *     payments with no stamp and only then filters them to real add-ons, so a
 *     hundred imported ADDITIONAL payments filled its window for ever and a
 *     genuinely stranded add-on — money taken, nothing delivered — was never
 *     reached;
 *   - a provider notification resolving to an imported row drove it back into
 *     fulfilment: claimed, provisioned against a plan it does not have, failed,
 *     alerted and retried; and when two notifications raced, the one that lost
 *     the claim ran the payment's side effects — referral qualification,
 *     partner commission, cashback — on money the donor had already settled.
 *
 * Not asserted here, because the stamp does not settle it: the webhook
 * reconciler reads a stamp older than two minutes on a NEW row with no
 * subscription as an abandoned checkout claim, clears it and fulfils again.
 * Every imported NEW payment is such a row, Bedolaga's included; that branch of
 * `reconcileWebhookEvent` is the place to fix it.
 */

type Written = Record<string, unknown>;

const IMPORTED_AT_START = Date.now();

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

async function remnashopWrites(donors: readonly RemnashopTransaction[]): Promise<Written[]> {
  const { written, prisma } = capture();
  const importer = new RemnashopImporterService(prisma, {} as never) as unknown as {
    importTransaction(userId: string, donor: RemnashopTransaction): Promise<string>;
  };
  for (const donor of donors) await importer.importTransaction('user-1', donor);
  return written;
}

async function altshopWrites(donors: readonly AltshopTransaction[]): Promise<Written[]> {
  const { written, prisma } = capture();
  const importer = new AltshopImporterService(prisma, {} as never, {} as never) as unknown as {
    importTransaction(userId: string, donor: AltshopTransaction): Promise<unknown>;
  };
  for (const donor of donors) await importer.importTransaction('user-1', donor);
  return written;
}

async function stealthnetWrites(donors: readonly StealthnetPayment[]): Promise<Written[]> {
  const { written, prisma } = capture();
  const importer = new StealthnetImporterService(prisma, {} as never, {} as never, {} as never) as unknown as {
    importPayment(userId: string, donor: StealthnetPayment, tariffs: ReadonlyMap<string, unknown>): Promise<boolean>;
  };
  for (const donor of donors) await importer.importPayment('user-1', donor, new Map());
  return written;
}

function remnashopDonor(overrides: Partial<RemnashopTransaction> = {}): RemnashopTransaction {
  return {
    id: 41,
    payment_id: 'plat-7f3e',
    user_telegram_id: 7001,
    status: 'COMPLETED',
    is_test: false,
    purchase_type: 'RENEW',
    gateway_type: 'PLATEGA',
    pricing: { final_amount: 349 },
    currency: 'RUB',
    plan_snapshot: { name: 'Месяц' },
    created_at: '2025-11-03T08:15:00.000Z',
    ...overrides,
  };
}

function altshopDonor(overrides: Partial<AltshopTransaction> = {}): AltshopTransaction {
  return {
    id: 57,
    payment_id: 'plat-9c21',
    user_telegram_id: 7002,
    status: 'COMPLETED',
    purchase_type: 'ADDITIONAL',
    gateway_type: 'PLATEGA',
    pricing: { final_amount: 149 },
    currency: 'RUB',
    plan_snapshot: { name: 'Трафик +50 ГБ' },
    channel: 'TELEGRAM',
    created_at: '2025-12-14T19:40:00.000Z',
    ...overrides,
  };
}

function stealthnetDonor(overrides: Partial<StealthnetPayment> = {}): StealthnetPayment {
  return {
    id: 'sn-pay-9',
    client_id: 'client-9',
    order_id: 'ORD-2025-0009',
    amount: 299,
    currency: 'RUB',
    status: 'PAID',
    provider: 'yookassa',
    external_id: '2f5c0a1e-000f-5000-8000-1a2b3c4d5e6f',
    tariff_id: null,
    tariff_price_option_id: null,
    proxy_tariff_id: null,
    singbox_tariff_id: null,
    remnawave_user_id: null,
    metadata: null,
    created_at: '2025-10-01T09:00:00.000Z',
    paid_at: '2025-10-01T09:04:30.000Z',
    device_count: null,
    bot_id: null,
    ...overrides,
  };
}

function assertStampedWithTheImportTime(value: unknown): void {
  assert.ok(value instanceof Date, `not stamped: ${String(value)}`);
  assert.ok(value.getTime() >= IMPORTED_AT_START && value.getTime() <= Date.now(), `stamped ${value.toISOString()}`);
}

describe('the importers stamp a completed payment as delivered, on the Bedolaga rule', () => {
  it('RemnaShop: at the donor creation time — it records no completion time', async () => {
    const [row] = await remnashopWrites([remnashopDonor()]);
    assert.equal(row?.status, TransactionStatus.COMPLETED);
    assert.deepEqual(row?.fulfilledAt, new Date('2025-11-03T08:15:00.000Z'));
  });

  it('AltShop: at the donor creation time — it records no completion time', async () => {
    const [row] = await altshopWrites([altshopDonor()]);
    assert.equal(row?.status, TransactionStatus.COMPLETED);
    assert.deepEqual(row?.fulfilledAt, new Date('2025-12-14T19:40:00.000Z'));
  });

  it('STEALTHNET: at paid_at, else at the creation time', async () => {
    const [paid, noPaidAt] = await stealthnetWrites([
      stealthnetDonor(),
      stealthnetDonor({ order_id: 'ORD-2025-0010', paid_at: null }),
    ]);
    assert.deepEqual(paid?.fulfilledAt, new Date('2025-10-01T09:04:30.000Z'));
    assert.deepEqual(noPaidAt?.fulfilledAt, new Date('2025-10-01T09:00:00.000Z'));
  });

  it('stamps with the import time when the donor dates cannot be read', async () => {
    const [remnashop] = await remnashopWrites([remnashopDonor({ created_at: 'not a date' })]);
    const [altshop] = await altshopWrites([altshopDonor({ created_at: '' })]);
    const [stealthnet] = await stealthnetWrites([stealthnetDonor({ paid_at: 'nope', created_at: 'nope' })]);
    assertStampedWithTheImportTime(remnashop?.fulfilledAt);
    assertStampedWithTheImportTime(altshop?.fulfilledAt);
    // STEALTHNET's own `createdAt` has no guard against an unreadable date and
    // fails the row on its own; the stamp is the rule's either way.
    assertStampedWithTheImportTime(stealthnet?.fulfilledAt);
  });

  it('leaves a payment the donor did not complete unstamped', async () => {
    const remnashop = await remnashopWrites(
      ['PENDING', 'CANCELED', 'REFUNDED', 'FAILED'].map((status, index) => remnashopDonor({ id: 100 + index, status })),
    );
    const altshop = await altshopWrites(
      ['PENDING', 'CANCELED', 'REFUNDED', 'FAILED'].map((status, index) => altshopDonor({ id: 100 + index, status })),
    );
    const stealthnet = await stealthnetWrites(
      ['PENDING', 'CANCELED', 'REFUNDED', 'FAILED'].map((status, index) =>
        stealthnetDonor({ order_id: `ORD-X-${index}`, status }),
      ),
    );
    for (const row of [...remnashop, ...altshop, ...stealthnet]) {
      assert.notEqual(row.status, TransactionStatus.COMPLETED);
      assert.equal('fulfilledAt' in row, false, `a ${String(row.status)} payment was stamped delivered`);
    }
    assert.equal(remnashop.length + altshop.length + stealthnet.length, 12);
  });
});

// ── The rows, as the database holds them ────────────────────────────────────

interface StoredRow {
  id: string;
  paymentId: string;
  userId: string;
  subscriptionId: string | null;
  status: TransactionStatus;
  purchaseType: PurchaseType;
  gatewayType: string;
  gatewayId: string | null;
  gatewayData: Prisma.JsonValue | null;
  currency: string;
  amount: Prisma.Decimal;
  planSnapshot: Prisma.JsonValue;
  fulfilledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  channel: string;
  paymentAsset: string | null;
  deviceTypes: string[];
}

function stored(written: Written, id: string): StoredRow {
  return {
    id,
    paymentId: String(written.paymentId),
    userId: 'user-1',
    subscriptionId: null,
    status: written.status as TransactionStatus,
    purchaseType: written.purchaseType as PurchaseType,
    gatewayType: String(written.gatewayType),
    gatewayId: (written.gatewayId as string | undefined) ?? null,
    gatewayData: (written.gatewayData as Prisma.JsonValue | undefined) ?? null,
    currency: String(written.currency),
    amount: new Prisma.Decimal(String(written.amount)),
    planSnapshot: written.planSnapshot as Prisma.JsonValue,
    fulfilledAt: (written.fulfilledAt as Date | undefined) ?? null,
    createdAt: written.createdAt as Date,
    updatedAt: written.createdAt as Date,
    channel: String(written.channel),
    paymentAsset: null,
    deviceTypes: [],
  };
}

// ── The add-on recovery sweep ───────────────────────────────────────────────

async function sweepOver(rows: StoredRow[]): Promise<{ applied: string[]; recovered: number }> {
  const applied: string[] = [];
  const prisma = {
    transaction: {
      findMany: async ({
        where,
        take,
      }: {
        where: { status: TransactionStatus; fulfilledAt: null; purchaseType: PurchaseType; createdAt: { lt: Date } };
        take: number;
      }) => {
        // The sweep's own query, answered as Postgres answers it. Refuse a shape
        // this double does not model rather than answer it wrongly.
        assert.equal(where.fulfilledAt, null, 'the sweep no longer selects unstamped rows — update this double');
        return rows
          .filter(
            (row) =>
              row.status === where.status &&
              row.fulfilledAt === null &&
              row.purchaseType === where.purchaseType &&
              row.createdAt < where.createdAt.lt,
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, take);
      },
      updateMany: async ({ where, data }: { where: { id: string; fulfilledAt: unknown }; data: { fulfilledAt: Date | null } }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        if (row === undefined || where.fulfilledAt !== null || row.fulfilledAt !== null) return { count: 0 };
        row.fulfilledAt = data.fulfilledAt;
        return { count: 1 };
      },
    },
  };
  const sweep = new AddOnFulfillmentRecoveryService(
    prisma as never,
    {
      applyCompletedTransaction: async (transaction: { id: string }) => {
        applied.push(transaction.id);
        return { syncJobs: [] };
      },
    } as never,
    { enqueue: async () => undefined } as never,
    { warn: () => undefined } as never,
    { runPostFulfillmentHooksBestEffort: async () => undefined } as never,
  );
  const { recovered } = await sweep.recoverStrandedFulfillments();
  return { applied, recovered };
}

/** A genuinely stranded add-on: paid an hour ago, never applied. */
function strandedAddOn(): StoredRow {
  const paidAt = new Date(Date.now() - 60 * 60 * 1000);
  return {
    id: 'genuine-stranded-addon',
    paymentId: 'native-payment-1',
    userId: 'user-2',
    subscriptionId: 'subscription-2',
    status: TransactionStatus.COMPLETED,
    purchaseType: PurchaseType.ADDITIONAL,
    gatewayType: 'PLATEGA',
    gatewayId: 'plat-native-1',
    gatewayData: null,
    currency: 'RUB',
    amount: new Prisma.Decimal('99.00'),
    planSnapshot: {
      snapshotSource: 'ADDON_PURCHASE',
      addOnId: 'addon-traffic-50',
      addOnType: AddOnType.EXTRA_TRAFFIC,
      addOnValue: 50,
      targetSubscriptionId: 'subscription-2',
    },
    fulfilledAt: null,
    createdAt: paidAt,
    updatedAt: paidAt,
    channel: 'TELEGRAM',
    paymentAsset: null,
    deviceTypes: [],
  };
}

/** A hundred ADDITIONAL donor payments, all older than the stranded add-on. */
function hundredDonorAddOns<T>(make: (index: number, createdAt: string) => T): T[] {
  return Array.from({ length: 100 }, (_unused, index) =>
    make(index, new Date(Date.UTC(2025, 5, 1) + index * 3_600_000).toISOString()),
  );
}

describe('imported add-on payments do not hide a stranded one from the recovery sweep', () => {
  it('RemnaShop: a hundred of them, and the stranded add-on is still recovered', async () => {
    const written = await remnashopWrites(
      hundredDonorAddOns((index, createdAt) =>
        remnashopDonor({ id: 1_000 + index, purchase_type: 'ADDITIONAL', created_at: createdAt }),
      ),
    );
    assert.equal(written.length, 100);
    const rows = [...written.map((row, index) => stored(row, `remnashop-${index}`)), strandedAddOn()];

    const { applied, recovered } = await sweepOver(rows);

    assert.deepEqual(applied, ['genuine-stranded-addon']);
    assert.equal(recovered, 1);
  });

  it('AltShop: a hundred of them, and the stranded add-on is still recovered', async () => {
    const written = await altshopWrites(
      hundredDonorAddOns((index, createdAt) => altshopDonor({ id: 1_000 + index, created_at: createdAt })),
    );
    assert.equal(written.length, 100);
    const rows = [...written.map((row, index) => stored(row, `altshop-${index}`)), strandedAddOn()];

    const { applied, recovered } = await sweepOver(rows);

    assert.deepEqual(applied, ['genuine-stranded-addon']);
    assert.equal(recovered, 1);
  });
});

// ── The webhook reconciler ──────────────────────────────────────────────────

function reconcilerFor(row: StoredRow, options: { readonly claimLostToAnotherWorker?: boolean } = {}) {
  const seen = {
    claims: 0,
    provisioned: [] as string[],
    sideEffects: [] as string[],
    processed: [] as string[],
    failed: [] as string[],
    alerted: [] as string[],
  };
  const at = new Date();
  const event = {
    id: 'event-1',
    gatewayType: row.gatewayType,
    paymentId: row.paymentId,
    providerEventId: 'provider-event-1',
    eventStatus: 'CONFIRMED',
    status: PaymentWebhookLifecycleStatus.PROCESSING,
    attempts: 1,
    reconciliationAttempts: 1,
    replayCount: 0,
    lastError: null,
    payloadHash: 'hash-1',
    rawPayload: { id: row.paymentId, status: 'CONFIRMED' },
    normalizedPayload: null,
    receivedAt: at,
    processedAt: null,
    lastTransitionAt: at,
    lastReplayedAt: null,
    createdAt: at,
    updatedAt: at,
  };
  const prisma = {
    paymentWebhookEvent: { findUnique: async () => event },
    paymentGateway: { findUnique: async () => null },
    transaction: {
      findUnique: async () => ({ ...row }),
      findFirst: async () => ({ ...row }),
      update: async ({ data }: { data: Partial<StoredRow> }) => {
        Object.assign(row, data);
        return { ...row };
      },
      updateMany: async ({ where, data }: { where: { id: string; fulfilledAt: Date | null }; data: { fulfilledAt: Date | null } }) => {
        if (where.id !== row.id) return { count: 0 };
        if (where.fulfilledAt === null && data.fulfilledAt instanceof Date) {
          seen.claims += 1;
          if (options.claimLostToAnotherWorker) return { count: 0 };
        }
        const matches =
          where.fulfilledAt === null
            ? row.fulfilledAt === null
            : row.fulfilledAt !== null && row.fulfilledAt.getTime() === where.fulfilledAt.getTime();
        if (!matches) return { count: 0 };
        row.fulfilledAt = data.fulfilledAt;
        return { count: 1 };
      },
    },
    $transaction: async (work: (client: unknown) => Promise<unknown>) => work(prisma),
  };
  const service = new PaymentReconciliationService(
    prisma as never,
    {
      incrementReconciliationAttempts: async () => undefined,
      markProcessing: async () => undefined,
      markProcessed: async (id: string) => {
        seen.processed.push(id);
        return {};
      },
      markFailed: async (id: string) => {
        seen.failed.push(id);
        return { id };
      },
    } as never,
    {
      // What the real method does with this row: `readPlanId` finds no plan id
      // in an imported snapshot and throws before writing anything.
      applyCompletedTransaction: async (transaction: { id: string }) => {
        seen.provisioned.push(transaction.id);
        throw new NotFoundException('Purchased plan not found');
      },
    } as never,
    {
      notifyWebhookFailed: async ({ event: failed }: { event: { id: string } }) => {
        seen.alerted.push(failed.id);
      },
    } as never,
    {
      processPartnerEarning: async () => {
        seen.sideEffects.push('partner commission');
      },
    } as never,
    {
      qualifyReferralAfterPurchase: async () => {
        seen.sideEffects.push('referral qualification');
        return null;
      },
    } as never,
    { enqueue: async () => undefined } as never,
    { warn: () => undefined, info: () => undefined, error: () => undefined, emit: () => undefined } as never,
    {
      enqueueRegisterIncome: async () => {
        seen.sideEffects.push('МойНалог income');
      },
    } as never,
    {
      recordFirstPurchase: async () => {
        seen.sideEffects.push('ad conversion');
      },
    } as never,
    { upsertFromYookassaPayment: async () => undefined } as never,
    { verifyCompletion: async () => ({ outcome: 'CONFIRMED', providerStatus: 'succeeded' }) } as never,
    {
      creditForTransactionBestEffort: async () => {
        seen.sideEffects.push('cashback');
        return undefined;
      },
      reverseForTransactionBestEffort: async () => undefined,
    } as never,
    { create: async () => 'notification-1' } as never,
  );
  return { service, seen };
}

/** An imported renewal and an imported add-on — the rows the stamp settles for the reconciler. */
async function importedNonNewRows(): Promise<StoredRow[]> {
  const [renewal] = await remnashopWrites([remnashopDonor()]);
  const [addOn] = await altshopWrites([altshopDonor()]);
  assert.ok(renewal && addOn);
  const rows = [stored(renewal, 'remnashop-renewal'), stored(addOn, 'altshop-add-on')];
  assert.deepEqual(
    rows.map((row) => row.purchaseType),
    [PurchaseType.RENEW, PurchaseType.ADDITIONAL],
  );
  for (const row of rows) {
    // The precondition the provisioning double above stands for.
    assert.equal(Object.prototype.hasOwnProperty.call(row.planSnapshot, 'id'), false);
  }
  return rows;
}

describe('a provider notification for an imported payment leaves it settled', () => {
  it('is acknowledged without being claimed, provisioned, failed or alerted', async () => {
    for (const row of await importedNonNewRows()) {
      const { service, seen } = reconcilerFor(row);

      await service.reconcileWebhookEvent('event-1');

      assert.deepEqual(
        { claims: seen.claims, provisioned: seen.provisioned, failed: seen.failed, alerted: seen.alerted },
        { claims: 0, provisioned: [], failed: [], alerted: [] },
        `${row.id} was driven back into fulfilment`,
      );
      assert.deepEqual(seen.processed, ['event-1']);
    }
  });

  it('pays none of its side effects when two notifications race for it', async () => {
    for (const row of await importedNonNewRows()) {
      const { service, seen } = reconcilerFor(row, { claimLostToAnotherWorker: true });

      await service.reconcileWebhookEvent('event-1');

      assert.deepEqual(seen.sideEffects, [], `${row.id}: side effects of a payment the donor already settled`);
      assert.deepEqual(seen.processed, ['event-1']);
    }
  });
});
