import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SubscriptionStatus, SyncJobStatus } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../common/services/system-events.service';
import { panelShortUuidFromConfigUrl } from '../remnawave/services/panel-user-address';
import { PanelUsersClient } from '../remnawave/services/panel-users.client';
import { PanelLinkReconciliationService } from './panel-link-reconciliation.service';
import { assertPanelProfileOwnership, readPanelFailure } from './profile-sync.processor';

/** How many PAIRS one invocation may merge. Each costs the panel two resolves. */
export const DUPLICATE_MERGE_DEFAULT_LIMIT = 25;
export const DUPLICATE_MERGE_MAX_LIMIT = 200;

/**
 * What happened to ONE pair. There is no silent third state: a pair is written,
 * previewed, or refused BY NAME with the check that refused it.
 */
export type DuplicateMergeOutcome =
  /** The merge was written. */
  | 'merged'
  /** A dry run: every check passed and a real run would merge. */
  | 'wouldMerge'
  /** A check failed. {@link DuplicateMergeRow.refusal} says which. */
  | 'refused';

/**
 * WHY THE REFUSAL IS A CODE AND NOT ONLY A SENTENCE. An operator merging a
 * batch has to be able to sort "the panel was briefly unreachable" (retry) from
 * "these are two different customers" (never retry) without parsing prose, and
 * a UI has to be able to colour them differently.
 */
export type DuplicateMergeRefusal =
  /** One of the two ids names no row at all. */
  | 'survivorMissing'
  | 'duplicateMissing'
  /** The same id was handed in twice. */
  | 'sameSubscription'
  /** The two rows belong to DIFFERENT customers. Never merge. */
  | 'differentCustomers'
  /** One of the two is already DELETED; there is nothing left to merge. */
  | 'alreadyRetired'
  /** The nominated survivor is not the older row. */
  | 'survivorNotOlder'
  /** The panel would not name a profile for that row's own resolve route. */
  | 'survivorUnresolved'
  | 'duplicateUnresolved'
  /** The two rows resolve to DIFFERENT panel profiles. Never merge. */
  | 'differentPanelProfiles'
  /** The profile resolved but could not be read back. */
  | 'profileUnreadable'
  /** The profile carries somebody else's `reiwa_id` marker. */
  | 'notOwned'
  /** Neither row is bound to the profile they resolve to. */
  | 'neitherHoldsIdentity'
  /**
   * The duplicate carries entitlement-lifecycle history — terms, add-on
   * entitlements, an effective projection, device-reduction plans or
   * entitlement incidents. See {@link BLOCKING_RELATIONS}.
   */
  | 'entitlementHistoryOnDuplicate'
  /** Both rows hold a trial claim, and `trial_claims.subscription_id` is UNIQUE. */
  | 'trialClaimOnBoth'
  /** A sync job for the duplicate is RUNNING and may already be mid-flight. */
  | 'syncJobRunning'
  /** A row changed under the merge while it was in flight; nothing was written. */
  | 'raceLost';

/** One relation, and how many of its rows moved (or would move). */
export interface DuplicateMergeReattachment {
  /** The Prisma relation name on `Subscription`. */
  readonly relation: string;
  /** The model that carries the foreign key. */
  readonly model: string;
  /** The column that carries it, as it is spelled in the database. */
  readonly column: string;
  readonly moved: number;
}

export interface DuplicateMergeRow {
  /** The OLDER row. It survives and keeps everything except the identity. */
  readonly survivorSubscriptionId: string;
  /** The NEWER row the importer minted. It is retired. */
  readonly duplicateSubscriptionId: string;
  readonly userId: string | null;
  readonly outcome: DuplicateMergeOutcome;
  readonly refusal: DuplicateMergeRefusal | null;
  readonly reason: string | null;
  /** The identity that moved (or would move) onto the survivor. */
  readonly remnawaveId: string | null;
  readonly remnawavePanelId: number | null;
  readonly panelUsername: string | null;
  readonly configUrl: string | null;
  /**
   * What the survivor held BEFORE the move, and what the duplicate held.
   *
   * These two are the undo. Without them the audit says where the identity
   * landed and not where it came from, and a merge sent to the wrong pair
   * cannot be reversed by hand.
   */
  readonly survivorPreviousRemnawaveId: string | null;
  readonly survivorPreviousPanelId: number | null;
  readonly duplicatePreviousRemnawaveId: string | null;
  readonly duplicatePreviousPanelId: number | null;
  /**
   * WHICH HALF IS BOUND TO THE LIVE PANEL PROFILE, as of the verification that
   * produced this row — the same instant {@link survivorPreviousRemnawaveId}
   * and its three siblings describe, and NOT the state after a write. On a
   * `merged` row the survivor holds the identity by definition afterwards;
   * what the operator cannot reconstruct is where it came from, so that is
   * what these two state.
   *
   * SAME SPELLING AND SAME QUESTION as
   * {@link PanelLinkReconciliationRow.holdsLiveIdentity}: is THIS subscription
   * row bound to the panel profile the sweep resolved? One field per half,
   * because a pair has two rows and "the pair holds it" is not an answer
   * anybody can act on. Both are derived by calling {@link namesProfile} —
   * the one implementation of the two-spellings rule (a 2.x profile keeps its
   * uuid in `remnawave_id` while its numeric id lives in
   * `remnawave_panel_id`, and a numeric id may itself be stored as a decimal
   * STRING in `remnawave_id`). A second copy of that rule anywhere — in this
   * file or in the SPA — is a copy that can disagree about polarity, and the
   * cost of disagreeing is an operator issuing a panel DELETE against a paying
   * customer's live profile.
   *
   * `null` on BOTH when this pair never got as far as naming a panel profile:
   * every refusal raised before the resolve round-trip leaves the question
   * unanswered, and an unanswered question must not read as "not bound".
   */
  readonly survivorHoldsLiveIdentity: boolean | null;
  readonly duplicateHoldsLiveIdentity: boolean | null;
  /** Every relation that moved, or would move, with its count. */
  readonly reattached: readonly DuplicateMergeReattachment[];
  /** Non-terminal sync jobs of the duplicate that were (or would be) superseded. */
  readonly supersededSyncJobs: number;
}

/**
 * WHY A BATCH STOPPED BEFORE IT REACHED THE END OF ITS PAIRS.
 *
 * `null` on any run that examined every pair it was handed — including a run in
 * which every one of them refused, which is a COMPLETE run that merged nothing
 * and not a stopped one.
 *
 * A BATCH IS NOT ATOMIC AND CANNOT BE MADE SO. Each pair is its own
 * transaction, because one transaction spanning a whole batch would hold the
 * profile advisory lock across every panel round-trip in it. So by the time
 * pair `n` fails, pairs `1..n-1` are COMMITTED — and the duplicate's identity
 * columns are NULL by then, which makes the run's audit row the ONLY surviving
 * record of what moved and where it came from. That audit is written by
 * `AdminDuplicateSubscriptionMergeController` AFTER this call returns, so a
 * throw escaping `merge()` would take it down with it and leave every merge in
 * the batch unrecorded. The failure is therefore reported HERE and the call
 * returns normally.
 *
 * Nothing is swallowed by that: the failing pair also appears in
 * {@link DuplicateMergeReport.rows} as a `raceLost` refusal naming the error,
 * an ERROR-severity system event is emitted, and `nextCursor` does not advance
 * past the pair that failed.
 */
export interface DuplicateMergeStop {
  /** The pair whose transaction failed, in the order it was handed in. */
  readonly survivorSubscriptionId: string;
  readonly duplicateSubscriptionId: string;
  /**
   * How many pairs were examined BEFORE it — the ones a real run has already
   * committed and whose per-pair detail is in this report and its audit row.
   */
  readonly pairsCompleted: number;
  /** The error's class name, e.g. `PrismaClientKnownRequestError`. */
  readonly errorName: string;
  /** Prisma's own code when it carries one — `P2002`, `P2028` — else `null`. */
  readonly errorCode: string | null;
  readonly message: string;
}

export interface DuplicateMergeReport {
  readonly dryRun: boolean;
  readonly pairsExamined: number;
  readonly merged: number;
  readonly wouldMerge: number;
  readonly refused: number;
  readonly rows: readonly DuplicateMergeRow[];
  /**
   * Set when a pair's transaction failed and the batch stopped there; `null` on
   * a run that reached the end of its pairs. See {@link DuplicateMergeStop}.
   */
  readonly stoppedEarly: DuplicateMergeStop | null;
  /** `true` when the DISCOVERY sweep stopped at its cap with rows remaining. */
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  /**
   * The panel era the discovery sweep reports; `null` on an explicit list,
   * where no sweep ran.
   *
   * Only ever `PANEL_ERA_3X` now — a 2.x panel is refused centrally by
   * `LegacyPanelRefusal`, so there is nothing left to discover. The field stays
   * because the operator SPA reads it and because reports stored on older audit
   * rows carry the other value.
   */
  readonly panelEra: string | null;
}

export interface DuplicateMergePairInput {
  readonly survivorSubscriptionId: string;
  readonly duplicateSubscriptionId: string;
}

export interface DuplicateMergeOptions {
  /**
   * Writes happen ONLY on an explicit `false`. Anything else — omitted,
   * mistyped, the string `'false'` off a query string or a form — previews.
   */
  readonly dryRun?: boolean;
  /**
   * An explicit list of pairs. When empty or omitted the service DISCOVERS
   * pairs by running the diagnosis sweep. Either way every pair is re-verified
   * from scratch before anything is written.
   */
  readonly pairs?: readonly DuplicateMergePairInput[];
  readonly limit?: number;
  readonly chunkSize?: number;
  readonly startAfterId?: string | null;
}

/**
 * The columns a merge reads off either half. Nothing else is needed, and
 * `planSnapshot` is deliberately ABSENT: a value that is never read cannot be
 * written back by accident.
 */
