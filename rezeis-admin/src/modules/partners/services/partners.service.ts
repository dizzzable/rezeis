import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Partner, Prisma, WithdrawalStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import {
  ListPartnersQueryDto,
  ListPartnerWithdrawalsQueryDto,
} from '../dto/list-partners-query.dto';
import { ProcessPartnerWithdrawalDto } from '../dto/process-partner-withdrawal.dto';
import {
  PartnerInterface,
  PartnerStatsInterface,
  PartnerUserSummaryInterface,
  PartnerWithdrawalInterface,
} from '../interfaces/partner.interface';
import { PartnerNotificationsService } from './partner-notifications.service';

const PARTNER_USER_SELECT = {
  id: true,
  name: true,
  username: true,
  telegramId: true,
  createdAt: true,
} as const;

const PARTNER_INCLUDE = {
  user: { select: PARTNER_USER_SELECT },
  _count: {
    select: {
      referrals: true,
    },
  },
} as const;

type PartnerRecord = Prisma.PartnerGetPayload<{ include: typeof PARTNER_INCLUDE }>;

const WITHDRAWAL_PARTNER_INCLUDE = {
  partner: {
    select: {
      id: true,
      isActive: true,
      user: {
        select: {
          id: true,
          name: true,
          username: true,
          telegramId: true,
        },
      },
    },
  },
} as const;

type PartnerWithdrawalRecord = Prisma.PartnerWithdrawalGetPayload<{
  include: typeof WITHDRAWAL_PARTNER_INCLUDE;
}>;

/**
 * ONE audit action for a balance adjustment, whichever screen performed it.
 * The origin lives in `metadata.source`, not in the action name.
 *
 * The user-detail panel used to write its own `user.partner.balance.adjusted`
 * with no amounts in it, so "who moved this balance and by how much" had to be
 * asked twice and one of the two answers had no numbers. Same reasoning as
 * `user.subscription.limits_changed`, which discriminates `operator_edit` from
 * `plan_assignment` the same way: a reader that has to remember to union a
 * second action name is a reader that will eventually forget.
 *
 *   SELECT metadata->>'partnerId', metadata->>'source',
 *          metadata->>'adjustment', metadata->>'previousBalance',
 *          metadata->>'newBalance', created_at
 *   FROM   admin_audit_log
 *   WHERE  action = 'partner.balance.adjusted'
 *   ORDER  BY created_at
 */
const PARTNER_BALANCE_ADJUSTED_ACTION = 'partner.balance.adjusted';

/** Which surface the operator used — see {@link PARTNER_BALANCE_ADJUSTED_ACTION}. */
type PartnerBalanceAdjustmentSource = 'partners_tab' | 'user_detail';

interface ProcessPartnerWithdrawalInput {
  readonly withdrawalId: string;
  readonly nextStatus: Exclude<WithdrawalStatus, 'PENDING'>;
  readonly dto: ProcessPartnerWithdrawalDto;
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
}

