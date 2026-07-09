import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import {
  Broadcast,
  BroadcastAudience,
  BroadcastStatus,
  Prisma,
} from '@prisma/client';

import {
  buildAudienceWhere,
  normalizeAudienceFilter,
} from '../utils/broadcast-audience.util';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { normalizeCode } from '../../promocodes/utils/code-normalizer.util';
import { PROMOCODE_INCLUDE_ACTIVATIONS_COUNT } from '../../promocodes/utils/promocode-mappers.util';
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
import {
  BroadcastPromoStatus,
  evaluateBroadcastPromocode,
  isBroadcastPromocodeUsable,
} from '../utils/broadcast-promo.util';

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
    const promoCode = await this.resolvePromoCodeForSave(input.dto.promoCode);
    const created = await this.prismaService.broadcast.create({
      data: {
        status: BroadcastStatus.DRAFT,
        audience: input.dto.audience,
        audiencePlanId: input.dto.audiencePlanId ?? null,
        promoCode: promoCode ?? null,
        payload: payloadDtoToJson(input.dto.payload),
        createdBy: input.currentAdmin.id,
        ...(input.dto.audienceFilter !== undefined
          ? { audienceFilter: input.dto.audienceFilter as unknown as Prisma.InputJsonValue }
          : {}),
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
    if (input.dto.promoCode !== undefined) {
      data.promoCode = await this.resolvePromoCodeForSave(input.dto.promoCode);
    }
    if (input.dto.audienceFilter !== undefined) {
      data.audienceFilter = input.dto.audienceFilter as unknown as Prisma.InputJsonValue;
    }
    if (input.dto.payload !== undefined) {
      data.payload = mergePayload(existing.payload, input.dto.payload);
    }
    const updated = await this.prismaService.broadcast.update({
      where: { id: existing.id },
      data,
    });
    return mapBroadcast(updated);
  }

  public async updateStatus(broadcastId: string, status: BroadcastStatus): Promise<void> {
    await this.prismaService.broadcast.update({
      where: { id: broadcastId },
      data: { status },
    });
  }

  /**
   * Compose-time promo validation. Normalizes the raw code, returns `null`
   * when the operator clears the tag (empty string), otherwise resolves the
   * canonical code and throws a `BadRequestException` unless the promo is
   * currently usable (exists + active + not expired + not depleted).
   */
  private async resolvePromoCodeForSave(
    rawCode: string | undefined,
  ): Promise<string | null> {
    if (rawCode === undefined) return null;
    const normalized = normalizeCode(rawCode);
    if (normalized.length === 0) return null;
    const evaluation = await this.evaluatePromoCode(normalized);
    if (evaluation === null) {
      throw new BadRequestException(`Promocode "${normalized}" not found`);
    }
    if (!isBroadcastPromocodeUsable(evaluation.status)) {
      throw new BadRequestException(promoStatusMessage(normalized, evaluation.status));
    }
    return evaluation.code;
  }

  /**
   * Dispatch-time gate. Re-validates the broadcast's promo tag right before
   * delivery is enqueued and throws a clear error when the code drifted into
   * EXPIRED / DEPLETED (or was deleted) since compose time. No-op when the
   * broadcast carries no promo tag.
   */
  public async assertPromoCodeDispatchable(broadcastId: string): Promise<void> {
    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: broadcastId },
      select: { promoCode: true },
    });
    const code = broadcast?.promoCode ?? null;
    if (code === null || code.length === 0) return;
    const evaluation = await this.evaluatePromoCode(code);
    if (evaluation === null) {
      throw new BadRequestException(`Promocode "${code}" no longer exists`);
    }
    if (!isBroadcastPromocodeUsable(evaluation.status)) {
      throw new BadRequestException(promoStatusMessage(code, evaluation.status));
    }
  }

  /**
   * Looks up a promo by (normalized) code and classifies it for broadcast use.
   * Returns `null` when the code does not exist.
   */
  private async evaluatePromoCode(
    normalizedCode: string,
  ): Promise<{ readonly code: string; readonly status: BroadcastPromoStatus } | null> {
    const record = await this.prismaService.promocode.findUnique({
      where: { code: normalizedCode },
      include: PROMOCODE_INCLUDE_ACTIVATIONS_COUNT,
    });
    if (record === null) return null;
    const status = evaluateBroadcastPromocode({
      isActive: record.isActive,
      createdAt: record.createdAt,
      lifetime: record.lifetime,
      expiresAt: record.expiresAt,
      maxActivations: record.maxActivations,
      activationsCount: record._count.activations,
    });
    return { code: record.code, status };
  }

  /**
   * Permanently delete a broadcast and all of its message rows. A broadcast
   * that is currently PROCESSING cannot be deleted (cancel it first) to avoid
   * orphaning in-flight delivery jobs.
   */
  public async deleteBroadcast(broadcastId: string): Promise<void> {
    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: broadcastId },
      select: { id: true, status: true },
    });
    if (broadcast === null) {
      throw new NotFoundException('Broadcast not found');
    }
    if (broadcast.status === BroadcastStatus.PROCESSING) {
      throw new BadRequestException(
        'Cannot delete a broadcast while it is processing — cancel it first',
      );
    }
    await this.prismaService.$transaction(async (tx) => {
      // Cabinet-feed events created by the fanout are keyed by broadcastId in
      // their JSON payload — drop them too, otherwise a deleted broadcast keeps
      // hanging in the user's notification feed.
      await tx.userNotificationEvent.deleteMany({
        where: {
          type: 'broadcast',
          payload: { path: ['broadcastId'], equals: broadcastId },
        },
      });
      await tx.broadcastMessage.deleteMany({ where: { broadcastId } });
      await tx.broadcast.delete({ where: { id: broadcastId } });
    });
  }

  /**
   * Update the text/parse-mode of a broadcast that has already been sent.
   * Besides updating the stored broadcast payload, this rewrites the
   * cabinet-feed notification events created for this broadcast so web/Telegram
   * users see the corrected text in their in-app feed. (Telegram message edits
   * are handled separately by the delivery worker via `enqueueEdit`.)
   */
  public async updateBroadcastContent(input: {
    readonly broadcastId: string;
    readonly text: string;
    readonly parseMode: 'HTML' | 'MarkdownV2' | null;
  }): Promise<void> {
    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: input.broadcastId },
      select: { id: true, payload: true },
    });
    if (broadcast === null) {
      throw new NotFoundException('Broadcast not found');
    }

    await this.prismaService.broadcast.update({
      where: { id: input.broadcastId },
      data: {
        payload: mergePayload(broadcast.payload, {
          text: input.text,
          parseMode: input.parseMode,
        }),
      },
    });

    // Rewrite the cabinet-feed events created by the fanout for this broadcast.
    const events = await this.prismaService.userNotificationEvent.findMany({
      where: {
        type: 'broadcast',
        payload: { path: ['broadcastId'], equals: input.broadcastId },
      },
      select: { id: true, payload: true },
    });
    for (const event of events) {
      const base =
        event.payload !== null &&
        typeof event.payload === 'object' &&
        !Array.isArray(event.payload)
          ? { ...(event.payload as Record<string, unknown>) }
          : {};
      base.text = input.text;
      await this.prismaService.userNotificationEvent.update({
        where: { id: event.id },
        data: { payload: base as Prisma.InputJsonObject },
      });
    }
  }

  public async previewAudience(
    broadcastId: string,
  ): Promise<BroadcastAudiencePreviewInterface> {
    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: broadcastId },
      select: { id: true, audience: true, audiencePlanId: true, audienceFilter: true },
    });
    if (broadcast === null) {
      throw new NotFoundException('Broadcast not found');
    }
    const totalRecipients = await this.countAudience({
      audience: broadcast.audience,
      audienceFilter: broadcast.audienceFilter,
    });
    return {
      audience: broadcast.audience,
      audiencePlanId: broadcast.audiencePlanId,
      audienceFilter: normalizeAudienceFilter(broadcast.audienceFilter),
      totalRecipients,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Count the recipients an audience resolves to. Uses the SAME shared
   * where-builder as delivery (`resolveRecipients`), so the preview count
   * always matches who is actually reached — the two used to diverge (preview
   * counted Telegram-only, delivery included web users). A structured
   * `audienceFilter` supersedes the `audience` enum preset when present.
   */
  private async countAudience(input: {
    readonly audience: BroadcastAudience;
    readonly audienceFilter: Prisma.JsonValue | null;
  }): Promise<number> {
    const where = buildAudienceWhere(
      input.audience,
      normalizeAudienceFilter(input.audienceFilter),
    );
    return this.prismaService.user.count({ where });
  }
}

