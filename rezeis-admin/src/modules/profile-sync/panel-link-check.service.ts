import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, SubscriptionStatus } from '@prisma/client';

import { RawCacheService } from '../../common/cache/raw-cache.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../common/runtime/process-role.util';
import { EVENT_TYPES, SystemEventsService } from '../../common/services/system-events.service';
import { isNumericPanelIdentity } from '../remnawave/services/panel-user-address';
import type {
  ExtraProfile,
  ExtraProfileCustomer,
  ExtraProfilesResponse,
  PanelLinkCheckStatus,
  PanelLinkCheckTrigger,
  SubscriptionWithoutLink,
  UnlinkedReasonCode,
  UnlinkedSubscriptionRow,
  UnlinkedSubscriptionsResponse,
} from './panel-link-check.types';
import {
  PANEL_LINK_POPULATION_SQL,
  PanelLinkReconciliationService,
  type PanelLinkReconciliationReport,
  type PanelLinkReconciliationRow,
  type PanelLinkRowReason,
} from './panel-link-reconciliation.service';
import {
  PanelProfileComparisonService,
  type PanelProfileComparison,
} from './panel-profile-comparison.service';

/**
 * Redis keys. Colons are fine here — the BullMQ rule about `:` in job ids
 * (memory `bullmq-custom-job-id-colon-rule`) does not apply: this check queues
 * no BullMQ job at all.
 */
export const PANEL_LINK_CHECK_KEYS = {
  /** Held for the length of one pass, on every process: the single-flight. */
  lock: 'panel-link-check:lock',
  /** When the check last ran, how that ended, when it runs next, where the walk continues. */
  state: 'panel-link-check:state',
  /** Backup imports that finished and still wait for their pass (and card). */
  requests: 'panel-link-check:requests',
  /** Why each row the walk could not prove was not proven. */
  verdicts: 'panel-link-check:verdicts',
  /** The last per-customer comparison. */
  comparison: 'panel-link-check:comparison',
} as const;

/**
 * The lock outlives the longest pass (walk budget + one whole-panel read) with
 * room to spare, and expires by itself if the process holding it dies — the
 * next tick after that takes it over.
 */
export const PANEL_LINK_CHECK_LOCK_TTL_SECONDS = 45 * 60;
/** "An hour later for what it could not finish" (owner, 24.09.2026). */
export const PANEL_LINK_CHECK_RETRY_MS = 60 * 60 * 1000;
/** The comparison runs at least once a day; so does the walk with it. */
export const PANEL_LINK_CHECK_DAILY_MS = 24 * 60 * 60 * 1000;
/** Rows one pass may ask the panel about (two calls each). The rest waits for the retry. */
export const PANEL_LINK_CHECK_WALK_LIMIT = 200;
/** Wall-clock budget of one pass's walk. */
export const PANEL_LINK_CHECK_WALK_BUDGET_MS = 10 * 60 * 1000;
/** Rows the operator's list shows. `total` still counts them all. */
export const PANEL_LINK_CHECK_LIST_LIMIT = 500;
/** How many per-row reasons are kept; the oldest go first. */
const VERDICT_CAP = 5000;
const STORED_TTL_SECONDS = 30 * 24 * 60 * 60;
const REQUEST_TTL_SECONDS = 2 * 24 * 60 * 60;
/** At most this many import requests wait at once; older ones are folded into the next pass anyway. */
const MAX_PENDING_IMPORTS = 20;

/**
 * The backup importers that WRITE `remnawave_id` — Remnashop, Altshop,
 * Bedolaga, STEALTHNET — and «Импорт из Remnawave». The 3x-ui importer does not:
 * it provisions through ordinary CREATE jobs, which link as they go.
 */
export const IMPORT_SOURCES_THAT_LINK: ReadonlySet<string> = new Set([
  'remnawave',
  'remnashop',
  'altshop',
  'stealthnet',
  'bedolaga',
]);

/** The donor, as the operator's pages name it. */
const IMPORT_SOURCE_NAMES: Readonly<Record<string, string>> = {
  remnawave: 'Remnawave',
  remnashop: 'Remnashop',
  altshop: 'Altshop',
  stealthnet: 'StealthNet',
  bedolaga: 'Bedolaga',
};

export type PanelLinkCheckTickOutcome = 'skipped' | 'idle' | 'busy' | 'ran' | 'failed';

