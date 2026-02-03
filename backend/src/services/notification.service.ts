import type { Pool } from 'pg';
import type { Subscription } from '../entities/subscription.entity.js';
import type { BulkRenewalResult } from './subscription-enhanced.service.js';
import { getTelegramConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Telegram inline keyboard button
 */
export interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}

/**
 * Notification options
 */
export interface NotificationOptions {
  chatId: string;
  message: string;
  buttons?: InlineKeyboardButton[];
  photo?: string;
  parseMode?: 'HTML' | 'Markdown';
}

/**
 * NotificationService - Service for sending Telegram notifications
 */
export class NotificationService {
  private readonly telegramConfig: ReturnType<typeof getTelegramConfig>;

  constructor() {
    this.telegramConfig = getTelegramConfig();
  }

  /**
   * Send a Telegram notification
   * @param options - Notification options
   * @returns Success status
   */
  async sendTelegramNotification(options: NotificationOptions): Promise<boolean> {
    try {
      const botToken = this.telegramConfig.botToken;
      if (!botToken) {
        logger.warn('Telegram bot token not configured');
        return false;
      }

      const formData = new FormData();
      formData.append('chat_id', options.chatId);
      formData.append('text', options.message);
      formData.append('parse_mode', options.parseMode || 'HTML');

      if (options.buttons && options.buttons.length > 0) {
        const keyboard = {
          inline_keyboard: options.buttons.map((button) => [
            {
              text: button.text,
              url: button.url,
              callback_data: button.callback_data,
            },
          ]),
        };
        formData.append('reply_markup', JSON.stringify(keyboard));
      }

      if (options.photo) {
        formData.append('photo', options.photo);
      }

      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const error = await response.text();
        logger.error({ error }, 'Failed to send Telegram notification');
        return false;
      }

      return true;
    } catch (error) {
      logger.error({ error, options }, 'Failed to send Telegram notification');
      return false;
    }
  }

  /**
   * Notify subscription created
   * @param userId - User ID
   * @param subscription - Subscription details
   */
  async notifySubscriptionCreated(userId: string, subscription: Subscription): Promise<void> {
    const user = await this.getUserTelegramId(userId);
    if (!user) return;

    const message = `✅ <b>Subscription Created</b>

Your subscription has been activated!
- Plan: ${subscription.planId}
- Ends: ${subscription.endDate.toLocaleDateString()}
- Status: ${subscription.status}

Thank you for choosing our service!`;

    await this.sendTelegramNotification({
      chatId: user.telegramId!,
      message,
    });
  }

  /**
   * Notify trial activated
   * @param userId - User ID
   * @param subscription - Subscription details
   * @param durationDays - Trial duration
   */
  async notifyTrialActivated(userId: string, subscription: Subscription, durationDays: number): Promise<void> {
    const user = await this.getUserTelegramId(userId);
    if (!user) return;

    const message = `🎁 <b>Trial Activated!</b>

Your ${durationDays}-day trial subscription is now active!
- Ends: ${subscription.endDate.toLocaleDateString()}

Enjoy your free trial and let us know if you have any questions!`;

    await this.sendTelegramNotification({
      chatId: user.telegramId!,
      message,
    });
  }

  /**
   * Notify subscription renewed
   * @param userId - User ID
   * @param subscription - Subscription details
   * @param daysAdded - Days added
   */
  async notifySubscriptionRenewed(userId: string, subscription: Subscription, daysAdded: number): Promise<void> {
    const user = await this.getUserTelegramId(userId);
    if (!user) return;

    const message = `🔄 <b>Subscription Renewed</b>

Your subscription has been extended by ${daysAdded} days!
- New end date: ${subscription.endDate.toLocaleDateString()}

Thank you for your continued support!`;

    await this.sendTelegramNotification({
      chatId: user.telegramId!,
      message,
    });
  }

  /**
   * Notify subscription expiring soon
   * @param userId - User ID
   * @param subscription - Subscription details
   * @param hoursLeft - Hours until expiration
   */
  async notifySubscriptionExpiring(userId: string, subscription: Subscription, hoursLeft: number): Promise<void> {
    const user = await this.getUserTelegramId(userId);
    if (!user) return;

    const message = `⚠️ <b>Subscription Expiring Soon</b>

Your subscription will expire in ${hoursLeft} hours!
- End date: ${subscription.endDate.toLocaleDateString()}

Don't forget to renew to continue using our service.`;

    await this.sendTelegramNotification({
      chatId: user.telegramId!,
      message,
      buttons: [
        { text: '🔄 Renew Now', callback_data: 'renew' },
      ],
    });
  }

  /**
   * Notify subscription expired
   * @param userId - User ID
   * @param subscription - Subscription details
   */
  async notifySubscriptionExpired(userId: string, subscription: Subscription): Promise<void> {
    const user = await this.getUserTelegramId(userId);
    if (!user) return;

    const message = `❌ <b>Subscription Expired</b>

Your subscription has expired.
- Plan: ${subscription.planId}

Renew now to continue using our service!`;

    await this.sendTelegramNotification({
      chatId: user.telegramId!,
      message,
      buttons: [
        { text: '🔄 Renew Now', callback_data: 'renew' },
      ],
    });
  }

  /**
   * Notify traffic limit reached
   * @param userId - User ID
   * @param subscription - Subscription details
   * @param limitGb - Traffic limit in GB
   */
  async notifyTrafficLimitReached(userId: string, subscription: Subscription, limitGb: number): Promise<void> {
    const user = await this.getUserTelegramId(userId);
    if (!user) return;

    const message = `📊 <b>Traffic Limit Reached</b>

You've used ${limitGb}GB of your monthly traffic limit.
- Plan: ${subscription.planId}

Consider upgrading your plan for more traffic!`;

    await this.sendTelegramNotification({
      chatId: user.telegramId!,
      message,
      buttons: [
        { text: '📦 Upgrade Plan', callback_data: 'upgrade' },
      ],
    });
  }

  /**
   * Notify payment received
   * @param userId - User ID
   * @param amount - Payment amount
   * @param currency - Currency
   */
  async notifyPaymentReceived(userId: string, amount: number, currency: string): Promise<void> {
    const user = await this.getUserTelegramId(userId);
    if (!user) return;

    const message = `💰 <b>Payment Received</b>

Thank you! Your payment of ${amount} ${currency} has been received.
- Transaction ID: ${Date.now()}

Your subscription is now active!`;

    await this.sendTelegramNotification({
      chatId: user.telegramId!,
      message,
    });
  }

  /**
   * Notify payment failed
   * @param userId - User ID
   * @param amount - Payment amount
   * @param reason - Failure reason
   */
  async notifyPaymentFailed(userId: string, amount: number, reason: string): Promise<void> {
    const user = await this.getUserTelegramId(userId);
    if (!user) return;

    const message = `❌ <b>Payment Failed</b>

Your payment of ${amount} could not be processed.
- Reason: ${reason}

Please try again or use a different payment method.`;

    await this.sendTelegramNotification({
      chatId: user.telegramId!,
      message,
    });
  }

  /**
   * Notify promocode activated
   * @param userId - User ID
   * @param reward - Reward description
   */
  async notifyPromocodeActivated(userId: string, reward: string): Promise<void> {
    const user = await this.getUserTelegramId(userId);
    if (!user) return;

    const message = `🎉 <b>Promocode Activated!</b>

Your promocode has been successfully applied!
- Reward: ${reward}

Enjoy your bonus!`;

    await this.sendTelegramNotification({
      chatId: user.telegramId!,
      message,
    });
  }

  /**
   * Notify promocode reward
   * @param userId - User ID
   * @param promocode - Promocode used
   * @param reward - Reward given
   */
  async notifyPromocodeReward(userId: string, promocode: string, reward: string): Promise<void> {
    await this.notifyPromocodeActivated(userId, `${promocode}: ${reward}`);
  }

  /**
   * Notify bulk renewal completed
   * @param userId - User ID
   * @param result - Bulk renewal result
   */
  async notifyBulkRenewalCompleted(userId: string, result: BulkRenewalResult): Promise<void> {
    const user = await this.getUserTelegramId(userId);
    if (!user) return;

    const message = `📦 <b>Bulk Renewal Complete</b>

${result.success ? '✅' : '❌'} Status: ${result.success ? 'Success' : 'Failed'}
- Total: ${result.totalAmount}
- Discount: ${result.totalDiscount}
- Final: ${result.finalAmount}
${result.error ? `- Error: ${result.error}` : ''}`;

    await this.sendTelegramNotification({
      chatId: user.telegramId!,
      message,
    });
  }

  /**
   * Queue a notification for background processing
   * @param type - Notification type
   * @param data - Notification data
   */
  async queueNotification(type: string, data: Record<string, unknown>): Promise<void> {
    // Would add to a queue (Redis, BullMQ, etc.)
    logger.info({ type, data }, 'Notification queued');
  }

  /**
   * Get user telegram ID
   * @param userId - User ID
   * @returns User with telegram ID
   */
  private async getUserTelegramId(_userId: string): Promise<{ telegramId?: string } | null> {
    // Would fetch user from repository
    return { telegramId: undefined };
  }
}

/**
 * Factory function to create NotificationService instance
 */
export function createNotificationService(): NotificationService {
  return new NotificationService();
}
