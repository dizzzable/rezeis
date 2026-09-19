import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { PaymentGatewayType, Prisma, Transaction, TransactionStatus } from '@prisma/client';
import { Job } from 'bullmq';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { MOY_NALOG_JOBS, MOY_NALOG_QUEUE } from '../constants/moy-nalog.constant';
import { MoyNalogApiService, MoyNalogAuth } from '../services/moy-nalog-api.service';
import { MoyNalogQueueService } from '../services/moy-nalog-queue.service';
import { renderIncomeName } from '../utils/moy-nalog-income-name.util';
import {
  encryptGatewaySettingsForStorage,
  readGatewaySettings,
} from '../utils/payment-gateway-settings.util';
import { readRefundedTotal } from '../utils/payment-refund-ledger.util';
import { writeTransactionGatewayData } from '../utils/transaction-gateway-data.util';

/**
 * Registers a COMPLETED YooKassa transaction as self-employed income in
 * «Мой Налог». Best-effort and idempotent: a transaction that already carries
 * a `moyNalogReceiptUuid` is skipped, a refunded one is never registered, and
 * any failure is retried by BullMQ without ever touching subscription
 * fulfillment.
 */
@Processor(MOY_NALOG_QUEUE, { concurrency: 2 })
export class MoyNalogProcessor extends WorkerHost {
  private readonly logger = new Logger(MoyNalogProcessor.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly moyNalogApiService: MoyNalogApiService,
    private readonly moyNalogQueueService: MoyNalogQueueService,
  ) {
    super();
  }

  public override async process(job: Job): Promise<void> {
    if (job.name === MOY_NALOG_JOBS.CANCEL_INCOME) {
      await this.processCancelIncome(job);
      return;
    }
    if (job.name !== MOY_NALOG_JOBS.REGISTER_INCOME) {
      return;
    }
    const transactionId = readTransactionId(job.data);

    const transaction = await this.prismaService.transaction.findUnique({
      where: { id: transactionId },
    });
    if (transaction === null) {
      this.logger.warn(`МойНалог job skipped: transaction ${transactionId} not found`);
      return;
    }
    if (transaction.gatewayType !== PaymentGatewayType.YOOKASSA) {
      return;
    }

    const gateway = await this.prismaService.paymentGateway.findUnique({
      where: { type: PaymentGatewayType.YOOKASSA },
    });
    if (gateway === null) {
      return;
    }
    const settings = readGatewaySettings(gateway.settings);
    if (settings.selfEmployedEnabled !== true) {
      return;
    }

    const gatewayData = readGatewayData(transaction.gatewayData);
    if (typeof gatewayData.moyNalogReceiptUuid === 'string' && gatewayData.moyNalogReceiptUuid.length > 0) {
      // Already registered — idempotent guard against retries / replays. A
      // retry of a run whose hand-off below failed hands the receipt over now.
      await this.handReceiptToCancellationIfRefunded(transaction);
      return;
    }
    // Money that went back is not income. This job retries for minutes when the
    // tax service is down, and a refund can land in between: its cancellation
    // then finds no receipt and does nothing, so registering here would declare
    // the refunded payment for good. A refunded payment also comes back through
    // here with no receipt when a success notification is replayed after the
    // refund, which revives the row to COMPLETED but keeps `refundReversedAt` —
    // registering again would be a second receipt for money already returned.
    if (
      transaction.status !== TransactionStatus.COMPLETED ||
      typeof gatewayData.refundReversedAt === 'string'
    ) {
      this.logger.warn(
        `МойНалог income not registered for transaction ${transactionId}: the payment was refunded ` +
          `(status ${transaction.status})`,
      );
      return;
    }

    const auth = buildAuth(settings, async (rotatedRefreshToken: string) => {
      await this.persistRotatedRefreshToken(gateway.id, gateway.settings, rotatedRefreshToken);
    });
    const amountNumber = Number(transaction.amount.toString());
    const name = renderIncomeName(readString(settings.incomeDescriptionTemplate), {
      description: resolveDescription(transaction),
      id: transaction.paymentId,
      amount: String(amountNumber),
    });

    const receiptUuid = await this.moyNalogApiService.registerIncome({
      auth,
      name,
      amount: amountNumber,
      date: transaction.updatedAt,
    });
    if (receiptUuid === null) {
      // Throw so BullMQ retries with exponential backoff. Fulfillment has
      // already completed independently — this only affects the receipt.
      throw new Error(`МойНалог income registration returned no receipt for transaction ${transactionId}`);
    }

    await this.recordOnTransaction(transaction.id, {
      moyNalogReceiptUuid: receiptUuid,
      moyNalogRegisteredAt: new Date().toISOString(),
    });
    this.logger.log(`Registered МойНалог income for transaction ${transactionId}`);

    // Read back AFTER the receipt is on the row. A refund that landed while the
    // tax service was answering enqueued its cancellation before there was a
    // receipt to cancel, and that job found nothing and finished. One of the
    // two always sees the other: the refund records its total under the row
    // lock before it enqueues the cancellation, so either that cancellation
    // reads this receipt, or this read sees the refund.
    const now = await this.prismaService.transaction.findUnique({ where: { id: transaction.id } });
    if (now !== null) {
      await this.handReceiptToCancellationIfRefunded(now);
    }
  }

