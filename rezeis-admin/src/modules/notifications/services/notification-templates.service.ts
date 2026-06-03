import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { NotificationTemplate, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';

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

interface SeedDefaultsOptions {
  readonly emitEvent?: boolean;
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

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly events: SystemEventsService,
  ) {}

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
    const existing = await this.prismaService.notificationTemplate.findUnique({
      where: { type: input.type },
      select: { id: true },
    });
    const template = await this.prismaService.notificationTemplate.upsert({
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
    this.events.info(
      existing === null
        ? EVENT_TYPES.NOTIFICATION_TEMPLATE_CREATED
        : EVENT_TYPES.NOTIFICATION_TEMPLATE_UPDATED,
      'SYSTEM',
      existing === null ? 'Notification template created' : 'Notification template updated',
      { templateId: template.id, type: template.type },
    );
    return template;
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
    const template = await this.prismaService.notificationTemplate.update({
      where: { id: input.id },
      data,
    });
    this.events.info(
      EVENT_TYPES.NOTIFICATION_TEMPLATE_UPDATED,
      'SYSTEM',
      'Notification template updated',
      { templateId: template.id, type: template.type },
    );
    return template;
  }

  public async delete(id: string): Promise<void> {
    const template = await this.prismaService.notificationTemplate.delete({ where: { id } });
    this.events.info(
      EVENT_TYPES.NOTIFICATION_TEMPLATE_DELETED,
      'SYSTEM',
      'Notification template deleted',
      { templateId: template.id, type: template.type },
    );
  }

  /**
   * Inserts every catalog template that is not yet present. Existing rows
   * are intentionally left alone so operator edits survive a re-seed.
   */
  public async seedDefaults(options: SeedDefaultsOptions = {}): Promise<SeedResult> {
    let created = 0;
    let skipped = 0;
    for (const template of DEFAULT_NOTIFICATION_TEMPLATES) {
      const existing = await this.prismaService.notificationTemplate.findUnique({
        where: { type: template.type },
        select: { id: true },
      });
      if (existing !== null) {
        skipped += 1;
        continue;
      }
      await this.prismaService.notificationTemplate.upsert({
        where: { type: template.type },
        create: this.fromCatalog(template),
        update: {},
      });
      created += 1;
    }
    if (options.emitEvent === true && created > 0) {
      this.events.info(EVENT_TYPES.NOTIFICATION_TEMPLATE_SEEDED, 'SYSTEM', 'Notification templates seeded', {
        created,
        skipped,
      });
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
