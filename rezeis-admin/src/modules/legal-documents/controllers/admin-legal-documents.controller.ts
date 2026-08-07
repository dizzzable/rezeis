import { BadRequestException, Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { LegalDocumentKey } from '@prisma/client';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import {
  LEGAL_DOCUMENT_BODY_MAX,
  LEGAL_DOCUMENT_KEYS,
  LEGAL_DOCUMENT_TITLE_MAX,
  LegalDocumentAdminInterface,
  LegalDocumentsService,
} from '../services/legal-documents.service';

/**
 * Patch body.
 *
 * A plain interface with `unknown` fields, parsed by hand — the same shape the
 * FAQ and AI-config editors use, and not an accident. The global
 * `ValidationPipe` runs with `forbidNonWhitelisted: true`, so a class DTO
 * rejects the WHOLE request with a 400 the moment the panel sends a field the
 * DTO has not learned about yet. On a settings surface that grows a field at a
 * time, that failure mode reads as "saving is broken" and points nowhere near
 * its cause. An interface has no class metadata, so the pipe passes the body
 * through and each field is validated where its rules actually live.
 */
interface UpdateLegalDocumentBody {
  readonly isActive?: unknown;
  readonly titleRu?: unknown;
  readonly titleEn?: unknown;
  readonly bodyRu?: unknown;
  readonly bodyEn?: unknown;
}

@ApiTags('admin/legal-documents')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('settings', 'view')
@Controller('admin/legal-documents')
export class AdminLegalDocumentsController {
  public constructor(private readonly legalDocumentsService: LegalDocumentsService) {}

  @Get()
  @ApiOperation({ summary: 'Both legal documents, both locales, active or not' })
  public list(): Promise<readonly LegalDocumentAdminInterface[]> {
    return this.legalDocumentsService.listForAdmin();
  }

  @Patch(':key')
  @RequirePermission('settings', 'edit')
  @ApiOperation({ summary: 'Edit one legal document' })
  public update(
    @Param('key') key: string,
    @Body() body: UpdateLegalDocumentBody,
  ): Promise<LegalDocumentAdminInterface> {
    return this.legalDocumentsService.update(parseKey(key), {
      isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
      titleRu: optionalText(body.titleRu, 'titleRu', LEGAL_DOCUMENT_TITLE_MAX),
      titleEn: optionalText(body.titleEn, 'titleEn', LEGAL_DOCUMENT_TITLE_MAX),
      bodyRu: optionalText(body.bodyRu, 'bodyRu', LEGAL_DOCUMENT_BODY_MAX),
      bodyEn: optionalText(body.bodyEn, 'bodyEn', LEGAL_DOCUMENT_BODY_MAX),
    });
  }
}

function parseKey(value: string): LegalDocumentKey {
  const match = LEGAL_DOCUMENT_KEYS.find((key) => key === value);
  if (match === undefined) {
    throw new BadRequestException(
      `key must be one of: ${LEGAL_DOCUMENT_KEYS.join(', ')}`,
    );
  }
  return match;
}

/**
 * `undefined` means "not in this patch"; an empty string is a real value — it
 * is how an operator clears a translation. Only the outer whitespace is
 * stripped: the internal line breaks ARE the document's formatting, since the
 * body is plain text rendered with `white-space: pre-wrap`.
 */
function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new BadRequestException(`${field} must be at most ${max} characters`);
  }
  return trimmed;
}
