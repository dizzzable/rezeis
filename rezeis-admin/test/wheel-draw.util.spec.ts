import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WheelSectorKind } from '@prisma/client';

import {
  drawSector,
  isWheelSpinnable,
  resolveDrawPool,
  sectorChancePercent,
  type SectorForDraw,
} from '../src/modules/wheel/wheel-draw.util';

function sector(overrides: Partial<SectorForDraw> & { id: string }): SectorForDraw {
  return {
    kind: WheelSectorKind.POINTS,
    enabled: true,
    weight: 10,
    maxWinsPerUser: null,
    maxWinsTotal: null,
    wonCount: 0,
    ...overrides,
  };
}

const NOTHING = sector({ id: 'nothing', kind: WheelSectorKind.NOTHING, weight: 70 });

function pool(sectors: readonly SectorForDraw[], wins: Record<string, number> = {}) {
  return resolveDrawPool({ sectors, userWins: new Map(Object.entries(wins)) });
}

/** A random source that hands back exactly the rolls it was given. */
function rolls(...values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

describe('who is in the draw', () => {
  it('excludes a sector the operator turned off', () => {
    const result = pool([NOTHING, sector({ id: 'off', enabled: false })]);

    assert.deepEqual(
      result.candidates.map((candidate) => candidate.id),
      ['nothing'],
    );
    assert.equal(result.excluded.get('off'), 'DISABLED');
  });

  it('excludes a sector of weight zero — on the wheel, never drawn', () => {
    const result = pool([NOTHING, sector({ id: 'never', weight: 0 })]);

    assert.equal(result.excluded.get('never'), 'ZERO_WEIGHT');
  });

  it('excludes what this person has already won as often as they may', () => {
    const sectors = [NOTHING, sector({ id: 'key', maxWinsPerUser: 1 })];

    assert.equal(pool(sectors, {}).candidates.length, 2, 'available before they win it');
    assert.equal(pool(sectors, { key: 1 }).excluded.get('key'), 'USER_CAP');
  });

  it('excludes what nobody can win any more', () => {
    const result = pool([NOTHING, sector({ id: 'jackpot', maxWinsTotal: 3, wonCount: 3 })]);

    assert.equal(result.excluded.get('jackpot'), 'EXHAUSTED');
  });

  it('excludes a key sector whose pool has run dry', () => {
    const result = pool([
      NOTHING,
      sector({ id: 'steam', kind: WheelSectorKind.KEY, keyPoolId: 'pool-1', keysAvailable: 0 }),
    ]);

    assert.equal(result.excluded.get('steam'), 'OUT_OF_STOCK');
  });

  it('excludes a key sector with no pool behind it at all', () => {
    // It would come up, fail to hand anything over, and the spin would still
    // be spent. Better never drawn.
    const result = pool([
      NOTHING,
      sector({ id: 'steam', kind: WheelSectorKind.KEY, keyPoolId: null, keysAvailable: 5 }),
    ]);

    assert.equal(result.excluded.get('steam'), 'UNCONFIGURED');
  });

  it('never caps the loss sector, whatever the operator sets on it', () => {
    // NOTHING is what keeps the pool non-empty for everybody, always. A
    // capped-out loss sector would leave somebody with a wheel that has
    // nothing left to give them at all.
    const capped = sector({
      id: 'nothing',
      kind: WheelSectorKind.NOTHING,
      weight: 70,
      maxWinsPerUser: 1,
      maxWinsTotal: 1,
      wonCount: 99,
    });

    const result = pool([capped], { nothing: 50 });

    assert.deepEqual(
      result.candidates.map((candidate) => candidate.id),
      ['nothing'],
    );
  });

  it('renormalises rather than falling back to a loss', () => {
    // A capped sector removed from the pool leaves the REST sharing 100 %.
    // Drawing it and paying "не повезло" instead would quietly pay the loss
    // sector more often than the operator configured, and the operator has no
    // way to see that: the sector actually paid is the one the numbers have
    // to describe.
    const sectors = [NOTHING, sector({ id: 'prize', weight: 30, maxWinsPerUser: 1 })];

    const open = pool(sectors, {});
    assert.equal(open.totalWeight, 100);
    assert.equal(sectorChancePercent(70, open.totalWeight), 70);

    const capped = pool(sectors, { prize: 1 });
    assert.equal(capped.totalWeight, 70);
    assert.equal(sectorChancePercent(70, capped.totalWeight), 100);
  });
});

describe('the draw itself', () => {
  const three = pool([
    sector({ id: 'a', weight: 70 }),
    sector({ id: 'b', weight: 5 }),
    sector({ id: 'c', weight: 25 }),
  ]);

  it('lands where the roll falls', () => {
    assert.equal(drawSector(three, rolls(0)), 'a');
    assert.equal(drawSector(three, rolls(0.69)), 'a');
    assert.equal(drawSector(three, rolls(0.7)), 'b', 'the first tick past 70 is the next sector');
    assert.equal(drawSector(three, rolls(0.74)), 'b');
    assert.equal(drawSector(three, rolls(0.75)), 'c');
    assert.equal(drawSector(three, rolls(0.999)), 'c');
  });

  it('has no memory: the same roll gives the same answer, every time', () => {
    // The operator sets a weight and that weight is what EVERY spin is judged
    // against. No pity timer, no "owed" prize, no sector consumed by landing
    // on it — those would all make the configured percentage a lie.
    const source = rolls(0.5, 0.5, 0.5, 0.5, 0.5);
    const drawn = [0, 0, 0, 0, 0].map(() => drawSector(three, source));

    assert.deepEqual(drawn, ['a', 'a', 'a', 'a', 'a']);
  });

  it('gives a losing streak no help at all', () => {
    // Four losses in a row do not raise the fifth roll's chances by a hair.
    const loseThenWin = rolls(0.1, 0.1, 0.1, 0.1, 0.72);

    assert.deepEqual(
      [0, 0, 0, 0, 0].map(() => drawSector(three, loseThenWin)),
      ['a', 'a', 'a', 'a', 'b'],
    );
  });

  it('survives a source that hands back 1, instead of calling it a broken wheel', () => {
    assert.equal(drawSector(three, rolls(1)), 'c');
    assert.equal(drawSector(three, rolls(1.5)), 'c');
    assert.equal(drawSector(three, rolls(Number.NaN)), 'a');
    assert.equal(drawSector(three, rolls(-3)), 'a');
  });

  it('answers null when there is nothing to draw from', () => {
    const empty = pool([sector({ id: 'off', enabled: false })]);

    assert.equal(drawSector(empty, rolls(0.5)), null);
    assert.equal(isWheelSpinnable(empty), false);
  });

  it('holds its shape over many draws', () => {
    // Not a test of randomness — a test that the intervals are contiguous and
    // that every roll in [0,1) lands on exactly one sector.
    const counts = new Map<string, number>();
    for (let step = 0; step < 10000; step += 1) {
      const id = drawSector(three, rolls(step / 10000));
      counts.set(id ?? 'null', (counts.get(id ?? 'null') ?? 0) + 1);
    }

    assert.equal(counts.get('null'), undefined, 'no roll fell through the intervals');
    assert.equal(counts.get('a'), 7000);
    assert.equal(counts.get('b'), 500);
    assert.equal(counts.get('c'), 2500);
  });
});

describe('the percentage the panel shows', () => {
  it('is derived, so the column adds up to a hundred by construction', () => {
    const result = pool([
      sector({ id: 'a', weight: 1 }),
      sector({ id: 'b', weight: 1 }),
      sector({ id: 'c', weight: 1 }),
    ]);

    const total = result.candidates.reduce(
      (sum, candidate) => sum + sectorChancePercent(candidate.weight, result.totalWeight),
      0,
    );
    assert.equal(Math.round(total), 100);
    // Thirds do not divide evenly, and that is fine: what must never happen is
    // an operator entering numbers that do not add up, which weights make
    // impossible.
    assert.ok(Math.abs(sectorChancePercent(1, 3) - 33.333333) < 0.001);
  });

  it('is zero when there is nothing to divide by', () => {
    assert.equal(sectorChancePercent(10, 0), 0);
    assert.equal(sectorChancePercent(0, 100), 0);
  });
});
