import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Currency, PaymentGatewayType, Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * The `20260919200000_yookassa_autopay_approved` migration, on PostgreSQL.
 *
 * From this release an absent `savePaymentMethod` reads as OFF
 * (`gateway-autopay.util.ts`), so the migration writes the key for the installs
 * that exist: ON where a customer holds an active saved ЮKassa method, which
 * proves ЮKassa approved the shop; OFF otherwise. An operator's OFF is kept. A
 * stored ON is not, because the old dialog posted ON back on every save. A
 * replay changes nothing.
 *
 * `payment_gateways.type` is unique, so the one ЮKassa row is shared with every
 * other live spec: each case runs the migration's file inside ONE transaction
 * that is rolled back at the end. Saved ЮKassa methods left by anything else are
 * switched off inside that transaction too, or they would prove the approval.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec; CI's PostgreSQL job
 * runs it.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;

const MIGRATION = '20260919200000_yookassa_autopay_approved';
const prefix = `yap-${process.pid}-${Date.now()}`;

/** Thrown at the end of the transaction so that nothing it did is kept. */
class RolledBack extends Error {}

interface SavedMethodSeed {
  readonly providerMethodId: string;
  readonly isActive: boolean;
}

interface Observed {
  readonly afterFirstRun: Prisma.JsonValue;
  readonly afterReplay: Prisma.JsonValue;
}

let prisma: PrismaService;

async function migrate(caseName: string, settings: Prisma.InputJsonObject, methods: readonly SavedMethodSeed[]): Promise<Observed> {
  const migrationSql = readFileSync(join(__dirname, '..', 'prisma', 'migrations', MIGRATION, 'migration.sql'), 'utf8');
  let observed: Observed | null = null;
  await assert.rejects(
    prisma.$transaction(
      async (tx) => {
        await tx.savedPaymentMethod.updateMany({
          where: { gatewayType: PaymentGatewayType.YOOKASSA },
          data: { isActive: false },
        });
        await tx.paymentGateway.upsert({
          where: { type: PaymentGatewayType.YOOKASSA },
          create: { type: PaymentGatewayType.YOOKASSA, currency: Currency.RUB, settings },
          update: { settings },
        });
        const userId = `${prefix}-${caseName}`;
        await tx.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId } });
        for (const method of methods) {
          await tx.savedPaymentMethod.create({
            data: {
              userId,
              gatewayType: PaymentGatewayType.YOOKASSA,
              providerMethodId: `${method.providerMethodId}-${userId}`,
              methodType: 'bank_card',
              isActive: method.isActive,
            },
          });
        }

        const read = async () =>
          (await tx.paymentGateway.findUniqueOrThrow({ where: { type: PaymentGatewayType.YOOKASSA } })).settings;
        await tx.$executeRawUnsafe(migrationSql);
        const afterFirstRun = await read();
        await tx.$executeRawUnsafe(migrationSql);
        observed = { afterFirstRun, afterReplay: await read() };
        throw new RolledBack();
      },
      { maxWait: 15_000, timeout: 60_000 },
    ),
    RolledBack,
  );
  if (observed === null) throw new Error('the transaction never reached its end');
  return observed;
}

run('writing «Автоплатежи одобрены провайдером» for ЮKassa on upgrade, on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    prisma = new PrismaService();
    await prisma.$connect();
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.$disconnect();
  });

  it('switches autopay ON where a customer holds an active saved method, keeping every other key', async () => {
    const observed = await migrate('approved', { shopId: 'shop-1' }, [
      { providerMethodId: 'pm-live', isActive: true },
      { providerMethodId: 'pm-unbound', isActive: false },
    ]);
    assert.deepEqual(observed.afterFirstRun, { shopId: 'shop-1', savePaymentMethod: true });
    assert.deepEqual(observed.afterReplay, observed.afterFirstRun);
  });

  it('switches autopay OFF where only unbound or demo methods exist, and where none do', async () => {
    const onlyDeadOrDemo = await migrate('dead-or-demo', { shopId: 'shop-1' }, [
      { providerMethodId: 'pm-unbound', isActive: false },
      { providerMethodId: 'demo_pm_1', isActive: true },
    ]);
    assert.deepEqual(onlyDeadOrDemo.afterFirstRun, { shopId: 'shop-1', savePaymentMethod: false });
    assert.deepEqual(onlyDeadOrDemo.afterReplay, onlyDeadOrDemo.afterFirstRun);

    const none = await migrate('none', {}, []);
    assert.deepEqual(none.afterFirstRun, { savePaymentMethod: false });
  });

  it('keeps an operator’s OFF even where saved methods exist, in every form the panel reads as OFF', async () => {
    const off = await migrate('operator-off', { shopId: 'shop-1', savePaymentMethod: false }, [
      { providerMethodId: 'pm-live', isActive: true },
    ]);
    assert.deepEqual(off.afterFirstRun, { shopId: 'shop-1', savePaymentMethod: false });
    assert.deepEqual(off.afterReplay, off.afterFirstRun);

    for (const [caseName, value] of [
      ['off-text', ' No '],
      ['off-zero-text', '0'],
      ['off-zero', 0],
    ] as const) {
      const observed = await migrate(caseName, { savePaymentMethod: value }, [{ providerMethodId: 'pm-live', isActive: true }]);
      assert.deepEqual(observed.afterFirstRun, { savePaymentMethod: value }, caseName);
    }
  });

  it('does not take a stored ON as approval: the old dialog posted ON back on every save', async () => {
    const unproven = await migrate('stored-on', { savePaymentMethod: 'true' }, []);
    assert.deepEqual(unproven.afterFirstRun, { savePaymentMethod: false });
    assert.deepEqual(unproven.afterReplay, unproven.afterFirstRun);

    const proven = await migrate('stored-on-with-methods', { savePaymentMethod: true }, [
      { providerMethodId: 'pm-live', isActive: true },
    ]);
    assert.deepEqual(proven.afterFirstRun, { savePaymentMethod: true });
  });
});
