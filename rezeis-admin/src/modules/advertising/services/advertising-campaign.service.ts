import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import { advertisingConfig } from '../../../common/config/advertising.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  CreateCampaignDto,
  CreatePlacementDto,
  UpdateCampaignDto,
  UpdatePlacementDto,
  AdSignupBonusDto,
} from '../dto/advertising.dto';
import { AdCampaignView, AdPlacementView } from '../interfaces/advertising.interface';
import { mapCampaign, mapPlacement } from '../utils/advertising-mappers';
import { generateTrackingCode, isValidTrackingCode } from '../utils/tracking-code.util';

@Injectable()
export class AdvertisingCampaignService {
  private readonly logger = new Logger(AdvertisingCampaignService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    @Inject(advertisingConfig.KEY)
    private readonly config: ConfigType<typeof advertisingConfig>,
  ) {}

  public async listCampaigns(): Promise<AdCampaignView[]> {
    const campaigns = await this.prismaService.adCampaign.findMany({
      orderBy: { createdAt: 'desc' },
      include: { placements: { orderBy: { createdAt: 'asc' } } },
    });
    return campaigns.map((c) => mapCampaign(c, this.config));
  }

  public async getCampaign(id: string): Promise<AdCampaignView> {
    const campaign = await this.prismaService.adCampaign.findUnique({
      where: { id },
      include: { placements: { orderBy: { createdAt: 'asc' } } },
    });
    if (campaign === null) {
      throw new NotFoundException('Campaign not found');
    }
    return mapCampaign(campaign, this.config);
  }

  public async createCampaign(input: CreateCampaignDto, createdBy: string | null): Promise<AdCampaignView> {
    const campaign = await this.prismaService.adCampaign.create({
      data: {
        name: input.name.trim(),
        notes: input.notes?.trim() || null,
        createdBy,
        status: 'ACTIVE',
      },
      include: { placements: true },
    });
    return mapCampaign(campaign, this.config);
  }

  public async updateCampaign(id: string, input: UpdateCampaignDto): Promise<AdCampaignView> {
    await this.requireCampaign(id);
    const campaign = await this.prismaService.adCampaign.update({
      where: { id },
      data: {
        name: input.name?.trim(),
        status: input.status,
        notes: input.notes === undefined ? undefined : input.notes.trim() || null,
      },
      include: { placements: { orderBy: { createdAt: 'asc' } } },
    });
    return mapCampaign(campaign, this.config);
  }

  public async createPlacement(input: CreatePlacementDto): Promise<AdPlacementView> {
    await this.requireCampaign(input.campaignId);
    const ownerType = input.ownerType ?? 'COMPANY';
    // PARTNER placements never carry an operator-funded budget (their cost is
    // the commission we pay), so the budget is dropped for them.
    const spendAmount = ownerType === 'PARTNER' ? null : input.spendAmountMinor ?? null;
    const spendCurrency = ownerType === 'PARTNER' ? null : input.spendCurrency?.toUpperCase() ?? null;
    const code = await this.mintUniqueCode();
    const placement = await this.prismaService.adPlacement.create({
      data: {
        campaignId: input.campaignId,
        platform: input.platform,
        channel: input.channel?.trim() || null,
        ownerType,
        partnerId: ownerType === 'PARTNER' ? input.partnerId ?? null : null,
        trackingCode: code,
        attributionWindowDays: input.attributionWindowDays,
        promoCodeId: input.promoCodeId ?? null,
        spendAmount,
        spendCurrency,
        signupBonusType: input.signupBonus?.type ?? 'NONE',
        signupBonus: buildSignupBonusJson(input.signupBonus),
        status: 'ACTIVE',
      },
    });
    return mapPlacement(placement, this.config);
  }

  public async updatePlacement(id: string, input: UpdatePlacementDto): Promise<AdPlacementView> {
    const existing = await this.prismaService.adPlacement.findUnique({ where: { id } });
    if (existing === null) {
      throw new NotFoundException('Placement not found');
    }
    const isPartner = existing.ownerType === 'PARTNER';
    // PARTNER cost is commission only — force null budget even if legacy rows
    // still carry spend from a bad write or owner-type change.
    const spendAmount = isPartner ? null : input.spendAmountMinor;
    const spendCurrency = isPartner
      ? null
      : input.spendCurrency === undefined
        ? undefined
        : input.spendCurrency.toUpperCase();
    const placement = await this.prismaService.adPlacement.update({
      where: { id },
      data: {
        channel: input.channel === undefined ? undefined : input.channel.trim() || null,
        attributionWindowDays: input.attributionWindowDays,
        promoCodeId: input.promoCodeId === undefined ? undefined : input.promoCodeId || null,
        spendAmount,
        spendCurrency,
        status: input.status,
        signupBonusType: input.signupBonus?.type,
        signupBonus:
          input.signupBonus === undefined ? undefined : buildSignupBonusJson(input.signupBonus),
      },
    });
    return mapPlacement(placement, this.config);
  }

  /**
   * Archives a placement. A placement with recorded clicks or conversions is
   * never hard-deleted (it would orphan attribution history); it is set to
   * ARCHIVED instead. An untouched placement is removed outright.
   */
  public async deletePlacement(id: string): Promise<{ archived: boolean }> {
    const existing = await this.prismaService.adPlacement.findUnique({
      where: { id },
      include: { _count: { select: { clicks: true, conversions: true } } },
    });
    if (existing === null) {
      throw new NotFoundException('Placement not found');
    }
    const used = existing._count.clicks > 0 || existing._count.conversions > 0;
    if (used) {
      await this.prismaService.adPlacement.update({
        where: { id },
        data: { status: 'ARCHIVED' },
      });
      return { archived: true };
    }
    await this.prismaService.adPlacement.delete({ where: { id } });
    return { archived: false };
  }

  private async requireCampaign(id: string): Promise<void> {
    const campaign = await this.prismaService.adCampaign.findUnique({ where: { id }, select: { id: true } });
    if (campaign === null) {
      throw new NotFoundException('Campaign not found');
    }
  }

  /** Mints a tracking code not already used by another placement. */
  private async mintUniqueCode(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = generateTrackingCode(10);
      if (!isValidTrackingCode(code)) {
        continue;
      }
      const existing = await this.prismaService.adPlacement.findUnique({
        where: { trackingCode: code },
        select: { id: true },
      });
      if (existing === null) {
        return code;
      }
    }
    throw new Error('Failed to mint a unique tracking code');
  }
}

function buildSignupBonusJson(
  bonus: AdSignupBonusDto | undefined,
): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue {
  if (bonus === undefined || bonus.type === 'NONE') {
    return Prisma.JsonNull;
  }
  const json: Record<string, unknown> = {};
  if (bonus.trialDurationDays !== undefined) json.trialDurationDays = bonus.trialDurationDays;
  if (bonus.trialTrafficGb !== undefined) json.trialTrafficGb = bonus.trialTrafficGb;
  if (bonus.trialDeviceLimit !== undefined) json.trialDeviceLimit = bonus.trialDeviceLimit;
  if (bonus.trialSquadUuids !== undefined) json.trialSquadUuids = bonus.trialSquadUuids;
  if (bonus.tariffPlanId !== undefined) json.tariffPlanId = bonus.tariffPlanId;
  if (bonus.tariffDurationDays !== undefined) json.tariffDurationDays = bonus.tariffDurationDays;
  return json as Prisma.InputJsonValue;
}
