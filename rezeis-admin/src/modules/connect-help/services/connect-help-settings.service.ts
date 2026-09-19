import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildAdminAuditLogData } from '../../../common/utils/admin-audit-log.util';
import type { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import type { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import {
  readConnectHelpSettings,
  type ConnectHelpSettingsView,
} from '../../connect-signal/connect-help-settings';
import { mutateSettingsRow } from '../../settings/utils/settings-row-write.util';

/** What a PATCH may change. An omitted field keeps what is stored. */
export interface ConnectHelpSettingsPatch {
  readonly enabled?: boolean;
  readonly delayHours?: number;
  readonly includeTrials?: boolean;
}

function storedObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/**
 * The operator's «Помощь с подключением» switches (`settings.connect_help_settings`).
 *
 * Read through `readConnectHelpSettings`, so an absent key — every install
 * before this feature — is OFF / 24 h / OFF. Written ONLY through
 * `mutateSettingsRow`: the row's JSON columns are shared by unrelated features
 * and a write that does not hold the row lock loses somebody else's change
 * (`test/settings-row-write-invariant.spec.ts` enforces it). The merge starts
 * from the row read under that lock, keeps any key this build does not know,
 * and the audit row commits in the same transaction.
 */
@Injectable()
export class ConnectHelpSettingsService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async read(): Promise<ConnectHelpSettingsView> {
    const row = await this.prismaService.settings.findFirst({
      orderBy: { id: 'asc' },
      select: { connectHelpSettings: true },
    });
    return readConnectHelpSettings(row?.connectHelpSettings ?? null);
  }

  public async update(input: {
    readonly patch: ConnectHelpSettingsPatch;
    readonly currentAdmin: CurrentAdminInterface;
    readonly requestMetadata: RequestMetadataInterface;
  }): Promise<ConnectHelpSettingsView> {
    const patch: Record<string, unknown> = {};
    if (input.patch.enabled !== undefined) patch['enabled'] = input.patch.enabled;
    if (input.patch.delayHours !== undefined) patch['delayHours'] = input.patch.delayHours;
    if (input.patch.includeTrials !== undefined) patch['includeTrials'] = input.patch.includeTrials;
    return mutateSettingsRow(this.prismaService, async ({ tx, row, write }) => {
      const stored = storedObject(row.connectHelpSettings);
      const before = readConnectHelpSettings(stored);
      const next = { ...stored, ...patch };
      const after = readConnectHelpSettings(next);
      await write({ connectHelpSettings: next as Prisma.InputJsonValue });
      await tx.adminAuditLog.create({
        data: buildAdminAuditLogData({
          action: 'settings.connectHelp.updated',
          actorId: input.currentAdmin.id,
          requestMetadata: input.requestMetadata,
          metadata: {
            requestId: input.requestMetadata.requestId,
            patchKeys: Object.keys(patch),
            before,
            after,
          },
        }),
      });
      return after;
    });
  }
}
