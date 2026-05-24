import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, WithdrawalStatus } from '@prisma/client';

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
import { PartnerEarningsService } from './partner-earnings.service';
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
    private readonly partnerEarningsService: PartnerEarningsService,
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
      const partner = await tx.partner.findUnique({
        where: { id: input.partnerId },
      });
      if (partner === null) {
        throw new NotFoundException('Partner not found');
      }
      if (!partner.isActive) {
        throw new BadRequestException('Partner is not active');
      }
      if (partner.balance < input.amount) {
        throw new BadRequestException('Insufficient partner balance');
      }
      // Deduct balance immediately (altshop pattern)
      await tx.partner.update({
        where: { id: partner.id },
        data: { balance: { decrement: input.amount } },
      });
      const withdrawal = await tx.partnerWithdrawal.create({
        data: {
          partnerId: partner.id,
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
   * Toggles a partner's active status. Donor: `partner_core.toggle_partner_status`.
   *
   * Side-effect on `false → true`: retroactively builds the
   * `PartnerReferral` chain from the partner's existing `Referral` graph,
   * so users who were registered before activation also flow earnings
   * back through this partner.
   */
  public async togglePartnerStatus(partnerId: string): Promise<PartnerInterface> {
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

    if (nextActive && !partner.isActive) {
      try {
        const result = await this.partnerEarningsService.backfillPartnerReferralChainForUser(
          updated.userId,
        );
        this.events.info(
          EVENT_TYPES.PARTNER_ACTIVATED,
          'PARTNER',
          result.attached > 0
            ? `Partner activated; backfilled ${result.attached} referral edge(s) (considered ${result.considered})`
            : 'Partner activated',
          {
            partnerId: updated.id,
            userId: updated.userId,
            attached: result.attached,
            considered: result.considered,
          },
        );
      } catch (error: unknown) {
        // Swallow — toggle itself succeeded, backfill is opportunistic.
        this.events.warn(
          EVENT_TYPES.PARTNER_ACTIVATED,
          'PARTNER',
          `Partner activated; referral backfill failed`,
          {
            partnerId: updated.id,
            userId: updated.userId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    } else if (!nextActive && partner.isActive) {
      this.events.info(EVENT_TYPES.PARTNER_DEACTIVATED, 'PARTNER', 'Partner deactivated', {
        partnerId: updated.id,
        userId: updated.userId,
      });
    }

    return mapPartner(updated);
  }

  /**
   * Adjusts a partner's balance by a signed amount (positive = credit,
   * negative = debit). Used by admins for manual corrections.
   * Donor: `partner_core.adjust_partner_balance`.
   */
  public async adjustBalance(input: {
    readonly partnerId: string;
    readonly amount: number;
    readonly reason: string | null;
    readonly currentAdmin: CurrentAdminInterface;
    readonly requestMetadata: RequestMetadataInterface;
  }): Promise<PartnerInterface> {
    const result = await this.prismaService.$transaction(async (tx) => {
      const partner = await tx.partner.findUnique({
        where: { id: input.partnerId },
        include: PARTNER_INCLUDE,
      });
      if (partner === null) {
        throw new NotFoundException('Partner not found');
      }
      const newBalance = partner.balance + input.amount;
      if (newBalance < 0) {
        throw new BadRequestException(
          'Resulting balance would be negative',
        );
      }
      const updated = await tx.partner.update({
        where: { id: partner.id },
        data: { balance: newBalance },
        include: PARTNER_INCLUDE,
      });
      await tx.adminAuditLog.create({
        data: {
          action: 'partner.balance.adjusted',
          ipAddress: input.requestMetadata.remoteAddress,
          userAgent: input.requestMetadata.userAgent,
          metadata: {
            requestId: input.requestMetadata.requestId,
            partnerId: partner.id,
            adjustment: input.amount,
            previousBalance: partner.balance,
            newBalance,
            reason: input.reason,
          } as Prisma.InputJsonObject,
          adminUser: { connect: { id: input.currentAdmin.id } },
        },
      });
      return { partnerSummary: mapPartner(updated), previousBalance: partner.balance, newBalance };
    });
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
    return result.partnerSummary;
  }

  private async processWithdrawalWithBalanceMutation(
    input: ProcessPartnerWithdrawalInput & { readonly auditAction: string },
  ): Promise<PartnerWithdrawalInterface> {
    const result = await this.prismaService.$transaction(async (transactionClient) => {
      const withdrawal = await transactionClient.partnerWithdrawal.findUnique({
        where: { id: input.withdrawalId },
      });
      if (withdrawal === null) {
        throw new NotFoundException('Withdrawal not found');
      }
      if (withdrawal.status !== WithdrawalStatus.PENDING) {
        throw new BadRequestException(
          'Only pending withdrawals can be processed',
        );
      }
      if (input.nextStatus === WithdrawalStatus.COMPLETED) {
        const partner = await transactionClient.partner.findUnique({
          where: { id: withdrawal.partnerId },
        });
        if (partner === null) {
          throw new NotFoundException('Partner not found');
        }
        // On approve: balance was already deducted at request time.
        // We only increment totalWithdrawn to mark it as paid out.
        await transactionClient.partner.update({
          where: { id: partner.id },
          data: {
            totalWithdrawn: { increment: withdrawal.amount },
          },
        });
      } else if (input.nextStatus === WithdrawalStatus.REJECTED) {
        // On reject: restore the amount that was deducted at request time
        // back to the partner's balance (altshop parity).
        await transactionClient.partner.update({
          where: { id: withdrawal.partnerId },
          data: {
            balance: { increment: withdrawal.amount },
          },
        });
      }
      const updated = await transactionClient.partnerWithdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: input.nextStatus,
          adminComment: input.dto.adminComment ?? withdrawal.adminComment,
          processedBy: input.currentAdmin.id,
          processedAt: new Date(),
        },
        include: WITHDRAWAL_PARTNER_INCLUDE,
      });
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
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
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
