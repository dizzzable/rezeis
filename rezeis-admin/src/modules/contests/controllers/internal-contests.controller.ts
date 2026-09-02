import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ContestStatus, Prisma, WheelSpinStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { buildUserReferenceWhere } from '../../internal-user/utils/user-reference.util';
import { ContestService, readClosedReason, type EntryRefusal } from '../services/contest.service';

/** A contest as the person sees it. No entrant list, no odds, no other winners. */
interface CabinetContest {
  readonly id: string;
  readonly title: Prisma.JsonValue;
  readonly description: Prisma.JsonValue;
  readonly status: ContestStatus;
  readonly startAt: string;
  readonly endAt: string;
  /** How many have entered — the one number that makes a contest feel real. */
  readonly entries: number;
  readonly prizes: ReadonlyArray<{
    readonly place: number;
    readonly kind: string;
    readonly title: Prisma.JsonValue;
    readonly amount: number;
  }>;
  readonly entered: boolean;
  /** Why the button is not there, when it is not. */
  readonly closed: EntryRefusal | null;
  /** This person's own result, once drawn. Nobody else's. */
  readonly myResult: {
    readonly place: number;
    readonly prizeTitle: Prisma.JsonValue;
    readonly status: WheelSpinStatus;
    readonly prize: Record<string, unknown> | null;
    readonly ticketId: string | null;
  } | null;
}

/**
 * Contests, for the person entering them. Consumed by reiwa.
 *
 * Auth as everywhere on this surface: the BFF proves itself with the api
 * token, the person is whoever reiwa's session says, and every read is scoped
 * to them. What is deliberately NOT here: who else entered, who else won, and
 * anything about the odds beyond the entry count.
 */
@ApiTags('internal/user/contests')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/contests')
export class InternalContestsController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly contests: ContestService,
  ) {}

  @Get(':userRef')
  @ApiOperation({ summary: 'Идущие конкурсы и мои результаты в прошедших' })
  public async list(@Param('userRef') userRef: string): Promise<readonly CabinetContest[]> {
    const userId = await this.resolveUserId(userRef);
    const now = new Date();
    // Live contests, plus drawn ones this person took part in: a person wants
    // to find out how they did, and a contest they never entered is noise.
    const rows = await this.prismaService.contest.findMany({
      where: {
        OR: [
          { status: ContestStatus.ACTIVE },
          { status: ContestStatus.DRAWN, entries: { some: { userId } } },
        ],
      },
      orderBy: [{ status: 'asc' }, { endAt: 'desc' }],
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        startAt: true,
        endAt: true,
        prizes: { orderBy: { place: 'asc' }, select: { place: true, kind: true, title: true, amount: true } },
        entries: { where: { userId }, select: { id: true } },
        _count: { select: { entries: true } },
      },
    });

    const mine = await this.prismaService.contestWinner.findMany({
      where: { userId, contestId: { in: rows.map((row) => row.id) } },
      select: {
        contestId: true,
        place: true,
        status: true,
        prizeSnapshot: true,
        outcome: true,
        manualTicketId: true,
        key: { select: { value: true } },
      },
    });
    const myWins = new Map(mine.map((win) => [win.contestId, win]));

    return rows.map((row) => {
      const win = myWins.get(row.id) ?? null;
      return {
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        startAt: row.startAt.toISOString(),
        endAt: row.endAt.toISOString(),
        entries: row._count.entries,
        prizes: row.prizes,
        entered: row.entries.length > 0,
        closed: readClosedReason(row, now),
        myResult:
          win === null
            ? null
            : {
                place: win.place,
                prizeTitle: (readObject(win.prizeSnapshot)['title'] ?? {}) as Prisma.JsonValue,
                status: win.status,
                prize: buildPrize(win.outcome, win.key?.value ?? null),
                ticketId: win.manualTicketId,
              },
      };
    });
  }

  @Post(':userRef/:contestId/enter')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Участвовать' })
  public async enter(
    @Param('userRef') userRef: string,
    @Param('contestId') contestId: string,
  ): Promise<{ readonly entered: boolean; readonly reason: EntryRefusal | null }> {
    const userId = await this.resolveUserId(userRef);
    return this.contests.enter({ contestId, userId });
  }

  private async resolveUserId(userRef: string): Promise<string> {
    const user = await this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(userRef),
      select: { id: true },
    });
    if (user === null) throw new NotFoundException('User not found');
    return user.id;
  }
}

/** What the person actually received. The operator's note never passes through. */
function buildPrize(outcome: Prisma.JsonValue | null, keyValue: string | null): Record<string, unknown> | null {
  const raw = readObject(outcome);
  if (keyValue !== null) return { key: keyValue };
  if (raw['manual'] === true) return null;
  const { points, days, trafficGb, discountPercent, promoCode, spins } = raw;
  const prize = {
    ...(points === undefined ? {} : { points }),
    ...(days === undefined ? {} : { days }),
    ...(trafficGb === undefined ? {} : { trafficGb }),
    ...(discountPercent === undefined ? {} : { discountPercent }),
    ...(promoCode === undefined ? {} : { promoCode }),
    ...(spins === undefined ? {} : { spins }),
  };
  return Object.keys(prize).length === 0 ? null : prize;
}

function readObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
