import { Injectable, Logger } from '@nestjs/common';
import { BroadcastMessageStatus, BroadcastStatus, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../../common/prisma/prisma.service';

const BATCH_SIZE = 50;
const TELEGRAM_SEND_DELAY_MS = 50;

/**
 * Broadcast delivery worker — sends staged messages to Telegram users.
 *
 * Donor parity: altshop `src/services/broadcast.py` + Taskiq task.
 *
 * The delivery loop:
 *  1. Picks a PROCESSING broadcast
 *  2. Fetches PENDING messages in batches
 *  3. Sends each via Telegram Bot API
 *  4. Marks messages as SENT or FAILED
 *  5. Updates broadcast counters
 *  6. Marks broadcast as COMPLETED when all messages are processed
 */
@Injectable()
export class BroadcastDeliveryService {
  private readonly logger = new Logger(BroadcastDeliveryService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Starts delivery for a broadcast. Transitions it from DRAFT → PROCESSING,
   * stages recipient messages, then delivers them.
   */
  public async startDelivery(broadcastId: string): Promise<void> {
    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: broadcastId },
      select: { id: true, status: true, payload: true, audience: true },
    });
    if (broadcast === null) {
      this.logger.warn(`Broadcast ${broadcastId} not found`);
      return;
    }
    if (broadcast.status !== BroadcastStatus.DRAFT) {
      this.logger.warn(`Broadcast ${broadcastId} is not in DRAFT status`);
      return;
    }

    // Stage recipients
    const recipientUserIds = await this.resolveRecipients(broadcast.audience);
    if (recipientUserIds.length === 0) {
      await this.prismaService.broadcast.update({
        where: { id: broadcastId },
        data: { status: BroadcastStatus.COMPLETED, totalCount: 0, startedAt: new Date(), completedAt: new Date() },
      });
      return;
    }

    // Create message rows
    await this.prismaService.broadcastMessage.createMany({
      data: recipientUserIds.map((userId) => ({
        broadcastId,
        userId,
        status: BroadcastMessageStatus.PENDING,
      })),
    });

    await this.prismaService.broadcast.update({
      where: { id: broadcastId },
      data: {
        status: BroadcastStatus.PROCESSING,
        totalCount: recipientUserIds.length,
        startedAt: new Date(),
      },
    });

    // Deliver in batches
    await this.deliverMessages(broadcastId);
  }

  /**
   * Processes pending messages for a broadcast. Can be called repeatedly
   * (e.g., after a restart) to resume delivery.
   */
  public async deliverMessages(broadcastId: string): Promise<void> {
    const botToken = this.configService.get<string>('BOT_TOKEN');
    if (!botToken) {
      this.logger.error('BOT_TOKEN not configured — cannot deliver broadcast');
      await this.prismaService.broadcast.update({
        where: { id: broadcastId },
        data: { status: BroadcastStatus.FAILED },
      });
      return;
    }

    const broadcast = await this.prismaService.broadcast.findUnique({
      where: { id: broadcastId },
      select: { id: true, payload: true },
    });
    if (broadcast === null) {
      return;
    }

    const payload = broadcast.payload as Record<string, unknown> | null;
    const text = typeof payload?.text === 'string' ? payload.text : '';
    if (text.length === 0) {
      this.logger.warn(`Broadcast ${broadcastId} has empty text — marking FAILED`);
      await this.prismaService.broadcast.update({
        where: { id: broadcastId },
        data: { status: BroadcastStatus.FAILED },
      });
      return;
    }

    let successCount = 0;
    let failedCount = 0;
    let hasMore = true;

    while (hasMore) {
      const batch = await this.prismaService.broadcastMessage.findMany({
        where: { broadcastId, status: BroadcastMessageStatus.PENDING },
        include: { broadcast: false },
        take: BATCH_SIZE,
        orderBy: { createdAt: 'asc' },
      });

      if (batch.length === 0) {
        hasMore = false;
        break;
      }

      for (const message of batch) {
        // Resolve user's telegramId
        const user = await this.prismaService.user.findUnique({
          where: { id: message.userId },
          select: { telegramId: true },
        });

        if (!user?.telegramId) {
          await this.prismaService.broadcastMessage.update({
            where: { id: message.id },
            data: { status: BroadcastMessageStatus.FAILED, errorMessage: 'No telegramId' },
          });
          failedCount++;
          continue;
        }

        try {
          const response = await fetch(
            `https://api.telegram.org/bot${botToken}/sendMessage`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: user.telegramId.toString(),
                text,
                parse_mode: (payload?.parseMode as string) ?? undefined,
              }),
            },
          );

          if (response.ok) {
            const data = (await response.json()) as { result?: { message_id?: number } };
            await this.prismaService.broadcastMessage.update({
              where: { id: message.id },
              data: {
                status: BroadcastMessageStatus.SENT,
                telegramMessageId: data.result?.message_id
                  ? BigInt(data.result.message_id)
                  : null,
                sentAt: new Date(),
              },
            });
            successCount++;
          } else {
            const errorBody = await response.text();
            await this.prismaService.broadcastMessage.update({
              where: { id: message.id },
              data: {
                status: BroadcastMessageStatus.FAILED,
                errorMessage: errorBody.slice(0, 500),
              },
            });
            failedCount++;
          }
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : 'Unknown error';
          await this.prismaService.broadcastMessage.update({
            where: { id: message.id },
            data: {
              status: BroadcastMessageStatus.FAILED,
              errorMessage: errorMessage.slice(0, 500),
            },
          });
          failedCount++;
        }

        // Rate limit: Telegram allows ~30 messages/second
        await sleep(TELEGRAM_SEND_DELAY_MS);
      }
    }

    // Finalize broadcast
    await this.prismaService.broadcast.update({
      where: { id: broadcastId },
      data: {
        status: BroadcastStatus.COMPLETED,
        successCount,
        failedCount,
        completedAt: new Date(),
      },
    });

    this.logger.log(
      `Broadcast ${broadcastId} completed: ${successCount} sent, ${failedCount} failed`,
    );
  }

  private async resolveRecipients(audience: string): Promise<string[]> {
    // Simplified audience resolution — returns user ids with telegramId set
    const where: Record<string, unknown> = {
      isBlocked: false,
      isBotBlocked: false,
      telegramId: { not: null },
    };

    switch (audience) {
      case 'ACTIVE_SUBSCRIBERS':
        where.subscriptions = { some: { status: 'ACTIVE' } };
        break;
      case 'EXPIRED':
        where.subscriptions = { some: { status: 'EXPIRED' } };
        where.NOT = { subscriptions: { some: { status: 'ACTIVE' } } };
        break;
      case 'TRIAL':
        where.subscriptions = { some: { isTrial: true, status: 'ACTIVE' } };
        break;
      case 'UNSUBSCRIBED':
        where.subscriptions = { none: {} };
        break;
      // ALL — no extra filter
    }

    const users = await this.prismaService.user.findMany({
      where: where as Prisma.UserWhereInput,
      select: { id: true },
    });
    return users.map((u) => u.id);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
