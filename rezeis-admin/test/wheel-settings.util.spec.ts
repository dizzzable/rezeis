import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Test } from '@nestjs/testing';

import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { RewardGrantService } from '../src/modules/rewards/reward-grant.service';
import { PrizePayoutService } from '../src/modules/wheel/services/prize-payout.service';
import { SpinWalletService } from '../src/modules/wheel/services/spin-wallet.service';
import { WheelSpinService } from '../src/modules/wheel/services/wheel-spin.service';
import { WHEEL_OFF, readWheelSettings } from '../src/modules/wheel/wheel-settings.util';
import { WheelModule } from '../src/modules/wheel/wheel.module';

describe('the wheel is off until an operator says otherwise', () => {
  it('reads an absent block as off in every field', () => {
    // The column ships with `{}` on every existing install. An update that
    // started a giveaway behind the operator's back would be the worst kind of
    // surprise, so absent is off — the same rule the points block follows.
    for (const value of [undefined, null, {}, [], 'nonsense', 42]) {
      assert.deepEqual(readWheelSettings(value), WHEEL_OFF, JSON.stringify(value));
    }
  });

  it('reads what the operator set', () => {
    assert.deepEqual(
      readWheelSettings({ enabled: true, freeSpinCooldownHours: 24, spinPricePoints: 150 }),
      { enabled: true, freeSpinCooldownHours: 24, spinPricePoints: 150 },
    );
  });

  it('treats anything but a positive whole number as off', () => {
    // A cooldown of 0 read as "unlimited" would be an unlimited wheel one
    // keystroke away; a price of -5 has no meaning at all. Both are the same
    // statement — this value cannot be trusted — and neither earns its own
    // behaviour.
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '24', null]) {
      const read = readWheelSettings({
        enabled: true,
        freeSpinCooldownHours: bad,
        spinPricePoints: bad,
      });
      assert.equal(read.freeSpinCooldownHours, null, `cooldown ${String(bad)}`);
      assert.equal(read.spinPricePoints, null, `price ${String(bad)}`);
      assert.equal(read.enabled, true, 'and a bad sub-field does not switch the wheel off');
    }
  });

  it('needs `enabled` to be exactly true, not merely truthy', () => {
    for (const nearly of ['true', 1, {}, 'yes']) {
      assert.equal(readWheelSettings({ enabled: nearly }).enabled, false, String(nearly));
    }
  });
});

describe('the wheel module stays a leaf', () => {
  it('builds the spin service with the real wallets and one import', async () => {
    // `WheelModule` is pulled in wherever the wheel is merely READ — the user
    // card, the cabinet controllers, events. If it dragged the notification
    // stack behind it, that stack would be constructed in all of those places;
    // this test is what stops an import creeping in, because such an import
    // makes the module fail to compile without the whole Auth chain.
    const moduleRef = await Test.createTestingModule({ imports: [WheelModule] })
      .useMocker(() => ({}))
      .compile();

    const spin = moduleRef.get(WheelSpinService) as unknown as {
      spinWallet?: unknown;
      payout?: unknown;
    };
    assert.ok(spin.spinWallet instanceof SpinWalletService);
    assert.ok(spin.payout instanceof PrizePayoutService);
    const payout = spin.payout as unknown as { spinWallet?: unknown; rewardGrant?: unknown };
    assert.ok(payout.spinWallet instanceof SpinWalletService);
    assert.ok(payout.rewardGrant instanceof RewardGrantService);
    assert.ok(
      (payout.rewardGrant as unknown as { pointsWallet?: unknown }).pointsWallet instanceof
        PointsWalletService,
      'and the applier got the real points wallet, so the one-writer rule holds',
    );

    await moduleRef.close();
  });
});
