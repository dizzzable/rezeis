import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { InternalAdminAuthGuard } from '../auth/guards/internal-admin-auth.guard';
import { EVENT_TYPES, SystemEventsService } from '../../common/services/system-events.service';
import { ReportReiwaErrorDto } from './dto/report-reiwa-error.dto';

/**
 * InternalSystemEventsController
 * ──────────────────────────────
 * reiwa-facing ingest for runtime errors. reiwa's bot/api/worker report their
 * errors here (signed internal channel, `InternalAdminAuthGuard`) so panel AND
 * reiwa failures land in ONE place: the rezeis audit log → Events page →
 * .txt export. Persisted as `event.reiwa.error` (category SYSTEM).
 */
@ApiTags('internal/system')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/system')
export class InternalSystemEventsController {
  public constructor(private readonly events: SystemEventsService) {}

  @Post('error')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'reiwa reports a runtime error/warning' })
  public reportError(@Body() body: ReportReiwaErrorDto): { ok: true } {
    const metadata: Record<string, unknown> = {
      source: body.source,
      ...(body.context ?? {}),
      ...(body.stack ? { stack: body.stack.slice(0, 4000) } : {}),
    };
    const message = `[reiwa:${body.source}] ${body.message}`;
    if (body.level === 'warning') {
      this.events.warn(EVENT_TYPES.REIWA_ERROR, 'SYSTEM', message, metadata);
    } else {
      this.events.error(EVENT_TYPES.REIWA_ERROR, 'SYSTEM', message, metadata);
    }
    return { ok: true };
  }
}
