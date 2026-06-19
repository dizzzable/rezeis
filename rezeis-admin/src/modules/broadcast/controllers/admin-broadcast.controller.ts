import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
  EditBroadcastDto,
  SendBroadcastDto,
  UpdateBroadcastDraftDto,
} from '../dto/broadcast-payload.dto';
import {
  BroadcastAudiencePreviewInterface,
  BroadcastInterface,
} from '../interfaces/broadcast.interface';
import { BroadcastService } from '../services/broadcast.service';
import { BroadcastDeliveryService } from '../services/broadcast-delivery.service';
import { BroadcastQueueService } from '../services/broadcast-queue.service';
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
    private readonly broadcastQueueService: BroadcastQueueService,
    private readonly broadcastDeliveryService: BroadcastDeliveryService,
  ) {}

  // ── CRUD ────────────────────────────────────────────────────────────────

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

  // ── SEND (async via BullMQ) ─────────────────────────────────────────────

  @Post(':broadcastId/send')
  @ApiOperation({ summary: 'Start async delivery (supports scheduled send via delayMinutes)' })
  public async sendBroadcast(
    @Param('broadcastId') broadcastId: string,
    @Body() dto: SendBroadcastDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
  ): Promise<{ jobId: string; message: string; scheduledFor?: string }> {
    const broadcast = await this.broadcastService.getBroadcast(broadcastId);
    if (broadcast.status !== 'DRAFT') {
      throw new BadRequestException('Only draft broadcasts can be sent');
    }

    const delayMs = dto.delayMinutes ? dto.delayMinutes * 60_000 : undefined;
    const jobId = await this.broadcastQueueService.enqueueStart(
      { broadcastId, adminId: currentAdmin.id },
      { delayMs },
    );

    const result: { jobId: string; message: string; scheduledFor?: string } = {
      jobId,
      message: delayMs ? 'Broadcast scheduled' : 'Broadcast delivery enqueued',
    };
    if (delayMs) {
      result.scheduledFor = new Date(Date.now() + delayMs).toISOString();
    }
    return result;
  }

  // ── TEST SEND (dev only) ────────────────────────────────────────────────

  @Post(':broadcastId/test')
  @ApiOperation({ summary: 'Send a preview of a draft to the bot developer (BOT_DEV_ID) only' })
  public async sendTestBroadcast(
    @Param('broadcastId') broadcastId: string,
    @CurrentAdmin() _currentAdmin: CurrentAdminInterface,
  ): Promise<{ ok: true; message: string }> {
    const broadcast = await this.broadcastService.getBroadcast(broadcastId);
    if (broadcast.status !== 'DRAFT') {
      throw new BadRequestException('Only draft broadcasts can be test-sent');
    }
    const result = await this.broadcastDeliveryService.sendTestToDev(broadcastId);
    if (!result.ok) {
      throw new BadRequestException(
        result.reason === 'relay-disabled'
          ? 'Bot relay not configured (REIWA_URL / WEBHOOK_SECRET_HEADER)'
          : result.reason === 'empty'
            ? 'Draft has no content to preview'
            : 'Test send failed',
      );
    }
    // The test draft is a throwaway preview shell (no recipients/messages) — the
    // real "send" creates its own fresh draft. Clean it up so test runs don't
    // accumulate orphan DRAFT rows in the broadcast list. Best-effort.
    try {
      await this.broadcastService.deleteBroadcast(broadcastId);
    } catch {
      // Non-fatal: the preview already reached the developer.
    }
    return { ok: true, message: 'Test preview sent to developer' };
  }

  // ── CANCEL ──────────────────────────────────────────────────────────────

  @Post(':broadcastId/cancel')
  @ApiOperation({ summary: 'Cancel a broadcast in progress (removes pending jobs, marks messages CANCELED)' })
  public async cancelBroadcast(
    @Param('broadcastId') broadcastId: string,
    @CurrentAdmin() _currentAdmin: CurrentAdminInterface,
  ): Promise<{ canceledMessages: number; message: string }> {
    const broadcast = await this.broadcastService.getBroadcast(broadcastId);
    if (broadcast.status !== 'PROCESSING' && broadcast.status !== 'DRAFT') {
      throw new BadRequestException('Only DRAFT or PROCESSING broadcasts can be canceled');
    }

    const canceledMessages = await this.broadcastQueueService.cancelBroadcast(broadcastId);

    // Update broadcast status
    await this.broadcastService.updateStatus(broadcastId, 'CANCELED');

    return { canceledMessages, message: 'Broadcast canceled' };
  }

  // ── EDIT (already-sent messages) ────────────────────────────────────────

  @Post(':broadcastId/edit')
  @ApiOperation({ summary: 'Edit a sent broadcast: rewrite cabinet feed + Telegram messages' })
  public async editBroadcast(
    @Param('broadcastId') broadcastId: string,
    @Body() dto: EditBroadcastDto,
    @CurrentAdmin() _currentAdmin: CurrentAdminInterface,
  ): Promise<{ batches: number; totalMessages: number; message: string }> {
    const broadcast = await this.broadcastService.getBroadcast(broadcastId);
    if (broadcast.status !== 'COMPLETED') {
      throw new BadRequestException('Only completed broadcasts can be edited');
    }
    // Always update the stored payload + cabinet-feed events so web-only and
    // Telegram users see the corrected text in their in-app feed.
    await this.broadcastService.updateBroadcastContent({
      broadcastId,
      text: dto.text,
      parseMode: dto.parseMode ?? null,
    });
    // Telegram message edits now apply to BOTH direct media sends and text
    // broadcasts (the reiwa-bot fanout returns the message id, which we persist
    // on delivery). The edit worker silently skips messages outside Telegram's
    // 48h edit window. Default to HTML — that's what text delivery sends.
    const sentMessages = await this.broadcastQueueService.getSentMessageIds(broadcastId);
    let batches = 0;
    if (sentMessages.length > 0) {
      batches = await this.broadcastQueueService.enqueueEdit({
        broadcastId,
        newText: dto.text,
        parseMode: dto.parseMode ?? 'HTML',
        messageIds: sentMessages,
      });
    }
    return { batches, totalMessages: sentMessages.length, message: 'Broadcast updated' };
  }

  // ── DELETE (whole broadcast) ────────────────────────────────────────────

  @Delete(':broadcastId')
  @ApiOperation({ summary: 'Delete a broadcast and all of its message rows' })
  public async deleteBroadcast(
    @Param('broadcastId') broadcastId: string,
    @CurrentAdmin() _currentAdmin: CurrentAdminInterface,
  ): Promise<{ deleted: true }> {
    await this.broadcastService.deleteBroadcast(broadcastId);
    return { deleted: true };
  }

  // ── DELETE (already-sent messages) ──────────────────────────────────────

  @Delete(':broadcastId/messages')
  @ApiOperation({ summary: 'Delete already-sent messages from Telegram (within 48h window)' })
  public async deleteBroadcastMessages(
    @Param('broadcastId') broadcastId: string,
    @CurrentAdmin() _currentAdmin: CurrentAdminInterface,
  ): Promise<{ batches: number; totalMessages: number; message: string }> {
    const broadcast = await this.broadcastService.getBroadcast(broadcastId);
    if (broadcast.status !== 'COMPLETED') {
      throw new BadRequestException('Only completed broadcasts can have messages deleted');
    }
    const sentMessages = await this.broadcastQueueService.getSentMessageIds(broadcastId);
    if (sentMessages.length === 0) {
      throw new BadRequestException('No sent messages found to delete');
    }
    const batches = await this.broadcastQueueService.enqueueDelete({
      broadcastId,
      messageIds: sentMessages,
    });
    return { batches, totalMessages: sentMessages.length, message: 'Delete enqueued' };
  }

  // ── RETRY FAILED ────────────────────────────────────────────────────────

  @Post(':broadcastId/retry')
  @ApiOperation({ summary: 'Retry all failed messages for a broadcast' })
  public async retryFailed(
    @Param('broadcastId') broadcastId: string,
    @CurrentAdmin() _currentAdmin: CurrentAdminInterface,
  ): Promise<{ batches: number; totalMessages: number; message: string }> {
    const broadcast = await this.broadcastService.getBroadcast(broadcastId);
    if (broadcast.status !== 'COMPLETED' && broadcast.status !== 'FAILED') {
      throw new BadRequestException('Only completed or failed broadcasts can be retried');
    }
    const failedMessages = await this.broadcastQueueService.getFailedMessageIds(broadcastId);
    if (failedMessages.length === 0) {
      throw new BadRequestException('No failed messages to retry');
    }
    const batches = await this.broadcastQueueService.enqueueRetry({
      broadcastId,
      messageIds: failedMessages,
    });

    // Set status back to PROCESSING
    await this.broadcastService.updateStatus(broadcastId, 'PROCESSING');

    return { batches, totalMessages: failedMessages.length, message: 'Retry enqueued' };
  }

  // ── MEDIA UPLOAD ────────────────────────────────────────────────────────

  @Post('upload-media')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }))
  @ApiOperation({ summary: 'Upload photo/video to Telegram and return file_id' })
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
