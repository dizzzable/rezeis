import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma, WheelSectorKind, WheelSpinStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { lockWheel, unlockWheel } from './helpers/wheel-exclusive';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { RewardGrantService } from '../src/modules/rewards/reward-grant.service';
import { SpinWalletService } from '../src/modules/wheel/services/spin-wallet.service';
import { WheelSpinService } from '../src/modules/wheel/services/wheel-spin.service';
import type { WheelSettings } from '../src/modules/wheel/wheel-settings.util';

/**
 * The spin against a real PostgreSQL, because everything worth checking here
 * is a property of the database and not of the code.
 *
 * A ceiling that two simultaneous winners cannot both pass, a key that two
 * spinners cannot both be handed, a refusal that gives the spin back — those
 * are locks, conditional writes and transaction boundaries. A fake has none
 * of them, so a fake would agree with any implementation, correct or not.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `wheel-${process.pid}-${Date.now()}`;

let prisma: PrismaService;
let service: WheelSpinService;

const ON: WheelSettings = { enabled: true, freeSpinCooldownHours: null, spinPricePoints: null };

/** Always lands on the first candidate the pool offers. */
const FIRST = (): number => 0;

const createdUsers: string[] = [];
const createdSectors: string[] = [];
const createdPools: string[] = [];

async function createUser(suffix: string, spinBalance = 0): Promise<string> {
  const id = `${prefix}-${suffix}`;
  await prisma.user.create({
    data: { id, referralCode: `${id}-ref`, name: suffix, spinBalance },
  });
  createdUsers.push(id);
  return id;
}

/**
 * There is ONE wheel, so every test has to start from an empty one: a sector
 * another test left enabled is a sector this test can land on. The first
 * version of this file did not do that and the failures moved around between
 * runs, which is exactly what a shared wheel looks like.
 */
async function resetWheel(): Promise<void> {
  await prisma.wheelSector.deleteMany({ where: { id: { startsWith: prefix } } });

  // There is ONE wheel and these specs share a database, so a sector another
  // FILE leaves enabled is a sector this file can land on — and the symptom is
  // a draw that pays the wrong prize, which reads like a bug in the draw. Say
  // so plainly instead. Anything that needs a sector row without spinning
  // should create it disabled.
  const foreign = await prisma.wheelSector.findMany({
    where: { enabled: true, id: { not: { startsWith: prefix } } },
    select: { id: true },
  });
  assert.deepEqual(
    foreign.map((sector) => sector.id),
    [],
    'another spec left an enabled sector on the shared wheel; create sectors disabled unless you spin',
  );
}

/**
 * `order` is explicit and distinct, because `FIRST` means "the first
 * candidate the pool offers" and the pool is ordered by it. Two sectors
 * sharing an order leave that undefined.
 */
async function createSector(
  suffix: string,
  order: number,
  data: Partial<Prisma.WheelSectorUncheckedCreateInput> & { kind: WheelSectorKind },
): Promise<string> {
  const id = `${prefix}-${suffix}`;
  await prisma.wheelSector.create({
    data: { id, weight: 100, enabled: true, order, ...data },
  });
  createdSectors.push(id);
  return id;
}

async function createPool(suffix: string, keys: readonly string[]): Promise<string> {
  const id = `${prefix}-${suffix}`;
  await prisma.wheelKeyPool.create({ data: { id, name: suffix } });
  createdPools.push(id);
  for (const [index, value] of keys.entries()) {
    await prisma.wheelKey.create({ data: { id: `${id}-k${index}`, poolId: id, value } });
  }
  return id;
}

