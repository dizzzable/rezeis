import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import {
  LegalDocumentLocale,
  LegalDocumentPublicInterface,
  LegalDocumentsService,
} from '../services/legal-documents.service';

/**
 * Internal legal-documents endpoint for reiwa — active documents only, one
 * locale, already resolved.
 *
 * Resolving the locale here rather than shipping both is what keeps the
 * registration screen's payload to what it will actually display. That screen
 * is pre-login: it renders before any session exists, on the slowest path a
 * visitor ever takes, and a second copy of a 40 KB agreement is pure weight.
 */
@Controller('internal/legal-documents')
@UseGuards(InternalAdminAuthGuard)
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalLegalDocumentsController {
  public constructor(private readonly legalDocumentsService: LegalDocumentsService) {}

  @Get()
  public list(
    @Query('locale') locale?: string,
  ): Promise<readonly LegalDocumentPublicInterface[]> {
    return this.legalDocumentsService.listPublic(parseLocale(locale));
  }
}

/** Anything that is not an explicit `en` reads as the primary locale. */
function parseLocale(value: string | undefined): LegalDocumentLocale {
  return value?.trim().toLowerCase() === 'en' ? 'en' : 'ru';
}
