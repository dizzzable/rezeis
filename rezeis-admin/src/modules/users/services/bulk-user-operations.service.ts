import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EVENT_TYPES,
  SystemEventsService,
} from '../../../common/services/system-events.service';

export type BulkUserAction = 'block' | 'unblock' | 'delete' | 'set_language' | 'set_max_subscriptions';

export interface BulkUserOperationInputInterface {
  readonly userIds: readonly string[];
  readonly action: BulkUserAction;
  /** Optional payload for parametric actions (e.g. set_language:'EN'). */
  readonly payload?: Record<string, unknown>;
  readonly adminId: string | null;
}

export interface BulkUserOperationItemResultInterface {
  readonly userId: string;
  readonly status: 'ok' | 'error' | 'skipped';
  readonly message?: string;
}

export interface BulkUserOperationResultInterface {
  readonly action: BulkUserAction;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly items: readonly BulkUserOperationItemResultInterface[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

const MAX_BATCH = 1_000;

/**
 * Executes admin-driven bulk operations against the `users` table.
 *
 * Design
 *   - Each row is processed individually so a partial failure doesn't
 *     break the whole batch (operators commonly mix valid/invalid IDs
 *     when copy-pasting from a spreadsheet).
 *   - Every successful mutation emits a SystemEvents notification —
 *     downstream subscribers (webhooks, telegram alerts, automations)
 *     react to bulk operations the same way as one-off admin actions.
 *   - We hard-cap the batch at `MAX_BATCH` to keep the JSON payload
 *     and DB write volume bounded.
 *
 * Backed by a single endpoint (`POST /admin/users/bulk`) — the UI
 * surfaces a checkbox column on the user search list and a
 * confirmation dialog with progress tracking.
 */
@Injectable()
export class BulkUserOperationsService {
  private readonly logger = new Logger(BulkUserOperationsService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly events: SystemEventsService,
  ) {}

  public async execute(input: BulkUserOperationInputInterface): Promise<BulkUserOperationResultInterface> {
    const startedAt = new Date();
    const ids = Array.from(new Set(input.userIds.filter((id) => typeof id === 'string' && id.length > 0)));
    if (ids.length === 0) {
      return emptyResult(input.action, startedAt);
    }
    if (ids.length > MAX_BATCH) {
      throw new Error(`Bulk operation exceeds the ${MAX_BATCH}-row limit`);
    }

    const items: BulkUserOperationItemResultInterface[] = [];
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const userId of ids) {
      try {
        const outcome = await this.dispatchOne(userId, input);
        items.push(outcome);
        if (outcome.status === 'ok') succeeded += 1;
        else if (outcome.status === 'skipped') skipped += 1;
        else failed += 1;
      } catch (err) {
        failed += 1;
        items.push({
          userId,
          status: 'error',
          message: (err as Error).message,
        });
      }
    }

    this.events.info(
      'system.bulk_users_executed',
      'SYSTEM',
      `Bulk user operation "${input.action}" executed (${succeeded}/${ids.length})`,
      {
        action: input.action,
        adminId: input.adminId,
        total: ids.length,
        succeeded,
        failed,
        skipped,
      },
    );

    return {
      action: input.action,
      total: ids.length,
      succeeded,
      failed,
      skipped,
      items,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }

  // ── Token resolution ────────────────────────────────────────────────────

  /**
   * Resolves an operator-supplied token to a canonical user.
   *
   * Accepts any of the identifiers an operator is likely to paste from a
   * spreadsheet / their own block-list:
   *   - canonical CUID (`user.id`)
   *   - numeric Telegram ID
   *   - email (case-insensitive)
   *   - web-cabinet login (case-insensitive, tolerant of a leading `@`)
   *
   * Returns `null` when nothing matches so the caller can mark the row as
   * `skipped` (not `error`) — a missing entry in a pasted list is expected.
   */
  private async resolveUser(
    token: string,
  ): Promise<{ id: string; telegramId: bigint | null; isBlocked: boolean } | null> {
    const trimmed = token.trim();
    if (trimmed.length === 0) return null;

    const numeric = /^\d{1,19}$/.test(trimmed);
    const handle = trimmed.replace(/^@+/, '');

    return this.prismaService.user.findFirst({
      where: {
        OR: [
          { id: trimmed },
          ...(numeric ? [{ telegramId: BigInt(trimmed) }] : []),
          { email: { equals: trimmed, mode: 'insensitive' as const } },
          ...(handle.length > 0
            ? [{ webAccount: { login: { equals: handle, mode: 'insensitive' as const } } }]
            : []),
        ],
      },
      select: { id: true, telegramId: true, isBlocked: true },
    });
  }

  // ── Per-row dispatch ────────────────────────────────────────────────────

  private async dispatchOne(
    token: string,
    input: BulkUserOperationInputInterface,
  ): Promise<BulkUserOperationItemResultInterface> {
    // The result item always reports the ORIGINAL token so operators can map
    // outcomes back to the exact list they pasted (CUID / TG ID / email / login).
    const userId = token;
    const user = await this.resolveUser(token);
    if (!user) {
      return { userId, status: 'skipped', message: 'User not found' };
    }

    switch (input.action) {
      case 'block':
        if (user.isBlocked) return { userId, status: 'skipped', message: 'Already blocked' };
        await this.prismaService.user.update({
          where: { id: user.id },
          data: { isBlocked: true },
        });
        this.events.warn(EVENT_TYPES.USER_BLOCKED, 'USER', `User bulk-blocked: ${user.id}`, {
          userId: user.id,
          telegramId: user.telegramId?.toString() ?? null,
          adminId: input.adminId,
          source: 'bulk',
        });
        return { userId, status: 'ok' };

      case 'unblock':
        if (!user.isBlocked) return { userId, status: 'skipped', message: 'Already unblocked' };
        await this.prismaService.user.update({
          where: { id: user.id },
          data: { isBlocked: false },
        });
        this.events.info(EVENT_TYPES.USER_UNBLOCKED, 'USER', `User bulk-unblocked: ${user.id}`, {
          userId: user.id,
          telegramId: user.telegramId?.toString() ?? null,
          adminId: input.adminId,
          source: 'bulk',
        });
        return { userId, status: 'ok' };

      case 'delete':
        await this.prismaService.user.delete({ where: { id: user.id } });
        this.events.warn(EVENT_TYPES.USER_DELETED, 'USER', `User bulk-deleted: ${user.id}`, {
          userId: user.id,
          telegramId: user.telegramId?.toString() ?? null,
          adminId: input.adminId,
          source: 'bulk',
        });
        return { userId, status: 'ok' };

      case 'set_language': {
        const lang = String(input.payload?.['language'] ?? '').toUpperCase();
        if (!lang || lang.length < 2 || lang.length > 4) {
          return { userId, status: 'skipped', message: 'Missing or invalid language' };
        }
        try {
          await this.prismaService.user.update({
            where: { id: user.id },
            data: { language: lang as never },
          });
          return { userId, status: 'ok' };
        } catch (err) {
          return { userId, status: 'error', message: (err as Error).message };
        }
      }

      case 'set_max_subscriptions': {
        const value = Number(input.payload?.['maxSubscriptions']);
        if (!Number.isFinite(value) || value < 1 || value > 50) {
          return { userId, status: 'skipped', message: 'maxSubscriptions must be 1..50' };
        }
        await this.prismaService.user.update({
          where: { id: user.id },
          data: { maxSubscriptions: Math.floor(value) },
        });
        return { userId, status: 'ok' };
      }

      default: {
        const exhaustive: never = input.action;
        return { userId, status: 'error', message: `Unknown action: ${String(exhaustive)}` };
      }
    }
  }
}

function emptyResult(action: BulkUserAction, startedAt: Date): BulkUserOperationResultInterface {
  return {
    action,
    total: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    items: [],
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  };
}
