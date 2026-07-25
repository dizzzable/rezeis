import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ImportStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

interface CreateDryRunInput {
  readonly filename: string;
  readonly sourceType: string;
  readonly createdBy: string;
  readonly result: Record<string, unknown>;
  readonly recordsTotal: number;
  readonly recordsOk: number;
  readonly recordsFailed: number;
}

/**
 * Imports module — donor: altshop `src/services/importer.py`.
 *
 * Lifecycle: DRAFT → DRY_RUN → COMMITTED | ROLLED_BACK | FAILED.
 * The service persists import metadata and dry-run results. Actual data
 * mutation (user creation, subscription provisioning) is handled by
 * dedicated commit executors that will be added in later slices.
 */
@Injectable()
export class ImportsService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async list(input: { readonly limit?: number; readonly offset?: number }) {
    return this.prismaService.importRecord.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit ?? 50,
      skip: input.offset ?? 0,
    });
  }

  public async getById(importId: string) {
    const record = await this.prismaService.importRecord.findUnique({
      where: { id: importId },
    });
    if (record === null) {
      throw new NotFoundException('Import record not found');
    }
    return record;
  }

  public async createDryRun(input: CreateDryRunInput) {
    return this.prismaService.importRecord.create({
      data: {
        filename: input.filename,
        sourceType: input.sourceType,
        status: ImportStatus.DRY_RUN,
        recordsTotal: input.recordsTotal,
        recordsOk: input.recordsOk,
        recordsFailed: input.recordsFailed,
        result: input.result as Prisma.InputJsonValue,
        createdBy: input.createdBy,
      },
    });
  }

  public async commit(importId: string) {
    const record = await this.getById(importId);
    if (record.status !== ImportStatus.DRY_RUN) {
      throw new BadRequestException('Only DRY_RUN imports can be committed');
    }
    return this.prismaService.importRecord.update({
      where: { id: importId },
      data: { status: ImportStatus.COMMITTED, committedAt: new Date() },
    });
  }

  public async rollback(importId: string) {
    const record = await this.getById(importId);
    if (record.status !== ImportStatus.COMMITTED) {
      throw new BadRequestException('Only COMMITTED imports can be rolled back');
    }
    const createdUserIds = extractCreatedUserIds(record.result);
    if (createdUserIds === null) {
      throw new BadRequestException(
        'This import has no rollback plan (it predates undo support), so it cannot be safely undone.',
      );
    }
    if (hasMatchedWrites(record.result)) {
      throw new BadRequestException(
        'Rollback blocked: this import changed matched existing users, whose previous state cannot be restored safely.',
      );
    }

    // Delete in one transaction. `Transaction.user` is `onDelete: Restrict`,
    // so a created user that carries imported transactions can't be removed
    // until those transactions are gone — delete them first (their line items
    // cascade), then the users. Subscriptions, web accounts, profile-sync
    // jobs, referrals and partner rows all cascade from `User`.
    //
    // Remnawave panel profiles are intentionally left untouched: they are the
    // SOURCE of the import (the backup/panel we read from), not data this
    // import created — deleting them would destroy the operator's real panel.
    // Only users this run CREATED are removed; users it merely matched and
    // UPDATED are left as-is (we keep no pre-import snapshot to restore).
    let deletedUsers = 0;
    if (createdUserIds.length > 0) {
      await this.prismaService.$transaction(async (tx) => {
        // Rollback is a migration recovery tool, not a way to erase a real
        // customer account after it started using the new system. Historical
        // transactions retain their donor timestamp, so anything newer than
        // this run's commit is live activity and blocks the destructive path.
        const laterTransactions = await tx.transaction.count({
          where: {
            userId: { in: createdUserIds },
            createdAt: { gt: record.committedAt ?? record.createdAt },
          },
        });
        if (laterTransactions > 0) {
          throw new BadRequestException(
            'Rollback blocked: imported users have newer payment activity. Resolve them manually instead.',
          );
        }
        await tx.transaction.deleteMany({ where: { userId: { in: createdUserIds } } });
        const deleted = await tx.user.deleteMany({ where: { id: { in: createdUserIds } } });
        deletedUsers = deleted.count;
      });
    }

    return this.prismaService.importRecord.update({
      where: { id: importId },
      data: {
        status: ImportStatus.ROLLED_BACK,
        rolledBackAt: new Date(),
        result: mergeRollbackOutcome(record.result, deletedUsers) as Prisma.InputJsonValue,
      },
    });
  }
}

/**
 * Read `result.rollback.createdUserIds` back out of the persisted JSON.
 * Returns `null` when no rollback plan was recorded (imports created before
 * undo support) so the caller can refuse rather than silently no-op.
 */
function extractCreatedUserIds(result: unknown): string[] | null {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;
  const rollback = (result as Record<string, unknown>).rollback;
  if (rollback === null || typeof rollback !== 'object' || Array.isArray(rollback)) return null;
  const ids = (rollback as Record<string, unknown>).createdUserIds;
  if (!Array.isArray(ids)) return null;
  return ids.filter((id): id is string => typeof id === 'string');
}

/** A conservative fail-closed marker written by importers that touched an
 * existing account. New-user-only imports retain the normal recovery path. */
function hasMatchedWrites(result: unknown): boolean {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return false;
  const rollback = (result as Record<string, unknown>).rollback;
  return (
    rollback !== null &&
    typeof rollback === 'object' &&
    !Array.isArray(rollback) &&
    (rollback as Record<string, unknown>).hasMatchedWrites === true
  );
}

/** Annotate the stored result with the rollback outcome for the audit trail. */
function mergeRollbackOutcome(result: unknown, deletedUsers: number): Record<string, unknown> {
  const base =
    result !== null && typeof result === 'object' && !Array.isArray(result)
      ? { ...(result as Record<string, unknown>) }
      : {};
  const rollback =
    base.rollback !== null && typeof base.rollback === 'object' && !Array.isArray(base.rollback)
      ? { ...(base.rollback as Record<string, unknown>) }
      : {};
  rollback.deletedUsers = deletedUsers;
  rollback.rolledBackAt = new Date().toISOString();
  base.rollback = rollback;
  return base;
}
