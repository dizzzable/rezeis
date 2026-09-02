import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  PointsLedgerSource,
  Prisma,
  SubscriptionStatus,
  ReferralRewardType,
  SyncAction,
  SyncJobStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { PointsWalletService } from '../../points/services/points-wallet.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { buildAdminAuditLogData } from '../../../common/utils/admin-audit-log.util';
import { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { CreateRewardDto } from '../dto/create-reward.dto';
import { ListRewardsQueryDto } from '../dto/list-rewards-query.dto';
import {
  AdminReferralRewardInterface,
  AdminReferralRewardsListInterface,
  BulkIssueRewardsResultInterface,
} from '../interfaces/admin-rewards.interface';
import { ReferralUserSummaryInterface } from '../interfaces/referral.interface';
import { buildReferralUserDisplayName } from './referral-user-identity';

// Mirrors `REFERRAL_USER_SUMMARY_SELECT` in `referrals.service.ts`, and for
// the same reason: the rewards table paints the same `ReferralUserSummary`,
// so selecting fewer identity columns here would make a web-only user
// nameable on one referral screen and anonymous on the other.
const REWARD_USER_SELECT = {
  id: true,
  username: true,
  name: true,
  telegramId: true,
  email: true,
  webAccount: { select: { login: true, email: true } },
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
 * ONE audit action for "an operator issued a referral reward", whichever
 * control produced it. The surface lives in `metadata.source`, not in a second
 * action name — the shape `partner.balance.adjusted` settled on today, and for
 * the same reason: two action names for one act make the row that answers
 * "who paid this customer" impossible to find with one query.
 *
 * Issuing moves money — POINTS credit a spendable balance, EXTRA_DAYS extend a
 * paid subscription — and until now it was the only money-moving admin act on
 * this controller that left NOTHING on the audit surface. `ReferralReward.
 * issuedBy`/`issuedAt` are a real trail, but they live on the domain row: an
 * operator reading `admin_audit_log` saw manual attaches, balance adjustments
 * and refunds, and no sign that a reward had ever been handed out.
 */
const REWARD_ISSUED_ACTION = 'referral.reward.issued';

/** Which control issued the reward — see {@link REWARD_ISSUED_ACTION}. */
const REWARD_ISSUE_SOURCE = {
  single: 'single',
  bulk: 'bulk',
} as const;

type RewardIssueSource = (typeof REWARD_ISSUE_SOURCE)[keyof typeof REWARD_ISSUE_SOURCE];

/**
 * Admin-side reward management — list, manually grant, issue (apply
 * effect to the user), bulk issue, and revoke. Sister of
 * `ReferralQualificationService`, which runs the *automatic* path
 * triggered by qualifying purchases: it CREATES reward rows when a
 * referral qualifies, and stops there.
 *
 * ISSUING A REWARD HAPPENS HERE AND NOWHERE ELSE. The qualification service
 * carried its own `issueReward` for a while — unreachable from anything, and
 * diverged: no `ProfileSyncJob`, so `EXTRA_DAYS` never reached the panel, and
 * a silent "issued" for a user with no eligible subscription. It is gone, and
 * a second copy must not come back. `applyRewardEffect` below is the single
 * implementation: POINTS bumps `User.points`; EXTRA_DAYS extends an ACTIVE
 * finite subscription resolved under a row lock and enqueues the sync that
 * pushes the new expiry to Remnawave.
 */
@Injectable()
export class AdminRewardsService {
  private readonly logger = new Logger(AdminRewardsService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly profileSyncQueue: ProfileSyncQueueService,
    private readonly events: SystemEventsService,
    private readonly pointsWallet: PointsWalletService,
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

  /**
   * The actor is `string`, not `string | null`, and that is deliberate.
   *
   * This path now writes an `admin_audit_log` row, and `buildAdminAuditLogData`
   * takes a named actor because every audit row in this repository has one. A
   * nullable actor here would put a branch on the audit write for a case no
   * caller can produce — the sole route is behind `AdminJwtAuthGuard` — and an
   * unreachable branch on an audit path is how an audit path stops being
   * written (the same call `bulk-user-operations.service.ts` made today). With
   * `string` the compiler, not a code reviewer, guarantees that every reward
   * this method issues leaves a row naming who issued it.
   *
   * `grant`/`revoke` keep `string | null`: they write no audit row, and
   * `ReferralReward.grantedBy` genuinely records automatic grants.
   */
  public async issue(
    rewardId: string,
    actorAdminId: string,
    requestMetadata: RequestMetadataInterface,
  ): Promise<AdminReferralRewardInterface> {
    return this.issueOne(rewardId, actorAdminId, requestMetadata, REWARD_ISSUE_SOURCE.single);
  }

  private async issueOne(
    rewardId: string,
    actorAdminId: string,
    requestMetadata: RequestMetadataInterface,
    source: RewardIssueSource,
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

        const effect = await applyRewardEffect(tx, this.pointsWallet, {
          id: reward.id,
          referralId: reward.referralId,
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
        // INSIDE the transaction, and after the grant — the opposite placement
        // decision from the system event below, for the opposite reason.
        //
        // The event is a notification: announcing points that a rollback then
        // takes back is worse than announcing them late, so it waits for the
        // commit. The audit row is not a notification, it is part of the same
        // fact as the write — "these points were credited BY this operator".
        // Written after the commit it would be a second, independently
        // failable statement about a payout that already happened, and the
        // gap between them is exactly where an audit row goes missing: the
        // process dies, the connection drops, the transaction that granted
        // the money is durable and nothing names who did it. Rolled back
        // together, the row and the grant cannot disagree.
        await tx.adminAuditLog.create({
          data: buildAdminAuditLogData({
            action: REWARD_ISSUED_ACTION,
            actorId: actorAdminId,
            requestMetadata,
            metadata: {
              requestId: requestMetadata.requestId,
              source,
              rewardId,
              referralId: reward.referralId,
              userId: reward.userId,
              rewardType: reward.type,
              amount: reward.amount,
              syncJobId: effect.syncJobId,
            },
          }),
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
        `Reward issued: rewardId=${rewardId} actor=${actorAdminId} source=${source} userId=${updated.userId}`,
      );
      // POST-COMMIT, and only when an effect was actually applied.
      //
      // Placement is the whole point: emitted inside the `$transaction`
      // callback it would announce points that a rollback then took back, and
      // the operator feed would disagree with the database. It sits after the
      // enqueue block ON PURPOSE — a failed enqueue does not undo the grant,
      // the sweep re-drives the job, and the reward really was issued.
      //
      // `effectApplied` is false for the already-issued short-circuit above.
      // An event there would be a second "reward issued" card for a no-op.
      //
      // The metadata keys are not free-form. `referrerId`, `rewardType` and
      // `rewardValue` are what `USER_EVENT_WHITELIST['referral.reward_issued']`
      // (`user-realtime-event.interface.ts`) matches and projects: without
      // `referrerId` the projection returns null and the earner is told
      // nothing. `userId` is what `SystemEventsService` reads to put a name on
      // the Telegram card. `ReferralReward.userId` IS the earner — L1 rewards
      // carry the referrer, L2 rewards the ancestor — so it fills both.
      this.events.info(EVENT_TYPES.REFERRAL_REWARD_ISSUED, 'REFERRAL', 'Referral reward issued', {
        rewardId: updated.id,
        referralId: updated.referralId,
        userId: updated.userId,
        referrerId: updated.userId,
        rewardType: updated.type,
        rewardValue: updated.amount,
        issuedBy: actorAdminId,
        syncJobId,
      });
    }
    return mapReward(updated);
  }

  /**
   * ONE audit row PER REWARD, not one naming the batch.
   *
   * The question this log is asked is "who issued THIS reward", and it is asked
   * about one reward. `AdminAuditLog` has no entity columns — the subject lives
   * in `metadata` — so the per-reward answer is
   *
   *   SELECT ... WHERE action = 'referral.reward.issued'
   *              AND metadata->>'rewardId' = $1
   *
   * and that query has to find the bulk issuance too, or it answers "nobody"
   * about a reward a bulk click paid out. A row naming the whole set answers
   * "which click did this" cheaply and the per-reward question not at all
   * without a second, differently-shaped query (`metadata->'rewardIds' @>
   * '["X"]'`) unioned in — and a reader who has to remember to union a second
   * shape is a reader who will eventually forget. Same reasoning as
   * `bulk-user-operations.service.ts`, and the same reasoning that put the
   * origin of `partner.balance.adjusted` in `metadata.source`.
   *
   * It also falls out of the failure model this method already has: a batch is
   * not atomic. Rewards succeed and fail independently, so a single row naming
   * the requested ids would claim payouts that the `errors` array shows never
   * happened. Per reward, the row exists exactly when the money moved, because
   * it is written in the very transaction that moved it.
   *
   * The cost is bounded by the batch size the DTO already caps.
   *
   * No `batchId` here, deliberately, unlike the bulk user path: that one is
   * fired from a toolbar over a checkbox selection where "which click" is a
   * real question. These ids come from the rewards table's own filtered view,
   * and `metadata.requestId` already groups one HTTP call's rows whenever the
   * caller sends the header. Adding a second grouping key that only sometimes
   * agrees with it is how two ways to ask the same question start disagreeing.
   */
  public async bulkIssue(
    ids: readonly string[],
    actorAdminId: string,
    requestMetadata: RequestMetadataInterface,
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
        await this.issueOne(id, actorAdminId, requestMetadata, REWARD_ISSUE_SOURCE.bulk);
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
      `Bulk issue: actor=${actorAdminId} requested=${ids.length} issued=${issued} skipped=${skipped} failed=${failed}`,
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
    email: string | null;
    webAccount: { login: string | null; email: string | null } | null;
    createdAt: Date;
  } | null,
): ReferralUserSummaryInterface {
  if (user === null) {
    // Unreachable with the current schema - `ReferralReward.user` is a
    // REQUIRED relation - and kept only as a guard. There is genuinely no
    // user to name in this branch, so `displayName` is empty here and here
    // only; every real user resolves to something printable below.
    return {
      id: '',
      username: null,
      name: null,
      displayName: '',
      telegramId: null,
      createdAt: new Date(0).toISOString(),
    };
  }
  return {
    id: user.id,
    username: user.username,
    name: user.name === '' ? null : user.name,
    displayName: buildReferralUserDisplayName(user),
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
      // A finite end date IS the eligibility rule for EXTRA_DAYS — a perpetual
      // subscription has nothing to extend. Re-attaching the checked value
      // carries that fact into the return type, so the caller cannot reach the
      // date arithmetic without it.
      return { ...subscription, expiresAt: subscription.expiresAt };
    }
  }
  return null;
}

/**
 * Apply the reward effect inside a Prisma transaction. THE ONLY implementation
 * of reward issuance in this repository, and it must stay that way.
 *
 * It used to cite a second one — the private effect block of
 * `ReferralQualificationService.issueReward` — as the model it mirrored. That
 * method had no caller anywhere in `src/`, and it had diverged on every point
 * that decides whether an `EXTRA_DAYS` reward actually reaches the customer:
 * it targeted `user.currentSubscriptionId` alone with no fallback and no lock,
 * it marked the reward ISSUED and granted nothing when there was no eligible
 * subscription, and it created no `ProfileSyncJob`. Pointing a reader at it was
 * pointing them at the broken half, so it was deleted rather than re-synced.
 */
async function applyRewardEffect(
  tx: Prisma.TransactionClient,
  wallet: PointsWalletService,
  reward: {
    id: string;
    referralId: string;
    userId: string;
    type: ReferralRewardType;
    amount: number;
  },
): Promise<{ readonly syncJobId: string | null }> {
  if (reward.type === ReferralRewardType.POINTS) {
    // Through the wallet, keyed on the reward: the ledger row is what the
    // earner sees as "+N for an invited friend", and the key is what makes a
    // re-driven issue a no-op instead of a second credit.
    const moved = await wallet.apply(tx, {
      userId: reward.userId,
      delta: reward.amount,
      source: PointsLedgerSource.REFERRAL_REWARD,
      referenceKey: reward.id,
      details: { rewardId: reward.id, referralId: reward.referralId },
    });
    if (!moved.applied) {
      if (moved.reason === 'USER_NOT_FOUND') {
        throw new NotFoundException('Cannot issue POINTS reward: the earner no longer exists');
      }
      // DUPLICATE: a ledger row for this reward exists while the reward is not
      // marked issued. That state cannot be produced by this code — the row
      // and the mark commit together — so it is refused rather than papered
      // over with a second credit or a silent mark.
      throw new BadRequestException(
        `Cannot issue POINTS reward ${reward.id}: the points were already credited (${moved.reason})`,
      );
    }
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
  // TWO different failures reach this line, and they need two different guards.
  //
  // The COMPILER one: `refuseUnhandledRewardType` takes `never`, so this call
  // only type-checks while every `ReferralRewardType` member has been peeled off
  // above. Add a third member to the enum and `tsc -p tsconfig.json` fails HERE
  // — the developer who widened the type is made to decide what issuing it
  // grants, at build time, instead of shipping a branch that grants nothing.
  //
  // The RUNTIME one: `reward.type` is read out of a database column, and the
  // enum compiled into this process is only the compiler's BELIEF about that
  // column. A row written by an older or newer deployment, by a migration in
  // flight, or by hand carries whatever it carries, and no compile-time check
  // ever inspects it. So the same guard also THROWS, inside the transaction and
  // before the reward is marked issued, which rolls back the reward update, the
  // audit row and anything the effect had already written.
  //
  // What must never come back is the bare `return { syncJobId: null }` that
  // used to stand here. `issue()` marks the reward ISSUED on whatever this
  // function returns, so an unhandled type produced a row claiming the customer
  // had been paid with nothing granted — precisely the failure the deleted
  // second copy of this logic was deleted for. Refusing is the safe direction:
  // the operator sees an error and the reward stays payable.
  return refuseUnhandledRewardType(reward.type);
}

/**
 * The `never` parameter is the compile-time half of the guard above: passing
 * anything that is not provably impossible is a type error at the call site.
 * The throw is the runtime half, for a `type` column that no longer matches the
 * enum. `BadRequestException` rather than a bare `Error` on purpose — Nest
 * hides a 500's message, and this one names the offending value, which is the
 * only thing that tells an operator (and `bulkIssue`'s `errors` array) what is
 * wrong with that reward.
 */
function refuseUnhandledRewardType(type: never): never {
  throw new BadRequestException(
    `Cannot issue reward: reward type "${String(type)}" has no issuance branch in ` +
      'applyRewardEffect. Nothing was granted and the reward is still unissued.',
  );
}
