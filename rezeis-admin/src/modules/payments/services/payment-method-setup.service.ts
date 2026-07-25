import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  PaymentGatewayType,
  PaymentMethodSetup,
  PaymentMethodSetupStatus,
  Prisma,
} from '@prisma/client';
import { firstValueFrom } from 'rxjs';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { readGatewaySettings } from '../utils/payment-gateway-settings.util';
import {
  readBooleanSetting,
  readOptionalString,
  readRecord,
  requireSetting,
  requireYookassaSecretKey,
} from './payment-provider-execution.helpers';
import { SavedPaymentMethodService } from './saved-payment-method.service';

export const YOOKASSA_STANDALONE_SETUP_CONSENT_VERSION = 'yookassa-zero-amount-v1';

const SETUP_TTL_MS = 30 * 60 * 1000;

/**
 * Minimum gap between two live YooKassa status polls for the same setup. The
 * client polls every few seconds while the tab is open; without this guard each
 * poll would hit the provider and could exhaust per-account API limits under
 * many concurrent bindings. Local reads still return the last known status.
 */
const REFRESH_THROTTLE_MS = 5 * 1000;

/** Max PENDING setups reconciled per cron tick — bounds provider fan-out. */
const RECONCILE_MAX_PER_TICK = 100;

@Injectable()
export class PaymentMethodSetupService {
  private readonly logger = new Logger(PaymentMethodSetupService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly httpService: HttpService,
    private readonly savedPaymentMethodService: SavedPaymentMethodService,
  ) {}

  public async getCapabilities(): Promise<{ readonly yookassaStandaloneSetup: boolean }> {
    const gateway = await this.prismaService.paymentGateway.findUnique({
      where: { type: PaymentGatewayType.YOOKASSA },
      select: { isActive: true, settings: true },
    });
    if (gateway === null || !gateway.isActive) {
      return { yookassaStandaloneSetup: false };
    }
    const settings = readGatewaySettings(gateway.settings);
    return {
      yookassaStandaloneSetup: readBooleanSetting(settings, 'savePaymentMethod', true),
    };
  }

  public async startYookassaSetup(input: {
    readonly userId: string;
    readonly returnUrl: string;
    readonly consent: boolean;
    readonly consentIp?: string | null;
    readonly consentUserAgent?: string | null;
  }): Promise<{ readonly setupId: string; readonly checkoutUrl: string; readonly expiresAt: string }> {
    if (!input.consent) {
      throw new BadRequestException({
        code: 'PAYMENT_METHOD_SETUP_CONSENT_REQUIRED',
        message: 'Explicit consent is required to save a payment method',
      });
    }

    const gateway = await this.prismaService.paymentGateway.findUnique({
      where: { type: PaymentGatewayType.YOOKASSA },
    });
    if (gateway === null || !gateway.isActive) {
      throw new BadRequestException({
        code: 'PAYMENT_METHOD_SETUP_UNAVAILABLE',
        message: 'YooKassa payment method setup is unavailable',
      });
    }
    const settings = readGatewaySettings(gateway.settings);
    if (!readBooleanSetting(settings, 'savePaymentMethod', true)) {
      throw new BadRequestException({
        code: 'PAYMENT_METHOD_SETUP_UNAVAILABLE',
        message: 'YooKassa payment method setup is disabled',
      });
    }

    // Reuse an in-flight binding instead of opening a second real YooKassa
    // request on a double-tap / retry. The partial unique index enforces this
    // at the DB level too; this fast path avoids the failed insert entirely.
    const existingPending = await this.prismaService.paymentMethodSetup.findFirst({
      where: {
        userId: input.userId,
        gatewayType: PaymentGatewayType.YOOKASSA,
        status: PaymentMethodSetupStatus.PENDING,
        expiresAt: { gt: new Date() },
        providerMethodId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existingPending !== null) {
      const checkoutUrl = readCheckoutUrl(existingPending.rawSnapshot);
      if (checkoutUrl !== null) {
        return {
          setupId: existingPending.id,
          checkoutUrl,
          expiresAt: existingPending.expiresAt.toISOString(),
        };
      }
    }

    const expiresAt = new Date(Date.now() + SETUP_TTL_MS);
    let setup: PaymentMethodSetup;
    try {
      setup = await this.prismaService.paymentMethodSetup.create({
        data: {
          userId: input.userId,
          gatewayType: PaymentGatewayType.YOOKASSA,
          status: PaymentMethodSetupStatus.PENDING,
          consentVersion: YOOKASSA_STANDALONE_SETUP_CONSENT_VERSION,
          consentAt: new Date(),
          consentIp: input.consentIp ?? null,
          consentUserAgent: input.consentUserAgent ?? null,
          returnUrl: input.returnUrl,
          expiresAt,
        },
      });
    } catch (error: unknown) {
      // Lost the race against a concurrent start (partial unique index on
      // PENDING). Surface a retryable signal rather than a 500.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BadRequestException({
          code: 'PAYMENT_METHOD_SETUP_ALREADY_PENDING',
          message: 'A card binding is already in progress',
        });
      }
      throw error;
    }

