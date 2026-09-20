import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../auth/interfaces/current-admin.interface';
import {
  ADMIN_NOTIFICATION_CATEGORIES,
  type AdminNotificationCategory,
} from '../push/admin-notification-categories';
import { AdminNotificationInboxService, type InboxPage } from './services/admin-notification-inbox.service';

const CATEGORY_NAMES: readonly string[] = ADMIN_NOTIFICATION_CATEGORIES.map((def) => def.category);

/**
 * A query string carries text, so `?unreadOnly=false` arrives as the non-empty
 * string `'false'` — truthy to every naive reader, and the filter then does the
 * opposite of what it says. Anything that is not one of the four spellings is
 * `undefined`, which `@IsOptional()` lets through as "not asked for".
 */
function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

class ListNotificationsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  public limit?: number;

  /** The id of the last row of the previous page. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  public cursor?: string;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  public unreadOnly?: boolean;

  /**
   * One of the five push categories. Validated against the same list the
   * preferences screen offers, so a typo answers 400 rather than an empty
   * inbox the operator would read as "nothing happened".
   */
  @IsOptional()
  @IsIn(CATEGORY_NAMES)
  public category?: AdminNotificationCategory;
}

class ClearNotificationsQueryDto {
  /** `true` clears only what has been read; otherwise the whole inbox goes. */
  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  public readOnly?: boolean;
}

const DEFAULT_PAGE = 20;

/**
 * The panel's notification centre — one operator's own alerts.
 *
 * Every route is scoped to the admin on the token, and the scope is part of
 * the WHERE rather than a check after reading: an id from the client that
 * names somebody else's copy matches nothing, which is the same answer as an
 * id that never existed. Nothing here can read, mark or delete another
 * operator's inbox.
 */
@ApiTags('admin/notifications')
@ApiBearerAuth()
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/notifications/inbox')
export class AdminNotificationsController {
  public constructor(private readonly inbox: AdminNotificationInboxService) {}

  @Get()
  @ApiOperation({ summary: 'The current admin’s alerts, newest first' })
  public async list(
    @Query() query: ListNotificationsQueryDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<InboxPage> {
    return this.inbox.list(admin.id, {
      limit: query.limit ?? DEFAULT_PAGE,
      cursor: query.cursor,
      unreadOnly: query.unreadOnly,
      category: query.category,
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'How many of them are unread — the badge on the bell' })
  public async unreadCount(@CurrentAdmin() admin: CurrentAdminInterface): Promise<{ unread: number }> {
    return { unread: await this.inbox.unreadCount(admin.id) };
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark every unread alert of the current admin as read' })
  public async readAll(@CurrentAdmin() admin: CurrentAdminInterface): Promise<{ marked: number; unread: number }> {
    const marked = await this.inbox.markAllRead(admin.id);
    return { marked, unread: await this.inbox.unreadCount(admin.id) };
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark one alert as read' })
  public async read(
    @Param('id') id: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<{ marked: number; unread: number }> {
    const marked = await this.inbox.markRead(admin.id, id);
    return { marked, unread: await this.inbox.unreadCount(admin.id) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete one alert from the current admin’s inbox' })
  public async remove(
    @Param('id') id: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<{ removed: number; unread: number }> {
    const removed = await this.inbox.remove(admin.id, id);
    return { removed, unread: await this.inbox.unreadCount(admin.id) };
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Clear the inbox — everything, or only what was read' })
  public async clear(
    @Query() query: ClearNotificationsQueryDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<{ removed: number; unread: number }> {
    const removed = await this.inbox.clear(admin.id, { readOnly: query.readOnly === true });
    return { removed, unread: await this.inbox.unreadCount(admin.id) };
  }
}
