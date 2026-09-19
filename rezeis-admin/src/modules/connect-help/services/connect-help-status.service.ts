import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { RawCacheService } from '../../../common/cache/raw-cache.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  ConnectSignalHealthService,
  type ConnectSignalHealth,
} from '../../connect-signal/services/connect-signal-health.service';
import { NotificationTemplatesService } from '../../notifications/services/notification-templates.service';
import type { LadderAttempt } from '../../notifications/services/user-notifications.service';
import { readPlatformBranding } from '../../settings/utils/platform-branding.util';
import {
  CONNECT_HELP_LAST_RESULT_KEY,
  CONNECT_HELP_LOG_MAX_PAGE,
  CONNECT_HELP_LOG_PAGE,
  CONNECT_HELP_TRIAL_TYPE,
  CONNECT_HELP_TYPE,
} from '../connect-help.constants';
import {
  connectHelpLogSql,
  type ConnectHelpLogFilter,
  type ConnectHelpLogRow,
} from '../connect-help.sql';
import type { ConnectHelpCycleResult } from './connect-help-sweep.service';

/** Whether a template of the help exists and is switched on. */
export type ConnectHelpTemplateState = 'active' | 'inactive' | 'missing';

/** `GET /admin/connect-help/status`. */
export interface ConnectHelpStatusView {
  /** The connection signal, as codes and numbers; the card words it. */
  readonly health: ConnectSignalHealth;
  /** The worker's last cycle, or `null` before the first one. */
  readonly lastCycle: ConnectHelpCycleResult | null;
  readonly templates: {
    readonly connect_help: ConnectHelpTemplateState;
    readonly connect_help_trial: ConnectHelpTemplateState;
  };
  /** The panel's zone for every time the card prints (`platformPolicy.timezone`, UTC when unset). */
  readonly timezone: string;
}

/** One decision in the operator's log. Instants are ISO strings. */
export interface ConnectHelpLogItem {
  readonly subscriptionId: string;
  readonly decidedAt: string;
  readonly kind: string | null;
  readonly anchorAt: string | null;
  /** `auto`, or `broadcast:<id>` for a subscription a broadcast reached first. */
  readonly source: string | null;
  /** `null` while the ladder has not finished (a deferred bot step). */
  readonly outcome: string | null;
  readonly attempts: readonly LadderAttempt[];
  readonly deferrals: number;
  readonly eventId: string | null;
  /** When the subscription connected after all, if it did. */
  readonly connectedAt: string | null;
  readonly user: {
    readonly id: string;
    readonly telegramId: string | null;
    readonly name: string | null;
    readonly username: string | null;
  };
  readonly planName: string | null;
  readonly subscriptionStatus: string;
}

export interface ConnectHelpLogPage {
  readonly items: readonly ConnectHelpLogItem[];
  readonly nextCursor: string | null;
  readonly timezone: string;
}

const CURSOR_SEPARATOR = '|';

/** An opaque cursor: the last row's decision time and subscription id. */
export function encodeLogCursor(decidedAt: Date, subscriptionId: string): string {
  return Buffer.from(`${decidedAt.toISOString()}${CURSOR_SEPARATOR}${subscriptionId}`, 'utf8').toString(
    'base64url',
  );
}

/** The cursor back, or a 400 — a cursor the client made up must not become SQL. */
export function decodeLogCursor(
  cursor: string,
): { readonly decidedAt: Date; readonly subscriptionId: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const at = decoded.indexOf(CURSOR_SEPARATOR);
  const decidedAt = at > 0 ? new Date(decoded.slice(0, at)) : new Date(Number.NaN);
  const subscriptionId = at > 0 ? decoded.slice(at + 1) : '';
  if (
    Number.isNaN(decidedAt.getTime()) ||
    decidedAt.toISOString() !== decoded.slice(0, at) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(subscriptionId)
  ) {
    throw new BadRequestException({
      code: 'CONNECT_HELP_LOG_CURSOR_INVALID',
      message: 'The log cursor is not one this endpoint issued',
    });
  }
  return { decidedAt, subscriptionId };
}

