import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ContestPrizeDelivery, PromocodeRewardType, Prisma, WheelSectorKind, WheelSpinStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { UserNotificationsService } from '../../notifications/services/user-notifications.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { SupportNotificationsService } from '../../support-tickets/services/support-notifications.service';
import { SupportTicketsService } from '../../support-tickets/services/support-tickets.service';
import { PrizePayoutService, type PrizePayout, type PrizeSpec } from '../../wheel/services/prize-payout.service';
import type { SettleResult } from '../../wheel-prizes/services/wheel-manual-prize.service';
import {
  contestPrizeGreeting,
  contestPrizeRefused,
  contestPrizeSettled,
  contestPrizeSubject,
  prizeTicketLocale,
  type PrizeTicketLocale,
} from '../../support-tickets/utils/prize-ticket-copy.util';

export interface ContestWinnerRow {
  readonly id: string;
  readonly contestId: string;
  readonly contestTitle: Prisma.JsonValue;
  readonly place: number;
  readonly kind: string;
  readonly prizeTitle: Prisma.JsonValue;
  readonly status: WheelSpinStatus;
  readonly createdAt: string;
  readonly settledAt: string | null;
  readonly settledBy: string | null;
  readonly settlementNote: string | null;
  readonly ticketId: string | null;
  /** What the operator has to do, as written on the prize. */
  readonly instructions: string;
  /**
   * A prize the system pays, held for the operator's «Выдать» — which PAYS
   * it, where on a manual prize it only records that a human did.
   */
  readonly heldForReview: boolean;
  /** The leaderboard score that won the place. `null` on a draw. */
  readonly score: number | null;
  readonly winner: {
    readonly id: string;
    readonly name: string;
    readonly username: string | null;
    readonly telegramId: string | null;
    readonly email: string | null;
  };
}

const WINNER_SELECT = {
  id: true,
  contestId: true,
  place: true,
  kind: true,
  status: true,
  outcome: true,
  prizeSnapshot: true,
  createdAt: true,
  settledAt: true,
  settledBy: true,
  settlementNote: true,
  manualTicketId: true,
  heldForReview: true,
  score: true,
  contest: { select: { title: true } },
  user: { select: { id: true, name: true, username: true, telegramId: true, email: true, language: true } },
} as const;

type WinnerRow = Prisma.ContestWinnerGetPayload<{ select: typeof WINNER_SELECT }>;

/**
 * The contest prizes a human has to hand over, and the record of who did.
 *
 * This is the wheel's `WheelManualPrizeService`, row for row, over a
 * different table — the same conversation opened for the winner, the same
 * conditional settle, the same refusal that must say why. It is a copy on
 * purpose and for now: the columns were named identically so that the day a
 * single `prize_settlements` table replaces both, the two services fold into
 * one without either table having to be renamed first. Until then, the one
 * operator queue is the panel page, which lists both.
 *
 * ── Held prizes ───────────────────────────────────────────────────────────
 *
 * A contest whose «Выдача призов» is «после проверки» or «через поддержку»
 * leaves every prize the system could pay PENDING and `heldForReview`. For
 * those, «Выдать» is the payout itself — points, days, a promo code, a key —
 * done here on the operator's word, in one transaction claimed on the hold,
 * so two operators pressing it at once pay it once. «Через поддержку» opens a
 * thread for each winner as a manual prize does; «после проверки» opens none,
 * and the winner hears of the payout as a notification instead.
 */
@Injectable()
export class ContestWinnerService {
  private readonly logger = new Logger(ContestWinnerService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly supportTickets: SupportTicketsService,
    private readonly supportNotifications: SupportNotificationsService,
    // `@Optional()` and last for the specs that build this positionally; a
    // held prize cannot be released without the first.
    @Optional() private readonly payout?: PrizePayoutService,
    @Optional() private readonly profileSyncQueue?: ProfileSyncQueueService,
    @Optional() private readonly userNotifications?: UserNotificationsService,
  ) {}

  public async listForContest(contestId: string): Promise<readonly ContestWinnerRow[]> {
    const rows = await this.prismaService.contestWinner.findMany({
      where: { contestId },
      orderBy: { place: 'asc' },
      select: WINNER_SELECT,
    });
    return rows.map((row) => toRow(row));
  }

  /** The queue: every contest prize still owed to somebody. */
  public async listPending(limit = 100): Promise<readonly ContestWinnerRow[]> {
    const rows = await this.prismaService.contestWinner.findMany({
      where: { status: WheelSpinStatus.PENDING },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: WINNER_SELECT,
    });
    return rows.map((row) => toRow(row));
  }

