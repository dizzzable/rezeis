import { Injectable } from '@nestjs/common';
import { BotBanner } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { BotBannerUploadService } from './bot-banner-upload.service';

export interface BotBannerView {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

interface CreateFromUploadInput {
  readonly buffer: Buffer;
  readonly originalName: string;
  readonly mimeType: string;
  /** Operator-facing label; falls back to the original file name. */
  readonly name?: string;
}

/**
 * BotBannerService
 * ────────────────
 * CRUD over the reusable banner library (`bot_banners`). An upload writes the
 * file via {@link BotBannerUploadService} (validated type/size, stored under
 * `/uploads/bot-banners/`) and records a library row so the operator can
 * reuse the same banner across screens / notifications without re-uploading.
 *
 * Pure mapping (`toView`) is exposed so the controller never leaks the Prisma
 * row shape. Deleting a row only removes the library entry — nodes still
 * referencing the URL keep rendering it until reassigned.
 */
@Injectable()
export class BotBannerService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly uploadService: BotBannerUploadService,
  ) {}

  public async listAll(): Promise<readonly BotBannerView[]> {
    const rows = await this.prismaService.botBanner.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map(toView);
  }

  public async createFromUpload(input: CreateFromUploadInput): Promise<BotBannerView> {
    const persisted = await this.uploadService.persist({
      buffer: input.buffer,
      originalName: input.originalName,
      mimeType: input.mimeType,
    });
    const name = (input.name ?? persisted.originalName).trim().slice(0, 120) || 'Banner';
    const row = await this.prismaService.botBanner.create({
      data: {
        name,
        url: persisted.url,
        mimeType: persisted.mimeType,
        sizeBytes: persisted.size,
      },
    });
    return toView(row);
  }

  public async delete(id: string): Promise<void> {
    await this.prismaService.botBanner.deleteMany({ where: { id } });
  }
}

export function toView(row: BotBanner): BotBannerView {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}
