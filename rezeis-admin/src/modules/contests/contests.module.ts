import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ContestsService } from './services/contests.service';

/**
 * Contests / Giveaway module — manages time-limited promotional events
 * where users can win prizes (subscription days, traffic, gift codes).
 *
 * This is a new feature not present in the altshop donor. The module
 * provides the backend contract for the admin UI to create/manage contests
 * and for the public ruid edge to display active contests and record
 * participation.
 */
@Module({
  imports: [AuthModule],
  providers: [ContestsService],
  exports: [ContestsService],
})
export class ContestsModule {}
