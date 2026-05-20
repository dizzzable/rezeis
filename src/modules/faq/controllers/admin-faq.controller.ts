import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import {
  FAQ_MEDIA_MAX_FILE_SIZE,
  FaqMediaUploadService,
  FaqUploadedMediaInterface,
} from '../services/faq-media-upload.service';
import { FaqService, FaqItemInterface } from '../services/faq.service';

interface CreateFaqItemBody {
  readonly question?: unknown;
  readonly answer?: unknown;
  readonly mediaUrls?: unknown;
  readonly orderIndex?: unknown;
  readonly locale?: unknown;
  readonly isActive?: unknown;
}

interface UpdateFaqItemBody {
  readonly question?: unknown;
  readonly answer?: unknown;
  readonly mediaUrls?: unknown;
  readonly orderIndex?: unknown;
  readonly locale?: unknown;
  readonly isActive?: unknown;
}

/**
 * AdminFaqController
 * ──────────────────
 * Operator CRUD for FAQ entries plus a media upload endpoint that
 * stores attached photos/videos under `data/uploads/faq/` and returns
 * a public URL.
 *
 * The upload route is attached to this controller (not a generic
 * `/uploads`) so future entity-specific upload pipelines (broadcast,
 * branding, etc.) keep their own quotas + validators in their own
 * modules.
 */
@ApiTags('admin/faq')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/faq')
export class AdminFaqController {
  public constructor(
    private readonly faqService: FaqService,
    private readonly faqMediaUploadService: FaqMediaUploadService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List every FAQ entry (admin view, includes inactive)' })
  public list(): Promise<readonly FaqItemInterface[]> {
    return this.faqService.listAll();
  }

  @Post()
  @ApiOperation({ summary: 'Create a new FAQ entry' })
  public create(@Body() body: CreateFaqItemBody): Promise<FaqItemInterface> {
    return this.faqService.create({
      question: requireString(body.question, 'question', { min: 1, max: 500 }),
      answer: requireString(body.answer, 'answer', { min: 1, max: 8_000 }),
      mediaUrls: parseMediaUrls(body.mediaUrls),
      orderIndex: parseOptionalInt(body.orderIndex, 'orderIndex'),
      locale: parseOptionalLocale(body.locale),
      isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
    });
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an existing FAQ entry' })
  public update(
    @Param('id') id: string,
    @Body() body: UpdateFaqItemBody,
  ): Promise<FaqItemInterface> {
    return this.faqService.update(id, {
      question:
        body.question === undefined
          ? undefined
          : requireString(body.question, 'question', { min: 1, max: 500 }),
      answer:
        body.answer === undefined
          ? undefined
          : requireString(body.answer, 'answer', { min: 1, max: 8_000 }),
      mediaUrls: body.mediaUrls === undefined ? undefined : parseMediaUrls(body.mediaUrls),
      orderIndex: parseOptionalInt(body.orderIndex, 'orderIndex'),
      isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
      locale: body.locale === undefined ? undefined : parseOptionalLocale(body.locale),
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a FAQ entry (attached media files are NOT cleaned up)' })
  public async delete(@Param('id') id: string): Promise<void> {
    await this.faqService.delete(id);
  }

  @Post('uploads')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: FAQ_MEDIA_MAX_FILE_SIZE },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Upload a single image or video and return a relative URL for `mediaUrls`',
  })
  public async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<FaqUploadedMediaInterface> {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    return this.faqMediaUploadService.persist({
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
    });
  }
}

// ── Body parsing helpers ─────────────────────────────────────────────────

function requireString(
  value: unknown,
  field: string,
  bounds: { readonly min: number; readonly max: number },
): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length < bounds.min) {
    throw new BadRequestException(`${field} must not be empty`);
  }
  if (trimmed.length > bounds.max) {
    throw new BadRequestException(`${field} exceeds ${bounds.max} characters`);
  }
  return trimmed;
}

function parseMediaUrls(value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new BadRequestException('mediaUrls must be an array of strings');
  }
  if (value.length > 20) {
    throw new BadRequestException('mediaUrls cannot exceed 20 entries');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new BadRequestException(`mediaUrls[${index}] must be a string`);
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException(`mediaUrls[${index}] must not be empty`);
    }
    if (trimmed.length > 1_024) {
      throw new BadRequestException(`mediaUrls[${index}] is too long`);
    }
    return trimmed;
  });
}

function parseOptionalInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new BadRequestException(`${field} must be an integer`);
  }
  return Math.trunc(parsed);
}

function parseOptionalLocale(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new BadRequestException('locale must be a string');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 32) {
    throw new BadRequestException('locale is too long');
  }
  return trimmed;
}
