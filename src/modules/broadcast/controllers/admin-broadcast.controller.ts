import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import {
  CreateBroadcastDraftDto,
  UpdateBroadcastDraftDto,
} from '../dto/broadcast-payload.dto';
import {
  BroadcastAudiencePreviewInterface,
  BroadcastInterface,
} from '../interfaces/broadcast.interface';
import { BroadcastService } from '../services/broadcast.service';
import {
  BroadcastMediaUploadService,
  UploadedMediaInterface,
} from '../services/broadcast-media-upload.service';

@ApiTags('admin/broadcast')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/broadcast')
export class AdminBroadcastController {
  public constructor(
    private readonly broadcastService: BroadcastService,
    private readonly broadcastMediaUploadService: BroadcastMediaUploadService,
  ) {}

  @Get('drafts')
  @ApiOperation({ summary: 'List broadcast drafts and historical entries' })
  public listDrafts(): Promise<readonly BroadcastInterface[]> {
    return this.broadcastService.listDrafts();
  }

  @Get(':broadcastId')
  @ApiOperation({ summary: 'Get a broadcast by id' })
  public getBroadcast(
    @Param('broadcastId') broadcastId: string,
  ): Promise<BroadcastInterface> {
    return this.broadcastService.getBroadcast(broadcastId);
  }

  @Post('drafts')
  @ApiOperation({ summary: 'Create a new broadcast draft' })
  public createDraft(
    @Body() dto: CreateBroadcastDraftDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
  ): Promise<BroadcastInterface> {
    return this.broadcastService.createDraft({ dto, currentAdmin });
  }

  @Patch('drafts/:broadcastId')
  @ApiOperation({ summary: 'Update a broadcast draft' })
  public updateDraft(
    @Param('broadcastId') broadcastId: string,
    @Body() dto: UpdateBroadcastDraftDto,
  ): Promise<BroadcastInterface> {
    return this.broadcastService.updateDraft({ broadcastId, dto });
  }

  @Get(':broadcastId/audience-preview')
  @ApiOperation({ summary: 'Compute the recipient count for a broadcast audience' })
  public previewAudience(
    @Param('broadcastId') broadcastId: string,
  ): Promise<BroadcastAudiencePreviewInterface> {
    return this.broadcastService.previewAudience(broadcastId);
  }

  @Post('upload-media')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        // 50 MB hard cap (matches Telegram video limit). The service
        // applies a stricter limit per media-type.
        fileSize: 50 * 1024 * 1024,
      },
    }),
  )
  @ApiOperation({
    summary:
      'Upload a photo/video to Telegram via the bot and return the resulting file_id',
  })
  public async uploadMedia(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentAdmin() _currentAdmin: CurrentAdminInterface,
  ): Promise<UploadedMediaInterface> {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    const mediaType = inferMediaTypeFromMime(file.mimetype);
    if (!mediaType) {
      throw new BadRequestException(
        `Unsupported file type: ${file.mimetype}. Allowed: image/* or video/*`,
      );
    }
    return this.broadcastMediaUploadService.upload({
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
      mediaType,
    });
  }
}

function inferMediaTypeFromMime(mime: string): 'photo' | 'video' | null {
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  return null;
}
