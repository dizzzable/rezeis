import { Controller, Get, Patch, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { AiConfigService } from '../services/ai-config.service.js';
import { UpdateAiConfigDto } from '../dto/update-ai-config.dto.js';

@Controller('admin/ai-config')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('settings', 'edit')
export class AdminAiConfigController {
  public constructor(private readonly aiConfigService: AiConfigService) {}

  @Get()
  async getSettings() {
    return this.aiConfigService.getSettings();
  }

  @Patch()
  async updateSettings(@Body() dto: UpdateAiConfigDto) {
    return this.aiConfigService.updateSettings(dto);
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  async testConnection() {
    return this.aiConfigService.testConnection();
  }

  @Get('models')
  async fetchModels() {
    return this.aiConfigService.fetchModels();
  }
}
