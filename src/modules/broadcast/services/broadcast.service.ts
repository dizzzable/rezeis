import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Broadcast,
  BroadcastAudience,
  BroadcastStatus,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import {
  BroadcastPayloadDto,
  CreateBroadcastDraftDto,
  UpdateBroadcastDraftDto,
} from '../dto/broadcast-payload.dto';
import {
  BroadcastAudiencePreviewInterface,
  BroadcastInterface,
  BroadcastPayloadInterface,
} from '../interfaces/broadcast.interface';

@Injectable()
export class BroadcastService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async listDrafts(): Promise<readonly BroadcastInterface[]> {
    const broadcasts = await this.prismaService.broadcast.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return broadcasts.map(mapBroadcast);
  }

  public async getBroadcast(broadcastId: string): Promise<BroadcastInterface> {
    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: broadcastId },
    });
    if (broadcast === null) {
      throw new NotFoundException('Broadcast not found');
    }
    return mapBroadcast(broadcast);
  }

  public async createDraft(input: {
    readonly dto: CreateBroadcastDraftDto;
    readonly currentAdmin: CurrentAdminInterface;
  }): Promise<BroadcastInterface> {
    const created = await this.prismaService.broadcast.create({
      data: {
        status: BroadcastStatus.DRAFT,
        audience: input.dto.audience,
        audiencePlanId: input.dto.audiencePlanId ?? null,
        payload: payloadDtoToJson(input.dto.payload),
        createdBy: input.currentAdmin.id,
      },
    });
    return mapBroadcast(created);
  }

  public async updateDraft(input: {
    readonly broadcastId: string;
    readonly dto: UpdateBroadcastDraftDto;
  }): Promise<BroadcastInterface> {
    const existing = await this.prismaService.broadcast.findUnique({
      where: { id: input.broadcastId },
      select: { id: true, status: true, payload: true, audiencePlanId: true },
    });
    if (existing === null) {
      throw new NotFoundException('Broadcast not found');
    }
    if (existing.status !== BroadcastStatus.DRAFT) {
      throw new NotFoundException('Only draft broadcasts can be updated');
    }
    const data: Prisma.BroadcastUpdateInput = {
      audience: input.dto.audience,
      audiencePlanId:
        input.dto.audiencePlanId === undefined
          ? undefined
          : input.dto.audiencePlanId,
    };
    if (input.dto.payload !== undefined) {
      data.payload = mergePayload(existing.payload, input.dto.payload);
    }
    const updated = await this.prismaService.broadcast.update({
      where: { id: existing.id },
      data,
    });
    return mapBroadcast(updated);
  }

  public async previewAudience(
    broadcastId: string,
  ): Promise<BroadcastAudiencePreviewInterface> {
    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: broadcastId },
      select: { id: true, audience: true, audiencePlanId: true },
    });
    if (broadcast === null) {
      throw new NotFoundException('Broadcast not found');
    }
    const totalRecipients = await this.countAudience({
      audience: broadcast.audience,
      audiencePlanId: broadcast.audiencePlanId,
    });
    return {
      audience: broadcast.audience,
      audiencePlanId: broadcast.audiencePlanId,
      totalRecipients,
      generatedAt: new Date().toISOString(),
    };
  }

  private async countAudience(input: {
    readonly audience: BroadcastAudience;
    readonly audiencePlanId: string | null;
  }): Promise<number> {
    const baseUserWhere: Prisma.UserWhereInput = {
      isBlocked: false,
      isBotBlocked: false,
      telegramId: { not: null },
    };
    switch (input.audience) {
      case BroadcastAudience.ALL:
        return this.prismaService.user.count({ where: baseUserWhere });
      case BroadcastAudience.ACTIVE_SUBSCRIBERS:
        return this.prismaService.user.count({
          where: {
            ...baseUserWhere,
            subscriptions: {
              some: { status: SubscriptionStatus.ACTIVE },
            },
          },
        });
      case BroadcastAudience.EXPIRED:
        return this.prismaService.user.count({
          where: {
            ...baseUserWhere,
            subscriptions: {
              some: { status: SubscriptionStatus.EXPIRED },
            },
            NOT: {
              subscriptions: { some: { status: SubscriptionStatus.ACTIVE } },
            },
          },
        });
      case BroadcastAudience.TRIAL:
        return this.prismaService.user.count({
          where: {
            ...baseUserWhere,
            subscriptions: { some: { isTrial: true, status: SubscriptionStatus.ACTIVE } },
          },
        });
      case BroadcastAudience.UNSUBSCRIBED:
        return this.prismaService.user.count({
          where: {
            ...baseUserWhere,
            subscriptions: { none: {} },
          },
        });
      default:
        return 0;
    }
  }
}

function payloadDtoToJson(
  payload: BroadcastPayloadDto | undefined,
): Prisma.InputJsonObject {
  return {
    text: payload?.text ?? null,
    mediaType: payload?.mediaType ?? 'none',
    mediaFileId: payload?.mediaFileId ?? null,
    parseMode: payload?.parseMode ?? null,
  };
}

function mergePayload(
  existing: Prisma.JsonValue,
  patch: BroadcastPayloadDto,
): Prisma.InputJsonObject {
  const base: Record<string, unknown> =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  if (patch.text !== undefined) base.text = patch.text;
  if (patch.mediaType !== undefined) base.mediaType = patch.mediaType;
  if (patch.mediaFileId !== undefined) base.mediaFileId = patch.mediaFileId;
  if (patch.parseMode !== undefined) base.parseMode = patch.parseMode;
  return base as Prisma.InputJsonObject;
}

function mapBroadcast(record: Broadcast): BroadcastInterface {
  return {
    id: record.id,
    status: record.status,
    audience: record.audience,
    audiencePlanId: record.audiencePlanId,
    payload: readPayload(record.payload),
    totalCount: record.totalCount,
    successCount: record.successCount,
    failedCount: record.failedCount,
    createdBy: record.createdBy,
    startedAt: record.startedAt?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function readPayload(value: Prisma.JsonValue): BroadcastPayloadInterface {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      text: null,
      mediaType: 'none',
      mediaFileId: null,
      parseMode: null,
    };
  }
  const candidate = value as Record<string, unknown>;
  return {
    text: typeof candidate.text === 'string' ? candidate.text : null,
    mediaType: readMediaType(candidate.mediaType),
    mediaFileId:
      typeof candidate.mediaFileId === 'string' ? candidate.mediaFileId : null,
    parseMode: readParseMode(candidate.parseMode),
  };
}

function readMediaType(value: unknown): 'none' | 'photo' | 'video' {
  return value === 'photo' || value === 'video' ? value : 'none';
}

function readParseMode(value: unknown): 'HTML' | 'MarkdownV2' | null {
  return value === 'HTML' || value === 'MarkdownV2' ? value : null;
}