    try {
      const shopId = requireSetting(settings, 'shopId');
      const secretKey = requireYookassaSecretKey(settings);
      const returnUrl = appendSetupId(input.returnUrl, setup.id);
      const response = await firstValueFrom(
        this.httpService.post(
          'https://api.yookassa.ru/v3/payment_methods',
          {
            type: 'bank_card',
            confirmation: { type: 'redirect', return_url: returnUrl },
            metadata: {
              paymentMethodSetupId: setup.id,
              userId: input.userId,
              consentVersion: YOOKASSA_STANDALONE_SETUP_CONSENT_VERSION,
            },
          },
          {
            auth: { username: shopId, password: secretKey },
            headers: { 'Idempotence-Key': setup.id },
            validateStatus: () => true,
          },
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        throw new ServiceUnavailableException('YooKassa payment method setup could not be started');
      }
      const providerMethod = readRecord(response.data);
      const providerMethodId = readOptionalString(providerMethod, ['id']);
      const checkoutUrl = readOptionalString(
        readRecord(providerMethod.confirmation),
        ['confirmation_url'],
      );
      if (providerMethodId === null || checkoutUrl === null) {
        throw new ServiceUnavailableException('YooKassa payment method setup response is incomplete');
      }

      await this.prismaService.paymentMethodSetup.update({
        where: { id: setup.id },
        data: {
          providerMethodId,
          providerStatus: readOptionalString(providerMethod, ['status']),
          rawSnapshot: providerMethod as Prisma.InputJsonValue,
        },
      });
      return { setupId: setup.id, checkoutUrl, expiresAt: expiresAt.toISOString() };
    } catch (error: unknown) {
      await this.prismaService.paymentMethodSetup.update({
        where: { id: setup.id },
        data: { status: PaymentMethodSetupStatus.FAILED, completedAt: new Date() },
      });
      throw error;
    }
  }

  public async getStatusForUser(input: {
    readonly userId: string;
    readonly setupId: string;
  }): Promise<{ readonly status: PaymentMethodSetupStatus; readonly expiresAt: string }> {
    let setup = await this.prismaService.paymentMethodSetup.findFirst({
      where: { id: input.setupId, userId: input.userId },
    });
    if (setup === null) {
      throw new NotFoundException('Payment method setup not found');
    }

    if (setup.status === PaymentMethodSetupStatus.PENDING && setup.expiresAt <= new Date()) {
      setup = await this.prismaService.paymentMethodSetup.update({
        where: { id: setup.id },
        data: { status: PaymentMethodSetupStatus.EXPIRED, completedAt: new Date() },
      });
    } else if (
      setup.status === PaymentMethodSetupStatus.PENDING &&
      setup.providerMethodId !== null &&
      this.shouldPollProvider(setup.lastCheckedAt)
    ) {
      setup = await this.refreshYookassaSetup(setup.id, setup.userId, setup.providerMethodId);
    }

    return { status: setup.status, expiresAt: setup.expiresAt.toISOString() };
  }

