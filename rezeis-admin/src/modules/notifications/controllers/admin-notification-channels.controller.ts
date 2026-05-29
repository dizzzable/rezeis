import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BotNotificationChannel } from '@prisma/client';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import {
  CreateBotNotificationChannelDto,
  UpdateBotNotificationChannelDto,
} from '../dto/notification-channel.dto';
import { BotNotificationChannelsService } from '../services/bot-notification-channels.service';

/**
 * AdminNotificationChannelsController
 * ───────────────────────────────────
 * Operator-facing CRUD for Telegram broadcast destinations. Each
 * row is a chat / channel / forum-topic the bot forwards
 * `UserNotificationEvent`s to (filtered by `kindFilter`). Useful for
 * "operations channel" patterns where the team wants payment events,
 * partner earnings, etc. mirrored into a private group.
 */
@ApiTags('admin/notifications/channels')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/notifications/channels')
export class AdminNotificationChannelsController {
  public constructor(
    private readonly channelsService: BotNotificationChannelsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all bot notification channels' })
  public listAll(): Promise<BotNotificationChannel[]> {
    return this.channelsService.listAll();
  }

  @Post()
  @ApiOperation({ summary: 'Create a new notification channel' })
  public create(
    @Body() body: CreateBotNotificationChannelDto,
  ): Promise<BotNotificationChannel> {
    return this.channelsService.create({
      name: body.name,
      chatId: body.chatId,
      topicThreadId: body.topicThreadId ?? null,
      kindFilter: body.kindFilter ?? [],
      isActive: body.isActive,
    });
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a notification channel' })
  public update(
    @Param('id') id: string,
    @Body() body: UpdateBotNotificationChannelDto,
  ): Promise<BotNotificationChannel> {
    return this.channelsService.update({
      id,
      name: body.name,
      chatId: body.chatId,
      topicThreadId: body.topicThreadId,
      kindFilter: body.kindFilter,
      isActive: body.isActive,
    });
  }

  @Post(':id/delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a notification channel (POST form for legacy clients)' })
  public deleteChannelPost(@Param('id') id: string): Promise<void> {
    return this.channelsService.delete(id);
  }
}