  public async findOne(winnerId: string): Promise<ContestWinnerRow> {
    const row = await this.prismaService.contestWinner.findUnique({
      where: { id: winnerId },
      select: WINNER_SELECT,
    });
    if (row === null) throw new NotFoundException('Contest winner not found');
    return toRow(row);
  }

  /** Open the conversation for one owed prize. Safe to call twice, or from two places at once. */
  public async openTicket(winnerId: string): Promise<string | null> {
    const winner = await this.prismaService.contestWinner.findUnique({
      where: { id: winnerId },
      select: {
        id: true,
        status: true,
        manualTicketId: true,
        prizeSnapshot: true,
        userId: true,
        // The thread below is written into the winner's OWN support inbox, so
        // it has to be in their language. The notification card announcing the
        // same prize has been localized since it shipped.
        user: { select: { language: true } },
        contest: { select: { title: true } },
      },
    });
    if (winner === null) return null;
    if (winner.status !== WheelSpinStatus.PENDING) return null;
    const locale = prizeTicketLocale(winner.user?.language ?? null);
    if (winner.manualTicketId !== null) return winner.manualTicketId;

    const contestTitle = readTitle(winner.contest.title);
    const prizeTitle = readTitle(readSnapshot(winner.prizeSnapshot)['title'] as Prisma.JsonValue);
    try {
      return await this.prismaService.$transaction(async (tx) => {
        const ticket = await tx.supportTicket.create({
          data: {
            userId: winner.userId,
            subject: contestPrizeSubject(contestTitle, prizeTitle, locale),
            status: 'OPEN',
          },
          select: { id: true },
        });
        const claimed = await tx.contestWinner.updateMany({
          where: { id: winner.id, manualTicketId: null },
          data: { manualTicketId: ticket.id },
        });
        if (claimed.count !== 1) throw new TicketRaceLost();
        await tx.supportTicketMessage.create({
          data: {
            ticketId: ticket.id,
            authorType: 'SYSTEM',
            authorId: null,
            content: contestPrizeGreeting(contestTitle, prizeTitle, locale),
            metadata: { type: 'contest_prize', winnerId: winner.id },
          },
        });
        return ticket.id;
      });
    } catch (error) {
      if (error instanceof TicketRaceLost) {
        const current = await this.prismaService.contestWinner.findUnique({
          where: { id: winner.id },
          select: { manualTicketId: true },
        });
        return current?.manualTicketId ?? null;
      }
      throw error;
    }
  }

