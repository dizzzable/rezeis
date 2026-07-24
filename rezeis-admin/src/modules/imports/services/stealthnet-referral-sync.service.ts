import { Injectable } from '@nestjs/common';
import { ImportStatus, ReferralInviteSource, ReferralRewardType } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  StealthnetClient,
  StealthnetPayment,
  StealthnetReferralCredit,
} from '../utils/stealthnet-backup-parser';

export type StealthnetReferralSyncStatus =
  | 'CREATED'
  | 'ALREADY_EXISTS'
  | 'CONFLICTING_REFERRAL'
  | 'PARTNER_ATTRIBUTION'
  | 'SELF_REFERRAL'
  | 'SOURCE_NOT_FOUND';

export interface StealthnetReferralMapping {
  readonly referredSourceId: string;
  readonly referrerSourceId: string;
  readonly referredUserId: string | null;
  readonly referrerUserId: string | null;
  readonly status: Exclude<StealthnetReferralSyncStatus, 'SOURCE_NOT_FOUND'>;
}

export interface StealthnetReferralImportResult {
  readonly mappings: readonly StealthnetReferralMapping[];
  readonly created: number;
  readonly existing: number;
  readonly skipped: number;
  readonly creditsCreated: number;
  readonly creditsExisting: number;
  readonly creditsSkipped: number;
}

export interface StealthnetReferralUserSyncResult {
  readonly importRecordId: string | null;
  readonly status: StealthnetReferralSyncStatus;
  readonly referrerUserId: string | null;
}

/**
 * Rebuilds STEALTHNET referral attribution without replaying payments.
 *
 * Importing an edge must never invoke the ordinary manual-attach flow: that
 * flow deliberately replays completed payments and can issue current reward
 * rules for old purchases. Historical STEALTHNET credits are imported below as
 * already-issued audit entries, while user balances are transferred separately.
 */
