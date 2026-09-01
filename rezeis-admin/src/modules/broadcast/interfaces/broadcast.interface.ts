import { BroadcastAudience, BroadcastStatus } from '@prisma/client';

import type { BroadcastAudienceFilter } from '../utils/broadcast-audience.util';

export interface BroadcastPayloadInterface {
  readonly title: string | null;
  readonly text: string | null;
  readonly mediaType: 'none' | 'photo' | 'video';
  readonly mediaFileId: string | null;
  readonly parseMode: 'HTML' | 'MarkdownV2' | null;
  /** Additive channel: also email recipients who have an email. */
  readonly emailEnabled: boolean;
  /** Additive channel: one-shot Telegram channel/group post target (or null). */
  readonly telegramChannelChatId: string | null;
}

export interface BroadcastInterface {
  readonly id: string;
  readonly status: BroadcastStatus;
  readonly audience: BroadcastAudience;
  readonly audiencePlanId: string | null;
  /** Structured multi-select filter; supersedes `audience` when non-null. */
  readonly audienceFilter: BroadcastAudienceFilter | null;
  readonly promoCode: string | null;
  readonly payload: BroadcastPayloadInterface;
  readonly totalCount: number;
  readonly successCount: number;
  readonly failedCount: number;
  /**
   * Recipients still awaiting dispatch, COUNTED rather than derived.
   *
   * The panel used to compute it as `total - success - failed`, which assumes
   * every recipient is one of those three. Cancelling and recalling both make a
   * fourth, so a recalled broadcast claimed for ever that it was "still
   * delivering" to people whose message had just been withdrawn.
   */
  readonly pendingCount: number;
  /** Recipients cancelled before dispatch, or recalled after it. */
  readonly canceledCount: number;
  /**
   * Messages a recall could still take out of a chat.
   *
   * NOT `successCount - canceledCount`. `successCount` counts every recipient
   * the broadcast REACHED, and it reaches web-only users through the cabinet
   * feed — those rows are SENT with no Telegram message id, and no `deleteMessage`
   * can touch them. Deriving the number instead of counting it offered to
   * recall messages that never existed, and left the button lit for ever on a
   * broadcast that had already been fully recalled.
   *
   * Counted with the same predicate the recall itself uses, so the number on
   * screen and the work the endpoint finds cannot disagree.
   */
  readonly recallableCount: number;
  /**
   * Recipients who have blocked the bot.
   *
   * Counted apart from `failedCount` because it is not the same kind of fact. A
   * failure might clear on a retry; this one cannot — the person has to unblock
   * the bot first — and the relay deduplicates the retry anyway. Folded in, it
   * was the bulk of "N ошибок" on every mature audience, next to a button that
   * could never change the number.
   */
  readonly blockedCount: number;
  /**
   * Recipients already delivered to, counted live.
   *
   * `successCount` is written once, by the finaliser. Until then the panel had
   * nothing but that zero to show, so a send half-way through 400 people read
   * `0/400` in green with 200 delivered and 200 unaccounted for — on the very
   * screen an operator watches to decide whether a broadcast is going well.
   */
  readonly deliveredCount: number;
  /**
   * What the public copy on the operator channel is, if there is one.
   *
   * The panel needs it to decide whether a recall is worth offering at all: a
   * broadcast delivered only to web-only users has no Telegram message ids, so
   * every recipient-based count is zero while the post anyone can read is still
   * there.
   *
   * `unaddressable` is a state of its own, not a `false`. It is the normal one
   * wherever the bot answers a bodiless 204 and echoes no message id — the post
   * exists and nothing here can reach it. Collapsed into "no post", the panel
   * hid the recall button for exactly those broadcasts, so the warning that
   * says "remove it by hand" could only be reached by pressing a button that
   * was not rendered.
   */
  readonly channelPost: 'none' | 'addressable' | 'unaddressable';
  readonly createdBy: string | null;
  /** When a scheduled send is due; `null` for an immediate one. */
  readonly scheduledAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BroadcastAudiencePreviewInterface {
  readonly audience: BroadcastAudience;
  readonly audiencePlanId: string | null;
  readonly audienceFilter: BroadcastAudienceFilter | null;
  /** Recipients matched by the audience filter at preview time. */
  readonly totalRecipients: number;
  readonly generatedAt: string;
}
