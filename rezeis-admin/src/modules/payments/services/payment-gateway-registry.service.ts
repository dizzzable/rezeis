import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Currency, PaymentGateway, PaymentGatewayType, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { MovePaymentGatewayDto, PaymentGatewayMoveDirection } from '../dto/move-payment-gateway.dto';
import { UpdatePaymentGatewayDto } from '../dto/update-payment-gateway.dto';
import { AdminPaymentGatewayInterface } from '../interfaces/admin-payment-gateway.interface';
import {
  GATEWAY_SUPPORTED_CURRENCIES,
  isCurrencySupportedByGateway,
} from '../utils/gateway-supported-currencies.util';
import {
  normalizeGatewaySettingsForStorage,
  readGatewaySettings,
} from '../utils/payment-gateway-settings.util';

interface PaymentGatewayDefaultInput {
  readonly type: PaymentGatewayType;
  readonly currency: Currency;
  readonly isActive: boolean;
  readonly orderIndex: number;
}

const PAYMENT_GATEWAY_DEFAULTS: readonly PaymentGatewayDefaultInput[] = [
  { type: PaymentGatewayType.TELEGRAM_STARS, currency: Currency.USD, isActive: true, orderIndex: 1 },
  { type: PaymentGatewayType.YOOKASSA, currency: Currency.USD, isActive: true, orderIndex: 2 },
  { type: PaymentGatewayType.ANTILOPAY, currency: Currency.RUB, isActive: false, orderIndex: 3 },
  { type: PaymentGatewayType.PLATEGA, currency: Currency.USD, isActive: false, orderIndex: 4 },
  { type: PaymentGatewayType.OVERPAY, currency: Currency.RUB, isActive: false, orderIndex: 5 },
  { type: PaymentGatewayType.PAYPALYCH, currency: Currency.RUB, isActive: false, orderIndex: 6 },
  { type: PaymentGatewayType.RIOPAY, currency: Currency.RUB, isActive: false, orderIndex: 7 },
  { type: PaymentGatewayType.HELEKET, currency: Currency.USDT, isActive: false, orderIndex: 8 },
  { type: PaymentGatewayType.CRYPTOMUS, currency: Currency.USDT, isActive: false, orderIndex: 9 },
  { type: PaymentGatewayType.MULENPAY, currency: Currency.USD, isActive: false, orderIndex: 10 },
  { type: PaymentGatewayType.WATA, currency: Currency.RUB, isActive: false, orderIndex: 11 },
  { type: PaymentGatewayType.AURAPAY, currency: Currency.RUB, isActive: false, orderIndex: 12 },
  { type: PaymentGatewayType.ROLLYPAY, currency: Currency.RUB, isActive: false, orderIndex: 13 },
  { type: PaymentGatewayType.SEVERPAY, currency: Currency.USD, isActive: false, orderIndex: 14 },
  { type: PaymentGatewayType.LAVA, currency: Currency.RUB, isActive: false, orderIndex: 15 },
  { type: PaymentGatewayType.CRYPTOPAY, currency: Currency.USDT, isActive: false, orderIndex: 16 },
];

