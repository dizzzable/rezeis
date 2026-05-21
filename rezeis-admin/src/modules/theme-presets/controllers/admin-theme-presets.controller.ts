import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { SaveThemePresetDto, UpdateThemePresetDto } from '../dto/save-theme-preset.dto';
import { AdminThemePresetInterface } from '../interfaces/admin-theme-preset.interface';
import { ThemePresetsService } from '../services/theme-presets.service';

@Controller('admin/theme-presets')
@UseGuards(AdminJwtAuthGuard)
export class AdminThemePresetsController {
  public constructor(private readonly themePresetsService: ThemePresetsService) {}

  @Get()
  public async list(
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
  ): Promise<readonly AdminThemePresetInterface[]> {
    return this.themePresetsService.listPresets(currentAdmin);
  }

  @Post()
  public async create(
    @Body() input: SaveThemePresetDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
  ): Promise<AdminThemePresetInterface> {
    return this.themePresetsService.createPreset(input, currentAdmin);
  }

  @Patch(':id')
  public async update(
    @Param('id') id: string,
    @Body() input: UpdateThemePresetDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
  ): Promise<AdminThemePresetInterface> {
    return this.themePresetsService.updatePreset(id, input, currentAdmin);
  }

  @Delete(':id')
  public async delete(
    @Param('id') id: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
  ): Promise<{ readonly deleted: true }> {
    await this.themePresetsService.deletePreset(id, currentAdmin);
    return { deleted: true } as const;
  }
}
