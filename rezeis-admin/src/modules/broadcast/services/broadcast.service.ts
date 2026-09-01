import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import {
  Broadcast,
  BroadcastAudience,
  BroadcastMessageStatus,
  BroadcastStatus,
  Prisma,
} from '@prisma/client';

import {
  buildAudienceWhere,
  normalizeAudienceFilter,
} from '../utils/broadcast-audience.util';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { normalizeCode } from '../../promocodes/utils/code-normalizer.util';
import { BROADCAST_BLOCKED_REASON, TELEGRAM_CAPTION_LIMIT } from '../broadcast.constants';
import { captionOverflowOf } from '../utils/broadcast-caption.util';
import { PROMOCODE_INCLUDE_ACTIVATIONS_COUNT } from '../../promocodes/utils/promocode-mappers.util';
import {
  BroadcastPayloadDto,
  CreateBroadcastDraftDto,
  UpdateBroadcastDraftDto,
} from '../dto/broadcast-payload.dto';
import {
  BroadcastAudiencePreviewInterface,
  BroadcastInterface,
  BroadcastPayloadInterface,
} from '../interfaces/broadcast.interface';
import {
  BroadcastPromoStatus,
  evaluateBroadcastPromocode,
  isBroadcastPromocodeUsable,
} from '../utils/broadcast-promo.util';

@Injectable()
export class BroadcastService {
  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Writes down that a send is pending, and when.
   *
   * `scheduledFor === null` is an immediate send: the row stays DRAFT and the
   * job is already on its way, so there is nothing to remember. A scheduled one
   * becomes SCHEDULED with its due time and its job id — the three facts the
   * panel needs to show it, the operator needs to cancel it, and the reconciler
   * needs to notice a schedule whose job never fired.
   */
  /**
   * Telegram refuses a caption over its own limit, and it refuses it once per
   * recipient — so an over-long media broadcast used to fail four hundred
   * times over and read as four hundred unrelated delivery problems. Caught
   * here it is one message, before anything is sent.
   */
  private assertCaptionFits(payload: unknown): void {
    const overflow = captionOverflowOf(payload);
    if (overflow !== null) {
      throw new BadRequestException(
        `A photo or video caption may be at most ${TELEGRAM_CAPTION_LIMIT} characters; this one is ${overflow}.`,
      );
    }
  }

  public async recordSchedule(
    broadcastId: string,
    scheduledFor: Date | null,
    queueJobId: string,
  ): Promise<boolean> {
    // ── GUARDED BY STATUS, and that is the whole point ────────────────────
    //
    // Unguarded, this was a way to write SCHEDULED over PROCESSING. The window
    // is small and entirely reachable: a send fires at 10:00, the operator
    // reschedules at 10:00:01, and between the controller reading the status
    // and calling this there are two Redis round trips. The claim lands in
    // that gap, PROCESSING is overwritten, the running send becomes invisible
    // to the reconciler — and the second job later finds the row SCHEDULED,
    // wins the claim, and stages the ENTIRE audience a second time. New
    // message rows mean new relay ids, so nothing dedups it: every recipient
    // gets the broadcast twice, plus a second channel post and a second email.
    //
    // `updateMany` with the precondition makes the write lose that race
    // instead of winning it. `false` means the broadcast moved on and the
    // caller must not pretend it scheduled anything.
    const data =
      scheduledFor === null
        ? { queueJobId, scheduledAt: null, status: BroadcastStatus.DRAFT }
        : { status: BroadcastStatus.SCHEDULED, scheduledAt: scheduledFor, queueJobId };

    const { count } = await this.prismaService.broadcast.updateMany({
      where: {
        id: broadcastId,
        status: { in: [BroadcastStatus.DRAFT, BroadcastStatus.SCHEDULED] },
      },
      data,
    });
    return count === 1;
  }

  public async listDrafts(): Promise<readonly BroadcastInterface[]> {
    const broadcasts = await this.prismaService.broadcast.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    const counts = await this.countMessageStates(broadcasts.map((b) => b.id));
    return broadcasts.map((record) => mapBroadcast(record, counts.get(record.id)));
  }

