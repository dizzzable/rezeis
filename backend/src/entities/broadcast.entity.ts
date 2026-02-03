/**
 * Broadcast audience type enum
 */
export type BroadcastAudience = 'ALL' | 'PLAN' | 'SUBSCRIBED' | 'UNSUBSCRIBED' | 'EXPIRED' | 'TRIAL';

/**
 * Broadcast status enum
 */
export type BroadcastStatus = 'draft' | 'pending' | 'sending' | 'completed' | 'failed';

/**
 * Broadcast button type enum
 */
export type BroadcastButtonType = 'url' | 'goto';

/**
 * Broadcast button interface
 */
export interface BroadcastButton {
  id: string;
  broadcastId: string;
  text: string;
  type: BroadcastButtonType;
  value: string;
  createdAt: Date;
}

/**
 * Broadcast entity interface
 */
export interface Broadcast {
  id: string;
  audience: BroadcastAudience;
  planId?: string;
  content: string;
  mediaUrl?: string;
  mediaType?: 'photo' | 'video';
  status: BroadcastStatus;
  recipientsCount: number;
  sentCount: number;
  failedCount: number;
  createdBy: string;
  createdAt: Date;
  sentAt?: Date;
  errorMessage?: string;
}

/**
 * Create broadcast DTO
 */
export type CreateBroadcastDTO = Omit<Broadcast, 'id' | 'createdAt' | 'sentAt' | 'recipientsCount' | 'sentCount' | 'failedCount'>;

/**
 * Update broadcast DTO
 */
export type UpdateBroadcastDTO = Partial<Omit<Broadcast, 'id' | 'createdAt' | 'createdBy'>>;

/**
 * Create broadcast button DTO
 */
export type CreateBroadcastButtonDTO = Omit<BroadcastButton, 'id' | 'createdAt'>;

/**
 * Broadcast filters for pagination
 */
export interface BroadcastFilters {
  status?: BroadcastStatus;
  audience?: BroadcastAudience;
  createdBy?: string;
  startDate?: Date;
  endDate?: Date;
}

/**
 * Audience count result
 */
export interface AudienceCount {
  audience: BroadcastAudience;
  planId?: string;
  count: number;
}
