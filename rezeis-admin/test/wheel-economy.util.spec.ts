import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PromocodeRewardType, WheelSectorKind } from '@prisma/client';

import { MAX_DISCOUNT_PERCENT } from '../src/common/utils/discount.util';
import {
  GENEROUS_THRESHOLD,
  readWheelBlockers,
  readWheelEconomy,
  type EconomySector,
} from '../src/modules/wheel-config/wheel-economy.util';
import {
  validateSector,
  type SectorDraft,
} from '../src/modules/wheel-config/wheel-sector-validation.util';

function sector(overrides: Partial<EconomySector> = {}): EconomySector {
  return { kind: WheelSectorKind.POINTS, enabled: true, weight: 10, amount: 1, ...overrides };
}

const LOSS = sector({ kind: WheelSectorKind.NOTHING, weight: 70, amount: 0 });

describe('the pool the draw can actually reach', () => {
  /**
   * A ceiling does not shrink the wheel evenly. It removes ONE sector from
   * somebody's pool, and the draw renormalises over what is left — so every
   * surviving sector's share goes UP. Judging the economy on the wheel as
   * configured is therefore the KINDEST reading available, and the guard has
   * to take the harshest.
   */
  it('sees the wheel a dry key pool leaves behind', () => {
    const sectors = [
      sector({ kind: WheelSectorKind.NOTHING, weight: 20, amount: 0 }),
      sector({ kind: WheelSectorKind.KEY, weight: 60, amount: 0, keyPoolId: 'pool-1' }),
      sector({ kind: WheelSectorKind.SPINS, weight: 20, amount: 3 }),
    ];

    // As configured this looks safe: p(SPINS) = 0.2, R = 0.6. Once the keys
    // are gone the pool is 20 + 20 and p(SPINS) = 0.5, so R = 1.5 — and the
    // keys WILL run out, because that is what a pool of keys does.
    const economy = readWheelEconomy(sectors);

    assert.equal(economy.spinsReturnedPerSpin, 1.5);
    assert.equal(economy.perpetual, true);
    assert.deepEqual([...readWheelBlockers(sectors)], ['PERPETUAL']);
  });

  it('sees the wheel a per-person ceiling leaves behind', () => {
    // Somebody who has already taken their one jackpot faces the smaller
    // wheel from then on, forever.
    const sectors = [
      sector({ kind: WheelSectorKind.NOTHING, weight: 30, amount: 0 }),
      sector({ weight: 50, maxWinsPerUser: 1 }),
      sector({ kind: WheelSectorKind.SPINS, weight: 20, amount: 3 }),
    ];

    assert.equal(readWheelEconomy(sectors).perpetual, true);
  });

  it('still counts a capped SPINS sector on both sides', () => {
    // A spins sector that can run out cannot make the economy worse by
    // leaving, so it stays in the denominator with everything else.
    const sectors = [
      sector({ kind: WheelSectorKind.NOTHING, weight: 90, amount: 0 }),
      sector({ kind: WheelSectorKind.SPINS, weight: 10, amount: 5, maxWinsTotal: 100 }),
    ];

    const economy = readWheelEconomy(sectors);

    assert.equal(economy.spinsReturnedPerSpin, 0.5, 'the loss sector is still the denominator');
    assert.equal(economy.perpetual, false);
  });

  it('leaves a wheel with nothing removable exactly as it was', () => {
    // The common case must not move: no ceilings, no keys, no change.
    const sectors = [
      sector({ kind: WheelSectorKind.NOTHING, weight: 90, amount: 0 }),
      sector({ kind: WheelSectorKind.SPINS, weight: 10, amount: 5 }),
    ];

    assert.equal(readWheelEconomy(sectors).spinsReturnedPerSpin, 0.5);
  });
});

