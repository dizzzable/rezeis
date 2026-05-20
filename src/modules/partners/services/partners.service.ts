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

const PARTNER_USER_SELECT = {
  id: true,
  name: true,
  telegramId: true,
  createdAt: true,
} as const;

const PARTNER_INCLUDE = {
  user: { select: PARTNER_USER_SELECT },
} as const;

type PartnerRecord = Prisma.PartnerGetPayload<{ include: typeof PARTNER_INCLUDE }>;
type PartnerWithdrawalRecord = Prisma.PartnerWithdrawalGetPayload<true>;

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
    const partners = await this.prismaService.partner.findMany({
      where,
      include: PARTNER_INCLUDE,
      orderBy: [{ totalEarned: 'desc' }, { createdAt: 'desc' }],
      take: query.limit ?? 100,
      skip: query.offset ?? 0,
    });
    return partners.map(mapPartner);
  }

  public async listWithdrawals(
    query: ListPartnerWithdrawalsQueryDto,
  ): Promise<readonly PartnerWithdrawalInterface[]> {
    const withdrawals = await this.prismaService.partnerWithdrawal.findMany({
      where: {
        partnerId: query.partnerId,
        status: query.status,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit ?? 100,
      skip: query.offset ?? 0,
    });
    return withdrawals.map(mapPartnerWithdrawal);
  }

  public async getStats(): Promise<PartnerStatsInterface> {
    const now = new Date();
    const [
      totalPartners,
      activePartners,
      pendingWithdrawals,
      completedWithdrawals,
      balanceAggregate,
    ] = await Promise.all([
      this.prismaService.partner.count(),
      this.prismaService.partner.count({ where: { isActive: true } }),
      this.prismaService.partnerWithdrawal.count({
        where: { status: WithdrawalStatus.PENDING },
      }),
      this.prismaService.partnerWithdrawal.count({
        where: { status: WithdrawalStatus.COMPLETED },
      }),
      this.prismaService.partner.aggregate({
        _sum: { balance: true },
      }),
    ]);
    return {
      totalPartners,
      activePartners,
      pendingWithdrawals,
      completedWithdrawals,
      totalBalance: balanceAggregate._sum.balance ?? 0,
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
    return this.prismaService.$transaction(async (tx) => {
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
      });
      return mapPartnerWithdrawal(withdrawal);
    });
  }

  /**
   * Toggles a partner's active status. Donor: `partner_core.toggle_partner_status`.
   */
  public async togglePartnerStatus(partnerId: string): Promise<PartnerInterface> {
    const partner = await this.prismaService.partner.findUnique({
      where: { id: partnerId },
      include: PARTNER_INCLUDE,
    });
    if (partner === null) {
      throw new NotFoundException('Partner not found');
    }
    const updated = await this.prismaService.partner.update({
      where: { id: partnerId },
      data: { isActive: !partner.isActive },
      include: PARTNER_INCLUDE,
    });
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
    return this.prismaService.$transaction(async (tx) => {
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
      return mapPartner(updated);
    });
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
      amount: result.amount,
      status: result.status,
      adminId: input.currentAdmin.id,
    });

    return result;
  }
}

function mapPartner(record: PartnerRecord): PartnerInterface {
  return {
    id: record.id,
    user: mapPartnerUser(record.user),
    balance: record.balance,
    totalEarned: record.totalEarned,
    totalWithdrawn: record.totalWithdrawn,
    isActive: record.isActive,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function mapPartnerUser(
  record: Prisma.UserGetPayload<{ select: typeof PARTNER_USER_SELECT }>,
): PartnerUserSummaryInterface {
  return {
    id: record.id,
    login: null,
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
  };
}
