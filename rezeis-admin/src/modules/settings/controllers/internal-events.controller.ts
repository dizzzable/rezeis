import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { SystemEventsService, SystemEventPayload } from '../../../common/services/system-events.service';

/**
 * Internal endpoint for receiving system events from external services (reiwa).
 *
 * Reiwa sends events here when it encounters errors or significant actions
 * that should be visible in the admin panel and Telegram notifications.
 */
@Controller('internal/events')
@UseGuards(InternalAdminAuthGuard)
export class InternalEventsController {
  public constructor(private readonly events: SystemEventsService) {}

  /**
   * Receives a system event from reiwa and routes it through the standard
   * event pipeline (audit log + webhook + Telegram).
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  public receiveEvent(@Body() body: SystemEventPayload): { received: true } {
    this.events.emit(body);
    return { received: true };
  }
}
