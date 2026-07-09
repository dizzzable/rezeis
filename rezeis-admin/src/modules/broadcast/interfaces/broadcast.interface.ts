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
  readonly createdBy: string | null;
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
