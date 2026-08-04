import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Currency, PaymentGateway, PaymentGatewayType, Prisma } from '@prisma/client';

import { paymentsConfig } from '../../../common/config/payments.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MovePaymentGatewayDto, PaymentGatewayMoveDirection } from '../dto/move-payment-gateway.dto';
import { UpdatePaymentGatewayDto } from '../dto/update-payment-gateway.dto';
import { AdminPaymentGatewayInterface } from '../interfaces/admin-payment-gateway.interface';
import {
  GATEWAY_SUPPORTED_CURRENCIES,
  isCurrencySupportedByGateway,
} from '../utils/gateway-supported-currencies.util';
import {
  encryptGatewaySettingsForStorage,
  isGatewayConfigured,
  maskGatewaySettings,
  normalizeGatewaySettingsForStorage,
  readGatewaySettings,
  resolveMaskedGatewaySettings,
} from '../utils/payment-gateway-settings.util';
import { buildWebhookUrl } from './payment-provider-execution.helpers';

interface PaymentGatewayDefaultInput {
  readonly type: PaymentGatewayType;
  readonly currency: Currency;
  readonly isActive: boolean;
  readonly orderIndex: number;
}

/**
 * Seeded once per gateway type, for rows that do not exist yet.
 *
 * Every `currency` here MUST appear in that gateway's
 * `GATEWAY_SUPPORTED_CURRENCIES` list — a row born outside its own catalog is
 * rejected by `assertCurrencySupported` on the operator's first save, and
 * worse, may be charged in a currency the provider never agreed to. This is
 * not hypothetical: MulenPay was seeded in USD while its provider enum is
 * exactly `['rub']`, so a $5 plan was posted as 5 ₽. The pairing is pinned by
 * `test/gateway-offering-safety.spec.ts` so the two lists cannot drift again.
 */
export const PAYMENT_GATEWAY_DEFAULTS: readonly PaymentGatewayDefaultInput[] = [
  // Stars are priced in Stars; XTR is the only value the catalog and the Bot
  // API accept, and `createTelegramStarsCheckout` rejects anything else.
  { type: PaymentGatewayType.TELEGRAM_STARS, currency: Currency.XTR, isActive: true, orderIndex: 1 },
  { type: PaymentGatewayType.YOOKASSA, currency: Currency.USD, isActive: true, orderIndex: 2 },
  { type: PaymentGatewayType.ANTILOPAY, currency: Currency.RUB, isActive: false, orderIndex: 3 },
  { type: PaymentGatewayType.PLATEGA, currency: Currency.USD, isActive: false, orderIndex: 4 },
  { type: PaymentGatewayType.OVERPAY, currency: Currency.RUB, isActive: false, orderIndex: 5 },
  { type: PaymentGatewayType.PAYPALYCH, currency: Currency.RUB, isActive: false, orderIndex: 6 },
  { type: PaymentGatewayType.RIOPAY, currency: Currency.RUB, isActive: false, orderIndex: 7 },
  { type: PaymentGatewayType.HELEKET, currency: Currency.USDT, isActive: false, orderIndex: 8 },
  { type: PaymentGatewayType.CRYPTOMUS, currency: Currency.USDT, isActive: false, orderIndex: 9 },
  { type: PaymentGatewayType.MULENPAY, currency: Currency.RUB, isActive: false, orderIndex: 10 },
  { type: PaymentGatewayType.WATA, currency: Currency.RUB, isActive: false, orderIndex: 11 },
  { type: PaymentGatewayType.AURAPAY, currency: Currency.RUB, isActive: false, orderIndex: 12 },
  { type: PaymentGatewayType.ROLLYPAY, currency: Currency.RUB, isActive: false, orderIndex: 13 },
  { type: PaymentGatewayType.SEVERPAY, currency: Currency.USD, isActive: false, orderIndex: 14 },
  { type: PaymentGatewayType.LAVA, currency: Currency.RUB, isActive: false, orderIndex: 15 },
  { type: PaymentGatewayType.CRYPTOPAY, currency: Currency.USDT, isActive: false, orderIndex: 16 },
  { type: PaymentGatewayType.VALUTIX, currency: Currency.RUB, isActive: false, orderIndex: 17 },
];

