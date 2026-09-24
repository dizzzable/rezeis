import {
  Prisma,
  SubscriptionStatus,
  SubscriptionTermStatus,
  SyncAction,
  SyncJobStatus,
} from '@prisma/client';

import { toPanelDeviceLimit, toPanelTrafficLimitBytes } from '../utils/panel-limit-wire.util';
import { panelExpiryToLocal, withLocalOpenEndKept } from './panel-expiry';
import type { RemnawavePanelUser } from './remnawave-api.service';

/**
 * WHAT A REMNAWAVE READ-BACK MAY WRITE ONTO A SUBSCRIPTION IN THE TERM MODEL —
 * the one rule every path that copies a panel profile back onto an existing row
 * follows: the webhook mirror (`RemnawaveWebhookService`), the «Импорт из
 * Remnawave» sync (`RemnawaveImporterService`), the ↻ refresh of one
 * subscription (`AdminUserSubscriptionsController.syncSubscription`), the
 * backup re-imports' panel overlay (Altshop, Bedolaga, Remnashop, STEALTHNET)
 * and the expired-profile cleanup's self-heal (`ExpiredProfileCleanupService`,
 * which reads the expiry alone).
 *
 * "In the model" is the codebase's usual test: the row has an ACTIVE term.
 * A row outside it, and a row being created, keep each writer's own behaviour.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 *  - LIMITS are never taken, in the columns or in the snapshot. In the model a
 *    limit is "own share + the add-ons the projection recorded", and the own
 *    share is read back as the column less that recorded share. A read that
 *    predates the panel's own last push — the push still queued or failing, or
 *    an old event delivered late — carries the OLD limit; taken as the
 *    customer's own it put the automatic device reduction below the plan and
 *    brought ended add-ons back. Nothing in a read
 *    tells that echo from a limit an operator set in Remnawave's own UI, so the
 *    panel is the source of truth: a profile holding other limits than rezeis
 *    would push gets rezeis' own pushed back (`queuePanelLimitsPutBack`).
 *  - EXPIRY is taken, as Remnawave-side extensions always were, unless the
 *    panel's own last change is newer than the read (`panelPushOutranksRead`).
 *  - STATUS follows the expiry. It is Remnawave's runtime state — LIMITED and
 *    EXPIRED are derived from usage and the clock there — so a read that is
 *    newer than everything rezeis pushed is the only way to learn it. But a
 *    read the panel's own push outranks describes the profile BEFORE that
 *    push: a renewal lifted EXPIRED, a top-up lifted LIMITED, and a
 *    `user.expired` stamped earlier and delivered later put «Истекла» on a
 *    subscription the customer had just paid for, until some later event. The
 *    fresh status after a push is the panel's own answer to it, which
 *    `ProfileSyncProcessor` writes (`profile-sync/panel-answer-status.ts`).
 *    A traffic reset of ours that landed after the read — the operator's
 *    «Сбросить» — outranks its status as well (`trafficResetOutranksStatus`).
 *  - A SUBSCRIPTION WITH NO END (`expiresAt = null`) takes no date from a read,
 *    nor an EXPIRED Remnawave derived from one (`keepsOpenEnd`,
 *    `panel-expiry.ts`). A read that states "no end" — the year 2099 — is
 *    `null` like the row's own.
 *
 * ── The time of a read ─────────────────────────────────────────────────────
 *
 * A webhook's time is the panel's stamp on it (`webhookEventTime`). A read the
 * panel answers on request is timed at the moment it was ASKED — before the
 * request, not after the answer: a push that completes while the answer is
 * travelling, or while an import walks its pages and writes its rows, is newer
 * than what was read, and only the earlier instant says so.
 */

/**
 * `cause` and `payload.source` of the UPDATE that puts rezeis' own limits back
 * into a Remnawave profile found holding other ones.
 */
export const REMNAWAVE_LIMIT_DRIFT_CAUSE = 'REMNAWAVE_LIMIT_DRIFT';

/**
 * `cause` and `payload.source` of the record an operator's «Сбросить» leaves:
 * a TRAFFIC_RESET job, COMPLETED when the panel has answered
 * ({@link recordOperatorTrafficReset}). Made directly, not through the
 * processor, and a push of ours all the same.
 */
export const OPERATOR_TRAFFIC_RESET_CAUSE = 'OPERATOR_TRAFFIC_RESET';

