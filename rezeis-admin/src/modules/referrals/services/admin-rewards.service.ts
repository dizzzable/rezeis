import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  SubscriptionStatus,
  ReferralRewardType,
  SyncAction,
  SyncJobStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { CreateRewardDto } from '../dto/create-reward.dto';
import { ListRewardsQueryDto } from '../dto/list-rewards-query.dto';
import {
  AdminReferralRewardInterface,
  AdminReferralRewardsListInterface,
  BulkIssueRewardsResultInterface,
} from '../interfaces/admin-rewards.interface';
import { ReferralUserSummaryInterface } from '../interfaces/referral.interface';

const REWARD_USER_SELECT = {
  id: true,
  username: true,
  name: true,
  telegramId: true,
  createdAt: true,
} as const;

const REWARD_INCLUDE = {
  user: { select: REWARD_USER_SELECT },
} as const;

type RewardRecord = Prisma.ReferralRewardGetPayload<{
  include: typeof REWARD_INCLUDE;
}>;

const DEFAULT_LIMIT = 100;

/**
 * Admin-side reward management — list, manually grant, issue (apply
 * effect to the user), bulk issue, and revoke. Sister of
 * `ReferralQualificationService`, which runs the *automatic* path
 * triggered by qualifying purchases.
 *
 * The two services share `applyRewardEffect` semantics: POINTS bumps
 * `User.points`, EXTRA_DAYS extends the user's current subscription
 * `expiresAt`. We keep both implementations local instead of importing
 * the qualification service to avoid a circular dependency, and to
 * record the `issuedBy` actor that the qualification path ignores.
 */
@Injectable()
export class AdminRewardsService {
  private readonly logger = new Logger(AdminRewardsService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly profileSyncQueue: ProfileSyncQueueService,
  ) {}

  // ── Read ────────────────────────────────────────────────────────────────

  public async list(query: ListRewardsQueryDto): Promise<AdminReferralRewardsListInterface> {
    const where: Prisma.ReferralRewardWhereInput = {
      revokedAt: null,
    };
    if (query.userId !== undefined) where.userId = query.userId;
    if (query.referralId !== undefined) where.referralId = query.referralId;
    if (query.type !== undefined) where.type = query.type;
    if (query.issued === 'true') where.isIssued = true;
    if (query.issued === 'false') where.isIssued = false;

    const limit = query.limit ?? DEFAULT_LIMIT;
    const offset = query.offset ?? 0;

    const [records, total] = await Promise.all([
      this.prismaService.referralReward.findMany({
        where,
        include: REWARD_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prismaService.referralReward.count({ where }),
    ]);

    return {
      items: records.map(mapReward),
      total,
    };
  }

  // ── Manual grant ────────────────────────────────────────────────────────

  public async grant(
    dto: CreateRewardDto,
    actorAdminId: string | null,
  ): Promise<AdminReferralRewardInterface> {
    const referral = await this.prismaService.referral.findUnique({
      where: { id: dto.referralId },
      select: { id: true, referrerId: true, referredId: true },
    });
    if (referral === null) {
      throw new NotFoundException('Referral edge not found');
    }

    const userId = await this.resolveUserId(dto);
    if (userId !== referral.referrerId && userId !== referral.referredId) {
      throw new BadRequestException(
        'User is not part of this referral edge (must be referrer or referred)',
      );
    }

    const created = await this.prismaService.referralReward.create({
      data: {
        referralId: dto.referralId,
        userId,
        type: dto.type,
        amount: dto.amount,
        grantedBy: actorAdminId,
      },
      include: REWARD_INCLUDE,
    });
    this.logger.log(
      `Manual reward grant: rewardId=${created.id} actor=${actorAdminId ?? 'system'} amount=${dto.amount} type=${dto.type}`,
    );
    return mapReward(created);
  }

  // ── Issue (apply effect) ───────────────────────────────────────────────

  public async issue(
    rewardId: string,
    actorAdminId: string | null,
  ): Promise<AdminReferralRewardInterface> {
    const { updated, syncJobId, effectApplied } = await this.prismaService.$transaction(
      async (tx) => {
        await lockReferralReward(tx, rewardId);
        const reward = await tx.referralReward.findUnique({
          where: { id: rewardId },
          include: REWARD_INCLUDE,
        });
        if (reward === null) throw new NotFoundException('Reward not found');
        if (reward.revokedAt !== null) {
          throw new BadRequestException('Cannot issue a revoked reward');
        }
        if (reward.isIssued) {
          return { updated: reward, syncJobId: null, effectApplied: false };
        }

        const effect = await applyRewardEffect(tx, {
          userId: reward.userId,
          type: reward.type,
          amount: reward.amount,
        });
        const result = await tx.referralReward.update({
          where: { id: rewardId },
          data: {
            isIssued: true,
            issuedAt: new Date(),
            issuedBy: actorAdminId,
          },
          include: REWARD_INCLUDE,
        });
        return { updated: result, syncJobId: effect.syncJobId, effectApplied: true };
      },
    );

    if (syncJobId) {
      try {
        await this.profileSyncQueue.enqueue(syncJobId);
      } catch (enqueueErr: unknown) {
        const message = enqueueErr instanceof Error ? enqueueErr.message : 'Unknown error';
        this.logger.warn(
          `Reward ${rewardId} issued but sync enqueue failed (sweep will recover): ${message}`,
        );
      }
    }

    if (effectApplied) {
      this.logger.log(
        `Reward issued: rewardId=${rewardId} actor=${actorAdminId ?? 'system'} userId=${updated.userId}`,
      );
    }
    return mapReward(updated);
  }

  public async bulkIssue(
    ids: readonly string[],
    actorAdminId: string | null,
  ): Promise<BulkIssueRewardsResultInterface> {
    let issued = 0;
    let skipped = 0;
    let failed = 0;
    const errors: Array<{ id: string; error: string }> = [];

    // Preload the eligibility snapshot for every id in ONE query instead of a
    // findUnique per id. `issue()` still does its own transactional re-read,
    // so correctness is unchanged; this only removes the N pre-check reads.
    const uniqueIds = Array.from(new Set(ids));
    const rows = await this.prismaService.referralReward.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, isIssued: true, revokedAt: true },
    });
    const snapshot = new Map(
      rows.map((row) => [row.id, { isIssued: row.isIssued, revokedAt: row.revokedAt }]),
    );

