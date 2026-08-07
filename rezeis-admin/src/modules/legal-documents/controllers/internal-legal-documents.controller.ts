import { Controller, Get, Query, UseGuards } from '@nestjs/common';

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