interface MergeSideRow {
  readonly id: string;
  readonly userId: string;
  readonly status: SubscriptionStatus;
  readonly createdAt: Date;
  readonly remnawaveId: string | null;
  readonly remnawavePanelId: number | null;
  readonly remnawavePanelUsername: string | null;
  readonly configUrl: string | null;
}

const MERGE_SIDE_SELECT = {
  id: true,
  userId: true,
  status: true,
  createdAt: true,
  remnawaveId: true,
  remnawavePanelId: true,
  remnawavePanelUsername: true,
  configUrl: true,
} as const;

/**
 * EVERY relation on `Subscription` that a merge MOVES, in the order it moves
 * them. Enumerated from `prisma/schema.prisma`, and the enumeration is the
 * contract: a relation added to the schema and not added here is a relation
 * that would be silently orphaned, which is the one failure mode worse than a
 * refused merge.
 *
 * All seven are safe to move for the same two reasons: the two rows belong to
 * ONE customer (proven before any write), and none of these columns carries a
 * uniqueness constraint that the survivor's own rows could collide with —
 * except `trial_claims.subscription_id`, which is UNIQUE and is therefore
 * moved only when the survivor holds no claim of its own (a pair where both
 * hold one is refused outright, see `trialClaimOnBoth`).
 */
const MOVED_RELATIONS = [
  {
    relation: 'transactions',
    model: 'Transaction',
    column: 'subscription_id',
    // Nullable, `onDelete: SetNull`, NOT unique. A payment left pointing at a
    // retired row is a payment that vanishes from the customer's history and
    // from every revenue report that joins through the surviving subscription.
    move: (tx: MergeTx, from: string, to: string) =>
      tx.transaction.updateMany({ where: { subscriptionId: from }, data: { subscriptionId: to } }),
    count: (client: CountClient, id: string) => client.transaction.count({ where: { subscriptionId: id } }),
  },
  {
    relation: 'transactionItems',
    model: 'TransactionItem',
    column: 'subscription_id',
    // Non-null, `onDelete: Restrict`, NOT unique. The receipt lines behind the
    // payments above; they have to name the same row the payment does.
    move: (tx: MergeTx, from: string, to: string) =>
      tx.transactionItem.updateMany({ where: { subscriptionId: from }, data: { subscriptionId: to } }),
    count: (client: CountClient, id: string) =>
      client.transactionItem.count({ where: { subscriptionId: id } }),
  },
  {
    relation: 'promocodeActivations',
    model: 'PromocodeActivation',
    column: 'target_subscription_id',
    // Nullable, `onDelete: SetNull`, NOT unique. The record that a promocode
    // was spent ON this customer's service; it is also what stops a code being
    // redeemed twice.
    move: (tx: MergeTx, from: string, to: string) =>
      tx.promocodeActivation.updateMany({
        where: { targetSubscriptionId: from },
        data: { targetSubscriptionId: to },
      }),
    count: (client: CountClient, id: string) =>
      client.promocodeActivation.count({ where: { targetSubscriptionId: id } }),
  },
  {
    relation: 'referralPointsExchanges',
    model: 'ReferralPointsExchange',
    column: 'target_subscription_id',
    // Nullable, `onDelete: SetNull`, NOT unique. Referral points the customer
    // already spent on this service.
    move: (tx: MergeTx, from: string, to: string) =>
      tx.referralPointsExchange.updateMany({
        where: { targetSubscriptionId: from },
        data: { targetSubscriptionId: to },
      }),
    count: (client: CountClient, id: string) =>
      client.referralPointsExchange.count({ where: { targetSubscriptionId: id } }),
  },
  {
    relation: 'trialClaim',
    model: 'TrialClaim',
    column: 'subscription_id',
    // Nullable and UNIQUE, `onDelete: SetNull`. The durable trial-quota ledger:
    // a CONSUMED row is immutable audit history and must keep naming a row that
    // exists. The uniqueness is why a pair holding two claims is refused rather
    // than merged — releasing or consuming one of them is the ledger's own
    // rule, not this service's to invent.
    move: (tx: MergeTx, from: string, to: string) =>
      tx.trialClaim.updateMany({ where: { subscriptionId: from }, data: { subscriptionId: to } }),
    count: (client: CountClient, id: string) => client.trialClaim.count({ where: { subscriptionId: id } }),
  },
] as const;

/**
 * `User.current_subscription_id` — the pointer the cabinet reads to decide
 * which card to open on. Handled apart from {@link MOVED_RELATIONS} because it
 * is REPOINTED rather than moved: the column lives on `User`, is UNIQUE there,
 * and is only touched when it actually names the duplicate.
 */
const CURRENT_SUBSCRIPTION_RELATION = {
  relation: 'currentSubscriptionOf',
  model: 'User',
  column: 'current_subscription_id',
} as const;

/**
 * `ProfileSyncJob.subscription_id` — the one relation that deliberately STAYS.
 *
 * A sync job is the history of panel mutations attempted FOR THAT ROW, carrying
 * a payload that names the profile as it stood when the job was created. Moving
 * it would re-file another row's attempts under the survivor and, for a job
 * that has not run yet, would point a live worker at the surviving row.
 *
 * The jobs are not merely left alone, though: every non-terminal one is
 * SUPERSEDED. A PENDING `DELETE` job on the duplicate names the LIVE profile in
 * its payload, and the profile now belongs to the survivor — running it would
 * delete a paying customer's service. `claimSyncJob` refuses any job with
 * `supersededAt` set, so superseding is what defuses it. A job already RUNNING
 * cannot be recalled, which is why such a pair is refused instead.
 */
const SYNC_JOB_RELATION = {
  relation: 'syncJobs',
  model: 'ProfileSyncJob',
  column: 'subscription_id',
} as const;

/**
 * The relations that BLOCK a merge when the duplicate carries any of them.
 *
 * These five are ONE interlocked graph, not five independent lists:
 *   • `subscription_terms` is UNIQUE on `(subscription_id, generation)`, and
 *     both halves of a pair number their generations from the same base, so
 *     moving terms collides the moment the survivor has any of its own.
 *     Renumbering a generation is a lifecycle rewrite, not a re-parent.
 *   • `add_on_entitlements` carries a COMPOSITE foreign key
 *     `(term_id, subscription_id) → subscription_terms(id, subscription_id)`.
 *     Prisma declares it NOT DEFERRABLE, so there is no statement order that
 *     re-parents both: updating the term first dangles the entitlement,
 *     updating the entitlement first points it at a term row that does not yet
 *     exist under that subscription.
 *   • `subscription_effective_projections.subscription_id` is UNIQUE, and the
 *     projection is anchored to a `baseline_term_id`.
 *   • `device_reduction_plans` is UNIQUE on `(subscription_id,
 *     projection_revision)` and hangs off that projection.
 *   • `entitlement_incidents` reference the entitlements above.
 *
 * So a pair whose duplicate carries any of them is REFUSED and named, which is
 * the outcome this service prefers to a silent choice. In the population this
 * defect actually produced the group is always empty: the duplicate was minted
 * by `RemnawaveImporterService`, which writes a bare `subscriptions` row and
 * creates no term, no projection and no entitlement — those come only from
 * `SubscriptionTermService.create` and `EffectiveProjectionService`, which the
 * importer never calls.
 */
const BLOCKING_RELATIONS = [
  {
    relation: 'terms',
    model: 'SubscriptionTerm',
    column: 'subscription_id',
    count: (client: CountClient, id: string) =>
      client.subscriptionTerm.count({ where: { subscriptionId: id } }),
  },
  {
    relation: 'addOnEntitlements',
    model: 'AddOnEntitlement',
    column: 'subscription_id',
    count: (client: CountClient, id: string) =>
      client.addOnEntitlement.count({ where: { subscriptionId: id } }),
  },
  {
    relation: 'effectiveProjection',
    model: 'SubscriptionEffectiveProjection',
    column: 'subscription_id',
    count: (client: CountClient, id: string) =>
      client.subscriptionEffectiveProjection.count({ where: { subscriptionId: id } }),
  },
  {
    relation: 'deviceReductionPlans',
    model: 'DeviceReductionPlan',
    column: 'subscription_id',
    count: (client: CountClient, id: string) =>
      client.deviceReductionPlan.count({ where: { subscriptionId: id } }),
  },
  {
    relation: 'entitlementIncidents',
    model: 'EntitlementIncident',
    column: 'subscription_id',
    count: (client: CountClient, id: string) =>
      client.entitlementIncident.count({ where: { subscriptionId: id } }),
  },
] as const;

/** The Prisma surface a count needs — the service client or a transaction one. */
type CountClient = Pick<
  PrismaService,
  | 'transaction'
  | 'transactionItem'
  | 'promocodeActivation'
  | 'referralPointsExchange'
  | 'trialClaim'
  | 'subscriptionTerm'
  | 'addOnEntitlement'
  | 'subscriptionEffectiveProjection'
  | 'deviceReductionPlan'
  | 'entitlementIncident'
  | 'profileSyncJob'
  | 'user'
>;

/** The transaction client the reattachment closures write through. */
type MergeTx = Prisma.TransactionClient;

