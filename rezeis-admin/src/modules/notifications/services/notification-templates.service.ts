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
  readonly titleEn?: string | null;
  readonly bodyEn?: string | null;
  readonly buttons?: ReadonlyArray<unknown>;
  readonly bannerUrl?: string | null;
  readonly isActive?: boolean;
}

interface UpdateTemplateInput {
  readonly id: string;
  readonly title?: string;
  readonly body?: string;
  readonly titleEn?: string | null;
  readonly bodyEn?: string | null;
  readonly buttons?: ReadonlyArray<unknown>;
  readonly bannerUrl?: string | null;
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
    const writeFields: {
      title: string;
      body: string;
      isActive: boolean;
      titleEn?: string | null;
      bodyEn?: string | null;
      buttons?: Prisma.InputJsonValue;
      bannerUrl?: string | null;
    } = {
      title: input.title,
      body: input.body,
      isActive: input.isActive ?? true,
    };
    if (input.titleEn !== undefined) writeFields.titleEn = input.titleEn;
    if (input.bodyEn !== undefined) writeFields.bodyEn = input.bodyEn;
    if (input.buttons !== undefined) {
      writeFields.buttons = [...input.buttons] as unknown as Prisma.InputJsonValue;
    }
    if (input.bannerUrl !== undefined) writeFields.bannerUrl = normalizeBannerUrl(input.bannerUrl);
    const template = await this.prismaService.notificationTemplate.upsert({
      where: { type: input.type },
      create: { type: input.type, ...writeFields },
      update: writeFields,
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
    if (input.titleEn !== undefined) data.titleEn = input.titleEn;
    if (input.bodyEn !== undefined) data.bodyEn = input.bodyEn;
    if (input.buttons !== undefined) {
      data.buttons = [...input.buttons] as unknown as Prisma.InputJsonValue;
    }
    if (input.bannerUrl !== undefined) data.bannerUrl = normalizeBannerUrl(input.bannerUrl);
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
   * Inserts every catalog template that is not yet present, AND backfills
   * the new `titleEn` / `bodyEn` / `buttons` columns on existing rows that
   * still hold the migration defaults. The backfill is conservative — it
   * never touches a row whose EN copy or buttons column was already
   * authored by an operator (non-null EN string, non-empty buttons array).
   */
  public async seedDefaults(options: SeedDefaultsOptions = {}): Promise<SeedResult> {
    let created = 0;
    let skipped = 0;
    let backfilled = 0;
    for (const template of DEFAULT_NOTIFICATION_TEMPLATES) {
      const existing = await this.prismaService.notificationTemplate.findUnique({
        where: { type: template.type },
        select: { id: true, titleEn: true, bodyEn: true, buttons: true },
      });
      if (existing !== null) {
        skipped += 1;
        const patch = this.buildBackfillPatch(template, existing);
        if (patch !== null) {
          await this.prismaService.notificationTemplate.update({
            where: { id: existing.id },
            data: patch,
          });
          backfilled += 1;
        }
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
    if (backfilled > 0) {
      this.logger.log(
        `Backfilled new locale/buttons columns on ${backfilled} existing notification template(s)`,
      );
    }
    return { created, skipped };
  }

  /**
   * Decide whether to backfill the new columns on an existing row.
   * Returns `null` when nothing needs to change. The seed data is the
   * source of truth for stock rows; an operator edit (non-empty EN copy
   * or non-empty buttons array) wins and is preserved verbatim.
   */
  private buildBackfillPatch(
    catalog: DefaultNotificationTemplate,
    existing: {
      readonly titleEn: string | null;
      readonly bodyEn: string | null;
      readonly buttons: unknown;
    },
  ): Prisma.NotificationTemplateUpdateInput | null {
    const patch: Prisma.NotificationTemplateUpdateInput = {};
    if (
      existing.titleEn === null &&
      typeof catalog.titleEn === 'string' &&
      catalog.titleEn.length > 0
    ) {
      patch.titleEn = catalog.titleEn;
    }
    if (
      existing.bodyEn === null &&
      typeof catalog.bodyEn === 'string' &&
      catalog.bodyEn.length > 0
    ) {
      patch.bodyEn = catalog.bodyEn;
    }
    const existingButtons = Array.isArray(existing.buttons) ? existing.buttons : null;
    if (
      existingButtons !== null &&
      existingButtons.length === 0 &&
      (catalog.buttons?.length ?? 0) > 0
    ) {
      patch.buttons = [...catalog.buttons!] as unknown as Prisma.InputJsonValue;
    }
    return Object.keys(patch).length > 0 ? patch : null;
  }

  private fromCatalog(
    template: DefaultNotificationTemplate,
  ): Prisma.NotificationTemplateCreateInput {
    return {
      type: template.type,
      title: template.title,
      body: template.body,
      titleEn: template.titleEn ?? null,
      bodyEn: template.bodyEn ?? null,
      buttons: (template.buttons ?? []) as unknown as Prisma.InputJsonValue,
      isActive: true,
    };
  }
}

/** Normalize an operator-supplied banner reference: empty/whitespace → null. */
function normalizeBannerUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