    for (const id of ids) {
      try {
        const before = snapshot.get(id) ?? null;
        if (before === null) {
          failed += 1;
          errors.push({ id, error: 'NOT_FOUND' });
          continue;
        }
        if (before.revokedAt !== null) {
          skipped += 1;
          continue;
        }
        if (before.isIssued) {
          skipped += 1;
          continue;
        }
        await this.issue(id, actorAdminId);
        // Mark issued in the local snapshot so a duplicate id later in the
        // same request is skipped (matches the previous per-id re-read).
        before.isIssued = true;
        issued += 1;
      } catch (error: unknown) {
        failed += 1;
        const message = error instanceof Error ? error.message : 'unknown';
        errors.push({ id, error: message });
      }
    }

    this.logger.log(
      `Bulk issue: actor=${actorAdminId ?? 'system'} requested=${ids.length} issued=${issued} skipped=${skipped} failed=${failed}`,
    );
    return { issued, skipped, failed, errors };
  }

  // ── Revoke ─────────────────────────────────────────────────────────────

  public async revoke(
    rewardId: string,
    reason: string | null,
    actorAdminId: string | null,
  ): Promise<AdminReferralRewardInterface> {
    const updated = await this.prismaService.$transaction(async (tx) => {
      await lockReferralReward(tx, rewardId);
      const reward = await tx.referralReward.findUnique({ where: { id: rewardId } });
      if (reward === null) throw new NotFoundException('Reward not found');
      if (reward.revokedAt !== null) {
        throw new BadRequestException('Reward already revoked');
      }
      if (reward.isIssued) {
        throw new BadRequestException(
          'Cannot revoke an already-issued reward — refund flow handles balance reversal separately',
        );
      }
      return tx.referralReward.update({
        where: { id: rewardId },
        data: { revokedAt: new Date(), revokeReason: reason },
        include: REWARD_INCLUDE,
      });
    });

    this.logger.log(
      `Reward revoked: rewardId=${rewardId} actor=${actorAdminId ?? 'system'} reason=${reason ?? 'none'}`,
    );
    return mapReward(updated);
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private async resolveUserId(dto: CreateRewardDto): Promise<string> {
    if (dto.userId !== undefined) return dto.userId;
    if (dto.userTelegramId !== undefined) {
      const user = await this.prismaService.user.findUnique({
        where: { telegramId: BigInt(dto.userTelegramId) },
        select: { id: true },
      });
      if (user === null) {
        throw new NotFoundException('User not found by telegram id');
      }
      return user.id;
    }
    throw new BadRequestException('Either userId or userTelegramId required');
  }
}