/**
 * DuplicateSubscriptionMergeService
 * ─────────────────────────────────
 * Resolves the duplicate PAIR that the Remnawave 2.x → 3.x identity split
 * produced: two local `subscriptions` rows for ONE customer on ONE panel
 * profile. `PanelLinkReconciliationService` diagnoses those pairs and stops;
 * this is the action it stops short of.
 *
 * ── THE SHAPE OF A PAIR, WHICH IS BACKWARDS FROM INSTINCT ────────────────────
 *
 * The OLDER row was linked in the 2.x era. It carries the customer's history,
 * their payments, their referral spends and the operator's plan — and it is
 * bound to NOTHING, because it stores a uuid a 3.x panel does not answer to.
 * The NEWER row is the duplicate the defect minted: it stores the current
 * decimal identity and it is the row pointing at the live profile.
 *
 * SO THE SURVIVOR IS THE OLDER ROW. It holds everything that matters, and the
 * already-fixed importer converges on the same choice (`orderBy: { createdAt:
 * 'asc' }`). A merge that kept the newer row would fight the importer for the
 * same customer on every subsequent sync.
 *
 * ── THE INVARIANT ────────────────────────────────────────────────────────────
 *
 * NOT ONE PANEL MUTATION MAY OCCUR. The panel's data is correct; only ours is
 * wrong. The only panel calls here are `resolvePanelIdentity` (a read behind a
 * POST) and `getPanelUserOutcome` (a profile read). No create, no update, no
 * delete — directly or transitively.
 *
 * TRANSITIVELY IS THE HARD HALF, and the hazard is precisely located.
 * `SubscriptionDeletionService.deleteSubscription` enqueues a `SyncAction.DELETE`
 * job for ANY row with `remnawaveId !== null`, and `ProfileSyncProcessor`
 * .handleDelete` then calls `deletePanelUser`. On a 3.x panel that job does NOT
 * fail closed on a dead 2.x uuid — and WHICH material carries it to the live
 * profile depends on what the job itself is holding, which is worth stating
 * exactly, because the two routes live in two different functions:
 *   • A PAYLOAD-BEARING job — every one `deleteSubscription` writes today, since
 *     it records `targetRemnawaveId`, `targetRemnawavePanelId` and
 *     `targetRemnawavePanelUsername` together under one `FOR UPDATE` — is
 *     addressed through `readTargetIdentity`, and that helper supplies NO
 *     `panelShortUuid` AT ALL. Its identity WINS over anything derived from the
 *     row (`handleDelete` prefers it whenever it carries a panel id or a panel
 *     username), so the reach is via `targetRemnawavePanelId` /
 *     `targetRemnawavePanelUsername` and never via `config_url`.
 *   • Only a job carrying NEITHER of those falls through to
 *     `deleteTargetIdentity`, which re-reads the row — and that is the one place
 *     the short UUID recovered from `config_url`, and after it the username,
 *     comes in.
 * Either way `panelUserAddress` lands on the LIVE profile, so both halves of a
 * pair are dangerous to delete, not only the half holding the decimal.
 *
 * TWO CONSEQUENCES, both load-bearing:
 *   1. THE RETIREMENT DOES NOT GO THROUGH `SubscriptionDeletionService`. The row
 *      is retired here, directly, so the DELETE-job path is never entered.
 *   2. THE DUPLICATE'S IDENTITY COLUMNS ARE CLEARED IN THE SAME STATEMENT THAT
 *      SETS ITS STATUS. The job-creation condition is literally
 *      `remnawaveId !== null`, so a row that is DELETED while still holding an
 *      identity is a loaded gun for any later manual delete; a row retired with
 *      its identity already null cannot produce a job at all. There is no
 *      instant, inside the transaction or after it, at which this row is
 *      `DELETED` and still names a profile.
 *
 * ── THE ORDER OF THE TWO IDENTITY WRITES ─────────────────────────────────────
 *
 * The duplicate is retired FIRST and the survivor claims the identity SECOND,
 * inside one transaction. Both halves live in one atomic step, so neither
 * intermediate is observable — but the order is still chosen rather than
 * incidental, because it is the order that is safe if the invariant ever
 * weakens: "nobody holds it" strands a row for the reconciliation sweep to
 * repair, whereas "both hold it, both live" is two subscriptions overwriting
 * each other and deleting each other's service.
 */
@Injectable()
export class DuplicateSubscriptionMergeService {
  private readonly logger = new Logger(DuplicateSubscriptionMergeService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly panelUsers: PanelUsersClient,
    private readonly reconciliation: PanelLinkReconciliationService,
    private readonly events: SystemEventsService,
  ) {}

  public async merge(options: DuplicateMergeOptions = {}): Promise<DuplicateMergeReport> {
    // `!== false`, not `?? true`. This repository has a documented history of
    // `?flag=false` arriving as the STRING `'false'` and coercing to `true`; a
    // merge is the last place that may happen.
    const dryRun = options.dryRun !== false;
    const limit = clampPositive(options.limit, DUPLICATE_MERGE_DEFAULT_LIMIT, DUPLICATE_MERGE_MAX_LIMIT);

    const explicit = options.pairs ?? [];
    const discovery =
      explicit.length > 0
        ? { pairs: explicit, hasMore: false, nextCursor: null, panelEra: null }
        : // NOT bounded by `limit`. That caps the PAIRS this run merges; the
          // sweep's own budget caps the ROWS it scans, and a run that merged
          // fewer pairs than it found says so through `hasMore` rather than by
          // looking at less.
          await this.discoverPairs(options.chunkSize, options.startAfterId ?? null);

    // AN EXPLICIT LIST IS A CLAIM; A DISCOVERED PAIR IS NOT. When an operator
    // names the survivor, that nomination is checked and refused if it has the
    // polarity of this defect backwards. Discovery names no survivor at all — it
    // only says which two rows are a pair — so the merge derives the survivor
    // from `createdAt` and there is nothing to contradict.
    const nominated = explicit.length > 0;
    const rows: DuplicateMergeRow[] = [];
    let stoppedEarly: DuplicateMergeStop | null = null;
    for (const pair of discovery.pairs.slice(0, limit)) {
      // A COMMITTED MERGE MUST NEVER BE UNRECORDED, AND THIS IS WHERE THAT IS
      // DECIDED.
      //
      // Every pair is its own transaction, so by the time pair `n` throws,
      // pairs `1..n-1` are already COMMITTED — with the duplicate's identity
      // columns NULL, which makes the run's `adminAuditLog` row the only
      // surviving record of what moved and where it came from. That row is
      // written by the controller AFTER this method returns. A throw escaping
      // here would therefore skip it entirely and leave every merge in the
      // batch with NO audit at all: precisely the loss the controller's
      // "ENOUGH TO UNDO BY HAND" note says the audit exists to prevent.
      //
      // So the throw is converted, not propagated, and the run returns
      // normally with everything that committed already in `rows`.
      //
      // NOTHING WAS WRITTEN FOR THE FAILING PAIR EITHER, which is what makes
      // the conversion honest rather than a swallow. Every statement of a merge
      // runs inside `writeMerge`'s single `$transaction`: a `P2002` from
      // `trial_claims.subscription_id` or from the globally-UNIQUE
      // `users.current_subscription_id`, a `P2028` timed out waiting on the
      // profile advisory lock (whose key is shared with `persistProfileLink`
      // and the reconciliation sweep, so contention is BY DESIGN), or anything
      // else, all roll that pair back whole.
      //
      // REPORTED THROUGH `raceLost` RATHER THAN A NEW CODE. Every reachable
      // failure here is "in flight, rolled back, nothing written, try again",
      // which is exactly what that member means and which puts it in the
      // operator console's retry bucket. The union is also MIRRORED in the SPA
      // and drift-guarded by a spec that reads this file, so a code invented
      // here would fail that guard and, until it was mirrored, land the
      // operator in the unknown bucket with no verdict at all. What the code
      // cannot carry travels in the row's `reason` and in
      // {@link DuplicateMergeReport.stoppedEarly}, which names the error class
      // and Prisma's own code.
      try {
        rows.push(await this.mergePair(pair, dryRun, nominated));
      } catch (err: unknown) {
        stoppedEarly = describeStop(pair, rows.length, err);
        rows.push(stoppedRow(pair, stoppedEarly));
        this.logger.error(
          `Duplicate merge STOPPED at pair ${pair.survivorSubscriptionId}/` +
            `${pair.duplicateSubscriptionId} after ${stoppedEarly.pairsCompleted} pair(s): ` +
            `${describeStopError(stoppedEarly)}. That pair was rolled back whole; the run is ` +
            'being reported rather than thrown so the pairs already committed are audited.',
        );
        break;
      }
    }

    const merged = rows.filter((row) => row.outcome === 'merged').length;
    const wouldMerge = rows.filter((row) => row.outcome === 'wouldMerge').length;
    const refused = rows.filter((row) => row.outcome === 'refused').length;
    // THE CURSOR MUST NOT ADVANCE PAST A PAIR THIS RUN NEVER TOUCHED.
    //
    // Discovery scans rows and this run merges PAIRS, and the two are capped
    // separately: the sweep can hand back more pairs than `limit` allows. Its
    // `nextCursor` names the last ROW it examined, so reporting it after a
    // truncated run would tell the operator to resume beyond pairs that were
    // found and left alone — the silent skip this whole family of code exists to
    // stop producing. A truncated run therefore reports the cursor it STARTED
    // from: a real run re-reads the same window and finds the merged pairs gone
    // (a retired duplicate is no longer a live half), so the walk still
    // converges, one `limit` at a time.
    const truncated = discovery.pairs.length > limit;
    // A BATCH THAT STOPPED IS A TRUNCATED BATCH, and it obeys the same cursor
    // rule for the same reason: pairs after the failure were never looked at,
    // so a cursor advanced past them would tell the operator to resume beyond
    // work nobody did.
    const incomplete = truncated || stoppedEarly !== null;
    const report: DuplicateMergeReport = {
      dryRun,
      pairsExamined: rows.length,
      merged,
      wouldMerge,
      refused,
      rows,
      stoppedEarly,
      hasMore: discovery.hasMore || incomplete,
      nextCursor: incomplete ? (options.startAfterId ?? null) : discovery.nextCursor,
      panelEra: discovery.panelEra,
    };

    if (rows.length > 0) {
      const summary = dryRun
        ? `Duplicate subscription merge (dry run): ${wouldMerge} of ${rows.length} pairs mergeable`
        : `Duplicate subscription merge: merged ${merged} of ${rows.length} pairs`;
      const metadata = {
        dryRun,
        pairsExamined: rows.length,
        merged,
        wouldMerge,
        refused,
        hasMore: report.hasMore,
        stoppedEarly: stoppedEarly !== null,
      };
      if (stoppedEarly === null) {
        this.events.info(EVENT_TYPES.SYSTEM_REMNAWAVE_SYNC, 'SYSTEM', summary, metadata);
      } else {
        // ERROR, NOT INFO, and it says the batch stopped in the SENTENCE rather
        // than only in a metadata flag. An operator reading the event feed has
        // to be able to tell "this run finished and refused four pairs" from
        // "this run stopped and the pairs after the failure were never looked
        // at" without opening the payload.
        this.events.error(
          EVENT_TYPES.SYSTEM_REMNAWAVE_SYNC,
          'SYSTEM',
          `${summary}; the batch STOPPED at pair ${stoppedEarly.survivorSubscriptionId}/` +
            `${stoppedEarly.duplicateSubscriptionId} (${describeStopError(stoppedEarly)}). ` +
            `The ${stoppedEarly.pairsCompleted} pair(s) before it are committed and audited; ` +
            'that pair and everything after it were not. Re-run to continue.',
          { ...metadata, stop: { ...stoppedEarly } },
        );
      }
    }
    return report;
  }