  /**
   * Enqueues a cancellation for a receipt registered on a payment that was
   * refunded in full meanwhile, and not cancelled yet. Its own job id: the
   * refund's cancellation job has already finished — finding no receipt — and
   * BullMQ keeps finished jobs, so enqueueing that id again would do nothing.
   */
  private async handReceiptToCancellationIfRefunded(
    transaction: Pick<Transaction, 'id' | 'status' | 'amount' | 'gatewayData'>,
  ): Promise<void> {
    const gatewayData = readGatewayData(transaction.gatewayData);
    const receipt = gatewayData.moyNalogReceiptUuid;
    if (typeof receipt !== 'string' || receipt.length === 0) return;
    if (typeof gatewayData.moyNalogCancelledAt === 'string' && gatewayData.moyNalogCancelledAt.length > 0) return;
    const paid = Number(transaction.amount.toString());
    const refundedInFull =
      transaction.status !== TransactionStatus.COMPLETED ||
      typeof gatewayData.refundReversedAt === 'string' ||
      (Number.isFinite(paid) && paid > 0 && readRefundedTotal(gatewayData) >= paid - 0.000001);
    if (!refundedInFull) return;
    this.logger.warn(
      `МойНалог income for transaction ${transaction.id} was registered while the payment was refunded — ` +
        'handing the receipt to a cancellation',
    );
    await this.moyNalogQueueService.enqueueCancelIncomeAfterRegistration(transaction.id);
  }

  /**
   * Cancels a previously-registered «Мой Налог» income receipt for a refunded /
   * charged-back transaction. Idempotent: skips when there is no stored receipt
   * uuid (income was never registered) or it was already cancelled. Throws on a
   * failed cancellation so BullMQ retries — the tax receipt MUST be voided.
   */
  private async processCancelIncome(job: Job): Promise<void> {
    const transactionId = readTransactionId(job.data);
    const transaction = await this.prismaService.transaction.findUnique({
      where: { id: transactionId },
    });
    if (transaction === null || transaction.gatewayType !== PaymentGatewayType.YOOKASSA) {
      return;
    }

    const gatewayData = readGatewayData(transaction.gatewayData);
    const receiptUuid = gatewayData.moyNalogReceiptUuid;
    if (typeof receiptUuid !== 'string' || receiptUuid.length === 0) {
      // Income was never registered — nothing to cancel.
      return;
    }
    if (typeof gatewayData.moyNalogCancelledAt === 'string' && gatewayData.moyNalogCancelledAt.length > 0) {
      // Already cancelled — idempotent guard against retries / replays.
      return;
    }

    const gateway = await this.prismaService.paymentGateway.findUnique({
      where: { type: PaymentGatewayType.YOOKASSA },
    });
    if (gateway === null) {
      return;
    }
    const settings = readGatewaySettings(gateway.settings);
    const auth = buildAuth(settings, async (rotatedRefreshToken: string) => {
      await this.persistRotatedRefreshToken(gateway.id, gateway.settings, rotatedRefreshToken);
    });

    const cancelled = await this.moyNalogApiService.cancelIncome({ auth, receiptUuid });
    if (!cancelled) {
      throw new Error(`МойНалог income cancellation failed for transaction ${transactionId}`);
    }

    await this.recordOnTransaction(transaction.id, {
      moyNalogCancelledAt: new Date().toISOString(),
    });
    this.logger.log(`Cancelled МойНалог income for refunded transaction ${transactionId}`);
  }