/** A `where` fragment: the row is in the durable term model. */
export const IN_TERM_MODEL = {
  terms: { some: { status: SubscriptionTermStatus.ACTIVE } },
} satisfies Prisma.SubscriptionWhereInput;

/** A `where` fragment: the row is outside the durable term model. */
export const OUTSIDE_TERM_MODEL = {
  terms: { none: { status: SubscriptionTermStatus.ACTIVE } },
} satisfies Prisma.SubscriptionWhereInput;

/**
 * A `select` fragment that answers "is this row in the model" in the query that
 * already reads the row. A row read without it (a hand-built double) carries no
 * `terms` and reads as outside the model, which is each writer's old path.
 */
export const TERM_MODEL_MARKER_SELECT = {
  terms: { where: { status: SubscriptionTermStatus.ACTIVE }, select: { id: true }, take: 1 },
} satisfies Prisma.SubscriptionSelect;

/** Whether a row read with {@link TERM_MODEL_MARKER_SELECT} is in the model. */
export function isInTermModel(row: { readonly terms?: readonly unknown[] } | null | undefined): boolean {
  return (row?.terms?.length ?? 0) > 0;
}

/** The limits a Remnawave read stated, as the panel spells them; `undefined` when it did not state one. */
export interface PanelStatedLimits {
  readonly trafficLimitBytes?: number;
  readonly hwidDeviceLimit?: number;
}

/**
 * The limits a decoded panel row states. `parsePanelUserRow` answers `0` for a
 * field the panel omitted, which reads as "unlimited" here; that can only ever
 * cost a redundant put-back of rezeis' own limits, never a write of the
 * panel's.
 */
export function statedLimitsOf(panelUser: Pick<RemnawavePanelUser, 'trafficLimitBytes' | 'hwidDeviceLimit'>): PanelStatedLimits {
  return {
    ...(Number.isFinite(panelUser.trafficLimitBytes) ? { trafficLimitBytes: panelUser.trafficLimitBytes } : {}),
    ...(Number.isFinite(panelUser.hwidDeviceLimit) && panelUser.hwidDeviceLimit >= 0
      ? { hwidDeviceLimit: panelUser.hwidDeviceLimit }
      : {}),
  };
}

/**
 * Whether a profile's stated limits are what rezeis pushes for these columns.
 * Compared as the push SENDS them (`panel-limit-wire.util.ts`), so the echo of
 * our own push always reads as in step. A limit the read did not state is not
 * a difference.
 */
export function panelLimitsInStep(
  columns: { readonly trafficLimit: number | null; readonly deviceLimit: number },
  stated: PanelStatedLimits,
): boolean {
  if (stated.trafficLimitBytes !== undefined && stated.trafficLimitBytes !== toPanelTrafficLimitBytes(columns.trafficLimit)) {
    return false;
  }
  if (stated.hwidDeviceLimit !== undefined && stated.hwidDeviceLimit !== toPanelDeviceLimit(columns.deviceLimit)) {
    return false;
  }
  return true;
}

/**
 * Whether the panel's own state for this subscription is at least as new as
 * anything a read made at `readAt` can describe — in which case the read's
 * limits, expiry and status are an echo of an older state, not news.
 *
 * rezeis' state reaches Remnawave only through profile-sync UPDATE and CREATE
 * jobs, each built from the columns when it runs, and every panel write that
 * should reach the profile queues one. So the LATEST such job that is not
 * superseded says it all:
 *
 *  - none: rezeis never pushed this row, and the read is all there is;
 *  - not COMPLETED (queued, running or failed): a change of ours has not
 *    reached Remnawave, so the read cannot include it — the push that is late
 *    or failing. The job carries our state when it lands; a failed one stays
 *    with the operator, as every failed push does;
 *  - COMPLETED: the read includes that push only if it was made after the push
 *    landed. `completedAt` is written after the PATCH has returned, so the
 *    echo of that very push is older and is never taken for news — which is
 *    what keeps {@link queuePanelLimitsPutBack} from ever answering its own
 *    echo. An old event delivered late (the panel retries a webhook it could
 *    not deliver, stamp and all) is older too.
 *
 * The panel's clock against ours for a webhook; ours on both sides for a read
 * made on request.
 */
