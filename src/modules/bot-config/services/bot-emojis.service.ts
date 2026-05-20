import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BotEmoji, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

interface CreateEmojiInput {
  readonly key: string;
  readonly unicode: string;
  readonly tgEmojiId?: string | null;
}

interface UpdateEmojiInput {
  readonly id: string;
  readonly key?: string;
  readonly unicode?: string;
  readonly tgEmojiId?: string | null;
}

const EMOJI_KEY_REGEX = /^[A-Z][A-Z0-9_]*$/;

@Injectable()
export class BotEmojisService {
  public constructor(private readonly prismaService: PrismaService) {}

  public listAll(): Promise<BotEmoji[]> {
    return this.prismaService.botEmoji.findMany({ orderBy: { key: 'asc' } });
  }

  public async create(input: CreateEmojiInput): Promise<BotEmoji> {
    const normalisedKey = input.key.toUpperCase();
    if (!EMOJI_KEY_REGEX.test(normalisedKey)) {
      throw new BadRequestException('key must match /^[A-Z][A-Z0-9_]*$/');
    }
    const existing = await this.prismaService.botEmoji.findUnique({
      where: { key: normalisedKey },
    });
    if (existing !== null) {
      throw new BadRequestException(`Emoji with key "${normalisedKey}" already exists`);
    }
    return this.prismaService.botEmoji.create({
      data: {
        key: normalisedKey,
        unicode: input.unicode,
        tgEmojiId: input.tgEmojiId ?? null,
      },
    });
  }

  public async update(input: UpdateEmojiInput): Promise<BotEmoji> {
    const existing = await this.prismaService.botEmoji.findUnique({ where: { id: input.id } });
    if (existing === null) {
      throw new NotFoundException('Bot emoji not found');
    }
    const data: Prisma.BotEmojiUpdateInput = {};
    if (input.key !== undefined) {
      const normalised = input.key.toUpperCase();
      if (!EMOJI_KEY_REGEX.test(normalised)) {
        throw new BadRequestException('key must match /^[A-Z][A-Z0-9_]*$/');
      }
      data.key = normalised;
    }
    if (input.unicode !== undefined) data.unicode = input.unicode;
    if (input.tgEmojiId !== undefined) {
      data.tgEmojiId = input.tgEmojiId === '' ? null : input.tgEmojiId;
    }
    return this.prismaService.botEmoji.update({ where: { id: input.id }, data });
  }

  public async delete(id: string): Promise<void> {
    const existing = await this.prismaService.botEmoji.findUnique({ where: { id } });
    if (existing === null) {
      throw new NotFoundException('Bot emoji not found');
    }
    await this.prismaService.botEmoji.delete({ where: { id } });
  }
}