interface PanelLinkCheckState {
  readonly lastRunAt: string | null;
  readonly lastRunTrigger: PanelLinkCheckTrigger | null;
  readonly lastRunOutcome: 'complete' | 'incomplete' | null;
  readonly nextRetryAt: string | null;
  /** Where the next pass's walk continues; `null` = from the start. */
  readonly walkCursor: string | null;
}

const EMPTY_STATE: PanelLinkCheckState = {
  lastRunAt: null,
  lastRunTrigger: null,
  lastRunOutcome: null,
  nextRetryAt: null,
  walkCursor: null,
};

interface ImportRequest {
  readonly importRecordId: string;
  readonly sourceType: string;
  readonly requestedAt: string;
}

interface StoredVerdict {
  readonly reason: UnlinkedReasonCode;
  readonly profileId: string | null;
  readonly otherSubscriptionId: string | null;
  readonly otherUserId: string | null;
  readonly lookedUpBy: 'shortUuid' | 'username' | null;
  readonly checkedAt: string;
}

/** The comparison as it is kept: the audit's `links` stay out of Redis. */
type StoredComparison = Omit<PanelProfileComparison, 'links'>;

/** The walk's reason codes, as the operator's list names them. */
const UNLINKED_REASON: Readonly<Record<PanelLinkRowReason, UnlinkedReasonCode>> = {
  noRoute: 'noRoute',
  notFound: 'notFound',
  panelUnavailable: 'panelUnavailable',
  profileGone: 'profileUnreadable',
  ownedByOther: 'ownedByOther',
  noOwnerProof: 'noOwnerProof',
  markedForOtherSubscription: 'markedForOtherSubscription',
  profileTaken: 'profileTaken',
  duplicatePair: 'duplicatePair',
  raceLost: 'changedDuringCheck',
  panelAgrees: 'panelAgrees',
};

interface PopulationRow {
  readonly id: string;
  readonly userId: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly remnawaveId: string | null;
  readonly planName: string | null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function readState(raw: unknown): PanelLinkCheckState {
  if (raw === null || typeof raw !== 'object') return EMPTY_STATE;
  const record = raw as Record<string, unknown>;
  const trigger = record['lastRunTrigger'];
  const outcome = record['lastRunOutcome'];
  return {
    lastRunAt: isoOrNull(record['lastRunAt']),
    lastRunTrigger:
      trigger === 'boot' || trigger === 'import' || trigger === 'retry' || trigger === 'daily' ? trigger : null,
    lastRunOutcome: outcome === 'complete' || outcome === 'incomplete' ? outcome : null,
    nextRetryAt: isoOrNull(record['nextRetryAt']),
    walkCursor: typeof record['walkCursor'] === 'string' && record['walkCursor'].length > 0 ? record['walkCursor'] : null,
  };
}

function readImportRequests(raw: unknown): ImportRequest[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ImportRequest =>
      entry !== null &&
      typeof entry === 'object' &&
      typeof (entry as ImportRequest).importRecordId === 'string' &&
      typeof (entry as ImportRequest).sourceType === 'string',
  );
}

