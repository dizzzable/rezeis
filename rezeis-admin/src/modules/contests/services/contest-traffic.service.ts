import { Injectable, Logger } from '@nestjs/common';
import { ContestKind, ContestMetric, ContestStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { describeStrictOutcome } from '../../remnawave/interfaces/remnawave-strict-outcome.interface';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';

/** How often a running traffic leaderboard is read. */
const READ_EVERY_MS = 60 * 60 * 1000;

/**
 * Reads traffic for the leaderboards that rank by it.
 *
 * Remnawave keeps no history this side could ask "how much between the 1st
 * and the 31st" — only counters. `usedTrafficBytes` resets with every monthly
 * reset; `lifetimeUsedTrafficBytes` never does, and that is the one read
 * here. The contest remembers it per subscription when it first sees one and
 * keeps the latest reading; the score is the difference.
 *
 * ── When ──────────────────────────────────────────────────────────────────
 *
 * Every hour while a contest runs — the board people watch moves hourly —
 * and once more after its end, which the end waits for: without it the last
 * hours of use are not on the board. One read of the panel serves every
 * traffic leaderboard due at the time.
 *
 * ── What counts from when ─────────────────────────────────────────────────
 *
 * A subscription made after the contest started counts from nothing: all its
 * traffic is the contest's. One that already existed counts from the first
 * reading — up to an hour of the contest's first traffic is not counted for
 * anybody, which treats everybody the same. A counter that goes BACKWARDS
 * (the panel user was recreated) keeps what was counted so far and goes on
 * from the new value, rather than handing anybody a negative score.
 *
 * A panel that cannot be read leaves every counter as it was; the board just
 * does not move until the next hour.
 */
@Injectable()
export class ContestTrafficService {
  private readonly logger = new Logger(ContestTrafficService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawave: RemnawaveApiService,
  ) {}

  /** Read the panel for every traffic leaderboard that is due. Returns how many were read. */
  public async readDue(now = new Date()): Promise<number> {
    const due = await this.prismaService.contest.findMany({
      where: {
        status: ContestStatus.ACTIVE,
        kind: ContestKind.LEADERBOARD,
        metric: ContestMetric.TRAFFIC,
        startAt: { lte: now },
        OR: [
          { trafficReadAt: null },
          { trafficReadAt: { lte: new Date(now.getTime() - READ_EVERY_MS) } },
          // Over, and perhaps not read since: the end is waiting for that read.
          { endAt: { lte: now } },
        ],
      },
      select: { id: true, startAt: true, endAt: true, trafficReadAt: true },
    });
    // `trafficReadAt < endAt` compares two columns, which a Prisma filter
    // cannot; the third branch above takes every ended one and this narrows it.
    const contests = due.filter(
      (contest) =>
        contest.trafficReadAt === null ||
        contest.trafficReadAt.getTime() <= now.getTime() - READ_EVERY_MS ||
        (contest.endAt.getTime() <= now.getTime() && contest.trafficReadAt.getTime() < contest.endAt.getTime()),
    );
    if (contests.length === 0) return 0;

    const bulk = await this.remnawave.strictGetAllPanelUsers();
    if (bulk.kind !== 'ok') {
      this.logger.warn(`Traffic leaderboards not read: ${describeStrictOutcome(bulk)}`);
      return 0;
    }
    const owners = await this.owners();

    const readings: { readonly remnawaveId: string; readonly bytes: bigint; readonly owner: Owner }[] = [];
    for (const user of bulk.value.users) {
      const bytes = user.userTraffic?.lifetimeUsedTrafficBytes;
      if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) continue;
      const owner = owners.byRemnawaveId.get(user.uuid) ?? (user.panelId === null ? undefined : owners.byPanelId.get(user.panelId));
      if (owner === undefined) continue;
      readings.push({ remnawaveId: user.uuid, bytes: BigInt(Math.trunc(bytes)), owner });
    }

    for (const contest of contests) {
      try {
        await this.record(contest, readings, now);
      } catch (error: unknown) {
        this.logger.warn(
          `Traffic for contest ${contest.id} not recorded: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return contests.length;
  }

  private async record(
    contest: { readonly id: string; readonly startAt: Date },
    readings: readonly { readonly remnawaveId: string; readonly bytes: bigint; readonly owner: Owner }[],
    now: Date,
  ): Promise<void> {
    const known = new Map(
      (
        await this.prismaService.contestTrafficCounter.findMany({
          where: { contestId: contest.id },
          select: { id: true, remnawaveId: true, startBytes: true, lastBytes: true },
        })
      ).map((row) => [row.remnawaveId, row]),
    );

    const fresh: Prisma.ContestTrafficCounterCreateManyInput[] = [];
    const moved: { id: string; startBytes: bigint; lastBytes: bigint }[] = [];
    for (const reading of readings) {
      const counter = known.get(reading.remnawaveId);
      if (counter === undefined) {
        const startBytes = reading.owner.createdAt.getTime() > contest.startAt.getTime() ? 0n : reading.bytes;
        fresh.push({
          contestId: contest.id,
          remnawaveId: reading.remnawaveId,
          userId: reading.owner.userId,
          startBytes,
          lastBytes: reading.bytes,
          updatedAt: now,
        });
        continue;
      }
      if (reading.bytes > counter.lastBytes) {
        moved.push({ id: counter.id, startBytes: counter.startBytes, lastBytes: reading.bytes });
      } else if (reading.bytes < counter.lastBytes) {
        // Recreated in the panel: keep what was counted, go on from here.
        moved.push({
          id: counter.id,
          startBytes: reading.bytes - (counter.lastBytes - counter.startBytes),
          lastBytes: reading.bytes,
        });
      }
    }

    for (let start = 0; start < fresh.length; start += 5_000) {
      await this.prismaService.contestTrafficCounter.createMany({
        data: fresh.slice(start, start + 5_000),
        skipDuplicates: true,
      });
    }
    // One statement per chunk, not one per subscription: an hourly read of a
    // busy panel moves thousands of counters.
    for (let start = 0; start < moved.length; start += 5_000) {
      const chunk = moved.slice(start, start + 5_000);
      await this.prismaService.$executeRaw`
        UPDATE "contest_traffic_counters" AS c
           SET "start_bytes" = m."start_bytes",
               "last_bytes"  = m."last_bytes",
               "updated_at"  = ${now}
          FROM (
            SELECT UNNEST(${chunk.map((row) => row.id)}::text[])                      AS "id",
                   UNNEST(${chunk.map((row) => row.startBytes.toString())}::bigint[]) AS "start_bytes",
                   UNNEST(${chunk.map((row) => row.lastBytes.toString())}::bigint[])  AS "last_bytes"
          ) AS m
         WHERE c."id" = m."id"`;
    }
    await this.prismaService.contest.updateMany({
      where: { id: contest.id, status: ContestStatus.ACTIVE },
      data: { trafficReadAt: now },
    });
  }

  /**
   * Whose panel user is whose. A profile made on Remnawave 2.x keeps its UUID
   * in `remnawaveId` and its numeric id in `remnawavePanelId`; one made on 3.x
   * has the numeric id, in decimal, in both — so a panel row is matched on
   * either.
   */
  private async owners(): Promise<{
    readonly byRemnawaveId: ReadonlyMap<string, Owner>;
    readonly byPanelId: ReadonlyMap<number, Owner>;
  }> {
    const rows = await this.prismaService.subscription.findMany({
      where: { OR: [{ remnawaveId: { not: null } }, { remnawavePanelId: { not: null } }] },
      select: { userId: true, remnawaveId: true, remnawavePanelId: true, createdAt: true },
    });
    const byRemnawaveId = new Map<string, Owner>();
    const byPanelId = new Map<number, Owner>();
    for (const row of rows) {
      const owner = { userId: row.userId, createdAt: row.createdAt };
      if (row.remnawaveId !== null) byRemnawaveId.set(row.remnawaveId, owner);
      if (row.remnawavePanelId !== null) byPanelId.set(row.remnawavePanelId, owner);
    }
    return { byRemnawaveId, byPanelId };
  }
}

interface Owner {
  readonly userId: string;
  readonly createdAt: Date;
}
