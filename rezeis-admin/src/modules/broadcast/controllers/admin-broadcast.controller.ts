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
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { RbacService } from '../../rbac/services/rbac.service';
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
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('broadcasts', 'view')
@Controller('admin/broadcast')
export class AdminBroadcastController {
  public constructor(
    private readonly broadcastService: BroadcastService,
    private readonly broadcastMediaUploadService: BroadcastMediaUploadService,
    private readonly broadcastQueueService: BroadcastQueueService,
    private readonly broadcastDeliveryService: BroadcastDeliveryService,
    private readonly rbacService: RbacService,
  ) {}

  /**
   * Whether this caller may destroy a broadcast.
   *
   * Asked here rather than with a second `@RequirePermission` because the
   * elevated permission must not gate the ENDPOINT: test-sending a preview is
   * `broadcasts:run` and must stay available to a role that holds run and not
   * delete — the default `operator` is exactly that shape. `@RequirePermission`
   * can only allow or refuse the whole route, so the distinction lives in what
   * the handler does afterwards. Same reasoning, same shape as
   * `AdminPaymentGatewaysController.canRevealSecrets`.
   */
  private async canDeleteBroadcasts(admin: CurrentAdminInterface): Promise<boolean> {
    return this.rbacService.hasPermission(
      { id: admin.id, role: admin.role, rbacRoleId: admin.rbacRoleId ?? null },
      'broadcasts',
      'delete',
    );
  }

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
  @RequirePermission('broadcasts', 'create')
  @ApiOperation({ summary: 'Create a new broadcast draft' })
  public createDraft(
    @Body() dto: CreateBroadcastDraftDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
  ): Promise<BroadcastInterface> {
    return this.broadcastService.createDraft({ dto, currentAdmin });
  }

  @Patch('drafts/:broadcastId')
  @RequirePermission('broadcasts', 'edit')
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
  @RequirePermission('broadcasts', 'run')
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

    // Dispatch-time promo gate: block the send if the tagged promo drifted
    // into EXPIRED/DEPLETED (or was deleted) since compose time.
    await this.broadcastService.assertPromoCodeDispatchable(broadcastId);

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
  @RequirePermission('broadcasts', 'run')
  @ApiOperation({ summary: 'Send a preview of a draft to the bot developer (BOT_DEV_ID) only' })
  public async sendTestBroadcast(
    @Param('broadcastId') broadcastId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
  ): Promise<{ ok: true; message: string }> {
    const broadcast = await this.broadcastService.getBroadcast(broadcastId);
    if (broadcast.status !== 'DRAFT') {
      throw new BadRequestException('Only draft broadcasts can be test-sent');
    }
    const result = await this.broadcastDeliveryService.sendTestToDev(broadcastId);
    if (!result.ok) {
      throw new BadRequestException(
        result.reason === 'relay-disabled'
          ? 'No test target: configure the bot relay (REIWA_URL / WEBHOOK_SECRET_HEADER) or set a user role to DEV'
          : result.reason === 'empty'
            ? 'Draft has no content to preview'
            : 'Test send failed',
      );
    }
    // Clean up the preview shell so test runs do not accumulate orphan DRAFT
    // rows in the broadcast list — but ONLY for a caller who could have deleted
    // it through the front door.
    //
    // This used to run unconditionally, justified by a comment saying the row
    // is "a throwaway preview shell (no recipients/messages)". That describes
    // the panel's own flow, which creates a shell and immediately test-sends
    // it. Nothing here enforced it: `broadcastId` is caller-supplied and the
    // only precondition is DRAFT, so the endpoint deleted ANY draft it was
    // pointed at. And "no messages" cannot tell the two apart — `messages` are
    // written at dispatch, so EVERY draft has none, including one somebody
    // spent an afternoon writing.
    //
    // That made `broadcasts:run` a way to destroy drafts without holding
    // `broadcasts:delete`, which this catalog deliberately separates: the
    // default `operator` role holds view/create/edit/run and no delete, and
    // `DELETE :broadcastId` is gated on delete precisely so destruction is its
    // own privilege. The invariant restored here is that a side effect must
    // never reach further than the caller's own hands.
    //
    // A run-only caller therefore leaves the shell behind. That is a stray row
    // in a list, undone by anyone with delete — the failure it replaces was
    // silent, permanent loss of somebody else's work.
    if (await this.canDeleteBroadcasts(currentAdmin)) {
      try {
        await this.broadcastService.deleteBroadcast(broadcastId);
      } catch {
        // Non-fatal: the preview already reached the developer.
      }
    }
    return { ok: true, message: 'Test preview sent to developer' };
  }

  // ── CANCEL ──────────────────────────────────────────────────────────────

  @Post(':broadcastId/cancel')
  @RequirePermission('broadcasts', 'edit')
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
  @RequirePermission('broadcasts', 'edit')
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
  @RequirePermission('broadcasts', 'delete')
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
  @RequirePermission('broadcasts', 'delete')
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
  @RequirePermission('broadcasts', 'run')
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
  @RequirePermission('broadcasts', 'edit')
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
