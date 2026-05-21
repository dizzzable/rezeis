import { Injectable, NotFoundException } from '@nestjs/common';
import { FaqItem, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

export interface FaqItemInterface {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  /**
   * Ordered list of attachment URLs. Each entry can be a relative path
   * (`/uploads/faq/<file>`) for assets uploaded through the admin panel
   * or an absolute URL for externally hosted media. Empty array when
   * the entry has no attachments.
   */
  readonly mediaUrls: readonly string[];
  readonly orderIndex: number;
  readonly isActive: boolean;
  readonly locale: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

@Injectable()
export class FaqService {
  public constructor(private readonly prismaService: PrismaService) {}

  /** Returns all active FAQ items for a given locale (or all if locale is null). */
  public async getPublicFaq(locale?: string | null): Promise<readonly FaqItemInterface[]> {
    const where: Prisma.FaqItemWhereInput = { isActive: true };
    if (locale) {
      where.OR = [{ locale }, { locale: null }];
    }
    const items = await this.prismaService.faqItem.findMany({
      where,
      orderBy: { orderIndex: 'asc' },
    });
    return items.map(mapFaqItem);
  }

  /** Returns all FAQ items (admin view, includes inactive). */
  public async listAll(): Promise<readonly FaqItemInterface[]> {
    const items = await this.prismaService.faqItem.findMany({
      orderBy: [{ orderIndex: 'asc' }, { createdAt: 'desc' }],
    });
    return items.map(mapFaqItem);
  }

  /** Creates a new FAQ item. */
  public async create(input: {
    question: string;
    answer: string;
    mediaUrls?: readonly string[];
    orderIndex?: number;
    locale?: string | null;
    isActive?: boolean;
  }): Promise<FaqItemInterface> {
    const item = await this.prismaService.faqItem.create({
      data: {
        question: input.question,
        answer: input.answer,
        mediaUrls: input.mediaUrls ? [...input.mediaUrls] : [],
        orderIndex: input.orderIndex ?? 0,
        locale: input.locale ?? null,
        isActive: input.isActive ?? true,
      },
    });
    return mapFaqItem(item);
  }

  /** Updates an existing FAQ item. */
  public async update(
    id: string,
    input: Partial<{
      question: string;
      answer: string;
      mediaUrls: readonly string[];
      orderIndex: number;
      isActive: boolean;
      locale: string | null;
    }>,
  ): Promise<FaqItemInterface> {
    const existing = await this.prismaService.faqItem.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('FAQ item not found');
    const data: Prisma.FaqItemUpdateInput = {};
    if (input.question !== undefined) data.question = input.question;
    if (input.answer !== undefined) data.answer = input.answer;
    if (input.mediaUrls !== undefined) data.mediaUrls = { set: [...input.mediaUrls] };
    if (input.orderIndex !== undefined) data.orderIndex = input.orderIndex;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.locale !== undefined) data.locale = input.locale;
    const updated = await this.prismaService.faqItem.update({
      where: { id },
      data,
    });
    return mapFaqItem(updated);
  }

  /** Deletes a FAQ item. */
  public async delete(id: string): Promise<void> {
    const existing = await this.prismaService.faqItem.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('FAQ item not found');
    await this.prismaService.faqItem.delete({ where: { id } });
  }
}

function mapFaqItem(record: FaqItem): FaqItemInterface {
  return {
    id: record.id,
    question: record.question,
    answer: record.answer,
    mediaUrls: record.mediaUrls,
    orderIndex: record.orderIndex,
    isActive: record.isActive,
    locale: record.locale,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