@Injectable()
export class StealthnetReferralSyncService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async syncImport(input: {
    readonly clients: readonly StealthnetClient[];
    readonly payments: readonly StealthnetPayment[];
    readonly referralCredits: readonly StealthnetReferralCredit[];
    readonly sourceUserIds: ReadonlyMap<string, string>;
  }): Promise<StealthnetReferralImportResult> {
    const clientsById = new Map(input.clients.map((client) => [client.id, client]));
    const paymentsById = new Map(input.payments.map((payment) => [payment.id, payment]));
    const mappings: StealthnetReferralMapping[] = [];
    let created = 0;
    let existing = 0;
    let skipped = 0;

    for (const client of input.clients) {
      if (client.referrer_id === null) continue;
      const referredUserId = input.sourceUserIds.get(client.id) ?? null;
      const referrerUserId = input.sourceUserIds.get(client.referrer_id) ?? null;
      const status = await this.attachEdge({
        referredUserId,
        referrerUserId,
        createdAt: parseOptionalDate(client.created_at),
      });
      mappings.push({
        referredSourceId: client.id,
        referrerSourceId: client.referrer_id,
        referredUserId,
        referrerUserId,
        status,
      });
      if (status === 'CREATED') created += 1;
      else if (status === 'ALREADY_EXISTS') existing += 1;
      else skipped += 1;
    }

    let creditsCreated = 0;
    let creditsExisting = 0;
    let creditsSkipped = 0;
    for (const credit of input.referralCredits) {
      const imported = await this.importHistoricalCredit({
        credit,
        clientsById,
        paymentsById,
        sourceUserIds: input.sourceUserIds,
      });
      if (imported === 'CREATED') creditsCreated += 1;
      else if (imported === 'EXISTS') creditsExisting += 1;
      else creditsSkipped += 1;
    }

    return {
      mappings,
      created,
      existing,
      skipped,
      creditsCreated,
      creditsExisting,
      creditsSkipped,
    };
  }

  /**
   * Retries one stored source edge from a completed STEALTHNET import. It is
   * intentionally narrow: a card action can repair a missed edge, but cannot
   * overwrite a referral or partner attribution that an operator created later.
   */
  public async syncForUser(userId: string): Promise<StealthnetReferralUserSyncResult> {
    const records = await this.prismaService.importRecord.findMany({
      // Import side effects are deliberately retained for review even when an
      // unrelated row makes the overall import fail. A stored source mapping
      // from such a run is still safe to repair: attachEdge applies the same
      // conflict and partner-attribution protections as a committed import.
      where: {
        sourceType: 'stealthnet',
        status: { in: [ImportStatus.COMMITTED, ImportStatus.FAILED] },
      },
      orderBy: [{ committedAt: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, result: true },
    });

    for (const record of records) {
      const mapping = readMappings(record.result).find(
        (candidate) => candidate.referredUserId === userId && candidate.referrerUserId !== null,
      );
      if (!mapping || mapping.referrerUserId === null) continue;
      const status = await this.attachEdge({
        referredUserId: mapping.referredUserId,
        referrerUserId: mapping.referrerUserId,
        createdAt: null,
      });
      return { importRecordId: record.id, status, referrerUserId: mapping.referrerUserId };
    }

    return { importRecordId: null, status: 'SOURCE_NOT_FOUND', referrerUserId: null };
  }

  private async attachEdge(input: {
    readonly referredUserId: string | null;
    readonly referrerUserId: string | null;
    readonly createdAt: Date | null;
  }): Promise<Exclude<StealthnetReferralSyncStatus, 'SOURCE_NOT_FOUND'>> {
    if (input.referredUserId === null || input.referrerUserId === null) {
      return 'CONFLICTING_REFERRAL';
    }
    if (input.referredUserId === input.referrerUserId) return 'SELF_REFERRAL';

    const existing = await this.prismaService.referral.findUnique({
      where: { referredId: input.referredUserId },
      select: { referrerId: true },
    });
    if (existing !== null) {
      return existing.referrerId === input.referrerUserId
        ? 'ALREADY_EXISTS'
        : 'CONFLICTING_REFERRAL';
    }

    const partnerAttribution = await this.prismaService.partnerReferral.findFirst({
      where: { referralUserId: input.referredUserId },
      select: { id: true },
    });
    if (partnerAttribution !== null) return 'PARTNER_ATTRIBUTION';

    try {
      await this.prismaService.referral.create({
        data: {
          referredId: input.referredUserId,
          referrerId: input.referrerUserId,
          level: 1,
          inviteSource: ReferralInviteSource.UNKNOWN,
          ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        },
      });
      return 'CREATED';
    } catch (error: unknown) {
      // The unique referred_id constraint protects concurrent import/card
      // retries. A concurrent winner is an idempotent replay, not a failure.
      if (isUniqueConstraintError(error)) return 'ALREADY_EXISTS';
      throw error;
    }
  }

  private async importHistoricalCredit(input: {
    readonly credit: StealthnetReferralCredit;
    readonly clientsById: ReadonlyMap<string, StealthnetClient>;
    readonly paymentsById: ReadonlyMap<string, StealthnetPayment>;
    readonly sourceUserIds: ReadonlyMap<string, string>;
  }): Promise<'CREATED' | 'EXISTS' | 'SKIPPED'> {
    if (input.credit.amount <= 0) return 'SKIPPED';
    const sourceKey = `stealthnet:${input.credit.id}`;
    const alreadyImported = await this.prismaService.referralReward.findUnique({
      where: { sourceKey },
      select: { id: true },
    });
    if (alreadyImported !== null) return 'EXISTS';

    const payment = input.paymentsById.get(input.credit.payment_id);
    const localReferrerId = input.sourceUserIds.get(input.credit.referrer_id);
    if (!payment || !localReferrerId) return 'SKIPPED';

    const rewardEdge = await this.resolveRewardEdge({
      payment,
      credit: input.credit,
      clientsById: input.clientsById,
      sourceUserIds: input.sourceUserIds,
    });
    if (rewardEdge === null || rewardEdge.referrerId !== localReferrerId) return 'SKIPPED';

    const creditedAt = parseOptionalDate(input.credit.created_at) ?? new Date();
    // A level-one STEALTHNET credit proves that the directly referred user
    // already qualified. Preserve that fact so the admin cannot later apply
    // current reward rules to the same historical conversion.
    if (input.credit.level === 1) {
      await this.prismaService.referral.updateMany({
        where: { id: rewardEdge.id, qualifiedAt: null },
        data: { qualifiedAt: creditedAt },
      });
    }

    try {
      await this.prismaService.referralReward.create({
        data: {
          referralId: rewardEdge.id,
          userId: localReferrerId,
          type: ReferralRewardType.POINTS,
          amount: input.credit.amount,
          isIssued: true,
          issuedAt: creditedAt,
          createdAt: creditedAt,
          sourceKey,
        },
      });
      return 'CREATED';
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) return 'EXISTS';
      throw error;
    }
  }

  private async resolveRewardEdge(input: {
    readonly payment: StealthnetPayment;
    readonly credit: StealthnetReferralCredit;
    readonly clientsById: ReadonlyMap<string, StealthnetClient>;
    readonly sourceUserIds: ReadonlyMap<string, string>;
  }): Promise<{ id: string; referrerId: string } | null> {
    let referredSourceId = input.payment.client_id;
    for (let level = 1; level <= input.credit.level; level += 1) {
      const referredSource = input.clientsById.get(referredSourceId);
      if (referredSource === undefined || referredSource.referrer_id === null) return null;
      const referredUserId = input.sourceUserIds.get(referredSourceId);
      const expectedReferrerId = input.sourceUserIds.get(referredSource.referrer_id);
      if (!referredUserId || !expectedReferrerId) return null;
      const edge = await this.prismaService.referral.findUnique({
        where: { referredId: referredUserId },
        select: { id: true, referrerId: true },
      });
      if (edge === null || edge.referrerId !== expectedReferrerId) return null;
      if (level === input.credit.level) return edge;
      referredSourceId = referredSource.referrer_id;
    }
    return null;
  }
}

function readMappings(value: unknown): StealthnetReferralMapping[] {
  if (!isRecord(value) || !isRecord(value.stealthnetReferrals)) return [];
  const rawMappings = value.stealthnetReferrals.mappings;
  if (!Array.isArray(rawMappings)) return [];
  return rawMappings.filter(isStealthnetReferralMapping);
}

function isStealthnetReferralMapping(value: unknown): value is StealthnetReferralMapping {
  if (!isRecord(value)) return false;
  return (
    typeof value.referredSourceId === 'string' &&
    typeof value.referrerSourceId === 'string' &&
    (typeof value.referredUserId === 'string' || value.referredUserId === null) &&
    (typeof value.referrerUserId === 'string' || value.referrerUserId === null) &&
    typeof value.status === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOptionalDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isUniqueConstraintError(error: unknown): boolean {
  return isRecord(error) && error.code === 'P2002';
}
