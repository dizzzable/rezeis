import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { PaymentGatewayType } from '@prisma/client';
import { Queue } from 'bullmq';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  PAYMENT_RECONCILIATION_JOB,
  PAYMENT_RECONCILIATION_QUEUE,
} from '../constants/payment-reconciliation.constant';
import {
  PaymentWebhookIngressResultInterface,
} from '../interfaces/payment-webhook-envelope.interface';
import {
  PAYMENT_WEBHOOK_STATUS_ENQUEUED,
  PaymentWebhookInboxService,
} from './payment-webhook-inbox.service';
import { PaymentWebhookNormalizerService } from './payment-webhook-normalizer.service';

interface IngestWebhookInput {
  readonly gatewayType: PaymentGatewayType;
  readonly rawBody: Buffer;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly clientIp: string | null;
  readonly verifySignature: boolean;
}

@Injectable()
export class PaymentWebhookIngressService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly paymentWebhookNormalizerService: PaymentWebhookNormalizerService,
    private readonly paymentWebhookInboxService: PaymentWebhookInboxService,
    @InjectQueue(PAYMENT_RECONCILIATION_QUEUE)
    private readonly paymentReconciliationQueue: Queue,
  ) {}

  public async ingestWebhook(
    input: IngestWebhookInput,
  ): Promise<PaymentWebhookIngressResultInterface> {
    const gateway = await this.prismaService.paymentGateway.findUnique({
      where: { type: input.gatewayType },
    });
    if (gateway === null) {
      throw new NotFoundException('Payment gateway not found');
    }

    const envelope = this.paymentWebhookNormalizerService.normalizeWebhook({
      gatewayType: input.gatewayType,
      rawBody: input.rawBody,
      headers: input.headers,
      clientIp: input.clientIp,
      gatewaySettings: gateway.settings,
      verifySignature: input.verifySignature,
    });

    const receivedEvent = await this.paymentWebhookInboxService.recordReceived({ envelope });
    if (!receivedEvent.duplicate) {
      await this.paymentWebhookInboxService.markEnqueued(receivedEvent.event.id);
      await this.paymentReconciliationQueue.add(
        PAYMENT_RECONCILIATION_JOB,
        {
          eventId: receivedEvent.event.id,
          paymentId: receivedEvent.event.paymentId,
          gatewayType: receivedEvent.event.gatewayType,
        },
        {
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
    }

    return {
      accepted: true,
      duplicate: receivedEvent.duplicate,
      lifecycleStatus:
        receivedEvent.duplicate
          ? receivedEvent.event.status ?? PAYMENT_WEBHOOK_STATUS_ENQUEUED
          : PAYMENT_WEBHOOK_STATUS_ENQUEUED,
      envelope,
    };
  }
}