run('WheelSpinService on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    prisma = new PrismaService();
    await prisma.$connect();
    await lockWheel(prisma);
    service = new WheelSpinService(
      prisma,
      new SpinWalletService(),
      new RewardGrantService(new PointsWalletService()),
    );
  });

  after(async () => {
    if (prisma === undefined) return;
    for (const id of createdUsers) {
      await prisma.user.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of createdSectors) {
      await prisma.wheelSector.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of createdPools) {
      await prisma.wheelKeyPool.delete({ where: { id } }).catch(() => undefined);
    }
    await unlockWheel(prisma);
    await prisma.$disconnect();
  });

  it('pays the drawn sector and spends exactly one spin', async () => {
    await resetWheel();
    const userId = await createUser('pay', 3);
    await createSector('pay-points', 0, { kind: WheelSectorKind.POINTS, amount: 25 });

    const result = await service.spin({
      userId,
      idempotencyKey: 'pay-1',
      settings: ON,
      random: FIRST,
    });

    assert.equal(result.spun, true);
    assert.ok(result.spun);
    assert.equal(result.status, WheelSpinStatus.SETTLED);
    assert.equal(result.kind, WheelSectorKind.POINTS);
    assert.equal(result.paidWith, 'BALANCE');
    assert.equal(result.spinBalanceAfter, 2, 'one spin spent, not two and not none');

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { points: true } });
    assert.equal(user?.points, 25, 'and the prize actually arrived');
  });

  it('serves a replayed request from the spin it already has, free of charge', async () => {
    await resetWheel();
    const userId = await createUser('replay', 5);
    await createSector('replay-points', 0, { kind: WheelSectorKind.POINTS, amount: 10 });

    const first = await service.spin({ userId, idempotencyKey: 'r-1', settings: ON, random: FIRST });
    const again = await service.spin({ userId, idempotencyKey: 'r-1', settings: ON, random: FIRST });

    assert.ok(first.spun && again.spun);
    assert.equal(again.spinId, first.spinId, 'the same spin, not a new one');
    assert.equal(again.replayed, true);
    assert.equal(again.spinBalanceAfter, 4, 'the balance moved once');

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { points: true } });
    assert.equal(user?.points, 10, 'and the prize was paid once');
  });

  it('two requests racing with the SAME handle spend one spin between them', async () => {
    await resetWheel();
    const userId = await createUser('race-key', 5);
    await createSector('race-key-points', 0, { kind: WheelSectorKind.POINTS, amount: 7 });

    const [a, b] = await Promise.all([
      service.spin({ userId, idempotencyKey: 'race-1', settings: ON, random: FIRST }),
      service.spin({ userId, idempotencyKey: 'race-1', settings: ON, random: FIRST }),
    ]);

    assert.ok(a.spun && b.spun);
    assert.equal(a.spinId, b.spinId, 'both are told about the same spin');
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { spinBalance: true, points: true },
    });
    assert.equal(user?.spinBalance, 4);
    assert.equal(user?.points, 7);
  });

  it('refuses when there is nothing to spend, and takes nothing', async () => {
    await resetWheel();
    const userId = await createUser('broke', 0);
    await createSector('broke-points', 0, { kind: WheelSectorKind.POINTS, amount: 5 });

    const result = await service.spin({
      userId,
      idempotencyKey: 'broke-1',
      settings: ON,
      random: FIRST,
    });

    assert.deepEqual(result, { spun: false, reason: 'NO_SPINS' });
    assert.equal(await prisma.wheelSpin.count({ where: { userId } }), 0);
  });

  it('gives the spin back when the wheel has nothing on it', async () => {
    await resetWheel();
    // The payment happens before the wheel is read, so this is the case that
    // proves the refusal rolls it back rather than pocketing it.
    const userId = await createUser('empty-wheel', 2);
    await createSector('empty-wheel-off', 0, {
      kind: WheelSectorKind.POINTS,
      amount: 5,
      enabled: false,
    });

    const result = await service.spin({
      userId,
      idempotencyKey: 'empty-1',
      settings: ON,
      random: FIRST,
    });

    assert.deepEqual(result, { spun: false, reason: 'WHEEL_UNAVAILABLE' });
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { spinBalance: true },
    });
    assert.equal(user?.spinBalance, 2, 'the spin was handed back');
    assert.equal(await prisma.spinLedgerEntry.count({ where: { userId } }), 0, 'and left no trace');
  });

  it('refuses outright when the operator has not switched the wheel on', async () => {
    await resetWheel();
    const userId = await createUser('off', 2);

    const result = await service.spin({
      userId,
      idempotencyKey: 'off-1',
      settings: { ...ON, enabled: false },
      random: FIRST,
    });

    assert.deepEqual(result, { spun: false, reason: 'WHEEL_DISABLED' });
  });

  it('records a loss as EMPTY and hands over nothing', async () => {
    await resetWheel();
    const userId = await createUser('loss', 2);
    await createSector('loss-nothing', 0, { kind: WheelSectorKind.NOTHING });

    const result = await service.spin({
      userId,
      idempotencyKey: 'loss-1',
      settings: ON,
      random: FIRST,
    });

    assert.ok(result.spun);
    assert.equal(result.status, WheelSpinStatus.EMPTY);
    assert.equal(result.outcome, null);
    const spin = await prisma.wheelSpin.findUnique({
      where: { id: result.spinId },
      select: { settledAt: true },
    });
    assert.notEqual(spin?.settledAt, null, 'a loss is settled the moment it happens');
  });

  it('records a manual prize as owed, not as paid', async () => {
    await resetWheel();
    const userId = await createUser('manual', 2);
    await createSector('manual-jackpot', 0, {
      kind: WheelSectorKind.MANUAL,
      manualInstructions: 'Свяжитесь с победителем и переведите 1000 ₽',
    });

    const result = await service.spin({
      userId,
      idempotencyKey: 'manual-1',
      settings: ON,
      random: FIRST,
    });

    assert.ok(result.spun);
    assert.equal(result.status, WheelSpinStatus.PENDING);
    const spin = await prisma.wheelSpin.findUnique({
      where: { id: result.spinId },
      select: { settledAt: true, outcome: true },
    });
    assert.equal(spin?.settledAt, null, 'nothing has been settled yet');
    assert.deepEqual(spin?.outcome, {
      manual: true,
      instructions: 'Свяжитесь с победителем и переведите 1000 ₽',
    });
  });

  it('pays spins with spins, so a won turn is a turn', async () => {
    await resetWheel();
    const userId = await createUser('spins', 1);
    await createSector('spins-sector', 0, { kind: WheelSectorKind.SPINS, amount: 3 });

    const result = await service.spin({
      userId,
      idempotencyKey: 'spins-1',
      settings: ON,
      random: FIRST,
    });

    assert.ok(result.spun);
    // One spent, three won.
    assert.equal(result.spinBalanceAfter, 3);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { spinBalance: true },
    });
    assert.equal(user?.spinBalance, 3);

    const ledger = await prisma.spinLedgerEntry.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { delta: true, source: true, balanceAfter: true },
    });
    assert.deepEqual(
      ledger.map((row) => [row.source, row.delta, row.balanceAfter]),
      [
        ['SPENT', -1, 0],
        ['WHEEL_PRIZE', 3, 3],
      ],
      'and the journal still sums to the balance',
    );
  });

  it('hands out one key per spin and never the same key twice', async () => {
    await resetWheel();
    const poolId = await createPool('keys', ['KEY-AAA', 'KEY-BBB']);
    await createSector('keys-sector', 0, { kind: WheelSectorKind.KEY, keyPoolId: poolId });
    const one = await createUser('key-1', 1);
    const two = await createUser('key-2', 1);

    const [a, b] = await Promise.all([
      service.spin({ userId: one, idempotencyKey: 'k-1', settings: ON, random: FIRST }),
      service.spin({ userId: two, idempotencyKey: 'k-2', settings: ON, random: FIRST }),
    ]);

    assert.ok(a.spun && b.spun);
    const claimed = await prisma.wheelKey.findMany({
      where: { poolId },
      select: { id: true, claimedByUserId: true, claimedSpinId: true },
      orderBy: { id: 'asc' },
    });
    const owners = claimed.map((key) => key.claimedByUserId).filter((id) => id !== null);
    assert.equal(owners.length, 2, 'both keys went out');
    assert.equal(new Set(owners).size, 2, 'to two different people');
    assert.equal(
      claimed.every((key) => key.claimedSpinId !== null),
      true,
      'and each is stamped with the spin that won it',
    );
  });

  it('stops offering a key sector once the pool is empty, instead of paying nothing', async () => {
    await resetWheel();
    const poolId = await createPool('dry', ['ONLY-ONE']);
    await createSector('dry-key', 0, { kind: WheelSectorKind.KEY, keyPoolId: poolId, weight: 100 });
    await createSector('dry-nothing', 1, { kind: WheelSectorKind.NOTHING, weight: 1 });
    const userId = await createUser('dry-user', 2);

    const first = await service.spin({
      userId,
      idempotencyKey: 'dry-1',
      settings: ON,
      random: FIRST,
    });
    assert.ok(first.spun);
    assert.equal(first.kind, WheelSectorKind.KEY);

    // The pool is empty now. FIRST would land on the key sector again if it
    // were still a candidate; it is not, so the only sector left wins.
    const second = await service.spin({
      userId,
      idempotencyKey: 'dry-2',
      settings: ON,
      random: FIRST,
    });
    assert.ok(second.spun);
    assert.equal(second.kind, WheelSectorKind.NOTHING);
  });

  it('holds a per-user ceiling against that person spinning twice at once', async () => {
    await resetWheel();
    // Both requests arrive together; both would read "won zero times" if the
    // count were taken outside the lock the payment holds.
    const capped = await createSector('cap-user-prize', 0, {
      kind: WheelSectorKind.POINTS,
      amount: 50,
      weight: 100,
      maxWinsPerUser: 1,
    });
    await createSector('cap-user-nothing', 1, { kind: WheelSectorKind.NOTHING, weight: 1 });
    const userId = await createUser('cap-user', 4);

    const [a, b] = await Promise.all([
      service.spin({ userId, idempotencyKey: 'cu-1', settings: ON, random: FIRST }),
      service.spin({ userId, idempotencyKey: 'cu-2', settings: ON, random: FIRST }),
    ]);

    assert.ok(a.spun && b.spun);
    const wins = await prisma.wheelSpin.count({ where: { userId, sectorId: capped } });
    assert.equal(wins, 1, 'the ceiling of one held');
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { points: true } });
    assert.equal(user?.points, 50, 'and the prize was paid exactly once');
  });

  it('holds a global ceiling against two different people spinning at once', async () => {
    await resetWheel();
    const jackpot = await createSector('cap-total-prize', 0, {
      kind: WheelSectorKind.POINTS,
      amount: 40,
      weight: 100,
      maxWinsTotal: 1,
    });
    await createSector('cap-total-nothing', 1, { kind: WheelSectorKind.NOTHING, weight: 1 });
    const one = await createUser('cap-total-1', 1);
    const two = await createUser('cap-total-2', 1);

    const [a, b] = await Promise.all([
      service.spin({ userId: one, idempotencyKey: 'ct-1', settings: ON, random: FIRST }),
      service.spin({ userId: two, idempotencyKey: 'ct-2', settings: ON, random: FIRST }),
    ]);

    assert.ok(a.spun && b.spun);
    const wins = await prisma.wheelSpin.count({ where: { sectorId: jackpot } });
    assert.equal(wins, 1, 'only one of them got it');
    const sector = await prisma.wheelSector.findUnique({
      where: { id: jackpot },
      select: { wonCount: true },
    });
    assert.equal(sector?.wonCount, 1, 'and the counter says so too');
    // The loser was not simply refused: they were paid the other sector.
    const kinds = [a.kind, b.kind].sort();
    assert.deepEqual(kinds, [WheelSectorKind.NOTHING, WheelSectorKind.POINTS]);
  });

  it('keeps what the sector was, so editing it later does not rewrite history', async () => {
    await resetWheel();
    const sectorId = await createSector('snap', 0, {
      kind: WheelSectorKind.POINTS,
      amount: 15,
      title: { ru: 'Пятнадцать баллов' },
    });
    const userId = await createUser('snap-user', 1);

    const result = await service.spin({
      userId,
      idempotencyKey: 'snap-1',
      settings: ON,
      random: FIRST,
    });
    assert.ok(result.spun);

    await prisma.wheelSector.update({
      where: { id: sectorId },
      data: { amount: 999, title: { ru: 'Совсем другое' } },
    });

    const spin = await prisma.wheelSpin.findUnique({
      where: { id: result.spinId },
      select: { amount: true, sectorSnapshot: true },
    });
    assert.equal(spin?.amount, 15);
    assert.deepEqual((spin?.sectorSnapshot as { title: unknown }).title, {
      ru: 'Пятнадцать баллов',
    });
  });

  it('survives the sector being deleted afterwards', async () => {
    await resetWheel();
    const sectorId = await createSector('gone', 0, { kind: WheelSectorKind.POINTS, amount: 5 });
    const userId = await createUser('gone-user', 1);

    const result = await service.spin({
      userId,
      idempotencyKey: 'gone-1',
      settings: ON,
      random: FIRST,
    });
    assert.ok(result.spun);

    await prisma.wheelSector.delete({ where: { id: sectorId } });

    const spin = await prisma.wheelSpin.findUnique({
      where: { id: result.spinId },
      select: { sectorId: true, kind: true, amount: true, sectorSnapshot: true },
    });
    assert.equal(spin?.sectorId, null, 'the reference goes');
    assert.equal(spin?.kind, WheelSectorKind.POINTS, 'the history stays');
    assert.equal((spin?.sectorSnapshot as { amount: number }).amount, 5);
  });

  it('takes the free spin before the balance, and only once per cooldown', async () => {
    await resetWheel();
    const userId = await createUser('free', 1);
    await createSector('free-nothing', 0, { kind: WheelSectorKind.NOTHING });
    const settings: WheelSettings = { ...ON, freeSpinCooldownHours: 24 };

    const first = await service.spin({
      userId,
      idempotencyKey: 'f-1',
      settings,
      random: FIRST,
    });
    assert.ok(first.spun);
    assert.equal(first.paidWith, 'FREE');
    assert.equal(first.spinBalanceAfter, 1, 'the balance was not touched');

    const second = await service.spin({
      userId,
      idempotencyKey: 'f-2',
      settings,
      random: FIRST,
    });
    assert.ok(second.spun);
    assert.equal(second.paidWith, 'BALANCE', 'the free one is gone until the cooldown passes');
    assert.equal(second.spinBalanceAfter, 0);
  });
});
