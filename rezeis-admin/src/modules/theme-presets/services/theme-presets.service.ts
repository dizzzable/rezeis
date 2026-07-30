import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { SaveThemePresetDto, UpdateThemePresetDto } from '../dto/save-theme-preset.dto';
import { AdminThemePresetInterface } from '../interfaces/admin-theme-preset.interface';

export const ACTIVE_PREFS_STORE_KEYS = [
  'rezeis-admin-theme',
  'rezeis-admin-glass',
  'rezeis-admin-effects',
  'rezeis-admin-appearance',
] as const;

export const ACTIVE_PREFS_LIMITS = {
  payloadBytes: 256 * 1024,
  storeBytes: 192 * 1024,
  stringBytes: 192 * 1024,
  maxDepth: 12,
  maxNodes: 4096,
  maxCollectionEntries: 512,
} as const;

const ACTIVE_PREFS_KEY_SET = new Set<string>(ACTIVE_PREFS_STORE_KEYS);
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializedBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return null;
  }
}

function isSafeJsonValue(
  value: unknown,
  depth = 0,
  budget: { nodes: number } = { nodes: 0 },
): boolean {
  budget.nodes += 1;
  if (budget.nodes > ACTIVE_PREFS_LIMITS.maxNodes) return false;
  if (depth > ACTIVE_PREFS_LIMITS.maxDepth) return false;

  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8') <= ACTIVE_PREFS_LIMITS.stringBytes;
  }
  if (Array.isArray(value)) {
    if (value.length > ACTIVE_PREFS_LIMITS.maxCollectionEntries) return false;
    return value.every((entry) => isSafeJsonValue(entry, depth + 1, budget));
  }
  if (!isPlainRecord(value)) return false;

  const entries = Object.entries(value);
  if (entries.length > ACTIVE_PREFS_LIMITS.maxCollectionEntries) return false;
  return entries.every(
    ([key, entry]) =>
      !FORBIDDEN_OBJECT_KEYS.has(key) &&
      Buffer.byteLength(key, 'utf8') <= 256 &&
      isSafeJsonValue(entry, depth + 1, budget),
  );
}

function isPersistedStoreEnvelope(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    !Object.prototype.hasOwnProperty.call(value, 'state') ||
    keys.some((key) => key !== 'state' && key !== 'version') ||
    !isPlainRecord(value.state)
  ) {
    return false;
  }
  if (
    value.version !== undefined &&
    (!Number.isSafeInteger(value.version) || (value.version as number) < 0)
  ) {
    return false;
  }
  const bytes = serializedBytes(value);
  return (
    bytes !== null &&
    bytes <= ACTIVE_PREFS_LIMITS.storeBytes &&
    isSafeJsonValue(value)
  );
}

/** Strict validation for newly persisted client snapshots. */
export function isValidActivePrefs(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  if (Object.keys(value).some((key) => !ACTIVE_PREFS_KEY_SET.has(key))) return false;
  const bytes = serializedBytes(value);
  if (bytes === null || bytes > ACTIVE_PREFS_LIMITS.payloadBytes) return false;
  return Object.values(value).every(isPersistedStoreEnvelope);
}

/**
 * Defensive read path for rows written before strict validation existed.
 * Valid known stores are salvaged while malformed/unknown fields stay server-side.
 */
export function sanitizeStoredActivePrefs(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null;

  const sanitized: Record<string, unknown> = {};
  for (const key of ACTIVE_PREFS_STORE_KEYS) {
    const store = value[key];
    if (isPersistedStoreEnvelope(store)) sanitized[key] = store;
  }
  if (Object.keys(sanitized).length === 0) return null;

  const bytes = serializedBytes(sanitized);
  return bytes !== null && bytes <= ACTIVE_PREFS_LIMITS.payloadBytes ? sanitized : null;
}

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

  /**
   * Returns the admin's ACTIVE appearance selection (opaque JSON blob mirroring
   * the web client's persisted store shapes), or `null` when never saved.
   */
  public async getAppearancePrefs(
    currentAdmin: CurrentAdminInterface,
  ): Promise<Record<string, unknown> | null> {
    const row = await this.prismaService.adminUser.findUnique({
      where: { id: currentAdmin.id },
      select: { appearancePrefs: true },
    });
    const prefs = row?.appearancePrefs;
    return sanitizeStoredActivePrefs(prefs);
  }

  /**
   * Persists the admin's ACTIVE appearance selection so it follows them across
   * devices. The blob is stored as-is (client-owned shape); the server never
   * interprets it.
   */
  public async saveAppearancePrefs(
    currentAdmin: CurrentAdminInterface,
    prefs: Record<string, unknown>,
  ): Promise<void> {
    if (!isValidActivePrefs(prefs)) {
      throw new BadRequestException('Invalid active appearance preferences');
    }
    await this.prismaService.adminUser.update({
      where: { id: currentAdmin.id },
      data: { appearancePrefs: prefs as Prisma.InputJsonObject },
    });
  }

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