  /**
   * Finds pairs by running the DIAGNOSIS sweep in dry-run and reading its
   * `duplicatePair` verdicts.
   *
   * DELEGATED RATHER THAN REIMPLEMENTED. There is exactly one sound definition
   * of "these two rows are the pair the identity split produced" — same
   * customer, both live, one panel profile, ownership proven — and a second
   * copy of it here would be a second thing to keep in agreement with the
   * first. `reconcile` is asked for a PREVIEW, so discovery itself writes
   * nothing.
   *
   * THE VERDICT IS STILL NOT TRUSTED. Every pair it names is re-verified from
   * the database and the panel by {@link mergePair} before a byte is written;
   * this call decides only WHICH pairs to look at.
   */
  private async discoverPairs(
    chunkSize: number | undefined,
    startAfterId: string | null,
  ): Promise<{
    pairs: DuplicateMergePairInput[];
    hasMore: boolean;
    nextCursor: string | null;
    panelEra: string | null;
  }> {
    const report = await this.reconciliation.reconcile({
      dryRun: true,
      chunkSize,
      startAfterId,
    });
    // Each pair contributes TWO rows to `unrepaired`, so they are de-duplicated
    // on the unordered id-pair before anything is merged. A pair merged twice
    // would refuse the second time (`alreadyRetired`), but reporting one pair as
    // two is exactly the kind of report an operator acts on wrongly.
    const seen = new Set<string>();
    const pairs: DuplicateMergePairInput[] = [];
    for (const row of report.unrepaired) {
      if (row.outcome !== 'duplicatePair') continue;
      const partner = row.duplicateOfSubscriptionId;
      if (partner === null) continue;
      const key = [row.subscriptionId, partner].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      // WHICH HALF SURVIVES IS NOT DECIDED HERE. `mergePair` re-reads both rows
      // and orders them by `createdAt` itself; this only carries the two ids in
      // the order the sweep happened to emit them.
      pairs.push({
        survivorSubscriptionId: row.subscriptionId,
        duplicateSubscriptionId: partner,
      });
    }
    return {
      pairs,
      hasMore: report.hasMore,
      nextCursor: report.nextCursor,
      panelEra: report.panelEra,
    };
  }

