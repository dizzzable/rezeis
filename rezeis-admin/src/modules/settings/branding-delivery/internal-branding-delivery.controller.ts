import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { readBrandingDeliveryReport } from './branding-delivery-report';
import { BrandingDeliveryService } from './branding-delivery.service';

/**
 * InternalBrandingDeliveryController
 * ══════════════════════════════════
 * `POST /api/internal/branding/delivery` — the cabinet's verdict on a version
 * of the public config: which fields of the appearance it did not take, empty
 * when it took everything (`branding-delivery-report.ts`). Sent once per
 * version by the cabinet's API process; the branding page shows the report on
 * the version it serves now.
 *
 * Body: `{ version: <32 hex>, rejected: [{ path, reason, value }] }`. A body
 * that is not a report is a 400 — the cabinet logs it and moves on.
 *
 * Auth: `InternalAdminAuthGuard`, the api_token and signature every internal
 * route the cabinet calls uses.
 */
@ApiTags('internal/branding')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/branding/delivery')
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalBrandingDeliveryController {
  public constructor(private readonly delivery: BrandingDeliveryService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Which fields of a public-config version the cabinet did not take' })
  public async report(@Body() body: unknown): Promise<{ readonly ok: true }> {
    const report = readBrandingDeliveryReport(body);
    if (report === null) throw new BadRequestException('Not a branding delivery report');
    await this.delivery.record(report);
    return { ok: true };
  }
}