/**
 * PanelLinkCheckService
 * ─────────────────────
 * «Починка привязки к панели» without the button (owner's decision,
 * 24.09.2026): the panel-link walk (`PanelLinkReconciliationService`) and the
 * per-customer comparison (`PanelProfileComparisonService`) run BY THEMSELVES,
 * and what they could not prove is listed in «Подписки» → «Инструменты».
 *
 * ── WHEN ──────────────────────────────────────────────────────────────────
 *
 *  • at worker boot, not awaited — boot never waits on Redis, the database or
 *    Remnawave;
 *  • after every backup import that writes links (Remnashop, Altshop,
 *    Bedolaga, STEALTHNET, «Импорт из Remnawave»): the import only RECORDS a
 *    request (`requestAfterImport`, on whichever process ran it), the worker's
 *    next minute runs the pass and sends one card with what is left;
 *  • an hour after a pass that could not finish — Remnawave did not answer, the
 *    walk hit its cap or its time budget, Remnawave's list could not be read;
 *  • once a day.
 * One `@Cron` a minute decides which of those is due; on the API process
 * (`RUID_PROCESS_ROLE=api`) it and the boot hook do nothing
 * (`shouldRunSchedules`, the precedent of `EntitlementCutoverJobService`).
 *
 * ── NEVER TWO AT ONCE ─────────────────────────────────────────────────────
 *
 * In one process a flag; across processes a Redis lock (`SET NX EX`,
 * {@link PANEL_LINK_CHECK_LOCK_TTL_SECONDS}), released at the end of the pass
 * and expiring by itself if the holder dies. A pass that finds the lock taken
 * does nothing and leaves the import requests where they are, so the holder's
 * next tick — or the next worker's — picks them up.
 *
 * ── BOUNDED ───────────────────────────────────────────────────────────────
 *
 * The walk asks the panel about at most {@link PANEL_LINK_CHECK_WALK_LIMIT} rows
 * a pass within {@link PANEL_LINK_CHECK_WALK_BUDGET_MS}, continues where it
 * stopped on the next pass, and stops at the first read the panel could not
 * answer. The comparison reads the whole list once a pass through the keyset
 * user stream (500 a page, 50 pages at most). A failed read ends that part
 * quietly and schedules the retry.
 *
 * ── WHERE THE RESULT LIVES, AND WHY NOT A TABLE ───────────────────────────
 *
 * No schema change (owner). The operator's lists are READ FROM THE DATABASE —
 * the rows that are without a proven link now, and each customer's
 * subscriptions without one now — and only what the database cannot know comes
 * from Redis: why the walk could not prove a row, and what the comparison read
 * off Remnawave. So a row an operator linked a minute ago leaves the list at
 * once, and an emptied Redis costs the reasons until the next pass, never the
 * rows. Recomputing on request was rejected: the comparison reads every profile
 * in Remnawave, and a list page is opened far more often than a day passes.
 */
