import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsString } from 'class-validator';

import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../auth/interfaces/current-admin.interface';
import {
  AdminCategoryPreference,
  AdminNotificationPreferencesService,
} from './services/admin-notification-preferences.service';

class UpdatePreferenceDto {
  @IsString()
  public category!: string;

  @IsBoolean()
  public enabled!: boolean;
}

/**
 * Per-admin notification category preferences. Only categories the admin's
 * role permits are returned / tunable (RBAC-gated server-side).
 */
@ApiTags('admin/notifications')
@ApiBearerAuth()
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/notifications/preferences')
export class AdminNotificationPreferencesController {
  public constructor(private readonly service: AdminNotificationPreferencesService) {}

  @Get()
  @ApiOperation({ summary: 'List role-permitted notification categories + state' })
  public async list(
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<{ categories: readonly AdminCategoryPreference[] }> {
    const categories = await this.service.getForAdmin(admin);
    return { categories };
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable/disable a notification category for the current admin' })
  public async update(
    @Body() dto: UpdatePreferenceDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<{ categories: readonly AdminCategoryPreference[] }> {
    await this.service.setForAdmin(admin, dto.category, dto.enabled);
    const categories = await this.service.getForAdmin(admin);
    return { categories };
  }
}
