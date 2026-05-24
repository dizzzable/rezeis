import { randomBytes } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CreateReferralInviteDto } from '../dto/create-referral-invite.dto';
import {
  ListReferralInvitesQueryDto,
  ListReferralsQueryDto,
} from '../dto/list-referrals-query.dto';
import {
  CreateReferralInviteResultInterface,
  ReferralInterface,
  ReferralInviteInterface,
  ReferralStatsInterface,
  ReferralUserSummaryInterface,
} from '../interfaces/referral.interface';

const REFERRAL_USER_SUMMARY_SELECT = {
  id: true,
  username: true,
  name: true,
  telegramId: true,
  createdAt: true,
} as const;

type UserSummaryRecord = Prisma.UserGetPayload<{
  select: typeof REFERRAL_USER_SUMMARY_SELECT;
}>;

const REFERRAL_INCLUDE = {
  referrer: { select: REFERRAL_USER_SUMMARY_SELECT },
  referred: { select: REFERRAL_USER_SUMMARY_SELECT },
} as const;

type ReferralRecord = Prisma.ReferralGetPayload<{ include: typeof REFERRAL_INCLUDE }>;

const REFERRAL_INVITE_INCLUDE = {
  inviter: { select: REFERRAL_USER_SUMMARY_SELECT },
} as const;

type ReferralInviteRecord = Prisma.ReferralInviteGetPayload<{
  include: typeof REFERRAL_INVITE_INCLUDE;
}>;

const INVITE_TOKEN_BYTES = 18;
const DEFAULT_INVITE_TTL_DAYS = 30;

@Injectable()
export class ReferralsService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async listReferrals(
    query: ListReferralsQueryDto,
  ): Promise<readonly ReferralInterface[]> {
    const where: Prisma.ReferralWhereInput = {
      referrerId: query.referrerId,
      referredId: query.referredId,
    };
    if (query.qualified === 'true') {
      where.qualifiedAt = { not: null };
    }
    if (query.qualified === 'false') {
      where.qualifiedAt = null;
    }
    const referrals = await this.prismaService.referral.findMany({
      where,
      include: REFERRAL_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit ?? 100,
      skip: query.offset ?? 0,
    });
    return referrals.map(mapReferral);
  }

  public async listInvites(
    query: ListReferralInvitesQueryDto,
  ): Promise<readonly ReferralInviteInterface[]> {
    const where: Prisma.ReferralInviteWhereInput = {
      inviterId: query.inviterId,
    };
    if (query.consumed === 'true') {
      where.consumedAt = { not: null };
    }
    if (query.consumed === 'false') {
      where.consumedAt = null;
    }
    if (query.revoked === 'true') {
      where.revokedAt = { not: null };
    }
    if (query.revoked === 'false') {
      where.revokedAt = null;
    }
    const invites = await this.prismaService.referralInvite.findMany({
      where,
      include: REFERRAL_INVITE_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit ?? 100,
      skip: query.offset ?? 0,
    });
    return invites.map(mapReferralInvite);
  }

  public async createInvite(
    input: CreateReferralInviteDto,
  ): Promise<CreateReferralInviteResultInterface> {
    const inviter = await this.prismaService.user.findUnique({
      where: { id: input.inviterId },
      select: { id: true },
    });
    if (inviter === null) {
      throw new NotFoundException('Inviter user not found');
    }
    const expiresAt = resolveInviteExpiry(input);
    const token = createInviteToken();
    const created = await this.prismaService.referralInvite.create({
      data: {
        inviterId: input.inviterId,
        token,
        note: input.note ?? null,
        expiresAt,
      },
      include: REFERRAL_INVITE_INCLUDE,
    });
    return { invite: mapReferralInvite(created) };
  }

  public async revokeInvite(inviteId: string): Promise<ReferralInviteInterface> {
    const existing = await this.prismaService.referralInvite.findUnique({
      where: { id: inviteId },
      select: { id: true, revokedAt: true, consumedAt: true },
    });
    if (existing === null) {
      throw new NotFoundException('Referral invite not found');
    }
    const now = new Date();
    const updated = await this.prismaService.referralInvite.update({
      where: { id: inviteId },
      data: {
        revokedAt: existing.revokedAt ?? now,
      },
      include: REFERRAL_INVITE_INCLUDE,
    });
    return mapReferralInvite(updated);
  }

  public async getStats(): Promise<ReferralStatsInterface> {
    const now = new Date();
    const [totalReferrals, qualifiedReferrals, activeInvites, consumedInvites] =
      await Promise.all([
        this.prismaService.referral.count(),
        this.prismaService.referral.count({
          where: { qualifiedAt: { not: null } },
        }),
        this.prismaService.referralInvite.count({
          where: {
            revokedAt: null,
            consumedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
        }),
        this.prismaService.referralInvite.count({
          where: { consumedAt: { not: null } },
        }),
      ]);
    return {
      totalReferrals,
      qualifiedReferrals,
      activeInvites,
      consumedInvites,
      generatedAt: now.toISOString(),
    };
  }
}

function resolveInviteExpiry(input: CreateReferralInviteDto): Date | null {
  if (input.expiresAt !== undefined) {
    return new Date(input.expiresAt);
  }
  if (input.expiresInDays !== undefined) {
    return addDays(new Date(), input.expiresInDays);
  }
  return addDays(new Date(), DEFAULT_INVITE_TTL_DAYS);
}

function addDays(reference: Date, days: number): Date {
  const result = new Date(reference);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function createInviteToken(): string {
  return randomBytes(INVITE_TOKEN_BYTES).toString('base64url');
}

function mapReferral(record: ReferralRecord): ReferralInterface {
  return {
    id: record.id,
    referrer: mapUserSummary(record.referrer),
    referred: mapUserSummary(record.referred),
    qualifiedAt: record.qualifiedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}

function mapReferralInvite(record: ReferralInviteRecord): ReferralInviteInterface {
  return {
    id: record.id,
    token: record.token,
    inviter: mapUserSummary(record.inviter),
    note: record.note,
    expiresAt: record.expiresAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    consumedAt: record.consumedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}

function mapUserSummary(record: UserSummaryRecord): ReferralUserSummaryInterface {
  return {
    id: record.id,
    username: record.username,
    name: record.name === '' ? null : record.name,
    telegramId: record.telegramId?.toString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}
