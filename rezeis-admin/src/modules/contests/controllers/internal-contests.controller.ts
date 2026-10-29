import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { ContestStatus, Prisma, WheelSpinStatus } from '@prisma/client';
import { IsBoolean, IsOptional, ValidateIf } from 'class-validator';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { buildUserReferenceWhere } from '../../internal-user/utils/user-reference.util';
import { maskPublicName } from '../contest-public-name.util';
import { ContestService, readClosedReason, type EntryRefusal } from '../services/contest.service';

/** How long a finished contest stays on everybody's screen. Entrants keep theirs. */
const PUBLIC_RESULTS_DAYS = 30;

/** A contest as the person sees it. No entrant list, no odds beyond their own tickets. */
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
  /** This person's own result, once drawn. */
  readonly myResult: {
    readonly place: number;
    readonly prizeTitle: Prisma.JsonValue;
    readonly status: WheelSpinStatus;
    readonly prize: Record<string, unknown> | null;
    readonly ticketId: string | null;
  } | null;
  /** The channel entering needs, so the screen can link to it. */
  readonly channel: { readonly joinUrl: string } | null;
  /**
   * What earns extra chances, and how many this person holds — as the draw
   * counted them, or before it as it would count them now. `null` when the
   * contest gives one chance each.
   */
  readonly tickets: {
    readonly perPurchase: number;
    readonly perReferral: number;
    readonly max: number | null;
    readonly mine: number;
  } | null;
  /** SHA-256 of the draw's seed: promised from the start. */
  readonly seedHash: string | null;
  /** The seed itself, once the draw has used it. */
  readonly seed: string | null;
  /** Everybody's view of a finished contest: who won what, names masked. */
  readonly winners: ReadonlyArray<{
    readonly place: number;
    readonly name: string | null;
    readonly prizeTitle: Prisma.JsonValue;
  }> | null;
  readonly drawnEntries: number | null;
  readonly drawnTickets: number | null;
}

/**
 * `true` / `false` — what Telegram said about the person and the contest's
 * channel; `null` — Telegram could not be asked. Absent from a cabinet that
 * does not check channels.
 */
class EnterContestDto {
  @IsOptional()
  @ValidateIf((_dto: EnterContestDto, value: unknown) => value !== null)
  @IsBoolean()
  public channelMember?: boolean | null;
}

/**
 * Contests, for the person entering them. Consumed by reiwa.
 *
 * Auth as everywhere on this surface: the BFF proves itself with the api
 * token, the person is whoever reiwa's session says, and every read is scoped
 * to them. What is deliberately NOT here: who else entered, and anything
 * about the odds beyond the entry count and the person's own tickets.
 *
 * Who won IS here, for a finished contest, with the names masked — the owner
 * (29.10.2026) wants everybody to be able to see that a draw happened and
 * went to real people. Only for a cabinet that asks (`?results=all`): an
 * older one draws every finished contest as "how you did", and would tell
 * somebody who never entered that they were unlucky.
 */