  /**
   * Conversations for every prize a human hands over: a manual prize, a key
   * the pool ran out of, and a held prize of a contest that hands prizes over
   * «через поддержку». A prize held «после проверки» gets none — that check
   * is the operator's, not a conversation with the winner.
   */
  public async openMissingTickets(batch = 50): Promise<number> {
    const owed = await this.prismaService.contestWinner.findMany({
      where: {
        status: WheelSpinStatus.PENDING,
        manualTicketId: null,
        NOT: { heldForReview: true, contest: { prizeDelivery: ContestPrizeDelivery.REVIEW } },
      },
      orderBy: { createdAt: 'asc' },
      take: batch,
      select: { id: true },
    });
    let opened = 0;
    for (const winner of owed) {
      try {
        if ((await this.openTicket(winner.id)) !== null) opened += 1;
      } catch (error: unknown) {
        this.logger.warn(
          `Could not open the conversation for contest winner ${winner.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return opened;
  }

  public async issue(input: { readonly winnerId: string; readonly adminId: string; readonly note: string | null }): Promise<SettleResult> {
    const current = await this.prismaService.contestWinner.findUnique({
      where: { id: input.winnerId },
      select: { heldForReview: true, status: true },
    });
    if (current === null) throw new NotFoundException('Contest winner not found');
    if (current.heldForReview && current.status === WheelSpinStatus.PENDING) return this.release(input);
    return this.settle({
      ...input,
      status: WheelSpinStatus.SETTLED,
      message: (prize, locale) =>
        contestPrizeSettled(prize, locale) + (input.note ? `\n\n${input.note}` : ''),
    });
  }

  public refuse(input: { readonly winnerId: string; readonly adminId: string; readonly reason: string }): Promise<SettleResult> {
    return this.settle({
      winnerId: input.winnerId,
      adminId: input.adminId,
      note: input.reason,
      status: WheelSpinStatus.REFUSED,
      message: (prize, locale) => `${contestPrizeRefused(prize, locale)}\n\n${input.reason}`,
    });
  }

  /**
   * Pay a held prize. The hold is claimed first, conditionally, so the second
   * of two «Выдать» finds nothing to pay; the payout and the claim commit
   * together or not at all.
   *
   * A key whose pool has run dry since the end leaves the prize PENDING and
   * no longer held — a manual handover, with its conversation opened by the
   * next sweep, the same as a key that ran out at the end itself.
   */
  private async release(input: {
    readonly winnerId: string;
    readonly adminId: string;
    readonly note: string | null;
  }): Promise<SettleResult> {
    if (this.payout === undefined) throw new Error('Prize payout is not wired');
    const payout = this.payout;
    const paid = await this.prismaService.$transaction(async (tx): Promise<PrizePayout | null> => {
      const claimed = await tx.contestWinner.updateMany({
        where: { id: input.winnerId, status: WheelSpinStatus.PENDING, heldForReview: true },
        data: { heldForReview: false },
      });
      if (claimed.count !== 1) return null;
      const winner = await tx.contestWinner.findUniqueOrThrow({
        where: { id: input.winnerId },
        select: { userId: true, contestId: true, place: true, prizeSnapshot: true },
      });
      const result = await payout.payOut(tx, {
        userId: winner.userId,
        prize: readPrizeSpec(winner.prizeSnapshot),
        origin: {
          source: 'CONTEST',
          referenceKey: `contest:${input.winnerId}`,
          details: { contestId: winner.contestId, winnerId: input.winnerId, place: winner.place },
        },
      });
      await tx.contestWinner.update({
        where: { id: input.winnerId },
        data: {
          status: result.status,
          ...(result.outcome === null ? {} : { outcome: result.outcome }),
          ...(result.status === WheelSpinStatus.PENDING
            ? {}
            : { settledAt: new Date(), settledBy: input.adminId, settlementNote: input.note }),
        },
      });
      if (result.keyId !== null) {
        await tx.wheelKey.update({ where: { id: result.keyId }, data: { claimedWinnerId: input.winnerId } });
      }
      return result;
    });
    if (paid === null) return { settled: false, reason: 'NOT_PENDING' };

    if (paid.syncSubscriptionId !== null) {
      await this.profileSyncQueue
        ?.enqueueSubscriptionSync(paid.syncSubscriptionId, { source: 'CONTEST_PRIZE', winnerId: input.winnerId })
        .catch((error: unknown) => {
          this.logger.error(
            `Contest winner ${input.winnerId}: prize changed subscription ${paid.syncSubscriptionId}, but its sync could not be queued: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }
    if (paid.status !== WheelSpinStatus.PENDING) await this.tellReleased(input);
    return { settled: true, status: paid.status };
  }

  /** In the thread when there is one («через поддержку»), as a notification when there is not. */
  private async tellReleased(input: { readonly winnerId: string; readonly adminId: string; readonly note: string | null }): Promise<void> {
    const winner = await this.prismaService.contestWinner.findUnique({
      where: { id: input.winnerId },
      select: {
        id: true,
        userId: true,
        place: true,
        manualTicketId: true,
        prizeSnapshot: true,
        contest: { select: { id: true, title: true } },
        user: { select: { id: true, language: true } },
      },
    });
    if (winner === null) return;
    const snapshot = readSnapshot(winner.prizeSnapshot);
    if (winner.manualTicketId === null) {
      await this.userNotifications
        ?.create({
          userId: winner.userId,
          type: 'contest_prize_issued',
          payload: {
            contestId: winner.contest.id,
            contestTitle: winner.contest.title,
            contestPrize: (snapshot['title'] ?? {}) as Prisma.JsonValue,
            place: winner.place,
          },
        })
        .catch((error: unknown) => {
          this.logger.warn(
            `Contest winner ${winner.id}: the prize was paid but the notice failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      return;
    }
    const locale = prizeTicketLocale(winner.user?.language ?? null);
    const prizeTitle = readTitle(snapshot['title'] as Prisma.JsonValue);
    await this.supportTickets.addMessage({
      ticketId: winner.manualTicketId,
      authorType: 'ADMIN',
      authorId: input.adminId,
      content: contestPrizeSettled(prizeTitle, locale) + (input.note ? `\n\n${input.note}` : ''),
      metadata: { type: 'contest_prize', winnerId: winner.id, outcome: WheelSpinStatus.SETTLED },
    });
    if (winner.user !== null) {
      void this.supportNotifications.notifyAdminReply({
        ticketId: winner.manualTicketId,
        subject: contestPrizeSubject(readTitle(winner.contest.title), prizeTitle, locale),
        user: { id: winner.user.id, language: winner.user.language },
      });
    }
  }

  private async settle(input: {
    readonly winnerId: string;
    readonly adminId: string;
    readonly note: string | null;
    readonly status: WheelSpinStatus;
    readonly message: (prizeTitle: string, locale: PrizeTicketLocale) => string;
  }): Promise<SettleResult> {
    const winner = await this.prismaService.contestWinner.findUnique({
      where: { id: input.winnerId },
      select: {
        id: true,
        status: true,
        manualTicketId: true,
        prizeSnapshot: true,
        contest: { select: { title: true } },
        user: { select: { id: true, language: true } },
      },
    });
    if (winner === null) throw new NotFoundException('Contest winner not found');
    if (winner.status !== WheelSpinStatus.PENDING) return { settled: false, reason: 'NOT_PENDING' };

    // BEFORE the status moves: the conversation opens only for what is still
    // owed, and settling is what stops it being owed.
    const ticketId = winner.manualTicketId ?? (await this.openTicket(winner.id));

    const written = await this.prismaService.contestWinner.updateMany({
      where: { id: winner.id, status: WheelSpinStatus.PENDING },
      data: { status: input.status, settledAt: new Date(), settledBy: input.adminId, settlementNote: input.note },
    });
    if (written.count !== 1) return { settled: false, reason: 'NOT_PENDING' };

    if (ticketId !== null) {
      const prizeTitle = readTitle(readSnapshot(winner.prizeSnapshot)['title'] as Prisma.JsonValue);
      await this.supportTickets.addMessage({
        ticketId,
        authorType: 'ADMIN',
        authorId: input.adminId,
        content: input.message(prizeTitle, prizeTicketLocale(winner.user?.language ?? null)),
        metadata: { type: 'contest_prize', winnerId: winner.id, outcome: input.status },
      });
      if (winner.user !== null) {
        void this.supportNotifications.notifyAdminReply({
          ticketId,
          // The card wrapping this subject IS localized, so a Russian
          // subject line arrived inside an English notification.
          subject: contestPrizeSubject(
            readTitle(winner.contest.title),
            prizeTitle,
            prizeTicketLocale(winner.user.language),
          ),
          user: { id: winner.user.id, language: winner.user.language },
        });
      }
    }
    return { settled: true, status: input.status };
  }
}

class TicketRaceLost extends Error {}

function toRow(row: WinnerRow): ContestWinnerRow {
  const snapshot = readSnapshot(row.prizeSnapshot);
  const outcome = readSnapshot(row.outcome);
  return {
    id: row.id,
    contestId: row.contestId,
    contestTitle: row.contest.title,
    place: row.place,
    kind: row.kind,
    prizeTitle: (snapshot['title'] ?? {}) as Prisma.JsonValue,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
    settledBy: row.settledBy,
    settlementNote: row.settlementNote,
    ticketId: row.manualTicketId,
    instructions: typeof outcome['instructions'] === 'string' ? outcome['instructions'] : '',
    heldForReview: row.heldForReview,
    score: row.score === null ? null : Number(row.score),
    winner: {
      id: row.user.id,
      name: row.user.name,
      username: row.user.username,
      telegramId: row.user.telegramId === null ? null : row.user.telegramId.toString(),
      email: row.user.email,
    },
  };
}

function readSnapshot(value: Prisma.JsonValue | null): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The prize a held winner is owed, from the snapshot taken when it was won —
 * never from the prize row, which may be gone by the time an operator
 * presses «Выдать».
 */
function readPrizeSpec(value: Prisma.JsonValue): PrizeSpec {
  const snapshot = readSnapshot(value);
  const text = (key: string): string | null => {
    const field = snapshot[key];
    return typeof field === 'string' && field !== '' ? field : null;
  };
  const kind = text('kind');
  if (kind === null || !(Object.values(WheelSectorKind) as string[]).includes(kind)) {
    throw new Error('Held contest prize has no readable kind');
  }
  const rewardType = text('promoRewardType');
  const planIds = snapshot['promoPlanIds'];
  return {
    id: text('id') ?? '',
    kind: kind as WheelSectorKind,
    amount: typeof snapshot['amount'] === 'number' ? snapshot['amount'] : 0,
    promoRewardType:
      rewardType !== null && (Object.values(PromocodeRewardType) as string[]).includes(rewardType)
        ? (rewardType as PromocodeRewardType)
        : null,
    promoPlanId: text('promoPlanId'),
    promoPlanIds: Array.isArray(planIds) ? planIds.filter((id): id is string => typeof id === 'string') : [],
    promoLifetime: typeof snapshot['promoLifetime'] === 'number' ? snapshot['promoLifetime'] : null,
    keyPoolId: text('keyPoolId'),
    manualInstructions: text('manualInstructions'),
  };
}

function readTitle(value: Prisma.JsonValue | null | undefined): string {
  const copy = readSnapshot(value ?? null);
  const ru = copy['ru'];
  const en = copy['en'];
  if (typeof ru === 'string' && ru.trim() !== '') return ru;
  if (typeof en === 'string' && en.trim() !== '') return en;
  return 'приз';
}
