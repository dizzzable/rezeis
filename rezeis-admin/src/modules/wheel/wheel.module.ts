import { Module } from '@nestjs/common';

import { SpinWalletService } from './services/spin-wallet.service';

/**
 * The wheel of fortune, starting with its wallet.
 *
 * Nothing is imported here, for the same reason `PointsModule` imports
 * nothing: this module is going to be pulled in by the user card, by the
 * cabinet-facing controllers and by events, and a module that only moves a
 * balance must not drag a stack along with it. When the wheel needs to tell
 * somebody what they won, that message is composed where the notification
 * stack already lives, not here.
 */
@Module({
  providers: [SpinWalletService],
  exports: [SpinWalletService],
})
export class WheelModule {}
