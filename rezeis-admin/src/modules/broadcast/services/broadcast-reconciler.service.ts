import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BroadcastMessageStatus, BroadcastStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { BroadcastQueueService } from './broadcast-queue.service';
import { BroadcastDeliveryService } from './broadcast-delivery.service';

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
  private static readonly STALE_PROCESSING_MINUTES = 180;

  /** How late a schedule may be before its missing job is treated as lost. */
  private static readonly OVERDUE_SCHEDULE_MINUTES = 5;

  /** Times one broadcast is put back before it is reported instead. */
  private static readonly MAX_REVIVALS = 3;

  private readonly revivals = new Map<string, number>();

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly queueService: BroadcastQueueService,
    private readonly systemEvents: SystemEventsService,
    // Required, not `@Optional()`: without it the "waiting for its finaliser"
    // branch below would go back to being a silent `continue`, which is the
    // dead end this class exists to remove.
    private readonly deliveryService: BroadcastDeliveryService,
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

  /**
   * A broadcast that has been mid-flight far too long with work still owed.
   *
   * "Far too long" has to outlast a legitimately slow send, not just a stalled
   * one: a large audience against an unwell relay spends ten seconds per
   * recipient, so a batch alone can run for minutes. Reviving one of those adds
   * a second full set of batch jobs on top of the ones still working — and with
   * the email leg deduplicated but the feed leg only read-then-written, that is
   * how a rescue becomes a duplicate.
   */
  private async reviveStalledDeliveries(): Promise<void> {
    const cutoff = new Date(Date.now() - BroadcastReconcilerService.STALE_PROCESSING_MINUTES * 60_000);
    const stalled = await this.prismaService.broadcast.findMany({
      where: { status: BroadcastStatus.PROCESSING, startedAt: { lt: cutoff } },
      select: { id: true },
      take: 50,
    });

    for (const broadcast of stalled) {
      const [pending, total] = await Promise.all([
        this.prismaService.broadcastMessage.count({
          where: { broadcastId: broadcast.id, status: BroadcastMessageStatus.PENDING },
        }),
        this.prismaService.broadcastMessage.count({ where: { broadcastId: broadcast.id } }),
      ]);

      if (pending === 0) {
        // ── "NOTHING PENDING" HAD TWO MEANINGS AND ONE ANSWER ─────────────
        //
        // `continue` was right for only one of them, and the other was a dead
        // end nothing else could reach. Staging CLAIMS the broadcast
        // (DRAFT → PROCESSING) before it resolves the audience, so a container
        // that dies in that window — a deploy, an OOM kill; not a throw, so the
        // catch never runs — leaves PROCESSING with no recipient rows at all.
        // The start job's retry then takes the resume path, finds nothing
        // pending, and completes green. This loop skipped it as "waiting for
        // its finaliser". Nobody was ever messaged, the panel showed 0/0
        // in-flight for ever, and no alert was raised anywhere — while the
        // channel post, queued inside the same claim, had already announced it
        // publicly.
        await (total === 0
          ? this.reportStagingNeverRan(broadcast.id)
          : this.deliveryService.checkAndFinalize(broadcast.id));
        continue;
      }

      if (await this.queueService.hasPendingStart(broadcast.id)) continue;
      await this.revive(broadcast.id, `${pending} recipients still undispatched`);
    }
  }

  /**
   * A broadcast that owns no recipients at all cannot be resumed or finished.
   *
   * Not revived: the claim already happened, so staging will refuse to run
   * again, and re-opening it would risk a second channel post. FAILED is the
   * truthful terminal state — nobody was reached — and it is the one that puts
   * the row somewhere the operator can see and act on.
   */
  private async reportStagingNeverRan(broadcastId: string): Promise<void> {
    const { count } = await this.prismaService.broadcast.updateMany({
      where: { id: broadcastId, status: BroadcastStatus.PROCESSING },
      data: { status: BroadcastStatus.FAILED, completedAt: new Date() },
    });
    if (count === 0) return;
    this.logger.error(`Broadcast ${broadcastId} was claimed but never staged a single recipient`);
    this.systemEvents.error(
      EVENT_TYPES.BROADCAST_STARTED,
      'SYSTEM',
      `Broadcast ${broadcastId} reached NOBODY: it was claimed for sending but no recipients were ever staged. ` +
        'Compose it again — and check the operator channel, which may already carry the announcement.',
      { broadcastId },
    );
  }

  private async revive(broadcastId: string, why: string): Promise<void> {
    const attempts = (this.revivals.get(broadcastId) ?? 0) + 1;
    this.revivals.set(broadcastId, attempts);

    if (attempts > BroadcastReconcilerService.MAX_REVIVALS) {
      // Putting it back is not working. Say so once, plainly, and stop — an
      // endless revival loop is how a broken broadcast becomes background noise.
      // NOT `SYSTEM_BROADCAST_SENT`: that type renders as 📢 «Рассылка
      // отправлена», so a rescue notice arrived titled as a successful send and
      // fired the broadcast-sent webhook to every automation subscriber. Exactly
      // the mislabelling the finaliser was fixed for one commit earlier.
      this.systemEvents.error(
        EVENT_TYPES.BROADCAST_STARTED,
        'SYSTEM',
        `Broadcast ${broadcastId} could not be resumed after ${BroadcastReconcilerService.MAX_REVIVALS} attempts (${why})`,
        { broadcastId, attempts, why },
      );
      return;
    }

    this.logger.warn(`Reviving broadcast ${broadcastId}: ${why}`);
    await this.queueService.enqueueStart({ broadcastId, adminId: null });
    this.systemEvents.warn(
      EVENT_TYPES.BROADCAST_STARTED,
      'SYSTEM',
      `Broadcast ${broadcastId} was picked up again: ${why}`,
      { broadcastId, attempts, why },
    );
  }
}