@Injectable()
export class PaymentGatewayRegistryService {
  public constructor(
    private readonly prismaService: PrismaService,
    @Inject(paymentsConfig.KEY)
    private readonly configuration: ConfigType<typeof paymentsConfig>,
  ) {}

  /**
   * `revealSecrets` is the caller's `payment_gateways:view_secrets` verdict,
   * resolved in the controller. It defaults to `false` everywhere so a new call
   * site has to ASK for credentials rather than receive them by omission —
   * this method used to hand every API key and RSA private key to anyone
   * holding plain `payment_gateways:view`.
   */
  public async listGateways(
    revealSecrets = false,
  ): Promise<readonly AdminPaymentGatewayInterface[]> {
    const [gateways, pricingUsage] = await Promise.all([
      this.prismaService.paymentGateway.findMany({
        orderBy: [{ orderIndex: 'asc' }, { type: 'asc' }],
      }),
      this.buildPricingUsageMap(),
    ]);
    return gateways.map((gateway) => this.mapGateway(gateway, pricingUsage, revealSecrets));
  }

  public async getGateway(
    gatewayId: string,
    revealSecrets = false,
  ): Promise<AdminPaymentGatewayInterface> {
    const [gateway, pricingUsage] = await Promise.all([
      this.prismaService.paymentGateway.findUnique({
        where: { id: gatewayId },
      }),
      this.buildPricingUsageMap(),
    ]);
    if (gateway === null) {
      throw new NotFoundException('Payment gateway not found');
    }
    return this.mapGateway(gateway, pricingUsage, revealSecrets);
  }

