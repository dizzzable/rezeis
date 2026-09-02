import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Prisma, WheelSectorKind, WheelSpinStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { RewardGrantService } from '../src/modules/rewards/reward-grant.service';
import { SpinWalletService } from '../src/modules/wheel/services/spin-wallet.service';
import { WheelSpinService } from '../src/modules/wheel/services/wheel-spin.service';
import { WheelCabinetService } from '../src/modules/wheel-cabinet/services/wheel-cabinet.service';
import { WheelSectorService } from '../src/modules/wheel-config/services/wheel-sector.service';
import { lockWheel, unlockWheel } from './helpers/wheel-exclusive';

/**
 * The cabinet contract against a real PostgreSQL.
 *
 * Two things are worth pinning here and nowhere else. The odds must not reach
 * the person spinning — the owner's decision, and the kind of leak that
 * arrives by somebody adding a convenient field years later. And buying spins
 * with points must be one movement or none: a debit that lands without its
 * credit is somebody paying for nothing.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `cab-${process.pid}-${Date.now()}`;

let prisma: PrismaService;
let cabinet: WheelCabinetService;
let spinService: WheelSpinService;
let config: WheelSectorService;

const createdUsers: string[] = [];

/** Always lands on the first candidate the pool offers. */
const FIRST = (): number => 0;

async function createUser(suffix: string, spinBalance = 0, points = 0): Promise<string> {
  const id = `${prefix}-${suffix}`;
  await prisma.user.create({
    data: { id, referralCode: `${id}-ref`, name: suffix, spinBalance, points },
  });
  createdUsers.push(id);
  return id;
}

async function addSector(input: {
  readonly kind: WheelSectorKind;
  readonly weight: number;
  readonly amount?: number;
  readonly order: number;
  readonly maxWinsPerUser?: number;
  readonly manualInstructions?: string;
  readonly keyPoolId?: string;
}): Promise<string> {
  const sector = await prisma.wheelSector.create({
    data: {
      kind: input.kind,
      title: { ru: input.kind, en: input.kind } as Prisma.InputJsonValue,
      weight: input.weight,
      amount: input.amount ?? 0,
      order: input.order,
      enabled: true,
      ...(input.maxWinsPerUser === undefined ? {} : { maxWinsPerUser: input.maxWinsPerUser }),
      ...(input.manualInstructions === undefined
        ? {}
        : { manualInstructions: input.manualInstructions }),
      ...(input.keyPoolId === undefined ? {} : { keyPoolId: input.keyPoolId }),
    },
    select: { id: true },
  });
  return sector.id;
}