  /**
   * Real PENDING and CANCELED tallies for a page of broadcasts, in one query.
   *
   * The stored counters only ever move for delivery outcomes, so the states
   * that come from an operator action — cancel, recall — are invisible to them
   * and are counted here instead.
   */
  private async countMessageStates(
    broadcastIds: readonly string[],
  ): Promise<
    Map<
      string,
      {
        pending: number;
        canceled: number;
        recallable: number;
        delivered: number;
        blocked: number;
      }
    >
  > {
    const counts = new Map<
      string,
      {
        pending: number;
        canceled: number;
        recallable: number;
        delivered: number;
        blocked: number;
      }
    >();
    if (broadcastIds.length === 0) return counts;
    const entryFor = (broadcastId: string) => {
      const existing = counts.get(broadcastId);
      if (existing !== undefined) return existing;
      const created = { pending: 0, canceled: 0, recallable: 0, delivered: 0, blocked: 0 };
      counts.set(broadcastId, created);
      return created;
    };

    const [states, recallable, recalled, blocked] = await Promise.all([
      this.prismaService.broadcastMessage.groupBy({
        by: ['broadcastId', 'status'],
        where: {
          broadcastId: { in: [...broadcastIds] },
          // SENT is here for the live progress number. Without it the panel had
          // only the finaliser's `successCount`, which is zero for the whole
          // run — so a send half-way through 400 people showed `0/400`.
          status: { in: ['PENDING', 'CANCELED', 'SENT'] },
        },
        _count: { _all: true },
      }),
      // SEPARATE, because this one is not a plain status tally: a recall can
      // only touch a message that exists in Telegram, and a broadcast also
      // reaches web-only users through the cabinet feed — SENT, with no message
      // id. THE SAME predicate `getSentMessageIds` uses, so the count on screen
      // and the work the endpoint finds cannot disagree.
      this.prismaService.broadcastMessage.groupBy({
        by: ['broadcastId'],
        where: {
          broadcastId: { in: [...broadcastIds] },
          status: 'SENT',
          telegramMessageId: { not: null },
        },
        _count: { _all: true },
      }),
      // "Reached", counted the SAME way `checkAndFinalize` counts it: delivered
      // plus since-recalled. Counting SENT alone made a fully recalled
      // broadcast render as `0/400 (400 recalled)` while its stored
      // `successCount` — deliberately left at 400, because the send did
      // happen — said the opposite on the same row.
      this.prismaService.broadcastMessage.groupBy({
        by: ['broadcastId'],
        where: {
          broadcastId: { in: [...broadcastIds] },
          status: 'CANCELED',
          telegramMessageId: { not: null },
        },
        _count: { _all: true },
      }),
      // Recipients who have blocked the bot. Counted with the reason the
      // delivery path records, and the same predicate `getFailedMessageIds`
      // excludes — so the number on screen and the work the retry button finds
      // add up to `failedCount` exactly.
      this.prismaService.broadcastMessage.groupBy({
        by: ['broadcastId'],
        where: {
          broadcastId: { in: [...broadcastIds] },
          status: 'FAILED',
          errorMessage: BROADCAST_BLOCKED_REASON,
        },
        _count: { _all: true },
      }),
    ]);

    for (const row of states) {
      const entry = entryFor(row.broadcastId);
      if (row.status === 'PENDING') entry.pending = row._count._all;
      else if (row.status === 'SENT') entry.delivered = row._count._all;
      else entry.canceled = row._count._all;
    }
    for (const row of recallable) {
      entryFor(row.broadcastId).recallable = row._count._all;
    }
    for (const row of recalled) {
      entryFor(row.broadcastId).delivered += row._count._all;
    }
    for (const row of blocked) {
      entryFor(row.broadcastId).blocked = row._count._all;
    }
    return counts;
  }

