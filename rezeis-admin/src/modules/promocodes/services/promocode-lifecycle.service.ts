import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';
import { CreatePromocodeDto } from '../dto/create-promocode.dto';
import { UpdatePromocodeDto } from '../dto/update-promocode.dto';
import {
  PromocodeActivationInterface,
  PromocodeActivationResultInterface,
  PromocodeInterface,
} from '../interfaces/promocode.interface';
import { isValidCode, normalizeCode } from '../utils/code-normalizer.util';
import {
  PROMOCODE_INCLUDE_ACTIVATIONS_COUNT,
  mapPromocode,
  mapPromocodeActivation,
} from '../utils/promocode-mappers.util';
import {
  PromocodeRewardsService,
} from './promocode-rewards.service';
import {
  PromocodeValidationResultInterface,
  PromocodeValidationService,
} from './promocode-validation.service';

interface ActivatePromocodeInput {
  readonly rawCode: string;
  readonly userId: string;
  readonly userTelegramId: bigint | null;
  readonly targetSubscriptionId: string | null;
}

/**
 * Donor: `src/services/promocode_lifecycle.py`.
 *
 * Owns the CRUD surface plus the orchestrated `activate(...)` step that
 * combines validation, the activation row, and the reward application
 * inside a single Prisma transaction. Failures roll back the entire step so
 * the user never ends up with a half-applied promocode.
 */
