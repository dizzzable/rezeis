import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { FaqService, FaqItemInterface } from '../services/faq.service';

/**
 * Internal FAQ endpoint for reiwa — returns only active items.
 */
@Controller('internal/faq')
@UseGuards(InternalAdminAuthGuard)
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalFaqController {
  public constructor(private readonly faqService: FaqService) {}

  @Get()
  public getPublicFaq(
    @Query('locale') locale?: string,
  ): Promise<readonly FaqItemInterface[]> {
    return this.faqService.getPublicFaq(locale ?? null);
  }
}
