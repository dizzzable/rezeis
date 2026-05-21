import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { FaqService, FaqItemInterface } from '../services/faq.service';

/**
 * Internal FAQ endpoint for reiwa — returns only active items.
 */
@Controller('internal/faq')
@UseGuards(InternalAdminAuthGuard)
export class InternalFaqController {
  public constructor(private readonly faqService: FaqService) {}

  @Get()
  public getPublicFaq(
    @Query('locale') locale?: string,
  ): Promise<readonly FaqItemInterface[]> {
    return this.faqService.getPublicFaq(locale ?? null);
  }
}
