import { Module } from '@nestjs/common';

import { RewardsModule } from '../rewards/rewards.module';
import { PrizePayoutService } from './services/prize-payout.service';
import { SpinWalletService } from './services/spin-wallet.service';
import { WheelSpinService } from './services/wheel-spin.service';

/**
 * The wheel of fortune: its wallet, and the spin that spends it.
 *
 * `RewardsModule` is the ONLY import, and it is itself a leaf — the wheel
 * hands out what a quest hands out, through the same applier, and gets the
 * points wallet along with it. Nothing else comes in on purpose: this module
 * is pulled in by the user card, by the cabinet-facing controllers and by
 * events, and a module that drags the notification stack behind it arrives
 * everywhere the wheel is merely READ. When the wheel needs to tell somebody
 * what they won, or to raise a ticket for a prize an operator settles by
 * hand, that message is composed where those stacks already live.
 */
@Module({
  imports: [RewardsModule],
  providers: [SpinWalletService, PrizePayoutService, WheelSpinService],
  exports: [SpinWalletService, PrizePayoutService, WheelSpinService],
})
export class WheelModule {}
