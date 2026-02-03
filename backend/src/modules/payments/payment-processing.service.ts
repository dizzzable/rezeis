import type { Pool, PoolClient } from 'pg';
import { logger } from '../../utils/logger.js';
import { eventService } from '../../events/event.service.js';
import type {
  WebhookPayload,
  PaymentTransaction,
  CreatePaymentTransactionDTO,
  UpdatePaymentTransactionDTO,
  ReferralPointsInput,
  PartnerCommissionInput,
} from './types.js';

/**
 * Payment processing error
 */
export class PaymentProcessingError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly paymentId?: string
  ) {
    super(message);
    this.name = 'PaymentProcessingError';
  }
}

/**
 * Payment processing service
 * Handles payment processing, balance updates, subscriptions, referrals, and partner commissions
 */
export class PaymentProcessingService {
  private readonly db: Pool;

  constructor(db: Pool) {
    this.db = db;
  }

  /**
   * Execute queries within a transaction
   * @param callback - Function to execute within transaction
   * @returns Result of the callback
   */
  private async withTransaction<R>(callback: (client: PoolClient) => Promise<R>): Promise<R> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get transaction by ID
   * @param transactionId - Transaction ID
   * @returns Transaction or null
   */
  async getTransactionById(transactionId: string): Promise<PaymentTransaction | null> {
    try {
      const result = await this.db.query<PaymentTransaction>(
        `SELECT * FROM payment_transactions WHERE id = $1`,
        [transactionId]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error({ error, transactionId }, 'Failed to get transaction');
      throw new PaymentProcessingError('Failed to get transaction', error, transactionId);
    }
  }

  /**
   * Get transaction by external ID
   * @param externalId - External payment ID
   * @param gatewayId - Gateway ID
   * @returns Transaction or null
   */
  async getTransactionByExternalId(externalId: string, gatewayId: string): Promise<PaymentTransaction | null> {
    try {
      const result = await this.db.query<PaymentTransaction>(
        `SELECT * FROM payment_transactions WHERE external_id = $1 AND gateway_id = $2`,
        [externalId, gatewayId]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error({ error, externalId, gatewayId }, 'Failed to get transaction by external ID');
      throw new PaymentProcessingError('Failed to get transaction', error);
    }
  }

  /**
   * Create new payment transaction
   * @param data - Transaction data
   * @returns Created transaction
   */
  async createTransaction(data: CreatePaymentTransactionDTO): Promise<PaymentTransaction> {
    try {
      const result = await this.db.query<PaymentTransaction>(
        `INSERT INTO payment_transactions
         (user_id, gateway_id, external_id, amount, currency, status, type, metadata, error_message, paid_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
         RETURNING *`,
        [
          data.userId,
          data.gatewayId,
          data.externalId || null,
          data.amount,
          data.currency,
          data.status,
          data.type,
          JSON.stringify(data.metadata || {}),
          data.errorMessage || null,
          data.paidAt || null,
        ]
      );
      return result.rows[0];
    } catch (error) {
      logger.error({ error, data }, 'Failed to create transaction');
      throw new PaymentProcessingError('Failed to create transaction', error);
    }
  }

  /**
   * Update payment transaction
   * @param transactionId - Transaction ID
   * @param data - Update data
   * @returns Updated transaction
   */
  async updateTransaction(
    transactionId: string,
    data: UpdatePaymentTransactionDTO
  ): Promise<PaymentTransaction> {
    try {
      const updates: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (data.externalId !== undefined) {
        updates.push(`external_id = $${paramIndex++}`);
        values.push(data.externalId);
      }
      if (data.status !== undefined) {
        updates.push(`status = $${paramIndex++}`);
        values.push(data.status);
      }
      if (data.metadata !== undefined) {
        updates.push(`metadata = $${paramIndex++}`);
        values.push(JSON.stringify(data.metadata));
      }
      if (data.errorMessage !== undefined) {
        updates.push(`error_message = $${paramIndex++}`);
        values.push(data.errorMessage);
      }
      if (data.paidAt !== undefined) {
        updates.push(`paid_at = $${paramIndex++}`);
        values.push(data.paidAt);
      }

      if (updates.length === 0) {
        throw new PaymentProcessingError('No fields to update');
      }

      updates.push(`updated_at = NOW()`);
      values.push(transactionId);

      const result = await this.db.query<PaymentTransaction>(
        `UPDATE payment_transactions
         SET ${updates.join(', ')}
         WHERE id = $${paramIndex}
         RETURNING *`,
        values
      );

      if (result.rows.length === 0) {
        throw new PaymentProcessingError('Transaction not found', undefined, transactionId);
      }

      return result.rows[0];
    } catch (error) {
      logger.error({ error, transactionId, data }, 'Failed to update transaction');
      throw new PaymentProcessingError('Failed to update transaction', error, transactionId);
    }
  }

  /**
   * Process successful payment
   * @param payload - Webhook payload
   */
  async processSuccessfulPayment(payload: WebhookPayload): Promise<void> {
    await this.withTransaction(async (client) => {
      logger.info({
        paymentId: payload.paymentId,
        externalId: payload.externalId,
        amount: payload.amount,
        currency: payload.currency,
      }, 'Processing successful payment');

      // 1. Find transaction by external ID or payment ID
      let transaction = await this.getTransactionByExternalId(payload.externalId, payload.metadata.gatewayId as string);

      if (!transaction) {
        transaction = await this.getTransactionById(payload.paymentId);
      }

      if (!transaction) {
        logger.warn({ paymentId: payload.paymentId }, 'Transaction not found');
        throw new PaymentProcessingError('Transaction not found', undefined, payload.paymentId);
      }

      // 2. Update transaction status
      await client.query(
        `UPDATE payment_transactions
         SET status = 'completed', external_id = $1, paid_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [payload.externalId, transaction.id]
      );

      // 3. Get user data
      const userResult = await client.query(
        `SELECT id, referred_by, partner_id FROM users WHERE id = $1`,
        [transaction.userId]
      );
      const user = userResult.rows[0];

      if (!user) {
        logger.warn({ userId: transaction.userId }, 'User not found');
        throw new PaymentProcessingError('User not found');
      }

      // 4. Process based on payment type
      const paymentType = payload.metadata.type as string;

      if (paymentType === 'subscription') {
        await this.activateSubscription(client, user.id, payload.metadata);
      } else if (paymentType === 'balance') {
        await this.addBalance(client, user.id, payload.amount);
      }

      // 5. Add referral points if user has a referrer
      if (user.referred_by) {
        await this.addReferralPoints(client, {
          referrerId: user.referred_by,
          referredId: user.id,
          amount: payload.amount,
          source: `payment_${paymentType}`,
        });
      }

      // 6. Add partner commission if user has a partner
      if (user.partner_id) {
        await this.addPartnerCommission(client, {
          partnerId: user.partner_id,
          userId: user.id,
          amount: payload.amount,
          orderId: transaction.id,
        });
      }

      // 7. Send notification
      await this.sendPaymentNotification(user.id, payload);

      logger.info({ paymentId: payload.paymentId }, 'Payment processed successfully');
    });
  }

  /**
   * Process failed payment
   * @param payload - Webhook payload
   */
  async processFailedPayment(payload: WebhookPayload): Promise<void> {
    try {
      logger.info({
        paymentId: payload.paymentId,
        error: payload.errorMessage,
      }, 'Processing failed payment');

      let transaction = await this.getTransactionByExternalId(payload.externalId, payload.metadata.gatewayId as string);

      if (!transaction) {
        transaction = await this.getTransactionById(payload.paymentId);
      }

      if (!transaction) {
        logger.warn({ paymentId: payload.paymentId }, 'Transaction not found for failed payment');
        return;
      }

      // Update transaction status
      await this.updateTransaction(transaction.id, {
        status: 'failed',
        errorMessage: payload.errorMessage,
      });

      // Send failure notification
      await eventService.emitPaymentFailed(transaction.userId, transaction.id, payload.errorMessage || 'Payment failed');

      logger.info({ paymentId: payload.paymentId }, 'Failed payment processed');
    } catch (error) {
      logger.error({ error, paymentId: payload.paymentId }, 'Failed to process failed payment');
      throw new PaymentProcessingError('Failed to process failed payment', error, payload.paymentId);
    }
  }

  /**
   * Activate subscription for user
   * @param client - Database client
   * @param userId - User ID
   * @param metadata - Payment metadata
   */
  private async activateSubscription(
    client: PoolClient,
    userId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const planId = metadata.planId as string;
    const durationDays = metadata.durationDays as number;

    if (!planId || !durationDays) {
      logger.warn({ userId, metadata }, 'Missing plan data for subscription activation');
      return;
    }

    try {
      // Check if user has existing active subscription
      const existingSub = await client.query(
        `SELECT id, expire_at FROM subscriptions WHERE user_id = $1 AND status = 'active'`,
        [userId]
      );

      if (existingSub.rows.length > 0) {
        // Extend existing subscription
        const sub = existingSub.rows[0];
        await client.query(
          `UPDATE subscriptions
           SET expire_at = expire_at + INTERVAL '${durationDays} days',
               updated_at = NOW()
           WHERE id = $1`,
          [sub.id]
        );
      } else {
        // Create new subscription
        await client.query(
          `INSERT INTO subscriptions (user_id, plan_id, status, expire_at, created_at, updated_at)
           VALUES ($1, $2, 'active', NOW() + INTERVAL '${durationDays} days', NOW(), NOW())`,
          [userId, planId]
        );
      }

      logger.info({ userId, planId, durationDays }, 'Subscription activated/extended');
    } catch (error) {
      logger.error({ error, userId, metadata }, 'Failed to activate subscription');
      throw error;
    }
  }

  /**
   * Add balance to user account
   * @param client - Database client
   * @param userId - User ID
   * @param amount - Amount to add
   */
  private async addBalance(client: PoolClient, userId: string, amount: number): Promise<void> {
    try {
      await client.query(
        `UPDATE users SET balance = COALESCE(balance, 0) + $1, updated_at = NOW() WHERE id = $2`,
        [amount, userId]
      );
      logger.info({ userId, amount }, 'Balance added');
    } catch (error) {
      logger.error({ error, userId, amount }, 'Failed to add balance');
      throw error;
    }
  }

  /**
   * Add referral points
   * @param client - Database client
   * @param input - Referral points input
   */
  private async addReferralPoints(client: PoolClient, input: ReferralPointsInput): Promise<void> {
    try {
      // Calculate points (e.g., 10% of payment amount)
      const points = Math.floor(input.amount * 0.1);

      await client.query(
        `INSERT INTO referrals (referrer_id, referred_id, points_earned, status, created_at)
         VALUES ($1, $2, $3, 'completed', NOW())
         ON CONFLICT (referrer_id, referred_id) DO UPDATE
         SET points_earned = referrals.points_earned + $3`,
        [input.referrerId, input.referredId, points]
      );

      logger.info({
        referrerId: input.referrerId,
        referredId: input.referredId,
        points,
      }, 'Referral points added');
    } catch (error) {
      logger.error({ error, input }, 'Failed to add referral points');
      // Don't throw - referral points are not critical
    }
  }

  /**
   * Add partner commission
   * @param client - Database client
   * @param input - Partner commission input
   */
  private async addPartnerCommission(client: PoolClient, input: PartnerCommissionInput): Promise<void> {
    try {
      // Get partner commission rate
      const partnerResult = await client.query(
        `SELECT commission_rate FROM partners WHERE id = $1`,
        [input.partnerId]
      );

      if (partnerResult.rows.length === 0) {
        logger.warn({ partnerId: input.partnerId }, 'Partner not found');
        return;
      }

      const commissionRate = parseFloat(partnerResult.rows[0].commission_rate) || 0.1;
      const commission = input.amount * commissionRate;

      // Add commission to partner earnings
      await client.query(
        `INSERT INTO partner_earnings (partner_id, referred_user_id, amount, commission_rate, status, created_at)
         VALUES ($1, $2, $3, $4, 'pending', NOW())`,
        [input.partnerId, input.userId, commission, commissionRate]
      );

      // Update partner balance
      await client.query(
        `UPDATE partners
         SET balance = COALESCE(balance, 0) + $1,
             total_earnings = COALESCE(total_earnings, 0) + $1,
             updated_at = NOW()
         WHERE id = $2`,
        [commission, input.partnerId]
      );

      // Emit partner commission event
      const userResult = await client.query(
        `SELECT id FROM users WHERE id = (SELECT user_id FROM partners WHERE id = $1)`,
        [input.partnerId]
      );

      if (userResult.rows.length > 0) {
        await eventService.emitPartnerCommission(
          userResult.rows[0].id,
          commission,
          input.orderId,
          'USD'
        );
      }

      logger.info({
        partnerId: input.partnerId,
        userId: input.userId,
        commission,
        orderId: input.orderId,
      }, 'Partner commission added');
    } catch (error) {
      logger.error({ error, input }, 'Failed to add partner commission');
      // Don't throw - partner commission is not critical
    }
  }

  /**
   * Send payment notification to user
   * @param userId - User ID
   * @param payload - Webhook payload
   */
  private async sendPaymentNotification(userId: string, payload: WebhookPayload): Promise<void> {
    try {
      await eventService.emitPaymentReceived(userId, {
        paymentId: payload.paymentId,
        amount: payload.amount,
        currency: payload.currency,
        status: payload.status,
      });
    } catch (error) {
      logger.error({ error, userId, paymentId: payload.paymentId }, 'Failed to send payment notification');
    }
  }
}
