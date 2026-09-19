import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  ConnectSignalHealthService,
  type ConnectSignalHealth,
  type ConnectSignalState,
} from '../../connect-signal/services/connect-signal-health.service';
import {
  CONNECT_BUCKETS,
  connectAudienceSql,
  markHelpedByBroadcastSql,
  type ConnectAudienceRow,
  type ConnectAudienceWindow,
  type ConnectBucket,
} from '../connect-audience.sql';

export { CONNECT_BUCKETS, type ConnectAudienceWindow, type ConnectBucket } from '../connect-audience.sql';

/**
 * The most people one resolution hands out. Above it the list is refused, not
 * truncated: a broadcast that silently reached "the first 20 000" would be a
 * different audience from the one the operator chose, and the ids travel as
 * one `IN (…)` list whose size PostgreSQL bounds (65 535 parameters).
 */
export const CONNECT_AUDIENCE_MAX_USERS = 20_000;

/** The design's sentence for that refusal (§2.3). */
export const CONNECT_AUDIENCE_TOO_LARGE_MESSAGE =
  'Слишком много получателей для фильтра «не подключился» — уменьшите срок';

/** «За последние, дней»: 1–30, the signal's own horizon; 7 when not said. */
export const CONNECT_AUDIENCE_MIN_DAYS = 1;
export const CONNECT_AUDIENCE_MAX_DAYS = 30;
export const CONNECT_AUDIENCE_DEFAULT_DAYS = 7;

/**
 * WHAT BOUNDS ONE RESOLUTION.
 *
 * The panel has no statement timeout of its own, and the broadcast preview is
 * answered inside the request that asked — which the panel cuts at 30 s. So
 * every statement here runs in an interactive transaction that first says
 * `SET LOCAL statement_timeout = '10s'` (it ends with the transaction), with
 * the `maxWait`/`timeout` pair `HintAudienceService` argues for: 10 s to get a
 * connection, 20 s for the whole transaction. A resolution therefore answers or
 * throws well inside the request's 30 s, never as a 408 with the query still
 * running behind it.
 */
export const CONNECT_AUDIENCE_STATEMENT_TIMEOUT = '10s';
export const CONNECT_AUDIENCE_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

/** The statement that bounds the rest of its transaction; a constant, since `SET` takes no bind parameters. */
const SET_STATEMENT_TIMEOUT = Prisma.raw(`SET LOCAL statement_timeout = '${CONNECT_AUDIENCE_STATEMENT_TIMEOUT}'`);

const DAY_MS = 24 * 60 * 60 * 1000;

/** What `userIds`, `counts` and `resolve` are asked. */
export interface ConnectAudienceQuery {
  readonly bucket: ConnectBucket;
  /** «За последние N дней», an integer 1–30 counted back from `now`. Ignored when `window` is given. */
  readonly withinDays?: number;
  /**
   * An explicit window instead — the hint audiences' `afterHours…beforeHours`
   * as `{ from: now − beforeHours, to: now − afterHours }`. The payment's
   * creation (paid) or the grant (trial) must fall in it, both ends inclusive.
   */
  readonly window?: ConnectAudienceWindow;
  /** Leave out subscriptions whose once-marker is set (helped automatically or by a broadcast). Default `true`. */
  readonly excludeHelped?: boolean;
  /** The clock: the verification's 24 hours and `withinDays` count back from it. Default: now. */
  readonly now?: Date;
}

/** People, not subscriptions: each counted once. */
export interface ConnectAudienceCounts {
  /** People with at least one subscription VERIFIED not connected — the ones a message reaches. */
  readonly verified: number;
  /** People in the bucket with no verified subscription and at least one not known to have connected. */
  readonly unverified: number;
  /** `ConnectSignalHealthService.current()`, as it is. */
  readonly health: ConnectSignalHealth;
}

export interface ConnectAudienceResolution extends ConnectAudienceCounts {
  /** The verified people, oldest anchor first; `null` when there are more than {@link limit}. */
  readonly userIds: readonly string[] | null;
  readonly limit: number;
}

/** More verified people than {@link CONNECT_AUDIENCE_MAX_USERS}. */
export class ConnectAudienceTooLargeError extends Error {
  public constructor(
    public readonly verified: number,
    public readonly limit: number = CONNECT_AUDIENCE_MAX_USERS,
  ) {
    super(CONNECT_AUDIENCE_TOO_LARGE_MESSAGE);
    this.name = 'ConnectAudienceTooLargeError';
  }
}

