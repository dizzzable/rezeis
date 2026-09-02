import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, WheelSectorKind, WheelSpinStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SupportNotificationsService } from '../../support-tickets/services/support-notifications.service';
import { SupportTicketsService } from '../../support-tickets/services/support-tickets.service';

export interface ManualPrizeRow {
  readonly spinId: string;
  readonly status: WheelSpinStatus;
  readonly createdAt: string;
  readonly settledAt: string | null;
  readonly settledBy: string | null;
  readonly settlementNote: string | null;
  readonly ticketId: string | null;
  /** What the operator has to do, as they wrote it on the sector. */
  readonly instructions: string;
  readonly sector: {
    readonly id: string | null;
    readonly title: Prisma.JsonValue;
    readonly rarity: string | null;
  };
  readonly winner: {
    readonly id: string;
    readonly name: string;
    readonly username: string | null;
    readonly telegramId: string | null;
    readonly email: string | null;
  };
}

export interface ManualPrizePage {
  readonly items: readonly ManualPrizeRow[];
  readonly nextCursor: string | null;
}

export type SettleResult =
  | { readonly settled: true; readonly status: WheelSpinStatus }
  /** Somebody else got there first, or it was never owed in the first place. */
  | { readonly settled: false; readonly reason: 'NOT_PENDING' };

export const MANUAL_PRIZE_DEFAULT_LIMIT = 25;
export const MANUAL_PRIZE_MAX_LIMIT = 100;

const SPIN_SELECT = {
  id: true,
  status: true,
  createdAt: true,
  settledAt: true,
  settledBy: true,
  settlementNote: true,
  manualTicketId: true,
  sectorId: true,
  sectorSnapshot: true,
  outcome: true,
  user: {
    select: { id: true, name: true, username: true, telegramId: true, email: true, language: true },
  },
} as const;

type SpinRow = Prisma.WheelSpinGetPayload<{ select: typeof SPIN_SELECT }>;

/**
 * The prizes a human has to hand over, and the record of who did.
 *
 * ── Why this does not live in the wheel module ────────────────────────────
 *
 * `WheelModule` is imported wherever the wheel is merely READ — the user
 * card, the cabinet controllers, events. Opening a conversation needs the
 * support stack, which needs Auth, notifications and two queues behind it; put
 * that import in the wheel and the whole chain is constructed in every one of
 * those places. So the wheel records the debt and this module, which may be
 * as heavy as it likes, settles it.
 *
 * ── Why a conversation and not a notification ─────────────────────────────
 *
 * "1000 ₽" is a bank transfer somebody makes, by hand, after asking the winner
 * where to send it. That is a conversation, and the product already has one:
 * the support ticket, which the operator answers in the inbox they already
 * watch and the winner reads where they already read everything else. A
 * one-way notification would announce the prize and leave both sides with
 * nowhere to arrange it.
 *
 * The person is NOT notified when the conversation opens. They have just this
 * second watched the wheel stop on the jackpot — telling them they won is the
 * one thing that needs no message. They hear from us when the operator
 * actually says something, which is a reply and is delivered as one.
 */
@Injectable()
export class WheelManualPrizeService {
  private readonly logger = new Logger(WheelManualPrizeService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly supportTickets: SupportTicketsService,
    private readonly supportNotifications: SupportNotificationsService,
  ) {}

