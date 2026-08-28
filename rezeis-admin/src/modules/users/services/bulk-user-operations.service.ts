import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildAdminAuditLogData } from '../../../common/utils/admin-audit-log.util';
import { parseTelegramId } from '../../../common/utils/postgres-bigint.util';
import {
  EVENT_TYPES,
  SystemEventsService,
} from '../../../common/services/system-events.service';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { UserBlockService } from './user-block.service';
import { UserDeletionService } from './user-deletion.service';

export type BulkUserAction = 'block' | 'unblock' | 'delete' | 'set_language' | 'set_max_subscriptions';

export interface BulkUserOperationInputInterface {
  readonly userIds: readonly string[];
  readonly action: BulkUserAction;
  /** Optional payload for parametric actions (e.g. set_language:'EN'). */
  readonly payload?: Record<string, unknown>;
  /**
   * The operator, not merely their id. `adminId: string | null` used to sit
   * here; the null was never reachable — the one caller is behind
   * `AdminJwtAuthGuard` — but a nullable actor makes an audit write carry a
   * branch for a case that cannot happen, and an unreachable branch on an audit
   * path is how an audit path stops being written.
   */
  readonly currentAdmin: CurrentAdminInterface;
  /** ip / user-agent / request id, for the audit rows this run writes. */
  readonly requestMetadata: RequestMetadataInterface;
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
 * A bulk run leaves ONE AUDIT ROW PER AFFECTED USER, under the SAME action name
 * the single-user route writes, with the origin in `metadata.source`.
 *
 * There was no `adminAuditLog` write in this file at all. Deleting one account
 * from the user card wrote `user.deleted`; deleting a thousand from the bulk
 * toolbar wrote zero rows — only system events, tagged `source: 'bulk'`. The
 * deletion itself was already converged (both call
 * `UserDeletionService.deleteUser`); only the operator record diverged, and the
 * shipped `operator` role holds `users:bulk_operations`.
 *
 * ── Why per user, and not one row naming the set ─────────────────────────────
 *
 * The question this log is asked is "who deleted THIS account", and it is asked
 * about ONE user. `AdminAuditLog` has no entity columns — the subject lives in
 * `metadata` — so the per-user answer is
 *
 *   SELECT ... WHERE action = 'user.deleted' AND metadata->>'userId' = $1
 *
 * and that query has to find the bulk deletion too, or it answers "nobody"
 * about an account a bulk click removed. One row naming the whole set answers
 * "which click did this" cheaply and the per-user question not at all without a
 * second, differently-shaped query (`metadata->'userIds' @> '["X"]'`) unioned
 * in — and a reader that has to remember to union a second shape is a reader
 * that will eventually forget. Same reasoning that put the origin of
 * `partner.balance.adjusted` in `metadata.source` rather than in a second
 * action name.
 *
 * `metadata.batchId` recovers the grouping the single-row shape would have
 * given, without the second shape: every row of one run carries it, and so does
 * the run's summary event. It is generated here rather than taken from
 * `requestId`, which is a client header and is null more often than not.
 *
 * The cost is real and bounded — at most `MAX_BATCH` rows per click — and it is
 * already precedented in this file, which emits one system event per affected
 * user for exactly the same reason.
 *
 * `set_language` and `set_max_subscriptions` were left out of the first pass
 * because their single-user counterpart is `user.profile.updated`, which keys
 * on a `changes` array rather than on a per-field action name. That is now
 * resolved the only way that keeps ONE query answering "who changed this user":
 * both bulk actions write `user.profile.updated` with the same `changes` array
 * the user card writes, so a search by action and `metadata.userId` finds the
 * card edit and the toolbar edit together. The new value is carried alongside,
 * which the card does not do — an audit row that names the field but not what
 * it became answers half the question, and there was no reason to copy that.
 *
 * `language` still has no single-user route. The action name is chosen to be
 * the one that route WOULD use, so adding it later needs no migration of rows
 * already written.
 */
const BULK_AUDIT_ACTION = {
  block: 'user.blocked',
  unblock: 'user.unblocked',
  delete: 'user.deleted',
  set_language: 'user.profile.updated',
  set_max_subscriptions: 'user.profile.updated',
} as const;

/** Which surface performed the mutation — see {@link BULK_AUDIT_ACTION}. */
const BULK_AUDIT_SOURCE = 'bulk';

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
    private readonly userDeletionService: UserDeletionService,
    private readonly userBlockService: UserBlockService,
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

    // Groups every row and every event this one click produces. See the note on
    // {@link BULK_AUDIT_ACTION} for why the grouping lives here and not in a
    // single set-shaped audit row.
    const batchId = randomUUID();