describe('the wheel that never stops', () => {
  it('is not ruled out by weights that add up to a hundred', () => {
    // THE CASE THAT MOTIVATED THIS FILE. 70 / 5 / 25 is a perfectly tidy
    // hundred per cent, and the wheel still pays back more than it costs:
    // 0.25 × 5 = 1.25 spins returned per spin.
    const economy = readWheelEconomy([
      LOSS,
      sector({ weight: 5 }),
      sector({ kind: WheelSectorKind.SPINS, weight: 25, amount: 5 }),
    ]);

    assert.equal(economy.totalWeight, 100, 'the percentages are beyond reproach');
    assert.equal(Number(economy.spinsReturnedPerSpin.toFixed(2)), 1.25);
    assert.equal(economy.perpetual, true);
    assert.equal(economy.expectedTotalSpins, null, 'the spins never run out');
  });

  it('says how many spins one spin really is, while it still ends', () => {
    // 10 % of "+5" is exactly half a spin back, so one bought spin is two.
    const economy = readWheelEconomy([
      sector({ kind: WheelSectorKind.NOTHING, weight: 90, amount: 0 }),
      sector({ kind: WheelSectorKind.SPINS, weight: 10, amount: 5 }),
    ]);

    assert.equal(economy.spinsReturnedPerSpin, 0.5);
    assert.equal(economy.expectedTotalSpins, 2);
    assert.equal(economy.perpetual, false);
  });

  it('treats exactly one as already too much', () => {
    // At R = 1 the chain still dies with probability one, but the expected
    // wait is unbounded. Not a thing to ship.
    const economy = readWheelEconomy([
      sector({ kind: WheelSectorKind.NOTHING, weight: 50, amount: 0 }),
      sector({ kind: WheelSectorKind.SPINS, weight: 50, amount: 2 }),
    ]);

    assert.equal(economy.spinsReturnedPerSpin, 1);
    assert.equal(economy.perpetual, true);
  });

  it('warns about a generous wheel without refusing it', () => {
    const economy = readWheelEconomy([
      sector({ kind: WheelSectorKind.NOTHING, weight: 82, amount: 0 }),
      sector({ kind: WheelSectorKind.SPINS, weight: 18, amount: 5 }),
    ]);

    assert.ok(economy.spinsReturnedPerSpin >= GENEROUS_THRESHOLD);
    assert.equal(economy.perpetual, false);
    assert.equal(economy.generous, true);
    assert.ok((economy.expectedTotalSpins ?? 0) > 5, 'one bought spin is really several');
  });

  it('counts only sectors somebody can actually land on', () => {
    // A disabled sector and a zero-weight one are not on anybody's wheel, so
    // neither can pay a spin back.
    const economy = readWheelEconomy([
      LOSS,
      sector({ kind: WheelSectorKind.SPINS, weight: 30, amount: 9, enabled: false }),
      sector({ kind: WheelSectorKind.SPINS, weight: 0, amount: 9 }),
    ]);

    assert.equal(economy.spinsReturnedPerSpin, 0);
    assert.equal(economy.totalWeight, 70);
  });

  it('only spins pay spins back', () => {
    // A hundred points is not a spin, however large the number.
    const economy = readWheelEconomy([
      sector({ kind: WheelSectorKind.POINTS, weight: 50, amount: 10_000 }),
      sector({ kind: WheelSectorKind.DAYS, weight: 50, amount: 365 }),
    ]);

    assert.equal(economy.spinsReturnedPerSpin, 0);
  });

  it('answers for an empty wheel without dividing by zero', () => {
    const economy = readWheelEconomy([]);

    assert.equal(economy.totalWeight, 0);
    assert.equal(economy.spinsReturnedPerSpin, 0);
    assert.equal(economy.expectedTotalSpins, 1);
    assert.equal(economy.perpetual, false);
  });
});

describe('what stops a wheel being switched on', () => {
  it('lets a sound wheel through', () => {
    assert.deepEqual(readWheelBlockers([LOSS, sector({ weight: 30 })]), []);
  });

  it('needs something on the wheel at all', () => {
    assert.deepEqual([...readWheelBlockers([sector({ enabled: false })])].sort(), [
      'NO_LOSS_SECTOR',
      'NO_SECTORS',
    ]);
  });

  it('needs a loss sector, because it is the one nothing can exhaust', () => {
    // Somebody who has taken their one permanent discount and their one key
    // would otherwise reach a wheel with nothing left to give them.
    assert.deepEqual(readWheelBlockers([sector({ weight: 30 })]), ['NO_LOSS_SECTOR']);
  });

  it('refuses a wheel whose spins never run out', () => {
    assert.deepEqual(
      readWheelBlockers([LOSS, sector({ kind: WheelSectorKind.SPINS, weight: 30, amount: 5 })]),
      ['PERPETUAL'],
    );
  });

  it('reports every reason at once, not just the first', () => {
    // An operator fixing a wheel wants the whole bill.
    const blockers = readWheelBlockers([
      sector({ kind: WheelSectorKind.SPINS, weight: 10, amount: 3 }),
    ]);

    assert.deepEqual([...blockers].sort(), ['NO_LOSS_SECTOR', 'PERPETUAL']);
  });
});

