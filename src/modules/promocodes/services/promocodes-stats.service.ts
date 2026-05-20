import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

export interface PromocodesStatsQueryInput {
  readonly from?: Date;
  readonly to?: Date;
  readonly promocodeId?: string;
}

export interface PromocodesStatsTotalsInterface {
  readonly activations: number;
  readonly uniqueUsers: number;
}

export interface PromocodesStatsByCodeInterface {
  readonly promocodeId: string;
  readonly promocodeCode: string;
  readonly rewardType: string;
  readonly activations: number;
  readonly uniqueUsers: number;
}

export interface PromocodesStatsByRewardInterface {
  readonly rewardType: string;
  readonly activations: number;
  readonly totalRewardValue: number;
}

export interface PromocodesStatsTopUserInterface {
  readonly userId: string;
  readonly displayName: string;
  readonly username: string | null;
  readonly telegramId: string | null;
  readonly activations: number;
}

export interface PromocodesStatsTimelinePointInterface {
  readonly bucket: string;
  readonly activations: number;
}

export interface PromocodesStatsResultInterface {
  readonly totals: PromocodesStatsTotalsInterface;
  readonly byCode: readonly PromocodesStatsByCodeInterface[];
  readonly byReward: readonly PromocodesStatsByRewardInterface[];
  readonly topUsers: readonly PromocodesStatsTopUserInterface[];
  readonly timeline: readonly PromocodesStatsTimelinePointInterface[];
}

@Injectable()
export class PromocodesStatsService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async getStats(
    input: PromocodesStatsQueryInput,
  ): Promise<PromocodesStatsResultInterface> {
    const where: Prisma.PromocodeActivationWhereInput = {};
    if (input.promocodeId) {
      where.promocodeId = input.promocodeId;
    }
    if (input.from || input.to) {
      where.activatedAt = {};
      if (input.from) where.activatedAt.gte = input.from;
      if (input.to) where.activatedAt.lte = input.to;
    }

    const activations = await this.prismaService.promocodeActivation.findMany({
      where,
      select: {
        promocodeId: true,
        promocodeCode: true,
        rewardType: true,
        rewardValue: true,
        userId: true,
        activatedAt: true,
        user: {
          select: {
            name: true,
            username: true,
            telegramId: true,
          },
        },
      },
      orderBy: { activatedAt: 'asc' },
    });

    const userSet = new Set<string>();
    const codeMap = new Map<
      string,
      {
        readonly promocodeId: string;
        readonly promocodeCode: string;
        readonly rewardType: string;
        activations: number;
        readonly users: Set<string>;
      }
    >();
    const rewardMap = new Map<
      string,
      {
        readonly rewardType: string;
        activations: number;
        totalRewardValue: number;
      }
    >();
    const userMap = new Map<
      string,
      {
        readonly userId: string;
        readonly displayName: string;
        readonly username: string | null;
        readonly telegramId: string | null;
        activations: number;
      }
    >();
    const timelineMap = new Map<string, { readonly bucket: string; activations: number }>();

    for (const row of activations) {
      userSet.add(row.userId);

      // by code
      let codeEntry = codeMap.get(row.promocodeId);
      if (!codeEntry) {
        codeEntry = {
          promocodeId: row.promocodeId,
          promocodeCode: row.promocodeCode,
          rewardType: row.rewardType,
          activations: 0,
          users: new Set<string>(),
        };
        codeMap.set(row.promocodeId, codeEntry);
      }
      codeEntry.activations += 1;
      codeEntry.users.add(row.userId);

      // by reward
      let rewardEntry = rewardMap.get(row.rewardType);
      if (!rewardEntry) {
        rewardEntry = { rewardType: row.rewardType, activations: 0, totalRewardValue: 0 };
        rewardMap.set(row.rewardType, rewardEntry);
      }
      rewardEntry.activations += 1;
      rewardEntry.totalRewardValue += row.rewardValue;

      // top users
      let userEntry = userMap.get(row.userId);
      if (!userEntry) {
        const fallbackName =
          (row.user.name && row.user.name.length > 0 ? row.user.name : null) ??
          row.user.username ??
          (row.user.telegramId ? `tg:${row.user.telegramId.toString()}` : row.userId);
        userEntry = {
          userId: row.userId,
          displayName: fallbackName,
          username: row.user.username,
          telegramId: row.user.telegramId ? row.user.telegramId.toString() : null,
          activations: 0,
        };
        userMap.set(row.userId, userEntry);
      }
      userEntry.activations += 1;

      // timeline
      const isoDay = row.activatedAt.toISOString().slice(0, 10);
      let timelineEntry = timelineMap.get(isoDay);
      if (!timelineEntry) {
        timelineEntry = { bucket: isoDay, activations: 0 };
        timelineMap.set(isoDay, timelineEntry);
      }
      timelineEntry.activations += 1;
    }

    const byCode = Array.from(codeMap.values())
      .map((entry) => ({
        promocodeId: entry.promocodeId,
        promocodeCode: entry.promocodeCode,
        rewardType: entry.rewardType,
        activations: entry.activations,
        uniqueUsers: entry.users.size,
      }))
      .sort((a, b) => b.activations - a.activations);

    const byReward = Array.from(rewardMap.values()).sort(
      (a, b) => b.activations - a.activations,
    );

    const topUsers = Array.from(userMap.values())
      .sort((a, b) => b.activations - a.activations)
      .slice(0, 10);

    const timeline = Array.from(timelineMap.values()).sort((a, b) =>
      a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0,
    );

    return {
      totals: {
        activations: activations.length,
        uniqueUsers: userSet.size,
      },
      byCode,
      byReward,
      topUsers,
      timeline,
    };
  }
}