  public async updateGateway(
    gatewayId: string,
    input: UpdatePaymentGatewayDto,
    revealSecrets = false,
  ): Promise<AdminPaymentGatewayInterface> {
    const currentGateway = await this.prismaService.paymentGateway.findUnique({
      where: { id: gatewayId },
    });
    if (currentGateway === null) {
      throw new NotFoundException('Payment gateway not found');
    }
    // Normalized once and reused: the readiness guard below and the write
    // itself must agree on what the row will hold, and normalization is what
    // turns the form's blank fields into "absent".
    const effectiveType = input.type ?? currentGateway.type;
    // Order matters, and each step depends on the previous one:
    //   1. resolve masks against the DECRYPTED stored row, so a form submitted
    //      by an operator who was shown `********abcd` keeps the real value.
    //      Settings are replaced rather than merged, so skipping this step
    //      would overwrite every live credential with its own mask.
    //   2. validate + normalize the resulting PLAINTEXT, so the zod schemas
    //      still see real values and the readiness guard below judges what the
    //      gateway will actually be able to do.
    //   3. encrypt last, immediately before the write — see `buildUpdateData`.
    const normalizedSettings =
      input.settings === undefined
        ? undefined
        : this.resolveSubmittedSettings(effectiveType, input.settings, currentGateway.settings);
    // Enabling is the moment readiness starts to matter: an unconfigured but
    // active gateway is offered to the buyer and only fails once the checkout
    // call reaches the provider. One PATCH can carry both `settings` and
    // `isActive`, so the check runs against the post-update values rather than
    // the stored row. Disabling stays unconditional — an operator must always
    // be able to take a broken gateway offline.
    if (input.isActive === true) {
      const effectiveSettings =
        normalizedSettings === undefined
          ? currentGateway.settings
          : (normalizedSettings as Prisma.JsonObject);
      if (!isGatewayConfigured(effectiveType, effectiveSettings)) {
        throw new BadRequestException('PAYMENT_GATEWAY_NOT_CONFIGURED');
      }
    }
    const updateData = this.buildUpdateData({
      input,
      currentGatewayType: currentGateway.type,
      normalizedSettings,
    });
    if (Object.keys(updateData).length === 0) {
      return this.getGateway(gatewayId, revealSecrets);
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
    return this.getGateway(gatewayId, revealSecrets);
  }

  public async moveGateway(
    gatewayId: string,
    direction: MovePaymentGatewayDto['direction'],
    revealSecrets = false,
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
    return this.getGateway(gatewayId, revealSecrets);
  }

  public async createDefaults(
    revealSecrets = false,
  ): Promise<readonly AdminPaymentGatewayInterface[]> {
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
    return this.listGateways(revealSecrets);
  }

  /**
   * Substitutes masked secrets with what is stored, then validates.
   *
   * Only a plain object can carry masks; a scalar, an array or `null` is handed
   * straight to `normalizeGatewaySettingsForStorage`, which stays the single
   * place deciding what a valid settings payload is — and rejects the rest with
   * `PAYMENT_GATEWAY_SETTINGS_INVALID`.
   */
  private resolveSubmittedSettings(
    gatewayType: PaymentGatewayType,
    submitted: unknown,
    storedSettings: Prisma.JsonValue,
  ): Prisma.InputJsonObject {
    const isPlainObject =
      typeof submitted === 'object' && submitted !== null && !Array.isArray(submitted);
    const resolved = isPlainObject
      ? resolveMaskedGatewaySettings(
          gatewayType,
          submitted as Record<string, unknown>,
          readGatewaySettings(storedSettings),
        )
      : submitted;
    return normalizeGatewaySettingsForStorage(gatewayType, resolved);
  }

  private buildUpdateData(input: {
    readonly input: UpdatePaymentGatewayDto;
    readonly currentGatewayType: PaymentGatewayType;
    /** Already validated by `updateGateway` so the guard and the write agree. */
    readonly normalizedSettings: Prisma.InputJsonObject | undefined;
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
    if (input.normalizedSettings !== undefined) {
      // Encryption is the LAST thing that happens to the settings object. Doing
      // it here rather than earlier means validation, mask resolution and the
      // readiness guard all reason about real credentials, and the ciphertext
      // exists only in the value handed to Prisma. It is also what upgrades a
      // legacy plaintext row: any save rewrites the whole column, so the row
      // comes back encrypted without a migration.
      const effectiveType = input.input.type ?? input.currentGatewayType;
      updateData.settings = encryptGatewaySettingsForStorage(
        effectiveType,
        input.normalizedSettings,
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
    revealSecrets: boolean,
  ): AdminPaymentGatewayInterface {
    const pricingUsage = pricingUsageByCurrency.get(gateway.currency);
    const activePlanDurationCount = pricingUsage?.size ?? 0;
    const plainSettings = readGatewaySettings(gateway.settings);
    const masked = maskGatewaySettings(gateway.type, plainSettings);
    return {
      id: gateway.id,
      type: gateway.type,
      orderIndex: gateway.orderIndex,
      currency: gateway.currency,
      isActive: gateway.isActive,
      settings: revealSecrets ? plainSettings : masked.settings,
      secretsVisible: revealSecrets,
      // Always the real list, even when secrets are revealed: it names the
      // secret-bearing fields that currently hold a value, which is what the
      // form uses to tell "not set" from "set", and the caller's permission
      // does not change that fact.
      configuredSecretKeys: masked.maskedKeys,
      // `isGatewayConfigured` runs on the DECRYPTED settings, never on the
      // masked view, so readiness is unaffected by who is asking — an operator
      // without `view_secrets` still sees the same green badge as a superadmin.
      isConfigured: isGatewayConfigured(gateway.type, gateway.settings),
      webhookUrl: this.resolveWebhookUrl(gateway.type),
      isUsedInPricing: activePlanDurationCount > 0,
      activePlanDurationCount,
      updatedAt: gateway.updatedAt.toISOString(),
    };
  }

  /**
   * `buildWebhookUrl` throws when `REZEIS_DOMAIN` is unset, which is the right
   * call at checkout time — a provider cannot be handed a relative callback.
   * The settings screen must still render, so an unconfigured domain degrades
   * to the relative path the panel used to hardcode instead of 503-ing the
   * whole gateway list.
   */
  private resolveWebhookUrl(gatewayType: PaymentGatewayType): string {
    const domain = this.configuration.domain;
    return domain === null
      ? `/api/v1/payments/webhooks/${gatewayType}`
      : buildWebhookUrl(domain, gatewayType);
  }
}