/** Only well-formed attempts leave the table: the column is JSON anyone with SQL could have edited. */
function readAttempts(value: unknown): LadderAttempt[] {
  if (!Array.isArray(value)) return [];
  const out: LadderAttempt[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const channel = record['channel'];
    if (channel !== 'bot' && channel !== 'push' && channel !== 'email') continue;
    if (typeof record['result'] !== 'string' || typeof record['at'] !== 'string') continue;
    out.push({
      channel,
      result: record['result'],
      at: record['at'],
      ...(typeof record['detail'] === 'string' ? { detail: record['detail'] } : {}),
    });
  }
  return out;
}

function toLogItem(row: ConnectHelpLogRow): ConnectHelpLogItem {
  return {
    subscriptionId: row.subscriptionId,
    decidedAt: row.decidedAt.toISOString(),
    kind: row.kind,
    anchorAt: row.anchorAt === null ? null : row.anchorAt.toISOString(),
    source: row.source,
    outcome: row.outcome,
    attempts: readAttempts(row.attempts),
    deferrals: Number(row.deferrals),
    eventId: row.eventId,
    connectedAt: row.firstConnectedAt === null ? null : row.firstConnectedAt.toISOString(),
    user: {
      id: row.userId,
      telegramId: row.telegramId === null ? null : row.telegramId.toString(),
      name: row.userName !== null && row.userName.length > 0 ? row.userName : null,
      username: row.username,
    },
    planName: row.planName,
    subscriptionStatus: row.subscriptionStatus,
  };
}

/**
 * What the «Помощь с подключением» card reads: the signal, the last cycle,
 * whether the two templates are on — and the log of every decision.
 */
@Injectable()
export class ConnectHelpStatusService {
  private readonly logger = new Logger(ConnectHelpStatusService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly health: ConnectSignalHealthService,
    private readonly rawCacheService: RawCacheService,
    private readonly templatesService: NotificationTemplatesService,
  ) {}

  public async status(now: Date = new Date()): Promise<ConnectHelpStatusView> {
    const [health, lastCycle, paid, trial, timezone] = await Promise.all([
      this.health.current(now),
      this.readLastCycle(),
      this.templateState(CONNECT_HELP_TYPE),
      this.templateState(CONNECT_HELP_TRIAL_TYPE),
      this.readTimezone(),
    ]);
    return {
      health,
      lastCycle,
      templates: { connect_help: paid, connect_help_trial: trial },
      timezone,
    };
  }

  public async log(query: {
    readonly cursor?: string;
    readonly outcome?: ConnectHelpLogFilter;
    readonly limit?: number;
  }): Promise<ConnectHelpLogPage> {
    const limit = Math.min(Math.max(query.limit ?? CONNECT_HELP_LOG_PAGE, 1), CONNECT_HELP_LOG_MAX_PAGE);
    const before =
      query.cursor === undefined || query.cursor.length === 0 ? null : decodeLogCursor(query.cursor);
    const [rows, timezone] = await Promise.all([
      this.prismaService.$queryRaw<ConnectHelpLogRow[]>(
        connectHelpLogSql({ before, filter: query.outcome ?? null, limit: limit + 1 }),
      ),
      this.readTimezone(),
    ]);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toLogItem),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeLogCursor(last.decidedAt, last.subscriptionId)
          : null,
      timezone,
    };
  }

  private async readLastCycle(): Promise<ConnectHelpCycleResult | null> {
    try {
      return await this.rawCacheService.get<ConnectHelpCycleResult>(CONNECT_HELP_LAST_RESULT_KEY);
    } catch (error) {
      this.logger.warn(`Could not read the last connect help cycle: ${(error as Error).message}`);
      return null;
    }
  }

  private async templateState(type: string): Promise<ConnectHelpTemplateState> {
    const template = await this.templatesService.getByType(type);
    if (template === null) return 'missing';
    return template.isActive ? 'active' : 'inactive';
  }

  /** The operator's zone; UTC when unset, as every other time the panel prints. */
  private async readTimezone(): Promise<string> {
    try {
      const row = await this.prismaService.settings.findFirst({
        orderBy: { id: 'asc' },
        select: { platformPolicy: true },
      });
      return readPlatformBranding(row?.platformPolicy ?? null).timezone ?? 'UTC';
    } catch {
      return 'UTC';
    }
  }
}