@Injectable()
export class PaymentGatewayRegistryService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async listGateways(): Promise<readonly AdminPaymentGatewayInterface[]> {
    const [gateways, pricingUsage] = await Promise.all([
      this.prismaService.paymentGateway.findMany({
        orderBy: [{ orderIndex: 'asc' }, { type: 'asc' }],
      }),
      this.buildPricingUsageMap(),
    ]);
    return gateways.map((gateway) => this.mapGateway(gateway, pricingUsage));
  }

  public async getGateway(gatewayId: string): Promise<AdminPaymentGatewayInterface> {
    const [gateway, pricingUsage] = await Promise.all([
      this.prismaService.paymentGateway.findUnique({
        where: { id: gatewayId },
      }),
      this.buildPricingUsageMap(),
    ]);
    if (gateway === null) {
      throw new NotFoundException('Payment gateway not found');
    }
    return this.mapGateway(gateway, pricingUsage);
  }

  public async updateGateway(
    gatewayId: string,
    input: UpdatePaymentGatewayDto,
  ): Promise<AdminPaymentGatewayInterface> {
    const currentGateway = await this.prismaService.paymentGateway.findUnique({
      where: { id: gatewayId },
    });
    if (currentGateway === null) {
      throw new NotFoundException('Payment gateway not found');
    }
    const updateData = this.buildUpdateData({
      input,
      currentGatewayType: currentGateway.type,
    });
    if (Object.keys(updateData).length === 0) {
      return this.getGateway(gatewayId);
    }
    try {
      await this.prismaService.paymentGateway.update({
        where: { id: gatewayId },
        data: updateData,
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('Payment gateway not found');
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BadRequestException('PAYMENT_GATEWAY_TYPE_CONFLICT');
      }
      throw error;
    }
    return this.getGateway(gatewayId);
  }

  public async moveGateway(
    gatewayId: string,
    direction: MovePaymentGatewayDto['direction'],
  ): Promise<AdminPaymentGatewayInterface> {
    await this.prismaService.$transaction(async (transactionClient) => {
      const currentGateway = await transactionClient.paymentGateway.findUnique({
        where: { id: gatewayId },
      });
      if (currentGateway === null) {
        throw new NotFoundException('Payment gateway not found');
      }
      const candidateGateway = await transactionClient.paymentGateway.findFirst({
        where:
          direction === PaymentGatewayMoveDirection.UP
            ? { orderIndex: { lt: currentGateway.orderIndex } }
            : { orderIndex: { gt: currentGateway.orderIndex } },
        orderBy:
          direction === PaymentGatewayMoveDirection.UP
            ? [{ orderIndex: 'desc' }, { type: 'desc' }]
            : [{ orderIndex: 'asc' }, { type: 'asc' }],
      });
      if (candidateGateway === null) {
        return;
      }
      await Promise.all([
        transactionClient.paymentGateway.update({
          where: { id: currentGateway.id },
          data: { orderIndex: candidateGateway.orderIndex },
        }),
        transactionClient.paymentGateway.update({
          where: { id: candidateGateway.id },
          data: { orderIndex: currentGateway.orderIndex },
        }),
      ]);
    });
    return this.getGateway(gatewayId);
  }

  public async createDefaults(): Promise<readonly AdminPaymentGatewayInterface[]> {
    const existingGateways = await this.prismaService.paymentGateway.findMany({
      select: { type: true },
    });
    const existingTypes = new Set(existingGateways.map((gateway) => gateway.type));
    const missingDefaults = PAYMENT_GATEWAY_DEFAULTS.filter(
      (gateway) => !existingTypes.has(gateway.type),
    );
    if (missingDefaults.length > 0) {
      await this.prismaService.$transaction(async (transactionClient) => {
        for (const gateway of missingDefaults) {
          await transactionClient.paymentGateway.create({
            data: {
              type: gateway.type,
              currency: gateway.currency,
              isActive: gateway.isActive,
              orderIndex: gateway.orderIndex,
              settings: {},
            },
          });
        }
      });
    }
    return this.listGateways();
  }

  private buildUpdateData(input: {
    readonly input: UpdatePaymentGatewayDto;
    readonly currentGatewayType: PaymentGatewayType;
  }): Prisma.PaymentGatewayUpdateInput {
    const updateData: Prisma.PaymentGatewayUpdateInput = {};
    if (input.input.type !== undefined) {
      updateData.type = input.input.type;
    }
    if (input.input.currency !== undefined) {
      // Reject combinations the gateway doesn't actually support so we
      // don't end up issuing checkouts in a currency the provider rejects.
      // The effective gateway type is whatever the request is moving us
      // to; falls back to the current row when the type isn't being changed.
      const effectiveType = input.input.type ?? input.currentGatewayType;
      if (!isCurrencySupportedByGateway(effectiveType, input.input.currency)) {
        throw new BadRequestException('PAYMENT_GATEWAY_CURRENCY_UNSUPPORTED');
      }
      updateData.currency = input.input.currency;
    } else if (input.input.type !== undefined && input.input.type !== input.currentGatewayType) {
      // Caller is changing the gateway type without touching currency —
      // make sure the current currency still fits the new type. If not,
      // snap to the new gateway's first supported currency.
      const supported = GATEWAY_SUPPORTED_CURRENCIES[input.input.type];
      const fallback = supported?.[0];
      if (fallback) {
        updateData.currency = fallback;
      }
    }
    if (input.input.isActive !== undefined) {
      updateData.isActive = input.input.isActive;
    }
    if (input.input.orderIndex !== undefined) {
      updateData.orderIndex = input.input.orderIndex;
    }
    if (input.input.settings !== undefined) {
      updateData.settings = normalizeGatewaySettingsForStorage(
        input.input.type ?? input.currentGatewayType,
        input.input.settings,
      );
    }
    return updateData;
  }

  private async buildPricingUsageMap(): Promise<ReadonlyMap<Currency, ReadonlySet<string>>> {
    const prices = await this.prismaService.planPrice.findMany({
      where: {
        planDuration: {
          plan: {
            isActive: true,
            isArchived: false,
          },
        },
      },
      select: {
        currency: true,
        planDurationId: true,
      },
    });
    const usageMap = new Map<Currency, Set<string>>();
    for (const price of prices) {
      const existingDurationIds = usageMap.get(price.currency) ?? new Set<string>();
      existingDurationIds.add(price.planDurationId);
      usageMap.set(price.currency, existingDurationIds);
    }
    return usageMap;
  }

  private mapGateway(
    gateway: PaymentGateway,
    pricingUsageByCurrency: ReadonlyMap<Currency, ReadonlySet<string>>,
  ): AdminPaymentGatewayInterface {
    const pricingUsage = pricingUsageByCurrency.get(gateway.currency);
    const activePlanDurationCount = pricingUsage?.size ?? 0;
    return {
      id: gateway.id,
      type: gateway.type,
      orderIndex: gateway.orderIndex,
      currency: gateway.currency,
      isActive: gateway.isActive,
      settings: readGatewaySettings(gateway.settings),
      isUsedInPricing: activePlanDurationCount > 0,
      activePlanDurationCount,
      updatedAt: gateway.updatedAt.toISOString(),
    };
  }
}
