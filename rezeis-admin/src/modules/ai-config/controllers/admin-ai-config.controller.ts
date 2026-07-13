import { Controller, Get, Patch, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { AiConfigService } from '../services/ai-config.service.js';
import { AiLearningService } from '../services/ai-learning.service.js';
import { UpdateAiConfigDto } from '../dto/update-ai-config.dto.js';
import { LearnFromTicketsDto } from '../dto/learn-from-tickets.dto.js';

@Controller('admin/ai-config')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('settings', 'edit')
export class AdminAiConfigController {
  public constructor(
    private readonly aiConfigService: AiConfigService,
    private readonly aiLearningService: AiLearningService,
  ) {}

  @Get()
  async getSettings() {
    // Masked — the raw provider key must never reach the admin SPA/browser.
    return this.aiConfigService.getSettingsMasked();
  }

  @Patch()
  async updateSettings(@Body() dto: UpdateAiConfigDto) {
    await this.aiConfigService.updateSettings(dto);
    // Echo back the masked view (a blank/masked apiKey kept the existing key).
    return this.aiConfigService.getSettingsMasked();
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

  /**
   * Learn from closed support tickets: distils anonymised Q→A DRAFT
   * instructions (isActive:false) for the operator to review and activate.
   * Nothing generated here reaches users until an operator turns it on.
   */
  @Post('learn-from-tickets')
  @HttpCode(HttpStatus.OK)
  async learnFromTickets(@Body() dto: LearnFromTicketsDto) {
    return this.aiLearningService.learnFromTickets(dto.limit ?? 30);
  }
}