  /**
   * Adds `patch` to the transaction's `gatewayData` through the one writer
   * (`writeTransactionGatewayData`), merged by PostgreSQL onto whatever the row
   * holds at that moment. The row was read before the tax service was called;
   * writing that copy back erased what the refund path wrote meanwhile — the
   * reversal's own record in 19 of 20 full refunds, and a partial refund's
   * ledger entry.
   *
   * Zero rows means the transaction is gone; there is nothing left to record
   * the receipt on, and throwing would only make BullMQ call the tax service
   * again.
   */
  private async recordOnTransaction(transactionId: string, patch: Record<string, unknown>): Promise<void> {
    const updated = await writeTransactionGatewayData(this.prismaService, transactionId, { merge: patch });
    if (updated === 0) {
      this.logger.warn(`МойНалог receipt for transaction ${transactionId} not recorded: the transaction is gone`);
    }
  }

  /**
   * Persists a rotated «Мой Налог» refresh token back into the YooKassa
   * gateway settings so the next job authenticates with the current token.
   * Best-effort: a failure here is logged and swallowed (the income is already
   * registered; only the next refresh-auth would be affected). Merges into the
   * raw settings JSON so unrelated gateway fields are preserved.
   *
   * This is the one credential write that does not go through
   * `PaymentGatewayRegistryService`, so it has to encrypt the rotated token
   * itself — otherwise every token rotation would quietly drop a plaintext
   * refresh token into an otherwise-encrypted row. Merging into the RAW stored
   * settings (not the decrypted view) is deliberate: the surrounding envelopes
   * are carried over verbatim, so a crypt-key problem cannot turn this
   * best-effort write into a wipe of the other credentials.
   */
  private async persistRotatedRefreshToken(
    gatewayId: string,
    currentSettings: Prisma.JsonValue | null,
    rotatedRefreshToken: string,
  ): Promise<void> {
    try {
      const merged = {
        ...readGatewayData(currentSettings),
        ...encryptGatewaySettingsForStorage(PaymentGatewayType.YOOKASSA, {
          moyNalogRefreshToken: rotatedRefreshToken,
        }),
      };
      await this.prismaService.paymentGateway.update({
        where: { id: gatewayId },
        data: { settings: merged as Prisma.InputJsonValue },
      });
      this.logger.log(`Persisted rotated МойНалог refresh token for gateway ${gatewayId}`);
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to persist rotated МойНалог refresh token: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function buildAuth(
  settings: Record<string, unknown>,
  onRefreshToken: (refreshToken: string) => Promise<void>,
): MoyNalogAuth {
  const method = settings.moyNalogAuthMethod === 'refresh' ? 'refresh' : 'password';
  return {
    method,
    inn: readString(settings.moyNalogInn),
    password: readString(settings.moyNalogPassword),
    refreshToken: readString(settings.moyNalogRefreshToken),
    deviceId: readString(settings.moyNalogDeviceId),
    proxy: readString(settings.moyNalogProxy),
    onRefreshToken,
  };
}

function resolveDescription(transaction: Transaction): string {
  const snapshot = readGatewayData(transaction.planSnapshot);
  const name = snapshot.name;
  if (typeof name === 'string' && name.trim().length > 0) {
    return name;
  }
  return String(transaction.purchaseType);
}

function readTransactionId(data: unknown): string {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('МойНалог job payload is invalid');
  }
  const transactionId = (data as Record<string, unknown>).transactionId;
  if (typeof transactionId !== 'string' || transactionId.length === 0) {
    throw new Error('МойНалог job transactionId is missing');
  }
  return transactionId;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readGatewayData(value: Prisma.JsonValue | null): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
