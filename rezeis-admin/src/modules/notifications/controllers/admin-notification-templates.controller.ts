import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { NotificationTemplate } from '@prisma/client';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import {
  CreateNotificationTemplateDto,
  UpdateNotificationTemplateDto,
} from '../dto/notification-template.dto';
import { NotificationTemplatesService } from '../services/notification-templates.service';

/**
 * AdminNotificationTemplatesController
 * ────────────────────────────────────
 * CRUD over the editable notification template catalog. The frontend
 * consumes this from `web/src/features/notifications/notifications-page.tsx`.
 *
 * The "seed" action upserts every catalog template that is not yet present
 * in the DB — operator edits survive subsequent seeds.
 */
@ApiTags('admin/notifications')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/notifications/templates')
export class AdminNotificationTemplatesController {
  public constructor(
    private readonly notificationTemplatesService: NotificationTemplatesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all notification templates' })
  public async list(): Promise<readonly NotificationTemplate[]> {
    return this.notificationTemplatesService.listAll();
  }

  @Post()
  @ApiOperation({ summary: 'Create a new template' })
  public create(@Body() body: CreateNotificationTemplateDto): Promise<NotificationTemplate> {
    return this.notificationTemplatesService.upsert({
      type: body.type,
      title: body.title,
      body: body.body,
      isActive: body.isActive ?? true,
    });
  }

  @Post('seed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Insert any default templates that are not present yet' })
  public seed(): Promise<{ readonly created: number; readonly skipped: number }> {
    return this.notificationTemplatesService.seedDefaults({ emitEvent: true });
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an existing template' })
  public update(
    @Param('id') id: string,
    @Body() body: UpdateNotificationTemplateDto,
  ): Promise<NotificationTemplate> {
    return this.notificationTemplatesService.update({
      id,
      title: body.title,
      body: body.body,
      isActive: body.isActive,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a template' })
  public async delete(@Param('id') id: string): Promise<void> {
    await this.notificationTemplatesService.delete(id);
  }
}