  /**
   * ONE pair, re-verified from scratch and then merged.
   *
   * NOTHING HANDED IN IS TRUSTED — not which row survives, not that they belong
   * to one customer, not that they are the same profile, not that either is
   * still live. A merge driven by a stale report is how the wrong customer
   * loses a subscription, and a report goes stale the moment anything else
   * touches either row.
   */
  private async mergePair(
    input: DuplicateMergePairInput,
    dryRun: boolean,
    nominated: boolean,
  ): Promise<DuplicateMergeRow> {
    const first = input.survivorSubscriptionId;
    const second = input.duplicateSubscriptionId;
    const blank = (
      survivorId: string,
      duplicateId: string,
      userId: string | null,
      refusal: DuplicateMergeRefusal,
      reason: string,
    ): DuplicateMergeRow => ({
      survivorSubscriptionId: survivorId,
      duplicateSubscriptionId: duplicateId,
      userId,
      outcome: 'refused',
      refusal,
      reason,
      remnawaveId: null,
      remnawavePanelId: null,
      panelUsername: null,
      configUrl: null,
      survivorPreviousRemnawaveId: null,
      survivorPreviousPanelId: null,
      duplicatePreviousRemnawaveId: null,
      duplicatePreviousPanelId: null,
      survivorHoldsLiveIdentity: null,
      duplicateHoldsLiveIdentity: null,
      reattached: [],
      supersededSyncJobs: 0,
    });

    if (first === second) {
      return blank(
        first,
        second,
        null,
        'sameSubscription',
        `subscription ${first} was named as BOTH halves of the pair; a row cannot be merged into itself`,
      );
    }

    const loaded = await this.prismaService.subscription.findMany({
      where: { id: { in: [first, second] } },
      select: MERGE_SIDE_SELECT,
    });
    const left = loaded.find((row) => row.id === first) ?? null;
    const right = loaded.find((row) => row.id === second) ?? null;
    if (left === null) {
      return blank(first, second, null, 'survivorMissing', `subscription ${first} does not exist`);
    }
    if (right === null) {
      return blank(first, second, null, 'duplicateMissing', `subscription ${second} does not exist`);
    }

    // ── SAME CUSTOMER ────────────────────────────────────────────────────────
    // Asked before anything else that could be mistaken for progress. Two rows
    // of two customers are never a pair, whatever the panel says about them,
    // and merging them would hand one customer the other's payments.
    if (left.userId !== right.userId) {
      return blank(
        first,
        second,
        null,
        'differentCustomers',
        `subscription ${first} belongs to customer ${left.userId} and ${second} to customer ` +
          `${right.userId}. These are two different customers, not the pair the 2.x/3.x identity ` +
          'split produces, and merging them would move one customer history onto the other. ' +
          'Nothing was changed.',
      );
    }
    const userId = left.userId;

    if (
      left.status === SubscriptionStatus.DELETED ||
      right.status === SubscriptionStatus.DELETED
    ) {
      const retired = left.status === SubscriptionStatus.DELETED ? left.id : right.id;
      return blank(
        first,
        second,
        userId,
        'alreadyRetired',
        `subscription ${retired} is already DELETED, so this pair is not two live rows and there ` +
          'is nothing to merge. Nothing was changed.',
      );
    }

    // ── WHICH ONE IS THE SURVIVOR ────────────────────────────────────────────
    // DERIVED, never accepted. The survivor is the strictly OLDER row: it is the
    // one carrying the customer history and the operator's plan, and it is the
    // one the fixed importer converges on. Equal timestamps refuse rather than
    // pick, because at that point nothing in the data says which is which.
    const leftOlder = left.createdAt.getTime() < right.createdAt.getTime();
    const rightOlder = right.createdAt.getTime() < left.createdAt.getTime();
    if (!leftOlder && !rightOlder) {
      return blank(
        first,
        second,
        userId,
        'survivorNotOlder',
        `subscriptions ${first} and ${second} were created at the same instant ` +
          `(${left.createdAt.toISOString()}), so which one carries the customer history cannot be ` +
          'derived. Nothing was changed.',
      );
    }
    const survivor = leftOlder ? left : right;
    const duplicate = leftOlder ? right : left;
    if (nominated && survivor.id !== input.survivorSubscriptionId) {
      // The caller nominated the NEWER row as the survivor. Refused rather than
      // silently corrected: an operator who believes the newer row is the one
      // to keep has the polarity of this defect backwards, and a merge that
      // quietly did the opposite of what they asked would teach them nothing.
      //
      // Only for a NOMINATED pair. Discovery hands over two ids in whatever
      // order the sweep emitted them and claims nothing about which is which,
      // so refusing it here would turn the sweep's emission order into a
      // correctness requirement it never promised to meet.
      return blank(
        input.survivorSubscriptionId,
        input.duplicateSubscriptionId,
        userId,
        'survivorNotOlder',
        `subscription ${input.survivorSubscriptionId} is the NEWER row (created ` +
          `${duplicate.createdAt.toISOString()}); the survivor must be the OLDER one, ` +
          `${survivor.id} (created ${survivor.createdAt.toISOString()}), because that is the row ` +
          'carrying the payments, the referral spends and the operator plan. Re-issue the merge ' +
          'with the two ids the other way round. Nothing was changed.',
      );
    }

    // ANSWERED LATE, REPORTED EARLY. "Is this half bound to the live profile?"
    // cannot be asked until the panel has named one, and several refusals are
    // raised after that point — so the answer is filled in the moment it exists
    // and every refusal from then on carries it. Before that it stays `null`,
    // which is the honest reading of a question nobody could ask yet; `false`
    // there would be this report claiming a row is unbound when it never looked.
    const holders: {
      survivor: boolean | null;
      duplicate: boolean | null;
    } = { survivor: null, duplicate: null };

    const refuse = (refusal: DuplicateMergeRefusal, reason: string): DuplicateMergeRow => ({
      ...blank(survivor.id, duplicate.id, userId, refusal, reason),
      survivorPreviousRemnawaveId: survivor.remnawaveId,
      survivorPreviousPanelId: survivor.remnawavePanelId,
      duplicatePreviousRemnawaveId: duplicate.remnawaveId,
      duplicatePreviousPanelId: duplicate.remnawavePanelId,
      survivorHoldsLiveIdentity: holders.survivor,
      duplicateHoldsLiveIdentity: holders.duplicate,
    });

    // ── THE SAME LIVE PANEL PROFILE ──────────────────────────────────────────
    // Each half is resolved through ITS OWN route — the short UUID recovered
    // from its `config_url`, or failing that its stored panel username — and the
    // two answers must name the same numeric profile. Where those routes are
    // different KEYS these are two independent resolves rather than one resolve
    // plus a column comparison, and that is the point: comparing our own two
    // columns would prove only that our own two rows agree with each other,
    // which is exactly what a pair written by the same broken importer would do
    // anyway.
    //
    // THE INDEPENDENCE IS NOT UNIVERSAL, AND THE LIMIT IS NAMED HERE RATHER
    // THAN LEFT TO BE DISCOVERED. `panelShortUuidFromConfigUrl` yields `null`
    // for a row with no `config_url` and for any stored URL whose path is
    // neither `…/sub/<id>` nor `…/api/sub/<id>` nor a single bare segment — so
    // `routeOf` falls back to `remnawave_panel_username`. And a duplicate pair
    // carries the SAME username on BOTH halves by construction:
    // `RemnawaveImporterService` writes `remnawavePanelUsername:
    // panelUser.username` off the panel row, and both halves were written from
    // the one profile. So when BOTH halves fall back to the username this is
    // ONE selector resolved twice; the two answers cannot disagree, and the
    // `survivorResolved.id !== duplicateResolved.id` guard below can never fire.
    //
    // THAT ROUTE IS LEFT USABLE RATHER THAN REFUSED, deliberately. Rows whose
    // `config_url` was never recorded are precisely the 2.x-era population this
    // merge exists to repair; refusing them would strand the pairs it was built
    // for. What still stands on that route is everything AFTER the comparison,
    // and none of it is derived from the username: the profile read-back that
    // proves the `reiwa_id` marker names THIS customer, and `namesProfile`,
    // which requires one of the two halves to be bound to the resolved NUMERIC
    // id. The comparison is what becomes vacuous, not the verification.
    const survivorRoute = routeOf(survivor);
    const duplicateRoute = routeOf(duplicate);
    if (survivorRoute === null) {
      return refuse(
        'survivorUnresolved',
        `subscription ${survivor.id} carries neither a subscription short UUID in its config URL ` +
          'nor a panel username, so there is no way to ask the panel which profile it owns. ' +
          'Nothing was changed.',
      );
    }
    if (duplicateRoute === null) {
      return refuse(
        'duplicateUnresolved',
        `subscription ${duplicate.id} carries neither a subscription short UUID in its config URL ` +
          'nor a panel username, so the claim that it names the same profile cannot be checked ' +
          'independently. Nothing was changed.',
      );
    }

    // WHY THE PANEL COULD NOT ANSWER IS PART OF THE REFUSAL. The method this
    // replaces answered `null` for a missing profile, an expired token, a 5xx
    // and a timeout alike, so a merge attempted during an outage told the
    // operator every pair was unresolvable — indistinguishable from "these rows
    // genuinely do not name a profile", which is the one reading that would
    // send them looking for a repair instead of waiting for the panel.
    const survivorOutcome = await this.panelUsers.resolveUser(survivorRoute.selector);
    if (survivorOutcome.kind !== 'ok') {
      const failure = readPanelFailure(survivorOutcome);
      return refuse(
        'survivorUnresolved',
        failure.kind === 'missing'
          ? `the panel did not resolve ${describeRoute(survivorRoute)} for subscription ` +
            `${survivor.id}. Nothing was changed.`
          : `the panel could not be asked about ${describeRoute(survivorRoute)} for ` +
            `subscription ${survivor.id} (${failure.detail}). Nothing was changed.`,
      );
    }
    const survivorResolved = survivorOutcome.data.response;
    const duplicateOutcome = await this.panelUsers.resolveUser(duplicateRoute.selector);
    if (duplicateOutcome.kind !== 'ok') {
      const failure = readPanelFailure(duplicateOutcome);
      return refuse(
        'duplicateUnresolved',
        failure.kind === 'missing'
          ? `the panel did not resolve ${describeRoute(duplicateRoute)} for subscription ` +
            `${duplicate.id}. Nothing was changed.`
          : `the panel could not be asked about ${describeRoute(duplicateRoute)} for ` +
            `subscription ${duplicate.id} (${failure.detail}). Nothing was changed.`,
      );
    }
    const duplicateResolved = duplicateOutcome.data.response;
    if (survivorResolved.id !== duplicateResolved.id) {
      return refuse(
        'differentPanelProfiles',
        `subscription ${survivor.id} resolves to panel profile ${survivorResolved.id} and ` +
          `${duplicate.id} resolves to panel profile ${duplicateResolved.id}. These are two ` +
          'different profiles, so these two rows are two real subscriptions and not a duplicate ' +
          'pair. Nothing was changed.',
      );
    }

    // THE SPELLING TO STORE IS THE PANEL'S OWN, and that is the numeric id in
    // decimal — there is no uuid to prefer, because 3.x does not have the
    // column. Same rule the reconciliation sweep follows. Writing anything else
    // would recreate by hand the unaddressable row this whole family of code
    // exists to repair.
    const remnawaveId = String(survivorResolved.id);
    const panelId = survivorResolved.id;

    // The resolve says WHERE the profile is; it does not say WHOSE it is. Only
    // a full profile read returns the description that carries the `reiwa_id`
    // marker, so this second round-trip is the ownership check itself.
    //
    // ADDRESSED BY THE NUMERIC ID THE RESOLVE JUST RETURNED, and by nothing
    // else — no username, no short UUID — so it cannot silently re-resolve by a
    // key this method has already reasoned about.
    const outcome = await this.panelUsers.getUserById(panelId);
    if (outcome.kind !== 'ok') {
      const failure = readPanelFailure(outcome);
      return refuse(
        'profileUnreadable',
        failure.kind === 'missing'
          ? `both rows resolve to panel profile ${remnawaveId}, but that profile is gone. ` +
            'Nothing was changed.'
          : `panel profile ${remnawaveId} could not be read back (${failure.detail}), so its ` +
            'owner could not be proven. Nothing was changed.',
      );
    }
    try {
      assertPanelProfileOwnership(
        duplicate.remnawavePanelUsername ?? survivor.remnawavePanelUsername ?? '',
        outcome.data.response.description,
        userId,
      );
    } catch (err: unknown) {
      return refuse('notOwned', `${(err as Error).message}. Nothing was changed.`);
    }

    // ── WHICH ROW HOLDS THE LIVE IDENTITY ────────────────────────────────────
    // Normally the duplicate: it is the row the importer minted against the live
    // profile. The survivor holding it instead is not an error — it means the
    // reconciliation sweep already repaired that half — and the merge is still
    // the right operation, so both are accepted and the source of the identity
    // is chosen rather than assumed. Neither holding it means these two rows
    // are not bound to the profile they resolve to, which is not a pair.
    const duplicateHolds = namesProfile(duplicate, remnawaveId, panelId);
    const survivorHolds = namesProfile(survivor, remnawaveId, panelId);
    // Reported from HERE on, including on the `neitherHoldsIdentity` refusal
    // immediately below: "we looked and neither half is bound" is a different
    // statement from "nobody looked", and it is the one that tells an operator
    // to repair the link rather than to retry.
    holders.survivor = survivorHolds;
    holders.duplicate = duplicateHolds;
    if (!duplicateHolds && !survivorHolds) {
      return refuse(
        'neitherHoldsIdentity',
        `both rows resolve to panel profile ${remnawaveId}, but neither of them is bound to it: ` +
          `${survivor.id} holds '${survivor.remnawaveId ?? 'nothing'}' and ${duplicate.id} holds ` +
          `'${duplicate.remnawaveId ?? 'nothing'}'. A pair has exactly one live half; this is not ` +
          'one. Repair the link first, then merge. Nothing was changed.',
      );
    }
    const identitySource = duplicateHolds ? duplicate : survivor;
    const panelUsername = identitySource.remnawavePanelUsername ?? survivor.remnawavePanelUsername;
    const configUrl = identitySource.configUrl ?? survivor.configUrl;

    // ── WHAT REFERENCES THE DUPLICATE ────────────────────────────────────────
    //
    // ASKED HERE FOR THE PREVIEW AND FOR THE CHEAP REFUSAL, AND ASKED AGAIN
    // INSIDE THE TRANSACTION FOR THE GUARANTEE. This call is what makes a dry
    // run a preview — a dry run returns before `writeMerge` is ever reached, so
    // without it a preview would report `wouldMerge` for a pair a real run
    // refuses — and it is what lets a doomed pair be refused WITHOUT opening a
    // transaction and queueing on the profile advisory lock, which is shared
    // with `persistProfileLink` and the reconciliation sweep and can block for
    // as long as they hold it.
    //
    // It is NOT the guarantee, and must not be read as one. Neither fenced
    // `updateMany` in `writeMerge` covers any of these three conditions — they
    // fence on `remnawaveId` and `status` — so between this line and the write
    // there is a window, and the wait on that advisory lock is most of it.
    // {@link mergeGuardFailure} is therefore called a second time under the
    // lock, before any statement runs, and a drain check runs after the last
    // one. See `writeMerge`.
    const guard = await this.mergeGuardFailure(this.prismaService, survivor.id, duplicate.id);
    if (guard !== null) return refuse(guard.refusal, guard.reason);

    const previous = {
      survivorPreviousRemnawaveId: survivor.remnawaveId,
      survivorPreviousPanelId: survivor.remnawavePanelId,
      duplicatePreviousRemnawaveId: duplicate.remnawaveId,
      duplicatePreviousPanelId: duplicate.remnawavePanelId,
    };

    if (dryRun) {
      // The preview counts the SAME relations the write moves, through the same
      // enumeration. A preview built from a second, hand-kept list would drift
      // from the write and stop being a preview.
      const reattached = await this.previewReattachments(duplicate.id, userId);
      const superseded = await this.prismaService.profileSyncJob.count({
        where: {
          subscriptionId: duplicate.id,
          supersededAt: null,
          status: { in: [SyncJobStatus.PENDING, SyncJobStatus.FAILED] },
        },
      });
      return {
        survivorSubscriptionId: survivor.id,
        duplicateSubscriptionId: duplicate.id,
        userId,
        outcome: 'wouldMerge',
        refusal: null,
        reason: null,
        remnawaveId,
        remnawavePanelId: panelId,
        panelUsername,
        configUrl,
        ...previous,
        survivorHoldsLiveIdentity: survivorHolds,
        duplicateHoldsLiveIdentity: duplicateHolds,
        reattached,
        supersededSyncJobs: superseded,
      };
    }

    return this.writeMerge(survivor, duplicate, {
      userId,
      remnawaveId,
      panelId,
      panelUsername,
      configUrl,
      previous,
      holds: { survivor: survivorHolds, duplicate: duplicateHolds },
    });
  }

