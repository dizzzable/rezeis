import type { Pool } from 'pg';
import { BroadcastRepository } from '../../repositories/broadcast.repository.js';
import type { PaginatedResult } from '../../repositories/base.repository.js';
import { logger } from '../../utils/logger.js';
import type {
  Broadcast,
  CreateBroadcastDTO,
  UpdateBroadcastDTO,
  BroadcastFilters,
  BroadcastAudience,
  BroadcastButton,
} from '../../entities/broadcast.entity.js';
import type {
  CreateBroadcastInput,
  UpdateBroadcastInput,
  BroadcastResponse,
} from './broadcast.schemas.js';

/**
 * Button response type
 */
interface ButtonResponse {
  id: string;
  broadcastId: string;
  text: string;
  type: string;
  value: string;
  createdAt: string;
}

/**
 * Broadcast not found error
 */
export class BroadcastNotFoundError extends Error {
  constructor(broadcastId: string) {
    super(`Broadcast with id ${broadcastId} not found`);
    this.name = 'BroadcastNotFoundError';
  }
}

/**
 * Permission denied error
 */
export class PermissionDeniedError extends Error {
  constructor() {
    super('Only super admin or admin can manage broadcasts');
    this.name = 'PermissionDeniedError';
  }
}

/**
 * Invalid broadcast state error
 */
export class InvalidBroadcastStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBroadcastStateError';
  }
}

/**
 * Telegram API error
 */
export class TelegramApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

/**
 * Broadcast service configuration
 */
interface BroadcastServiceConfig {
  broadcastRepository: BroadcastRepository;
  telegramBotToken: string;
}

/**
 * Create broadcast service factory
 * @param db - PostgreSQL pool instance
 * @param telegramBotToken - Telegram bot token
 * @returns Broadcast service instance
 */
export function createBroadcastService(db: Pool, telegramBotToken: string): BroadcastService {
  const broadcastRepository = new BroadcastRepository(db);
  return new BroadcastService({ broadcastRepository, telegramBotToken });
}

/**
 * Broadcast service class
 * Handles all broadcast-related business logic
 */
class BroadcastService {
  private readonly broadcastRepository: BroadcastRepository;
  private readonly telegramBotToken: string;

  constructor(config: BroadcastServiceConfig) {
    this.broadcastRepository = config.broadcastRepository;
    this.telegramBotToken = config.telegramBotToken;
  }

  /**
   * Check if user is admin or super_admin
   * @param userRole - User role from JWT
   * @returns True if admin
   */
  private isAdmin(userRole: string): boolean {
    return userRole === 'super_admin' || userRole === 'admin';
  }

  /**
   * Verify admin permission
   * @param userRole - User role from JWT
   * @throws PermissionDeniedError if not admin
   */
  private verifyAdmin(userRole: string): void {
    if (!this.isAdmin(userRole)) {
      throw new PermissionDeniedError();
    }
  }

  /**
   * Map Broadcast entity to BroadcastResponse
   * @param broadcast - Broadcast entity
   * @returns Broadcast response object
   */
  private mapBroadcastToResponse(broadcast: Broadcast): BroadcastResponse {
    return {
      id: broadcast.id,
      audience: broadcast.audience,
      planId: broadcast.planId,
      content: broadcast.content,
      mediaUrl: broadcast.mediaUrl,
      mediaType: broadcast.mediaType,
      status: broadcast.status,
      recipientsCount: broadcast.recipientsCount,
      sentCount: broadcast.sentCount,
      failedCount: broadcast.failedCount,
      createdBy: broadcast.createdBy,
      createdAt: broadcast.createdAt.toISOString(),
      sentAt: broadcast.sentAt?.toISOString(),
      errorMessage: broadcast.errorMessage,
    };
  }

  /**
   * Map BroadcastButton entity to response
   * @param button - BroadcastButton entity
   * @returns Button response object
   */
  private mapButtonToResponse(button: BroadcastButton): ButtonResponse {
    return {
      id: button.id,
      broadcastId: button.broadcastId,
      text: button.text,
      type: button.type,
      value: button.value,
      createdAt: button.createdAt.toISOString(),
    };
  }