/**
 * PostgreSQL cancelled the statement at `statement_timeout` (SQLSTATE 57014).
 * Prisma 7's pg adapter reports it as P2010 with the code in
 * `meta.driverAdapterError.cause` — not as a code of its own.
 */
export function isStatementTimeout(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const meta = (error as { readonly meta?: unknown }).meta;
  const cause =
    meta !== null && typeof meta === 'object'
      ? ((meta as { readonly driverAdapterError?: { readonly cause?: Record<string, unknown> } }).driverAdapterError
          ?.cause ?? null)
      : null;
  if (cause !== null && (cause['originalCode'] === '57014' || cause['code'] === '57014')) return true;
  const message = (error as { readonly message?: unknown }).message;
  return typeof message === 'string' && message.includes('57014');
}

/** The window a query means, validated. A caller passing nonsense is a programming error. */
export function connectAudienceWindowOf(query: ConnectAudienceQuery, now: Date): ConnectAudienceWindow {
  if (query.window !== undefined) {
    const { from, to } = query.window;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from.getTime() > to.getTime()) {
      throw new RangeError('connect audience: the window must be two valid instants, from ≤ to');
    }
    return { from, to };
  }
  const days = query.withinDays ?? CONNECT_AUDIENCE_DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < CONNECT_AUDIENCE_MIN_DAYS || days > CONNECT_AUDIENCE_MAX_DAYS) {
    throw new RangeError(
      `connect audience: withinDays must be an integer ${CONNECT_AUDIENCE_MIN_DAYS}–${CONNECT_AUDIENCE_MAX_DAYS}, got ${String(days)}`,
    );
  }
  return { from: new Date(now.getTime() - days * DAY_MS), to: now };
}

function checkedBucket(bucket: unknown): ConnectBucket {
  if (!(CONNECT_BUCKETS as readonly unknown[]).includes(bucket)) {
    throw new RangeError(`connect audience: unknown bucket ${String(bucket)}`);
  }
  return bucket as ConnectBucket;
}

/** The part of the health an operator's screen may show: codes, instants and numbers — no free text. */
export interface ConnectAudienceHealthView {
  readonly state: ConnectSignalState;
  readonly checkedCoverage: number;
  readonly lastOkAt: string | null;
  readonly lastUserWebhookAt: string | null;
  /** Since when every probe cycle has failed; with `lastOkAt`, the «не отвечает с …» moment. */
  readonly failingSince: string | null;
  readonly coverage: ConnectSignalHealth['coverage'];
  /** Hours the probe's first pass still needs. */
  readonly firstPassHours: number;
}

export function connectAudienceHealthView(health: ConnectSignalHealth): ConnectAudienceHealthView {
  return {
    state: health.state,
    checkedCoverage: health.checkedCoverage,
    lastOkAt: health.lastOkAt,
    lastUserWebhookAt: health.lastUserWebhookAt,
    failingSince: health.probe.failingSince,
    coverage: health.coverage,
    firstPassHours: health.probe.firstPassHours,
  };
}

/**
 * «КУПИЛ, НО НЕ ПОДКЛЮЧИЛСЯ» — WHO, AS PEOPLE.
 *
 * The one place that turns WP4a's per-subscription signal into lists and
 * counts of people: the broadcast filter «Подключение VPN» (preview and
 * staging) and the hint audiences. The definitions live in
 * `connect-audience.sql.ts`, composed from `connect-signal/connect-sql.ts`.
 *
 * Nothing here ever counts the UNKNOWN as "not connected": a person is in the
 * list only when a successful read after their purchase (or grant), at most a
 * day old, found the profile never connected. Everyone else in the bucket is a
 * separate number, and that number is who a message will NOT reach.
 */
@Injectable()
export class ConnectAudienceService {
  private readonly logger = new Logger(ConnectAudienceService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly connectSignalHealthService: ConnectSignalHealthService,
  ) {}

  /**
   * The verified people, oldest anchor first (the longest waiting lead, so a
   * caller that takes a prefix takes them). Throws
   * {@link ConnectAudienceTooLargeError} above {@link CONNECT_AUDIENCE_MAX_USERS}.
   */
  public async userIds(query: ConnectAudienceQuery): Promise<string[]> {
    const read = await this.read(query, CONNECT_AUDIENCE_MAX_USERS + 1);
    if (read.userIds.length > CONNECT_AUDIENCE_MAX_USERS) {
      throw new ConnectAudienceTooLargeError(read.verified);
    }
    return read.userIds;
  }