export async function panelPushOutranksRead(
  client: Pick<Prisma.TransactionClient, 'profileSyncJob'>,
  subscriptionId: string,
  readAt: Date,
): Promise<boolean> {
  return latestPushOutranks(await latestPanelPush(client, subscriptionId), readAt);
}

/** The latest non-superseded UPDATE or CREATE for a row: what {@link panelPushOutranksRead} weighs. */
async function latestPanelPush(
  client: Pick<Prisma.TransactionClient, 'profileSyncJob'>,
  subscriptionId: string,
): Promise<{ readonly status: SyncJobStatus; readonly completedAt: Date | null } | null> {
  return client.profileSyncJob.findFirst({
    where: {
      subscriptionId,
      supersededAt: null,
      action: { in: [SyncAction.UPDATE, SyncAction.CREATE] },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { status: true, completedAt: true },
  });
}

function latestPushOutranks(
  latest: { readonly status: SyncJobStatus; readonly completedAt: Date | null } | null,
  readAt: Date,
): boolean {
  if (latest === null) return false;
  if (latest.status !== SyncJobStatus.COMPLETED || latest.completedAt === null) return true;
  return readAt.getTime() <= latest.completedAt.getTime();
}

/**
 * Whether a traffic reset of ours LANDED after a read made at `readAt` — the
 * operator's «Сбросить» (the owner, 24.09.2026), or a TRAFFIC_RESET job. A
 * reset lifts LIMITED, so a `user.limited` stamped before it and delivered
 * after it describes the profile before the reset. It outranks the read's
 * STATUS only: a reset carries neither our expiry nor our limits, which is why
 * {@link panelPushOutranksRead} leaves resets out. One that has not completed
 * has changed nothing yet; one that has, superseded or not, has — the
 * operator's record is born superseded ({@link recordOperatorTrafficReset}).
 */
async function trafficResetOutranksStatus(
  client: Pick<Prisma.TransactionClient, 'profileSyncJob'>,
  subscriptionId: string,
  readAt: Date,
): Promise<boolean> {
  const reset = await client.profileSyncJob.findFirst({
    where: {
      subscriptionId,
      action: SyncAction.TRAFFIC_RESET,
      status: SyncJobStatus.COMPLETED,
      completedAt: { gte: readAt },
    },
    select: { id: true },
  });
  return reset !== null;
}

/**
 * Records an operator's traffic reset as the push of ours it is, once the
 * panel has answered it: COMPLETED at this instant, so a read stamped before
 * it is outranked for the status ({@link trafficResetOutranksStatus}). Returns
 * the job, for the answer's status (`takePanelAnswerStatus`).
 *
 * BORN SUPERSEDED, so that it never stands for the subscription's sync state.
 * Everything that reads that state takes the latest job that is not
 * superseded: the subscription card's «Не применилось в панели: …» (the only
 * warning that limits, expiry or squads are not reaching Remnawave), the
 * sweeps, a merge's count of live jobs. A reset says nothing about whether the
 * panel's own state landed, and as the latest job it would have hidden that
 * warning after a failed push.
 */
export async function recordOperatorTrafficReset(
  client: Pick<Prisma.TransactionClient, 'profileSyncJob'>,
  subscriptionId: string,
): Promise<{ readonly id: string; readonly subscriptionId: string; readonly createdAt: Date }> {
  const now = new Date();
  return client.profileSyncJob.create({
    data: {
      subscriptionId,
      action: SyncAction.TRAFFIC_RESET,
      status: SyncJobStatus.COMPLETED,
      startedAt: now,
      completedAt: now,
      supersededAt: now,
      cause: OPERATOR_TRAFFIC_RESET_CAUSE,
      payload: { source: OPERATOR_TRAFFIC_RESET_CAUSE } as Prisma.InputJsonObject,
    },
    select: { id: true, subscriptionId: true, createdAt: true },
  });
}

/**
 * THE SAME TEST IN REVERSE, for Remnawave's answer to a push of rezeis' own:
 * whether a push NEWER than `job` — created after it, in the order
 * {@link panelPushOutranksRead} reads "latest" — is not COMPLETED yet
 * (queued, running or failed). That push carries a later state of ours, and
 * its own answer describes the profile after it; this answer, however fresh
 * about Remnawave, predates it. Taking it would let an older push overwrite
 * what a newer one is about to establish — a renewal's ACTIVE by the answer
 * of a push queued before the payment. A newer push that has COMPLETED
 * outranks nothing here: its answer was written when it came, and which of the
 * two PATCHes Remnawave applied last is not ours to know.
 *
 * The same jobs count as in {@link panelPushOutranksRead}: UPDATE and CREATE,
 * not superseded.
 */
export async function newerPanelPushPending(
  client: Pick<Prisma.TransactionClient, 'profileSyncJob'>,
  job: { readonly id: string; readonly subscriptionId: string; readonly createdAt: Date },
): Promise<boolean> {
  const newer = await client.profileSyncJob.findFirst({
    where: {
      subscriptionId: job.subscriptionId,
      supersededAt: null,
      action: { in: [SyncAction.UPDATE, SyncAction.CREATE] },
      status: { not: SyncJobStatus.COMPLETED },
      OR: [{ createdAt: { gt: job.createdAt } }, { createdAt: job.createdAt, id: { gt: job.id } }],
    },
    select: { id: true },
  });
  return newer !== null;
}

/** One row in the term model, and what a read said about its profile. */
export interface TermModelReadback {
  readonly subscriptionId: string;
  /** `null` when the row has no panel link: an UPDATE would provision through CREATE. */
  readonly remnawaveId: string | null;
  readonly columns: { readonly trafficLimit: number | null; readonly deviceLimit: number };
  readonly stated: PanelStatedLimits;
  /** When the panel stated it — see "The time of a read". */
  readonly readAt: Date;
  /** Another live row names the same profile (a duplicate pair). */
  readonly sharedProfile: boolean;
  /** The panel reports the profile deleted. */
  readonly profileDeleted: boolean;
  /**
   * The row's own `expiresAt`: `null` for a subscription with no end.
   * `undefined` when the writer did not read it, which decides nothing.
   */
  readonly localExpiresAt?: Date | null;
  /** The expiry the read stated, through `panelExpiryToLocal`; `undefined` when it stated none. */
  readonly statedExpiresAt?: Date | null;
}

/**
 * What to do about the limits a read stated — which, in the model, are never
 * written in any of these cases:
 *
 *  - `IN_STEP`: the profile holds what rezeis pushes;
 *  - `PUT_BACK`: it does not — queue {@link queuePanelLimitsPutBack} after the write;
 *  - `OUTRANKED`: the read is older than the panel's own last change, which is
 *    already on its way or has landed;
 *  - `PROFILE_DELETED`: an UPDATE that finds the profile gone re-provisions it,
 *    and bringing back a profile an operator removed is the operator's call;
 *  - `SHARED_PROFILE`: two live rows name the profile. Each would push its own
 *    limits over the other's echo, and each echo, newer than the other row's
 *    last push, would answer again — a loop through the panel with the
 *    customer's limit flapping. Which row the profile belongs to is the
 *    operator's call («Слияние подписок-дубликатов»);
 *  - `UNLINKED`: the row has no `remnawaveId`, and an UPDATE without one
 *    provisions through CREATE — a read-back must not mint a second profile.
 */
export type PanelLimitsVerdict = 'IN_STEP' | 'PUT_BACK' | 'OUTRANKED' | 'PROFILE_DELETED' | 'SHARED_PROFILE' | 'UNLINKED';

export interface TermModelReadbackVerdict {
  /** False when the panel's own state outranks the read: its expiry is not written. */
  readonly takeExpiry: boolean;
  /**
   * False on the same condition: the read's status is not written either, and
   * nothing that reports it as news — a customer notice, a card, an
   * automation — goes out on its strength.
   */
  readonly takeStatus: boolean;
  /**
   * The row has no end date and the read states one: that date is not
   * written, nor an EXPIRED Remnawave derived from it (`withLocalOpenEndKept`).
   * Independent of `takeExpiry`, which stays "not outranked".
   */
  readonly keepsOpenEnd: boolean;
  /**
   * The read is outranked because the latest push of ours FAILED — not queued,
   * not running, not landed after it. The one case where a reader may still
   * take a status on evidence of its own (the webhook's LIMITED, when the
   * traffic used is at or over the row's own limit).
   */
  readonly outrankedByFailedPush: boolean;
  readonly limits: PanelLimitsVerdict;
}

/**
 * THE RULE, for one row in the term model. Asked BEFORE the writer's own write,
 * which then leaves the limits out, and the expiry and the status too unless
 * the verdict takes them. A `PUT_BACK` is queued AFTER that write, so the push
 * — built from the columns when it runs — carries an expiry the same read may
 * just have brought in.
 */
export async function judgeTermModelReadback(
  client: Pick<Prisma.TransactionClient, 'profileSyncJob'>,
  input: TermModelReadback,
): Promise<TermModelReadbackVerdict> {
  const latest = await latestPanelPush(client, input.subscriptionId);
  const outranked = latestPushOutranks(latest, input.readAt);
  const resetSince = await trafficResetOutranksStatus(client, input.subscriptionId, input.readAt);
  return {
    takeExpiry: !outranked,
    takeStatus: !outranked && !resetSince,
    keepsOpenEnd: input.localExpiresAt === null && input.statedExpiresAt instanceof Date,
    // Not when a reset landed since: the counter the read reports is gone.
    outrankedByFailedPush: outranked && latest?.status === SyncJobStatus.FAILED && !resetSince,
    limits: limitsVerdict(input, outranked),
  };
}

function limitsVerdict(input: TermModelReadback, outranked: boolean): PanelLimitsVerdict {
  // An echo: whatever it says about the limits, what Remnawave holds now is —
  // or, once the push in flight lands, will be — what rezeis pushed.
  if (outranked) return 'OUTRANKED';
  if (panelLimitsInStep(input.columns, input.stated)) return 'IN_STEP';
  if (input.profileDeleted) return 'PROFILE_DELETED';
  if (input.sharedProfile) return 'SHARED_PROFILE';
  if (input.remnawaveId === null) return 'UNLINKED';
  return 'PUT_BACK';
}

/**
 * Queues the UPDATE that puts rezeis' own limits back into the profile: an
 * ordinary job, built from the columns when it runs like every other push — so
 * it re-asserts the expiry, squads and contacts rezeis holds as well, and no
 * status (`propagateStatus` is absent). Returns its id for the caller to
 * enqueue; a caller without the queue leaves the PENDING row to the
 * five-minute profile-sync sweep.
 */
export async function queuePanelLimitsPutBack(
  client: Pick<Prisma.TransactionClient, 'profileSyncJob'>,
  subscriptionId: string,
): Promise<string> {
  const job = await client.profileSyncJob.create({
    data: {
      subscriptionId,
      action: SyncAction.UPDATE,
      status: SyncJobStatus.PENDING,
      cause: REMNAWAVE_LIMIT_DRIFT_CAUSE,
      payload: { source: REMNAWAVE_LIMIT_DRIFT_CAUSE } as Prisma.InputJsonObject,
    },
    select: { id: true },
  });
  return job.id;
}

/** An existing row as a panel-row reader reads it, with {@link TERM_MODEL_MARKER_SELECT}. */
export interface ReadbackRow {
  readonly id: string;
  readonly remnawaveId: string | null;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  /** The row's own expiry, when the writer selected it; read here otherwise. */
  readonly expiresAt?: Date | null;
  readonly terms?: readonly unknown[];
}

/**
 * THE RULE for a writer that copies a decoded panel row onto an EXISTING
 * subscription — the «Импорт из Remnawave» sync, the ↻ refresh, the backup
 * re-imports' overlay. `null` when it does not apply: no row yet, no panel
 * profile read, or a row outside the model; the writer then writes as it
 * always did. `claims` are the writer's own terms for "the rows that name this
 * profile" (`panelProfileClaims` for a panel row), asked to spot a duplicate.
 */
export async function judgePanelRowReadback(
  client: Pick<Prisma.TransactionClient, 'profileSyncJob' | 'subscription'>,
  input: {
    readonly existing: ReadbackRow | null;
    readonly panel: Pick<RemnawavePanelUser, 'status' | 'trafficLimitBytes' | 'hwidDeviceLimit' | 'expireAt'> | null;
    readonly readAt: Date;
    readonly claims: readonly Prisma.SubscriptionWhereInput[];
  },
): Promise<TermModelReadbackVerdict | null> {
  const { existing, panel } = input;
  if (existing === null || panel === null || !isInTermModel(existing)) return null;
  return judgeTermModelReadback(client, {
    subscriptionId: existing.id,
    remnawaveId: existing.remnawaveId,
    columns: existing,
    stated: statedLimitsOf(panel),
    readAt: input.readAt,
    sharedProfile: await otherLiveRowsNameProfile(client, existing.id, input.claims),
    profileDeleted: panel.status.trim().toUpperCase() === 'DELETED',
    // Read here when the writer did not select it: a subscription with no end
    // must be known as one on every path, the backup re-imports' included.
    localExpiresAt:
      existing.expiresAt !== undefined
        ? existing.expiresAt
        : (await client.subscription.findUnique({ where: { id: existing.id }, select: { expiresAt: true } }))
            ?.expiresAt,
    statedExpiresAt: panelExpiryToLocal(panel.expireAt),
  });
}

/**
 * A writer's own data for an UPDATE of a row in the term model, less what the
 * verdict withholds: the limits always, the expiry unless `takeExpiry`, the
 * status unless `takeStatus` — and, on a row with no end (`keepsOpenEnd`), a
 * stated date and an EXPIRED derived from it. Every other field goes out as
 * the writer built it.
 */
export function withoutWithheldReadbackFields<T extends object>(data: T, verdict: TermModelReadbackVerdict): T {
  const { trafficLimit: _limitTraffic, deviceLimit: _limitDevices, expiresAt, status, ...rest } = data as T & {
    readonly trafficLimit?: unknown;
    readonly deviceLimit?: unknown;
    readonly expiresAt?: unknown;
    readonly status?: unknown;
  };
  const kept = {
    ...rest,
    ...(verdict.takeExpiry && expiresAt !== undefined ? { expiresAt } : {}),
    ...(verdict.takeStatus && status !== undefined ? { status } : {}),
  } as T;
  return verdict.keepsOpenEnd ? withLocalOpenEndKept(kept, null) : kept;
}

/**
 * What comes AFTER the writer's write: the put-back queued when the verdict
 * asks for one, and the one line saying what became of the profile's limits.
 * `enqueue` hands the job to the queue when the caller has one; without it the
 * five-minute profile-sync sweep picks the PENDING row up. Returns the job id.
 */
export async function finishTermModelReadback(
  client: Pick<Prisma.TransactionClient, 'profileSyncJob'>,
  verdict: TermModelReadbackVerdict,
  input: {
    readonly subscriptionId: string;
    readonly profile: string;
    readonly source: string;
    readonly logger: { log(message: string): void; warn(message: string): void };
    readonly enqueue?: (syncJobId: string) => Promise<void>;
  },
): Promise<string | null> {
  const said = describeLimitsVerdict(verdict.limits, input);
  if (verdict.limits !== 'PUT_BACK') {
    if (said !== null) input.logger.warn(said);
    return null;
  }
  const syncJobId = await queuePanelLimitsPutBack(client, input.subscriptionId);
  input.logger.log(`${said} (sync job ${syncJobId})`);
  if (input.enqueue !== undefined) {
    try {
      await input.enqueue(syncJobId);
    } catch (err: unknown) {
      input.logger.warn(
        `Sync job ${syncJobId} not queued, the profile-sync sweep will: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return syncJobId;
}

/**
 * The one log line for a verdict that leaves a profile holding other limits
 * than rezeis pushes — `null` when there is nothing to say.
 */
export function describeLimitsVerdict(
  verdict: PanelLimitsVerdict,
  input: { readonly subscriptionId: string; readonly profile: string; readonly source: string },
): string | null {
  const head =
    `${input.source}: Remnawave profile ${input.profile} holds other limits than subscription ` +
    `${input.subscriptionId} (in the term model)`;
  switch (verdict) {
    case 'PUT_BACK':
      return `${head}; pushing the panel's limits back`;
    case 'PROFILE_DELETED':
      return `${head}, which were not pushed back: the panel reports the profile deleted`;
    case 'SHARED_PROFILE':
      return `${head}, which were not pushed back: more than one live subscription names this profile — merge the duplicates`;
    case 'UNLINKED':
      return `${head}, which were not pushed back: the row has no panel link`;
    default:
      return null;
  }
}

/** Live rows other than `subscriptionId` that `claims` name — a duplicate pair when any. */
export async function otherLiveRowsNameProfile(
  client: Pick<Prisma.TransactionClient, 'subscription'>,
  subscriptionId: string,
  claims: readonly Prisma.SubscriptionWhereInput[],
): Promise<boolean> {
  const other = await client.subscription.findFirst({
    where: {
      id: { not: subscriptionId },
      status: { not: SubscriptionStatus.DELETED },
      OR: [...claims],
    },
    select: { id: true },
  });
  return other !== null;
}
