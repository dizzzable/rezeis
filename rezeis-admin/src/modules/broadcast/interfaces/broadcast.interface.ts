import { BroadcastAudience, BroadcastStatus } from '@prisma/client';

export interface BroadcastPayloadInterface {
  readonly text: string | null;
  readonly mediaType: 'none' | 'photo' | 'video';
  readonly mediaFileId: string | null;
  readonly parseMode: 'HTML' | 'MarkdownV2' | null;
}

export interface BroadcastInterface {
  readonly id: string;
  readonly status: BroadcastStatus;
  readonly audience: BroadcastAudience;
  readonly audiencePlanId: string | null;
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
  /** Recipients matched by the audience filter at preview time. */
  readonly totalRecipients: number;
  readonly generatedAt: string;
}