  /**
   * The whole merge, in ONE transaction.
   *
   * THE ADVISORY LOCK IS THE SAME KEY `persistProfileLink` and the
   * reconciliation sweep take, so a concurrent CREATE about to link this same
   * panel identity queues behind this transaction instead of racing it.
   * `$executeRaw`, not `$queryRaw`: `pg_advisory_xact_lock` returns `void` and
   * Prisma's query path has no deserializer for it.
   *
   * EVERY WRITE IS FENCED on what the row held when it was verified. If either
   * half moved while the panel round-trips were in flight, the transaction
   * throws and Prisma rolls back the whole thing — a half-merged pair (identity
   * moved, payments left behind; or payments moved onto a row that never got the
   * identity) is worse than either the before or the after state.
   *
   * BUT A FENCE ONLY FENCES WHAT IT MENTIONS, and those two mention
   * `remnawaveId` and `status`. Three of the conditions this merge refuses on —
   * a blocking entitlement relation, a trial claim on the survivor, a sync job
   * claimed into RUNNING — live on OTHER tables entirely, so no compare-and-swap
   * on `subscriptions` can see them. They were checked before the panel
   * round-trips and before this transaction opened; between that check and the
   * first statement here lies a window whose largest part is the wait on the
   * advisory lock above, which is shared with `persistProfileLink` and the
   * reconciliation sweep and is CONTENDED BY DESIGN. Left uncovered, that window
   * turns a refusal into the failure this service treats as strictly worse: a
   * `SubscriptionTerm`, an `AddOnEntitlement` or a projection silently ORPHANED
   * onto a `DELETED` row (see {@link BLOCKING_RELATIONS}), or a `P2002` from the
   * UNIQUE `trial_claims.subscription_id` that is not a {@link MergeRaceError}
   * and escapes.
   *
   * SO THEY ARE ASSERTED TWICE MORE, INSIDE:
   *   • {@link mergeGuardFailure} again as step 0, under the lock and before ANY
   *     statement. It re-asks the three questions verbatim and produces the SAME
   *     named refusal the outside check produces, so an operator cannot tell —
   *     and does not need to tell — which of the two fired. Being before the
   *     writes is what matters for the trial claim: `trialClaim.updateMany`
   *     would raise `P2002` rather than refuse, and a refusal is the outcome
   *     that is wanted.
   *   • {@link assertDuplicateDrained} as step 5, after the LAST statement. Under
   *     READ COMMITTED every statement takes a fresh snapshot, so a row
   *     committed after step 0 is invisible to it and visible here; this is the
   *     latest instant inside the transaction at which the question can be
   *     asked. It asks the strongest available form of it — NOTHING may still
   *     reference the retired row — so anything that landed mid-merge rolls the
   *     whole thing back instead of being orphaned.
   */
  private async writeMerge(
    survivor: MergeSideRow,
    duplicate: MergeSideRow,
    plan: {
      userId: string;
      remnawaveId: string;
      panelId: number;
      panelUsername: string | null;
      configUrl: string | null;
      previous: {
        survivorPreviousRemnawaveId: string | null;
        survivorPreviousPanelId: number | null;
        duplicatePreviousRemnawaveId: string | null;
        duplicatePreviousPanelId: number | null;
      };
      /**
       * Which half was bound BEFORE this write, as {@link namesProfile}
       * answered it during verification. Carried in rather than recomputed
       * here: after step 1 the duplicate's identity columns are NULL and after
       * step 2 the survivor's name the profile, so a second derivation inside
       * the transaction would answer a different question and report the
       * survivor every time.
       */
      holds: { survivor: boolean; duplicate: boolean };
    },
  ): Promise<DuplicateMergeRow> {
    // One shape for every refusal this method can produce, so a code added here
    // cannot accidentally report a different set of undo columns from the one
    // beside it. `reattached` and `supersededSyncJobs` are empty on all of them
    // BY CONSTRUCTION: every path that reaches this builder threw, and a throw
    // inside the transaction rolls the whole merge back.
    const refusedInFlight = (
      refusal: DuplicateMergeRefusal,
      reason: string,
    ): DuplicateMergeRow => ({
      survivorSubscriptionId: survivor.id,
      duplicateSubscriptionId: duplicate.id,
      userId: plan.userId,
      outcome: 'refused',
      refusal,
      reason,
      remnawaveId: plan.remnawaveId,
      remnawavePanelId: plan.panelId,
      panelUsername: plan.panelUsername,
      configUrl: plan.configUrl,
      ...plan.previous,
      survivorHoldsLiveIdentity: plan.holds.survivor,
      duplicateHoldsLiveIdentity: plan.holds.duplicate,
      reattached: [],
      supersededSyncJobs: 0,
    });
    const raceLost = (what: string, detail: string | null = null): DuplicateMergeRow =>
      refusedInFlight(
        'raceLost',
        detail ??
          `${what} changed while this merge was in flight, so the pair no longer looks the way it ` +
            'did when it was verified. The whole transaction was rolled back and nothing was changed.',
      );

    try {
      return await this.prismaService.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtext(${`remnawave-profile:${plan.remnawaveId}`})::bigint)
        `);

        // ── 0. THE THREE CONDITIONS NO FENCE COVERS, RE-ASKED UNDER THE LOCK ─
        //
        // BEFORE ANY STATEMENT, which is the half of the placement that matters
        // for the trial claim: once `trialClaim.updateMany` has run against a
        // survivor that gained a claim in the window, the UNIQUE
        // `trial_claims.subscription_id` raises `P2002` — which is not a
        // {@link MergeRaceError}, escapes this method, and (before `merge()`
        // learned to convert it) took the whole batch's audit with it. Asked
        // here, the same situation is a named `trialClaimOnBoth` refusal with
        // the same wording the pre-flight check produces.
        //
        // The window this closes is not theoretical. `pg_advisory_xact_lock`
        // above BLOCKS until whoever holds the profile key commits, and the key
        // is shared with `persistProfileLink` and the reconciliation sweep's
        // `writeLink` — so "checked, then waited an unbounded time, then wrote"
        // is the normal shape of a contended merge, not the unlucky one.
        const guard = await this.mergeGuardFailure(tx, survivor.id, duplicate.id);
        if (guard !== null) throw new MergeConditionError(guard.refusal, guard.reason);

        // ── 1. RETIRE THE DUPLICATE, IDENTITY AND STATUS IN ONE STATEMENT ────
        //
        // FIRST, and this order is not cosmetic. Doing it after the survivor
        // claimed the identity would create — however briefly — the one state
        // that must never exist: two LIVE rows naming one panel profile, each
        // able to overwrite and delete the other's service.
        //
        // ONE `data` OBJECT, and that is the invariant that keeps the panel
        // safe. `SubscriptionDeletionService.deleteSubscription` creates its
        // `SyncAction.DELETE` job inside `if (current.remnawaveId !== null)`,
        // and `handleDelete` turns that job into `deletePanelUser`. A row left
        // `DELETED` while still holding an identity is therefore a loaded gun
        // for the next manual delete — and on a 3.x panel it fires even for the
        // dead 2.x uuid.
        //
        // WHICH MATERIAL CARRIES IT THERE IS WORTH BEING EXACT ABOUT, because
        // it is NOT the short UUID for the job this row would produce. The job
        // `deleteSubscription` writes is payload-bearing — it captures
        // `targetRemnawaveId`, `targetRemnawavePanelId` and
        // `targetRemnawavePanelUsername` off the row under one `FOR UPDATE` —
        // and `handleDelete` addresses it through `readTargetIdentity`, which
        // supplies NO `panelShortUuid` and WINS over anything row-derived. So
        // the reach to the live profile runs through `targetRemnawavePanelId` /
        // `targetRemnawavePanelUsername`. Clearing the four identity columns in
        // the same statement that sets `DELETED` is what stops the job being
        // created AT ALL — no observer, at any instant, ever sees a retired row
        // that names a profile — which is the defence that holds whichever of
        // the two routes would have carried it.
        //
        // `configUrl` GOES WITH THEM ANYWAY, as depth rather than as the gate.
        // It is the material `deleteTargetIdentity` recovers a short UUID from,
        // and that is the branch taken only by a job carrying NEITHER a panel id
        // nor a panel username — the one case the payload route does not cover.
        // Leaving it behind would keep the retired row addressable through it.
        const retired = await tx.subscription.updateMany({
          where: {
            id: duplicate.id,
            remnawaveId: duplicate.remnawaveId,
            status: { not: SubscriptionStatus.DELETED },
          },
          data: {
            remnawaveId: null,
            remnawavePanelId: null,
            remnawavePanelUsername: null,
            configUrl: null,
            status: SubscriptionStatus.DELETED,
          },
        });
        if (retired.count === 0) throw new MergeRaceError(`subscription ${duplicate.id}`);

        // ── 2. THE SURVIVOR TAKES THE IDENTITY ───────────────────────────────
        //
        // FOUR COLUMNS, AND ONLY FOUR. `planSnapshot` is not among them and must
        // never be: Prisma writes a `Json` column WHOLESALE, and `name` is what
        // the cabinet, the bot and every invoice render as the customer's plan.
        // The survivor is the row that HAS a real plan; the duplicate carries
        // whatever the importer invented (`{ importedFrom, tag,
        // trafficLimitStrategy }` — no name at all). Same for `status`,
        // `expiresAt`, `deviceLimit`, `trafficLimit`, `isTrial`,
        // `internalSquads`, `externalSquad` and `cardBranding`: identity comes
        // from the duplicate, everything else stays the survivor's.
        const claimed = await tx.subscription.updateMany({
          where: {
            id: survivor.id,
            remnawaveId: survivor.remnawaveId,
            status: { not: SubscriptionStatus.DELETED },
          },
          data: {
            remnawaveId: plan.remnawaveId,
            remnawavePanelId: plan.panelId,
            ...(plan.panelUsername === null ? {} : { remnawavePanelUsername: plan.panelUsername }),
            ...(plan.configUrl === null ? {} : { configUrl: plan.configUrl }),
          },
        });
        if (claimed.count === 0) throw new MergeRaceError(`subscription ${survivor.id}`);

        // ── 3. EVERYTHING THAT REFERENCED THE DUPLICATE ──────────────────────
        const reattached: DuplicateMergeReattachment[] = [];
        for (const relation of MOVED_RELATIONS) {
          const written = await relation.move(tx, duplicate.id, survivor.id);
          reattached.push({
            relation: relation.relation,
            model: relation.model,
            column: relation.column,
            moved: written.count,
          });
        }
        // The cabinet's "currently selected subscription" pointer, repointed
        // only when it actually names the duplicate. Left alone it would open
        // the customer's cabinet on a retired row.
        const repointed = await tx.user.updateMany({
          where: { id: plan.userId, currentSubscriptionId: duplicate.id },
          data: { currentSubscriptionId: survivor.id },
        });
        reattached.push({ ...CURRENT_SUBSCRIPTION_RELATION, moved: repointed.count });

        // ── 4. DEFUSE THE DUPLICATE'S QUEUE ──────────────────────────────────
        //
        // The jobs STAY on the retired row — they are its own history — but no
        // non-terminal one may ever run. A PENDING `DELETE` job carries the LIVE
        // profile in its payload (`targetRemnawaveId`), and that profile now
        // belongs to the survivor, so running it would delete a paying
        // customer's service. `claimSyncJob` returns early for any job with
        // `supersededAt` set, which is exactly what this write does. RUNNING
        // jobs cannot be recalled this way, which is why a pair carrying one is
        // refused — before the transaction is opened, again as step 0 inside it,
        // and once more by step 5, which is the only one of the three that can
        // see a PENDING job claimed into RUNNING while these statements were
        // running. That last one IS defended in depth downstream — the
        // processor re-reads ownership before it touches a profile — which is
        // why the ORPHAN is the more urgent half of this defect and the claimed
        // job the less urgent; it is still refused rather than tolerated,
        // because "a worker is mid-flight against a profile that just changed
        // hands" is not a state this service is willing to create knowingly.
        const superseded = await tx.profileSyncJob.updateMany({
          where: {
            subscriptionId: duplicate.id,
            supersededAt: null,
            status: { in: [SyncJobStatus.PENDING, SyncJobStatus.FAILED] },
          },
          data: {
            supersededAt: new Date(),
            status: SyncJobStatus.COMPLETED,
            cause: 'SUPERSEDED_BY_DUPLICATE_MERGE',
          },
        });
        reattached.push({ ...SYNC_JOB_RELATION, moved: 0 });

        // ── 5. NOTHING MAY STILL REFERENCE THE RETIRED ROW ───────────────────
        //
        // The LAST statement of the merge, and the strongest form of the
        // question step 0 asked in its weakest form. Step 0 asks "is this pair
        // still mergeable?" against a snapshot taken before any write; this asks
        // "did the merge actually drain the duplicate?" against a snapshot taken
        // after all of them. Under READ COMMITTED those are different snapshots,
        // and the difference is exactly the set of rows some other transaction
        // committed while these statements were running.
        await this.assertDuplicateDrained(tx, duplicate.id);

        this.logger.log(
          `Duplicate merge: subscription ${duplicate.id} retired into ${survivor.id} (customer ` +
            `${plan.userId}); panel identity '${plan.remnawaveId}' (panel id ${plan.panelId}) now ` +
            `belongs to ${survivor.id}; reattached ` +
            `${reattached.map((r) => `${r.relation}=${r.moved}`).join(' ')}; superseded ` +
            `${superseded.count} sync job(s)`,
        );

        return {
          survivorSubscriptionId: survivor.id,
          duplicateSubscriptionId: duplicate.id,
          userId: plan.userId,
          outcome: 'merged' as const,
          refusal: null,
          reason: null,
          remnawaveId: plan.remnawaveId,
          remnawavePanelId: plan.panelId,
          panelUsername: plan.panelUsername,
          configUrl: plan.configUrl,
          ...plan.previous,
          survivorHoldsLiveIdentity: plan.holds.survivor,
          duplicateHoldsLiveIdentity: plan.holds.duplicate,
          reattached,
          supersededSyncJobs: superseded.count,
        };
      });
    } catch (err: unknown) {
      // BOTH IN-TRANSACTION REFUSALS LAND HERE, and both say the same thing
      // about the database: the throw unwound the `$transaction`, so Prisma
      // rolled every statement of this merge back and the pair is exactly as it
      // was before. Anything else is re-thrown to {@link merge}, which records
      // the pairs that already committed and stops the batch rather than losing
      // their audit — see {@link DuplicateMergeStop}.
      if (err instanceof MergeRaceError) return raceLost(err.what, err.detail);
      if (err instanceof MergeConditionError) return refusedInFlight(err.refusal, err.detail);
      throw err;
    }
  }

  /** How many rows each MOVED relation would carry, for the dry run. */
  private async previewReattachments(
    duplicateId: string,
    userId: string,
  ): Promise<DuplicateMergeReattachment[]> {
    const rows: DuplicateMergeReattachment[] = [];
    for (const relation of MOVED_RELATIONS) {
      rows.push({
        relation: relation.relation,
        model: relation.model,
        column: relation.column,
        moved: await relation.count(this.prismaService, duplicateId),
      });
    }
    rows.push({
      ...CURRENT_SUBSCRIPTION_RELATION,
      moved: await this.prismaService.user.count({
        where: { id: userId, currentSubscriptionId: duplicateId },
      }),
    });
    rows.push({ ...SYNC_JOB_RELATION, moved: 0 });
    return rows;
  }

  /**
   * THE THREE CONDITIONS NEITHER FENCED `updateMany` CAN SEE, asked through
   * whichever client is handed in.
   *
   * ONE implementation, called from two places on purpose. `mergePair` calls it
   * on the service client — that is what makes the dry run a real preview and
   * what refuses a doomed pair before it queues on a contended advisory lock —
   * and `writeMerge` calls it again on the TRANSACTION client, under that lock,
   * before any statement. A second hand-kept copy inside the transaction would
   * be a second set of reasons to keep in agreement with the first, and the
   * first divergence an operator would notice is a pair the preview called
   * mergeable being refused by a sentence that does not match.
   *
   * The order is the order of increasing recoverability, so the reason an
   * operator reads first is the one that needs the most work: entitlement
   * history has to be resolved by hand, a double trial claim is the trial
   * ledger's decision, a RUNNING job just needs a minute.
   *
   * `null` means all three passed AS OF THIS CLIENT'S SNAPSHOT — never "this
   * pair is safe", which is why the caller inside the transaction also drains
   * afterwards.
   */
  private async mergeGuardFailure(
    client: CountClient,
    survivorId: string,
    duplicateId: string,
  ): Promise<{ refusal: DuplicateMergeRefusal; reason: string } | null> {
    const blocked = await this.blockingRowsOn(client, duplicateId);
    if (blocked.length > 0) {
      return {
        refusal: 'entitlementHistoryOnDuplicate',
        reason:
          `subscription ${duplicateId} carries entitlement-lifecycle history that cannot be ` +
          `re-parented (${blocked.map((b) => `${b.model}: ${b.moved}`).join(', ')}). ` +
          'Subscription terms are unique per (subscription, generation), add-on entitlements sit ' +
          'behind a composite non-deferrable foreign key to their term, and the effective ' +
          'projection is unique per subscription — so there is no statement order that moves them ' +
          'safely. This pair must be resolved by hand. Nothing was changed.',
      };
    }
    const survivorClaims = await client.trialClaim.count({
      where: { subscriptionId: survivorId },
    });
    const duplicateClaims = await client.trialClaim.count({
      where: { subscriptionId: duplicateId },
    });
    if (survivorClaims > 0 && duplicateClaims > 0) {
      return {
        refusal: 'trialClaimOnBoth',
        reason:
          `both ${survivorId} and ${duplicateId} hold a trial claim, and ` +
          '`trial_claims.subscription_id` is UNIQUE, so the duplicate claim cannot be moved onto ' +
          'the survivor. Releasing or consuming one of them is the trial ledger own rule and not ' +
          'this merge to decide. Nothing was changed.',
      };
    }
    const runningJobs = await client.profileSyncJob.count({
      where: {
        subscriptionId: duplicateId,
        status: SyncJobStatus.RUNNING,
        supersededAt: null,
      },
    });
    if (runningJobs > 0) {
      return {
        refusal: 'syncJobRunning',
        reason:
          `${runningJobs} sync job(s) for subscription ${duplicateId} are RUNNING and may already ` +
          'be in flight against the panel. A job that has been claimed cannot be recalled by ' +
          'marking it superseded, so retiring the row underneath it would leave a worker acting ' +
          'on a profile that has just changed hands. Re-run once they finish. Nothing was changed.',
      };
    }
    return null;
  }

  /**
   * THE DUPLICATE IS EMPTY, asserted after the last statement of the merge.
   *
   * The invariant this whole service is built around, stated once as an
   * executable check instead of being implied by the enumeration in
   * {@link MOVED_RELATIONS}: after a merge commits, NOTHING may still point at
   * the row it retired. {@link BLOCKING_RELATIONS} says an orphan on a `DELETED`
   * row is the one outcome worse than a refusal — a term, an add-on entitlement
   * or a projection filed under a subscription the customer no longer has,
   * invisible to every join that goes through the surviving row.
   *
   * WHY BOTH LISTS AND NOT ONLY ONE. A `MOVED` relation that still has rows
   * means something created one after the `updateMany` that was supposed to
   * carry them; a `BLOCKING` relation that has any means something created one
   * after step 0 said there were none. Neither is reachable from this method's
   * own statements — which is exactly why finding one proves a concurrent write
   * and not a bug in the enumeration.
   *
   * THE POINTER IS ASKED WITHOUT THE `user_id` FILTER the repoint uses.
   * `users.current_subscription_id` is globally UNIQUE, so at most one row can
   * name the duplicate; if that row is the pair's own customer the repoint moved
   * it, and if it is somebody else's the repoint deliberately did not — and a
   * DIFFERENT customer's cabinet left open on a retired row is precisely the
   * orphan this check exists to refuse rather than commit.
   *
   * NON-TERMINAL JOBS INCLUDE `RUNNING`, which is the only one of the three
   * checks that can see a `PENDING` job claimed while these statements ran.
   *
   * Throws {@link MergeRaceError} rather than a named condition: by definition
   * this is something that changed under the merge. A re-run re-asks the named
   * pre-flight checks and reports the blocking relation by itself.
   */
  private async assertDuplicateDrained(tx: MergeTx, duplicateId: string): Promise<void> {
    const left: string[] = [];
    for (const relation of MOVED_RELATIONS) {
      const count = await relation.count(tx, duplicateId);
      if (count > 0) left.push(`${relation.model}: ${count}`);
    }
    for (const relation of BLOCKING_RELATIONS) {
      const count = await relation.count(tx, duplicateId);
      if (count > 0) left.push(`${relation.model}: ${count}`);
    }
    const pointers = await tx.user.count({ where: { currentSubscriptionId: duplicateId } });
    if (pointers > 0) {
      left.push(
        `${CURRENT_SUBSCRIPTION_RELATION.model}.${CURRENT_SUBSCRIPTION_RELATION.column}: ${pointers}`,
      );
    }
    const live = await tx.profileSyncJob.count({
      where: {
        subscriptionId: duplicateId,
        supersededAt: null,
        status: {
          in: [SyncJobStatus.PENDING, SyncJobStatus.FAILED, SyncJobStatus.RUNNING],
        },
      },
    });
    if (live > 0) left.push(`${SYNC_JOB_RELATION.model} (not superseded): ${live}`);
    if (left.length === 0) return;
    throw new MergeRaceError(
      `subscription ${duplicateId}`,
      `subscription ${duplicateId} still had ${left.join(', ')} pointing at it after this merge ` +
        'had moved everything it knows how to move, so something created them while the merge was ' +
        'in flight. Committing would have left them orphaned on a DELETED row — the one outcome ' +
        'this service treats as worse than a refusal, because nothing downstream ever looks at ' +
        'them again. The whole transaction was rolled back and nothing was changed. Re-run: the ' +
        'pre-flight checks name the offending relation by itself.',
    );
  }

  /** The blocking relations the duplicate actually carries, with counts. */
  private async blockingRowsOn(
    client: CountClient,
    duplicateId: string,
  ): Promise<DuplicateMergeReattachment[]> {
    const found: DuplicateMergeReattachment[] = [];
    for (const relation of BLOCKING_RELATIONS) {
      const count = await relation.count(client, duplicateId);
      if (count > 0) {
        found.push({
          relation: relation.relation,
          model: relation.model,
          column: relation.column,
          moved: count,
        });
      }
    }
    return found;
  }
}

