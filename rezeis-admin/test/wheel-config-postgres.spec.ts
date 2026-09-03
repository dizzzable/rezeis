import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Prisma, WheelSectorKind } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { WheelSectorService } from '../src/modules/wheel-config/services/wheel-sector.service';
import { lockWheel, unlockWheel } from './helpers/wheel-exclusive';

/**
 * The configurator against a real PostgreSQL.
 *
 * The guards are the point: a wheel whose spins never run out must not be
 * switchable on, and one that is already on must not be editable into that
 * state under somebody's feet. Both are judgements about the whole SET of
 * sectors, which is exactly what a per-row unit test cannot see.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;

let prisma: PrismaService;
let service: WheelSectorService;

function title(ru: string): Prisma.InputJsonValue {
  return { ru, en: ru };
}

/** Everything this spec creates, cleared between tests: there is one wheel. */
async function clearWheel(): Promise<void> {
  await prisma.wheelSector.deleteMany({});
}

async function addSector(input: {
  readonly kind: WheelSectorKind;
  readonly weight: number;
  readonly amount?: number;
  readonly enabled?: boolean;
  readonly manualInstructions?: string;
  readonly keyPoolId?: string;
}): Promise<string> {
  const before = await service.overview();
  await service.create(
    {
      kind: input.kind,
      title: title(input.kind),
      weight: input.weight,
      amount: input.amount ?? 0,
      promoRewardType: null,
      promoPlanId: null,
      promoLifetime: null,
      keyPoolId: input.keyPoolId ?? null,
      manualInstructions: input.manualInstructions ?? null,
      maxWinsPerUser: null,
      maxWinsTotal: null,
      enabled: input.enabled ?? true,
    },
    'admin-test',
  );
  const after = await service.overview();
  const added = after.sectors.find(
    (sector) => !before.sectors.some((existing) => existing.id === sector.id),
  );
  assert.ok(added, 'the sector was created');
  return added.id;
}

