import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import {
  Prisma,
  Quest,
  QuestDaysFallback,
  QuestRewardType,
  QuestType,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { normalizeAudienceFilter } from '../../broadcast/utils/broadcast-audience.util';
import { CreateQuestDto, UpdateQuestDto } from '../dto/quest-payload.dto';
import {
  LocalizedText,
  QuestInterface,
  QuestParams,
} from '../interfaces/quest.interface';
import { resolveQuestChannelConfig } from '../utils/quest-channel-config.util';
import { resolveQuestPartnerConfig } from '../utils/quest-partner-config.util';
import { QuestPartnerSecretRegistry } from './quest-partner-secret.registry';

/** Narrow view of the secret registry the config gate needs (slug existence). */
interface PartnerSlugChecker {
  has(slug: string): boolean;
}

@Injectable()
export class QuestService {
  public constructor(
    private readonly prismaService: PrismaService,
    @Optional() private readonly partnerSecrets?: QuestPartnerSecretRegistry,
  ) {}

  public async list(): Promise<readonly QuestInterface[]> {
    const quests = await this.prismaService.quest.findMany({
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      take: 200,
    });
    return quests.map(mapQuest);
  }

  public async getById(questId: string): Promise<QuestInterface> {
    const quest = await this.prismaService.quest.findUnique({ where: { id: questId } });
    if (quest === null) {
      throw new NotFoundException('Quest not found');
    }
    return mapQuest(quest);
  }

  public async create(input: {
    readonly dto: CreateQuestDto;
    readonly currentAdmin: CurrentAdminInterface;
  }): Promise<QuestInterface> {
    assertCompletableType(input.dto.type, input.dto.params ?? null, this.partnerSecrets);
    assertWindow(input.dto.startAt, input.dto.endAt);
    assertRewardConfig(
      input.dto.rewardType,
      input.dto.daysFallback ?? 'MINT_PROMOCODE',
      input.dto.rewardPlanId ?? null,
    );
    assertParamsSize(input.dto.params ?? null);
    const maxOrder = await this.prismaService.quest.aggregate({ _max: { order: true } });
    const created = await this.prismaService.quest.create({
      data: {
        type: input.dto.type,
        title: localizedToJson(input.dto.title),
        description: localizedToJson(input.dto.description),
        iconKind: input.dto.iconKind ?? 'PRESET',
        iconRef: input.dto.iconRef ?? '',
        rewardType: input.dto.rewardType,
        rewardAmount: input.dto.rewardAmount ?? 0,
        rewardPlanId: input.dto.rewardPlanId ?? null,
        daysFallback: input.dto.daysFallback ?? 'MINT_PROMOCODE',
        repeat: input.dto.repeat ?? 'ONCE',
        cooldownHours: input.dto.cooldownHours ?? null,
        startAt: parseDate(input.dto.startAt),
        endAt: parseDate(input.dto.endAt),
        maxCompletionsGlobal: input.dto.maxCompletionsGlobal ?? null,
        order: input.dto.order ?? (maxOrder._max.order ?? 0) + 1,
        enabled: input.dto.enabled ?? false,
        createdBy: input.currentAdmin.id,
        ...(input.dto.audienceFilter !== undefined && input.dto.audienceFilter !== null
          ? { audienceFilter: input.dto.audienceFilter as unknown as Prisma.InputJsonValue }
          : {}),
        ...(input.dto.params !== undefined && input.dto.params !== null
          ? { params: input.dto.params as Prisma.InputJsonValue }
          : {}),
      },
    });
    return mapQuest(created);
  }

  public async update(questId: string, dto: UpdateQuestDto): Promise<QuestInterface> {
    const existing = await this.prismaService.quest.findUnique({
      where: { id: questId },
      select: {
        id: true,
        type: true,
        startAt: true,
        endAt: true,
        rewardType: true,
        daysFallback: true,
        rewardPlanId: true,
        params: true,
      },
    });
    if (existing === null) {
      throw new NotFoundException('Quest not found');
    }
    assertCompletableType(
      dto.type ?? existing.type,
      dto.params !== undefined ? dto.params : (existing.params as Prisma.JsonValue),
      this.partnerSecrets,
    );
    const nextStart = dto.startAt !== undefined ? parseDate(dto.startAt) : existing.startAt;
    const nextEnd = dto.endAt !== undefined ? parseDate(dto.endAt) : existing.endAt;
    assertWindowDates(nextStart, nextEnd);
    // Validate the EFFECTIVE reward config (merge of patch + existing) so a
    // partial patch cannot leave a DAYS→GRANT_TRIAL quest without a plan.
    assertRewardConfig(
      dto.rewardType ?? existing.rewardType,
      dto.daysFallback ?? existing.daysFallback,
      dto.rewardPlanId !== undefined ? dto.rewardPlanId : existing.rewardPlanId,
    );
    if (dto.params !== undefined) assertParamsSize(dto.params);

    const data: Prisma.QuestUpdateInput = {};
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.title !== undefined) data.title = localizedToJson(dto.title);
    if (dto.description !== undefined) data.description = localizedToJson(dto.description);
    if (dto.iconKind !== undefined) data.iconKind = dto.iconKind;
    if (dto.iconRef !== undefined) data.iconRef = dto.iconRef;
    if (dto.rewardType !== undefined) data.rewardType = dto.rewardType;
    if (dto.rewardAmount !== undefined) data.rewardAmount = dto.rewardAmount;
    if (dto.rewardPlanId !== undefined) data.rewardPlanId = dto.rewardPlanId;
    if (dto.daysFallback !== undefined) data.daysFallback = dto.daysFallback;
    if (dto.repeat !== undefined) data.repeat = dto.repeat;
    if (dto.cooldownHours !== undefined) data.cooldownHours = dto.cooldownHours;
    if (dto.startAt !== undefined) data.startAt = nextStart;
    if (dto.endAt !== undefined) data.endAt = nextEnd;
    if (dto.maxCompletionsGlobal !== undefined) {
      data.maxCompletionsGlobal = dto.maxCompletionsGlobal;
    }
    if (dto.order !== undefined) data.order = dto.order;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.audienceFilter !== undefined) {
      // `DbNull` writes a real SQL NULL (matches the create path, which omits
      // the column) rather than a JSON `null` literal.
      data.audienceFilter =
        dto.audienceFilter === null
          ? Prisma.DbNull
          : (dto.audienceFilter as unknown as Prisma.InputJsonValue);
    }
    if (dto.params !== undefined) {
      data.params =
        dto.params === null ? Prisma.DbNull : (dto.params as Prisma.InputJsonValue);
    }

    const updated = await this.prismaService.quest.update({ where: { id: questId }, data });
    return mapQuest(updated);
  }

  public async delete(questId: string): Promise<void> {
    try {
      await this.prismaService.quest.delete({ where: { id: questId } });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundException('Quest not found');
      }
      throw err;
    }
  }

  /** Persist a new display order from an ordered list of quest ids. */
  public async reorder(orderedIds: readonly string[]): Promise<readonly QuestInterface[]> {
    try {
      await this.prismaService.$transaction(
        orderedIds.map((id, index) =>
          this.prismaService.quest.update({ where: { id }, data: { order: index } }),
        ),
      );
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new BadRequestException('Reorder references an unknown quest id');
      }
      throw err;
    }
    return this.list();
  }
}

