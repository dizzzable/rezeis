import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { UpdatePlatformSettingsDto } from '../dto/update-platform-settings.dto';
import { PlatformSettingsInterface } from '../interfaces/platform-settings.interface';
import { SettingsService } from '../services/settings.service';

/**
 * Exposes JWT-protected platform settings endpoints for the admin panel.
 */
@Controller('admin/settings')
@UseGuards(AdminJwtAuthGuard)
export class SettingsController {
  public constructor(private readonly settingsService: SettingsService) {}

  /**
   * Returns the singleton platform settings payload.
   */
  @Get('platform')
  public async getPlatformSettings(): Promise<PlatformSettingsInterface> {
    return this.settingsService.getPlatformSettings();
  }

  /**
   * Updates the singleton platform settings payload.
   */
  @Patch('platform')
  public async updatePlatformSettings(
    @Body() updatePlatformSettingsDto: UpdatePlatformSettingsDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<PlatformSettingsInterface> {
    return this.settingsService.updatePlatformSettings({
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
      updatePlatformSettingsDto,
    });
  }
}