@Injectable()
export class PartnersService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly events: SystemEventsService,
    private readonly partnerNotificationsService: PartnerNotificationsService,
  ) {}

  public async listPartners(
    query: ListPartnersQueryDto,
  ): Promise<readonly PartnerInterface[]> {
    const where: Prisma.PartnerWhereInput = {};
    if (query.isActive === 'true') {
      where.isActive = true;
    } else if (query.isActive === 'false') {
      where.isActive = false;
    }
    if (query.search !== undefined && query.search.trim().length > 0) {
      const trimmed = query.search.trim();
      const userFilter: Prisma.UserWhereInput = {
        OR: [
          { name: { contains: trimmed, mode: 'insensitive' } },
          { username: { contains: trimmed, mode: 'insensitive' } },
        ],
      };
      const numericTelegramId = trimmed.match(/^\d{3,}$/);
      if (numericTelegramId) {
        try {
          (userFilter.OR as Prisma.UserWhereInput[]).push({
            telegramId: BigInt(trimmed),
          });
        } catch {
          // ignore non-bigint inputs
        }
      }
      where.user = userFilter;
    }
    const orderBy: Prisma.PartnerOrderByWithRelationInput[] = [];
    const sort = query.sort ?? 'totalEarned';
    const order = query.order ?? 'desc';
    orderBy.push({ [sort]: order } as Prisma.PartnerOrderByWithRelationInput);
    if (sort !== 'createdAt') {
      orderBy.push({ createdAt: 'desc' });
    }
    const partners = await this.prismaService.partner.findMany({
      where,
      include: PARTNER_INCLUDE,
      orderBy,
      take: query.limit ?? 100,
      skip: query.offset ?? 0,
    });
    return partners.map(mapPartner);
  }

  public async listWithdrawals(
    query: ListPartnerWithdrawalsQueryDto,
  ): Promise<readonly PartnerWithdrawalInterface[]> {
    const where: Prisma.PartnerWithdrawalWhereInput = {
      partnerId: query.partnerId,
      status: query.status,
    };
    if (query.search !== undefined && query.search.trim().length > 0) {
      const trimmed = query.search.trim();
      const userFilter: Prisma.UserWhereInput = {
        OR: [
          { name: { contains: trimmed, mode: 'insensitive' } },
          { username: { contains: trimmed, mode: 'insensitive' } },
        ],
      };
      const numericTelegramId = trimmed.match(/^\d{3,}$/);
      if (numericTelegramId) {
        try {
          (userFilter.OR as Prisma.UserWhereInput[]).push({
            telegramId: BigInt(trimmed),
          });
        } catch {
          // ignore
        }
      }
      where.partner = { user: userFilter };
    }
    const withdrawals = await this.prismaService.partnerWithdrawal.findMany({
      where,
      include: WITHDRAWAL_PARTNER_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit ?? 100,
      skip: query.offset ?? 0,
    });
    return withdrawals.map(mapPartnerWithdrawal);
  }

  /**
   * Bulk approve a list of pending withdrawals. Each withdrawal is processed
   * inside its own transaction, mirroring `approveWithdrawal` semantics.
   * Errors per-id are collected; the operation never aborts mid-batch so
   * the operator can see exactly what passed and what failed.
   */
  public async bulkApproveWithdrawals(input: {
    readonly withdrawalIds: readonly string[];
    readonly adminComment: string | null;
    readonly currentAdmin: CurrentAdminInterface;
    readonly requestMetadata: RequestMetadataInterface;
  }): Promise<{
    readonly approved: number;
    readonly failed: number;
    readonly errors: ReadonlyArray<{ id: string; error: string }>;
  }> {
    const errors: Array<{ id: string; error: string }> = [];
    let approved = 0;
    for (const withdrawalId of input.withdrawalIds) {
      try {
        await this.approveWithdrawal({
          withdrawalId,
          dto: { adminComment: input.adminComment ?? undefined },
          currentAdmin: input.currentAdmin,
          requestMetadata: input.requestMetadata,
        });
        approved += 1;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'unknown';
        errors.push({ id: withdrawalId, error: message });
      }
    }
    return { approved, failed: errors.length, errors };
  }

  public async getStats(): Promise<PartnerStatsInterface> {
    const now = new Date();
    const window7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const window30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const [
      totalPartners,
      activePartners,
      pendingWithdrawals,
      completedWithdrawals,
      rejectedWithdrawals,
      partnerAggregate,
      earnings30d,
      earnings7d,
      completed30d,
    ] = await Promise.all([
      this.prismaService.partner.count(),
      this.prismaService.partner.count({ where: { isActive: true } }),
      this.prismaService.partnerWithdrawal.count({
        where: { status: WithdrawalStatus.PENDING },
      }),
      this.prismaService.partnerWithdrawal.count({
        where: { status: WithdrawalStatus.COMPLETED },
      }),
      this.prismaService.partnerWithdrawal.count({
        where: { status: WithdrawalStatus.REJECTED },
      }),
      this.prismaService.partner.aggregate({
        _sum: { balance: true, totalEarned: true, totalWithdrawn: true },
      }),
      this.prismaService.partnerTransaction.aggregate({
        where: { createdAt: { gte: window30d } },
        _sum: { earnedAmount: true },
      }),
      this.prismaService.partnerTransaction.aggregate({
        where: { createdAt: { gte: window7d } },
        _sum: { earnedAmount: true },
      }),
      this.prismaService.partnerWithdrawal.count({
        where: {
          status: WithdrawalStatus.COMPLETED,
          processedAt: { gte: window30d },
        },
      }),
    ]);
    return {
      totalPartners,
      activePartners,
      pendingWithdrawals,
      completedWithdrawals,
      rejectedWithdrawals,
      totalBalance: partnerAggregate._sum.balance ?? 0,
      totalEarned: partnerAggregate._sum.totalEarned ?? 0,
      totalWithdrawn: partnerAggregate._sum.totalWithdrawn ?? 0,
      earningsLast30d: earnings30d._sum.earnedAmount ?? 0,
      earningsLast7d: earnings7d._sum.earnedAmount ?? 0,
      completedLast30d: completed30d,
      generatedAt: now.toISOString(),
    };
  }

  /** Approves a pending withdrawal: marks COMPLETED, increments totalWithdrawn. */
  public async approveWithdrawal(
    input: Omit<ProcessPartnerWithdrawalInput, 'nextStatus'>,
  ): Promise<PartnerWithdrawalInterface> {
    return this.processWithdrawalWithBalanceMutation({
      ...input,
      nextStatus: WithdrawalStatus.COMPLETED,
      auditAction: 'partner.withdrawal.approved',
    });
  }

  /**
   * Rejects a pending withdrawal and **restores** the amount back to the
   * partner's balance. In our flow (matching altshop), the balance is deducted
   * at withdrawal-request time, so rejection must credit it back.
   */
  public async rejectWithdrawal(
    input: Omit<ProcessPartnerWithdrawalInput, 'nextStatus'>,
  ): Promise<PartnerWithdrawalInterface> {
    return this.processWithdrawalWithBalanceMutation({
      ...input,
      nextStatus: WithdrawalStatus.REJECTED,
      auditAction: 'partner.withdrawal.rejected',
    });
  }

  /**
   * Creates a new withdrawal request on behalf of a partner (user-initiated).
   * The amount is deducted from the partner's balance immediately (optimistic
   * debit). If the admin later rejects the withdrawal, the balance is restored.
   *
   * Donor: `partner_withdrawals.request_withdrawal` + `create_withdrawal_request`.
   *
   * The debit is RELATIVE and every condition it depends on rides in the
   * `where` of that same statement: `isActive` and `balance >= amount`. The
   * sufficiency guard used to be `if (partner.balance < input.amount)`
   * evaluated in JS against a `findUnique` taken a few lines earlier in this
   * same transaction. A relative write cannot LOSE an update, but it also
   * cannot REFUSE one: under the default READ COMMITTED isolation two requests
   * both read 10 000, both passed the JS check, and Postgres applied both
   * decrements in lock order, leaving the partner at -10 000 with two PENDING
   * withdrawals against money that was only ever there once. The predicate now
   * travels with the write, so Postgres evaluates it against the row it locks
   * rather than against a number this process read a moment earlier, and
   * `count === 0` IS the refusal. Same shape as {@link applyBalanceAdjustment}
   * and as `spendPoints` in `referral-points-exchange.service.ts`.
   *
   * It is `gte`, not `gt`: a request for exactly the whole balance still
   * matches the row and lands it on zero, the same boundary the replaced
   * `balance < amount` had. `amount` is already known positive here, so the
   * floor can never be a value a healthy row fails by accident.
   *
   * ORDER MATTERS. The guarded debit runs BEFORE `partnerWithdrawal.create`,
   * never after. A withdrawal row is a claim on money that has already left
   * the balance — approving one later increments `totalWithdrawn` as if it had
   * been paid — so a row that outlives a refused debit is a payout owed
   * against money never taken. Creating first and letting the throw roll it
   * back would make that invariant depend on the rollback actually happening;
   * debiting first makes it structural, because the refusal returns before
   * anything has been created. Nothing is read from the partner row on the
   * path that succeeds: the create needs only `input.partnerId`, which the
   * caller already supplied.
   *
   * The three refusals are told apart only when the write matched nothing, and
   * in the order the JS checks used to run, so callers see exactly the
   * messages and exception types they always did.
   */
  public async createWithdrawalRequest(input: {
    readonly partnerId: string;
    readonly amount: number;
    readonly method: string;
    readonly requisites: string;
  }): Promise<PartnerWithdrawalInterface> {
    if (input.amount <= 0) {
      throw new BadRequestException('Withdrawal amount must be positive');
    }
    const result = await this.prismaService.$transaction(async (tx) => {
      // Deduct balance immediately (altshop pattern), conditionally: the
      // active flag and the sufficiency floor are the `where` of this very
      // statement, so no read-then-check window exists.
      const debited = await tx.partner.updateMany({
        where: {
          id: input.partnerId,
          isActive: true,
          balance: { gte: input.amount },
        },
        data: { balance: { decrement: input.amount } },
      });
      if (debited.count === 0) {
        // Zero rows is "no such partner", "not active" or "not enough", and
        // the count cannot say which. Only this branch pays for telling them
        // apart; the path that succeeds never reads the partner row.
        const existing = await tx.partner.findUnique({
          where: { id: input.partnerId },
          select: { id: true, isActive: true },
        });
        if (existing === null) {
          throw new NotFoundException('Partner not found');
        }
        if (!existing.isActive) {
          throw new BadRequestException('Partner is not active');
        }
        throw new BadRequestException('Insufficient partner balance');
      }
      const withdrawal = await tx.partnerWithdrawal.create({
        data: {
          partnerId: input.partnerId,
          amount: input.amount,
          status: WithdrawalStatus.PENDING,
          method: input.method,
          requisites: input.requisites,
        },
        include: WITHDRAWAL_PARTNER_INCLUDE,
      });
      return mapPartnerWithdrawal(withdrawal);
    });
    this.events.info(
      EVENT_TYPES.PARTNER_WITHDRAWAL_REQUESTED,
      'PARTNER',
      `Partner requested ${input.amount} withdrawal`,
      {
        withdrawalId: result.id,
        partnerId: input.partnerId,
        amount: input.amount,
        method: input.method,
      },
    );
    return result;
  }

  /**
   * Toggles a partner's active status, addressed by partner id — the Partners
   * tab (`POST /admin/partners/:partnerId/toggle`).
   * Donor: `partner_core.toggle_partner_status`.
   *
   * Activation has no referral-graph side-effect; see `applyActiveTransition`.
   */
  public async togglePartnerStatus(partnerId: string): Promise<PartnerInterface> {
    return mapPartner(await this.applyActiveTransition(partnerId));
  }

  /**
   * The same transition addressed by user id — the user-detail panel
   * (`POST /admin/users/:telegramId/partner/toggle`).
   *
   * Returns the bare `Partner` row rather than a `PartnerInterface` because
   * that is the response shape that endpoint has always had and the SPA is
   * pinned to it. The row is stripped rather than re-read so that both
   * surfaces still issue exactly one update.
   */
  public async togglePartnerStatusForUser(userId: string): Promise<Partner> {
    const partner = await this.prismaService.partner.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (partner === null) {
      throw new NotFoundException('Partner not found');
    }
    return stripPartnerRelations(await this.applyActiveTransition(partner.id));
  }

  /**
   * Creates a partner for `userId`, active from birth — the user-detail panel
   * (`POST /admin/users/:telegramId/create-partner`). There is no Partners-tab
   * equivalent; this is the only surface that mints a partner.
   *
   * A partner born active IS an activation, so this emits `PARTNER_ACTIVATED`
   * with the same payload `applyActiveTransition` emits, on top of
   * `PARTNER_CREATED`. Without it, "when did this partner start earning?" had
   * two different answers depending on which screen the operator used.
   */
  public async createPartnerForUser(input: {
    readonly userId: string;
    readonly telegramId: string;
  }): Promise<Partner> {
    const existing = await this.prismaService.partner.findUnique({
      where: { userId: input.userId },
      select: { id: true },
    });
    if (existing !== null) {
      throw new BadRequestException('Partner already exists for this user');
    }
    const partner = await this.prismaService.partner.create({
      data: { userId: input.userId, isActive: true },
    });
    this.events.info(
      EVENT_TYPES.PARTNER_CREATED,
      'PARTNER',
      `Partner created for user ${input.telegramId}`,
      { userId: input.userId, partnerId: partner.id, telegramId: input.telegramId },
    );
    this.emitPartnerActivated(partner.id, input.userId);
    return partner;
  }

  /**
   * The single implementation of "an operator flipped a partner's active
   * flag". Both surfaces that can do it go through here, so the audit trail
   * cannot depend on which screen the operator happened to use — they used to
   * disagree, and only the Partners tab left any trace at all.
   *
   * Activation deliberately does NOT touch the referral graph. Partner
   * earnings count only from the moment of activation, so people the partner
   * invited BEFORE that must never acquire a `PartnerReferral` edge — not
   * retroactively, and not on their future payments either. A retroactive
   * backfill used to run here and was removed for exactly that reason;
   * re-adding any edge-building step here silently reopens it.
   *
   * Edges backfilled before the rule changed are left alone: they are paying
   * today and they also feed `INVITED`-scoped trial eligibility, so
   * going-forward behaviour and the historical data differ by design.
   */
  private async applyActiveTransition(partnerId: string): Promise<PartnerRecord> {
    const partner = await this.prismaService.partner.findUnique({
      where: { id: partnerId },
      include: PARTNER_INCLUDE,
    });
    if (partner === null) {
      throw new NotFoundException('Partner not found');
    }
    const nextActive = !partner.isActive;
    const updated = await this.prismaService.partner.update({
      where: { id: partnerId },
      data: { isActive: nextActive },
      include: PARTNER_INCLUDE,
    });

    if (nextActive) {
      this.emitPartnerActivated(updated.id, updated.userId);
    } else {
      this.events.info(EVENT_TYPES.PARTNER_DEACTIVATED, 'PARTNER', 'Partner deactivated', {
        partnerId: updated.id,
        userId: updated.userId,
      });
    }

    return updated;
  }

  private emitPartnerActivated(partnerId: string, userId: string): void {
    this.events.info(EVENT_TYPES.PARTNER_ACTIVATED, 'PARTNER', 'Partner activated', {
      partnerId,
      userId,
    });
  }

  /**
   * Adjusts a partner's balance by a signed amount (positive = credit,
   * negative = debit), addressed by partner id — the Partners tab
   * (`POST /admin/partners/:partnerId/adjust-balance`).
   * Donor: `partner_core.adjust_partner_balance`.
   */
  public async adjustBalance(input: {
    readonly partnerId: string;
    readonly amount: number;
    readonly reason: string | null;
    readonly currentAdmin: CurrentAdminInterface;
    readonly requestMetadata: RequestMetadataInterface;
  }): Promise<PartnerInterface> {
    return mapPartner(
      await this.applyBalanceAdjustment({ ...input, source: 'partners_tab' }),
    );
  }

  /**
   * The same adjustment addressed by user id — the user-detail panel
   * (`POST /admin/users/:telegramId/partner/adjust-balance`).
   *
   * Returns the bare `Partner` row rather than a `PartnerInterface`, for the
   * same reason `togglePartnerStatusForUser` does: that is the response shape
   * the endpoint has always had and the SPA is pinned to it. The row is
   * stripped rather than re-read so that both surfaces still issue exactly
   * one update.
   */
  public async adjustBalanceForUser(input: {
    readonly userId: string;
    readonly amount: number;
    readonly reason: string | null;
    readonly currentAdmin: CurrentAdminInterface;
    readonly requestMetadata: RequestMetadataInterface;
  }): Promise<Partner> {
    const partner = await this.prismaService.partner.findUnique({
      where: { userId: input.userId },
      select: { id: true },
    });
    if (partner === null) {
      throw new NotFoundException('Partner not found');
    }
    return stripPartnerRelations(
      await this.applyBalanceAdjustment({
        partnerId: partner.id,
        amount: input.amount,
        reason: input.reason,
        currentAdmin: input.currentAdmin,
        requestMetadata: input.requestMetadata,
        source: 'user_detail',
      }),
    );
  }

  /**
   * The single implementation of "an operator moved a partner's balance".
   * Both surfaces that can do it go through here, so the trail cannot depend
   * on which screen was used — they used to disagree, and the user-detail
   * copy recorded no amounts and emitted no system event at all.
   *
   * Read, write and audit row share ONE transaction. The user-detail copy did
   * its read-then-update outside any transaction, so a failure between the
   * balance write and the audit write moved money and left no trace of it.
   *
   * The balance write is RELATIVE and its below-zero floor rides in the
   * `where` of that same statement: `balance >= -amount` is "the resulting
   * balance must not be negative" rearranged so the only column left in it is
   * the one the database is already locking. Postgres evaluates it against
   * the row it locks rather than against a number this process read a moment
   * earlier, so `count === 0` IS the refusal and no read-then-check window
   * exists. This used to be an absolute `balance: newBalance` computed from
   * an earlier read, which under the default READ COMMITTED isolation lost
   * updates between two concurrent adjustments — both read 100, one wrote
   * 150, the other re-evaluated its `WHERE` and overwrote with 50. The
   * enclosing transaction never prevented that; it makes the write
   * all-or-nothing, not serialisable. Same shape as `spendPoints` in
   * `referral-points-exchange.service.ts`.
   *
   * The floor cannot block a credit: for a positive `amount` the predicate is
   * `balance >= -amount`, a negative floor that every non-negative balance
   * clears. It is `gte`, not `gt`, so an adjustment landing exactly on zero
   * still passes — the same boundary the replaced `newBalance < 0` had.
   *
   * `previousBalance`/`newBalance` are taken AFTER the write. The update holds
   * the row lock until this transaction commits, so nothing else can move the
   * balance in between: the row read back is this adjustment's own result and
   * `newBalance - amount` is by construction the value the increment started
   * from. Reading beforehand would put the stale number back into the audit
   * row after taking it out of the arithmetic.
   */
  private async applyBalanceAdjustment(input: {
    readonly partnerId: string;
    readonly amount: number;
    readonly reason: string | null;
    readonly currentAdmin: CurrentAdminInterface;
    readonly requestMetadata: RequestMetadataInterface;
    readonly source: PartnerBalanceAdjustmentSource;
  }): Promise<PartnerRecord> {
    const result = await this.prismaService.$transaction(async (tx) => {
      const written = await tx.partner.updateMany({
        where: { id: input.partnerId, balance: { gte: -input.amount } },
        data: { balance: { increment: input.amount } },
      });
      if (written.count === 0) {
        // Zero rows is either "no such partner" or "the floor refused it".
        // Only this branch pays for telling the two apart; the path that
        // succeeds never reads the balance before writing it.
        const existing = await tx.partner.findUnique({
          where: { id: input.partnerId },
          select: { id: true },
        });
        if (existing === null) {
          throw new NotFoundException('Partner not found');
        }
        throw new BadRequestException(
          'Resulting balance would be negative',
        );
      }
      const updated = await tx.partner.findUnique({
        where: { id: input.partnerId },
        include: PARTNER_INCLUDE,
      });
      if (updated === null) {
        // Unreachable: this transaction holds the lock on the row it has just
        // written. Kept so the type stays honest without a non-null assertion.
        throw new NotFoundException('Partner not found');
      }
      const newBalance = updated.balance;
      const previousBalance = newBalance - input.amount;
      await tx.adminAuditLog.create({
        data: {
          action: PARTNER_BALANCE_ADJUSTED_ACTION,
          ipAddress: input.requestMetadata.remoteAddress,
          userAgent: input.requestMetadata.userAgent,
          metadata: {
            requestId: input.requestMetadata.requestId,
            partnerId: updated.id,
            source: input.source,
            adjustment: input.amount,
            previousBalance,
            newBalance,
            reason: input.reason,
          } as Prisma.InputJsonObject,
          adminUser: { connect: { id: input.currentAdmin.id } },
        },
      });
      return { record: updated, previousBalance, newBalance };
    });
    // Deliberately carries no `source`: the system event states the same fact
    // whichever screen produced it, and the activation surfaces already pin
    // their two events as identical.
    this.events.info(
      EVENT_TYPES.PARTNER_BALANCE_ADJUSTED,
      'PARTNER',
      `Partner balance adjusted by ${input.amount}`,
      {
        partnerId: input.partnerId,
        adjustment: input.amount,
        previousBalance: result.previousBalance,
        newBalance: result.newBalance,
        adminId: input.currentAdmin.id,
        reason: input.reason,
      },
    );
    return result.record;
  }

  /**
   * The single implementation of "an operator resolved a pending withdrawal" —
   * {@link approveWithdrawal} (`PENDING -> COMPLETED`) and
   * {@link rejectWithdrawal} (`PENDING -> REJECTED`) differ only in
   * `nextStatus`, the audit action and which money write runs.
   *
   * The STATUS TRANSITION is the guard, and it is one statement: the from-state
   * `PENDING` rides in the `where` of the update that writes the to-state, so
   * exactly one caller can move a given withdrawal out of `PENDING` and
   * `count === 0` means somebody else already did. This used to be a
   * `findUnique` followed by `if (withdrawal.status !== PENDING)` in JS, with
   * the new status written at the END of the transaction. Two approvals of one
   * withdrawal both read `PENDING`, both passed, and both incremented
   * `totalWithdrawn` — one payout counted twice in every figure derived from
   * it. Two rejections were worse: both credited `balance`, minting an amount
   * that was only ever debited once. {@link bulkApproveWithdrawals} makes the
   * collision ordinary rather than theoretical — a long batch invites the
   * second click.
   *
   * ORDER MATTERS. The transition runs BEFORE either money write, so the claim
   * is staked before anything is paid: a transaction that loses the race
   * refuses without having moved money, rather than relying on the rollback to
   * take it back. `amount` and `partnerId` are then read back from the row
   * this transaction has just written and still holds the lock on, so the
   * figures the money writes and the audit row use are this transition's own
   * result — the same reasoning as the post-write read-back in
   * {@link applyBalanceAdjustment}.
   *
   * Both money writes are relative increments and need no floor of their own:
   * `totalWithdrawn` only grows, and the rejection credit returns money that
   * this same row's creation debited. What made them unsafe was never the
   * arithmetic — it was being reachable twice.
   *
   * An absent `adminComment` is expressed by OMITTING the key, which leaves the
   * column untouched; that is what `?? withdrawal.adminComment` used to say,
   * without needing a read to say it.
   */
  private async processWithdrawalWithBalanceMutation(
    input: ProcessPartnerWithdrawalInput & { readonly auditAction: string },
  ): Promise<PartnerWithdrawalInterface> {
    const result = await this.prismaService.$transaction(async (transactionClient) => {
      const transitioned = await transactionClient.partnerWithdrawal.updateMany({
        where: {
          id: input.withdrawalId,
          status: WithdrawalStatus.PENDING,
        },
        data: {
          status: input.nextStatus,
          ...(input.dto.adminComment !== undefined
            ? { adminComment: input.dto.adminComment }
            : {}),
          processedBy: input.currentAdmin.id,
          processedAt: new Date(),
        },
      });
      if (transitioned.count === 0) {
        // Zero rows is either "no such withdrawal" or "somebody else already
        // moved it out of PENDING". Only this branch pays for telling the two
        // apart; the path that succeeds never reads the row beforehand.
        const existing = await transactionClient.partnerWithdrawal.findUnique({
          where: { id: input.withdrawalId },
          select: { id: true },
        });
        if (existing === null) {
          throw new NotFoundException('Withdrawal not found');
        }
        throw new BadRequestException(
          'Only pending withdrawals can be processed',
        );
      }
      const updated = await transactionClient.partnerWithdrawal.findUnique({
        where: { id: input.withdrawalId },
        include: WITHDRAWAL_PARTNER_INCLUDE,
      });
      if (updated === null) {
        // Unreachable: this transaction holds the lock on the row it has just
        // transitioned. Kept so the type stays honest without a non-null
        // assertion.
        throw new NotFoundException('Withdrawal not found');
      }
      if (input.nextStatus === WithdrawalStatus.COMPLETED) {
        const partner = await transactionClient.partner.findUnique({
          where: { id: updated.partnerId },
        });
        if (partner === null) {
          throw new NotFoundException('Partner not found');
        }
        // On approve: balance was already deducted at request time.
        // We only increment totalWithdrawn to mark it as paid out.
        await transactionClient.partner.update({
          where: { id: partner.id },
          data: {
            totalWithdrawn: { increment: updated.amount },
          },
        });
      } else if (input.nextStatus === WithdrawalStatus.REJECTED) {
        // On reject: restore the amount that was deducted at request time
        // back to the partner's balance (altshop parity).
        await transactionClient.partner.update({
          where: { id: updated.partnerId },
          data: {
            balance: { increment: updated.amount },
          },
        });
      }
      await transactionClient.adminAuditLog.create({
        data: {
          action: input.auditAction,
          ipAddress: input.requestMetadata.remoteAddress,
          userAgent: input.requestMetadata.userAgent,
          metadata: {
            requestId: input.requestMetadata.requestId,
            withdrawalId: updated.id,
            partnerId: updated.partnerId,
            amount: updated.amount,
          } as Prisma.InputJsonObject,
          adminUser: { connect: { id: input.currentAdmin.id } },
        },
      });
      return mapPartnerWithdrawal(updated);
    });

    // Emit withdrawal event
    const eventType = input.nextStatus === WithdrawalStatus.COMPLETED
      ? EVENT_TYPES.PARTNER_WITHDRAWAL_APPROVED
      : EVENT_TYPES.PARTNER_WITHDRAWAL_REJECTED;
    this.events.info(eventType, 'PARTNER', `Withdrawal ${input.nextStatus.toLowerCase()}`, {
      withdrawalId: result.id,
      partnerId: result.partnerId,
      userId: result.partner?.user?.id ?? null,
      amount: result.amount,
      status: result.status,
      adminId: input.currentAdmin.id,
    });

    // Notify the partner via UserNotificationEvent so the email/Telegram
    // bridge picks it up automatically.
    if (result.partner?.user?.id) {
      if (input.nextStatus === WithdrawalStatus.COMPLETED) {
        await this.partnerNotificationsService.notifyWithdrawalApproved({
          partnerUserId: result.partner.user.id,
          withdrawalId: result.id,
          amount: result.amount,
        });
      } else if (input.nextStatus === WithdrawalStatus.REJECTED) {
        await this.partnerNotificationsService.notifyWithdrawalRejected({
          partnerUserId: result.partner.user.id,
          withdrawalId: result.id,
          amount: result.amount,
          reason: input.dto.adminComment ?? null,
        });
      }
    }

    return result;
  }
}

