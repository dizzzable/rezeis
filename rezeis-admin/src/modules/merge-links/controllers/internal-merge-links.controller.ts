import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { MergeLinkSourcesInterface } from '../interfaces/plan-bundle.interface';
import { MergeLinksService } from '../services/merge-links.service';

/**
 * The one question `remnawave-subscription-merge` asks this service: which
 * profiles does this token stand for?
 *
 * Answered, never mirrored — so a renewed, replaced or deleted profile changes
 * the merged link on the service's next cache miss without a sync job, and the
 * grouping can never disagree with the subscriptions.
 *
 * 404 means "not a merge link" for every reason that matters to the caller: an
 * unknown token, a revoked one, a bundle the operator switched off, or a
 * customer who no longer holds two of its plans. The merging service maps that
 * to a 404 of its own instead of serving a one-profile config.
 *
 * NOT THROTTLED PER ADDRESS, for the reason every internal controller here
 * records: the caller is one service on one address asking on behalf of every
 * customer at once, so a per-address limit protects nothing and breaks everyone.
 */
@Controller('internal/merge-links')
@UseGuards(InternalAdminAuthGuard)
@SkipThrottle()
export class InternalMergeLinksController {
  public constructor(private readonly mergeLinksService: MergeLinksService) {}

  @Get(':token/sources')
  public async sources(@Param('token') token: string): Promise<MergeLinkSourcesInterface> {
    const resolved = await this.mergeLinksService.resolveSources(token);
    if (resolved === null) {
      throw new NotFoundException('Merge link not found');
    }
    return resolved;
  }
}