run('the wheel configurator on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    prisma = new PrismaService();
    await prisma.$connect();
    await lockWheel(prisma);
    service = new WheelSectorService(prisma);
  });

  after(async () => {
    if (prisma === undefined) return;
    await clearWheel().catch(() => undefined);
    // Leave the wheel off, whatever the last test did to it.
    await service.updateSettings({ enabled: false }).catch(() => undefined);
    await unlockWheel(prisma);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await service.updateSettings({ enabled: false });
    await clearWheel();
  });

  it('derives the percentages, so the column always totals a hundred', async () => {
    await addSector({ kind: WheelSectorKind.NOTHING, weight: 70 });
    await addSector({ kind: WheelSectorKind.POINTS, weight: 25, amount: 50 });
    await addSector({ kind: WheelSectorKind.DAYS, weight: 5, amount: 3 });

    const overview = await service.overview();

    assert.equal(overview.economy.totalWeight, 100);
    const total = overview.sectors.reduce((sum, sector) => sum + sector.chancePercent, 0);
    assert.equal(Math.round(total), 100);
    assert.deepEqual(
      overview.sectors.map((sector) => sector.chancePercent),
      [70, 25, 5],
    );
  });

  it('keeps the percentages adding up after a weight changes', async () => {
    // Nothing has to be re-saved and nothing can drift: the figures are read
    // from the weights, never stored beside them.
    const loss = await addSector({ kind: WheelSectorKind.NOTHING, weight: 70 });
    await addSector({ kind: WheelSectorKind.POINTS, weight: 30, amount: 50 });

    await service.update(loss, {
      kind: WheelSectorKind.NOTHING,
      title: title('не повезло'),
      weight: 10,
      amount: 0,
      promoRewardType: null,
      promoPlanId: null,
      promoLifetime: null,
      keyPoolId: null,
      manualInstructions: null,
      maxWinsPerUser: null,
      maxWinsTotal: null,
      enabled: true,
    });

    const overview = await service.overview();
    assert.equal(overview.economy.totalWeight, 40);
    assert.deepEqual(
      overview.sectors.map((sector) => Math.round(sector.chancePercent)),
      [25, 75],
    );
  });

  it('refuses to switch on a wheel whose spins never run out', async () => {
    // Weights that add up to a hundred; a wheel that still pays for itself.
    await addSector({ kind: WheelSectorKind.NOTHING, weight: 70 });
    await addSector({ kind: WheelSectorKind.POINTS, weight: 5, amount: 50 });
    await addSector({ kind: WheelSectorKind.SPINS, weight: 25, amount: 5 });

    await assert.rejects(() => service.updateSettings({ enabled: true }), /не кончатся/i);

    const overview = await service.overview();
    assert.equal(overview.settings.enabled, false, 'and it really is still off');
    assert.equal(overview.economy.perpetual, true);
    assert.deepEqual(overview.blockers, ['PERPETUAL']);
  });

  it('refuses to switch on a wheel with no loss sector', async () => {
    await addSector({ kind: WheelSectorKind.POINTS, weight: 100, amount: 10 });

    await assert.rejects(() => service.updateSettings({ enabled: true }), /не повезло/i);
    assert.equal((await service.overview()).settings.enabled, false);
  });

  it('switches on a sound wheel and reports what it is worth', async () => {
    await addSector({ kind: WheelSectorKind.NOTHING, weight: 90 });
    await addSector({ kind: WheelSectorKind.SPINS, weight: 10, amount: 5 });

    const overview = await service.updateSettings({
      enabled: true,
      freeSpinCooldownHours: 24,
      spinPricePoints: 150,
    });

    assert.equal(overview.settings.enabled, true);
    assert.equal(overview.settings.freeSpinCooldownHours, 24);
    assert.equal(overview.settings.spinPricePoints, 150);
    assert.deepEqual(overview.blockers, []);
    // Half a spin back each time, so one bought spin is really two.
    assert.equal(overview.economy.spinsReturnedPerSpin, 0.5);
    assert.equal(overview.economy.expectedTotalSpins, 2);
  });

  it('will not let a live wheel be edited into a perpetual one', async () => {
    await addSector({ kind: WheelSectorKind.NOTHING, weight: 90 });
    const spins = await addSector({ kind: WheelSectorKind.SPINS, weight: 10, amount: 2 });
    await service.updateSettings({ enabled: true });

    await assert.rejects(
      () =>
        service.update(spins, {
          kind: WheelSectorKind.SPINS,
          title: title('прокруты'),
          weight: 60,
          amount: 5,
          promoRewardType: null,
          promoPlanId: null,
          promoLifetime: null,
          keyPoolId: null,
          manualInstructions: null,
          maxWinsPerUser: null,
          maxWinsTotal: null,
          enabled: true,
        }),
      /ломает/i,
    );

    // AND THE EDIT IS GONE. The refusal used to be a lie: the write had
    // already committed and only the reply said otherwise, so an operator
    // read "эта правка его ломает" while the live wheel paid spins forever.
    const after = await prisma.wheelSector.findUnique({
      where: { id: spins },
      select: { weight: true, amount: true },
    });
    assert.equal(after?.weight, 10, 'the weight is what it was');
    assert.equal(after?.amount, 2, 'and so is the prize');
    const overview = await service.overview();
    assert.equal(overview.economy.perpetual, false, 'the live wheel still ends');
  });

  it('will not let the loss sector be deleted out from under a live wheel', async () => {
    const loss = await addSector({ kind: WheelSectorKind.NOTHING, weight: 90 });
    await addSector({ kind: WheelSectorKind.POINTS, weight: 10, amount: 5 });
    await service.updateSettings({ enabled: true });

    await assert.rejects(() => service.remove(loss), /не повезло/i);

    // Same again, and worse if it were not undone: the sector the refusal is
    // about would already have been deleted.
    const survivor = await prisma.wheelSector.findUnique({
      where: { id: loss },
      select: { id: true },
    });
    assert.ok(survivor !== null, 'the loss sector is still there');
  });

  it('lets a half-finished wheel be built while it is off', async () => {
    // An operator passes through states a live wheel would refuse. A
    // configurator that fought them there is a configurator people fight.
    await addSector({ kind: WheelSectorKind.SPINS, weight: 100, amount: 9 });

    const overview = await service.overview();
    assert.equal(overview.economy.perpetual, true, 'plainly broken');
    assert.equal(overview.settings.enabled, false, 'and plainly not live');
  });

  it('refuses a sector that could never pay, on or off', async () => {
    await assert.rejects(
      () =>
        service.create(
          {
            kind: WheelSectorKind.KEY,
            title: title('ключ'),
            weight: 10,
            amount: 0,
            promoRewardType: null,
            promoPlanId: null,
            promoLifetime: null,
            keyPoolId: null,
            manualInstructions: null,
            maxWinsPerUser: null,
            maxWinsTotal: null,
          },
          'admin-test',
        ),
      /пул ключей/i,
    );
  });

  it('shows how many keys are left behind a key sector', async () => {
    const pool = await prisma.wheelKeyPool.create({
      data: { name: 'cfg-pool', keys: { create: [{ value: 'K1' }, { value: 'K2' }] } },
      select: { id: true },
    });
    try {
      await addSector({ kind: WheelSectorKind.NOTHING, weight: 90 });
      await addSector({ kind: WheelSectorKind.KEY, weight: 10, keyPoolId: pool.id });

      const overview = await service.overview();
      const keySector = overview.sectors.find((sector) => sector.kind === WheelSectorKind.KEY);
      assert.equal(keySector?.keysAvailable, 2);
      const lossSector = overview.sectors.find((sector) => sector.kind === WheelSectorKind.NOTHING);
      assert.equal(lossSector?.keysAvailable, null, 'nothing else has stock to run out');
    } finally {
      await clearWheel();
      await prisma.wheelKeyPool.delete({ where: { id: pool.id } }).catch(() => undefined);
    }
  });

  it('refuses a reorder that names one sector twice', async () => {
    // The same length as the wheel, so a length check alone waves it through
    // — and the sector it silently drops keeps a stale order that can now
    // collide with somebody else's.
    const first = await addSector({ kind: WheelSectorKind.NOTHING, weight: 50 });
    await addSector({ kind: WheelSectorKind.POINTS, weight: 50, amount: 5 });

    await assert.rejects(() => service.reorder([first, first]), /ровно один раз/i);
  });

  it('reorders the wheel, and refuses a list that forgets a sector', async () => {
    const a = await addSector({ kind: WheelSectorKind.NOTHING, weight: 50 });
    const b = await addSector({ kind: WheelSectorKind.POINTS, weight: 30, amount: 5 });
    const c = await addSector({ kind: WheelSectorKind.DAYS, weight: 20, amount: 3 });

    const reordered = await service.reorder([c, a, b]);
    assert.deepEqual(reordered.sectors.map((sector) => sector.id), [c, a, b]);

    // A partial list would leave the missing sectors sharing an order with
    // somebody, and the slot order is what a person sees.
    await assert.rejects(() => service.reorder([a, b]), /ровно один раз/i);
  });

  it('keeps a spin readable after its sector is deleted', async () => {
    const loss = await addSector({ kind: WheelSectorKind.NOTHING, weight: 100 });
    const user = await prisma.user.create({
      data: { id: 'cfg-spin-user', referralCode: 'cfg-spin-ref', name: 'cfg' },
      select: { id: true },
    });
    const spin = await prisma.wheelSpin.create({
      data: {
        userId: user.id,
        sectorId: loss,
        sectorSnapshot: { title: { ru: 'не повезло' } },
        kind: WheelSectorKind.NOTHING,
        status: 'EMPTY',
        paidWith: 'BALANCE',
        idempotencyKey: 'cfg-spin-1',
      },
      select: { id: true },
    });

    try {
      await service.remove(loss);

      const after = await prisma.wheelSpin.findUnique({
        where: { id: spin.id },
        select: { sectorId: true, sectorSnapshot: true },
      });
      assert.equal(after?.sectorId, null, 'the reference goes');
      assert.deepEqual(after?.sectorSnapshot, { title: { ru: 'не повезло' } }, 'the history stays');
    } finally {
      await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    }
  });

  it('counts the spins taken, as context for the numbers above', async () => {
    const overview = await service.overview();

    assert.equal(typeof overview.spins.total, 'number');
    assert.equal(typeof overview.spins.pending, 'number');
  });
});
