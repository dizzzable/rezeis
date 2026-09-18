import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { SubpageConfigService } from '../services/subpage-config.service';

/**
 * InternalSubpageConfigController
 * ───────────────────────────────
 * Service-facing read endpoint consumed by rezeis-subpage. The subpage fetches
 * the effective config here on boot, on its TTL refresh, and on invalidate.
 *
 * Auth: `InternalAdminAuthGuard` — the same Bearer api_token mechanism reiwa
 * uses. Operators mint a "Subpage" API token in "Settings → API tokens" and put
 * it in the subpage's `REZEIS_ADMIN_TOKEN`.
 */
@ApiTags('internal/subpage-config')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/subpage-config')
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalSubpageConfigController {
  public constructor(private readonly subpageConfigService: SubpageConfigService) {}

  @Get('effective')
  @ApiOperation({ summary: 'Effective subscription-page config consumed by rezeis-subpage' })
  public async getEffective(): Promise<Record<string, unknown>> {
    return this.subpageConfigService.getEffectiveConfig();
  }
}
