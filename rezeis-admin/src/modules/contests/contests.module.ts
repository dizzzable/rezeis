import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { SupportTicketsModule } from '../support-tickets/support-tickets.module';
import { WheelModule } from '../wheel/wheel.module';
import { AdminContestsController } from './controllers/admin-contests.controller';
import { InternalContestsController } from './controllers/internal-contests.controller';
import { ContestReconcilerService } from './services/contest-reconciler.service';
import { ContestService } from './services/contest.service';
import { ContestWinnerService } from './services/contest-winner.service';

/**
 * Contests — an event with a draw at the end.
 *
 * The temporary sibling of the wheel, and built out of the wheel's parts on
 * purpose: `WheelModule` for the payout (the same nine prize kinds, the same
 * journals), `SupportTicketsModule` for the conversation a manual prize is
 * settled in. What is the contest's own — entering, the draw, the places —
 * lives here.
 */
@Module({
  imports: [AuthModule, WheelModule, SupportTicketsModule],
  controllers: [AdminContestsController, InternalContestsController],
  providers: [ContestService, ContestWinnerService, ContestReconcilerService],
  exports: [ContestService, ContestWinnerService],
})
export class ContestsModule {}
