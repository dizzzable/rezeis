import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { WheelSectorKind, WheelSpinStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { lockWheel, unlockWheel } from './helpers/wheel-exclusive';
import {
  KEY_LOAD_MAX,
  WheelKeyPoolService,
  maskKey,
} from '../src/modules/wheel-prizes/services/wheel-key-pool.service';

/**
 * Key pools against a real PostgreSQL.
 *
 * The interesting parts are all database rules: a batch pasted twice must not
 * double the pool, a key already handed over must survive every kind of
 * tidying, and a pool somebody has won from must refuse to be deleted at all.
 * The unique index and the conditional deletes are what enforce those, and a
 * fake has neither.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `kpool-${process.pid}-${Date.now()}`;

let prisma: PrismaService;
let service: WheelKeyPoolService;

const createdPools: string[] = [];
const createdUsers: string[] = [];
const createdSectors: string[] = [];

async function newPool(suffix: string): Promise<string> {
  const pool = await service.createPool({
    name: `${prefix}-${suffix}`,
    note: null,
    createdBy: 'admin-test',
  });
  createdPools.push(pool.id);
  return pool.id;
}

async function createUser(suffix: string): Promise<string> {
  const id = `${prefix}-${suffix}`;
  await prisma.user.create({ data: { id, referralCode: `${id}-ref`, name: suffix } });
  createdUsers.push(id);
  return id;
}

run('wheel key pools on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    prisma = new PrismaService();
    await prisma.$connect();
    await lockWheel(prisma);
    service = new WheelKeyPoolService(prisma);
  });

  after(async () => {
    if (prisma === undefined) return;
    for (const id of createdSectors) {
      await prisma.wheelSector.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of createdUsers) {
      await prisma.user.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of createdPools) {
      await prisma.wheelKeyPool.delete({ where: { id } }).catch(() => undefined);
    }
    await unlockWheel(prisma);
    await prisma.$disconnect();
  });

  it('loads a pasted batch and counts what is left', async () => {
    const poolId = await newPool('load');

    const result = await service.loadKeys(poolId, ['AAA-111', 'BBB-222', 'CCC-333']);

    assert.deepEqual(result, { received: 3, added: 3, duplicates: 0 });
    const pool = await service.getPool(poolId);
    assert.equal(pool.total, 3);
    assert.equal(pool.claimed, 0);
    assert.equal(pool.available, 3);
  });

  it('drops blank lines and trims, but never changes case', async () => {
    // A key is case-sensitive. "Helpfully" upper-casing a batch turns it into
    // rubbish nobody can redeem, and the supplier will not send another.
    const poolId = await newPool('trim');

    const result = await service.loadKeys(poolId, ['  aB-cD  ', '', '   ', '\tEf-Gh\n']);

    assert.deepEqual(result, { received: 2, added: 2, duplicates: 0 });
    const keys = await service.listKeys({ poolId, reveal: true });
    assert.deepEqual(
      keys.items.map((key) => key.value).sort(),
      ['aB-cD', 'Ef-Gh'].sort(),
    );
  });

  it('skips a key already in the pool instead of refusing the whole paste', async () => {
    // The realistic mistake is pasting a list that overlaps last week's.
    // Refusing all of it would make the operator diff two files by hand.
    const poolId = await newPool('dup');
    await service.loadKeys(poolId, ['ONE', 'TWO']);

    const second = await service.loadKeys(poolId, ['TWO', 'THREE', 'FOUR']);

    assert.deepEqual(second, { received: 3, added: 2, duplicates: 1 });
    assert.equal((await service.getPool(poolId)).total, 4);
  });

  it('counts a paste that repeats itself once', async () => {
    const poolId = await newPool('selfdup');

    const result = await service.loadKeys(poolId, ['SAME', 'SAME', 'SAME']);

    assert.equal(result.added, 1);
    assert.equal(result.duplicates, 2);
    assert.equal((await service.getPool(poolId)).total, 1);
  });

  it('refuses a paste with nothing in it', async () => {
    const poolId = await newPool('empty');

    await assert.rejects(() => service.loadKeys(poolId, ['', '   ']), /загружать/i);
  });

  it('refuses a batch bigger than one statement should carry', async () => {
    const poolId = await newPool('huge');
    const tooMany = Array.from({ length: KEY_LOAD_MAX + 1 }, (_, index) => `K-${index}`);

    await assert.rejects(() => service.loadKeys(poolId, tooMany), /не больше/i);
  });

  it('masks the values unless the caller may read them', async () => {
    const poolId = await newPool('mask');
    await service.loadKeys(poolId, ['ABCDE-FGHIJ-KLMNO']);

    const hidden = await service.listKeys({ poolId, reveal: false });
    const shown = await service.listKeys({ poolId, reveal: true });

    assert.equal(hidden.items[0]?.masked, true);
    assert.equal(hidden.items[0]?.value, '••••••LMNO');
    assert.doesNotMatch(hidden.items[0]?.value ?? '', /ABCDE/);
    assert.equal(shown.items[0]?.masked, false);
    assert.equal(shown.items[0]?.value, 'ABCDE-FGHIJ-KLMNO');
  });

  it('hides a short key completely rather than mostly', () => {
    // Six of eight characters left showing is not a mask, it is a hint.
    assert.equal(maskKey('SHORT'), '•••••');
    assert.equal(maskKey('AB'), '••••');
    assert.equal(maskKey('EXACTLY8'), '••••••••');
    assert.equal(maskKey('NINECHARS'), '••••••HARS');
  });

  it('separates what is left from what went out', async () => {
    const poolId = await newPool('split');
    await service.loadKeys(poolId, ['FREE-1', 'FREE-2', 'GONE-1']);
    const userId = await createUser('split-user');
    const gone = await prisma.wheelKey.findFirst({ where: { poolId, value: 'GONE-1' } });
    await prisma.wheelKey.update({
      where: { id: gone!.id },
      data: { claimedByUserId: userId, claimedAt: new Date() },
    });

    const free = await service.listKeys({ poolId, claimed: false, reveal: true });
    const taken = await service.listKeys({ poolId, claimed: true, reveal: true });
    const pool = await service.getPool(poolId);

    assert.deepEqual(free.items.map((k) => k.value).sort(), ['FREE-1', 'FREE-2']);
    assert.deepEqual(taken.items.map((k) => k.value), ['GONE-1']);
    assert.equal(taken.items[0]?.claimedBy?.id, userId);
    assert.equal(pool.available, 2);
    assert.equal(pool.claimed, 1);
  });

  it('retires an unclaimed key, and refuses to retire one already handed out', async () => {
    const poolId = await newPool('retire');
    await service.loadKeys(poolId, ['TYPO-1', 'MINE-1']);
    const userId = await createUser('retire-user');
    const typo = await prisma.wheelKey.findFirst({ where: { poolId, value: 'TYPO-1' } });
    const mine = await prisma.wheelKey.findFirst({ where: { poolId, value: 'MINE-1' } });
    await prisma.wheelKey.update({
      where: { id: mine!.id },
      data: { claimedByUserId: userId, claimedAt: new Date() },
    });

    await service.deleteKey(poolId, typo!.id);
    assert.equal(await prisma.wheelKey.count({ where: { id: typo!.id } }), 0);

    // The claimed one is the record of what somebody was given, and they may
    // still be holding it.
    await assert.rejects(() => service.deleteKey(poolId, mine!.id), /выдан/i);
    assert.equal(await prisma.wheelKey.count({ where: { id: mine!.id } }), 1);
  });

  it('refuses to delete a pool somebody has won from', async () => {
    const poolId = await newPool('history');
    await service.loadKeys(poolId, ['WON-1']);
    const userId = await createUser('history-user');
    const key = await prisma.wheelKey.findFirst({ where: { poolId } });
    await prisma.wheelKey.update({
      where: { id: key!.id },
      data: { claimedByUserId: userId, claimedAt: new Date() },
    });

    // The keys cascade with the pool, so deleting it would erase who got what.
    await assert.rejects(() => service.deletePool(poolId), /выдавались/i);
    assert.equal(await prisma.wheelKeyPool.count({ where: { id: poolId } }), 1);
  });

  it('refuses to delete a pool an enabled sector still draws from', async () => {
    // The foreign key would null the reference and leave the sector on the
    // wheel with nothing behind it — drawn, then excluded as UNCONFIGURED.
    const poolId = await newPool('inuse');
    const sectorId = `${prefix}-inuse-sector`;
    await prisma.wheelSector.create({
      data: { id: sectorId, kind: WheelSectorKind.KEY, keyPoolId: poolId, weight: 1, enabled: true },
    });
    createdSectors.push(sectorId);

    await assert.rejects(() => service.deletePool(poolId), /включённым сектором/i);

    // Disabled, it is the operator's business again.
    await prisma.wheelSector.update({ where: { id: sectorId }, data: { enabled: false } });
    await service.deletePool(poolId);
    assert.equal(await prisma.wheelKeyPool.count({ where: { id: poolId } }), 0);
  });

  it('deletes an untouched pool and the keys still in it', async () => {
    const poolId = await newPool('fresh');
    await service.loadKeys(poolId, ['A', 'B', 'C']);

    await service.deletePool(poolId);

    assert.equal(await prisma.wheelKeyPool.count({ where: { id: poolId } }), 0);
    assert.equal(await prisma.wheelKey.count({ where: { poolId } }), 0);
  });

  it('shows which sectors a pool feeds, so deleting is never a surprise', async () => {
    const poolId = await newPool('sectors');
    const sectorId = `${prefix}-sectors-sector`;
    await prisma.wheelSector.create({
      data: {
        id: sectorId,
        kind: WheelSectorKind.KEY,
        keyPoolId: poolId,
        title: { ru: 'Ключ Steam' },
        weight: 1,
        enabled: false,
      },
    });
    createdSectors.push(sectorId);

    const pool = await service.getPool(poolId);

    assert.deepEqual(pool.sectors, [{ id: sectorId, title: { ru: 'Ключ Steam' }, enabled: false }]);
  });

  it('leaves a spin readable after its key is gone with the pool', async () => {
    // A pool with no claimed keys can be deleted, and the spins that named its
    // keys keep their history: the outcome is a snapshot, not a join.
    const poolId = await newPool('spin');
    await service.loadKeys(poolId, ['LOOSE-1']);
    const userId = await createUser('spin-user');
    const key = await prisma.wheelKey.findFirst({ where: { poolId } });
    const spin = await prisma.wheelSpin.create({
      data: {
        userId,
        sectorSnapshot: { kind: 'KEY', title: { ru: 'Ключ' } },
        kind: WheelSectorKind.KEY,
        status: WheelSpinStatus.SETTLED,
        paidWith: 'BALANCE',
        idempotencyKey: `${prefix}-spin-1`,
        outcome: { keyId: key!.id, poolId },
      },
      select: { id: true },
    });

    await service.deletePool(poolId);

    const after = await prisma.wheelSpin.findUnique({
      where: { id: spin.id },
      select: { kind: true, outcome: true },
    });
    assert.equal(after?.kind, WheelSectorKind.KEY);
    assert.equal((after?.outcome as { keyId: string }).keyId, key!.id);
  });
});
