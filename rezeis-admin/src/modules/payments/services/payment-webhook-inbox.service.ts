import { Injectable, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(PaymentWebhookInboxService.name);

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
      return this.resolveKeyCollision(existingEvent, input.envelope);
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
        // The `findFirst` above saw no row, so two deliveries for the same
        // `(gatewayType, providerEventId)` raced and the other one won the
        // `@@unique` insert. Losing that race says NOTHING about whether the
        // two payloads match — providers reuse one event/invoice id across
        // pending → paid, so the loser is very often the `paid` update that
        // arrived alongside the `pending` one. Reporting it as a duplicate
        // here dropped it before reconciliation was ever enqueued, and the
        // pending-expiry sweep then cancelled a payment the user had already
        // made. Re-read the winner and run the identical payload-hash
        // comparison the non-racing path uses.
        const winningEvent = await this.prismaService.paymentWebhookEvent.findFirst({
          where: {
            gatewayType: input.envelope.gatewayType,
            providerEventId: input.envelope.providerEventId,
          } as never,
        });
        if (winningEvent !== null) {
          return this.resolveKeyCollision(winningEvent, input.envelope);
        }
        // The winner is gone (a purge or manual DB surgery between the P2002
        // and this read). Rethrow rather than looping back to `create`: the
        // gateway redelivers on a non-200 and the retry lands on a clean
        // insert, whereas retrying in place is how this path would start
        // recursing.
      }
      throw error;
    }
  }

  /**
   * Single owner of "a row already holds this `(gatewayType, providerEventId)`" —
   * reached both when `recordReceived` finds that row up front and when it
   * loses the insert race and learns about it from a P2002.
   *
   * Contains no `create` and never re-enters `recordReceived` on purpose. The
   * obvious patch for the racing path — just call `recordReceived` again — has
   * no bound: a row that disappears between the P2002 and the re-read puts the
   * call straight back on the `create` path, and with SeverPay redelivering one
   * event up to 100 times there is nothing to break the cycle. Funnelling both
   * callers in here keeps the racing path a single linear pass instead.
   */
  private async resolveKeyCollision(
    existingEvent: PaymentWebhookEvent,
    envelope: PaymentWebhookEnvelopeInterface,
  ): Promise<{ readonly event: PaymentWebhookEvent; readonly duplicate: boolean }> {
    // Many gateways (HELEKET, CRYPTOMUS, PLATEGA, WATA, …) reuse the same
    // provider event/invoice id across every status update of one payment
    // (e.g. confirm_check → paid). Deduping purely on
    // `(gatewayType, providerEventId)` would drop the FINAL `paid`
    // notification as a duplicate of the earlier `pending` one — the
    // payment would then hang PENDING and auto-cancel, losing real money.
    //
    // A collision is only a TRUE duplicate when the payload is byte-for-byte
    // identical (same `payloadHash`). When the hash differs the provider has
    // sent a genuinely new state, so we refresh the stored row and report it
    // as NOT a duplicate — the ingress then re-enqueues reconciliation and
    // the new status is applied (reconciliation is idempotent, same as a
    // manual replay).
    const isSamePayload =
      existingEvent.payloadHash !== null &&
      existingEvent.payloadHash === envelope.payloadHash;

    if (isSamePayload) {
      const updatedEvent = await this.prismaService.paymentWebhookEvent.update({
        where: { id: existingEvent.id },
        data: {
          attempts: { increment: 1 },
        } as never,
      });
      // The ingress answers 200 to a duplicate deliberately (SeverPay retries
      // up to 100 times on anything else), so the access log for a dropped
      // redelivery is byte-identical to one we acted on and `attempts` on this
      // row is otherwise the only trace — visible solely by querying the admin
      // webhook events list. A true duplicate is a benign provider retry, so
      // `warn` rather than `error`; a spike in it is the one signal that a
      // gateway has started misbehaving. The payload stays out of the message:
      // it carries payment data.
      this.logger.warn(
        `Duplicate ${envelope.gatewayType} webhook dropped for payment ${envelope.paymentId} ` +
          `(providerEventId=${envelope.providerEventId}, attempts=${updatedEvent.attempts}) — ` +
          `identical payload, reconciliation not re-enqueued`,
      );
      return { event: updatedEvent, duplicate: true };
    }

    const refreshedEvent = await this.prismaService.paymentWebhookEvent.update({
      where: { id: existingEvent.id },
      data: {
        paymentId: envelope.paymentId,
        eventStatus: envelope.eventStatus,
        payloadHash: envelope.payloadHash,
        rawPayload: envelope.rawPayload as Prisma.InputJsonValue,
        status: PAYMENT_WEBHOOK_STATUS_RECEIVED,
        lastError: null,
        attempts: { increment: 1 },
        receivedAt: new Date(envelope.receivedAt),
        lastTransitionAt: new Date(envelope.receivedAt),
        processedAt: null,
      } as never,
    });
    return { event: refreshedEvent, duplicate: false };
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
