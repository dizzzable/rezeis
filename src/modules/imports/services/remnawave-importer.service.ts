import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ImportStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  RemnawaveApiService,
  RemnawavePanelUser,
} from '../../remnawave/services/remnawave-api.service';

export interface RemnawaveImportSummary {
  readonly importRecordId: string;
  readonly fetched: number;
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly errors: readonly string[];
}

interface RunInput {
  readonly mode: 'import' | 'sync';
  readonly createdBy: string | null;
}

/**
 * One-click Remnawave importer/synchronizer — donor flow:
 *   altshop → DashboardImporter.MAIN → "Synchronize" button.
 *
 * Pulls the full user catalogue from the Remnawave panel and projects it
 * onto rezeis-admin's `User` table. Two modes:
 *   • `import` — upserts every panel user, creating new local rows for
 *     panel users we've never seen before (matched by `telegramId`).
 *   • `sync`   — only updates existing local users (no creations).
 *
 * Each run produces an `ImportRecord` row so the operator can see the
 * history (wired into the Imports page).
 */
@Injectable()
export class RemnawaveImporterService {
  private readonly logger = new Logger(RemnawaveImporterService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
  ) {}

  public async run(input: RunInput): Promise<RemnawaveImportSummary> {
    let panelUsers: RemnawavePanelUser[];
    try {
      panelUsers = await this.remnawaveApiService.getAllPanelUsers();
    } catch (err) {
      this.logger.error(`getAllPanelUsers failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        'REMNAWAVE_INTEGRATION_UNAVAILABLE',
      );
    }

    const errors: string[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const panelUser of panelUsers) {
      try {
        if (panelUser.telegramId === null) {
          skipped += 1;
          continue;
        }
        const telegramIdBigInt = BigInt(panelUser.telegramId);
        const existing = await this.prismaService.user.findUnique({
          where: { telegramId: telegramIdBigInt },
          select: { id: true },
        });
        const fields: Prisma.UserUpdateInput = {
          username: panelUser.username || undefined,
          email: panelUser.email ?? undefined,
        };
        if (existing === null) {
          if (input.mode === 'sync') {
            // Sync mode never creates new local rows.
            skipped += 1;
            continue;
          }
          await this.prismaService.user.create({
            data: {
              telegramId: telegramIdBigInt,
              username: panelUser.username || null,
              email: panelUser.email,
              name: panelUser.username || '',
            },
          });
          created += 1;
        } else {
          await this.prismaService.user.update({
            where: { id: existing.id },
            data: fields,
          });
          updated += 1;
        }
      } catch (err) {
        const message = `tgid=${panelUser.telegramId ?? '?'}: ${(err as Error).message}`;
        errors.push(message);
        this.logger.warn(`Importer row failed: ${message}`);
      }
    }

    const importRecord = await this.prismaService.importRecord.create({
      data: {
        filename: `remnawave-${input.mode}-${new Date().toISOString()}.json`,
        sourceType: 'remnawave',
        status: errors.length === 0 ? ImportStatus.COMMITTED : ImportStatus.FAILED,
        recordsTotal: panelUsers.length,
        recordsOk: created + updated,
        recordsFailed: errors.length,
        result: {
          mode: input.mode,
          fetched: panelUsers.length,
          created,
          updated,
          skipped,
          errors,
        } satisfies Prisma.InputJsonValue,
        errorMessage: errors.length === 0 ? null : errors.slice(0, 5).join('; '),
        createdBy: input.createdBy,
        committedAt: new Date(),
      },
    });

    return {
      importRecordId: importRecord.id,
      fetched: panelUsers.length,
      created,
      updated,
      skipped,
      errors,
    };
  }
}
