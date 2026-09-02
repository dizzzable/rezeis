import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { ContestService } from './contest.service';
import { ContestWinnerService } from './contest-winner.service';

/**
 * Runs the draw for every contest that has ended, and opens a conversation
 * for every contest prize a human has to hand over.
 *
 * Every minute, because "the draw is at the end" is a promise people set an
 * alarm for. The draw itself is one transaction stamped on ACTIVE, so a sweep
 * that overlaps the operator pressing the button — or another sweep — cannot
 * hand out a second set of prizes; the loser is told ALREADY_DRAWN and moves
 * on.
 */
@Injectable()
export class ContestReconcilerService {
  private readonly logger = new Logger(ContestReconcilerService.name);

  public constructor(
    private readonly contests: ContestService,
    private readonly winners: ContestWinnerService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'contest-draws' })
  public async reconcile(): Promise<void> {
    if (!shouldRunSchedules()) return;
    try {
      for (const contestId of await this.contests.listDue()) {
        try {
          const result = await this.contests.draw({ contestId });
          if (result.drawn) {
            this.logger.log(`Contest ${contestId} drawn by the sweep: ${result.winners} of ${result.entrants}`);
          }
        } catch (error: unknown) {
          this.logger.warn(
            `Contest ${contestId} draw failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const opened = await this.winners.openMissingTickets();
      if (opened > 0) {
        this.logger.log(`Opened ${opened} conversation(s) for contest prizes waiting on an operator`);
      }
    } catch (error: unknown) {
      this.logger.warn(`Contest reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