function promoStatusMessage(code: string, status: BroadcastPromoStatus): string {
  switch (status) {
    case 'INACTIVE':
      return `Promocode "${code}" is inactive`;
    case 'EXPIRED':
      return `Promocode "${code}" has expired`;
    case 'DEPLETED':
      return `Promocode "${code}" has no activations left`;
    case 'OK':
      return `Promocode "${code}" is usable`;
  }
}

function payloadDtoToJson(
  payload: BroadcastPayloadDto | undefined,
): Prisma.InputJsonObject {
  return {
    title: payload?.title ?? null,
    text: payload?.text ?? null,
    mediaType: payload?.mediaType ?? 'none',
    mediaFileId: payload?.mediaFileId ?? null,
    parseMode: payload?.parseMode ?? null,
    emailEnabled: payload?.emailEnabled ?? false,
    telegramChannelChatId: payload?.telegramChannelChatId ?? null,
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
  if (patch.title !== undefined) base.title = patch.title;
  if (patch.text !== undefined) base.text = patch.text;
  if (patch.mediaType !== undefined) base.mediaType = patch.mediaType;
  if (patch.mediaFileId !== undefined) base.mediaFileId = patch.mediaFileId;
  if (patch.parseMode !== undefined) base.parseMode = patch.parseMode;
  if (patch.emailEnabled !== undefined) base.emailEnabled = patch.emailEnabled;
  if (patch.telegramChannelChatId !== undefined) {
    base.telegramChannelChatId = patch.telegramChannelChatId;
  }
  return base as Prisma.InputJsonObject;
}

function mapBroadcast(record: Broadcast): BroadcastInterface {
  return {
    id: record.id,
    status: record.status,
    audience: record.audience,
    audiencePlanId: record.audiencePlanId,
    audienceFilter: normalizeAudienceFilter(record.audienceFilter),
    promoCode: record.promoCode,
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
      title: null,
      text: null,
      mediaType: 'none',
      mediaFileId: null,
      parseMode: null,
      emailEnabled: false,
      telegramChannelChatId: null,
    };
  }
  const candidate = value as Record<string, unknown>;
  return {
    title: typeof candidate.title === 'string' ? candidate.title : null,
    text: typeof candidate.text === 'string' ? candidate.text : null,
    mediaType: readMediaType(candidate.mediaType),
    mediaFileId:
      typeof candidate.mediaFileId === 'string' ? candidate.mediaFileId : null,
    parseMode: readParseMode(candidate.parseMode),
    emailEnabled: candidate.emailEnabled === true,
    telegramChannelChatId:
      typeof candidate.telegramChannelChatId === 'string' &&
      candidate.telegramChannelChatId.trim().length > 0
        ? candidate.telegramChannelChatId.trim()
        : null,
  };
}

function readMediaType(value: unknown): 'none' | 'photo' | 'video' {
  return value === 'photo' || value === 'video' ? value : 'none';
}

function readParseMode(value: unknown): 'HTML' | 'MarkdownV2' | null {
  return value === 'HTML' || value === 'MarkdownV2' ? value : null;
}
