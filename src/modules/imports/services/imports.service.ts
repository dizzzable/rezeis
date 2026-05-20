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
    return this.prismaService.importRecord.update({
      where: { id: importId },
      data: { status: ImportStatus.ROLLED_BACK, rolledBackAt: new Date() },
    });
  }
}