  /**
   * Handles a YooKassa `payment_method.active` / `payment_method.inactive`
   * webhook. This is the primary completion signal: it fires even when the user
   * never returns to the tab, so the binding is not lost on a closed browser.
   * Routed here (not through payment reconciliation) because the event carries a
   * payment_method object, not a payment. Idempotent — re-delivery is a no-op.
   */
  public async handleYookassaPaymentMethodEvent(rawObject: unknown): Promise<void> {
    const providerMethod = readRecord(rawObject);
    const providerMethodId = readOptionalString(providerMethod, ['id']);
    if (providerMethodId === null) {
      return;
    }
    const metadata = readRecord(providerMethod.metadata);
    const setupId = readOptionalString(metadata, ['paymentMethodSetupId']);

    const setup =
      setupId !== null
        ? await this.prismaService.paymentMethodSetup.findUnique({ where: { id: setupId } })
        : await this.prismaService.paymentMethodSetup.findUnique({
            where: { providerMethodId },
          });
    if (setup === null) {
      this.logger.warn(
        `YooKassa payment_method event for unknown setup (methodId=${providerMethodId}, setupId=${setupId ?? 'n/a'})`,
      );
      return;
    }

    await this.applyProviderMethod(setup, providerMethod);
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'payment-method-setup-reconcile' })
  public async reconcilePendingSetups(): Promise<void> {
    if (!shouldRunSchedules()) return;

    const now = new Date();
    // Expire abandoned bindings with no provider handle at all.
    await this.prismaService.paymentMethodSetup.updateMany({
      where: {
        status: PaymentMethodSetupStatus.PENDING,
        expiresAt: { lte: now },
      },
      data: { status: PaymentMethodSetupStatus.EXPIRED, completedAt: now },
    });

    // Poll still-open bindings that have a provider handle. This is the safety
    // net for lost `payment_method.active` webhooks (user closed the tab and
    // never polled): the card is bound at YooKassa but we never heard back.
    const pending = await this.prismaService.paymentMethodSetup.findMany({
      where: {
        status: PaymentMethodSetupStatus.PENDING,
        providerMethodId: { not: null },
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'asc' },
      take: RECONCILE_MAX_PER_TICK,
    });
    if (pending.length === 0) return;

    let resolved = 0;
    for (const setup of pending) {
      if (setup.providerMethodId === null) continue;
      try {
        const next = await this.refreshYookassaSetup(
          setup.id,
          setup.userId,
          setup.providerMethodId,
        );
        if (next.status !== PaymentMethodSetupStatus.PENDING) resolved += 1;
      } catch (error: unknown) {
        this.logger.warn(
          `Reconcile poll failed for setup ${setup.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (resolved > 0) {
      this.logger.log(`Payment-method setup reconcile: resolved ${resolved} pending binding(s)`);
    }
  }

  private shouldPollProvider(lastCheckedAt: Date | null): boolean {
    return lastCheckedAt === null || Date.now() - lastCheckedAt.getTime() >= REFRESH_THROTTLE_MS;
  }

  private async refreshYookassaSetup(
    setupId: string,
    userId: string,
    providerMethodId: string,
  ): Promise<PaymentMethodSetup> {
    const gateway = await this.prismaService.paymentGateway.findUnique({
      where: { type: PaymentGatewayType.YOOKASSA },
    });
    if (gateway === null) {
      throw new ServiceUnavailableException('YooKassa gateway is not configured');
    }
    const settings = readGatewaySettings(gateway.settings);
    const shopId = requireSetting(settings, 'shopId');
    const secretKey = requireYookassaSecretKey(settings);
    const response = await firstValueFrom(
      this.httpService.get(
        `https://api.yookassa.ru/v3/payment_methods/${encodeURIComponent(providerMethodId)}`,
        {
          auth: { username: shopId, password: secretKey },
          validateStatus: () => true,
        },
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      this.logger.warn(`Unable to refresh YooKassa setup ${setupId}: HTTP ${response.status}`);
      // Stamp the poll so the client throttle still advances on a transient
      // upstream error and we don't hot-loop the provider.
      return this.prismaService.paymentMethodSetup.update({
        where: { id: setupId },
        data: { lastCheckedAt: new Date() },
      });
    }

    const providerMethod = readRecord(response.data);
    return this.applyProviderMethod({ id: setupId, userId } as PaymentMethodSetup, providerMethod);
  }

  /**
   * Maps a YooKassa payment_method object onto the setup row and, when active,
   * persists the reusable saved method. Idempotent and safe to run from either
   * the webhook or the poll path. Only advances PENDING rows to a terminal
   * state so a late duplicate can never revert an already-resolved binding.
   */
  private async applyProviderMethod(
    setup: Pick<PaymentMethodSetup, 'id' | 'userId'>,
    providerMethod: Record<string, unknown>,
  ): Promise<PaymentMethodSetup> {
    const providerStatus = readOptionalString(providerMethod, ['status']) ?? 'pending';
    const saved = providerMethod.saved === true;
    const active = providerStatus.toLowerCase() === 'active' && saved;
    const inactive = providerStatus.toLowerCase() === 'inactive';

    if (active) {
      await this.savedPaymentMethodService.upsertFromYookassaPaymentMethod({
        userId: setup.userId,
        rawPaymentMethod: providerMethod,
      });
    }

    const nextStatus = active
      ? PaymentMethodSetupStatus.ACTIVE
      : inactive
        ? PaymentMethodSetupStatus.INACTIVE
        : PaymentMethodSetupStatus.PENDING;

    // Race guard: only transition a row that is still PENDING. A concurrent
    // webhook + poll must not double-apply or downgrade a resolved binding.
    if (nextStatus === PaymentMethodSetupStatus.PENDING) {
      return this.prismaService.paymentMethodSetup.update({
        where: { id: setup.id },
        data: {
          providerStatus,
          lastCheckedAt: new Date(),
          rawSnapshot: providerMethod as Prisma.InputJsonValue,
        },
      });
    }

    await this.prismaService.paymentMethodSetup.updateMany({
      where: { id: setup.id, status: PaymentMethodSetupStatus.PENDING },
      data: {
        providerStatus,
        status: nextStatus,
        completedAt: new Date(),
        lastCheckedAt: new Date(),
        rawSnapshot: providerMethod as Prisma.InputJsonValue,
      },
    });
    return this.prismaService.paymentMethodSetup.findUniqueOrThrow({ where: { id: setup.id } });
  }
}

function appendSetupId(returnUrl: string, setupId: string): string {
  let parsed: URL;
  try {
    parsed = new URL(returnUrl);
  } catch {
    throw new BadRequestException('PAYMENT_METHOD_SETUP_RETURN_URL_INVALID');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestException('PAYMENT_METHOD_SETUP_RETURN_URL_INVALID');
  }
  parsed.searchParams.set('setupId', setupId);
  return parsed.toString();
}

function readCheckoutUrl(rawSnapshot: Prisma.JsonValue | null): string | null {
  const snapshot = readRecord(rawSnapshot);
  return readOptionalString(readRecord(snapshot.confirmation), ['confirmation_url']);
}
