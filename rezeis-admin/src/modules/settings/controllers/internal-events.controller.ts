import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import {
  SystemEventsService,
  type SystemEventCategory,
  type SystemEventPayload,
  type SystemEventSeverity,
} from '../../../common/services/system-events.service';

const EVENT_CATEGORIES: readonly SystemEventCategory[] = [
  'USER',
  'AUTH',
  'SUBSCRIPTION',
  'DEVICE',
  'PAYMENT',
  'REFERRAL',
  'PARTNER',
  'PROMOCODE',
  'SUPPORT',
  'FRAUD',
  'NODE',
  'REMNAWAVE',
  'SYSTEM',
];

const EVENT_SEVERITIES: readonly SystemEventSeverity[] = ['INFO', 'WARNING', 'ERROR'];

/**
 * Validated shape of an inbound reiwa→rezeis system event. This is a
 * cross-service trust boundary, so the payload is validated (like
 * `ReportReiwaErrorDto`) rather than trusting the raw body: the global
 * `ValidationPipe` (whitelist + forbidNonWhitelisted) strips unknown top-level
 * keys and rejects malformed enums/oversized strings.
 */
class ReceiveSystemEventDto {
  @IsString()
  @MaxLength(200)
  public type!: string;

  @IsIn(EVENT_CATEGORIES)
  public category!: SystemEventCategory;

  @IsIn(EVENT_SEVERITIES)
  public severity!: SystemEventSeverity;

  @IsString()
  @MaxLength(2000)
  public message!: string;

  @IsOptional()
  @IsObject()
  public metadata?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public adminId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  public timestamp?: string;
}

/**
 * Internal endpoint for receiving system events from external services (reiwa).
 *
 * Reiwa sends events here when it encounters errors or significant actions
 * that should be visible in the admin panel and Telegram notifications.
 */
@Controller('internal/events')
@UseGuards(InternalAdminAuthGuard)
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalEventsController {
  public constructor(private readonly events: SystemEventsService) {}

  /**
   * Receives a system event from reiwa and routes it through the standard
   * event pipeline (audit log + webhook + Telegram).
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  public receiveEvent(@Body() body: ReceiveSystemEventDto): { received: true } {
    this.events.emit(body satisfies SystemEventPayload);
    return { received: true };
  }
}
