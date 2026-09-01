import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BroadcastMessageStatus, BroadcastStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { BroadcastQueueService } from './broadcast-queue.service';

/**
 * The counterpart to `checkAndFinalize`: what to do about a broadcast that will
 * never finalize on its own.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Two states had no way out, and both were reached in one incident:
 *
 *  - **Stuck in PROCESSING.** A start job that dies partway through its fan-out
 *    leaves recipients PENDING; `checkAndFinalize` returns early while any
 *    remain, so the broadcast never completes, its counters are never written,
 *    and the panel shows `0/400` for ever. The fan-out resumes on a retry now —
 *    but only if a retry comes. When the job is gone entirely, nothing does.
 *  - **A schedule whose job vanished.** `scheduled_at` is the intent; the job is
 *    the mechanism. If the mechanism is lost — a queue wiped, a job removed by
 *    hand — the intent used to be lost with it, silently, because the intent was
 *    never written down. It is now, so it can be noticed.
 *
 * ── Why it re-enqueues rather than failing the row ────────────────────────
 *
 * Both cases are "the work was never done", not "the work was refused". The
 * recipients are still PENDING and still deliverable, and delivery skips anyone
 * already SENT — so the safe move is to put the job back. A broadcast that keeps
 * coming back here is reported, not retried for ever.
 */
@Injectable()
export class BroadcastReconcilerService {
  private readonly logger = new Logger(BroadcastReconcilerService.name);

  /** How long a broadcast may sit in PROCESSING before it is treated as stuck. */
  private static readonly STALE_PROCESSING_MINUTES = 30;

  /** How late a schedule may be before its missing job is treated as lost. */
  private static readonly OVERDUE_SCHEDULE_MINUTES = 5;

  /** Times one broadcast is put back before it is reported instead. */
  private static readonly MAX_REVIVALS = 3;

  private readonly revivals = new Map<string, number>();

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly queueService: BroadcastQueueService,
    private readonly systemEvents: SystemEventsService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  public async reconcile(): Promise<void> {
    if (!shouldRunSchedules()) return;
    await this.reviveOverdueSchedules();
    await this.reviveStalledDeliveries();
  }

  /** A schedule whose time has passed and whose job is not in the queue. */
  private async reviveOverdueSchedules(): Promise<void> {
    const due = new Date(Date.now() - BroadcastReconcilerService.OVERDUE_SCHEDULE_MINUTES * 60_000);
    const overdue = await this.prismaService.broadcast.findMany({
      where: { status: BroadcastStatus.SCHEDULED, scheduledAt: { lt: due } },
      select: { id: true, scheduledAt: true },
      take: 50,
    });

    for (const broadcast of overdue) {
      // The job may simply be late — a worker that was down comes back and
      // BullMQ promotes it. Only a schedule with NO job behind it is lost.
      if (await this.queueService.hasPendingStart(broadcast.id)) continue;
      await this.revive(broadcast.id, `schedule was due ${broadcast.scheduledAt?.toISOString()}`);
    }
  }

  /** A broadcast that has been mid-flight far too long with work still owed. */
  private async reviveStalledDeliveries(): Promise<void> {
    const cutoff = new Date(Date.now() - BroadcastReconcilerService.STALE_PROCESSING_MINUTES * 60_000);
    const stalled = await this.prismaService.broadcast.findMany({
      where: { status: BroadcastStatus.PROCESSING, startedAt: { lt: cutoff } },
      select: { id: true },
      take: 50,
    });

    for (const broadcast of stalled) {
      const pending = await this.prismaService.broadcastMessage.count({
        where: { broadcastId: broadcast.id, status: BroadcastMessageStatus.PENDING },
      });
      // No pending rows means it is merely waiting for its finaliser; ask for
      // that rather than re-enqueueing a send with nothing left to send.
      if (pending === 0) continue;
      if (await this.queueService.hasPendingStart(broadcast.id)) continue;
      await this.revive(broadcast.id, `${pending} recipients still undispatched`);
    }
  }

  private async revive(broadcastId: string, why: string): Promise<void> {
    const attempts = (this.revivals.get(broadcastId) ?? 0) + 1;
    this.revivals.set(broadcastId, attempts);

    if (attempts > BroadcastReconcilerService.MAX_REVIVALS) {
      // Putting it back is not working. Say so once, plainly, and stop — an
      // endless revival loop is how a broken broadcast becomes background noise.
      this.systemEvents.error(
        EVENT_TYPES.SYSTEM_BROADCAST_SENT,
        'SYSTEM',
        `Broadcast ${broadcastId} could not be resumed after ${BroadcastReconcilerService.MAX_REVIVALS} attempts (${why})`,
        { broadcastId, attempts, why },
      );
      return;
    }

    this.logger.warn(`Reviving broadcast ${broadcastId}: ${why}`);
    await this.queueService.enqueueStart({ broadcastId, adminId: null });
    this.systemEvents.warn(
      EVENT_TYPES.SYSTEM_BROADCAST_SENT,
      'SYSTEM',
      `Broadcast ${broadcastId} was picked up again: ${why}`,
      { broadcastId, attempts, why },
    );
  }
}
