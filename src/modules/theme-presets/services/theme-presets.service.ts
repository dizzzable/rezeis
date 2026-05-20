import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { SaveThemePresetDto, UpdateThemePresetDto } from '../dto/save-theme-preset.dto';
import { AdminThemePresetInterface } from '../interfaces/admin-theme-preset.interface';

interface PresetRow {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly description: string | null;
  readonly isShared: boolean;
  readonly themeData: Prisma.JsonValue;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly owner: { readonly id: string; readonly name: string | null; readonly login: string };
}

@Injectable()
export class ThemePresetsService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async listPresets(
    currentAdmin: CurrentAdminInterface,
  ): Promise<readonly AdminThemePresetInterface[]> {
    const rows = (await this.prismaService.adminThemePreset.findMany({
      where: {
        OR: [{ ownerId: currentAdmin.id }, { isShared: true }],
      },
      include: {
        owner: { select: { id: true, name: true, login: true } },
      },
      orderBy: [{ updatedAt: 'desc' }],
    })) as readonly PresetRow[];

    return rows.map((row) => this.mapPreset(row, currentAdmin));
  }

  public async createPreset(
    input: SaveThemePresetDto,
    currentAdmin: CurrentAdminInterface,
  ): Promise<AdminThemePresetInterface> {
    const created = (await this.prismaService.adminThemePreset.create({
      data: {
        ownerId: currentAdmin.id,
        name: input.name,
        description: input.description ?? null,
        isShared: input.isShared ?? false,
        themeData: input.themeData as unknown as Prisma.InputJsonValue,
      },
      include: {
        owner: { select: { id: true, name: true, login: true } },
      },
    })) as PresetRow;
    return this.mapPreset(created, currentAdmin);
  }

  public async updatePreset(
    presetId: string,
    input: UpdateThemePresetDto,
    currentAdmin: CurrentAdminInterface,
  ): Promise<AdminThemePresetInterface> {
    const existing = await this.findOwnedPreset(presetId, currentAdmin);

    const data: Prisma.AdminThemePresetUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.isShared !== undefined) data.isShared = input.isShared;
    if (input.themeData !== undefined) {
      data.themeData = input.themeData as unknown as Prisma.InputJsonValue;
    }

    const updated = (await this.prismaService.adminThemePreset.update({
      where: { id: existing.id },
      data,
      include: {
        owner: { select: { id: true, name: true, login: true } },
      },
    })) as PresetRow;

    return this.mapPreset(updated, currentAdmin);
  }

  public async deletePreset(
    presetId: string,
    currentAdmin: CurrentAdminInterface,
  ): Promise<void> {
    await this.findOwnedPreset(presetId, currentAdmin);
    await this.prismaService.adminThemePreset.delete({ where: { id: presetId } });
  }

  private async findOwnedPreset(
    presetId: string,
    currentAdmin: CurrentAdminInterface,
  ): Promise<{ readonly id: string; readonly ownerId: string }> {
    const row = await this.prismaService.adminThemePreset.findUnique({
      where: { id: presetId },
      select: { id: true, ownerId: true },
    });
    if (!row) {
      throw new NotFoundException('Theme preset not found');
    }
    if (row.ownerId !== currentAdmin.id && currentAdmin.role !== 'DEV') {
      throw new ForbiddenException('Only the owner can mutate this preset');
    }
    return row;
  }

  private mapPreset(
    row: PresetRow,
    currentAdmin: CurrentAdminInterface,
  ): AdminThemePresetInterface {
    return {
      id: row.id,
      ownerId: row.ownerId,
      ownerName: row.owner.name ?? row.owner.login,
      name: row.name,
      description: row.description,
      isShared: row.isShared,
      isOwn: row.ownerId === currentAdmin.id,
      themeData: row.themeData as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