function mapPartner(record: PartnerRecord): PartnerInterface {
  const totalReferrals = record._count?.referrals ?? 0;
  return {
    id: record.id,
    user: mapPartnerUser(record.user),
    balance: record.balance,
    totalEarned: record.totalEarned,
    totalWithdrawn: record.totalWithdrawn,
    isActive: record.isActive,
    referralsCount: totalReferrals,
    useGlobalSettings: record.useGlobalSettings,
    accrualStrategy: record.accrualStrategy,
    rewardType: record.rewardType,
    level1Percent: decimalToString(record.level1Percent),
    level2Percent: decimalToString(record.level2Percent),
    level3Percent: decimalToString(record.level3Percent),
    level1FixedAmount: record.level1FixedAmount,
    level2FixedAmount: record.level2FixedAmount,
    level3FixedAmount: record.level3FixedAmount,
    level1AccrualStrategy: record.level1AccrualStrategy,
    level2AccrualStrategy: record.level2AccrualStrategy,
    level3AccrualStrategy: record.level3AccrualStrategy,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Drops the relations `PARTNER_INCLUDE` pulls in, leaving the plain `Partner`
 * columns. Used by the user-detail toggle, whose response shape predates
 * `PartnerInterface` and must not grow fields.
 */
function stripPartnerRelations(record: PartnerRecord): Partner {
  const { user: _user, _count: _referralCount, ...partner } = record;
  return partner;
}

function decimalToString(value: { toString(): string } | null): string | null {
  return value === null || value === undefined ? null : value.toString();
}

function mapPartnerUser(
  record: Prisma.UserGetPayload<{ select: typeof PARTNER_USER_SELECT }>,
): PartnerUserSummaryInterface {
  return {
    id: record.id,
    login: null,
    username: record.username,
    name: record.name === '' ? null : record.name,
    telegramId: record.telegramId?.toString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}

function mapPartnerWithdrawal(record: PartnerWithdrawalRecord): PartnerWithdrawalInterface {
  return {
    id: record.id,
    partnerId: record.partnerId,
    amount: record.amount,
    status: record.status,
    method: record.method,
    requisites: record.requisites,
    adminComment: record.adminComment,
    processedBy: record.processedBy,
    processedAt: record.processedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    partner:
      record.partner !== undefined
        ? {
            id: record.partner.id,
            isActive: record.partner.isActive,
            user:
              record.partner.user !== null
                ? {
                    id: record.partner.user.id,
                    name: record.partner.user.name === '' ? null : record.partner.user.name,
                    username: record.partner.user.username,
                    telegramId: record.partner.user.telegramId?.toString() ?? null,
                  }
                : null,
          }
        : null,
  };
}