function assertWindow(startAt?: string | null, endAt?: string | null): void {
  assertWindowDates(parseDate(startAt), parseDate(endAt));
}

const MAX_PARAMS_JSON_BYTES = 4 * 1024;

/**
 * Quest types with a working end-to-end completion path in this release
 * (live event + catch-up reconciler + claim). SUBSCRIBE_CHANNEL / PARTNER_TASK
 * / CUSTOM have no detection yet, so we refuse to create/patch them — an
 * operator must never ship a quest a user can see but never complete.
 */
const COMPLETABLE_QUEST_TYPES: readonly QuestType[] = [
  QuestType.LINK_TELEGRAM,
  QuestType.LINK_EMAIL,
  QuestType.INVITE_FRIENDS,
  QuestType.SUBSCRIBE_CHANNEL,
  QuestType.PARTNER_TASK,
];

function assertCompletableType(
  type: QuestType,
  params: Record<string, unknown> | Prisma.JsonValue | null,
  partnerSlugs?: PartnerSlugChecker,
): void {
  if (!COMPLETABLE_QUEST_TYPES.includes(type)) {
    throw new BadRequestException('This quest type is not available yet');
  }
  if (type === QuestType.SUBSCRIBE_CHANNEL && resolveQuestChannelConfig(params as Prisma.JsonValue) === null) {
    throw new BadRequestException('A channel quest requires a valid chat id or username');
  }
  if (type === QuestType.PARTNER_TASK) {
    const config = resolveQuestPartnerConfig(params as Prisma.JsonValue);
    // The partner slug must resolve to a configured secret, otherwise the
    // callback / manual-code path can never verify and the quest is unshippable.
    if (config === null || partnerSlugs === undefined || !partnerSlugs.has(config.partnerSlug)) {
      throw new BadRequestException('A partner quest requires a valid, configured partner');
    }
  }
}