  public async getBroadcast(broadcastId: string): Promise<BroadcastInterface> {
    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: broadcastId },
    });
    if (broadcast === null) {
      throw new NotFoundException('Broadcast not found');
    }
    const counts = await this.countMessageStates([broadcast.id]);
    return mapBroadcast(broadcast, counts.get(broadcast.id));
  }

  public async createDraft(input: {
    readonly dto: CreateBroadcastDraftDto;
    readonly currentAdmin: CurrentAdminInterface;
  }): Promise<BroadcastInterface> {
    if (input.dto.payload !== undefined) this.assertCaptionFits(input.dto.payload);
    const promoCode = await this.resolvePromoCodeForSave(input.dto.promoCode);
    const created = await this.prismaService.broadcast.create({
      data: {
        status: BroadcastStatus.DRAFT,
        audience: input.dto.audience,
        audiencePlanId: input.dto.audiencePlanId ?? null,
        promoCode: promoCode ?? null,
        payload: payloadDtoToJson(input.dto.payload),
        createdBy: input.currentAdmin.id,
        ...(input.dto.audienceFilter !== undefined
          ? { audienceFilter: input.dto.audienceFilter as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
    return mapBroadcast(created);
  }

  public async updateDraft(input: {
    readonly broadcastId: string;
    readonly dto: UpdateBroadcastDraftDto;
  }): Promise<BroadcastInterface> {
    const existing = await this.prismaService.broadcast.findUnique({
      where: { id: input.broadcastId },
      select: { id: true, status: true, payload: true, audiencePlanId: true },
    });
    if (existing === null) {
      throw new NotFoundException('Broadcast not found');
    }
    // A SCHEDULED broadcast is editable for the same reason a DRAFT is: it has
    // not gone anywhere yet, and the job re-reads content and audience when it
    // fires. Refusing it was a regression from giving a pending send its own
    // status — before that it stayed DRAFT and could be corrected during the
    // wait, which is exactly when an operator notices a typo.
    if (
      existing.status !== BroadcastStatus.DRAFT &&
      existing.status !== BroadcastStatus.SCHEDULED
    ) {
      throw new NotFoundException('Only draft or scheduled broadcasts can be updated');
    }
    const data: Prisma.BroadcastUpdateInput = {
      audience: input.dto.audience,
      audiencePlanId:
        input.dto.audiencePlanId === undefined
          ? undefined
          : input.dto.audiencePlanId,
    };
    if (input.dto.promoCode !== undefined) {
      data.promoCode = await this.resolvePromoCodeForSave(input.dto.promoCode);
    }
    if (input.dto.audienceFilter !== undefined) {
      data.audienceFilter = input.dto.audienceFilter as unknown as Prisma.InputJsonValue;
    }
    if (input.dto.payload !== undefined) {
      const merged = mergePayload(existing.payload, input.dto.payload);
      // The MERGED payload, not the patch: attaching a photo to a long draft
      // and shortening a long caption both arrive as one-field patches, and
      // either alone looks fine.
      this.assertCaptionFits(merged);
      data.payload = merged;
    }
    const updated = await this.prismaService.broadcast.update({
      where: { id: existing.id },
      data,
    });
    return mapBroadcast(updated);
  }

  /**
   * Claim a settled broadcast for a retry, answering the status it had.
   *
   * ── Why this is not `updateStatus(PROCESSING)` after the enqueue ─────────
   *
   * The retry jobs start the moment they are queued. A short retry — a handful
   * of recipients — can be picked up, delivered and FINALIZED back to COMPLETED
   * before the line after the enqueue runs, and that line then stamped
   * PROCESSING over the finished state. Nothing finalizes twice, so the
   * broadcast sat in PROCESSING for ever with no pending recipients: invisible
   * to the reconciler, which correctly skips a broadcast with nothing left to
   * send, and showing "still delivering" on a send that had completed.
   *
   * Claiming BEFORE the enqueue removes the race, and the precondition keeps
   * the claim honest: a broadcast that is already PROCESSING is not retried on
   * top of itself.
   */
  public async beginRetry(broadcastId: string): Promise<BroadcastStatus | null> {
    const existing = await this.prismaService.broadcast.findUnique({
      where: { id: broadcastId },
      select: { status: true },
    });
    if (existing === null) return null;
    // The read and the claim are two statements, so the status can move between
    // them. If it read PROCESSING and the broadcast then finalized, the claim
    // below succeeds and this would answer PROCESSING — which `abortRetry`
    // would later write back as PROCESSING, leaving the broadcast stuck in the
    // exact permanent state this method exists to prevent. Only a settled
    // status is a valid thing to restore.
    if (
      existing.status !== BroadcastStatus.COMPLETED &&
      existing.status !== BroadcastStatus.FAILED
    ) {
      return null;
    }
    const { count } = await this.prismaService.broadcast.updateMany({
      where: {
        id: broadcastId,
        status: { in: [BroadcastStatus.COMPLETED, BroadcastStatus.FAILED] },
      },
      // `startedAt` MOVES. The reconciler treats a broadcast as stalled when it
      // has been PROCESSING since before `now - 3h`, and failures are usually
      // noticed the next day — so leaving the original send time made every
      // retry of an older broadcast stale the instant it started. The next cron
      // tick then queued a START job on top of it, whose resume path re-batched
      // every row the retry had just put back to PENDING: the photo arrives
      // twice, and a text message collects the bot's deduplicated
      // `unconfirmed`, which overwrites a SENT row with FAILED.
      data: { status: BroadcastStatus.PROCESSING, startedAt: new Date() },
    });
    return count === 1 ? existing.status : null;
  }

  /**
   * Put every message a retry will touch back to PENDING, before any batch runs.
   *
   * ── Why not leave this to the batches ─────────────────────────────────────
   *
   * `retryBatch` reset only its OWN batch, and a retry of more than fifty
   * recipients is several batches. The finaliser's "is anything still pending?"
   * guard counts PENDING rows and does not count FAILED ones — so while batch 1
   * ran, batches 2..N were still FAILED and therefore invisible to it. If the
   * last row of batch 1 settled in the gap before batch 2's own reset landed,
   * the guard saw zero pending and wrote the broadcast COMPLETED, with interim
   * counters and a "broadcast sent" card, while most of the retry had not
   * started. That also re-opened Recall and Edit — both gated on COMPLETED — on
   * a send that was still going out.
   *
   * Flipping them all up front makes the guard true for the whole retry.
   */
  public async markForRetry(broadcastId: string, messageIds: readonly string[]): Promise<number> {
    const { count } = await this.prismaService.broadcastMessage.updateMany({
      where: { id: { in: [...messageIds] }, broadcastId, status: BroadcastMessageStatus.FAILED },
      // `errorMessage` is deliberately LEFT. Clearing it here erased every
      // original failure reason for a retry that then never left the queue —
      // the rollback puts the rows back to FAILED but cannot reconstruct why
      // they failed. It is not cleared later either: `retryBatch`'s own reset
      // matches on `status: FAILED`, and these rows are PENDING by then, so
      // that statement touches nothing. Every terminal branch of `deliverBatch`
      // rewrites the field anyway, so the stale reason only survives on a row
      // the circuit breaker never reaches.
      data: { status: BroadcastMessageStatus.PENDING },
    });
    return count;
  }

  /**
   * Undo a `beginRetry` claim whose jobs never made it onto the queue.
   *
   * The message ids matter: `markForRetry` has already flipped them
   * FAILED → PENDING, and restoring only the broadcast's status left them
   * stranded. Nothing recovers a PENDING row under a settled broadcast — the
   * reconciler looks only at PROCESSING, "retry failed" finds no FAILED rows to
   * offer, and the panel counts them for ever as "still delivering" on a
   * broadcast that has finished.
   */
  public async abortRetry(
    broadcastId: string,
    previous: BroadcastStatus,
    messageIds: readonly string[] = [],
  ): Promise<void> {
    if (messageIds.length > 0) {
      await this.prismaService.broadcastMessage.updateMany({
        where: { id: { in: [...messageIds] }, broadcastId, status: BroadcastMessageStatus.PENDING },
        data: { status: BroadcastMessageStatus.FAILED },
      });
    }
    await this.prismaService.broadcast.updateMany({
      where: { id: broadcastId, status: BroadcastStatus.PROCESSING },
      data: { status: previous },
    });
  }

  public async updateStatus(broadcastId: string, status: BroadcastStatus): Promise<void> {
    await this.prismaService.broadcast.update({
      where: { id: broadcastId },
      data: { status },
    });
  }

  /**
   * Compose-time promo validation. Normalizes the raw code, returns `null`
   * when the operator clears the tag (empty string), otherwise resolves the
   * canonical code and throws a `BadRequestException` unless the promo is
   * currently usable (exists + active + not expired + not depleted).
   */
  private async resolvePromoCodeForSave(
    rawCode: string | undefined,
  ): Promise<string | null> {
    if (rawCode === undefined) return null;
    const normalized = normalizeCode(rawCode);
    if (normalized.length === 0) return null;
    const evaluation = await this.evaluatePromoCode(normalized);
    if (evaluation === null) {
      throw new BadRequestException(`Promocode "${normalized}" not found`);
    }
    if (!isBroadcastPromocodeUsable(evaluation.status)) {
      throw new BadRequestException(promoStatusMessage(normalized, evaluation.status));
    }
    return evaluation.code;
  }

  /**
   * Dispatch-time gate. Re-validates the broadcast's promo tag right before
   * delivery is enqueued and throws a clear error when the code drifted into
   * EXPIRED / DEPLETED (or was deleted) since compose time. No-op when the
   * broadcast carries no promo tag.
   */
  public async assertPromoCodeDispatchable(broadcastId: string): Promise<void> {
    const verdict = await this.checkPromoCodeDispatchable(broadcastId);
    if (!verdict.ok) throw new BadRequestException(verdict.reason);
  }

  /**
   * The same gate, as an answer rather than an exception.
   *
   * ── Why staging needs it too ──────────────────────────────────────────────
   *
   * `assertPromoCodeDispatchable` runs when the operator presses send. For an
   * immediate send that is the moment of dispatch and the two are the same
   * check. For a SCHEDULED one they are hours apart, and a promo can expire or
   * be used up in that gap — the send then went out with a button that opens a
   * dead code, to the whole audience, irreversibly. A schedule revived by the
   * reconciler has the same gap, only wider.
   *
   * A send already IN FLIGHT is deliberately not re-checked. Staging returns
   * early for a PROCESSING broadcast (that is what makes a retry a resume), so
   * a stalled delivery that the reconciler picks back up finishes with the
   * button its first recipients already received. Refusing the tail of a send
   * whose head is already out would be the worse answer.
   *
   * One implementation, two shapes: the controller wants a 400, staging wants
   * to decide for itself what to do about it.
   */
  public async checkPromoCodeDispatchable(
    broadcastId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: broadcastId },
      select: { promoCode: true },
    });
    const code = broadcast?.promoCode ?? null;
    if (code === null || code.length === 0) return { ok: true };
    const evaluation = await this.evaluatePromoCode(code);
    if (evaluation === null) {
      return { ok: false, reason: `Promocode "${code}" no longer exists` };
    }
    if (!isBroadcastPromocodeUsable(evaluation.status)) {
      return { ok: false, reason: promoStatusMessage(code, evaluation.status) };
    }
    return { ok: true };
  }

  /**
   * Looks up a promo by (normalized) code and classifies it for broadcast use.
   * Returns `null` when the code does not exist.
   */
  private async evaluatePromoCode(
    normalizedCode: string,
  ): Promise<{ readonly code: string; readonly status: BroadcastPromoStatus } | null> {
    const record = await this.prismaService.promocode.findUnique({
      where: { code: normalizedCode },
      include: PROMOCODE_INCLUDE_ACTIVATIONS_COUNT,
    });
    if (record === null) return null;
    const status = evaluateBroadcastPromocode({
      isActive: record.isActive,
      createdAt: record.createdAt,
      lifetime: record.lifetime,
      expiresAt: record.expiresAt,
      maxActivations: record.maxActivations,
      activationsCount: record._count.activations,
    });
    return { code: record.code, status };
  }

  /**
   * Permanently delete a broadcast and all of its message rows. A broadcast
   * that is currently PROCESSING cannot be deleted (cancel it first) to avoid
   * orphaning in-flight delivery jobs.
   */
  public async deleteBroadcast(broadcastId: string): Promise<void> {
    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: broadcastId },
      select: { id: true, status: true },
    });
    if (broadcast === null) {
      throw new NotFoundException('Broadcast not found');
    }
    if (broadcast.status === BroadcastStatus.PROCESSING) {
      throw new BadRequestException(
        'Cannot delete a broadcast while it is processing — cancel it first',
      );
    }
    await this.prismaService.$transaction(async (tx) => {
      // Cabinet-feed events created by the fanout are keyed by broadcastId in
      // their JSON payload — drop them too, otherwise a deleted broadcast keeps
      // hanging in the user's notification feed.
      await tx.userNotificationEvent.deleteMany({
        where: {
          type: 'broadcast',
          payload: { path: ['broadcastId'], equals: broadcastId },
        },
      });
      await tx.broadcastMessage.deleteMany({ where: { broadcastId } });
      await tx.broadcast.delete({ where: { id: broadcastId } });
    });
  }

  /**
   * Update the text/parse-mode of a broadcast that has already been sent.
   * Besides updating the stored broadcast payload, this rewrites the
   * cabinet-feed notification events created for this broadcast so web/Telegram
   * users see the corrected text in their in-app feed. (Telegram message edits
   * are handled separately by the delivery worker via `enqueueEdit`.)
   */
  public async updateBroadcastContent(input: {
    readonly broadcastId: string;
    readonly text: string;
    /**
     * `undefined` leaves the stored value alone; `null` deliberately strips
     * formatting. Collapsing the two — which the controller used to do with
     * `?? null` — cleared the parse mode of any caller that simply omitted the
     * key, and a later retry then re-sent the tail of the audience unformatted
     * where the first recipients got HTML.
     */
    readonly parseMode?: 'HTML' | 'MarkdownV2' | null;
  }): Promise<void> {
    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: input.broadcastId },
      select: { id: true, payload: true },
    });
    if (broadcast === null) {
      throw new NotFoundException('Broadcast not found');
    }

    const merged = mergePayload(broadcast.payload, {
      text: input.text,
      parseMode: input.parseMode,
    });
    // The caption limit applies to a CORRECTION as much as to a first draft,
    // and this is the one path that writes `payload.text` without going through
    // `updateDraft`. Missing here it produced exactly what the limit exists to
    // prevent: a photo broadcast sent fine at 900 characters, corrected to
    // 1500, and every `editMessageCaption` refused at 1024 — four hundred
    // failures in the log, not one message changed, and the channel copy left
    // showing the original too.
    // The title counts, because the edit composes it in — exactly as the first
    // delivery and any later retry do. Measuring the body alone here let a
    // correction through that Telegram then refused for every recipient a
    // retry reached.
    this.assertCaptionFits(merged);

    await this.prismaService.broadcast.update({
      where: { id: input.broadcastId },
      data: { payload: merged },
    });

    // Rewrite the cabinet-feed events created by the fanout for this broadcast
    // in ONE atomic bulk statement. A large broadcast fans out to 100k+ feed
    // rows; the previous read-all-then-update-each loop pulled every row into
    // memory and issued one UPDATE per row inside the request handler — O(N)
    // round-trips that block the event loop and time out big edits. `jsonb_set`
    // rewrites only the `text` key server-side in a single pass.
    await this.prismaService.$executeRaw`
      UPDATE "user_notification_events"
      SET "payload" = jsonb_set("payload", '{text}', to_jsonb(${input.text}::text), true)
      WHERE "type" = 'broadcast'
        AND "payload" ->> 'broadcastId' = ${input.broadcastId}
    `;
  }

  public async previewAudience(
    broadcastId: string,
  ): Promise<BroadcastAudiencePreviewInterface> {
    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: broadcastId },
      select: { id: true, audience: true, audiencePlanId: true, audienceFilter: true },
    });
    if (broadcast === null) {
      throw new NotFoundException('Broadcast not found');
    }
    const totalRecipients = await this.countAudience({
      audience: broadcast.audience,
      audienceFilter: broadcast.audienceFilter,
    });
    return {
      audience: broadcast.audience,
      audiencePlanId: broadcast.audiencePlanId,
      audienceFilter: normalizeAudienceFilter(broadcast.audienceFilter),
      totalRecipients,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Count the recipients an audience resolves to. Uses the SAME shared
   * where-builder as delivery (`resolveRecipients`), so the preview count
   * always matches who is actually reached — the two used to diverge (preview
   * counted Telegram-only, delivery included web users). A structured
   * `audienceFilter` supersedes the `audience` enum preset when present.
   */
  private async countAudience(input: {
    readonly audience: BroadcastAudience;
    readonly audienceFilter: Prisma.JsonValue | null;
  }): Promise<number> {
    const where = buildAudienceWhere(
      input.audience,
      normalizeAudienceFilter(input.audienceFilter),
    );
    return this.prismaService.user.count({ where });
  }
}

