import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { AdPlatform, Prisma } from '@prisma/client';

import { advertisingConfig } from '../../../common/config/advertising.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CreateAdRequestDto, ModerateRequestDto } from '../dto/advertising.dto';
import { AdCampaignView, AdPlacementRequestView } from '../interfaces/advertising.interface';
import { mapCampaign, mapRequest } from '../utils/advertising-mappers';
import { generateTrackingCode, isValidTrackingCode } from '../utils/tracking-code.util';

type TxClient = Prisma.TransactionClient;

/**
 * Partner-submitted advertising request lifecycle:
 * PENDING → (operator) ACTIVE | COUNTERED → (partner) ACTIVE,
 * plus REJECTED. On the transition to ACTIVE one PARTNER placement is created
 * per requested platform under a fresh campaign, with the agreed window.
 *
 * Activation claims the request status atomically (`updateMany` with expected
 * status) inside a transaction so concurrent accept/approve cannot mint
 * duplicate campaigns or tracking codes.
 */
@Injectable()
export class AdPlacementRequestService {
  private readonly logger = new Logger(AdPlacementRequestService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    @Inject(advertisingConfig.KEY)
    private readonly config: ConfigType<typeof advertisingConfig>,
  ) {}

  public async listRequests(status?: string): Promise<AdPlacementRequestView[]> {
    const requests = await this.prismaService.adPlacementRequest.findMany({
      where: status ? { status: status as never } : undefined,
      orderBy: { createdAt: 'desc' },
    });
    return requests.map(mapRequest);
  }

  public async listForPartner(partnerId: string): Promise<AdPlacementRequestView[]> {
    const requests = await this.prismaService.adPlacementRequest.findMany({
      where: { partnerId },
      orderBy: { createdAt: 'desc' },
    });
    return requests.map(mapRequest);
  }

  public async createRequest(
    partnerId: string,
    input: CreateAdRequestDto,
  ): Promise<AdPlacementRequestView> {
    const request = await this.prismaService.adPlacementRequest.create({
      data: {
        partnerId,
        platforms: input.platforms,
        channel: input.channel?.trim() || null,
        notes: input.notes?.trim() || null,
        proposedWindowDays: input.proposedWindowDays,
        selfFundedBudgetNote: input.selfFundedBudgetNote?.trim() || null,
        status: 'PENDING',
      },
    });
    return mapRequest(request);
  }

