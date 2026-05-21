import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AddOn, AddOnPrice, AddOnType, Currency, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

export interface AddOnPriceInterface {
  readonly id: string;
  readonly currency: Currency;
  readonly price: string;
}

export interface AddOnInterface {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: AddOnType;
  readonly value: number;
  readonly isActive: boolean;
  readonly orderIndex: number;
  readonly applicablePlanIds: readonly string[];
  readonly prices: readonly AddOnPriceInterface[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

const ADD_ON_INCLUDE = { prices: true } as const;

@Injectable()
export class AddOnsService {
  public constructor(private readonly prismaService: PrismaService) {}

  /** List all add-ons (admin view). */
  public async listAll(): Promise<readonly AddOnInterface[]> {
    const records = await this.prismaService.addOn.findMany({
      include: ADD_ON_INCLUDE,
      orderBy: [{ orderIndex: 'asc' }, { createdAt: 'desc' }],
    });
    return records.map(mapAddOn);
  }

  /**
   * List active add-ons available for a specific plan.
   * Used by the purchase flow to show applicable add-ons.
   */
  public async listForPlan(planId: string): Promise<readonly AddOnInterface[]> {
    const records = await this.prismaService.addOn.findMany({
      where: { isActive: true },
      include: ADD_ON_INCLUDE,
      orderBy: [{ orderIndex: 'asc' }],
    });
    // Filter: add-on applies if applicablePlanIds is empty (all plans) or includes this planId
    return records
      .filter((r) => r.applicablePlanIds.length === 0 || r.applicablePlanIds.includes(planId))
      .map(mapAddOn);
  }

  /** Create a new add-on. */
  public async create(input: {
    name: string;
    description?: string | null;
    type: AddOnType;
    value: number;
    isActive?: boolean;
    applicablePlanIds?: string[];
    prices: Array<{ currency: Currency; price: string }>;
  }): Promise<AddOnInterface> {
    if (input.value <= 0) {
      throw new BadRequestException('Add-on value must be positive');
    }
    const lastRecord = await this.prismaService.addOn.findFirst({
      orderBy: { orderIndex: 'desc' },
      select: { orderIndex: true },
    });
    const record = await this.prismaService.addOn.create({
      data: {
        name: input.name.trim(),
        description: input.description?.trim() ?? null,
        type: input.type,
        value: input.value,
        isActive: input.isActive ?? true,
        orderIndex: (lastRecord?.orderIndex ?? 0) + 1,
        applicablePlanIds: input.applicablePlanIds ?? [],
        prices: {
          create: input.prices.map((p) => ({
            currency: p.currency,
            price: p.price,
          })),
        },
      },
      include: ADD_ON_INCLUDE,
    });
    return mapAddOn(record);
  }

  /** Update an existing add-on. */
  public async update(
    id: string,
    input: Partial<{
      name: string;
      description: string | null;
      type: AddOnType;
      value: number;
      isActive: boolean;
      applicablePlanIds: string[];
      prices: Array<{ currency: Currency; price: string }>;
    }>,
  ): Promise<AddOnInterface> {
    const existing = await this.prismaService.addOn.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Add-on not found');

    const updateData: Prisma.AddOnUpdateInput = {};
    if (input.name !== undefined) updateData.name = input.name.trim();
    if (input.description !== undefined) updateData.description = input.description?.trim() ?? null;
    if (input.type !== undefined) updateData.type = input.type;
    if (input.value !== undefined) {
      if (input.value <= 0) throw new BadRequestException('Add-on value must be positive');
      updateData.value = input.value;
    }
    if (input.isActive !== undefined) updateData.isActive = input.isActive;
    if (input.applicablePlanIds !== undefined) updateData.applicablePlanIds = input.applicablePlanIds;
    if (input.prices !== undefined) {
      updateData.prices = {
        deleteMany: {},
        create: input.prices.map((p) => ({ currency: p.currency, price: p.price })),
      };
    }

    const record = await this.prismaService.addOn.update({
      where: { id },
      data: updateData,
      include: ADD_ON_INCLUDE,
    });
    return mapAddOn(record);
  }

  /** Delete an add-on. */
  public async delete(id: string): Promise<void> {
    const existing = await this.prismaService.addOn.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Add-on not found');
    await this.prismaService.addOn.delete({ where: { id } });
  }
}

function mapAddOn(record: AddOn & { prices?: readonly AddOnPrice[] }): AddOnInterface {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    type: record.type,
    value: record.value,
    isActive: record.isActive,
    orderIndex: record.orderIndex,
    applicablePlanIds: record.applicablePlanIds,
    prices: (record.prices ?? []).map((p) => ({
      id: p.id,
      currency: p.currency,
      price: p.price.toString(),
    })),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