    const items: BulkUserOperationItemResultInterface[] = [];
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const userId of ids) {
      try {
        const outcome = await this.dispatchOne(userId, input, batchId);
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
      EVENT_TYPES.SYSTEM_BULK_USERS_EXECUTED,
      'SYSTEM',
      `Bulk user operation "${input.action}" executed (${succeeded}/${ids.length})`,
      {
        action: input.action,
        adminId: input.currentAdmin.id,
        batchId,
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

    // The old gate was `^\d{1,19}$`, which reads like a range check and is not
    // one: `9999999999999999999` is nineteen digits and still larger than
    // Postgres `int8`. It was bound anyway and Postgres answered `22003 numeric
    // field value out of range`, failing the WHOLE bulk run on one bad row in a
    // pasted list — the opposite of the per-row `skipped` this method promises.
    // Dropping the branch is not a narrowing: no row's `telegramId` can equal a
    // value the column cannot store, and the id / email / login branches below
    // still run.
    const telegramId = parseTelegramId(trimmed);
    const handle = trimmed.replace(/^@+/, '');

    return this.prismaService.user.findFirst({
      where: {
        OR: [
          { id: trimmed },
          ...(telegramId !== null ? [{ telegramId }] : []),
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
    batchId: string,
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
        // The same act as the user card performs, through the same service.
        // Two inline `is_blocked` updates is exactly how the two screens came
        // to disagree about what a ban does.
        await this.userBlockService.block({
          userId: user.id,
          adminId: input.currentAdmin.id,
        });
        await this.recordOperatorRow(BULK_AUDIT_ACTION.block, input, batchId, user);
        this.events.warn(EVENT_TYPES.USER_BLOCKED, 'USER', `User bulk-blocked: ${user.id}`, {
          userId: user.id,
          telegramId: user.telegramId?.toString() ?? null,
          adminId: input.currentAdmin.id,
          batchId,
          source: BULK_AUDIT_SOURCE,
        });
        return { userId, status: 'ok' };

      case 'unblock':
        if (!user.isBlocked) return { userId, status: 'skipped', message: 'Already unblocked' };
        await this.userBlockService.unblock({
          userId: user.id,
          adminId: input.currentAdmin.id,
        });
        await this.recordOperatorRow(BULK_AUDIT_ACTION.unblock, input, batchId, user);
        this.events.info(EVENT_TYPES.USER_UNBLOCKED, 'USER', `User bulk-unblocked: ${user.id}`, {
          userId: user.id,
          telegramId: user.telegramId?.toString() ?? null,
          adminId: input.currentAdmin.id,
          batchId,
          source: BULK_AUDIT_SOURCE,
        });
        return { userId, status: 'ok' };

      case 'delete':
        // The audit row goes AFTER the deletion boundary returns, never before:
        // a row for a deletion that threw would answer "who deleted this" about
        // an account that is still there. A row that is never written for a
        // deletion that landed is the defect this whole block exists to fix, so
        // the ordering is one way round only.
        await this.userDeletionService.deleteUser(user.id);
        await this.recordOperatorRow(BULK_AUDIT_ACTION.delete, input, batchId, user);
        this.events.warn(EVENT_TYPES.USER_DELETED, 'USER', 'User account deleted', {
          userId: user.id,
          telegramId: user.telegramId?.toString() ?? null,
          adminId: input.currentAdmin.id,
          batchId,
          source: BULK_AUDIT_SOURCE,
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
          // AFTER the update, like every other branch here: the log records
          // what was done, so a throw above leaves nothing behind.
          await this.recordOperatorRow(BULK_AUDIT_ACTION.set_language, input, batchId, user, {
            changes: ['language'],
            language: lang,
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
        const maxSubscriptions = Math.floor(value);
        await this.prismaService.user.update({
          where: { id: user.id },
          data: { maxSubscriptions },
        });
        await this.recordOperatorRow(
          BULK_AUDIT_ACTION.set_max_subscriptions,
          input,
          batchId,
          user,
          { changes: ['maxSubscriptions'], maxSubscriptions },
        );
        return { userId, status: 'ok' };
      }

      default: {
        const exhaustive: never = input.action;
        return { userId, status: 'error', message: `Unknown action: ${String(exhaustive)}` };
      }
    }
  }

  /**
   * The operator record for ONE user this run actually changed.
   *
   * Called only from a branch that has already mutated the row, so a skipped
   * row (already blocked, nothing resolved) and a failed row leave nothing
   * behind: the log records what was DONE. What was attempted is in the
   * response body and in the run's summary event.
   */
  private async recordOperatorRow(
    action: string,
    input: BulkUserOperationInputInterface,
    batchId: string,
    user: { readonly id: string; readonly telegramId: bigint | null },
    /**
     * Extra metadata for actions whose single-user counterpart carries more
     * than the subject id — `user.profile.updated` and its `changes` array.
     * Spread LAST would let a caller overwrite `userId` or `source` and break
     * the one query this whole block exists to answer, so it is spread FIRST
     * and the fixed keys win.
     */
    extraMetadata: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.prismaService.adminAuditLog.create({
      data: buildAdminAuditLogData({
        action,
        actorId: input.currentAdmin.id,
        requestMetadata: input.requestMetadata,
        metadata: {
          ...extraMetadata,
          requestId: input.requestMetadata.requestId,
          source: BULK_AUDIT_SOURCE,
          batchId,
          userId: user.id,
          telegramId: user.telegramId?.toString() ?? null,
        },
      }),
    });
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