  /**
   * Approves a request. When `approvedWindowDays` equals the proposed window we
   * activate immediately; when the operator counters with a different window the
   * request goes to COUNTERED and waits for the partner to accept.
   */
  public async approve(
    id: string,
    reviewerId: string | null,
    input: ModerateRequestDto,
  ): Promise<{ request: AdPlacementRequestView; campaign: AdCampaignView | null }> {
    const request = await this.requirePending(id);
    const approvedWindow = input.approvedWindowDays ?? request.proposedWindowDays;
    const isCounter = approvedWindow !== request.proposedWindowDays;

    if (isCounter) {
      const claimed = await this.prismaService.adPlacementRequest.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: 'COUNTERED',
          approvedWindowDays: approvedWindow,
          reviewedBy: reviewerId,
          reviewedAt: new Date(),
          notes: input.notes?.trim() || request.notes,
        },
      });
      if (claimed.count === 0) {
        throw new BadRequestException('Request is not pending review');
      }
      const updated = await this.prismaService.adPlacementRequest.findUniqueOrThrow({
        where: { id },
      });
      return { request: mapRequest(updated), campaign: null };
    }

    return this.activateAtomically({
      id,
      expectedStatus: 'PENDING',
      reviewerId,
      windowDays: approvedWindow,
    });
  }

  /** Partner accepts the operator's countered terms → activate. */
  public async accept(
    id: string,
    partnerId: string,
  ): Promise<{ request: AdPlacementRequestView; campaign: AdCampaignView | null }> {
    const request = await this.prismaService.adPlacementRequest.findUnique({ where: { id } });
    if (request === null || request.partnerId !== partnerId) {
      throw new NotFoundException('Request not found');
    }
    if (request.status !== 'COUNTERED') {
      throw new BadRequestException('Request is not awaiting partner acceptance');
    }
    return this.activateAtomically({
      id,
      expectedStatus: 'COUNTERED',
      partnerId,
      reviewerId: request.reviewedBy,
      windowDays: request.approvedWindowDays ?? request.proposedWindowDays,
    });
  }

  public async reject(id: string, reviewerId: string | null): Promise<AdPlacementRequestView> {
    await this.requirePending(id);
    const claimed = await this.prismaService.adPlacementRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'REJECTED', reviewedBy: reviewerId, reviewedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw new BadRequestException('Request is not pending review');
    }
    const updated = await this.prismaService.adPlacementRequest.findUniqueOrThrow({
      where: { id },
    });
    return mapRequest(updated);
  }

  /**
   * Atomically claims the request row (expected status → ACTIVE) then creates
   * campaign + placements in the same transaction. Concurrent acceptors lose
   * the claim (`updateMany` count 0) and get a 400 without side effects.
   */
  private async activateAtomically(input: {
    readonly id: string;
    readonly expectedStatus: 'PENDING' | 'COUNTERED';
    readonly partnerId?: string;
    readonly reviewerId: string | null;
    readonly windowDays: number;
  }): Promise<{ request: AdPlacementRequestView; campaign: AdCampaignView }> {
    return this.prismaService.$transaction(async (tx) => {
      const claimWhere: Prisma.AdPlacementRequestWhereInput = {
        id: input.id,
        status: input.expectedStatus,
      };
      if (input.partnerId !== undefined) {
        claimWhere.partnerId = input.partnerId;
      }

      const claimed = await tx.adPlacementRequest.updateMany({
        where: claimWhere,
        data: {
          status: 'ACTIVE',
          approvedWindowDays: input.windowDays,
          reviewedBy: input.reviewerId,
          reviewedAt: new Date(),
        },
      });
      if (claimed.count === 0) {
        throw new BadRequestException('Request is not available for activation');
      }

      const request = await tx.adPlacementRequest.findUniqueOrThrow({
        where: { id: input.id },
      });

      const partner = await tx.partner.findUnique({
        where: { id: request.partnerId },
        select: { id: true },
      });
      if (partner === null) {
        throw new BadRequestException('Partner not found');
      }

      const campaign = await tx.adCampaign.create({
        data: {
          name: `Partner ${request.partnerId.slice(0, 8)} — ${request.channel ?? 'campaign'}`.slice(
            0,
            100,
          ),
          status: 'ACTIVE',
          notes: request.notes,
        },
      });

      for (const platform of request.platforms as AdPlatform[]) {
        const code = await this.mintUniqueCode(tx);
        await tx.adPlacement.create({
          data: {
            campaignId: campaign.id,
            platform,
            channel: request.channel,
            ownerType: 'PARTNER',
            partnerId: request.partnerId,
            trackingCode: code,
            attributionWindowDays: input.windowDays,
            status: 'ACTIVE',
          },
        });
      }

      const updated = await tx.adPlacementRequest.update({
        where: { id: input.id },
        data: { campaignId: campaign.id },
      });

      const full = await tx.adCampaign.findUnique({
        where: { id: campaign.id },
        include: { placements: { orderBy: { createdAt: 'asc' } } },
      });

      this.logger.log(
        `Activated advertising request ${input.id} → campaign ${campaign.id} (${request.platforms.length} placements)`,
      );

      return {
        request: mapRequest(updated),
        campaign: mapCampaign(full ?? campaign, this.config),
      };
    });
  }

  private async requirePending(id: string) {
    const request = await this.prismaService.adPlacementRequest.findUnique({ where: { id } });
    if (request === null) {
      throw new NotFoundException('Request not found');
    }
    if (request.status !== 'PENDING') {
      throw new BadRequestException('Request is not pending review');
    }
    return request;
  }

  private async mintUniqueCode(tx: TxClient): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = generateTrackingCode(10);
      if (!isValidTrackingCode(code)) continue;
      const existing = await tx.adPlacement.findUnique({
        where: { trackingCode: code },
        select: { id: true },
      });
      if (existing === null) return code;
    }
    throw new Error('Failed to mint a unique tracking code');
  }
}
