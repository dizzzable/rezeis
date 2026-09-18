import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { LandingConfigService } from '../services/landing-config.service';
import type { EffectiveLandingPayload } from '../landing-config.schema';

/**
 * InternalLandingConfigController
 * ───────────────────────────────
 * Service-facing read endpoint consumed by the reiwa BFF. reiwa fetches the
 * effective PUBLISHED config here (or the `{ enabled: false }` sentinel), caches
 * it with a short TTL, and refreshes on the `reiwa.landing.invalidate` webhook.
 *
 * Auth: `InternalAdminAuthGuard` — the same Bearer api_token mechanism reiwa
 * uses for branding / platform-policy.
 */
@ApiTags('internal/landing-config')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/landing-config')
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalLandingConfigController {
  public constructor(private readonly landingConfigService: LandingConfigService) {}

  @Get('effective')
  @ApiOperation({ summary: 'Effective published landing config consumed by reiwa' })
  public async getEffective(): Promise<EffectiveLandingPayload> {
    return this.landingConfigService.getEffectivePublished();
  }
}