@Injectable()
export class PanelLinkCheckService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PanelLinkCheckService.name);
  /** A pass is running in THIS process. */
  private inFlight = false;
  /** This worker has booted and its boot pass has not run yet. */
  private bootPending = false;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly reconciliation: PanelLinkReconciliationService,
    private readonly comparison: PanelProfileComparisonService,
    private readonly cache: RawCacheService,
    private readonly events: SystemEventsService,
  ) {}

  public onApplicationBootstrap(): void {
    if (!shouldRunSchedules()) return;
    this.bootPending = true;
    // Not awaited, deliberately: see the class note. When Redis is not ready yet
    // the pass finds no lock to take and the next tick runs it (`bootPending`).
    void this.run('boot').catch((error: unknown) => {
      this.logger.warn(`Panel link check did not run at boot; the next tick runs it: ${message(error)}`);
    });
  }

  /** Every minute on the worker: run a pass when one is due. */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'panel-link-check' })
  public async tick(now: Date = new Date()): Promise<PanelLinkCheckTickOutcome> {
    if (!shouldRunSchedules()) return 'skipped';
    if (this.inFlight) return 'busy';
    let trigger: PanelLinkCheckTrigger | null;
    try {
      trigger = await this.dueTrigger(now);
    } catch (error: unknown) {
      this.logger.warn(`Panel link check could not read its schedule: ${message(error)}`);
      return 'idle';
    }
    if (trigger === null) return 'idle';
    try {
      return await this.run(trigger);
    } catch (error: unknown) {
      // The lock is already given back (`run`'s `finally`); the schedule is
      // unchanged, so the next tick tries again.
      this.logger.warn(`Panel link check (${trigger}) failed and is tried again: ${message(error)}`);
      return 'failed';
    }
  }

  /**
   * Records that a backup import finished, from whichever process ran it. The
   * worker runs the pass within a minute and sends the card. Never throws: the
   * import has committed and nothing here may turn it into a failure.
   */
  public async requestAfterImport(input: {
    readonly importRecordId: string;
    readonly sourceType: string;
  }): Promise<boolean> {
    if (!IMPORT_SOURCES_THAT_LINK.has(input.sourceType)) return false;
    try {
      const pending = readImportRequests(await this.cache.get<unknown>(PANEL_LINK_CHECK_KEYS.requests));
      const next = [
        ...pending.filter((request) => request.importRecordId !== input.importRecordId),
        { importRecordId: input.importRecordId, sourceType: input.sourceType, requestedAt: new Date().toISOString() },
      ].slice(-MAX_PENDING_IMPORTS);
      await this.cache.set(PANEL_LINK_CHECK_KEYS.requests, next, REQUEST_TTL_SECONDS);
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        `Panel link check was not requested after import ${input.importRecordId}; the daily run still ` +
          `covers its rows, but no card will name them: ${message(error)}`,
      );
      return false;
    }
  }

  /**
   * One pass, if nobody else is running one. `busy` when this process or
   * another holds the pass.
   */
  public async run(trigger: PanelLinkCheckTrigger): Promise<'ran' | 'busy'> {
    if (this.inFlight) return 'busy';
    this.inFlight = true;
    try {
      let claimed = false;
      try {
        claimed = await this.cache.claimOnce(PANEL_LINK_CHECK_KEYS.lock, PANEL_LINK_CHECK_LOCK_TTL_SECONDS);
      } catch (error: unknown) {
        this.logger.warn(`Panel link check could not take its lock: ${message(error)}`);
      }
      if (!claimed) return 'busy';
      try {
        // TAKEN, not read: a request that lands while this pass runs stays for
        // the next one, and no request is answered twice.
        let imports: ImportRequest[] = [];
        try {
          imports = readImportRequests(await this.cache.take<unknown>(PANEL_LINK_CHECK_KEYS.requests));
        } catch (error: unknown) {
          this.logger.warn(`Panel link check could not read the import requests: ${message(error)}`);
        }
        await this.pass(imports.length > 0 ? 'import' : trigger, imports);
        this.bootPending = false;
      } finally {
        try {
          await this.cache.del(PANEL_LINK_CHECK_KEYS.lock);
        } catch (error: unknown) {
          this.logger.warn(`Panel link check lock not released; it expires by itself: ${message(error)}`);
        }
      }
      return 'ran';
    } finally {
      this.inFlight = false;
    }
  }

  /** What «Подписки без привязки к Remnawave» shows. */
  public async listUnlinked(): Promise<UnlinkedSubscriptionsResponse> {
    const [check, counts, population, verdicts] = await Promise.all([
      this.status(),
      this.countPopulation(),
      this.readPopulation(PANEL_LINK_CHECK_LIST_LIMIT + 1),
      this.readVerdicts(),
    ]);
    const page = population.slice(0, PANEL_LINK_CHECK_LIST_LIMIT);
    const users = await this.readUsers(page.map((row) => row.userId));
    const rows: UnlinkedSubscriptionRow[] = page.map((row) => {
      const verdict = verdicts[row.id] ?? null;
      const user = users.get(row.userId) ?? null;
      return {
        subscriptionId: row.id,
        userId: row.userId,
        userName: user?.name ?? null,
        userTelegramId: user?.telegramId ?? null,
        status: row.status,
        planName: row.planName,
        createdAt: new Date(row.createdAt).toISOString(),
        storedRemnawaveId: row.remnawaveId,
        linkKind: row.remnawaveId === null ? 'empty' : 'nonNumeric',
        reason: verdict?.reason ?? 'notCheckedYet',
        profileId: verdict?.profileId ?? null,
        otherSubscriptionId: verdict?.otherSubscriptionId ?? null,
        otherUserId: verdict?.otherUserId ?? null,
        lookedUpBy: verdict?.lookedUpBy ?? null,
        checkedAt: verdict?.checkedAt ?? null,
      };
    });
    return { check, total: counts.total, rows, truncated: population.length > PANEL_LINK_CHECK_LIST_LIMIT };
  }

  /** What «Лишние профили в Remnawave» shows: the last comparison, re-checked against the database. */
  public async listExtraProfiles(): Promise<ExtraProfilesResponse> {
    const [check, stored] = await Promise.all([this.status(), this.readComparison()]);
    if (stored === null) {
      return {
        check,
        comparedAt: null,
        readOutcome: null,
        profilesRead: 0,
        profilesWithoutOwner: 0,
        autoLinked: 0,
        customers: [],
        truncated: false,
      };
    }
    const userIds = stored.customers.map((customer) => customer.userId);
    const users = await this.readUsers(userIds);
    const withoutLink = await this.readSubscriptionsWithoutLink(userIds);
    const linkers = await this.readLinkersNow(
      stored.customers.flatMap((customer) => customer.profiles.map((profile) => profile.profileId)),
    );
    const customers: ExtraProfileCustomer[] = stored.customers.map((customer) => {
      const user = users.get(customer.userId) ?? null;
      return {
        userId: customer.userId,
        userExists: user !== null,
        userName: user?.name ?? null,
        userTelegramId: user?.telegramId ?? null,
        profiles: customer.profiles.map((profile): ExtraProfile => {
          const now = linkers.get(profile.profileId) ?? [];
          const other = now.find((row) => row.userId !== customer.userId) ?? null;
          return {
            ...profile,
            linkedBySubscriptionId: other?.id ?? profile.linkedBySubscriptionId,
            linkedNow: now.length > 0,
          };
        }),
        subscriptionsWithoutLink: withoutLink.get(customer.userId) ?? [],
      };
    });
    return {
      check,
      comparedAt: stored.comparedAt,
      readOutcome: stored.readOutcome,
      profilesRead: stored.profilesRead,
      profilesWithoutOwner: stored.profilesWithoutOwner,
      autoLinked: stored.autoLinked,
      customers,
      truncated: stored.truncated,
    };
  }

  /** When the check last ran, how, and when it runs next. */
  public async status(): Promise<PanelLinkCheckStatus> {
    const state = await this.loadState();
    let running = false;
    try {
      running = await this.cache.exists(PANEL_LINK_CHECK_KEYS.lock);
    } catch {
      running = false;
    }
    const nextRunAt =
      state.nextRetryAt ??
      (state.lastRunAt === null
        ? null
        : new Date(Date.parse(state.lastRunAt) + PANEL_LINK_CHECK_DAILY_MS).toISOString());
    return {
      lastRunAt: state.lastRunAt,
      lastRunTrigger: state.lastRunTrigger,
      lastRunOutcome: state.lastRunOutcome,
      nextRunAt,
      running,
    };
  }

  /**
   * Which pass is due, if any. Import requests first — an operator is waiting
   * for their card — then this worker's boot, then the retry, then the day.
   */
  private async dueTrigger(now: Date): Promise<PanelLinkCheckTrigger | null> {
    const requests = readImportRequests(await this.cache.get<unknown>(PANEL_LINK_CHECK_KEYS.requests));
    if (requests.length > 0) return 'import';
    if (this.bootPending) return 'boot';
    const state = await this.loadState();
    if (state.lastRunAt === null) return 'boot';
    if (state.nextRetryAt !== null && Date.parse(state.nextRetryAt) <= now.getTime()) return 'retry';
    if (now.getTime() - Date.parse(state.lastRunAt) >= PANEL_LINK_CHECK_DAILY_MS) return 'daily';
    return null;
  }

  /**
   * The pass itself: the walk for real, then the comparison, then the record of
   * both, then the cards. Each part fails on its own — a walk that threw does
   * not stop the comparison, and neither stops the state from being written.
   */
  private async pass(trigger: PanelLinkCheckTrigger, imports: readonly ImportRequest[]): Promise<void> {
    const state = await this.loadState();

    let walk: PanelLinkReconciliationReport | null = null;
    try {
      walk = await this.reconciliation.reconcile({
        dryRun: false,
        limit: PANEL_LINK_CHECK_WALK_LIMIT,
        budgetMs: PANEL_LINK_CHECK_WALK_BUDGET_MS,
        startAfterId: state.walkCursor,
      });
    } catch (error: unknown) {
      this.logger.warn(`Panel link check: the walk failed and runs again in an hour: ${message(error)}`);
    }

    let comparison: PanelProfileComparison | null = null;
    let comparisonFailed = false;
    try {
      const outcome = await this.comparison.compare();
      if (outcome.kind === 'ok') {
        comparison = outcome.result;
      } else {
        comparisonFailed = true;
        this.logger.warn(
          `Panel link check: Remnawave's user list could not be read (${outcome.detail}); the ` +
            'comparison runs again in an hour',
        );
      }
    } catch (error: unknown) {
      comparisonFailed = true;
      this.logger.warn(`Panel link check: the comparison failed and runs again in an hour: ${message(error)}`);
    }

    const finishedAt = new Date();
    // A list Remnawave served only in part is NOT a reason to retry: that is the
    // panel's size, not an outage, and an hour changes nothing about it.
    const incomplete =
      walk === null || !walk.walkComplete || walk.panelUnavailable || comparisonFailed;

    await this.saveVerdicts(walk, comparison, finishedAt);
    if (comparison !== null) {
      await this.cache.set(PANEL_LINK_CHECK_KEYS.comparison, storedComparison(comparison), STORED_TTL_SECONDS);
    }
    await this.cache.set(
      PANEL_LINK_CHECK_KEYS.state,
      {
        lastRunAt: finishedAt.toISOString(),
        lastRunTrigger: trigger,
        lastRunOutcome: incomplete ? 'incomplete' : 'complete',
        nextRetryAt: incomplete ? new Date(finishedAt.getTime() + PANEL_LINK_CHECK_RETRY_MS).toISOString() : null,
        walkCursor: walk !== null && !walk.walkComplete ? walk.nextCursor : null,
      } satisfies PanelLinkCheckState,
    );

    const walked = walk?.linked ?? 0;
    const compared = comparison?.autoLinked ?? 0;
    if (walked + compared > 0) await this.audit(trigger, walk, comparison);

    const counts = imports.length > 0 ? await this.countPopulation() : null;
    if (counts !== null && counts.total > 0) {
      this.warnAfterImport(imports, counts, walked + compared, incomplete);
    } else if (walked + compared > 0) {
      this.events.info(
        EVENT_TYPES.SYSTEM_REMNAWAVE_SYNC,
        'SYSTEM',
        `Panel link check: linked ${walked + compared} subscription(s) to their Remnawave profiles`,
        {
          trigger,
          scanned: walk?.scanned ?? 0,
          linked: walked + compared,
          note:
            `Проверка привязки к панели сама привязала подписки к их профилям Remnawave: ${walked + compared}. ` +
            'Что осталось без привязки — «Подписки» → «Инструменты» → «Подписки без привязки к Remnawave».',
        },
      );
    }
    this.logger.log(
      `Panel link check (${trigger}): walked ${walk?.scanned ?? 0} row(s), linked ${walked}; ` +
        `comparison ${comparison === null ? 'not run' : `read ${comparison.profilesRead}, linked ${compared}`}; ` +
        `${incomplete ? 'incomplete — retry in an hour' : 'complete'}`,
    );
  }

  /**
   * ONE card after a backup import (owner's answer to Q4: count and warn):
   * how many live subscriptions the check left without a proven link, how many
   * of them hold an id no supported Remnawave issued, and where the list is.
   */
  private warnAfterImport(
    imports: readonly ImportRequest[],
    counts: { readonly total: number; readonly nonNumeric: number },
    linked: number,
    incomplete: boolean,
  ): void {
    const sources = [...new Set(imports.map((request) => IMPORT_SOURCE_NAMES[request.sourceType] ?? request.sourceType))];
    const note =
      `После импорта (${sources.join(', ')}) проверка привязки к панели ` +
      (linked > 0 ? `привязала подписок: ${linked}, но ` : '') +
      `не смогла доказать привязку к профилю Remnawave у подписок: ${counts.total}` +
      (counts.nonNumeric > 0
        ? `; из них с нечисловым идентификатором, какого нынешняя Remnawave не выдаёт: ${counts.nonNumeric}. `
        : '. ') +
      'Список с причиной у каждой и кнопкой «Привязать профиль» — «Подписки» → «Инструменты» → ' +
      '«Подписки без привязки к Remnawave».' +
      (incomplete ? ' Remnawave ответил не на всё — проверка повторится через час сама.' : '') +
      ' Сам импорт ничего не удалял и ничего не отправлял в Remnawave.';
    this.events.warn(
      EVENT_TYPES.SYSTEM_REMNAWAVE_SYNC,
      'SYSTEM',
      `After the backup import, ${counts.total} live subscription(s) have no proven Remnawave link ` +
        `(${counts.nonNumeric} hold a non-numeric id)`,
      {
        reason: 'links_unproven_after_import',
        importRecordIds: imports.map((request) => request.importRecordId),
        sourceTypes: imports.map((request) => request.sourceType),
        unprovenLinks: counts.total,
        nonNumericLinks: counts.nonNumeric,
        linked,
        note,
      },
    );
  }

  /**
   * One audit row per pass that linked anything: the rows themselves, not a
   * count, because this write decides which profile a subscription names, and
   * an entry that cannot say WHICH went WHERE — and what the row held before —
   * cannot be used to undo a mistake. Same action as the button this replaces,
   * so the audit page's label and every search for it keep working.
   */
  private async audit(
    trigger: PanelLinkCheckTrigger,
    walk: PanelLinkReconciliationReport | null,
    comparison: PanelProfileComparison | null,
  ): Promise<void> {
    const links = [
      ...(walk?.repaired ?? [])
        .filter((row) => row.outcome === 'linked')
        .map((row) => ({
          subscriptionId: row.subscriptionId,
          userId: row.userId,
          remnawaveId: row.remnawaveId,
          storedRemnawaveId: row.storedRemnawaveId,
          panelId: row.panelId,
          resolvedBy: row.resolvedBy,
        })),
      ...(comparison?.links ?? []).map((link) => ({
        subscriptionId: link.subscriptionId,
        userId: link.userId,
        remnawaveId: link.remnawaveId,
        storedRemnawaveId: link.previousRemnawaveId,
        storedPanelId: link.previousPanelId,
        panelId: link.panelId,
        panelUsername: link.panelUsername,
        resolvedBy: 'ownerMarker',
        proof: link.proof,
      })),
    ];
    try {
      await this.prismaService.adminAuditLog.create({
        data: {
          action: 'subscriptions.panel_link_reconciled',
          metadata: {
            automatic: true,
            trigger,
            scanned: walk?.scanned ?? 0,
            linked: walk?.linked ?? 0,
            autoLinked: comparison?.autoLinked ?? 0,
            links,
          } as Prisma.InputJsonObject,
        },
      });
    } catch (error: unknown) {
      // The links are committed; the log line is then their only record.
      this.logger.error(
        `Panel link check: the audit row was not written (${message(error)}); the links written: ${JSON.stringify(links)}`,
      );
    }
  }

  /** Keeps the verdict of every row the walk asked about and could not prove. */
  private async saveVerdicts(
    walk: PanelLinkReconciliationReport | null,
    comparison: PanelProfileComparison | null,
    at: Date,
  ): Promise<void> {
    if (walk === null && (comparison?.links.length ?? 0) === 0) return;
    const verdicts = await this.readVerdicts();
    const scanned: PanelLinkReconciliationRow[] = [...(walk?.repaired ?? []), ...(walk?.unrepaired ?? [])].filter(
      (row) => row.scanned,
    );
    for (const row of scanned) {
      if (row.outcome === 'linked' || row.outcome === 'wouldLink' || row.reasonCode === null) {
        delete verdicts[row.subscriptionId];
        continue;
      }
      verdicts[row.subscriptionId] = {
        reason: UNLINKED_REASON[row.reasonCode],
        profileId: row.remnawaveId,
        otherSubscriptionId: row.otherSubscriptionId,
        otherUserId: row.otherUserId,
        lookedUpBy:
          row.reasonCode === 'noRoute' || row.resolvedBy === 'storedIdentity' ? null : row.resolvedBy,
        checkedAt: at.toISOString(),
      };
    }
    for (const link of comparison?.links ?? []) delete verdicts[link.subscriptionId];
    const kept = Object.entries(verdicts)
      .sort(([, left], [, right]) => right.checkedAt.localeCompare(left.checkedAt))
      .slice(0, VERDICT_CAP);
    await this.cache.set(PANEL_LINK_CHECK_KEYS.verdicts, Object.fromEntries(kept), STORED_TTL_SECONDS);
  }

  private async loadState(): Promise<PanelLinkCheckState> {
    try {
      return readState(await this.cache.get<unknown>(PANEL_LINK_CHECK_KEYS.state));
    } catch (error: unknown) {
      this.logger.warn(`Panel link check could not read its state: ${message(error)}`);
      return EMPTY_STATE;
    }
  }

  private async readVerdicts(): Promise<Record<string, StoredVerdict>> {
    try {
      const raw = await this.cache.get<unknown>(PANEL_LINK_CHECK_KEYS.verdicts);
      return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? { ...(raw as Record<string, StoredVerdict>) }
        : {};
    } catch {
      return {};
    }
  }

  private async readComparison(): Promise<StoredComparison | null> {
    try {
      const raw = await this.cache.get<StoredComparison>(PANEL_LINK_CHECK_KEYS.comparison);
      return raw !== null && Array.isArray(raw.customers) ? raw : null;
    } catch {
      return null;
    }
  }

  /** How many live rows are without a proven link now, and how many of them hold a non-decimal id. */
  private async countPopulation(): Promise<{ total: number; nonNumeric: number }> {
    const rows = await this.prismaService.$queryRaw<Array<{ total: number; nonNumeric: number }>>(Prisma.sql`
      SELECT count(*)::int AS "total",
             (count(*) FILTER (WHERE "remnawave_id" IS NOT NULL))::int AS "nonNumeric"
      FROM "subscriptions"
      WHERE "status" <> 'DELETED'
        AND ${PANEL_LINK_POPULATION_SQL}
    `);
    return { total: Number(rows[0]?.total ?? 0), nonNumeric: Number(rows[0]?.nonNumeric ?? 0) };
  }

  /** The population, oldest first — the customer who has waited longest leads. */
  private async readPopulation(take: number): Promise<PopulationRow[]> {
    return this.prismaService.$queryRaw<PopulationRow[]>(Prisma.sql`
      SELECT "id",
             "user_id" AS "userId",
             "status"::text AS "status",
             "created_at" AS "createdAt",
             "remnawave_id" AS "remnawaveId",
             "plan_snapshot" ->> 'name' AS "planName"
      FROM "subscriptions"
      WHERE "status" <> 'DELETED'
        AND ${PANEL_LINK_POPULATION_SQL}
      ORDER BY "created_at" ASC, "id" ASC
      LIMIT ${take}
    `);
  }

  private async readUsers(
    userIds: readonly string[],
  ): Promise<Map<string, { name: string | null; telegramId: string | null }>> {
    const unique = [...new Set(userIds)];
    const users = new Map<string, { name: string | null; telegramId: string | null }>();
    if (unique.length === 0) return users;
    const rows = await this.prismaService.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true, telegramId: true },
    });
    for (const row of rows) {
      users.set(row.id, {
        name: typeof row.name === 'string' && row.name.length > 0 ? row.name : null,
        telegramId: row.telegramId === null || row.telegramId === undefined ? null : row.telegramId.toString(),
      });
    }
    return users;
  }

  /** Each customer's live subscriptions whose link is empty or not a decimal, as the database stands now. */
  private async readSubscriptionsWithoutLink(
    userIds: readonly string[],
  ): Promise<Map<string, SubscriptionWithoutLink[]>> {
    const byUser = new Map<string, SubscriptionWithoutLink[]>();
    if (userIds.length === 0) return byUser;
    const rows = await this.prismaService.subscription.findMany({
      where: { userId: { in: [...new Set(userIds)] }, status: { not: SubscriptionStatus.DELETED } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, userId: true, status: true, createdAt: true, remnawaveId: true, planSnapshot: true },
    });
    for (const row of rows) {
      if (row.remnawaveId !== null && isNumericPanelIdentity(row.remnawaveId)) continue;
      const snapshot =
        row.planSnapshot !== null && typeof row.planSnapshot === 'object' && !Array.isArray(row.planSnapshot)
          ? (row.planSnapshot as Record<string, unknown>)
          : {};
      const list = byUser.get(row.userId) ?? [];
      list.push({
        subscriptionId: row.id,
        status: row.status,
        planName: typeof snapshot['name'] === 'string' ? snapshot['name'] : null,
        createdAt: row.createdAt.toISOString(),
        storedRemnawaveId: row.remnawaveId,
      });
      byUser.set(row.userId, list);
    }
    return byUser;
  }

  /** Every live row that names one of the profiles now, by either identifier. */
  private async readLinkersNow(
    profileIds: readonly string[],
  ): Promise<Map<string, Array<{ id: string; userId: string }>>> {
    const linkers = new Map<string, Array<{ id: string; userId: string }>>();
    const decimals = [...new Set(profileIds)].filter((id) => isNumericPanelIdentity(id));
    if (decimals.length === 0) return linkers;
    const numeric = decimals.map((id) => Number(id)).filter((id) => Number.isSafeInteger(id));
    const rows = await this.prismaService.subscription.findMany({
      where: {
        status: { not: SubscriptionStatus.DELETED },
        OR: [{ remnawaveId: { in: decimals } }, { remnawavePanelId: { in: numeric } }],
      },
      select: { id: true, userId: true, remnawaveId: true, remnawavePanelId: true },
    });
    for (const row of rows) {
      const named = new Set<string>();
      if (row.remnawaveId !== null && isNumericPanelIdentity(row.remnawaveId)) named.add(String(Number(row.remnawaveId)));
      if (row.remnawavePanelId !== null) named.add(String(row.remnawavePanelId));
      for (const profileId of named) {
        const list = linkers.get(profileId) ?? [];
        list.push({ id: row.id, userId: row.userId });
        linkers.set(profileId, list);
      }
    }
    return linkers;
  }
}

/** The comparison as it is kept: everything but the audit's `links`. */
function storedComparison(comparison: PanelProfileComparison): StoredComparison {
  return {
    comparedAt: comparison.comparedAt,
    readOutcome: comparison.readOutcome,
    profilesRead: comparison.profilesRead,
    profilesWithoutOwner: comparison.profilesWithoutOwner,
    autoLinked: comparison.autoLinked,
    customers: comparison.customers,
    truncated: comparison.truncated,
  };
}