/** Thrown inside the transaction so Prisma rolls the whole merge back. */
class MergeRaceError extends Error {
  public constructor(
    public readonly what: string,
    /**
     * The whole reason, when the race is more specific than a lost fence.
     * `null` keeps the generic sentence, which is the right one for a
     * compare-and-swap that matched nothing: all anybody can say is that the
     * row no longer holds what it held.
     */
    public readonly detail: string | null = null,
  ) {
    super(detail ?? `${what} changed under the merge`);
    this.name = 'MergeRaceError';
  }
}

/**
 * Thrown inside the transaction when one of the three conditions no fence
 * covers has stopped holding — so Prisma rolls the merge back and the caller
 * reports the SAME named refusal the pre-flight check would have reported.
 *
 * Distinct from {@link MergeRaceError} because the two answer different
 * questions for the operator. A race says "try again"; these say what is wrong
 * with the pair, and two of the three ("resolve the entitlement history by
 * hand", "the trial ledger has to release one of the claims") are not things a
 * re-run can fix.
 */
class MergeConditionError extends Error {
  public constructor(
    public readonly refusal: DuplicateMergeRefusal,
    public readonly detail: string,
  ) {
    super(detail);
    this.name = 'MergeConditionError';
  }
}

/** Reads whatever a throw from a pair's transaction can be made to say. */
function describeStop(
  pair: DuplicateMergePairInput,
  pairsCompleted: number,
  err: unknown,
): DuplicateMergeStop {
  const error = err instanceof Error ? err : null;
  // Prisma's known-request errors carry `code` (`P2002`, `P2028`, …), and it is
  // the field an operator can actually look up. Read structurally rather than
  // through `instanceof PrismaClientKnownRequestError`, so a driver-level error
  // that carries the same field is described just as well.
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return {
    survivorSubscriptionId: pair.survivorSubscriptionId,
    duplicateSubscriptionId: pair.duplicateSubscriptionId,
    pairsCompleted,
    errorName: error === null ? typeof err : error.name,
    errorCode: typeof code === 'string' && code.length > 0 ? code : null,
    message: error === null ? String(err) : error.message,
  };
}

