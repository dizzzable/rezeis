import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { WheelManualPrizeService } from './wheel-manual-prize.service';

/**
 * Makes sure every owed prize has a conversation to settle it in.
 *
 * The spin transaction deliberately does not open the ticket: a ticket created
 * inside it would be rolled back by any later failure, and one created just
 * after it would be lost to a crash in between. So the spin records the debt
 * and this sweep pays the debt forward — it cannot lose a win, whatever
 * crashed, and it re-drives anything the cabinet's own attempt failed to open.
 *
 * Every minute, because somebody is waiting on the other side of it.
 */
@Injectable()
export class WheelPrizeReconcilerService {
  private readonly logger = new Logger(WheelPrizeReconcilerService.name);

  public constructor(private readonly manualPrizes: WheelManualPrizeService) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'wheel-manual-prize-tickets' })
  public async reconcile(): Promise<void> {
    if (!shouldRunSchedules()) return;
    try {
      const opened = await this.manualPrizes.openMissingTickets();
      if (opened > 0) {
        this.logger.log(`Opened ${opened} conversation(s) for prizes waiting on an operator`);
      }
    } catch (error: unknown) {
      this.logger.warn(
        `Wheel prize reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
