import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { FaqItem, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';

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
export class FaqService implements OnModuleInit {
  private readonly logger = new Logger(FaqService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Seed the standard FAQ once, on a fresh install, when the table is empty.
   *
   * Before this, the cabinet rendered a hardcoded fallback set while the admin
   * "FAQ" page showed an empty list — so the operator had nothing to edit and
   * the two could silently diverge. Seeding the same default Q&A (RU + EN) into
   * the DB makes the admin the single source of truth: the operator can edit,
   * reorder, translate, or delete the entries.
   *
   * Gated to the schedule-running role so the API and worker containers don't
   * race to seed in a split deployment; idempotent via the `count === 0` guard.
   */
  public async onModuleInit(): Promise<void> {
    if (!shouldRunSchedules()) return;
    try {
      const existing = await this.prismaService.faqItem.count();
      if (existing > 0) return;
      await this.prismaService.faqItem.createMany({ data: [...DEFAULT_FAQ_SEED] });
      this.logger.log(`Seeded ${DEFAULT_FAQ_SEED.length} default FAQ entries`);
    } catch (err: unknown) {
      this.logger.warn(
        `Default FAQ seed skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

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

/**
 * Standard FAQ seeded on a fresh install (RU + EN). Mirrors the cabinet's
 * built-in fallback so the admin panel is never empty out of the box. The
 * operator owns these once seeded — edits/translations/deletions stick.
 */
const DEFAULT_FAQ_SEED: readonly Prisma.FaqItemCreateManyInput[] = [
  {
    question: 'Как подключить VPN?',
    answer:
      'Купите подписку, нажмите «Подключить» на карточке подписки и скопируйте ссылку. Вставьте её в ваш VPN-клиент (V2RayNG, Hiddify, Streisand и др.).',
    locale: 'ru',
    orderIndex: 0,
    isActive: true,
    mediaUrls: [],
  },
  {
    question: 'Сколько устройств можно подключить?',
    answer:
      'Количество устройств зависит от вашего тарифного плана. Посмотреть лимит можно на карточке подписки.',
    locale: 'ru',
    orderIndex: 1,
    isActive: true,
    mediaUrls: [],
  },
  {
    question: 'Как продлить подписку?',
    answer:
      'Нажмите «Продлить» под карточкой подписки или купите новый план — он автоматически продлит текущую подписку.',
    locale: 'ru',
    orderIndex: 2,
    isActive: true,
    mediaUrls: [],
  },
  {
    question: 'Что делать если VPN не работает?',
    answer:
      'Попробуйте перегенерировать ссылку подключения. Если не помогло — создайте тикет в разделе «Поддержка».',
    locale: 'ru',
    orderIndex: 3,
    isActive: true,
    mediaUrls: [],
  },
  {
    question: 'How to connect VPN?',
    answer:
      'Purchase a subscription, tap "Connect" on the subscription card, and copy the link. Paste it into your VPN client (V2RayNG, Hiddify, Streisand, etc.).',
    locale: 'en',
    orderIndex: 0,
    isActive: true,
    mediaUrls: [],
  },
  {
    question: 'How many devices can I connect?',
    answer:
      'The number of devices depends on your plan. Check the limit on your subscription card.',
    locale: 'en',
    orderIndex: 1,
    isActive: true,
    mediaUrls: [],
  },
  {
    question: 'How to renew my subscription?',
    answer:
      'Tap "Renew" under the subscription card, or buy a new plan — it will automatically extend your current subscription.',
    locale: 'en',
    orderIndex: 2,
    isActive: true,
    mediaUrls: [],
  },
  {
    question: 'What if VPN is not working?',
    answer:
      'Try regenerating the connection link. If that doesn\'t help, create a ticket in the "Support" section.',
    locale: 'en',
    orderIndex: 3,
    isActive: true,
    mediaUrls: [],
  },
];