/**
 * A `DAYS` reward that falls back to `GRANT_TRIAL` needs a plan to grant; without
 * one every claim by a user with no bounded subscription throws at payout time,
 * consuming a budget slot and looping the reconciler. Reject at save time.
 */
function assertRewardConfig(
  rewardType: QuestRewardType,
  daysFallback: QuestDaysFallback,
  rewardPlanId: string | null,
): void {
  if (
    rewardType === 'DAYS' &&
    daysFallback === 'GRANT_TRIAL' &&
    (rewardPlanId === null || rewardPlanId.trim().length === 0)
  ) {
    throw new BadRequestException('A DAYS reward with GRANT_TRIAL fallback requires a reward plan');
  }
}

/** Bound the free-form `params` JSON so it cannot store an oversized blob. */
function assertParamsSize(params: Record<string, unknown> | null): void {
  if (params === null) return;
  if (Buffer.byteLength(JSON.stringify(params), 'utf8') > MAX_PARAMS_JSON_BYTES) {
    throw new BadRequestException('Quest params are too large (max 4 KB)');
  }
}

function assertWindowDates(start: Date | null, end: Date | null): void {
  if (start !== null && end !== null && end.getTime() <= start.getTime()) {
    throw new BadRequestException('endAt must be after startAt');
  }
}

function parseDate(value?: string | null): Date | null {
  if (value === undefined || value === null || value.trim().length === 0) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException('Invalid date');
  }
  return date;
}

function localizedToJson(value: { ru?: string; en?: string } | undefined): Prisma.InputJsonObject {
  return { ru: value?.ru ?? '', en: value?.en ?? '' };
}

function readLocalized(value: Prisma.JsonValue): LocalizedText {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ru: '', en: '' };
  }
  const record = value as Record<string, unknown>;
  return {
    ru: typeof record.ru === 'string' ? record.ru : '',
    en: typeof record.en === 'string' ? record.en : '',
  };
}

function readParams(value: Prisma.JsonValue): QuestParams | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as QuestParams;
}

function mapQuest(record: Quest): QuestInterface {
  return {
    id: record.id,
    type: record.type as QuestType,
    title: readLocalized(record.title),
    description: readLocalized(record.description),
    iconKind: record.iconKind,
    iconRef: record.iconRef,
    rewardType: record.rewardType,
    rewardAmount: record.rewardAmount,
    rewardPlanId: record.rewardPlanId,
    daysFallback: record.daysFallback,
    audienceFilter: normalizeAudienceFilter(record.audienceFilter),
    repeat: record.repeat,
    cooldownHours: record.cooldownHours,
    startAt: record.startAt?.toISOString() ?? null,
    endAt: record.endAt?.toISOString() ?? null,
    maxCompletionsGlobal: record.maxCompletionsGlobal,
    issuedCount: record.issuedCount,
    params: readParams(record.params),
    order: record.order,
    enabled: record.enabled,
    createdBy: record.createdBy,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