@ApiTags('internal/user/contests')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/contests')
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalContestsController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly contests: ContestService,
  ) {}

  @Get(':userRef')
  @ApiOperation({ summary: 'Идущие конкурсы, итоги прошедших и мои результаты' })
  public async list(
    @Param('userRef') userRef: string,
    @Query('results') results?: string,
  ): Promise<readonly CabinetContest[]> {
    const person = await this.resolveUser(userRef);
    const userId = person.id;
    const now = new Date();
    const everybodysResults = results === 'all';
    const recent = new Date(now.getTime() - PUBLIC_RESULTS_DAYS * 24 * 60 * 60 * 1000);

    // Live contests; drawn ones this person took part in — they want to find
    // out how they did; and, for a cabinet that shows them, every contest
    // drawn lately, plus a recent cancellation this person had entered, so it
    // does not simply vanish from their screen.
    const rows = await this.prismaService.contest.findMany({
      where: {
        OR: [
          { status: ContestStatus.ACTIVE },
          { status: ContestStatus.DRAWN, entries: { some: { userId } } },
          ...(everybodysResults
            ? [
                { status: ContestStatus.DRAWN, drawnAt: { gte: recent } },
                { status: ContestStatus.CANCELLED, updatedAt: { gte: recent }, entries: { some: { userId } } },
              ]
            : []),
        ],
      },
      orderBy: [{ status: 'asc' }, { endAt: 'desc' }],
      take: 50,
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        startAt: true,
        endAt: true,
        audienceFilter: true,
        ticketsPerPurchase: true,
        ticketsPerReferral: true,
        maxTicketsPerUser: true,
        channelChatId: true,
        channelJoinUrl: true,
        drawSeed: true,
        drawSeedHash: true,
        drawnEntries: true,
        drawnTickets: true,
        prizes: { orderBy: { place: 'asc' }, select: { place: true, kind: true, title: true, amount: true } },
        entries: { where: { userId }, select: { id: true, tickets: true } },
        _count: { select: { entries: true } },
      },
    });

    // Who this person may actually enter. Without it the screen offers the
    // button to everybody and the audience filter refuses on tap, which reads
    // as a broken button rather than as a contest that is not for them.
    const eligible = await this.contests.eligibleAmong(
      userId,
      rows.filter((row) => row.status === ContestStatus.ACTIVE),
    );

    const ids = rows.map((row) => row.id);
    const drawnIds = rows.filter((row) => row.status === ContestStatus.DRAWN).map((row) => row.id);
    const [mine, allWinners] = await Promise.all([
      this.prismaService.contestWinner.findMany({
        where: { userId, contestId: { in: ids } },
        select: {
          contestId: true,
          place: true,
          status: true,
          prizeSnapshot: true,
          outcome: true,
          manualTicketId: true,
          key: { select: { value: true } },
        },
      }),
      everybodysResults && drawnIds.length > 0
        ? this.prismaService.contestWinner.findMany({
            where: { contestId: { in: drawnIds } },
            orderBy: { place: 'asc' },
            select: {
              contestId: true,
              place: true,
              prizeSnapshot: true,
              user: { select: { name: true, username: true } },
            },
          })
        : Promise.resolve([]),
    ]);
    const myWins = new Map(mine.map((win) => [win.contestId, win]));
    const winnersOf = new Map<string, Array<{ place: number; name: string | null; prizeTitle: Prisma.JsonValue }>>();
    for (const win of allWinners) {
      const list = winnersOf.get(win.contestId) ?? [];
      list.push({
        place: win.place,
        name: maskPublicName(win.user.name, win.user.username),
        prizeTitle: (readObject(win.prizeSnapshot)['title'] ?? {}) as Prisma.JsonValue,
      });
      winnersOf.set(win.contestId, list);
    }

    const views: CabinetContest[] = [];
    for (const row of rows) {
      const win = myWins.get(row.id) ?? null;
      const entry = row.entries[0] ?? null;
      const hasTickets = row.ticketsPerPurchase > 0 || row.ticketsPerReferral > 0;
      const myTickets = !hasTickets
        ? 1
        : entry?.tickets != null
          ? entry.tickets
          : row.status === ContestStatus.ACTIVE
            ? await this.contests.ticketsOf(row, userId)
            : 1;
      views.push({
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        startAt: row.startAt.toISOString(),
        endAt: row.endAt.toISOString(),
        entries: row._count.entries,
        prizes: row.prizes,
        entered: entry !== null,
        closed:
          readClosedReason(row, now) ??
          (row.status !== ContestStatus.ACTIVE
            ? null
            : !eligible.has(row.id)
              ? 'NOT_ELIGIBLE'
              : row.channelChatId !== null && person.telegramId === null
                ? 'NEEDS_TELEGRAM'
                : null),
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
        channel: row.channelJoinUrl === null ? null : { joinUrl: row.channelJoinUrl },
        tickets: hasTickets
          ? {
              perPurchase: row.ticketsPerPurchase,
              perReferral: row.ticketsPerReferral,
              max: row.maxTicketsPerUser,
              mine: myTickets,
            }
          : null,
        seedHash: row.drawSeedHash,
        seed: row.status === ContestStatus.DRAWN ? row.drawSeed : null,
        winners: row.status === ContestStatus.DRAWN && everybodysResults ? (winnersOf.get(row.id) ?? []) : null,
        drawnEntries: row.status === ContestStatus.DRAWN ? row.drawnEntries : null,
        drawnTickets: row.status === ContestStatus.DRAWN ? row.drawnTickets : null,
      });
    }
    return views;
  }

  /**
   * Take part. A contest that needs a channel and was not told what Telegram
   * says is refused with the channel attached — and the person's Telegram id,
   * which the cabinet would otherwise have to look up: the cabinet holds the
   * bot token, asks Telegram about exactly that chat and that person, and
   * comes back with the answer in `channelMember`. The id is for the cabinet's
   * backend; it does not pass it on to the browser.
   */
  @Post(':userRef/:contestId/enter')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Участвовать' })
  public async enter(
    @Param('userRef') userRef: string,
    @Param('contestId') contestId: string,
    @Body() dto: EnterContestDto,
  ): Promise<{
    readonly entered: boolean;
    readonly reason: EntryRefusal | null;
    readonly channel?: { readonly chatId: string; readonly joinUrl: string; readonly telegramId: string | null };
  }> {
    const { id: userId, telegramId } = await this.resolveUser(userRef);
    const result = await this.contests.enter({
      contestId,
      userId,
      ...(dto.channelMember === undefined ? {} : { channelMember: dto.channelMember }),
    });
    if (result.reason !== 'CHANNEL_REQUIRED') return result;
    const contest = await this.prismaService.contest.findUnique({
      where: { id: contestId },
      select: { channelChatId: true, channelJoinUrl: true },
    });
    if (contest?.channelChatId == null || contest.channelJoinUrl == null) return result;
    return {
      ...result,
      channel: {
        chatId: contest.channelChatId,
        joinUrl: contest.channelJoinUrl,
        telegramId: telegramId === null ? null : telegramId.toString(),
      },
    };
  }

  private async resolveUser(userRef: string): Promise<{ readonly id: string; readonly telegramId: bigint | null }> {
    const user = await this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(userRef),
      select: { id: true, telegramId: true },
    });
    if (user === null) throw new NotFoundException('User not found');
    return user;
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
