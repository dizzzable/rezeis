import { Injectable } from '@nestjs/common';
import {
  PaymentWebhookEvent,
  PaymentWebhookLifecycleStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { PaymentWebhookEnvelopeInterface } from '../interfaces/payment-webhook-envelope.interface';
import { normalizePaymentProviderError } from '../utils/payment-provider-error.util';

export const PAYMENT_WEBHOOK_STATUS_RECEIVED = PaymentWebhookLifecycleStatus.RECEIVED;
export const PAYMENT_WEBHOOK_STATUS_ENQUEUED = PaymentWebhookLifecycleStatus.ENQUEUED;
export const PAYMENT_WEBHOOK_STATUS_PROCESSING = PaymentWebhookLifecycleStatus.PROCESSING;
export const PAYMENT_WEBHOOK_STATUS_PROCESSED = PaymentWebhookLifecycleStatus.PROCESSED;
export const PAYMENT_WEBHOOK_STATUS_FAILED = PaymentWebhookLifecycleStatus.FAILED;

@Injectable()
export class PaymentWebhookInboxService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async recordReceived(input: {
    readonly envelope: PaymentWebhookEnvelopeInterface;
  }): Promise<{ readonly event: PaymentWebhookEvent; readonly duplicate: boolean }> {
    const existingEvent = await this.prismaService.paymentWebhookEvent.findFirst({
      where: {
        gatewayType: input.envelope.gatewayType,
        providerEventId: input.envelope.providerEventId,
      } as never,
    });

    if (existingEvent !== null) {
      const updatedEvent = await this.prismaService.paymentWebhookEvent.update({
        where: { id: existingEvent.id },
        data: {
          attempts: { increment: 1 },
        } as never,
      });
      return { event: updatedEvent, duplicate: true };
    }

    try {
      const createdEvent = await this.prismaService.paymentWebhookEvent.create({
        data: {
          gatewayType: input.envelope.gatewayType,
          paymentId: input.envelope.paymentId,
          providerEventId: input.envelope.providerEventId,
          eventStatus: input.envelope.eventStatus,
          status: PAYMENT_WEBHOOK_STATUS_RECEIVED,
          payloadHash: input.envelope.payloadHash,
          rawPayload: input.envelope.rawPayload as Prisma.InputJsonValue,
          attempts: 1,
          lastError: null,
          receivedAt: new Date(input.envelope.receivedAt),
          lastTransitionAt: new Date(input.envelope.receivedAt),
          processedAt: null,
        } as never,
      });
      return { event: createdEvent, duplicate: false };
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const duplicateEvent = await this.prismaService.paymentWebhookEvent.findFirst({
          where: {
            gatewayType: input.envelope.gatewayType,
            providerEventId: input.envelope.providerEventId,
          } as never,
        });
        if (duplicateEvent !== null) {
          return { event: duplicateEvent, duplicate: true };
        }
      }
      throw error;
    }
  }

  public async markEnqueued(eventId: string): Promise<PaymentWebhookEvent> {
    return this.prismaService.paymentWebhookEvent.update({
      where: { id: eventId },
      data: {
        status: PAYMENT_WEBHOOK_STATUS_ENQUEUED,
        lastError: null,
        lastTransitionAt: new Date(),
      },
    });
  }

  public async markReplayRequested(eventId: string): Promise<PaymentWebhookEvent> {
    return this.prismaService.paymentWebhookEvent.update({
      where: { id: eventId },
      data: {
        status: PAYMENT_WEBHOOK_STATUS_ENQUEUED,
        lastError: null,
        replayCount: { increment: 1 },
        lastReplayedAt: new Date(),
        lastTransitionAt: new Date(),
      } as never,
    });
  }

  public async markProcessing(eventId: string): Promise<PaymentWebhookEvent> {
    return this.prismaService.paymentWebhookEvent.update({
      where: { id: eventId },
      data: {
        status: PAYMENT_WEBHOOK_STATUS_PROCESSING,
        lastError: null,
        lastTransitionAt: new Date(),
      },
    });
  }

  public async incrementReconciliationAttempts(eventId: string): Promise<PaymentWebhookEvent> {
    return this.prismaService.paymentWebhookEvent.update({
      where: { id: eventId },
      data: {
        reconciliationAttempts: { increment: 1 },
      } as never,
    });
  }

  public async markProcessed(eventId: string): Promise<PaymentWebhookEvent> {
    return this.prismaService.paymentWebhookEvent.update({
      where: { id: eventId },
      data: {
        status: PAYMENT_WEBHOOK_STATUS_PROCESSED,
        lastError: null,
        processedAt: new Date(),
        lastTransitionAt: new Date(),
      },
    });
  }

  public async markFailed(eventId: string, lastError: string): Promise<PaymentWebhookEvent> {
    const normalizedLastError = normalizePaymentProviderError(lastError, PAYMENT_WEBHOOK_STATUS_FAILED);
    return this.prismaService.paymentWebhookEvent.update({
      where: { id: eventId },
      data: {
        status: PAYMENT_WEBHOOK_STATUS_FAILED,
        lastError: normalizedLastError.slice(0, 2048),
        lastTransitionAt: new Date(),
      },
    });
  }
}
