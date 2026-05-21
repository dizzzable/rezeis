import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BotButton, BotButtonStyle, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

interface CreateButtonInput {
  readonly buttonId: string;
  readonly label: string;
  readonly style?: BotButtonStyle;
  readonly iconCustomEmojiId?: string | null;
  readonly visible?: boolean;
  readonly onePerRow?: boolean;
  readonly orderIndex?: number;
}

interface UpdateButtonInput {
  readonly id: string;
  readonly label?: string;
  readonly style?: BotButtonStyle;
  readonly iconCustomEmojiId?: string | null;
  readonly visible?: boolean;
  readonly onePerRow?: boolean;
  readonly orderIndex?: number;
}

const BUTTON_ID_REGEX = /^[a-z0-9._-]+$/i;

@Injectable()
export class BotButtonsService {
  public constructor(private readonly prismaService: PrismaService) {}

  public listAll(): Promise<BotButton[]> {
    return this.prismaService.botButton.findMany({
      orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
    });
  }

  public async create(input: CreateButtonInput): Promise<BotButton> {
    if (!BUTTON_ID_REGEX.test(input.buttonId)) {
      throw new BadRequestException('buttonId must be alphanumeric (._- allowed)');
    }
    const existing = await this.prismaService.botButton.findUnique({
      where: { buttonId: input.buttonId },
    });
    if (existing !== null) {
      throw new BadRequestException(`Button with id "${input.buttonId}" already exists`);
    }
    const tail = await this.prismaService.botButton.findFirst({
      orderBy: { orderIndex: 'desc' },
      select: { orderIndex: true },
    });
    return this.prismaService.botButton.create({
      data: {
        buttonId: input.buttonId,
        label: input.label,
        style: input.style ?? BotButtonStyle.PRIMARY,
        iconCustomEmojiId: input.iconCustomEmojiId ?? null,
        visible: input.visible ?? true,
        onePerRow: input.onePerRow ?? false,
        orderIndex: input.orderIndex ?? (tail?.orderIndex ?? -1) + 1,
      },
    });
  }

  public async update(input: UpdateButtonInput): Promise<BotButton> {
    const existing = await this.prismaService.botButton.findUnique({ where: { id: input.id } });
    if (existing === null) {
      throw new NotFoundException('Bot button not found');
    }
    const data: Prisma.BotButtonUpdateInput = {};
    if (input.label !== undefined) data.label = input.label;
    if (input.style !== undefined) data.style = input.style;
    if (input.iconCustomEmojiId !== undefined) {
      data.iconCustomEmojiId = input.iconCustomEmojiId === '' ? null : input.iconCustomEmojiId;
    }
    if (input.visible !== undefined) data.visible = input.visible;
    if (input.onePerRow !== undefined) data.onePerRow = input.onePerRow;
    if (input.orderIndex !== undefined) data.orderIndex = input.orderIndex;
    return this.prismaService.botButton.update({ where: { id: input.id }, data });
  }

  public async delete(id: string): Promise<void> {
    const existing = await this.prismaService.botButton.findUnique({ where: { id } });
    if (existing === null) {
      throw new NotFoundException('Bot button not found');
    }
    await this.prismaService.botButton.delete({ where: { id } });
  }
}
