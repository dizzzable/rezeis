import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import type { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import type { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { readCustomEmojiPacks } from '../../custom-emoji/utils/custom-emoji-packs.util';
import { buildSlotUsage } from '../utils/slot-usage.util';
import { BotEmojisService } from './bot-emojis.service';
import { BotTextsService } from './bot-texts.service';

/** Premium emoji preview joined from an imported pack (when the slot's
 *  `tgEmojiId` belongs to one). `null` for a bare/manual id. */
export interface SlotPremiumPreview {
  readonly slug: string;
  readonly name: string;
  readonly imageUrl: string;
  readonly lottieUrl: string | null;
  readonly videoUrl: string | null;
  readonly packName: string;
}

export interface EmojiStudioSlot {
  readonly id: string;
  readonly key: string;
  readonly unicode: string;
  readonly tgEmojiId: string | null;
  readonly premiumPreview: SlotPremiumPreview | null;
  readonly usedIn: readonly string[];
}

export interface EmojiStudioView {
  readonly slots: readonly EmojiStudioSlot[];
  readonly ownerHasPremium: boolean;
}

/**
 * BotEmojiStudioService
 * ─────────────────────
 * Composite read for the Bot Emoji Studio: every semantic emoji slot with its
 * fallback, premium id, a *preview* of that premium (joined to the imported
 * pack the id came from), and the blocks/screens that reference the slot.
 *
 * Packs are read via the pure `readCustomEmojiPacks` util (NOT the
 * CustomEmojiService) so this module never imports CustomEmojiModule — the
 * same cycle-avoidance the internal bot-config projection uses.
 */
@Injectable()
export class BotEmojiStudioService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly botEmojisService: BotEmojisService,
    private readonly botTextsService: BotTextsService,
  ) {}

  public async getStudio(): Promise<EmojiStudioView> {
    const [slots, texts, settings] = await Promise.all([
      this.botEmojisService.listAll(),
      this.botTextsService.listAll(),
      this.prismaService.settings.findFirst({ orderBy: { updatedAt: 'asc' } }),
    ]);

    const packs = readCustomEmojiPacks(settings?.systemNotifications);
    const previewById = indexPreviewsByEmojiId(packs);

    // Usage: code-driven sites + a scan of operator copy (bot texts).
    const usage = buildSlotUsage(
      texts.flatMap((t) => [
        { label: `text:${t.key}`, text: t.value ?? '' },
        { label: `text:${t.key}`, text: (t as { valueEn?: string | null }).valueEn ?? '' },
      ]),
    );

    return {
      ownerHasPremium: readOwnerHasPremium(settings?.systemNotifications),
      slots: slots.map((slot) => ({
        id: slot.id,
        key: slot.key,
        unicode: slot.unicode ?? '',
        tgEmojiId: slot.tgEmojiId !== null && slot.tgEmojiId.length > 0 ? slot.tgEmojiId : null,
        premiumPreview:
          slot.tgEmojiId !== null && slot.tgEmojiId.length > 0
            ? previewById.get(slot.tgEmojiId) ?? null
            : null,
        usedIn: usage[slot.key] ?? [],
      })),
    };
  }

  /**
   * Set the panel-managed "bot owner has Telegram Premium" flag (merged into
   * `Settings.systemNotifications.botEmoji`). When off, reiwa strips
   * `custom_emoji` entities so a non-premium owner's messages never fail to
   * send. Audited; the singleton settings row is expected to exist.
   */
  public async setOwnerHasPremium(input: {
    readonly enabled: boolean;
    readonly admin: CurrentAdminInterface;
    readonly requestMetadata: RequestMetadataInterface;
  }): Promise<boolean> {
    const settings = await this.prismaService.settings.findFirst({
      orderBy: { updatedAt: 'asc' },
      select: { id: true, systemNotifications: true },
    });
    if (settings === null) return input.enabled;

    const sys =
      typeof settings.systemNotifications === 'object' && settings.systemNotifications !== null
        ? (settings.systemNotifications as Record<string, unknown>)
        : {};
    const botEmoji =
      typeof sys.botEmoji === 'object' && sys.botEmoji !== null
        ? (sys.botEmoji as Record<string, unknown>)
        : {};
    const next = { ...sys, botEmoji: { ...botEmoji, ownerHasPremium: input.enabled } };

    await this.prismaService.$transaction([
      this.prismaService.settings.update({
        where: { id: settings.id },
        data: { systemNotifications: next as Prisma.InputJsonValue },
      }),
      this.prismaService.adminAuditLog.create({
        data: {
          action: 'bot_config.emoji.ownerPremium',
          ipAddress: input.requestMetadata.remoteAddress,
          userAgent: input.requestMetadata.userAgent,
          metadata: {
            requestId: input.requestMetadata.requestId,
            ownerHasPremium: input.enabled,
          } as Prisma.InputJsonObject,
          adminUser: { connect: { id: input.admin.id } },
        },
      }),
    ]);
    return input.enabled;
  }
}

/** Index imported pack emoji by their Telegram `customEmojiId` for preview joins. */
function indexPreviewsByEmojiId(
  packs: ReadonlyArray<{
    readonly name: string;
    readonly emojis: ReadonlyArray<{
      readonly slug: string;
      readonly name: string;
      readonly imageUrl: string;
      readonly lottieUrl: string | null;
      readonly videoUrl: string | null;
      readonly customEmojiId: string | null;
    }>;
  }>,
): Map<string, SlotPremiumPreview> {
  const index = new Map<string, SlotPremiumPreview>();
  for (const pack of packs) {
    for (const emoji of pack.emojis) {
      if (emoji.customEmojiId !== null && emoji.customEmojiId.length > 0) {
        index.set(emoji.customEmojiId, {
          slug: emoji.slug,
          name: emoji.name,
          imageUrl: emoji.imageUrl,
          lottieUrl: emoji.lottieUrl,
          videoUrl: emoji.videoUrl,
          packName: pack.name,
        });
      }
    }
  }
  return index;
}

/** Read the optional owner-premium flag (default true) from settings JSON. */
function readOwnerHasPremium(systemNotifications: unknown): boolean {
  if (typeof systemNotifications !== 'object' || systemNotifications === null) return true;
  const botEmoji = (systemNotifications as Record<string, unknown>).botEmoji;
  if (typeof botEmoji !== 'object' || botEmoji === null) return true;
  const flag = (botEmoji as Record<string, unknown>).ownerHasPremium;
  return typeof flag === 'boolean' ? flag : true;
}