  /**
   * Get broadcasts with pagination and filters
   * @param params - Query parameters
   * @param userRole - Current user role for authorization
   * @returns Paginated broadcasts
   */
  async getBroadcasts(
    params: { page: number; limit: number; status?: Broadcast['status']; audience?: Broadcast['audience'] },
    userRole: string
  ): Promise<PaginatedResult<BroadcastResponse>> {
    this.verifyAdmin(userRole);

    const filters: BroadcastFilters = {};
    if (params.status) {
      filters.status = params.status;
    }
    if (params.audience) {
      filters.audience = params.audience;
    }

    const result = await this.broadcastRepository.getBroadcastsWithPagination(
      params.page,
      params.limit,
      Object.keys(filters).length > 0 ? filters : undefined
    );

    return {
      data: result.data.map((broadcast) => this.mapBroadcastToResponse(broadcast)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  /**
   * Get broadcast by ID
   * @param id - Broadcast ID
   * @param userRole - Current user role for authorization
   * @returns Broadcast with buttons or null
   */
  async getBroadcastById(
    id: string,
    userRole: string
  ): Promise<{ broadcast: BroadcastResponse; buttons: ButtonResponse[] } | null> {
    this.verifyAdmin(userRole);

    const result = await this.broadcastRepository.findWithButtons(id);
    if (!result) {
      return null;
    }

    return {
      broadcast: this.mapBroadcastToResponse(result.broadcast),
      buttons: result.buttons.map((button) => this.mapButtonToResponse(button)),
    };
  }

  /**
   * Create broadcast
   * @param data - Create broadcast data
   * @param userId - Current user ID
   * @param userRole - Current user role for authorization
   * @returns Created broadcast with buttons
   */
  async createBroadcast(
    data: CreateBroadcastInput,
    userId: string,
    userRole: string
  ): Promise<{ broadcast: BroadcastResponse; buttons: ButtonResponse[] }> {
    this.verifyAdmin(userRole);

    // Validate planId for PLAN audience
    if (data.audience === 'PLAN' && !data.planId) {
      throw new InvalidBroadcastStateError('Plan ID is required for PLAN audience');
    }

    const createData: CreateBroadcastDTO = {
      audience: data.audience,
      planId: data.planId,
      content: data.content,
      mediaUrl: data.mediaUrl,
      mediaType: data.mediaType,
      status: 'draft',
      createdBy: userId,
    };

    const broadcast = await this.broadcastRepository.create(createData);

    // Create buttons
    const buttons: BroadcastButton[] = [];
    if (data.buttons && data.buttons.length > 0) {
      for (const buttonData of data.buttons) {
        const button = await this.broadcastRepository.createButton({
          broadcastId: broadcast.id,
          text: buttonData.text,
          type: buttonData.type,
          value: buttonData.value,
        });
        buttons.push(button);
      }
    }

    logger.info({ broadcastId: broadcast.id }, 'Broadcast created successfully');

    return {
      broadcast: this.mapBroadcastToResponse(broadcast),
      buttons: buttons.map((button) => this.mapButtonToResponse(button)),
    };
  }

  /**
   * Update broadcast
   * @param id - Broadcast ID
   * @param data - Update broadcast data
   * @param userRole - Current user role for authorization
   * @returns Updated broadcast with buttons
   */
  async updateBroadcast(
    id: string,
    data: UpdateBroadcastInput,
    userRole: string
  ): Promise<{ broadcast: BroadcastResponse; buttons: ButtonResponse[] }> {
    this.verifyAdmin(userRole);

    const existing = await this.broadcastRepository.findWithButtons(id);
    if (!existing) {
      throw new BroadcastNotFoundError(id);
    }

    // Only allow updates for draft broadcasts
    if (existing.broadcast.status !== 'draft') {
      throw new InvalidBroadcastStateError('Only draft broadcasts can be updated');
    }

    // Validate planId for PLAN audience
    if (data.audience === 'PLAN' && !data.planId && !existing.broadcast.planId) {
      throw new InvalidBroadcastStateError('Plan ID is required for PLAN audience');
    }

    const updateData: UpdateBroadcastDTO = {};
    if (data.audience !== undefined) updateData.audience = data.audience;
    if (data.planId !== undefined) updateData.planId = data.planId;
    if (data.content !== undefined) updateData.content = data.content;
    if (data.mediaUrl !== undefined) updateData.mediaUrl = data.mediaUrl;
    if (data.mediaType !== undefined) updateData.mediaType = data.mediaType;

    const broadcast = await this.broadcastRepository.update(id, updateData);

    // Update buttons if provided
    let buttons = existing.buttons;
    if (data.buttons !== undefined) {
      // Delete existing buttons
      await this.broadcastRepository.deleteButtonsByBroadcastId(id);

      // Create new buttons
      buttons = [];
      if (data.buttons.length > 0) {
        for (const buttonData of data.buttons) {
          const button = await this.broadcastRepository.createButton({
            broadcastId: broadcast.id,
            text: buttonData.text,
            type: buttonData.type,
            value: buttonData.value,
          });
          buttons.push(button);
        }
      }
    }

    logger.info({ broadcastId: id }, 'Broadcast updated successfully');

    return {
      broadcast: this.mapBroadcastToResponse(broadcast),
      buttons: buttons.map((button) => this.mapButtonToResponse(button)),
    };
  }

  /**
   * Delete broadcast
   * @param id - Broadcast ID
   * @param userRole - Current user role for authorization
   */
  async deleteBroadcast(id: string, userRole: string): Promise<void> {
    this.verifyAdmin(userRole);

    const existing = await this.broadcastRepository.findById(id);
    if (!existing) {
      throw new BroadcastNotFoundError(id);
    }

    // Only allow deletion for draft broadcasts
    if (existing.status !== 'draft') {
      throw new InvalidBroadcastStateError('Only draft broadcasts can be deleted');
    }

    await this.broadcastRepository.delete(id);
    logger.info({ broadcastId: id }, 'Broadcast deleted successfully');
  }

  /**
   * Get audience count
   * @param audience - Audience type
   * @param planId - Optional plan ID
   * @param userRole - Current user role for authorization
   * @returns Audience count
   */
  async getAudienceCount(
    audience: BroadcastAudience,
    planId: string | undefined,
    userRole: string
  ): Promise<{ audience: BroadcastAudience; planId?: string; count: number }> {
    this.verifyAdmin(userRole);

    if (audience === 'PLAN' && !planId) {
      throw new InvalidBroadcastStateError('Plan ID is required for PLAN audience');
    }

    const count = await this.broadcastRepository.countAudience(audience, planId);

    return {
      audience,
      planId,
      count,
    };
  }

  /**
   * Send broadcast via Telegram Bot API
   * @param id - Broadcast ID
   * @param userRole - Current user role for authorization
   * @returns Send result
   */
  async sendBroadcast(
    id: string,
    userRole: string
  ): Promise<{ broadcastId: string; status: string; recipientsCount: number; message: string }> {
    this.verifyAdmin(userRole);

    const existing = await this.broadcastRepository.findWithButtons(id);
    if (!existing) {
      throw new BroadcastNotFoundError(id);
    }

    const broadcast = existing.broadcast;
    const buttons = existing.buttons;

    // Only allow sending for draft or failed broadcasts
    if (broadcast.status !== 'draft' && broadcast.status !== 'failed') {
      throw new InvalidBroadcastStateError('Only draft or failed broadcasts can be sent');
    }

    // Update status to pending
    await this.broadcastRepository.updateStatus(id, 'pending');

    try {
      // Get audience user IDs
      const userIds = await this.broadcastRepository.getAudienceUserIds(
        broadcast.audience,
        broadcast.planId
      );

      if (userIds.length === 0) {
        await this.broadcastRepository.updateStatus(id, 'completed');
        await this.broadcastRepository.updateRecipientsCount(id, 0);
        return {
          broadcastId: id,
          status: 'completed',
          recipientsCount: 0,
          message: 'Broadcast sent successfully (no recipients found)',
        };
      }

      // Update recipients count
      await this.broadcastRepository.updateRecipientsCount(id, userIds.length);

      // Update status to sending
      await this.broadcastRepository.updateStatus(id, 'sending');

      // Start sending process asynchronously
      this.executeBroadcastSending(id, broadcast, buttons, userIds);

      return {
        broadcastId: id,
        status: 'sending',
        recipientsCount: userIds.length,
        message: `Broadcast started sending to ${userIds.length} recipients`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.broadcastRepository.updateStatus(id, 'failed', errorMessage);
      throw new TelegramApiError(`Failed to start broadcast: ${errorMessage}`);
    }
  }

  /**
   * Execute broadcast sending via Telegram Bot API
   * @param broadcastId - Broadcast ID
   * @param broadcast - Broadcast entity
   * @param buttons - Broadcast buttons
   * @param userIds - Array of user IDs
   */
  private async executeBroadcastSending(
    broadcastId: string,
    broadcast: Broadcast,
    buttons: BroadcastButton[],
    userIds: string[]
  ): Promise<void> {
    let sentCount = 0;
    let failedCount = 0;

    try {
      logger.info({ broadcastId, recipientCount: userIds.length }, 'Starting broadcast sending');

      // Process in batches of 30 (Telegram rate limits)
      const batchSize = 30;
      const delay = 1000; // 1 second delay between batches

      for (let i = 0; i < userIds.length; i += batchSize) {
        const batch = userIds.slice(i, i + batchSize);

        for (const userId of batch) {
          try {
            await this.sendTelegramMessage(userId, broadcast, buttons);
            sentCount++;
          } catch (error) {
            logger.error({ error, userId, broadcastId }, 'Failed to send message to user');
            failedCount++;
          }
        }

        // Update statistics
        await this.broadcastRepository.updateStatistics(broadcastId, sentCount, failedCount);

        // Delay between batches (except for the last one)
        if (i + batchSize < userIds.length) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      // Mark as completed
      await this.broadcastRepository.updateStatus(broadcastId, 'completed');

      logger.info(
        { broadcastId, sentCount, failedCount },
        'Broadcast sending completed'
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.broadcastRepository.updateStatus(broadcastId, 'failed', errorMessage);
      logger.error({ error, broadcastId }, 'Broadcast sending failed');
    }
  }

  /**
   * Send Telegram message
   * @param userId - User ID (Telegram ID)
   * @param broadcast - Broadcast entity
   * @param buttons - Broadcast buttons
   */
  private async sendTelegramMessage(
    userId: string,
    broadcast: Broadcast,
    buttons: BroadcastButton[]
  ): Promise<void> {
    const apiUrl = `https://api.telegram.org/bot${this.telegramBotToken}`;

    // Build reply markup if buttons exist
    let replyMarkup: { inline_keyboard: { text: string; url?: string; callback_data?: string }[][] } | undefined;
    if (buttons.length > 0) {
      replyMarkup = {
        inline_keyboard: [
          buttons.map((button) => ({
            text: button.text,
            url: button.type === 'url' ? button.value : undefined,
            callback_data: button.type === 'goto' ? button.value : undefined,
          })),
        ],
      };
    }

    if (broadcast.mediaUrl && broadcast.mediaType === 'photo') {
      // Send photo with caption
      const response = await fetch(`${apiUrl}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: userId,
          photo: broadcast.mediaUrl,
          caption: broadcast.content,
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json() as { description?: string };
        throw new Error(errorData.description || 'Failed to send photo');
      }
    } else if (broadcast.mediaUrl && broadcast.mediaType === 'video') {
      // Send video with caption
      const response = await fetch(`${apiUrl}/sendVideo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: userId,
          video: broadcast.mediaUrl,
          caption: broadcast.content,
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json() as { description?: string };
        throw new Error(errorData.description || 'Failed to send video');
      }
    } else {
      // Send text message
      const response = await fetch(`${apiUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: userId,
          text: broadcast.content,
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json() as { description?: string };
        throw new Error(errorData.description || 'Failed to send message');
      }
    }
  }

  /**
   * Preview broadcast
   * @param id - Broadcast ID
   * @param telegramId - Telegram ID to send preview to
   * @param userRole - Current user role for authorization
   */
  async previewBroadcast(id: string, telegramId: string, userRole: string): Promise<void> {
    this.verifyAdmin(userRole);

    const existing = await this.broadcastRepository.findWithButtons(id);
    if (!existing) {
      throw new BroadcastNotFoundError(id);
    }

    try {
      await this.sendTelegramMessage(telegramId, existing.broadcast, existing.buttons);
      logger.info({ broadcastId: id, telegramId }, 'Broadcast preview sent');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new TelegramApiError(`Failed to send preview: ${errorMessage}`);
    }
  }
}
