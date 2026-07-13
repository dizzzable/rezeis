import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AddOn, AddOnLifetime, AddOnPrice, AddOnType, Currency, Prisma } from '@prisma/client';

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
  readonly lifetime: AddOnLifetime;
  readonly revision: number;
  readonly icon: string | null;
  readonly value: number;
  readonly isActive: boolean;
  readonly archivedAt: string | null;
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

  /** List all add-ons (admin view), including archived. */
  public async listAll(): Promise<readonly AddOnInterface[]> {
    const records = await this.prismaService.addOn.findMany({
      include: ADD_ON_INCLUDE,
      orderBy: [{ orderIndex: 'asc' }, { createdAt: 'desc' }],
    });
    return records.map(mapAddOn);
  }

  /**
   * List active, non-archived add-ons available for a specific plan.
   * Used by the purchase flow to show applicable add-ons.
   */
  public async listForPlan(planId: string): Promise<readonly AddOnInterface[]> {
    const records = await this.prismaService.addOn.findMany({
      where: { isActive: true, archivedAt: null },
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
    lifetime?: AddOnLifetime;
    icon?: string | null;
    value: number;
    isActive?: boolean;
    applicablePlanIds?: string[];
    prices: Array<{ currency: Currency; price: string }>;
  }): Promise<AddOnInterface> {
    if (input.value <= 0) {
      throw new BadRequestException('Add-on value must be positive');
    }
    const applicablePlanIds = normalizePlanIds(input.applicablePlanIds);
    await this.assertPlansExist(applicablePlanIds);
    const lastRecord = await this.prismaService.addOn.findFirst({
      orderBy: { orderIndex: 'desc' },
      select: { orderIndex: true },
    });
    const record = await this.prismaService.addOn.create({
      data: {
        name: input.name.trim(),
        description: input.description?.trim() ?? null,
        type: input.type,
        lifetime: input.lifetime ?? AddOnLifetime.UNTIL_NEXT_RESET,
        icon: normalizeIcon(input.icon),
        value: input.value,
        isActive: input.isActive ?? true,
        orderIndex: (lastRecord?.orderIndex ?? 0) + 1,
        applicablePlanIds,
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

  /**
   * Update an existing add-on. Commercial changes (name, type, value, lifetime,
   * prices, applicable plans) bump `revision` so entitlement snapshots and
   * checkout fingerprints can pin the exact catalog version they were sold at.
   */
  public async update(
    id: string,
    input: Partial<{
      name: string;
      description: string | null;
      type: AddOnType;
      lifetime: AddOnLifetime;
      icon: string | null;
      value: number;
      isActive: boolean;
      applicablePlanIds: string[];
      prices: Array<{ currency: Currency; price: string }>;
    }>,
  ): Promise<AddOnInterface> {
    const existing = await this.prismaService.addOn.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Add-on not found');

    const updateData: Prisma.AddOnUpdateInput = {};
    let commercialChanged = false;

    if (input.name !== undefined) {
      const name = input.name.trim();
      updateData.name = name;
      if (name !== existing.name) commercialChanged = true;
    }
    if (input.description !== undefined) updateData.description = input.description?.trim() ?? null;
    if (input.type !== undefined) {
      updateData.type = input.type;
      if (input.type !== existing.type) commercialChanged = true;
    }
    if (input.lifetime !== undefined) {
      updateData.lifetime = input.lifetime;
      if (input.lifetime !== existing.lifetime) commercialChanged = true;
    }
    if (input.icon !== undefined) updateData.icon = normalizeIcon(input.icon);
    if (input.value !== undefined) {
      if (input.value <= 0) throw new BadRequestException('Add-on value must be positive');
      updateData.value = input.value;
      if (input.value !== existing.value) commercialChanged = true;
    }
    if (input.isActive !== undefined) updateData.isActive = input.isActive;
    if (input.applicablePlanIds !== undefined) {
      const applicablePlanIds = normalizePlanIds(input.applicablePlanIds);
      await this.assertPlansExist(applicablePlanIds);
      updateData.applicablePlanIds = applicablePlanIds;
      if (!sameStringSet(applicablePlanIds, existing.applicablePlanIds)) commercialChanged = true;
    }
    if (input.prices !== undefined) {
      updateData.prices = {
        deleteMany: {},
        create: input.prices.map((p) => ({ currency: p.currency, price: p.price })),
      };
      commercialChanged = true;
    }

    if (commercialChanged) {
      updateData.revision = { increment: 1 };
    }

    const record = await this.prismaService.addOn.update({
      where: { id },
      data: updateData,
      include: ADD_ON_INCLUDE,
    });
    return mapAddOn(record);
  }

  /**
   * Archive an add-on: hide it from the catalog without destroying it. This is
   * the durable alternative to deletion — entitlement snapshots reference the
   * catalog row (revision/price history), so a sold add-on must never vanish.
   * Idempotent.
   */
  public async archive(id: string): Promise<AddOnInterface> {
    const existing = await this.prismaService.addOn.findUnique({ where: { id }, include: ADD_ON_INCLUDE });
    if (!existing) throw new NotFoundException('Add-on not found');
    if (existing.archivedAt !== null) {
      return mapAddOn(existing);
    }
    const record = await this.prismaService.addOn.update({
      where: { id },
      data: { archivedAt: new Date(), isActive: false },
      include: ADD_ON_INCLUDE,
    });
    return mapAddOn(record);
  }

  /**
   * Hard-delete an add-on. Only allowed when no entitlement references it;
   * referenced add-ons must be archived instead so their purchase history and
   * price snapshots survive.
   */
  public async delete(id: string): Promise<void> {
    const existing = await this.prismaService.addOn.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Add-on not found');
    const referencing = await this.prismaService.addOnEntitlement.count({ where: { addOnId: id } });
    if (referencing > 0) {
      throw new ConflictException(
        'Add-on has entitlement history and cannot be hard-deleted; archive it instead',
      );
    }
    await this.prismaService.addOn.delete({ where: { id } });
  }

  /** Rejects any plan id that does not exist so the catalog cannot store orphans. */
  private async assertPlansExist(planIds: readonly string[]): Promise<void> {
    if (planIds.length === 0) return;
    const found = await this.prismaService.plan.findMany({
      where: { id: { in: [...planIds] } },
      select: { id: true },
    });
    const foundIds = new Set(found.map((p) => p.id));
    const missing = planIds.filter((planId) => !foundIds.has(planId));
    if (missing.length > 0) {
      throw new BadRequestException(`Unknown plan id(s): ${missing.join(', ')}`);
    }
  }
}

function mapAddOn(record: AddOn & { prices?: readonly AddOnPrice[] }): AddOnInterface {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    type: record.type,
    lifetime: record.lifetime,
    revision: record.revision,
    icon: record.icon,
    value: record.value,
    isActive: record.isActive,
    archivedAt: record.archivedAt?.toISOString() ?? null,
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

/** Trims an icon key; empty/blank → null so it falls back to the default. */
function normalizeIcon(icon: string | null | undefined): string | null {
  if (typeof icon !== 'string') return null;
  const trimmed = icon.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 64) : null;
}

/** Trim, drop blanks and de-duplicate applicable plan ids (order preserved). */
function normalizePlanIds(planIds: readonly string[] | undefined): string[] {
  if (planIds === undefined) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of planIds) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}
