import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { Prisma, WebhookDeliveryStatus } from '@prisma/client';
import { firstValueFrom } from 'rxjs';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  AUTO_DISABLE_THRESHOLD,
  DELIVERY_TIMEOUT_MS,
  MAX_DELIVERY_ATTEMPTS,
  MAX_RESPONSE_BODY_PREVIEW,
  WEBHOOK_RETRY_DELAYS_SEC,
} from '../webhooks.constants';
import { eventMatches } from '../utils/event-matcher';
import { buildWebhookSignature } from '../utils/signature';
import { WebhookQueueService } from './webhook-queue.service';

export interface WebhookDispatchEventInput {
  readonly type: string;
  readonly category: string;
  readonly severity: string;
  readonly message: string;
  readonly metadata?: Record<string, unknown>;
  readonly timestamp: string;
}

/**
 * Webhook dispatcher — translates SystemEvents into per-subscription
 * delivery rows and HTTP POSTs.
 *
 * Lifecycle for a single (event, subscription) pair:
 *   1. `dispatch(event)` — fan-out: for every active matching subscription
 *      we INSERT a `WebhookDelivery` row in `PENDING` and enqueue a BullMQ
 *      job that calls `processDelivery(id)`.
 *   2. `processDelivery(id)` — performs the HTTP POST with HMAC signature,
 *      records the result, and either:
 *        - flips the row to `SUCCEEDED` and resets the consecutive
 *          failure counter on the subscription, or
 *        - flips to `RETRYING` and re-enqueues with backoff (when
 *          attempts remain), or
 *        - flips to `FAILED` and increments the consecutive counter
 *          (auto-disabling the subscription if it crosses
 *          AUTO_DISABLE_THRESHOLD).
 *
 * Non-2xx responses count as failures. Network errors (timeout, DNS,
 * TLS) also count as failures and are retried just like 5xx responses.
 *
 * Auto-disable
 *   When `consecutive_failures` >= AUTO_DISABLE_THRESHOLD the subscription
 *   is flipped to `isActive=false` and `auto_disabled_at=now()`. The
 *   admin must explicitly re-enable from the UI; the existing
 *   subscription PATCH endpoint clears the flag automatically.
 */