  /** The signal's health alone — `ConnectSignalHealthService.current()`, reused for a minute. */
  public health(now?: Date): Promise<ConnectSignalHealth> {
    return this.connectSignalHealthService.current(now);
  }

  /** The two person counts and the signal's health; no list. */
  public async counts(query: ConnectAudienceQuery): Promise<ConnectAudienceCounts> {
    const [read, health] = await Promise.all([
      this.read(query, 0),
      this.connectSignalHealthService.current(query.now),
    ]);
    return { verified: read.verified, unverified: read.unverified, health };
  }

  /**
   * The list, the counts and the health from ONE pass over the bucket — what
   * the broadcast preview needs. Never throws for size: over the cap the list
   * is `null` and the counts are still exact.
   */
  public async resolve(query: ConnectAudienceQuery): Promise<ConnectAudienceResolution> {
    const [read, health] = await Promise.all([
      this.read(query, CONNECT_AUDIENCE_MAX_USERS + 1),
      this.connectSignalHealthService.current(query.now),
    ]);
    return {
      userIds: read.userIds.length > CONNECT_AUDIENCE_MAX_USERS ? null : read.userIds,
      verified: read.verified,
      unverified: read.unverified,
      health,
      limit: CONNECT_AUDIENCE_MAX_USERS,
    };
  }

  /**
   * THE ONCE-MARKER FOR A STAGED BROADCAST (§2.3).
   *
   * Marks the subscriptions of `userIds` — the broadcast's recipients, never
   * the whole bucket: a customer the operator's other chips left out received
   * nothing and must stay open to the automatic help — that are in the bucket
   * and verified not connected at `query.now`. Only where the marker is unset,
   * so re-staging is a no-op and neither this nor the automatic sender ever
   * overwrites the other. Emits nothing: `subscription.not_connected` is the
   * automatic moment's alone.
   *
   * `client` runs it inside the caller's transaction — staging writes the
   * recipient rows and the markers together, both or neither. Returns how many
   * subscriptions were marked.
   */
  public async markHelpedByBroadcast(
    broadcastId: string,
    query: ConnectAudienceQuery,
    options: { readonly userIds: readonly string[]; readonly client?: Prisma.TransactionClient },
  ): Promise<number> {
    if (options.userIds.length === 0) return 0;
    const now = query.now ?? new Date();
    const statement = markHelpedByBroadcastSql({
      broadcastId,
      bucket: checkedBucket(query.bucket),
      window: connectAudienceWindowOf(query, now),
      now,
      userIds: options.userIds,
    });
    const run = async (tx: Prisma.TransactionClient): Promise<number> => {
      await tx.$executeRaw(SET_STATEMENT_TIMEOUT);
      const rows = await tx.$queryRaw<Array<{ readonly subscriptionId: string }>>(statement);
      return rows.length;
    };
    const marked =
      options.client === undefined
        ? await this.prismaService.$transaction(run, CONNECT_AUDIENCE_TRANSACTION_OPTIONS)
        : await run(options.client);
    this.logger.log(
      `connect-audience: broadcast ${broadcastId} marked ${marked} subscription(s) helped (${query.bucket})`,
    );
    return marked;
  }

  private async read(
    query: ConnectAudienceQuery,
    idLimit: number,
  ): Promise<{ readonly userIds: string[]; readonly verified: number; readonly unverified: number }> {
    const now = query.now ?? new Date();
    const statement = connectAudienceSql({
      bucket: checkedBucket(query.bucket),
      window: connectAudienceWindowOf(query, now),
      now,
      excludeHelped: query.excludeHelped !== false,
      idLimit,
    });
    const rows = await this.prismaService.$transaction(async (tx) => {
      // The timeout is `SET LOCAL`: it ends with this transaction and never
      // leaks into the pool's next borrower.
      await tx.$executeRaw(SET_STATEMENT_TIMEOUT);
      return tx.$queryRaw<ConnectAudienceRow[]>(statement);
    }, CONNECT_AUDIENCE_TRANSACTION_OPTIONS);
    const userIds: string[] = [];
    let verified = 0;
    let unverified = 0;
    for (const row of rows) {
      if (row.userId !== null) {
        userIds.push(row.userId);
      } else {
        verified = Number(row.verified ?? 0);
        unverified = Number(row.unverified ?? 0);
      }
    }
    return { userIds, verified, unverified };
  }
}