function promoStatusMessage(code: string, status: BroadcastPromoStatus): string {
  switch (status) {
    case 'INACTIVE':
      return `Promocode "${code}" is inactive`;
    case 'EXPIRED':
      return `Promocode "${code}" has expired`;
    case 'DEPLETED':
      return `Promocode "${code}" has no activations left`;
    case 'OK':
      return `Promocode "${code}" is usable`;
  }
}

function payloadDtoToJson(
  payload: BroadcastPayloadDto | undefined,
): Prisma.InputJsonObject {
  return {
    title: payload?.title ?? null,
    text: payload?.text ?? null,
    mediaType: payload?.mediaType ?? 'none',
    mediaFileId: payload?.mediaFileId ?? null,
    parseMode: payload?.parseMode ?? null,
    emailEnabled: payload?.emailEnabled ?? false,
    telegramChannelChatId: payload?.telegramChannelChatId ?? null,
  };
}

/**
 * Patch accepted by {@link mergePayload}. Wider than {@link BroadcastPayloadDto}
 * in exactly one place: the post-send edit flow sends `parseMode: null` to strip
 * the formatting of an already-delivered broadcast, and only `undefined` (an
 * absent key) may leave the stored value untouched — so "clear it" needs a value
 * of its own, the same `null` the stored payload and `readParseMode` already use.
 */
