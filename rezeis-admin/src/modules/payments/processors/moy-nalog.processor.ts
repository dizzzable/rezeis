import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { PaymentGatewayType, Prisma, Transaction } from '@prisma/client';
import { Job } from 'bullmq';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { MOY_NALOG_JOBS, MOY_NALOG_QUEUE } from '../constants/moy-nalog.constant';
import { MoyNalogApiService, MoyNalogAuth } from '../services/moy-nalog-api.service';
import { renderIncomeName } from '../utils/moy-nalog-income-name.util';
import { readGatewaySettings } from '../utils/payment-gateway-settings.util';

/**
 * Registers a COMPLETED YooKassa transaction as self-employed income in
 * «Мой Налог». Best-effort and idempotent: a transaction that already carries
 * a `moyNalogReceiptUuid` is skipped, and any failure is retried by BullMQ
 * without ever touching subscription fulfillment.
 */
@Processor(MOY_NALOG_QUEUE, { concurrency: 2 })
export class MoyNalogProcessor extends WorkerHost {
  private readonly logger = new Logger(MoyNalogProcessor.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly moyNalogApiService: MoyNalogApiService,
  ) {
    super();
  }

  public override async process(job: Job): Promise<void> {
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
      // Already registered — idempotent guard against retries / replays.
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

    await this.prismaService.transaction.update({
      where: { id: transaction.id },
      data: {
        gatewayData: mergeGatewayData(transaction.gatewayData, {
          moyNalogReceiptUuid: receiptUuid,
          moyNalogRegisteredAt: new Date().toISOString(),
        }) as Prisma.InputJsonValue,
      },
    });
    this.logger.log(`Registered МойНалог income for transaction ${transactionId}`);
  }

  /**
   * Persists a rotated «Мой Налог» refresh token back into the YooKassa
   * gateway settings so the next job authenticates with the current token.
   * Best-effort: a failure here is logged and swallowed (the income is already
   * registered; only the next refresh-auth would be affected). Merges into the
   * raw settings JSON so unrelated gateway fields are preserved.
   */
  private async persistRotatedRefreshToken(
    gatewayId: string,
    currentSettings: Prisma.JsonValue | null,
    rotatedRefreshToken: string,
  ): Promise<void> {
    try {
      const merged = {
        ...readGatewayData(currentSettings),
        moyNalogRefreshToken: rotatedRefreshToken,
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

function mergeGatewayData(
  currentValue: Transaction['gatewayData'],
  nextValue: Record<string, unknown>,
): Record<string, unknown> {
  const currentRecord =
    typeof currentValue === 'object' && currentValue !== null && !Array.isArray(currentValue)
      ? (currentValue as Record<string, unknown>)
      : {};
  return {
    ...currentRecord,
    ...nextValue,
  };
}