@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly httpService: HttpService,
    private readonly queueService: WebhookQueueService,
  ) {}

  /**
   * Fan out a SystemEvent to every active matching subscription. Called
   * from `SystemEventsService.emit()` via the event bridge installed in
   * `WebhookEventBridgeService.onModuleInit()`.
   *
   * Fire-and-forget: never throws.
   */
  public async dispatch(event: WebhookDispatchEventInput): Promise<void> {
    let subscriptions: { id: string; eventTypes: string[] }[];
    try {
      subscriptions = await this.prismaService.webhookSubscription.findMany({
        where: { isActive: true },
        select: { id: true, eventTypes: true },
      });
    } catch (err) {
      this.logger.error(`Failed to fan out event ${event.type}: ${(err as Error).message}`);
      return;
    }
    const matched = subscriptions.filter((sub) => eventMatches(event.type, sub.eventTypes));
    if (matched.length === 0) return;

    const payload = serializeEvent(event);

    await Promise.all(
      matched.map(async (sub) => {
        try {
          const delivery = await this.prismaService.webhookDelivery.create({
            data: {
              subscriptionId: sub.id,
              eventType: event.type,
              payload: payload as Prisma.InputJsonValue,
              status: WebhookDeliveryStatus.PENDING,
            },
          });
          await this.queueService.enqueueImmediate(delivery.id).catch((err) => {
            this.logger.warn(
              `Failed to enqueue webhook delivery ${delivery.id}: ${(err as Error).message}`,
            );
          });
        } catch (err) {
          this.logger.error(
            `Failed to create delivery row for sub=${sub.id}: ${(err as Error).message}`,
          );
        }
      }),
    );
  }

  /**
   * Manually re-queue a delivery — used by the "Replay" button in the UI.
   * Creates a FRESH delivery row pointing at the same subscription/payload
   * so the original history is preserved.
   */
  public async replay(deliveryId: string): Promise<{ readonly newDeliveryId: string }> {
    const original = await this.prismaService.webhookDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
      select: {
        subscriptionId: true,
        eventType: true,
        payload: true,
      },
    });
    const fresh = await this.prismaService.webhookDelivery.create({
      data: {
        subscriptionId: original.subscriptionId,
        eventType: original.eventType,
        payload: original.payload as Prisma.InputJsonValue,
        status: WebhookDeliveryStatus.PENDING,
      },
    });
    await this.queueService.enqueueImmediate(fresh.id).catch((err) => {
      this.logger.warn(`Replay enqueue failed: ${(err as Error).message}`);
    });
    return { newDeliveryId: fresh.id };
  }

  /**
   * Test-fire: sends a synthetic `webhook.test` payload to a subscription
   * without going through the queue. Returns the delivery id so the UI
   * can navigate to the new row.
   */
  public async test(subscriptionId: string): Promise<{ readonly deliveryId: string }> {
    const subscription = await this.prismaService.webhookSubscription.findUniqueOrThrow({
      where: { id: subscriptionId },
      select: { id: true },
    });
    const payload = serializeEvent({
      type: 'webhook.test',
      category: 'SYSTEM',
      severity: 'INFO',
      message: 'Test delivery from rezeis-admin',
      metadata: { test: true },
      timestamp: new Date().toISOString(),
    });
    const delivery = await this.prismaService.webhookDelivery.create({
      data: {
        subscriptionId: subscription.id,
        eventType: 'webhook.test',
        payload: payload as Prisma.InputJsonValue,
        status: WebhookDeliveryStatus.PENDING,
      },
    });
    await this.queueService.enqueueImmediate(delivery.id).catch((err) => {
      this.logger.warn(`Test enqueue failed: ${(err as Error).message}`);
    });
    return { deliveryId: delivery.id };
  }

  // ── Worker-facing API ───────────────────────────────────────────────────

  /**
   * Performs a single delivery attempt. Called by the BullMQ processor.
   * Idempotent — safe to call again on retry.
   */
  public async processDelivery(deliveryId: string): Promise<void> {
    const delivery = await this.prismaService.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: {
        subscription: {
          select: {
            id: true,
            url: true,
            secret: true,
            isActive: true,
            consecutiveFailures: true,
          },
        },
      },
    });
    if (!delivery) {
      this.logger.warn(`Delivery ${deliveryId} not found, dropping`);
      return;
    }
    // If the subscription was disabled between enqueue and now, drop
    // gracefully and mark the delivery as failed.
    if (!delivery.subscription.isActive) {
      await this.prismaService.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: WebhookDeliveryStatus.FAILED,
          errorMessage: 'Subscription is disabled',
          finishedAt: new Date(),
        },
      });
      return;
    }
    if (delivery.status === WebhookDeliveryStatus.SUCCEEDED) {
      return;
    }

    const attemptNumber = delivery.attempt + 1;
    const startedAt = new Date();
    const body = JSON.stringify(delivery.payload);
    const { header: signatureHeader, timestamp } = buildWebhookSignature({
      secret: delivery.subscription.secret,
      body,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'rezeis-admin-webhook/1.0',
      'X-Rezeis-Event': delivery.eventType,
      'X-Rezeis-Delivery-Id': delivery.id,
      'X-Rezeis-Attempt': attemptNumber.toString(),
      'X-Rezeis-Signature': signatureHeader,
      'X-Rezeis-Timestamp': timestamp.toString(),
    };

    let httpStatus: number | null = null;
    let responseBody: string | null = null;
    let errorMessage: string | null = null;
    let success = false;

    try {
      const response = await firstValueFrom(
        this.httpService.post(delivery.subscription.url, body, {
          headers,
          timeout: DELIVERY_TIMEOUT_MS,
          // Pass the body as a string so axios doesn't try to re-serialize
          // and break the signature.
          transformRequest: [(payload: unknown): string => payload as string],
          // Don't throw on non-2xx — we want to record the status and
          // decide whether to retry.
          validateStatus: () => true,
          maxRedirects: 0,
          maxContentLength: 1_000_000,
          maxBodyLength: 1_000_000,
        }),
      );
      httpStatus = response.status;
      responseBody = truncate(stringifyResponseBody(response.data), MAX_RESPONSE_BODY_PREVIEW);
      success = response.status >= 200 && response.status < 300;
    } catch (err) {
      errorMessage = truncate((err as Error).message ?? 'Unknown error', 1024);
    }

    const durationMs = Date.now() - startedAt.getTime();

    if (success) {
      await this.markSucceeded(delivery.id, delivery.subscription.id, {
        attempt: attemptNumber,
        httpStatus,
        responseBody,
        durationMs,
        startedAt,
      });
      return;
    }

    // Failure path — decide retry vs final.
    const remaining = MAX_DELIVERY_ATTEMPTS - attemptNumber;
    if (remaining > 0) {
      const delaySec = WEBHOOK_RETRY_DELAYS_SEC[attemptNumber] ?? WEBHOOK_RETRY_DELAYS_SEC[WEBHOOK_RETRY_DELAYS_SEC.length - 1]!;
      const nextRetryAt = new Date(Date.now() + delaySec * 1_000);
      await this.prismaService.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: WebhookDeliveryStatus.RETRYING,
          attempt: attemptNumber,
          httpStatus,
          responseBody,
          errorMessage,
          durationMs,
          startedAt,
          nextRetryAt,
        },
      });
      try {
        await this.queueService.enqueueDelayed(delivery.id, delaySec);
      } catch (err) {
        this.logger.error(`Failed to schedule retry for ${delivery.id}: ${(err as Error).message}`);
      }
      return;
    }

    await this.markFailed(delivery.id, delivery.subscription.id, {
      attempt: attemptNumber,
      httpStatus,
      responseBody,
      errorMessage,
      durationMs,
      startedAt,
      previousConsecutiveFailures: delivery.subscription.consecutiveFailures,
    });
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private async markSucceeded(
    deliveryId: string,
    subscriptionId: string,
    info: {
      attempt: number;
      httpStatus: number | null;
      responseBody: string | null;
      durationMs: number;
      startedAt: Date;
    },
  ): Promise<void> {
    const finishedAt = new Date();
    await this.prismaService.$transaction([
      this.prismaService.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: WebhookDeliveryStatus.SUCCEEDED,
          attempt: info.attempt,
          httpStatus: info.httpStatus,
          responseBody: info.responseBody,
          errorMessage: null,
          durationMs: info.durationMs,
          startedAt: info.startedAt,
          finishedAt,
          nextRetryAt: null,
        },
      }),
      this.prismaService.webhookSubscription.update({
        where: { id: subscriptionId },
        data: {
          lastDeliveredAt: finishedAt,
          consecutiveFailures: 0,
          totalDeliveries: { increment: 1 },
        },
      }),
    ]);
  }

  private async markFailed(
    deliveryId: string,
    subscriptionId: string,
    info: {
      attempt: number;
      httpStatus: number | null;
      responseBody: string | null;
      errorMessage: string | null;
      durationMs: number;
      startedAt: Date;
      previousConsecutiveFailures: number;
    },
  ): Promise<void> {
    const finishedAt = new Date();
    const newConsecutive = info.previousConsecutiveFailures + 1;
    const shouldAutoDisable = newConsecutive >= AUTO_DISABLE_THRESHOLD;

    await this.prismaService.$transaction([
      this.prismaService.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: WebhookDeliveryStatus.FAILED,
          attempt: info.attempt,
          httpStatus: info.httpStatus,
          responseBody: info.responseBody,
          errorMessage: info.errorMessage,
          durationMs: info.durationMs,
          startedAt: info.startedAt,
          finishedAt,
          nextRetryAt: null,
        },
      }),
      this.prismaService.webhookSubscription.update({
        where: { id: subscriptionId },
        data: {
          consecutiveFailures: newConsecutive,
          totalDeliveries: { increment: 1 },
          totalFailures: { increment: 1 },
          ...(shouldAutoDisable && {
            isActive: false,
            autoDisabledAt: finishedAt,
          }),
        },
      }),
    ]);

    if (shouldAutoDisable) {
      this.logger.warn(
        `Webhook subscription ${subscriptionId} auto-disabled after ${newConsecutive} consecutive failures`,
      );
    }
  }
}

function serializeEvent(event: WebhookDispatchEventInput): Record<string, unknown> {
  return {
    event: event.type,
    category: event.category,
    severity: event.severity,
    message: event.message,
    metadata: event.metadata ?? {},
    timestamp: event.timestamp,
  };
}

function stringifyResponseBody(data: unknown): string {
  if (data === null || data === undefined) return '';
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}