@Injectable()
export class PromocodeLifecycleService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly validationService: PromocodeValidationService,
    private readonly rewardsService: PromocodeRewardsService,
    private readonly events: SystemEventsService,
  ) {}

  public async list(): Promise<readonly PromocodeInterface[]> {
    const records = await this.prismaService.promocode.findMany({
      include: PROMOCODE_INCLUDE_ACTIVATIONS_COUNT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return records.map(mapPromocode);
  }

  public async getById(promocodeId: string): Promise<PromocodeInterface> {
    const record = await this.prismaService.promocode.findUnique({
      where: { id: promocodeId },
      include: PROMOCODE_INCLUDE_ACTIVATIONS_COUNT,
    });
    if (record === null) {
      throw new NotFoundException('Promocode not found');
    }
    return mapPromocode(record);
  }

  public async getByCode(code: string): Promise<PromocodeInterface | null> {
    const normalizedCode = normalizeCode(code);
    if (normalizedCode.length === 0) {
      return null;
    }
    const record = await this.prismaService.promocode.findUnique({
      where: { code: normalizedCode },
      include: PROMOCODE_INCLUDE_ACTIVATIONS_COUNT,
    });
    return record === null ? null : mapPromocode(record);
  }

  public async create(dto: CreatePromocodeDto): Promise<PromocodeInterface> {
    const normalizedCode = normalizeCode(dto.code);
    if (!isValidCode(normalizedCode)) {
      throw new BadRequestException('Promocode code is invalid');
    }

    this.assertPlanSnapshotConsistency(dto.rewardType, dto.plan);

    try {
      const record = await this.prismaService.promocode.create({
        data: {
          code: normalizedCode,
          isActive: dto.isActive ?? true,
          availability: dto.availability,
          rewardType: dto.rewardType,
          reward: dto.reward ?? null,
          plan: dto.plan === null || dto.plan === undefined
            ? Prisma.JsonNull
            : (dto.plan as unknown as Prisma.InputJsonValue),
          lifetime: dto.lifetime ?? null,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
          maxActivations: dto.maxActivations ?? null,
          allowedTelegramIds: (dto.allowedTelegramIds ?? []).map((value) =>
            BigInt(value),
          ),
          allowedPlanIds: dto.allowedPlanIds ?? [],
        },
        include: PROMOCODE_INCLUDE_ACTIVATIONS_COUNT,
      });
      return mapPromocode(record);
    } catch (err: unknown) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(`Promocode '${normalizedCode}' already exists`);
      }
      throw err;
    }
  }

  public async update(
    promocodeId: string,
    dto: UpdatePromocodeDto,
  ): Promise<PromocodeInterface> {
    const existing = await this.prismaService.promocode.findUnique({
      where: { id: promocodeId },
    });
    if (existing === null) {
      throw new NotFoundException('Promocode not found');
    }

    if (dto.rewardType !== undefined || dto.plan !== undefined) {
      this.assertPlanSnapshotConsistency(
        dto.rewardType ?? existing.rewardType,
        dto.plan ?? existing.plan,
      );
    }

    const updateData: Prisma.PromocodeUpdateInput = {};
    if (dto.isActive !== undefined) updateData.isActive = dto.isActive;
    if (dto.availability !== undefined) updateData.availability = dto.availability;
    if (dto.rewardType !== undefined) updateData.rewardType = dto.rewardType;
    if (dto.reward !== undefined) updateData.reward = dto.reward;
    if (dto.plan !== undefined) {
      updateData.plan =
        dto.plan === null
          ? Prisma.JsonNull
          : (dto.plan as unknown as Prisma.InputJsonValue);
    }
    if (dto.lifetime !== undefined) updateData.lifetime = dto.lifetime;
    if (dto.expiresAt !== undefined) {
      updateData.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    }
    if (dto.maxActivations !== undefined) updateData.maxActivations = dto.maxActivations;
    if (dto.allowedTelegramIds !== undefined) {
      updateData.allowedTelegramIds = dto.allowedTelegramIds.map((value) => BigInt(value));
    }
    if (dto.allowedPlanIds !== undefined) {
      updateData.allowedPlanIds = dto.allowedPlanIds;
    }

    const updated = await this.prismaService.promocode.update({
      where: { id: promocodeId },
      data: updateData,
      include: PROMOCODE_INCLUDE_ACTIVATIONS_COUNT,
    });
    return mapPromocode(updated);
  }

  public async delete(promocodeId: string): Promise<void> {
    try {
      await this.prismaService.promocode.delete({ where: { id: promocodeId } });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundException('Promocode not found');
      }
      throw err;
    }
  }

  /**
   * Generates a random unique promocode code that doesn't collide with
   * existing codes in the database. Donor parity: altshop
   * `PromocodeDto.generate_code()` button in the Telegram configurator.
   */
  public async generateUniqueCode(): Promise<{ readonly code: string }> {
    const maxAttempts = 10;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const code = generateRandomCode();
      const existing = await this.prismaService.promocode.findUnique({
        where: { code },
        select: { id: true },
      });
      if (existing === null) {
        return { code };
      }
    }
    throw new BadRequestException(
      'Failed to generate a unique code after multiple attempts',
    );
  }

  public async listUserActivations(input: {
    readonly userId: string;
    readonly limit: number;
    readonly offset: number;
  }): Promise<{
    readonly entries: readonly PromocodeActivationInterface[];
    readonly total: number;
  }> {
    const [total, records] = await Promise.all([
      this.prismaService.promocodeActivation.count({
        where: { userId: input.userId },
      }),
      this.prismaService.promocodeActivation.findMany({
        where: { userId: input.userId },
        orderBy: [{ activatedAt: 'desc' }, { id: 'desc' }],
        skip: input.offset,
        take: input.limit,
      }),
    ]);
    return { entries: records.map(mapPromocodeActivation), total };
  }

  /**
   * Atomically validates and activates a promocode.
   *
   * Donor parity: the activation row is inserted first so the
   * `(promocodeId, userId)` uniqueness constraint protects against the
   * concurrent double-activation race; if reward application fails the
   * transaction rolls the row back together with the reward effect.
   */
  public async activate(
    input: ActivatePromocodeInput,
  ): Promise<PromocodeActivationResultInterface> {
    const userContext = await this.validationService.resolveActivationContext(
      input.userId,
    );
    const validation = await this.validationService.validate(input.rawCode, {
      userId: input.userId,
      userTelegramId: input.userTelegramId,
      hasActiveSubscriptions: userContext.hasActiveSubscriptions,
      isInvitedUser: userContext.isInvitedUser,
    });
    if (!validation.success) {
      return rejectFromValidation(validation);
    }

    const promocode = validation.promocode;
    const targetResolution = await this.validationService.resolveTargetSubscription({
      userId: input.userId,
      targetSubscriptionId: input.targetSubscriptionId,
      promocode,
    });
    if (targetResolution.errorCode !== null) {
      return reject(targetResolution.errorCode, 'ntf-promocode-not-available', promocode);
    }

    const rewardValue = this.rewardsService.resolveActivationRewardValue(promocode);
    try {
      const completed = await this.prismaService.$transaction(async (transactionClient) => {
        const activation = await transactionClient.promocodeActivation.create({
          data: {
            promocodeId: promocode.id,
            userId: input.userId,
            promocodeCode: promocode.code,
            rewardType: promocode.rewardType,
            rewardValue,
            targetSubscriptionId: targetResolution.subscriptionId,
          },
        });
        const application = await this.rewardsService.applyReward({
          transactionClient,
          promocode,
          userId: input.userId,
          targetSubscriptionId: targetResolution.subscriptionId,
        });
        if (!application.applied) {
          throw new RewardNotAppliedError();
        }
        return { activation, rewardValue: application.rewardValue };
      });
      // Emit promocode activated event
      this.events.info(EVENT_TYPES.PROMOCODE_ACTIVATED, 'PROMOCODE', `Promocode ${promocode.code} activated`, {
        userId: input.userId,
        promocodeId: promocode.id,
        code: promocode.code,
        rewardType: promocode.rewardType,
        rewardValue: completed.rewardValue,
      });
      return {
        step: 'ACTIVATED',
        messageKey: this.rewardsService.getSuccessMessageKey(promocode.rewardType),
        errorCode: null,
        promocode,
        reward: { type: promocode.rewardType, value: completed.rewardValue },
        availableSubscriptionIds: [],
        activation: mapPromocodeActivation(completed.activation),
      };
    } catch (err: unknown) {
      if (err instanceof RewardNotAppliedError) {
        return reject(
          'REWARD_NOT_APPLICABLE',
          'ntf-promocode-reward-failed',
          promocode,
        );
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Race: another process activated the same promo for the same user.
        return reject(
          'ALREADY_ACTIVATED',
          'ntf-promocode-already-activated',
          promocode,
        );
      }
      throw err;
    }
  }

  private assertPlanSnapshotConsistency(rewardType: string, plan: unknown): void {
    if (rewardType !== 'SUBSCRIPTION') {
      return;
    }
    if (plan === null || plan === undefined) {
      throw new BadRequestException(
        'SUBSCRIPTION promocodes require a plan snapshot',
      );
    }
    if (typeof plan !== 'object' || Array.isArray(plan)) {
      throw new BadRequestException('Plan snapshot must be a JSON object');
    }
    const candidate = plan as Record<string, unknown>;
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
      throw new BadRequestException('Plan snapshot must include a non-empty id');
    }
  }
}

