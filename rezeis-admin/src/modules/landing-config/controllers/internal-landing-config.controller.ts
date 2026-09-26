import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { RETIRED_LANDING_ANSWER, type RetiredLandingAnswer } from '../landing-retired';

/**
 * InternalLandingConfigController — RETIRED, answers a constant
 * ─────────────────────────────────────────────────────────────
 * The landing is gone (0.9.7.71). This route stays only for cabinets up to
 * 0.9.7.53, which still read it: it always answers `{"enabled":false}`, the
 * "nothing published" answer they turn into "`/` opens sign-in". Why an answer
 * and not a 404, and when the route may go: `../landing-retired.ts`.
 *
 * No constructor and no service on purpose: it cannot read the landing tables,
 * so nothing an operator left in them can reach a visitor again.
 *
 * Same path, same guard and same throttling as before, so an old cabinet sees
 * no difference other than the answer. Auth: `InternalAdminAuthGuard` — the
 * Bearer api_token reiwa uses for branding / platform-policy.
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
  @Get('effective')
  @ApiOperation({
    summary: 'Retired landing: always {"enabled":false}, read by cabinets up to 0.9.7.53',
  })
  // Async because the settings-version source that reads this handler awaits
  // a promise (`config-version-sources.ts`). A fresh object per call, so no
  // caller can mutate what the next one is served.
  public async getEffective(): Promise<RetiredLandingAnswer> {
    return { ...RETIRED_LANDING_ANSWER };
  }
}
