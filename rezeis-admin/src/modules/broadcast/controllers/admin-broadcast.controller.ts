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
import {
  BroadcastQueueService,
  PartialEnqueueError,
} from '../services/broadcast-queue.service';
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
    // A SCHEDULED broadcast is re-sendable: that is how an operator moves the
    // time. The enqueue below REPLACES any pending start job for this
    // broadcast, so the new time is the one that fires and the old job cannot
    // go out behind it.
    if (broadcast.status !== 'DRAFT' && broadcast.status !== 'SCHEDULED') {
      throw new BadRequestException('Only draft or scheduled broadcasts can be sent');
    }

    // Dispatch-time promo gate: block the send if the tagged promo drifted
    // into EXPIRED/DEPLETED (or was deleted) since compose time.
    await this.broadcastService.assertPromoCodeDispatchable(broadcastId);

    const delayMs = dto.delayMinutes ? dto.delayMinutes * 60_000 : undefined;
    // Computed BEFORE the enqueue. A `delayMinutes` big enough to overflow the
    // date would otherwise throw here with the job already in the queue.
    const scheduledFor = delayMs === undefined ? null : new Date(Date.now() + delayMs);

    const jobId = await this.broadcastQueueService.enqueueStart(
      { broadcastId, adminId: currentAdmin.id },
      { delayMs },
    );

    // THE RECORD OF INTENT, written in the same request that enqueues the job.
    // A schedule that exists only as a delayed job in Redis cannot be shown,
    // cannot be cancelled and cannot be reconciled — which is exactly how a
    // pending send used to render as an ordinary draft with no actions on it.
    const recorded = await this.broadcastService.recordSchedule(broadcastId, scheduledFor, jobId);
    if (!recorded) {
      // ── LOSING THIS WRITE IS NOT AUTOMATICALLY AN ERROR ──────────────────
      //
      // The precondition failed, which means the status moved between the read
      // above and this write. There are two ways that happens and they deserve
      // opposite answers:
      //
      //  - The job we just queued was picked up and WON THE CLAIM. For an
      //    immediate send the in-process worker can do that in the few
      //    milliseconds before this line runs. The send is proceeding exactly
      //    as asked, and answering 400 told the operator their perfectly
      //    successful send had failed — after which the natural move is to
      //    press send again.
      //  - It was cancelled or had already finished. Then there is nothing to
      //    schedule, and the queued job has to be taken back or it would stage
      //    the whole audience a second time when it fires.
      const current = await this.broadcastService.getBroadcast(broadcastId);
      // Only an IMMEDIATE send may read this as success. A RESCHEDULE that lost
      // the claim has really failed: the broadcast is already going out at the
      // old time and the new one cannot be honoured, so answering 200 would
      // discard the operator's correction while telling them it worked.
      if (current.status !== 'PROCESSING' || scheduledFor !== null) {
        await this.broadcastQueueService.dropPendingStart(broadcastId);
        throw new BadRequestException(
          current.status === 'PROCESSING'
            ? 'This broadcast has already started sending — it can no longer be rescheduled'
            : 'Broadcast is no longer draft or scheduled',
        );
      }
      // Under way already, which is exactly what was asked for.
      return { jobId, message: 'Broadcast delivery enqueued' };
    }

    const result: { jobId: string; message: string; scheduledFor?: string } = {
      jobId,
      message: scheduledFor ? 'Broadcast scheduled' : 'Broadcast delivery enqueued',
    };
    if (scheduledFor) {
      result.scheduledFor = scheduledFor.toISOString();
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
  ): Promise<{ ok: true; draftRemoved: boolean; message: string }> {
    const broadcast = await this.broadcastService.getBroadcast(broadcastId);
    // Same widening as cancel and updateDraft: a pending send is still a send
    // that has not happened, and previewing it is exactly what an operator does
    // while deciding whether to let it go out.
    if (broadcast.status !== 'DRAFT' && broadcast.status !== 'SCHEDULED') {
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
    let draftRemoved = false;
    if (await this.canDeleteBroadcasts(currentAdmin)) {
      try {
        await this.broadcastService.deleteBroadcast(broadcastId);
        draftRemoved = true;
      } catch {
        // Non-fatal: the preview already reached the developer.
      }
    }
    // SAID OUT LOUD, because the panel has to know. It forgot the draft id
    // unconditionally after a test send, so a run-only caller — who leaves the
    // shell behind by design — got a second row on the next save, and could
    // delete neither of them.
    return { ok: true, draftRemoved, message: 'Test preview sent to developer' };
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
    // SCHEDULED belongs here, and its absence was a regression: a pending send
    // used to be a DRAFT and cancellable, then it got its own status and this
    // guard was not widened with it. The panel offered the button anyway, so
    // stopping a scheduled broadcast answered 400 — and a scheduled row has no
    // delete button either, which left it with no way to be stopped at all.
    if (
      broadcast.status !== 'PROCESSING' &&
      broadcast.status !== 'DRAFT' &&
      broadcast.status !== 'SCHEDULED'
    ) {
      throw new BadRequestException('Only DRAFT, SCHEDULED or PROCESSING broadcasts can be canceled');
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
  ): Promise<{
    batches: number;
    totalMessages: number;
    /**
     * What happened to the ONE public copy on the operator channel. Narrowed to
     * what this handler can actually answer, so the API description does not
     * advertise an outcome it never emits.
     */
    channel: 'edited' | 'no-post' | 'unaddressable' | 'failed';
    message: string;
  }> {
    const broadcast = await this.broadcastService.getBroadcast(broadcastId);
    if (broadcast.status !== 'COMPLETED') {
      throw new BadRequestException('Only completed broadcasts can be edited');
    }
    // Always update the stored payload + cabinet-feed events so web-only and
    // Telegram users see the corrected text in their in-app feed.
    // `dto.parseMode` STRAIGHT THROUGH: omitted stays `undefined`, which leaves
    // the stored value alone. `?? null` collapsed "the caller said nothing"
    // into "strip the formatting".
    await this.broadcastService.updateBroadcastContent({
      broadcastId,
      text: dto.text,
      parseMode: dto.parseMode,
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
        // THE EFFECTIVE STORED VALUE, not a transport default. Passing
        // `?? 'HTML'` here is what made the worker write HTML back into the
        // payload: a later "retry failed" then read that and re-sent the tail
        // of the audience with parse_mode HTML, where the head had got none —
        // so a bare `<` or `&` in the operator's text made Telegram refuse
        // exactly the recipients the retry existed to reach. The worker picks
        // the wire value itself, the same way delivery does.
        // `!== undefined`, NOT `??`. An explicit `null` is the operator asking
        // to strip the formatting, and `??` treated it the same as an omitted
        // key — so the strip landed in the payload and the worker then wrote
        // the resurrected value straight back over it, while the wire still
        // carried the old parse mode.
        parseMode:
          dto.parseMode !== undefined ? dto.parseMode : (broadcast.payload.parseMode ?? null),
        messageIds: sentMessages,
      });
    }
    // THE PUBLIC COPY, once. The channel post is not a recipient and is not in
    // `sentMessages`, so it used to be the one message a correction never
    // reached — leaving the original text up in the only place anyone else can
    // read it. Reported rather than thrown: the recipients' edit is already
    // under way and is the larger half of the correction.
    // ALWAYS 'HTML' for the channel: `postToChannelIfConfigured` creates that
    // post with HTML and nothing else, so re-parsing the edit as anything the
    // operator chose for the per-recipient copies would have Telegram refuse
    // it — and the public copy would keep the old text with only a warning to
    // show for it.
    const channel = await this.broadcastDeliveryService.syncChannelPost(
      broadcastId,
      dto.text,
      'HTML',
    );
    return {
      batches,
      totalMessages: sentMessages.length,
      channel,
      // `unaddressable` counts as a failure to report, not a success: the post
      // exists, it still shows the old text, and nothing here can reach it.
      message:
        channel === 'failed' || channel === 'unaddressable'
          ? 'Broadcast updated, but the channel post could not be edited — check it by hand'
          : 'Broadcast updated',
    };
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
  ): Promise<{
    batches: number;
    totalMessages: number;
    /** See the edit handler: narrowed to what a recall can actually answer. */
    channel: 'deleted' | 'no-post' | 'unaddressable' | 'failed';
    message: string;
  }> {
    const broadcast = await this.broadcastService.getBroadcast(broadcastId);
    if (broadcast.status !== 'COMPLETED') {
      throw new BadRequestException('Only completed broadcasts can have messages deleted');
    }
    const sentMessages = await this.broadcastQueueService.getSentMessageIds(broadcastId);
    // ── THE PUBLIC COPY IS A REASON TO PROCEED ON ITS OWN ─────────────────
    //
    // Refusing here whenever no recipient message is left took the channel post
    // down with it: a broadcast delivered only to web-only users has no
    // Telegram message ids at all, and one already recalled has none either —
    // so the copy anyone can still read had no route left in the panel. The
    // recall now refuses only when there is nothing ANYWHERE to remove.
    const channelPost = await this.broadcastDeliveryService.channelPostState(broadcastId);
    if (sentMessages.length === 0 && channelPost === 'no-post') {
      throw new BadRequestException('No sent messages found to delete');
    }
    const batches =
      sentMessages.length === 0
        ? 0
        : await this.broadcastQueueService.enqueueDelete({
            broadcastId,
            messageIds: sentMessages,
          });
    // The channel copy goes too. Recalling from four hundred private chats and
    // leaving the post up on the channel is the version of this that is hardest
    // to explain — and the channel is usually the reason a recall is wanted.
    const channel = await this.broadcastDeliveryService.deleteChannelPost(broadcastId);
    return {
      batches,
      totalMessages: sentMessages.length,
      channel,
      // `batches === 0` is a real outcome now: a broadcast whose only remaining
      // copy is the channel one has no recipient messages to enqueue.
      message:
        channel === 'failed' || channel === 'unaddressable'
          ? batches === 0
            ? 'Nothing was recalled: the channel post could not be deleted — remove it by hand'
            : 'Recall enqueued, but the channel post could not be deleted — remove it by hand'
          : batches === 0
            ? 'Channel post deleted'
            : 'Delete enqueued',
    };
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
    // Claim FIRST — see `beginRetry`. Writing the status afterwards let a fast
    // retry finish and finalize before the write landed, which then stamped
    // PROCESSING over a completed send and stranded it there permanently.
    const previous = await this.broadcastService.beginRetry(broadcastId);
    if (previous === null) {
      throw new BadRequestException('This broadcast is already running — wait for it to finish');
    }

    let batches: number;
    try {
      // ALL of them to PENDING first — see `markForRetry`. Left to the batches,
      // a multi-batch retry could finalize the broadcast as COMPLETED while
      // most of it had not started, because the finaliser's guard counts
      // PENDING rows and the not-yet-reset ones were still FAILED.
      await this.broadcastService.markForRetry(broadcastId, failedMessages);
      batches = await this.broadcastQueueService.enqueueRetry({
        broadcastId,
        messageIds: failedMessages,
      });
    } catch (err: unknown) {
      // Roll back ONLY if the fan-out placed nothing at all. It is a loop of
      // queue writes, so a failure halfway leaves earlier batches queued and
      // running — restoring the status then tells the panel the broadcast has
      // finished while it is actively re-delivering. When some batches did land
      // the broadcast stays PROCESSING and its own finaliser settles it, which
      // is the truthful state.
      const enqueued = err instanceof PartialEnqueueError ? err.batchesEnqueued : 0;
      if (enqueued === 0) {
        // The message ids too: `markForRetry` has already put them back to
        // PENDING, and a PENDING row under a settled broadcast is reachable by
        // nothing at all.
        await this.broadcastService.abortRetry(broadcastId, previous, failedMessages);
      }
      throw err;
    }

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
