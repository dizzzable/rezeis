import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BotText, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

interface CreateTextInput {
  readonly key: string;
  readonly value: string;
  readonly visible?: boolean;
}

interface UpdateTextInput {
  readonly id: string;
  readonly key?: string;
  readonly value?: string;
  readonly visible?: boolean;
}

const TEXT_KEY_REGEX = /^[a-z0-9._-]+$/i;

@Injectable()
export class BotTextsService {
  public constructor(private readonly prismaService: PrismaService) {}

  public listAll(): Promise<BotText[]> {
    return this.prismaService.botText.findMany({ orderBy: { key: 'asc' } });
  }

  public async create(input: CreateTextInput): Promise<BotText> {
    if (!TEXT_KEY_REGEX.test(input.key)) {
      throw new BadRequestException('key must be alphanumeric (._- allowed)');
    }
    const existing = await this.prismaService.botText.findUnique({ where: { key: input.key } });
    if (existing !== null) {
      throw new BadRequestException(`Text with key "${input.key}" already exists`);
    }
    return this.prismaService.botText.create({
      data: {
        key: input.key,
        value: input.value,
        visible: input.visible ?? true,
      },
    });
  }

  public async update(input: UpdateTextInput): Promise<BotText> {
    const existing = await this.prismaService.botText.findUnique({ where: { id: input.id } });
    if (existing === null) {
      throw new NotFoundException('Bot text not found');
    }
    const data: Prisma.BotTextUpdateInput = {};
    if (input.key !== undefined) {
      if (!TEXT_KEY_REGEX.test(input.key)) {
        throw new BadRequestException('key must be alphanumeric (._- allowed)');
      }
      data.key = input.key;
    }
    if (input.value !== undefined) data.value = input.value;
    if (input.visible !== undefined) data.visible = input.visible;
    return this.prismaService.botText.update({ where: { id: input.id }, data });
  }

  public async delete(id: string): Promise<void> {
    const existing = await this.prismaService.botText.findUnique({ where: { id } });
    if (existing === null) {
      throw new NotFoundException('Bot text not found');
    }
    await this.prismaService.botText.delete({ where: { id } });
  }
}
