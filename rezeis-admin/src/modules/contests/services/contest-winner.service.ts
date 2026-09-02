import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, WheelSpinStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SupportNotificationsService } from '../../support-tickets/services/support-notifications.service';
import { SupportTicketsService } from '../../support-tickets/services/support-tickets.service';
import type { SettleResult } from '../../wheel-prizes/services/wheel-manual-prize.service';

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
 */
@Injectable()
export class ContestWinnerService {
  private readonly logger = new Logger(ContestWinnerService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly supportTickets: SupportTicketsService,
    private readonly supportNotifications: SupportNotificationsService,
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
        contest: { select: { title: true } },
      },
    });
    if (winner === null) return null;
    if (winner.status !== WheelSpinStatus.PENDING) return null;
    if (winner.manualTicketId !== null) return winner.manualTicketId;

    const contestTitle = readTitle(winner.contest.title);
    const prizeTitle = readTitle(readSnapshot(winner.prizeSnapshot)['title'] as Prisma.JsonValue);
    try {
      return await this.prismaService.$transaction(async (tx) => {
        const ticket = await tx.supportTicket.create({
          data: { userId: winner.userId, subject: `Приз конкурса «${contestTitle}»: ${prizeTitle}`, status: 'OPEN' },
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
            content:
              `Вы выиграли в конкурсе «${contestTitle}»: ${prizeTitle}. ` +
              'Оператор свяжется с вами здесь, чтобы вручить приз.',
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

  public async openMissingTickets(batch = 50): Promise<number> {
    const owed = await this.prismaService.contestWinner.findMany({
      where: { status: WheelSpinStatus.PENDING, manualTicketId: null },
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

  public issue(input: { readonly winnerId: string; readonly adminId: string; readonly note: string | null }): Promise<SettleResult> {
    return this.settle({
      ...input,
      status: WheelSpinStatus.SETTLED,
      message: (prize) => `Приз вручён: ${prize}.` + (input.note ? `\n\n${input.note}` : ''),
    });
  }

  public refuse(input: { readonly winnerId: string; readonly adminId: string; readonly reason: string }): Promise<SettleResult> {
    return this.settle({
      winnerId: input.winnerId,
      adminId: input.adminId,
      note: input.reason,
      status: WheelSpinStatus.REFUSED,
      message: (prize) => `По призу «${prize}» принято решение отказать.\n\n${input.reason}`,
    });
  }

  private async settle(input: {
    readonly winnerId: string;
    readonly adminId: string;
    readonly note: string | null;
    readonly status: WheelSpinStatus;
    readonly message: (prizeTitle: string) => string;
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
        content: input.message(prizeTitle),
        metadata: { type: 'contest_prize', winnerId: winner.id, outcome: input.status },
      });
      if (winner.user !== null) {
        void this.supportNotifications.notifyAdminReply({
          ticketId,
          subject: `Приз конкурса «${readTitle(winner.contest.title)}»: ${prizeTitle}`,
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

function readTitle(value: Prisma.JsonValue | null | undefined): string {
  const copy = readSnapshot(value ?? null);
  const ru = copy['ru'];
  const en = copy['en'];
  if (typeof ru === 'string' && ru.trim() !== '') return ru;
  if (typeof en === 'string' && en.trim() !== '') return en;
  return 'приз';
}
