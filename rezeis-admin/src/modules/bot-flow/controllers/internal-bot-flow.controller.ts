import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { BotFlowService } from '../services/bot-flow.service';

/**
 * Internal API consumed by reiwa bot runtime.
 * Returns the published flow graph for rendering inline keyboards.
 */
@ApiTags('Internal — Bot Flow')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/bot-flows')
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalBotFlowController {
  public constructor(private readonly flowService: BotFlowService) {}

  @Get('published/:name')
  @ApiOperation({ summary: 'Get published flow by name (for bot runtime)' })
  public getPublished(@Param('name') name: string) {
    return this.flowService.getPublished(name);
  }
}