run('the wheel cabinet contract on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    prisma = new PrismaService();
    await prisma.$connect();
    await lockWheel(prisma);
    const spinWallet = new SpinWalletService();
    const pointsWallet = new PointsWalletService();
    spinService = new WheelSpinService(
      prisma,
      spinWallet,
      new RewardGrantService(pointsWallet),
    );
    cabinet = new WheelCabinetService(prisma, spinService, spinWallet, pointsWallet);
    config = new WheelSectorService(prisma);
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.wheelSector.deleteMany({}).catch(() => undefined);
    await config.updateSettings({ enabled: false }).catch(() => undefined);
    for (const id of createdUsers) {
      await prisma.user.delete({ where: { id } }).catch(() => undefined);
    }
    await unlockWheel(prisma);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await config.updateSettings({ enabled: false, spinPricePoints: null, freeSpinCooldownHours: null });
    await prisma.wheelSector.deleteMany({});
  });

  it('never tells the person the odds', async () => {
    // THE OWNER'S DECISION, pinned against the response itself rather than
    // against the type: a convenient field added years from now would compile.
    await addSector({ kind: WheelSectorKind.NOTHING, weight: 70, order: 0 });
    await addSector({ kind: WheelSectorKind.POINTS, weight: 30, amount: 50, order: 1 });
    await config.updateSettings({ enabled: true });
    const userId = await createUser('odds', 1);

    const view = await cabinet.view(userId);

    const serialised = JSON.stringify(view);
    for (const leak of ['weight', 'chance', 'percent', 'totalWeight', 'odds']) {
      assert.doesNotMatch(serialised, new RegExp(leak, 'i'), `"${leak}" reached the cabinet`);
    }
    // And the numbers themselves are absent, not merely renamed.
    for (const sector of view.sectors) {
      assert.deepEqual(Object.keys(sector).sort(), [
        'amount',
        'available',
        'iconKind',
        'iconRef',
        'id',
        'kind',
        'rarity',
        'title',
        'unavailable',
      ]);
    }
  });

  it('greys out what this person has already won, and says why', async () => {
    const once = await addSector({
      kind: WheelSectorKind.POINTS,
      weight: 100,
      amount: 25,
      order: 0,
      maxWinsPerUser: 1,
    });
    await addSector({ kind: WheelSectorKind.NOTHING, weight: 1, order: 1 });
    await config.updateSettings({ enabled: true });
    const userId = await createUser('cap', 2);

    const before = await cabinet.view(userId);
    assert.equal(before.sectors.find((s) => s.id === once)?.available, true);

    await spinService.spin({
      userId,
      idempotencyKey: 'cab-cap-1',
      settings: await spinService.readSettings(),
      random: FIRST,
    });

    const after = await cabinet.view(userId);
    const capped = after.sectors.find((sector) => sector.id === once);
    assert.equal(capped?.available, false);
    assert.equal(capped?.unavailable, 'ALREADY_WON');
    // Still listed: a prize that vanishes reads as a bug, not as a rule.
    assert.ok(capped);
  });

  it('hides a sector the operator broke rather than explaining it', async () => {
    // A KEY sector with no pool is excluded from the draw as UNCONFIGURED.
    // That is the operator's mistake, and a customer told about it learns
    // nothing they can act on.
    await addSector({ kind: WheelSectorKind.NOTHING, weight: 100, order: 0 });
    const broken = await prisma.wheelSector.create({
      data: {
        kind: WheelSectorKind.KEY,
        title: { ru: 'ключ' } as Prisma.InputJsonValue,
        weight: 10,
        order: 1,
        enabled: true,
      },
      select: { id: true },
    });
    await config.updateSettings({ enabled: true });
    const userId = await createUser('broken', 1);

    const view = await cabinet.view(userId);

    assert.equal(view.sectors.some((sector) => sector.id === broken.id), false);
  });

  it('knows whether a spin can be taken at all', async () => {
    await addSector({ kind: WheelSectorKind.NOTHING, weight: 100, order: 0 });
    await config.updateSettings({ enabled: true });
    const broke = await createUser('broke-spin', 0);
    const flush = await createUser('flush-spin', 3);

    assert.equal((await cabinet.view(broke)).canSpin, false);
    assert.equal((await cabinet.view(flush)).canSpin, true);

    // The free spin counts even with an empty balance.
    await config.updateSettings({ freeSpinCooldownHours: 24 });
    const withFree = await cabinet.view(broke);
    assert.equal(withFree.freeSpin.available, true);
    assert.equal(withFree.canSpin, true);
  });

  it('says the wheel is off without pretending it has sectors', async () => {
    await addSector({ kind: WheelSectorKind.NOTHING, weight: 100, order: 0 });
    const userId = await createUser('off', 5);

    const view = await cabinet.view(userId);

    assert.equal(view.enabled, false);
    assert.equal(view.canSpin, false);
  });

  it('buys spins with points in one movement or none', async () => {
    await addSector({ kind: WheelSectorKind.NOTHING, weight: 100, order: 0 });
    await config.updateSettings({ enabled: true, spinPricePoints: 100 });
    const userId = await createUser('buy', 0, 350);

    const result = await cabinet.buySpins({ userId, count: 3, idempotencyKey: 'cab-buy-1' });

    assert.equal(result.spinBalance, 3);
    assert.equal(result.pointsBalance, 50);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { points: true, spinBalance: true },
    });
    assert.equal(user?.points, 50);
    assert.equal(user?.spinBalance, 3);
    // Both journals agree with both balances.
    const points = await prisma.pointsLedgerEntry.findMany({ where: { userId } });
    const spins = await prisma.spinLedgerEntry.findMany({ where: { userId } });
    assert.equal(points.reduce((sum, row) => sum + row.delta, 0), -300);
    assert.equal(spins.reduce((sum, row) => sum + row.delta, 0), 3);
  });

  it('charges nothing when the points are not there', async () => {
    await addSector({ kind: WheelSectorKind.NOTHING, weight: 100, order: 0 });
    await config.updateSettings({ enabled: true, spinPricePoints: 100 });
    const userId = await createUser('poor', 0, 50);

    await assert.rejects(
      () => cabinet.buySpins({ userId, count: 3, idempotencyKey: 'cab-poor-1' }),
      /баллов/i,
    );

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { points: true, spinBalance: true },
    });
    assert.equal(user?.points, 50, 'the points are untouched');
    assert.equal(user?.spinBalance, 0, 'and no spins were handed out');
  });

  it('a replayed purchase charges once', async () => {
    await addSector({ kind: WheelSectorKind.NOTHING, weight: 100, order: 0 });
    await config.updateSettings({ enabled: true, spinPricePoints: 100 });
    const userId = await createUser('replay-buy', 0, 500);

    const first = await cabinet.buySpins({ userId, count: 2, idempotencyKey: 'cab-rb-1' });
    const again = await cabinet.buySpins({ userId, count: 2, idempotencyKey: 'cab-rb-1' });

    assert.deepEqual(again, first);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { points: true, spinBalance: true },
    });
    assert.equal(user?.points, 300);
    assert.equal(user?.spinBalance, 2);
  });

  it('refuses to sell spins the operator never priced', async () => {
    await addSector({ kind: WheelSectorKind.NOTHING, weight: 100, order: 0 });
    await config.updateSettings({ enabled: true });
    const userId = await createUser('unpriced', 0, 1000);

    await assert.rejects(
      () => cabinet.buySpins({ userId, count: 1, idempotencyKey: 'cab-unpriced-1' }),
      /нельзя купить/i,
    );
  });

  it('shows the winner their key, which is the whole point of winning one', async () => {
    const pool = await prisma.wheelKeyPool.create({
      data: { name: `${prefix}-pool`, keys: { create: [{ value: 'STEAM-ABCDE-12345' }] } },
      select: { id: true },
    });
    try {
      await addSector({ kind: WheelSectorKind.KEY, weight: 100, order: 0, keyPoolId: pool.id });
      await addSector({ kind: WheelSectorKind.NOTHING, weight: 1, order: 1 });
      await config.updateSettings({ enabled: true });
      const userId = await createUser('key-win', 1);

      const spun = await spinService.spin({
        userId,
        idempotencyKey: 'cab-key-1',
        settings: await spinService.readSettings(),
        random: FIRST,
      });
      assert.ok(spun.spun);
      assert.equal(spun.kind, WheelSectorKind.KEY);

      const history = await cabinet.history({ userId });
      assert.deepEqual(history.items[0]?.prize, { key: 'STEAM-ABCDE-12345' });
    } finally {
      await prisma.wheelSector.deleteMany({});
      await prisma.wheelKeyPool.delete({ where: { id: pool.id } }).catch(() => undefined);
    }
  });

  it('does not pass the operator note on with a manual prize', async () => {
    // The instruction is what the operator told themselves to do. Whatever it
    // says — a bank detail, a shortcut, a caveat — it is not a promise made
    // to the person who won.
    await addSector({
      kind: WheelSectorKind.MANUAL,
      weight: 100,
      order: 0,
      manualInstructions: 'Перевести 1000 ₽ на карту, лимит на сегодня исчерпан',
    });
    // The loss sector is required to switch the wheel on at all — the guard
    // caught this test forgetting it, which is the guard working.
    await addSector({ kind: WheelSectorKind.NOTHING, weight: 1, order: 1 });
    await config.updateSettings({ enabled: true });
    const userId = await createUser('manual-win', 1);

    await spinService.spin({
      userId,
      idempotencyKey: 'cab-manual-1',
      settings: await spinService.readSettings(),
      random: FIRST,
    });

    const history = await cabinet.history({ userId });
    assert.equal(history.items[0]?.status, WheelSpinStatus.PENDING);
    assert.equal(history.items[0]?.prize, null);
    assert.doesNotMatch(JSON.stringify(history.items[0]), /1000|лимит/);
  });

  it('reads back a loss as a loss and a win as what it gave', async () => {
    await addSector({ kind: WheelSectorKind.POINTS, weight: 100, amount: 40, order: 0 });
    await addSector({ kind: WheelSectorKind.NOTHING, weight: 1, order: 1 });
    await config.updateSettings({ enabled: true });
    const userId = await createUser('history', 2);

    const settings = await spinService.readSettings();
    await spinService.spin({ userId, idempotencyKey: 'cab-h-1', settings, random: FIRST });
    await spinService.spin({ userId, idempotencyKey: 'cab-h-2', settings, random: () => 0.999 });

    const history = await cabinet.history({ userId });
    assert.equal(history.items.length, 2);
    const kinds = history.items.map((item) => item.kind).sort();
    assert.deepEqual(kinds, [WheelSectorKind.NOTHING, WheelSectorKind.POINTS]);
    const win = history.items.find((item) => item.kind === WheelSectorKind.POINTS);
    const loss = history.items.find((item) => item.kind === WheelSectorKind.NOTHING);
    assert.deepEqual(win?.prize, { points: 40 });
    assert.equal(loss?.prize, null);
    assert.equal(loss?.status, WheelSpinStatus.EMPTY);
  });

  it('shows one person only their own spins', async () => {
    await addSector({ kind: WheelSectorKind.NOTHING, weight: 100, order: 0 });
    await config.updateSettings({ enabled: true });
    const mine = await createUser('mine', 1);
    const theirs = await createUser('theirs', 1);
    const settings = await spinService.readSettings();
    await spinService.spin({ userId: mine, idempotencyKey: 'cab-mine-1', settings, random: FIRST });
    await spinService.spin({ userId: theirs, idempotencyKey: 'cab-theirs-1', settings, random: FIRST });

    const history = await cabinet.history({ userId: mine });

    assert.equal(history.items.length, 1);
    const spin = await prisma.wheelSpin.findUnique({
      where: { id: history.items[0]?.spinId ?? '' },
      select: { userId: true },
    });
    assert.equal(spin?.userId, mine);
  });
});
