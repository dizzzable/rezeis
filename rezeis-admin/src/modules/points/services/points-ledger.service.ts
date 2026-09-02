import { Injectable } from '@nestjs/common';
import { PointsLedgerSource, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

export interface PointsLedgerRow {
  readonly id: string;
  readonly delta: number;
  readonly balanceAfter: number;
  readonly source: PointsLedgerSource;
  readonly referenceKey: string | null;
  readonly details: Prisma.JsonValue | null;
  readonly createdAt: string;
}

export interface PointsLedgerPage {
  readonly items: readonly PointsLedgerRow[];
  /** The id to pass back for the next page; `null` when this was the last one. */
  readonly nextCursor: string | null;
}

export const POINTS_LEDGER_DEFAULT_LIMIT = 20;
export const POINTS_LEDGER_MAX_LIMIT = 100;

/**
 * Reads the points journal — the same rows for the operator's user card and
 * for the subscriber's own history; only the labels differ, and those are
 * the caller's.
 *
 * Keyset pagination on the row id: the list is ordered newest first by
 * `createdAt` with the id as the tie-break, and the cursor names the last
 * row the client holds. An offset would drift while new rows land on top —
 * a cashback arriving between two pages would show one row twice and hide
 * another — and the journal is exactly the list where that is noticed.
 */
@Injectable()
export class PointsLedgerService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async listForUser(input: {
    readonly userId: string;
    readonly cursor?: string | null;
    readonly limit?: number | null;
  }): Promise<PointsLedgerPage> {
    const limit = clampLimit(input.limit);
    const rows = await this.prismaService.pointsLedgerEntry.findMany({
      where: { userId: input.userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One more than asked: its presence is how "there is a next page" is
      // known without a second COUNT round trip.
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        delta: true,
        balanceAfter: true,
        source: true,
        referenceKey: true,
        details: true,
        createdAt: true,
      },
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((row) => ({
        id: row.id,
        delta: row.delta,
        balanceAfter: row.balanceAfter,
        source: row.source,
        referenceKey: row.referenceKey,
        details: row.details,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }
}

function clampLimit(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return POINTS_LEDGER_DEFAULT_LIMIT;
  return Math.min(POINTS_LEDGER_MAX_LIMIT, Math.max(1, Math.trunc(value)));
}
