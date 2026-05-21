import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { BotFlowService } from '../services/bot-flow.service';

/**
 * Internal API consumed by reiwa bot runtime.
 * Returns the published flow graph for rendering inline keyboards.
 */
@ApiTags('Internal — Bot Flow')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/bot-flows')
export class InternalBotFlowController {
  public constructor(private readonly flowService: BotFlowService) {}

  @Get('published/:name')
  @ApiOperation({ summary: 'Get published flow by name (for bot runtime)' })
  public getPublished(@Param('name') name: string) {
    return this.flowService.getPublished(name);
  }
}
