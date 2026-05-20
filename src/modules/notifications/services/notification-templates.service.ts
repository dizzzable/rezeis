import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { NotificationTemplate, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

import {
  DEFAULT_NOTIFICATION_TEMPLATES,
  DefaultNotificationTemplate,
} from '../catalog/default-templates.catalog';

interface UpsertTemplateInput {
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly isActive?: boolean;
}

interface UpdateTemplateInput {
  readonly id: string;
  readonly title?: string;
  readonly body?: string;
  readonly isActive?: boolean;
}

interface SeedResult {
  readonly created: number;
  readonly skipped: number;
}

/**
 * Backing store for editable notification message templates.
 *
 * The `type` column is unique and used by emitters as a stable key
 * (`expires_in_3_days`, `payment.completed`, …). The catalog of default
 * templates lives in `catalog/default-templates.catalog.ts` and is the only
 * source the operator-facing "seed" action consults.
 */
@Injectable()
export class NotificationTemplatesService implements OnModuleInit {
  private readonly logger = new Logger(NotificationTemplatesService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  public async onModuleInit(): Promise<void> {
    const result = await this.seedDefaults();
    if (result.created > 0) {
      this.logger.log(`Auto-seeded ${result.created} notification templates (${result.skipped} already existed)`);
    }
  }

  public listAll(): Promise<NotificationTemplate[]> {
    return this.prismaService.notificationTemplate.findMany({
      orderBy: [{ isActive: 'desc' }, { type: 'asc' }],
    });
  }

  public async getByType(type: string): Promise<NotificationTemplate | null> {
    return this.prismaService.notificationTemplate.findUnique({ where: { type } });
  }

  public async upsert(input: UpsertTemplateInput): Promise<NotificationTemplate> {
    return this.prismaService.notificationTemplate.upsert({
      where: { type: input.type },
      create: {
        type: input.type,
        title: input.title,
        body: input.body,
        isActive: input.isActive ?? true,
      },
      update: {
        title: input.title,
        body: input.body,
        isActive: input.isActive ?? true,
      },
    });
  }

  public async update(input: UpdateTemplateInput): Promise<NotificationTemplate> {
    const existing = await this.prismaService.notificationTemplate.findUnique({
      where: { id: input.id },
    });
    if (existing === null) {
      throw new NotFoundException('Notification template not found');
    }
    const data: Prisma.NotificationTemplateUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.body !== undefined) data.body = input.body;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    return this.prismaService.notificationTemplate.update({
      where: { id: input.id },
      data,
    });
  }

  public async delete(id: string): Promise<void> {
    await this.prismaService.notificationTemplate.delete({ where: { id } });
  }

  /**
   * Inserts every catalog template that is not yet present. Existing rows
   * are intentionally left alone so operator edits survive a re-seed.
   */
  public async seedDefaults(): Promise<SeedResult> {
    let created = 0;
    let skipped = 0;
    for (const template of DEFAULT_NOTIFICATION_TEMPLATES) {
      const result = await this.prismaService.notificationTemplate.upsert({
        where: { type: template.type },
        create: this.fromCatalog(template),
        update: {},
      });
      if (result.createdAt.getTime() === result.updatedAt.getTime()) {
        created += 1;
      } else {
        skipped += 1;
      }
    }
    return { created, skipped };
  }

  private fromCatalog(
    template: DefaultNotificationTemplate,
  ): Prisma.NotificationTemplateCreateInput {
    return {
      type: template.type,
      title: template.title,
      body: template.body,
      isActive: true,
    };
  }
}