  /** The queue, newest first. `status` omitted means everything owed. */
  public async list(input: {
    readonly status?: WheelSpinStatus | null;
    readonly cursor?: string | null;
    readonly limit?: number | null;
  }): Promise<ManualPrizePage> {
    const limit = clampLimit(input.limit);
    const rows = await this.prismaService.wheelSpin.findMany({
      where: {
        kind: WheelSectorKind.MANUAL,
        ...(input.status == null ? { status: WheelSpinStatus.PENDING } : { status: input.status }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One more than asked: its presence is how "there is a next page" is
      // known without a second round trip.
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      select: SPIN_SELECT,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((row) => toRow(row)),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  public async findOne(spinId: string): Promise<ManualPrizeRow> {
    const spin = await this.prismaService.wheelSpin.findUnique({
      where: { id: spinId },
      select: SPIN_SELECT,
    });
    if (spin === null) throw new NotFoundException('Wheel spin not found');
    return toRow(spin);
  }

  /**
   * Open the conversation for one owed prize.
   *
   * Safe to call twice and safe to call from two places at once: the ticket is
   * created inside a transaction that also claims `manualTicketId`, and a
   * claim that loses the race rolls the ticket back with it. Without that the
   * loser would leave an orphan conversation nobody is ever told about.
   */
  public async openTicket(spinId: string): Promise<string | null> {
    const spin = await this.prismaService.wheelSpin.findUnique({
      where: { id: spinId },
      select: {
        id: true,
        kind: true,
        status: true,
        manualTicketId: true,
        sectorSnapshot: true,
        userId: true,
      },
    });
    if (spin === null) return null;
    if (spin.kind !== WheelSectorKind.MANUAL) return null;
    if (spin.status !== WheelSpinStatus.PENDING) return null;
    if (spin.manualTicketId !== null) return spin.manualTicketId;

    const title = readTitle(spin.sectorSnapshot);
    try {
      return await this.prismaService.$transaction(async (tx) => {
        const ticket = await tx.supportTicket.create({
          data: {
            userId: spin.userId,
            subject: `Приз с колеса: ${title}`,
            status: 'OPEN',
          },
          select: { id: true },
        });
        const claimed = await tx.wheelSpin.updateMany({
          where: { id: spin.id, manualTicketId: null },
          data: { manualTicketId: ticket.id },
        });
        if (claimed.count !== 1) throw new TicketRaceLost();

        await tx.supportTicketMessage.create({
          data: {
            ticketId: ticket.id,
            authorType: 'SYSTEM',
            authorId: null,
            content:
              `Вы выиграли на колесе: ${title}. ` +
              'Оператор свяжется с вами здесь, чтобы вручить приз.',
            metadata: { type: 'wheel_manual_prize', spinId: spin.id },
          },
        });
        return ticket.id;
      });
    } catch (error) {
      if (error instanceof TicketRaceLost) {
        const current = await this.prismaService.wheelSpin.findUnique({
          where: { id: spin.id },
          select: { manualTicketId: true },
        });
        return current?.manualTicketId ?? null;
      }
      throw error;
    }
  }

  /**
   * Open a conversation for every owed prize that has none.
   *
   * The backstop, and — until the cabinet calls `openTicket` on the way out of
   * a spin — the only path. It is written as a sweep rather than as a hook
   * inside the spin transaction on purpose: a ticket created in that
   * transaction would be rolled back with any later failure, and one created
   * after it would be lost to a crash in between. A sweep over the debts
   * cannot lose one, whatever crashed.
   */
  public async openMissingTickets(batch = 50): Promise<number> {
    const owed = await this.prismaService.wheelSpin.findMany({
      where: {
        kind: WheelSectorKind.MANUAL,
        status: WheelSpinStatus.PENDING,
        manualTicketId: null,
      },
      orderBy: { createdAt: 'asc' },
      take: batch,
      select: { id: true },
    });

    let opened = 0;
    for (const spin of owed) {
      try {
        if ((await this.openTicket(spin.id)) !== null) opened += 1;
      } catch (error: unknown) {
        this.logger.warn(
          `Could not open the conversation for wheel spin ${spin.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return opened;
  }

  /** The operator handed the prize over. */
  public async issue(input: {
    readonly spinId: string;
    readonly adminId: string;
    readonly note: string | null;
  }): Promise<SettleResult> {
    return this.settle({
      spinId: input.spinId,
      adminId: input.adminId,
      note: input.note,
      status: WheelSpinStatus.SETTLED,
      message: (title) =>
        `Приз с колеса вручён: ${title}.` + (input.note ? `\n\n${input.note}` : ''),
    });
  }

  /**
   * The operator decided not to hand it over, and said why.
   *
   * The spin is NOT given back. Whether a refusal deserves compensation is a
   * judgement about the particular case, and the operator has a manual spin
   * adjustment for the cases where it does; refunding here would pay out on
   * every refusal, including the ones aimed at somebody gaming the wheel.
   */
  public async refuse(input: {
    readonly spinId: string;
    readonly adminId: string;
    readonly reason: string;
  }): Promise<SettleResult> {
    return this.settle({
      spinId: input.spinId,
      adminId: input.adminId,
      note: input.reason,
      status: WheelSpinStatus.REFUSED,
      message: (title) => `По призу с колеса «${title}» принято решение отказать.\n\n${input.reason}`,
    });
  }

  private async settle(input: {
    readonly spinId: string;
    readonly adminId: string;
    readonly note: string | null;
    readonly status: WheelSpinStatus;
    readonly message: (title: string) => string;
  }): Promise<SettleResult> {
    const spin = await this.prismaService.wheelSpin.findUnique({
      where: { id: input.spinId },
      select: {
        id: true,
        kind: true,
        status: true,
        manualTicketId: true,
        sectorSnapshot: true,
        user: { select: { id: true, language: true } },
      },
    });
    if (spin === null) throw new NotFoundException('Wheel spin not found');
    if (spin.kind !== WheelSectorKind.MANUAL) return { settled: false, reason: 'NOT_PENDING' };
    // An early exit on a stale click, so nothing below opens a conversation
    // about a prize that was handed over last week. The conditional write is
    // still the authority; this only spares the operator's inbox.
    if (spin.status !== WheelSpinStatus.PENDING) return { settled: false, reason: 'NOT_PENDING' };

    // The conversation is opened BEFORE the status moves, because `openTicket`
    // opens one only for a prize that is still owed — and settling is the very
    // thing that stops it being owed. Doing it the other way round left a
    // refusal with nowhere to say why, which is a refusal nobody can appeal.
    const ticketId = spin.manualTicketId ?? (await this.openTicket(spin.id));

    // PENDING rides in the WHERE, so two operators clicking at the same moment
    // cannot both settle it and the second is told so rather than silently
    // overwriting the first one's note.
    const written = await this.prismaService.wheelSpin.updateMany({
      where: { id: spin.id, status: WheelSpinStatus.PENDING },
      data: {
        status: input.status,
        settledAt: new Date(),
        settledBy: input.adminId,
        settlementNote: input.note,
      },
    });
    if (written.count !== 1) return { settled: false, reason: 'NOT_PENDING' };

    // The conversation is where the person finds out.
    if (ticketId !== null) {
      const title = readTitle(spin.sectorSnapshot);
      await this.supportTickets.addMessage({
        ticketId,
        authorType: 'ADMIN',
        authorId: input.adminId,
        content: input.message(title),
        metadata: { type: 'wheel_manual_prize', spinId: spin.id, outcome: input.status },
      });
      if (spin.user !== null) {
        // Fire-and-forget, as everywhere else a reply is announced: a delivery
        // that fails must not undo a prize that was handed over.
        void this.supportNotifications.notifyAdminReply({
          ticketId,
          subject: `Приз с колеса: ${title}`,
          user: { id: spin.user.id, language: spin.user.language },
        });
      }
    }

    return { settled: true, status: input.status };
  }
}

/** Thrown to roll a ticket back when another writer claimed the spin first. */
class TicketRaceLost extends Error {}

function toRow(spin: SpinRow): ManualPrizeRow {
  const snapshot = readSnapshot(spin.sectorSnapshot);
  return {
    spinId: spin.id,
    status: spin.status,
    createdAt: spin.createdAt.toISOString(),
    settledAt: spin.settledAt?.toISOString() ?? null,
    settledBy: spin.settledBy,
    settlementNote: spin.settlementNote,
    ticketId: spin.manualTicketId,
    instructions: readInstructions(spin.outcome),
    sector: {
      id: spin.sectorId,
      title: (snapshot['title'] ?? {}) as Prisma.JsonValue,
      rarity: typeof snapshot['rarity'] === 'string' ? snapshot['rarity'] : null,
    },
    winner: {
      id: spin.user.id,
      name: spin.user.name,
      username: spin.user.username,
      // BigInt does not survive JSON, and the panel only ever displays it.
      telegramId: spin.user.telegramId === null ? null : spin.user.telegramId.toString(),
      email: spin.user.email,
    },
  };
}

function readSnapshot(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The sector's own name, in Russian where there is one.
 *
 * Read from the SNAPSHOT, never from the live sector: an operator renaming a
 * sector must not rewrite the subject of a conversation already under way.
 */
function readTitle(value: Prisma.JsonValue): string {
  const title = readSnapshot(value)['title'];
  const copy = readSnapshot((title ?? null) as Prisma.JsonValue);
  const ru = copy['ru'];
  const en = copy['en'];
  if (typeof ru === 'string' && ru.trim() !== '') return ru;
  if (typeof en === 'string' && en.trim() !== '') return en;
  return 'приз';
}

/** What the operator wrote on the sector, carried on the spin's outcome. */
function readInstructions(value: Prisma.JsonValue): string {
  const instructions = readSnapshot(value)['instructions'];
  return typeof instructions === 'string' ? instructions : '';
}

function clampLimit(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MANUAL_PRIZE_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MANUAL_PRIZE_MAX_LIMIT);
}