function draft(overrides: Partial<SectorDraft> = {}): SectorDraft {
  return {
    kind: WheelSectorKind.POINTS,
    weight: 10,
    amount: 5,
    keyPoolId: null,
    promoRewardType: null,
    promoPlanId: null,
    promoLifetime: null,
    manualInstructions: null,
    maxWinsPerUser: null,
    maxWinsTotal: null,
    ...overrides,
  };
}

describe('a sector that cannot pay is refused when it is saved', () => {
  it('accepts an ordinary one', () => {
    assert.deepEqual(validateSector(draft()), []);
  });

  it('needs an amount for anything measured', () => {
    for (const kind of [
      WheelSectorKind.POINTS,
      WheelSectorKind.SPINS,
      WheelSectorKind.DAYS,
      WheelSectorKind.TRAFFIC,
    ]) {
      const problems = validateSector(draft({ kind, amount: 0 }));
      assert.equal(problems.length, 1, kind);
      assert.equal(problems[0]?.field, 'amount');
    }
  });

  it('holds a discount to the ceiling pricing actually applies', () => {
    // A stored 100 would be a number no checkout could ever spend.
    assert.deepEqual(validateSector(draft({ kind: WheelSectorKind.DISCOUNT, amount: 90 })), []);
    const tooMuch = validateSector(draft({ kind: WheelSectorKind.DISCOUNT, amount: 100 }));
    assert.equal(tooMuch[0]?.field, 'amount');
    assert.match(tooMuch[0]?.message ?? '', new RegExp(String(MAX_DISCOUNT_PERCENT)));
  });

  it('needs a pool behind a key sector', () => {
    // Without one the draw excludes it as UNCONFIGURED and the sector sits on
    // the wheel never coming up, with no explanation anywhere.
    const problems = validateSector(draft({ kind: WheelSectorKind.KEY, amount: 0 }));
    assert.deepEqual(problems.map((p) => p.field), ['keyPoolId']);
    assert.deepEqual(
      validateSector(draft({ kind: WheelSectorKind.KEY, amount: 0, keyPoolId: 'pool-1' })),
      [],
    );
  });

  it('needs a tariff for a subscription code', () => {
    const problems = validateSector(
      draft({
        kind: WheelSectorKind.PROMOCODE,
        promoRewardType: PromocodeRewardType.SUBSCRIPTION,
        amount: 30,
      }),
    );
    assert.deepEqual(problems.map((p) => p.field), ['promoPlanId']);
  });

  it('needs instructions on a manual prize', () => {
    // The operator reads this weeks later, in a queue, deciding what
    // "1000 ₽" was supposed to mean.
    const problems = validateSector(
      draft({ kind: WheelSectorKind.MANUAL, amount: 0, manualInstructions: '   ' }),
    );
    assert.deepEqual(problems.map((p) => p.field), ['manualInstructions']);
  });

  it('refuses a ceiling on the loss sector', () => {
    // NOTHING is exempt from every ceiling by design, so a ceiling set here
    // is one the draw would ignore — worse than one that cannot be set.
    const problems = validateSector(
      draft({ kind: WheelSectorKind.NOTHING, amount: 0, maxWinsPerUser: 1 }),
    );
    assert.deepEqual(problems.map((p) => p.field), ['maxWinsPerUser']);
    assert.deepEqual(validateSector(draft({ kind: WheelSectorKind.NOTHING, amount: 0 })), []);
  });

  it('refuses a negative weight', () => {
    assert.deepEqual(validateSector(draft({ weight: -1 })).map((p) => p.field), ['weight']);
    assert.deepEqual(validateSector(draft({ weight: 0 })), [], 'zero is allowed: on the wheel, never drawn');
  });

  it('refuses a ceiling below one', () => {
    assert.deepEqual(validateSector(draft({ maxWinsTotal: 0 })).map((p) => p.field), ['maxWinsTotal']);
  });
});
