import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { ContestService } from './contest.service';
import { ContestNoticeService } from './contest-notice.service';
import { ContestTrafficService } from './contest-traffic.service';
import { ContestWinnerService } from './contest-winner.service';

/**
 * Runs the draw for every contest that has ended — or, for a leaderboard,
 * hands out its places — opens a conversation for every contest prize a
 * human has to hand over, and tells people: that a contest has opened, and
 * how they did. Traffic leaderboards are read from Remnawave first, so an
 * ended one finds its last reading in place.
 *
 * Every minute, because "the draw is at the end" is a promise people set an
 * alarm for. The draw itself is one transaction stamped on ACTIVE, so a sweep
 * that overlaps the operator pressing the button — or another sweep — cannot
 * hand out a second set of prizes; the loser is told ALREADY_DRAWN and moves
 * on.
 *
 * A draw that fails rolls back whole and is tried again next minute. Its
 * reason goes on the contest, where the panel shows it, and the operator gets
 * one event when it first fails — not one a minute.
 */
@Injectable()
export class ContestReconcilerService {
  private readonly logger = new Logger(ContestReconcilerService.name);

  public constructor(
    private readonly contests: ContestService,
    private readonly winners: ContestWinnerService,
    private readonly notices: ContestNoticeService,
    private readonly events: SystemEventsService,
    private readonly traffic: ContestTrafficService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'contest-draws' })
  public async reconcile(): Promise<void> {
    if (!shouldRunSchedules()) return;
    // Apart from the draws: a panel that cannot be read holds up only the
    // traffic leaderboards, which wait for it on their own.
    try {
      await this.traffic.readDue();
    } catch (error: unknown) {
      this.logger.warn(`Contest traffic read failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      for (const contestId of await this.contests.listDue()) {
        try {
          const result = await this.contests.draw({ contestId });
          if (result.drawn) {
            this.logger.log(`Contest ${contestId} drawn by the sweep: ${result.winners} of ${result.entrants}`);
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Contest ${contestId} draw failed: ${message}`);
          const news = await this.contests.recordDrawFailure(contestId, error).catch(() => false);
          if (news) {
            this.events.warn(EVENT_TYPES.SYSTEM_ERROR, 'SYSTEM', `Итоги конкурса не подведены: ${message}`, {
              contestId,
              why:
                'Победители не выбраны и призы не выданы: подведение итогов откатывается целиком и ' +
                'повторяется каждую минуту, а участники ждут итогов.',
              nextSteps:
                'Откройте «Конкурсы»: причина написана у этого конкурса. Чаще всего это приз, который нельзя ' +
                'выдать, — например, удалён тариф промокода, — а у рейтинга по трафику ещё недоступная ' +
                'Remnawave. Исправить конкурс после публикации нельзя; если причина не уходит сама, отмените ' +
                'его и создайте заново.',
            });
          }
        }
      }
      const opened = await this.winners.openMissingTickets();
      if (opened > 0) {
        this.logger.log(`Opened ${opened} conversation(s) for contest prizes waiting on an operator`);
      }
    } catch (error: unknown) {
      this.logger.warn(`Contest reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Apart from the draws: a failure telling people must not hold up a draw,
    // and the other way round.
    try {
      const sent = await this.notices.sendDue();
      if (sent.announced + sent.results + sent.reminded > 0) {
        this.logger.log(
          `Contest notices: ${sent.announced} announcement(s), ${sent.results} result(s), ${sent.reminded} reminder(s)`,
        );
      }
    } catch (error: unknown) {
      this.logger.warn(`Contest notices failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