class RewardNotAppliedError extends Error {
  public constructor() {
    super('promocode reward not applied');
    this.name = 'RewardNotAppliedError';
  }
}

function rejectFromValidation(
  validation: PromocodeValidationResultInterface,
): PromocodeActivationResultInterface {
  if (validation.success) {
    return reject('INTERNAL_ERROR', 'ntf-promocode-internal-error', null);
  }
  const failure = validation as Extract<
    PromocodeValidationResultInterface,
    { success: false }
  >;
  return reject(failure.errorCode, failure.messageKey, null);
}

function reject(
  errorCode: PromocodeActivationResultInterface['errorCode'],
  messageKey: string,
  promocode: PromocodeInterface | null,
): PromocodeActivationResultInterface {
  return {
    step: 'REJECTED',
    messageKey,
    errorCode: errorCode ?? 'INTERNAL_ERROR',
    promocode,
    reward: null,
    availableSubscriptionIds: [],
    activation: null,
  };
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/**
 * Generates a random alphanumeric code (no ambiguous chars like 0/O/1/I).
 * Format: 8 uppercase chars, e.g. `XKRT4N7P`.
 */
function generateRandomCode(): string {
  const chars: string[] = [];
  for (let i = 0; i < CODE_LENGTH; i++) {
    const index = Math.floor(Math.random() * CODE_ALPHABET.length);
    chars.push(CODE_ALPHABET[index]);
  }
  return chars.join('');
}