function mapReward(record: RewardRecord): AdminReferralRewardInterface {
  return {
    id: record.id,
    referralId: record.referralId,
    user: mapUser(record.user),
    userTelegramId: record.user?.telegramId?.toString() ?? null,
    type: record.type,
    amount: record.amount,
    isIssued: record.isIssued,
    issuedAt: record.issuedAt?.toISOString() ?? null,
    issuedBy: record.issuedBy,
    createdAt: record.createdAt.toISOString(),
  };
}

function mapUser(
  user: {
    id: string;
    username: string | null;
    name: string;
    telegramId: bigint | null;
    createdAt: Date;
  } | null,
): ReferralUserSummaryInterface {
  if (user === null) {
    return {
      id: '',
      username: null,
      name: null,
      telegramId: null,
      createdAt: new Date(0).toISOString(),
    };
  }
  return {
    id: user.id,
    username: user.username,
    name: user.name === '' ? null : user.name,
    telegramId: user.telegramId?.toString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

async function lockReferralReward(tx: Prisma.TransactionClient, rewardId: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "referral_rewards" WHERE "id" = ${rewardId} FOR UPDATE`,
  );
}

async function lockSubscription(
  tx: Prisma.TransactionClient,
  subscriptionId: string,
): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscriptionId} FOR UPDATE`,
  );
}

async function resolveActiveFiniteSubscription(
  tx: Prisma.TransactionClient,
  userId: string,
  currentSubscriptionId: string | null,
) {
  const fallback = await tx.subscription.findFirst({
    where: { userId, status: SubscriptionStatus.ACTIVE, expiresAt: { not: null } },
    select: { id: true },
    orderBy: [{ expiresAt: 'desc' }, { id: 'desc' }],
  });
  const candidateIds = Array.from(
    new Set(
      [currentSubscriptionId, fallback?.id ?? null].filter((id): id is string => id !== null),
    ),
  );

  for (const subscriptionId of candidateIds) {
    await lockSubscription(tx, subscriptionId);
    const subscription = await tx.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        status: true,
        remnawaveId: true,
      },
    });
    if (
      subscription !== null &&
      subscription.userId === userId &&
      subscription.status === SubscriptionStatus.ACTIVE &&
      subscription.expiresAt !== null
    ) {
      return subscription;
    }
  }
  return null;
}

/**
 * Apply the reward effect inside a Prisma transaction. Mirrors the
 * private `applyEffect` block of `ReferralQualificationService.issueReward`.
 */
async function applyRewardEffect(
  tx: Prisma.TransactionClient,
  reward: { userId: string; type: ReferralRewardType; amount: number },
): Promise<{ readonly syncJobId: string | null }> {
  if (reward.type === ReferralRewardType.POINTS) {
    await tx.user.update({
      where: { id: reward.userId },
      data: { points: { increment: reward.amount } },
    });
    return { syncJobId: null };
  }
  if (reward.type === ReferralRewardType.EXTRA_DAYS) {
    const user = await tx.user.findUnique({
      where: { id: reward.userId },
      select: { currentSubscriptionId: true },
    });
    const subscription = await resolveActiveFiniteSubscription(
      tx,
      reward.userId,
      user?.currentSubscriptionId ?? null,
    );
    if (subscription === null) {
      throw new BadRequestException(
        'Cannot issue EXTRA_DAYS reward: user has no finite active subscription. ' +
          'Grant once an eligible subscription exists, or convert to POINTS.',
      );
    }
    const newExpiresAt = new Date(
      Math.max(subscription.expiresAt.getTime(), Date.now()) + reward.amount * 24 * 60 * 60 * 1000,
    );
    await tx.subscription.update({
      where: { id: subscription.id },
      data: { expiresAt: newExpiresAt },
    });
    // Push the extended expiry to Remnawave. Without this ProfileSyncJob the
    // extra days only live in the local DB and never reach the user's real VPN
    // profile ("дни выдались, только с задержкой" — the sync never fired).
    const syncJob = await tx.profileSyncJob.create({
      data: {
        subscriptionId: subscription.id,
        action: subscription.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        payload: {
          source: 'REFERRAL_EXTRA_DAYS_REWARD',
          userId: reward.userId,
          days: reward.amount,
        } as Prisma.InputJsonObject,
      },
    });
    return { syncJobId: syncJob.id };
  }
  return { syncJobId: null };
}