/** `PrismaClientKnownRequestError P2002`, or just the class name. */
function describeStopError(stop: DuplicateMergeStop): string {
  const named = stop.errorCode === null ? stop.errorName : `${stop.errorName} ${stop.errorCode}`;
  return `${named}: ${stop.message}`;
}

/**
 * The row a pair whose transaction FAILED contributes to the report.
 *
 * It names the ids in the order they were HANDED IN, not the order the merge
 * would have derived: the throw may have happened before either row was read,
 * so which one is older is not a fact this row is entitled to claim. Same
 * reason every pre-verification refusal in `mergePair` reports the input ids.
 */
function stoppedRow(pair: DuplicateMergePairInput, stop: DuplicateMergeStop): DuplicateMergeRow {
  return {
    survivorSubscriptionId: pair.survivorSubscriptionId,
    duplicateSubscriptionId: pair.duplicateSubscriptionId,
    userId: null,
    outcome: 'refused',
    refusal: 'raceLost',
    reason:
      `the merge of ${pair.survivorSubscriptionId} and ${pair.duplicateSubscriptionId} failed in ` +
      `flight (${describeStopError(stop)}). Every statement of a merge runs inside one ` +
      'transaction, so this pair was rolled back whole and nothing was changed for it. THE BATCH ' +
      `STOPPED HERE: the ${stop.pairsCompleted} pair(s) listed before this one were examined and ` +
      '— on a real run — are already committed and recorded in this run audit; no pair after it ' +
      'was looked at, and the cursor was left where this run started so a re-run re-reads the ' +
      'same window.',
    remnawaveId: null,
    remnawavePanelId: null,
    panelUsername: null,
    configUrl: null,
    survivorPreviousRemnawaveId: null,
    survivorPreviousPanelId: null,
    duplicatePreviousRemnawaveId: null,
    duplicatePreviousPanelId: null,
    survivorHoldsLiveIdentity: null,
    duplicateHoldsLiveIdentity: null,
    reattached: [],
    supersededSyncJobs: 0,
  };
}

/** The one resolve route a row has, or `null` when it has none. */
function routeOf(row: MergeSideRow): {
  readonly kind: 'shortUuid' | 'username';
  readonly value: string;
  readonly selector: { readonly shortUuid: string } | { readonly username: string };
} | null {
  const shortUuid = panelShortUuidFromConfigUrl(row.configUrl ?? null);
  if (shortUuid !== null && shortUuid.length > 0) {
    return { kind: 'shortUuid', value: shortUuid, selector: { shortUuid } };
  }
  const username = row.remnawavePanelUsername ?? '';
  // An empty string passes `IS NOT NULL`; resolving by it would ask the panel
  // "which user is called nothing?" and act on the answer.
  if (username.length > 0) return { kind: 'username', value: username, selector: { username } };
  return null;
}

function describeRoute(route: { kind: 'shortUuid' | 'username'; value: string }): string {
  return `${route.kind} '${route.value}'`;
}

/**
 * Is this row bound to that panel profile?
 *
 * Both spellings are accepted for the same reason `panelIdentityWhere` accepts
 * both: a profile created on 2.x keeps its uuid in `remnawave_id` while its
 * numeric id lives in `remnawave_panel_id`, so one profile has two legitimate
 * local spellings and a check that knew only one would call a bound row unbound.
 */
function namesProfile(row: MergeSideRow, remnawaveId: string, panelId: number): boolean {
  if (row.remnawaveId !== null && row.remnawaveId === remnawaveId) return true;
  if (row.remnawaveId !== null && row.remnawaveId === String(panelId)) return true;
  return row.remnawavePanelId !== null && row.remnawavePanelId === panelId;
}

/** Reads a caller-supplied bound, falling back rather than trusting it. */
function clampPositive(value: unknown, fallback: number, ceiling: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  if (floored < 1) return fallback;
  return Math.min(floored, ceiling);
}