type BroadcastPayloadPatch = Omit<BroadcastPayloadDto, 'parseMode'> & {
  readonly parseMode?: 'HTML' | 'MarkdownV2' | null;
};

function mergePayload(
  existing: Prisma.JsonValue,
  patch: BroadcastPayloadPatch,
): Prisma.InputJsonObject {
  const base: Record<string, unknown> =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  if (patch.title !== undefined) base.title = patch.title;
  if (patch.text !== undefined) base.text = patch.text;
  if (patch.mediaType !== undefined) base.mediaType = patch.mediaType;
  if (patch.mediaFileId !== undefined) base.mediaFileId = patch.mediaFileId;
  if (patch.parseMode !== undefined) base.parseMode = patch.parseMode;
  if (patch.emailEnabled !== undefined) base.emailEnabled = patch.emailEnabled;
  if (patch.telegramChannelChatId !== undefined) {
    base.telegramChannelChatId = patch.telegramChannelChatId;
  }
  return base as Prisma.InputJsonObject;
}

function mapBroadcast(
  record: Broadcast,
  counts?: {
    readonly pending: number;
    readonly canceled: number;
    readonly recallable: number;
    readonly delivered: number;
    readonly blocked: number;
  },
): BroadcastInterface {
  return {
    id: record.id,
    status: record.status,
    audience: record.audience,
    audiencePlanId: record.audiencePlanId,
    audienceFilter: normalizeAudienceFilter(record.audienceFilter),
    promoCode: record.promoCode,
    payload: readPayload(record.payload),
    totalCount: record.totalCount,
    successCount: record.successCount,
    failedCount: record.failedCount,
    // Falling back to the old arithmetic keeps a caller that has no counts
    // truthful for the common case, and never negative.
    pendingCount:
      counts?.pending ??
      Math.max(0, record.totalCount - record.successCount - record.failedCount),
    canceledCount: counts?.canceled ?? 0,
    recallableCount: counts?.recallable ?? 0,
    blockedCount: counts?.blocked ?? 0,
    // ── THREE STATES, NOT TWO ─────────────────────────────────────────────
    //
    // A boolean could not say "there is a public copy and we cannot address
    // it", which is the NORMAL state wherever the bot answers a bodiless 204
    // and echoes no message id. Folded into `false`, the panel hid the recall
    // button for exactly the broadcasts that most needed one — and the warning
    // that says "remove it by hand" was only reachable by pressing a button
    // that was never rendered.
    channelPost: channelPostStateOf(record),
    deliveredCount: counts?.delivered ?? record.successCount,
    createdBy: record.createdBy,
    scheduledAt: record.scheduledAt?.toISOString() ?? null,
    startedAt: record.startedAt?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * What the operator-channel copy of this broadcast is, from the row alone.
 *
 * Mirrors `BroadcastDeliveryService.channelPostAddress`, which answers the same
 * question for the recall route. The two must agree: one decides whether the
 * button appears, the other decides what pressing it does.
 */
function channelPostStateOf(record: Broadcast): 'none' | 'addressable' | 'unaddressable' {
  const chatId = record.channelChatId ?? null;
  const messageId = record.channelMessageId ?? null;
  if (chatId !== null && messageId !== null) return 'addressable';
  // A chat we stored and an id we no longer hold: a successful recall clears
  // the id and keeps the chat, so the post is already down.
  if (chatId !== null) return 'none';
  const payload = record.payload as Record<string, unknown> | null;
  const configured =
    typeof payload?.telegramChannelChatId === 'string' &&
    payload.telegramChannelChatId.trim().length > 0;
  return configured ? 'unaddressable' : 'none';
}

function readPayload(value: Prisma.JsonValue): BroadcastPayloadInterface {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      title: null,
      text: null,
      mediaType: 'none',
      mediaFileId: null,
      parseMode: null,
      emailEnabled: false,
      telegramChannelChatId: null,
    };
  }
  const candidate = value as Record<string, unknown>;
  return {
    title: typeof candidate.title === 'string' ? candidate.title : null,
    text: typeof candidate.text === 'string' ? candidate.text : null,
    mediaType: readMediaType(candidate.mediaType),
    mediaFileId:
      typeof candidate.mediaFileId === 'string' ? candidate.mediaFileId : null,
    parseMode: readParseMode(candidate.parseMode),
    emailEnabled: candidate.emailEnabled === true,
    telegramChannelChatId:
      typeof candidate.telegramChannelChatId === 'string' &&
      candidate.telegramChannelChatId.trim().length > 0
        ? candidate.telegramChannelChatId.trim()
        : null,
  };
}

function readMediaType(value: unknown): 'none' | 'photo' | 'video' {
  return value === 'photo' || value === 'video' ? value : 'none';
}

function readParseMode(value: unknown): 'HTML' | 'MarkdownV2' | null {
  return value === 'HTML' || value === 'MarkdownV2' ? value : null;
}
