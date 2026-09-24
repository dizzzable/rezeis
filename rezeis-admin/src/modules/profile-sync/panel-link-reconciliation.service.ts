import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { panelShortUuidFromConfigUrl } from '../remnawave/services/panel-user-address';
import { PanelUsersClient } from '../remnawave/services/panel-users.client';
import { readProfileOwnerMarkers, readProfileSubscriptionMarkers } from './panel-owner-marker';
import { assertPanelProfileOwnership, readPanelFailure } from './profile-sync.processor';

/** How many rows one database page carries. Bounds memory, not panel load. */
export const PANEL_LINK_RECONCILIATION_PAGE_SIZE = 25;
/**
 * How many rows ONE invocation may examine. Each row costs the panel a resolve
 * plus a profile read, so the ceiling is a panel-load budget rather than a
 * database one — the automatic check continues from `nextCursor` on its next
 * run, and the duplicate merge's operator runs again.
 */
export const PANEL_LINK_RECONCILIATION_DEFAULT_LIMIT = 200;
export const PANEL_LINK_RECONCILIATION_MAX_LIMIT = 1000;

/**
 * How many SHARED-IDENTITY groups one invocation reports, and how many rows it
 * will read to describe them.
 *
 * Not a panel budget — that arm never calls the panel — but a bound on the `IN`
 * list and on the result set, so one pathological cluster cannot make a report
 * unboundedly large. Hitting either cap sets
 * {@link PanelLinkReconciliationReport.hasMore}; the operator runs again, and
 * because each merge retires a row the population shrinks under the walk rather
 * than repeating.
 */
export const PANEL_LINK_SHARED_IDENTITY_MAX_GROUPS = 200;
export const PANEL_LINK_SHARED_IDENTITY_MAX_MEMBERS = 1000;

/**
 * THE POPULATION THE WALK TRIES TO PROVE, spelled once. The walk's pages, the
 * operator's list («Подписки» → «Инструменты» → «Подписки без привязки к
 * Remnawave») and the count after a backup import all read it, so the three
 * can never disagree about which rows are "without a proven link".
 *
 * Two arms, and a live row (`status <> 'DELETED'`) is in the population when it
 * matches either:
 *
 *  1. NO IDENTITY, AND THE SIGNATURE OF THE 19.08.2026 WRITE-PATH DEFECT —
 *     `remnawave_id IS NULL` while the panel username and the config URL did
 *     land. See the class note for why exactly this and nothing wider.
 *  2. AN IDENTITY NO SUPPORTED PANEL CAN HAVE ISSUED — `remnawave_id` that is
 *     not a decimal: a Remnawave 2.x uuid kept after the panel was upgraded, an
 *     empty string, a donor's junk. Remnawave 3.x names a user by its numeric
 *     id and nothing else, so such a row names nobody the panel answers to. The
 *     same test the destructive paths refuse on (`isNumericPanelIdentity`,
 *     `^\d+$`), so every row they refuse is a row this check tries to prove.
 *
 * `!~` is NULL-safe in the direction this needs: a NULL identity makes the
 * second arm NULL, not true, so only the first arm can bring an empty row in.
 */
export const PANEL_LINK_POPULATION_SQL = Prisma.sql`(
  ("remnawave_id" IS NULL AND "remnawave_panel_username" IS NOT NULL AND "config_url" IS NOT NULL)
  OR "remnawave_id" !~ '^[0-9]+$'
)`;

/**
 * What happened to ONE row. Everything that is not `linked`/`wouldLink` is
 * reported BY NAME — silence is the disease this walk repairs, so it is not
 * allowed to be the way the walk reports its own failures.
 */
export type PanelLinkReconciliationOutcome =
  /** The link was written. */
  | 'linked'
  /** A dry run: every check passed and a real run would write the link. */
  | 'wouldLink'
  /** The panel could not name the profile from either route. */
  | 'unresolved'
  /**
   * The profile's description does not PROVE it is this row's customer's: its
   * `reiwa_id` line names somebody else, there is no such line, or the lines
   * disagree. The reason says which.
   */
  | 'notOwned'
  /**
   * The profile IS this customer's, but its `subscription_id` line names
   * another of their subscriptions (owner's decision, 24.09.2026: when the line
   * is there it must match for any automatic link).
   */
  | 'markedForOtherSubscription'
  /** Another live subscription — of another customer — already holds that panel profile. */
  | 'conflict'
  /**
   * The row holds a non-decimal identity and could NOT be repaired — and the
   * reason is one no other member covers.
   *
   * WHY THIS IS THE NARROW MEANING. `linked` and `wouldLink` already carry the
   * one distinction an operator acts on: whether a write HAPPENED or would
   * happen. A repaired row with a non-decimal identity is therefore
   * `linked`/`wouldLink`, and {@link PanelLinkReconciliationRow.storedRemnawaveId}
   * is what shows the identity it used to hold.
   *
   * That leaves exactly two ways to be here, and both are reported rather than
   * folded into `unresolved`, which would say "the panel did not answer" about
   * a row the panel was never asked about:
   *   • no resolve route at all — neither a `config_url` to recover a
   *     subscription short UUID from, nor a `remnawave_panel_username`;
   *   • the panel answers for the profile with the identity the row ALREADY
   *     holds, so there is nothing to rewrite. A repair invented from that
   *     disagreement is how this bug class is made in the first place.
   */
  | 'staleIdentity'
  /**
   * Two LIVE rows of ONE customer on ONE panel profile — not a collision
   * between two unrelated subscriptions.
   *
   * REACHED BY TWO DIFFERENT ROUTES, and an operator can tell them apart by
   * {@link PanelLinkReconciliationRow.resolvedBy} and by
   * {@link PanelLinkReconciliationRow.holdsLiveIdentity}:
   *
   *  • `shortUuid` / `username` — a row that could NOT name its profile was
   *    resolved on the panel and landed on a profile another live row already
   *    holds. Exactly ONE half is bound (`holdsLiveIdentity` true on the
   *    partner, false on the scanned row).
   *  • `storedIdentity` — two live rows STORE the same identity. Nothing was
   *    resolved, because nothing needed to be: both rows already name the
   *    profile, so BOTH halves are bound and `holdsLiveIdentity` is true on
   *    each. That is the dangerous difference — there is no wrong-looking half
   *    to delete safely, and deleting either enqueues a panel DELETE against a
   *    live profile.
   *
   * THE SECOND ROUTE IS WHAT MAKES A CLUSTER CONVERGE. A merge gives the
   * survivor the duplicate's identity, so after the first merge of a cluster of
   * three the survivor holds a well-formed identity and so does the remaining
   * duplicate. Neither is a BROKEN link any more, and a selection that asks only
   * "is this link broken?" cannot see either of them.
   *
   * NOT REPAIRED BY THIS WALK, deliberately: merging two subscriptions moves
   * history, payments and referral links, and that belongs behind its own dry
   * run — «Подписки» → «Инструменты» → «Слияние подписок-дубликатов», which
   * finds its pairs by running this walk as a preview.
   *
   * A pair contributes TWO rows to {@link PanelLinkReconciliationReport.unrepaired}
   * — the scanned half and the half it collided with — because an operator who
   * is shown only one of them cannot see which is which, and the wrong-looking
   * one is the LIVE one. See {@link PanelLinkReconciliationRow.holdsLiveIdentity}.
   */
  | 'duplicatePair'
  /** A concurrent CREATE linked the row first; its link is left alone. */
  | 'raceLost';

/**
 * WHY a row was not linked, as a code a screen can translate — the sentence in
 * {@link PanelLinkReconciliationRow.reason} is for logs and audit rows, and a
 * screen that parsed it would break on the first rewording.
 */
export type PanelLinkRowReason =
  /** No short UUID in the config URL and no panel username: nothing to ask the panel by. */
  | 'noRoute'
  /** The panel has no profile under that short UUID / username. */
  | 'notFound'
  /** The panel could not be asked (transport, 5xx, auth, timeout). The walk stops there. */
  | 'panelUnavailable'
  /** The resolve named a profile that is gone by the time it is read. */
  | 'profileGone'
  /** The `reiwa_id` line names another customer ({@link PanelLinkReconciliationRow.otherUserId}). */
  | 'ownedByOther'
  /** No `reiwa_id` line, or lines naming different customers. */
  | 'noOwnerProof'
  /** The `subscription_id` line names another subscription ({@link PanelLinkReconciliationRow.otherSubscriptionId}). */
  | 'markedForOtherSubscription'
  /** A live row of ANOTHER customer holds the profile. */
  | 'profileTaken'
  /** A live row of the SAME customer holds the profile. */
  | 'duplicatePair'
  /** The row changed while the walk was in flight. */
  | 'raceLost'
  /** The panel answers with the very identity the row holds. */
  | 'panelAgrees';

export interface PanelLinkReconciliationRow {
  readonly subscriptionId: string;
  readonly userId: string;
  /** The stored `remnawave_panel_username` — the operator's handle on the row. */
  readonly panelUsername: string;
  /**
   * Which route named the profile this row is about.
   *
   * `shortUuid` / `username` are the two RESOLVE routes, and exactly one of them
   * is tried per scanned row. On the PARTNER row of such a `duplicatePair` this
   * records the route that identified the shared profile, not a resolve
   * performed for the partner — the partner is read out of the database, never
   * off the panel.
   *
   * `storedIdentity` is not a resolve at all: it says the profile was named by
   * the identity the rows ALREADY STORE, and that the panel was never asked.
   * Only the shared-identity arm emits it — see
   * {@link PanelLinkReconciliationService.selectSharedIdentityPairs}.
   */
  readonly resolvedBy: 'shortUuid' | 'username' | 'storedIdentity';
  readonly outcome: PanelLinkReconciliationOutcome;
  /** The code for {@link reason}; `null` on `linked` / `wouldLink`. */
  readonly reasonCode: PanelLinkRowReason | null;
  /** The identity that was (or would be) written; `null` when nothing resolved. */
  readonly remnawaveId: string | null;
  /**
   * What the row holds RIGHT NOW, before this walk touched anything: `null`
   * for the missing-identity population, the non-decimal value for the other.
   *
   * A report that shows only the NEW value cannot be checked. The operator has
   * to be able to see the identity that stopped working, both to recognise the
   * damage and to undo a repair that went to the wrong profile.
   */
  readonly storedRemnawaveId: string | null;
  readonly panelId: number | null;
  /**
   * The other row of a `duplicatePair`, `null` otherwise — including on a plain
   * `conflict`, where the two rows belong to DIFFERENT customers and are not a
   * pair at all (the holder is {@link otherSubscriptionId}).
   */
  readonly duplicateOfSubscriptionId: string | null;
  /**
   * The other subscription the reason is about, for a screen: the pair partner,
   * the other customer's holder of a `conflict`, or the subscription a
   * `subscription_id` line names. `null` when the reason names none.
   */
  readonly otherSubscriptionId: string | null;
  /** The other customer the reason is about (`ownedByOther`, `profileTaken`), else `null`. */
  readonly otherUserId: string | null;
  /**
   * True when the subscription THIS record describes is bound to the live panel
   * profile as this report leaves the database.
   *
   * THE FIELD EXISTS BECAUSE THE POLARITY IS BACKWARDS FROM INSTINCT. In the
   * pair a lost link produces, the OLDER row — the one carrying the customer's
   * history, payments and plan, the one that looks legitimate — holds an
   * identity the panel no longer answers to, and is bound to NOTHING. The
   * NEWER, wrong-looking duplicate stores the current decimal and is the row
   * actually pointing at the live profile. An operator who deletes the
   * wrong-looking card issues a panel DELETE against a paying customer's live
   * profile. So this is stated as a field rather than left to be inferred from
   * {@link storedRemnawaveId}.
   *
   * Per outcome:
   *   `linked`             true  — the write just bound it.
   *   `wouldLink`          false — a dry run wrote nothing; it is still dead.
   *   `staleIdentity`      true only in the "panel already agrees" case.
   *   `duplicatePair`      via a resolve: false on the scanned half, true on the
   *                        partner. Via `storedIdentity`: TRUE ON BOTH — both
   *                        rows store the identity, so both are bound and
   *                        neither may be deleted.
   *   `raceLost`           false — something else wrote an identity this walk
   *                        never verified, so there is nothing to vouch for.
   *   everything else      false.
   */
  readonly holdsLiveIdentity: boolean;
  /**
   * `true` for a row the walk itself selected and asked the panel about;
   * `false` for the partner a pair drags in and for the shared-identity arm's
   * rows, which were read out of the database. The automatic check keeps the
   * verdict of a scanned row only: that is the answer to "why is this row not
   * linked", and a partner's verdict is about another row.
   */
  readonly scanned: boolean;
  /** Why this row was not repaired. `null` on `linked` / `wouldLink`. */
  readonly reason: string | null;
}

export interface PanelLinkReconciliationReport {
  readonly dryRun: boolean;
  /** Rows examined by THIS invocation, capped by `limit`. */
  readonly scanned: number;
  readonly linked: number;
  readonly wouldLink: number;
  /** Rows that were repaired, or that a real run would repair. */
  readonly repaired: readonly PanelLinkReconciliationRow[];
  /**
   * Every row that was NOT repaired, each carrying its own reason.
   *
   * May be LONGER than `scanned - repaired.length`: each `duplicatePair`
   * contributes its partner row as well, and the partner was found, not
   * scanned. `subscriptionId` is what identifies a row here, never its index.
   */
  readonly unrepaired: readonly PanelLinkReconciliationRow[];
  /**
   * `true` when the walk stopped with the selection not exhausted — at
   * `limit`, at the time budget, or because the panel stopped answering. The
   * caller continues from {@link nextCursor}.
   */
  readonly hasMore: boolean;
  /**
   * `true` when the WALK read its selection to the end in this invocation.
   * Narrower than `!hasMore`, which also turns true when the shared-identity
   * arm was cut at its cap: that is the merge's backlog, not rows the walk has
   * yet to ask about, and waiting an hour does not shorten it — so the
   * automatic check schedules its retry on this, not on `hasMore`.
   */
  readonly walkComplete: boolean;
  /**
   * Where a continuation starts: the id of the last row the walk FINISHED, or
   * `null` when it finished none. A row the panel could not be asked about is
   * not finished, so a continuation asks about it again first.
   */
  readonly nextCursor: string | null;
  /**
   * `true` when the walk stopped because the panel did not answer — transport,
   * 5xx, auth, timeout. The rows after it were not asked about at all; one
   * failed read is taken to mean the panel is down, and asking it once per row
   * of a backlog would only make the outage louder. The automatic check
   * schedules its retry on this.
   */
  readonly panelUnavailable: boolean;
  /**
   * How many of {@link scanned} came from the NON-DECIMAL-identity population,
   * whatever became of them.
   */
  readonly staleIdentityScanned: number;
  /** How many duplicate PAIRS were diagnosed (each is two rows in `unrepaired`). */
  readonly duplicatePairs: number;
  /**
   * How many of {@link duplicatePairs} were found by the SHARED-IDENTITY arm —
   * two live rows storing one identity — rather than by resolving a row that
   * could not name its profile.
   */
  readonly sharedIdentityPairs: number;
}

export interface PanelLinkReconciliationOptions {
  /**
   * Writes happen ONLY on an explicit `false`. Anything else — omitted,
   * mistyped, a truthy string from a form — is a dry run, so the failure mode
   * of a malformed request is "reported nothing, changed nothing".
   */
  readonly dryRun?: boolean;
  readonly limit?: number;
  /**
   * Rows per database page, at most {@link PANEL_LINK_RECONCILIATION_PAGE_SIZE}
   * (the default). Smaller pages change nothing but how often the walk asks.
   */
  readonly pageSize?: number;
  /** Resume point: only rows with `id > startAfterId` are considered. */
  readonly startAfterId?: string | null;
  /**
   * A wall-clock budget for the WALK, in milliseconds. When it runs out the
   * walk stops before the next row and reports `hasMore`. Absent: no budget
   * (the row cap still applies).
   */
  readonly budgetMs?: number;
}

/** The row shape the selection reads. Nothing else is needed to repair one. */
interface BrokenLinkRow {
  readonly id: string;
  readonly userId: string;
  /**
   * `null` for the missing-identity population; the non-decimal string for
   * the second one. Which population a row came from is read off THIS field
   * and nothing else — the two selection arms are mutually exclusive on
   * exactly it.
   */
  readonly remnawaveId: string | null;
  readonly remnawavePanelUsername: string | null;
  readonly configUrl: string | null;
}

/** The live row a resolved profile collided with, read out of the database. */
interface ProfileHolder {
  readonly id: string;
  readonly userId: string;
  readonly remnawaveId: string | null;
  readonly remnawavePanelId: number | null;
  readonly remnawavePanelUsername: string | null;
}

/** One scanned row's verdict, plus the partner row a pair drags in with it. */
interface RowVerdict {
  readonly row: PanelLinkReconciliationRow;
  readonly partner: PanelLinkReconciliationRow | null;
  /** The panel did not answer for this row: the walk stops before the next one. */
  readonly panelUnavailable?: boolean;
}

/**
 * One row of a shared-identity cluster, as the members query reads it.
 *
 * `createdAt` is NOT among these columns and that is deliberate: which member is
 * the oldest is decided by the `ORDER BY` on the query itself — the same
 * `created_at ASC, id ASC` the dry-run holder probe and `writeLink`'s raw probe
 * already use — so there is one spelling of the survivor rule, not a fourth.
 */
interface SharedIdentityMember {
  readonly id: string;
  readonly userId: string;
  readonly remnawaveId: string | null;
  readonly remnawavePanelId: number | null;
  readonly remnawavePanelUsername: string | null;
}

/** What one shared-identity cluster is keyed by, and how it spells the profile. */
interface SharedIdentityGroup {
  /** The identity BOTH members store, in the spelling the report carries. */
  readonly remnawaveId: string;
  /** The numeric panel id when the group is keyed by one; `null` otherwise. */
  readonly panelId: number | null;
  readonly members: SharedIdentityMember[];
}

/** The unordered key two subscription ids make, so one pair is reported once. */
function pairKey(left: string, right: string): string {
  return [left, right].sort().join('|');
}

/**
 * PanelLinkReconciliationService
 * ──────────────────────────────
 * The repair for subscriptions whose panel profile EXISTS but which cannot name
 * it: the walk over {@link PANEL_LINK_POPULATION_SQL}, one resolve and one
 * profile read per row, the ownership proof, the collision check, and the
 * rewrite of `remnawave_id` to the panel's own decimal id. Two populations, one
 * walk, one report — the per-row `outcome` says what became of each row.
 *
 * WHO RUNS IT (owner's decision, 24.09.2026). Nobody presses a button any more:
 * `PanelLinkCheckService` runs it for real at worker boot, after every backup
 * import, once a day and an hour after a run that could not finish, and lists
 * what it could not prove in «Подписки» → «Инструменты» → «Подписки без
 * привязки к Remnawave». `DuplicateSubscriptionMergeService` runs it as a
 * PREVIEW to find its pairs. Our own ids never change: the only column a
 * repair writes is the LINK (`remnawave_id`, with the numeric
 * `remnawave_panel_id` beside it).
 *
 * NOTHING HERE MUTATES THE PANEL. The only two panel calls are
 * `resolveUser` (`POST /api/users/resolve`, a read behind a POST) and
 * `getUserById` (a profile read). No create, no rename, no delete. That is a
 * property to preserve, not a coincidence: every repair this service performs
 * is a LOCAL write correcting which panel profile a local row NAMES.
 *
 * ── POPULATION 1: NO IDENTITY AT ALL ─────────────────────────────────────────
 *
 * WHERE THOSE ROWS CAME FROM. `unwrapPanelUser` used to CAST the create/update
 * response into `RemnawavePanelUser` instead of decoding it. A Remnawave 3.x
 * user row has no `uuid` field at all, so the cast produced an object whose
 * `uuid` was `undefined` while its type promised `string`.
 * `persistProfileLink` passed that into a Prisma `update`, Prisma reads
 * `undefined` as "leave this column alone", and the write SUCCEEDED having
 * recorded no identity: the panel profile was live, `remnawave_id` stayed NULL
 * forever, and the sync job reported COMPLETED. The decoder is fixed, so no NEW
 * row can land in this state — but a decoder cannot repair the rows already in
 * it, because the fact it needs (which profile this row owns) lives on the
 * panel, not in the response we failed to read months ago.
 *
 * THE SIGNATURE OF THE DAMAGE, and why it is precise. `persistProfileLink`
 * wrote FOUR columns in one statement: `remnawaveId` and `remnawavePanelId`
 * both came from the undecoded body and were therefore `undefined` (skipped),
 * while `remnawavePanelUsername` and `configUrl` came from arguments that were
 * NOT undefined and did land. A live row with a panel username and a config URL
 * but no identity at all is reachable no other way:
 *   • a row that was never provisioned has neither of the two;
 *   • a row detached by `reprovisionMissingProfile` or by `handleDelete` has
 *     all four cleared in the same statement;
 *   • the manual link endpoint writes all of them together.
 * It is deliberately NOT widened to "any unlinked row": those are the ordinary
 * pre-provision state, and asking the panel to name a profile for them would
 * invent links for subscriptions that never had one. (The per-customer
 * comparison, `PanelProfileComparisonService`, reaches those rows by a
 * different proof: the `reiwa_id` line of a profile nobody links.)
 *
 * ── POPULATION 2: AN IDENTITY NO SUPPORTED PANEL ISSUED ──────────────────────
 *
 * Remnawave 3.x dropped the `uuid` column outright and names every user by a
 * decimal id. A row linked while the panel was 2.x still holds that uuid, and a
 * donor's backup can bring an empty string or junk; none of them names anybody
 * the panel answers to. Remnawave 2.x itself is refused centrally
 * (`LegacyPanelRefusal`), so there is one era and no probe of it here.
 *
 * WHAT THIS WALK DOES NOT DO. It does not merge the duplicate pair a lost link
 * produced. It diagnoses it (`duplicatePair`, with both halves named and the
 * live one flagged) and stops.
 */
@Injectable()
export class PanelLinkReconciliationService {
  private readonly logger = new Logger(PanelLinkReconciliationService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly panelUsers: PanelUsersClient,
  ) {}

  public async reconcile(
    options: PanelLinkReconciliationOptions = {},
  ): Promise<PanelLinkReconciliationReport> {
    // `!== false`, not `?? true`: a caller that sent `dryRun: 'false'` (a form
    // field, a query string) must not be read as a request to write.
    const dryRun = options.dryRun !== false;
    const limit = clampPositive(
      options.limit,
      PANEL_LINK_RECONCILIATION_DEFAULT_LIMIT,
      PANEL_LINK_RECONCILIATION_MAX_LIMIT,
    );
    const pageCeiling = clampPositive(
      options.pageSize,
      PANEL_LINK_RECONCILIATION_PAGE_SIZE,
      PANEL_LINK_RECONCILIATION_PAGE_SIZE,
    );
    const deadline =
      typeof options.budgetMs === 'number' && Number.isFinite(options.budgetMs) && options.budgetMs > 0
        ? Date.now() + options.budgetMs
        : null;

    const repaired: PanelLinkReconciliationRow[] = [];
    const unrepaired: PanelLinkReconciliationRow[] = [];
    /**
     * Every pair the WALK already named, so the shared-identity arm does not
     * report the same two rows a second time.
     *
     * Only exact pairs are suppressed. A row already named in one pair is NOT
     * struck out of others: a walk pair the merge later refuses would then
     * silently starve every shared pair its members belong to.
     */
    const walkPairKeys = new Set<string>();
    let cursor: string | null =
      typeof options.startAfterId === 'string' && options.startAfterId.length > 0
        ? options.startAfterId
        : null;
    let scanned = 0;
    let staleIdentityScanned = 0;
    let duplicatePairs = 0;
    let hasMore = false;
    let panelUnavailable = false;
    /** Set only where the selection is seen to END — never by a cap, a budget or an outage. */
    let walkComplete = false;

    walk: while (scanned < limit) {
      // One more than needed, so "the cap was reached AND rows remain" is
      // answered without a second query — and without reporting `hasMore` for a
      // selection that merely happened to end exactly on the boundary.
      const pageSize = Math.min(pageCeiling, limit - scanned);
      const page = await this.selectBrokenLinks(cursor, pageSize + 1);
      const rows = page.slice(0, pageSize);
      if (rows.length === 0) {
        walkComplete = true;
        break;
      }

      for (const row of rows) {
        if (deadline !== null && Date.now() >= deadline) {
          // Out of time with this row not asked about: the cursor stays on the
          // last row finished, so a continuation starts here.
          hasMore = true;
          break walk;
        }
        const verdict = await this.reconcileRow(row, dryRun);
        const result = verdict.row;
        (result.outcome === 'linked' || result.outcome === 'wouldLink'
          ? repaired
          : unrepaired
        ).push(result);
        if (verdict.partner !== null) unrepaired.push(verdict.partner);
        if (result.outcome === 'duplicatePair') {
          duplicatePairs += 1;
          if (result.duplicateOfSubscriptionId !== null) {
            walkPairKeys.add(pairKey(result.subscriptionId, result.duplicateOfSubscriptionId));
          }
        }
        // Which population this row came from, read off the one column that
        // separates the two selection arms.
        if (row.remnawaveId !== null) staleIdentityScanned += 1;
        scanned += 1;
        // Named in the log too, not only in the report: the list an operator
        // opens shows the latest verdict, the one reading logs a week later sees
        // the same rows.
        if (result.reason !== null) {
          this.logger.warn(
            `Panel link check: subscription ${result.subscriptionId} (user ` +
              `${result.userId}, panel username '${result.panelUsername}', stored identity ` +
              `'${result.storedRemnawaveId ?? 'none'}', tried ${result.resolvedBy}) not ` +
              `repaired — ${result.outcome}: ${result.reason}`,
          );
        }
        if (verdict.partner !== null) {
          this.logger.warn(
            `Panel link check: subscription ${verdict.partner.subscriptionId} is the ` +
              `LIVE half of the duplicate pair with ${result.subscriptionId} — ` +
              `${verdict.partner.reason}`,
          );
        }
        if (verdict.panelUnavailable === true) {
          // ONE failed read ends the walk. The panel is taken to be down, and
          // asking it again once per remaining row would make the outage louder
          // without learning anything. The row is REPORTED (its reason says
          // the panel could not be asked) but not FINISHED: the cursor stays
          // before it, so a continuation asks about it first.
          panelUnavailable = true;
          hasMore = true;
          break walk;
        }
        cursor = row.id;
      }

      // ASSIGNED, never latched. The extra row proves only that THIS page did
      // not drain the selection; the next page may. A `hasMore = true` that is
      // never cleared survives the page that finished the walk and sends the
      // caller round a loop of runs that repair nothing.
      hasMore = page.length > rows.length;
      if (!hasMore) {
        walkComplete = true;
        break;
      }
      // The cap, not the page, is what stops the walk — `scanned < limit` ends
      // it on the next turn when the cap is what we hit.
      if (scanned >= limit) break;
    }

    // ── THE SHARED-IDENTITY ARM ──────────────────────────────────────────────
    //
    // RUN AFTER THE WALK, ON PURPOSE. A real run's walk WRITES, and this arm
    // reads identity columns, so it must see the state the walk left rather
    // than the one it started from. (The walk cannot itself create a shared
    // identity: `writeLink` probes for a holder under the profile advisory lock
    // and reports a `duplicatePair` instead of writing when it finds one. What
    // it can do is REMOVE one, by repairing a row — and reading after the fact
    // is what keeps this arm from reporting a pair that no longer exists.)
    //
    // NOT SCOPED BY THE CURSOR. `startAfterId` pages the WALK, whose selection
    // shrinks as it repairs; this arm is one whole-table aggregate whose answer
    // is not a page of rows. Scoping it to the cursor would hide every cluster
    // behind the resume point. Re-reporting an already-merged cluster is not the
    // opposite risk it looks like: a merge retires one half, the group drops to
    // one member, and the pair stops being reported by itself.
    const shared = await this.selectSharedIdentityPairs(walkPairKeys);
    for (const row of shared.rows) unrepaired.push(row);
    duplicatePairs += shared.pairs;
    if (shared.truncated) hasMore = true;
    for (const row of shared.rows) {
      if (row.duplicateOfSubscriptionId === null) continue;
      // The PROFILE both halves name, and separately what THIS half stores.
      // They are not always the same string: on a pair found through the numeric
      // panel id one half can still be holding a non-decimal identity, and a
      // log line that printed the stored value as though it were the profile
      // would name a dead identity as the live one.
      this.logger.warn(
        `Panel link check: subscriptions ${row.subscriptionId} and ` +
          `${row.duplicateOfSubscriptionId} (user ${row.userId}) are BOTH live and BOTH name ` +
          `panel profile ${row.remnawaveId ?? 'unknown'}; this half stores ` +
          `'${row.storedRemnawaveId ?? 'none'}' — ${row.reason}`,
      );
    }

    const linked = repaired.filter((row) => row.outcome === 'linked').length;
    return {
      dryRun,
      scanned,
      linked,
      wouldLink: repaired.length - linked,
      repaired,
      unrepaired,
      hasMore,
      walkComplete,
      nextCursor: cursor,
      panelUnavailable,
      staleIdentityScanned,
      duplicatePairs,
      sharedIdentityPairs: shared.pairs,
    };
  }

  /**
   * The damaged rows, paged by id: {@link PANEL_LINK_POPULATION_SQL}.
   *
   * Paged by `id > cursor` rather than by OFFSET on purpose: a real run REMOVES
   * rows from this selection as it repairs them, and an offset walk over a
   * shrinking set skips one row for every row it fixes. That holds for both
   * arms: repairing a missing-identity row makes `remnawave_id` non-null and
   * decimal, and repairing a non-decimal one rewrites it to the decimal. Either
   * way the row leaves the selection under the walk's own feet. Rows that are
   * NOT repaired stay in it, and the cursor — advanced per ROW, not per page —
   * is what keeps the walk from re-reading them forever.
   *
   * RAW SQL, because the second arm is a regular expression and Prisma's
   * `where` has none. A non-decimal row with NEITHER route is selected all the
   * same, so that it is REPORTED — by name, with a reason, and without costing
   * a panel round-trip — instead of being silently absent. {@link reconcileRow}
   * short-circuits it before either panel call.
   */
  private async selectBrokenLinks(cursor: string | null, take: number): Promise<BrokenLinkRow[]> {
    return this.prismaService.$queryRaw<BrokenLinkRow[]>(Prisma.sql`
      SELECT "id",
             "user_id" AS "userId",
             "remnawave_id" AS "remnawaveId",
             "remnawave_panel_username" AS "remnawavePanelUsername",
             "config_url" AS "configUrl"
      FROM "subscriptions"
      WHERE "status" <> 'DELETED'
        ${cursor === null ? Prisma.empty : Prisma.sql`AND "id" > ${cursor}`}
        AND ${PANEL_LINK_POPULATION_SQL}
      ORDER BY "id" ASC
      LIMIT ${take}
    `);
  }

  /**
   * TWO LIVE ROWS OF ONE CUSTOMER THAT ALREADY NAME THE SAME PANEL PROFILE.
   *
   * ── WHY THE OTHER SELECTION CANNOT ASK THIS ──────────────────────────────
   *
   * {@link selectBrokenLinks} asks "is THIS link broken?". That is a predicate
   * over one row at a time, and no predicate over one row can notice that a
   * DIFFERENT row holds the same string. So the moment both halves of a cluster
   * carry a well-formed identity the cluster becomes invisible — which is
   * precisely the state a MERGE leaves behind, because the survivor takes the
   * duplicate's identity. A cluster of three therefore used to stop halfway:
   * the first merge was found, the second never was, and the customer was left
   * with two live rows able to overwrite and delete each other's service.
   *
   * ── WHAT COUNTS AS IDENTITY HERE, AND WHAT DOES NOT ──────────────────────
   *
   * The two IMMUTABLE identifiers, and only those — the same two-angled
   * question `writeLink`'s conflict probe asks:
   *
   *   • `remnawave_id`, DECIMAL and EQUAL as strings. A profile's identity is
   *     that profile's forever, so two live rows carrying the identical decimal
   *     carry one profile. Non-decimal spellings are the walk's population, and
   *     the walk diagnoses them with the panel's own answer rather than a
   *     string match (see the `where` below).
   *   • `remnawave_panel_id`, non-null and EQUAL. A numeric panel id names one
   *     profile forever too, and it is how a row still holding a non-decimal
   *     identity and an importer-minted one can be shown to be the same profile.
   *
   * NULLS ARE EXCLUDED FROM BOTH, not compared. `remnawave_panel_id` carries no
   * unique constraint (migration 20260810160000 records why one cannot be added
   * to live data), so grouping nulls together would put every row that has none
   * in one bucket and turn "who is this profile" into "anybody".
   *
   * `remnawave_panel_username` IS DELIBERATELY NOT IDENTITY. Panel usernames are
   * DETERMINISTIC (`clampPanelUsername` documents that determinism as a
   * requirement, because the CREATE path uses the name as its crash-recovery
   * key), so a profile that was deleted frees its name and the NEXT profile
   * provisioned for that customer inherits it. Two live rows sharing a username
   * are then the row that lost its profile and the row that got the
   * replacement — two DIFFERENT profiles. Merging them would move a live
   * subscription's history onto a dead row and retire the live one.
   *
   * `config_url` is excluded for a weaker but sufficient reason: it is a resolve
   * ROUTE, not an identity. It is regenerated when a subscription link is
   * rotated, so one profile can have had two.
   *
   * ── SAME CUSTOMER ONLY ───────────────────────────────────────────────────
   *
   * Groups are formed per `user_id`. Two rows of DIFFERENT customers sharing an
   * identity is a genuine collision, not a pair, and {@link describeCollision}
   * explains why nothing sound distinguishes "one customer the importer split in
   * two" from "two customers". A merge moves payments and referral spends
   * between subscriptions, so a pair is claimed only where the owner is proven
   * identical.
   *
   * ── NO PANEL CALL, AND NO WRITE ──────────────────────────────────────────
   *
   * These rows already name their profile — twice — so the panel has nothing to
   * add, and this arm makes no call at all. It also writes nothing: it reports
   * the pair, and the survivor rule, the ownership proof and every guard live in
   * `DuplicateSubscriptionMergeService`, which re-verifies each pair from the
   * database AND the panel before a byte is written.
   *
   * ── COST ─────────────────────────────────────────────────────────────────
   *
   * THREE statements per invocation, and the number does not move with the size
   * of the table: two aggregates that return only the identities held more than
   * once, then ONE `IN` lookup for the member rows of those identities. Two
   * statements when nothing is shared, because the lookup is skipped.
   *
   * ── WHICH MEMBER IS THE SURVIVOR ─────────────────────────────────────────
   *
   * The oldest, and it is decided by the ORDER BY on the members query —
   * `created_at ASC, id ASC`, the same order the dry-run holder probe and
   * `writeLink`'s raw probe use, and the order the fixed importer converges on.
   * Every pair is anchored on the group's FIRST member, so the oldest row of the
   * WHOLE cluster is one half of every pair the cluster produces.
   */
  private async selectSharedIdentityPairs(
    excludePairKeys: ReadonlySet<string>,
  ): Promise<{
    rows: PanelLinkReconciliationRow[];
    pairs: number;
    truncated: boolean;
  }> {
    const live = { status: { not: SubscriptionStatus.DELETED } };

    // ONE grouped pass per angle. `having` is what makes it an aggregate rather
    // than a scan: only identities held by MORE THAN ONE live row come back, so
    // the result is the defect population and not the table.
    const identityGroups = await this.prismaService.subscription.groupBy({
      by: ['remnawaveId'],
      where: {
        ...live,
        remnawaveId: { not: null },
        // NON-DECIMAL SPELLINGS ARE THE WALK'S POPULATION, NOT THIS ONE, and the
        // two are kept apart the way the walk's own two arms are. Two live rows
        // sharing a dead 2.x uuid ARE on one profile — but the walk already
        // selects both, resolves them on the panel and diagnoses the pair with
        // the panel's own answer. Claiming them here as well would report one
        // row under two verdicts at once ("this would be repaired" and "this is
        // half of a pair"), and an operator cannot act on both.
        //
        // `contains: '-'` is the uuid half of "not a decimal", which is the half
        // that can be shared: an identity is shared by being COPIED from one row
        // to another, and a uuid is what a 2.x panel handed out. The other
        // non-decimal spellings (an empty string, a donor's junk) are never an
        // identity two rows could legitimately share, and the walk names each of
        // them on its own.
        NOT: { remnawaveId: { contains: '-' } },
      },
      having: { remnawaveId: { _count: { gt: 1 } } },
      orderBy: { remnawaveId: 'asc' },
      take: PANEL_LINK_SHARED_IDENTITY_MAX_GROUPS + 1,
    });
    const panelIdGroups = await this.prismaService.subscription.groupBy({
      by: ['remnawavePanelId'],
      where: { ...live, remnawavePanelId: { not: null } },
      having: { remnawavePanelId: { _count: { gt: 1 } } },
      orderBy: { remnawavePanelId: 'asc' },
      take: PANEL_LINK_SHARED_IDENTITY_MAX_GROUPS + 1,
    });

    // The `not: null` in each `where` is what keeps these lists free of the
    // null bucket; the narrowing here is the type system catching up with it.
    const allIdentities = identityGroups
      .map((group) => group.remnawaveId)
      .filter((value): value is string => typeof value === 'string');
    const allPanelIds = panelIdGroups
      .map((group) => group.remnawavePanelId)
      .filter((value): value is number => typeof value === 'number');
    const truncatedGroups =
      allIdentities.length > PANEL_LINK_SHARED_IDENTITY_MAX_GROUPS ||
      allPanelIds.length > PANEL_LINK_SHARED_IDENTITY_MAX_GROUPS;
    const identities = allIdentities.slice(0, PANEL_LINK_SHARED_IDENTITY_MAX_GROUPS);
    const panelIds = allPanelIds.slice(0, PANEL_LINK_SHARED_IDENTITY_MAX_GROUPS);

    const angles: Prisma.SubscriptionWhereInput[] = [];
    if (identities.length > 0) angles.push({ remnawaveId: { in: identities } });
    if (panelIds.length > 0) angles.push({ remnawavePanelId: { in: panelIds } });
    // Nothing is shared. The third statement is not issued at all rather than
    // being issued with an empty `IN`, which is the ordinary case on a healthy
    // database and the one this arm must cost the least in.
    if (angles.length === 0) return { rows: [], pairs: 0, truncated: truncatedGroups };

    const members = await this.prismaService.subscription.findMany({
      where: { ...live, OR: angles },
      // THE SURVIVOR RULE, SPELLED ONCE. See the note above; `id` settles an
      // exact `created_at` tie so the same cluster names the same anchor every
      // run, which is what makes an operator's preview match their merge.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: PANEL_LINK_SHARED_IDENTITY_MAX_MEMBERS + 1,
      select: {
        id: true,
        userId: true,
        remnawaveId: true,
        remnawavePanelId: true,
        remnawavePanelUsername: true,
      },
    });
    const truncatedMembers = members.length > PANEL_LINK_SHARED_IDENTITY_MAX_MEMBERS;
    // Truncation drops the NEWEST members, never the anchor: the rows arrive
    // oldest-first, so a cluster cut short still pairs on its real oldest row
    // and the tail is picked up by the next run.
    const ordered = members.slice(0, PANEL_LINK_SHARED_IDENTITY_MAX_MEMBERS);

    const identitySet = new Set(identities);
    const panelIdSet = new Set(panelIds);
    const groups = new Map<string, SharedIdentityGroup>();
    const collect = (key: string, group: SharedIdentityGroup, member: SharedIdentityMember) => {
      const existing = groups.get(key);
      if (existing === undefined) groups.set(key, { ...group, members: [member] });
      else existing.members.push(member);
    };
    for (const member of ordered) {
      // A row can belong to a group on BOTH angles at once. Both are collected
      // and the resulting pairs are de-duplicated below, rather than one angle
      // being preferred: which angle sees a cluster depends on which columns
      // happen to have been recorded, and neither is more authoritative.
      if (member.remnawaveId !== null && identitySet.has(member.remnawaveId)) {
        collect(
          `identity\x00${member.userId}\x00${member.remnawaveId}`,
          { remnawaveId: member.remnawaveId, panelId: null, members: [] },
          member,
        );
      }
      if (member.remnawavePanelId !== null && panelIdSet.has(member.remnawavePanelId)) {
        collect(
          `panelId\x00${member.userId}\x00${member.remnawavePanelId}`,
          {
            // The identity spelling for a group keyed by the numeric id: on a
            // 3.x panel the decimal id IS the identity — the same rule
            // `parsePanelUserRow` follows for a 3.x row.
            remnawaveId: String(member.remnawavePanelId),
            panelId: member.remnawavePanelId,
            members: [],
          },
          member,
        );
      }
    }

    const seen = new Set(excludePairKeys);
    const rows: PanelLinkReconciliationRow[] = [];
    let pairs = 0;
    for (const group of groups.values()) {
      // A group of one is not a cluster. Reachable even though the aggregate
      // filtered on `_count > 1`: the aggregate counts rows sharing an identity
      // across ALL customers, and this grouping splits them by `user_id`.
      if (group.members.length < 2) continue;
      const [anchor, ...rest] = group.members;
      if (anchor === undefined) continue;
      for (const other of rest) {
        const key = pairKey(anchor.id, other.id);
        if (seen.has(key)) continue;
        seen.add(key);
        pairs += 1;
        rows.push(
          this.describeSharedIdentity(anchor, other, group, true),
          this.describeSharedIdentity(other, anchor, group, false),
        );
      }
    }
    return { rows, pairs, truncated: truncatedGroups || truncatedMembers };
  }

  /**
   * One half of a shared-identity pair.
   *
   * `holdsLiveIdentity` IS TRUE ON BOTH, and that is the fact an operator has to
   * come away with. On the pair a broken link produces exactly one half is bound
   * and the other is a dead row that looks legitimate; here BOTH rows store the
   * profile's identity, so there is no half that can be deleted safely. A
   * `DELETED` row that still names a profile is what
   * `SubscriptionDeletionService.deleteSubscription` turns into a panel DELETE.
   */
  private describeSharedIdentity(
    self: SharedIdentityMember,
    other: SharedIdentityMember,
    group: SharedIdentityGroup,
    selfIsOlder: boolean,
  ): PanelLinkReconciliationRow {
    const older = selfIsOlder ? self.id : other.id;
    return {
      subscriptionId: self.id,
      userId: self.userId,
      panelUsername: self.remnawavePanelUsername ?? '',
      // Nothing was resolved. Both rows already name the profile, so the panel
      // was never asked — see the union's own note.
      resolvedBy: 'storedIdentity',
      outcome: 'duplicatePair',
      reasonCode: 'duplicatePair',
      remnawaveId: group.remnawaveId,
      storedRemnawaveId: self.remnawaveId,
      panelId: self.remnawavePanelId ?? group.panelId,
      duplicateOfSubscriptionId: other.id,
      otherSubscriptionId: other.id,
      otherUserId: null,
      holdsLiveIdentity: true,
      scanned: false,
      reason:
        `subscription ${other.id} — the SAME customer (${self.userId}) — is LIVE on panel ` +
        `profile ${group.remnawaveId}, and so is this row: both of them STORE that identity. ` +
        'This is not a broken link, it is two live subscriptions on one profile, and they ' +
        "overwrite and delete each other's service. BOTH halves are bound to the live profile, " +
        'so unlike the pair a broken link produces there is no wrong-looking half here — ' +
        `deleting EITHER enqueues a panel DELETE against a paying customer's live profile. ` +
        `Subscription ${older} is the OLDER row and is the one a merge keeps. Nothing was ` +
        'changed; merge them in «Подписки» → «Инструменты» → «Слияние подписок-дубликатов».',
    };
  }

  /**
   * One row: resolve it on the panel, prove it is ours, then link it.
   *
   * EXACTLY ONE RESOLVE, and the two routes are ordered, not raced:
   *
   *  1. the subscription short UUID recovered from the stored `config_url`.
   *     It is unique panel material issued to this profile and to no other, so
   *     a stale one names the right profile or nobody.
   *  2. the stored panel username — ONLY when there is no short UUID.
   *     Deliberately second, and never a fallback for a short UUID that failed
   *     to resolve: panel usernames are DETERMINISTIC, so a profile that was
   *     deleted and re-provisioned carries the SAME name as the one this row
   *     lost. Resolving by name can therefore land on a DIFFERENT, live
   *     profile. The ownership check below is what makes route 2 usable at all.
   *
   * THE STORED IDENTITY IS NEVER USED AS A RESOLVE KEY. For the non-decimal
   * population it is precisely the string the panel cannot answer to, and for
   * the other one there is none.
   */
  private async reconcileRow(row: BrokenLinkRow, dryRun: boolean): Promise<RowVerdict> {
    const stored = row.remnawaveId;
    const panelUsername = row.remnawavePanelUsername ?? '';
    const shortUuid = panelShortUuidFromConfigUrl(row.configUrl ?? null);
    const useShortUuid = shortUuid !== null && shortUuid.length > 0;
    const resolvedBy: 'shortUuid' | 'username' = useShortUuid ? 'shortUuid' : 'username';
    const describe: DescribeRow = (outcome, reasonCode, reason, remnawaveId = null, panelId = null, extra = {}) => ({
      subscriptionId: row.id,
      userId: row.userId,
      panelUsername,
      resolvedBy,
      outcome,
      reasonCode,
      remnawaveId,
      storedRemnawaveId: stored,
      panelId,
      duplicateOfSubscriptionId: extra.duplicateOfSubscriptionId ?? null,
      otherSubscriptionId: extra.otherSubscriptionId ?? extra.duplicateOfSubscriptionId ?? null,
      otherUserId: extra.otherUserId ?? null,
      holdsLiveIdentity: extra.holdsLiveIdentity ?? false,
      scanned: true,
      reason,
    });
    const alone = (result: PanelLinkReconciliationRow, panelUnavailable = false): RowVerdict => ({
      row: result,
      partner: null,
      panelUnavailable,
    });

    if (!useShortUuid && panelUsername.length === 0) {
      // Population 1 cannot reach this (its arm requires a non-null username),
      // but an empty string passes `IS NOT NULL` — and resolving by it would
      // ask the panel "which user is called nothing?" and act on the answer.
      // Population 2 reaches it BY DESIGN: those rows are selected in order to
      // be named here, and they cost the panel nothing.
      return alone(
        stored === null
          ? describe('unresolved', 'noRoute', 'no subscription short UUID and no panel username')
          : describe(
              'staleIdentity',
              'noRoute',
              `stored identity '${stored}' is not a panel id a supported Remnawave can answer to, ` +
                'and neither a subscription short UUID nor a panel username was ever recorded for ' +
                'this row — there is no resolve route at all, so nothing can repair it ' +
                'automatically. The panel profile must be identified by hand.',
            ),
      );
    }

    const selector = useShortUuid
      ? { shortUuid: shortUuid as string }
      : { username: panelUsername };
    const resolution = await this.panelUsers.resolveUser(selector);
    if (resolution.kind !== 'ok') {
      const failure = readPanelFailure(resolution);
      const asked = useShortUuid
        ? `shortUuid '${shortUuid}'`
        : `username '${panelUsername}'`;
      // WHY THE PANEL COULD NOT NAME IT IS PART OF THE ROW. A `null` that meant
      // a missing profile, an expired token, a 5xx and a timeout alike told an
      // operator every row was unresolvable during an outage.
      return failure.kind === 'missing'
        ? alone(describe('unresolved', 'notFound', `panel did not resolve ${asked}`))
        : alone(
            describe(
              'unresolved',
              'panelUnavailable',
              `panel could not be asked about ${asked} (${failure.detail}); nothing was changed`,
            ),
            true,
          );
    }
    const resolved = resolution.data.response;

    // THE SPELLING TO STORE IS THE PANEL'S OWN. 3.x has no uuid to return and
    // keys everything by the numeric id, so the decimal IS the identity.
    const remnawaveId = String(resolved.id);

    if (stored !== null && stored === remnawaveId) {
      // The row was selected as non-decimal and the panel answers with the very
      // string it already holds, so there is nothing to rewrite and no repair
      // may be invented from the disagreement.
      //
      // REACHABLE ONLY THROUGH DRIFT, and kept for exactly that. The contract
      // declares `id` as a number, so a conforming answer is always a decimal —
      // but the executor is LENIENT and hands back a body it could not validate
      // RAW, so this field can arrive as whatever the panel sent.
      return alone(
        describe(
          'staleIdentity',
          'panelAgrees',
          `the panel answers for this profile with the identity the row already holds ` +
            `('${stored}'), so there is nothing to rewrite — this row was selected as a ` +
            "non-decimal identity and the panel's own answer disagrees with that. Nothing was changed.",
          remnawaveId,
          resolved.id,
          { holdsLiveIdentity: true },
        ),
      );
    }

    // The resolve answers WHERE the profile is; it does not answer WHOSE it is.
    // The description — which carries the `reiwa_id` marker — only comes back
    // on a full profile read, so this second round-trip is the ownership check,
    // not a convenience.
    //
    // THE READ IS ADDRESSED BY THE NUMERIC ID THE RESOLVE JUST RETURNED, and by
    // nothing else — no username, no short UUID — so a hidden second resolve by
    // name is impossible rather than merely unintended.
    const outcome = await this.panelUsers.getUserById(resolved.id);
    if (outcome.kind !== 'ok') {
      const failure = readPanelFailure(outcome);
      return failure.kind === 'missing'
        ? alone(
            describe(
              'unresolved',
              'profileGone',
              `panel resolved ${resolvedBy} to profile ${remnawaveId} but that profile is gone`,
              remnawaveId,
              resolved.id,
            ),
          )
        : alone(
            describe(
              'unresolved',
              'panelUnavailable',
              `panel profile ${remnawaveId} could not be read back (${failure.detail}); ` +
                'nothing was changed',
              remnawaveId,
              resolved.id,
            ),
            true,
          );
    }
    const profile = outcome.data.response;

    try {
      // "A profile answers to this name" is not "this profile is mine". The
      // owner is read from the `reiwa_id` LINE — a display name forging it
      // does not count — and it has to be PROVEN: a description with no such
      // line is refused, because a row resolved by its stored name can land on
      // another customer's profile. See `assertPanelProfileOwnership`.
      assertPanelProfileOwnership(panelUsername, profile.description, row.userId);
    } catch (err: unknown) {
      const owners = [...new Set(readProfileOwnerMarkers(profile.description))];
      const otherOwner = owners.length === 1 ? owners[0] : null;
      return alone(
        describe(
          'notOwned',
          otherOwner !== null ? 'ownedByOther' : 'noOwnerProof',
          (err as Error).message,
          remnawaveId,
          resolved.id,
          { otherUserId: otherOwner },
        ),
      );
    }

    // THE SUBSCRIPTION LINE (owner's decision, 24.09.2026): when the profile
    // says which subscription it was made for, an automatic link gives it to
    // that one or to none. Ownership is already proven above — this stops a
    // customer's profile landing on the wrong one of THEIR subscriptions.
    const namedSubscriptions = [...new Set(readProfileSubscriptionMarkers(profile.description))];
    const otherNamed = namedSubscriptions.find((named) => named !== row.id);
    if (otherNamed !== undefined) {
      return alone(
        describe(
          'markedForOtherSubscription',
          'markedForOtherSubscription',
          `Remnawave profile ${remnawaveId} is this customer's, but its subscription_id line names ` +
            `subscription ${otherNamed}, not ${row.id} — refusing to link it automatically`,
          remnawaveId,
          resolved.id,
          { otherSubscriptionId: otherNamed },
        ),
      );
    }

    if (dryRun) {
      // The preview asks the exclusivity question too. A dry run that reported
      // "would link" for a row a real run would refuse is not a preview.
      //
      // ORDERED, BECAUSE THIS ANSWER PICKS A MERGE PARTNER. A cluster of THREE
      // or more live rows naming one profile is reachable, and
      // `DuplicateSubscriptionMergeService.discoverPairs` takes
      // `duplicateOfSubscriptionId` — this row — as the pair's other half. With
      // no `orderBy` that is whichever row Postgres happened to return first,
      // so two identical runs could name two different pairs.
      //
      // `createdAt` ASC then `id` ASC, and the SAME order as the raw probe in
      // {@link writeLink}: the oldest live row naming a profile is the
      // canonical one, which is the rule the merge derives its survivor from
      // and the one the fixed importer converges on.
      const holder = await this.prismaService.subscription.findFirst({
        where: {
          id: { not: row.id },
          status: { not: SubscriptionStatus.DELETED },
          OR: [{ remnawaveId }, { remnawavePanelId: resolved.id }],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          userId: true,
          remnawaveId: true,
          remnawavePanelId: true,
          remnawavePanelUsername: true,
        },
      });
      if (holder !== null) {
        return this.describeCollision(row, holder, remnawaveId, resolved.id, describe, resolvedBy);
      }
      return alone(describe('wouldLink', null, null, remnawaveId, resolved.id));
    }

    return this.writeLink(row, remnawaveId, resolved.id, describe, resolvedBy);
  }

  /**
   * Two live rows on one panel profile: which of the two things is it?
   *
   * A GENUINE COLLISION (different customers) is the dangerous one and keeps
   * the old `conflict` name and refusal. THE PAIR A LOST LINK PRODUCED (both
   * rows on one `userId`) is a different animal: the importer saw one customer
   * as two and minted a second Subscription for the profile they already had.
   * It is reported as `duplicatePair` and NOT repaired here — merging carries
   * history, payments and referral links, and belongs behind its own dry run.
   *
   * BOTH HALVES ARE EMITTED, and the polarity is the point. The scanned half is
   * the OLDER row: it holds the customer's history and an identity that names
   * NOTHING on this panel. The holder is the NEWER, wrong-looking duplicate,
   * and it is the row actually bound to the LIVE profile.
   *
   * CROSS-USER PAIRS ARE NOT DETECTABLE and are therefore not claimed. When the
   * importer minted a second USER as well, it wrote no marker tying the two
   * Users together, so such a pair is reported as `conflict`: the weaker, safer
   * claim, which still names the holder and still refuses to write.
   */
  private describeCollision(
    row: BrokenLinkRow,
    holder: ProfileHolder,
    remnawaveId: string,
    panelId: number,
    describe: DescribeRow,
    resolvedBy: 'shortUuid' | 'username',
  ): RowVerdict {
    if (holder.userId !== row.userId) {
      // An owner the probe could not read renders as `unknown` and lands HERE,
      // in the safe branch: "not proven to be the same customer" is the only
      // sound reading of a missing `user_id`.
      const holderOwner = holder.userId.length > 0 ? holder.userId : 'unknown';
      return {
        row: describe(
          'conflict',
          'profileTaken',
          `subscription ${holder.id} is already live on panel profile ${remnawaveId}; it belongs ` +
            `to a DIFFERENT customer (${holderOwner}, not ${row.userId}), so this is a genuine ` +
            'collision and not a duplicate pair of one customer. Two subscriptions sharing one ' +
            "panel profile overwrite each other and delete each other's service, so nothing was " +
            'changed.',
          remnawaveId,
          panelId,
          {
            otherSubscriptionId: holder.id,
            otherUserId: holder.userId.length > 0 ? holder.userId : null,
          },
        ),
        partner: null,
      };
    }
    return {
      row: describe(
        'duplicatePair',
        'duplicatePair',
        `subscription ${holder.id} — the SAME customer (${row.userId}) — is already live on panel ` +
          `profile ${remnawaveId}, which is the profile this row resolves to. THIS row does NOT ` +
          `hold the live identity: it stores '${row.remnawaveId ?? 'nothing'}'. Subscription ` +
          `${holder.id} does. Nothing was changed; merge them in «Подписки» → «Инструменты» → ` +
          '«Слияние подписок-дубликатов».',
        remnawaveId,
        panelId,
        { duplicateOfSubscriptionId: holder.id },
      ),
      partner: {
        subscriptionId: holder.id,
        userId: holder.userId,
        panelUsername: holder.remnawavePanelUsername ?? '',
        // Not a resolve performed for this row — it was read out of the
        // database. This records the route that identified the shared profile.
        resolvedBy,
        outcome: 'duplicatePair',
        reasonCode: 'duplicatePair',
        remnawaveId,
        storedRemnawaveId: holder.remnawaveId,
        panelId: holder.remnawavePanelId ?? panelId,
        duplicateOfSubscriptionId: row.id,
        otherSubscriptionId: row.id,
        otherUserId: null,
        holdsLiveIdentity: true,
        scanned: false,
        reason:
          `this row HOLDS the live identity for panel profile ${remnawaveId} and is the live half ` +
          `of the duplicate pair with subscription ${row.id}. It is the newer, wrong-looking one ` +
          'and it is the one that must NOT be deleted: retiring it enqueues a panel DELETE ' +
          "against a paying customer's live profile. Nothing was changed.",
      },
    };
  }

  /**
   * The write, under the same mutual exclusion `persistProfileLink` takes.
   *
   * THE ADVISORY LOCK IS THE SAME KEY, so a concurrent CREATE about to link the
   * same panel identity queues behind this transaction instead of racing it.
   * `$executeRaw`, not `$queryRaw`: `pg_advisory_xact_lock` returns `void` and
   * Prisma's query path has no deserializer for it.
   *
   * THE CONFLICT PROBE IS THE SAME TWO-ANGLED QUESTION, and only the two
   * IMMUTABLE identifiers are asked about. The panel USERNAME is deliberately
   * not part of it — it is mutable and re-derivable, so a stale row still
   * carrying the name of a profile that no longer exists would wedge every
   * future repair under that name.
   *
   * AND IT IS ORDERED THE WAY THE DRY RUN ORDERS IT — `created_at` ASC, then
   * `id` ASC — so the write path and the preview name the same holder.
   *
   * THE FENCE IS "THE ROW STILL HOLDS WHAT IT HELD WHEN WE SELECTED IT" — a
   * compare-and-swap on `remnawave_id`, which is `IS NULL` for population 1 and
   * `= <the non-decimal value>` for population 2. A concurrent CREATE that has
   * already re-linked this row must WIN, because it linked a profile it just
   * provisioned or adopted under a lock while this walk is acting on a fact it
   * read before the round-trip. Overwriting it would detach a live profile and
   * leave an orphan on the panel. Widening the fence to the row id alone would
   * turn `raceLost` — a reported, harmless no-op — into exactly that loss.
   */
  private async writeLink(
    row: BrokenLinkRow,
    remnawaveId: string,
    panelId: number,
    describe: DescribeRow,
    resolvedBy: 'shortUuid' | 'username',
  ): Promise<RowVerdict> {
    return this.prismaService.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext(${`remnawave-profile:${remnawaveId}`})::bigint)
      `);
      // The holder's `user_id` comes back with it, because "who else is on this
      // profile" and "is that somebody the same customer" are one question with
      // one answer and must not be two round-trips that can disagree.
      const holders = await tx.$queryRaw<RawHolderRow[]>(Prisma.sql`
        SELECT "id" AS "conflictId",
               "user_id" AS "conflictUserId",
               "remnawave_id" AS "conflictRemnawaveId",
               "remnawave_panel_id" AS "conflictPanelId",
               "remnawave_panel_username" AS "conflictPanelUsername"
        FROM "subscriptions"
        WHERE "id" <> ${row.id}
          AND "status" <> 'DELETED'
          AND (
            "remnawave_id" = ${remnawaveId}
            OR "remnawave_panel_id" = ${panelId}::int
          )
        ORDER BY "created_at" ASC, "id" ASC
        LIMIT 1
      `);
      const first: RawHolderRow | undefined = holders.length > 0 ? holders[0] : undefined;
      const conflictId = first?.conflictId;
      if (first !== undefined && typeof conflictId === 'string' && conflictId.length > 0) {
        const holder: ProfileHolder = {
          id: conflictId,
          // `''` rather than the row's own userId when the column did not come
          // back: an unknown owner must never read as "the same customer", or a
          // genuine cross-customer collision would be reported as a repairable
          // duplicate pair and eventually merged.
          userId: typeof first.conflictUserId === 'string' ? first.conflictUserId : '',
          remnawaveId: first.conflictRemnawaveId ?? null,
          remnawavePanelId:
            typeof first.conflictPanelId === 'number' ? first.conflictPanelId : null,
          remnawavePanelUsername: first.conflictPanelUsername ?? null,
        };
        return this.describeCollision(row, holder, remnawaveId, panelId, describe, resolvedBy);
      }

      const written = await tx.subscription.updateMany({
        where: { id: row.id, remnawaveId: row.remnawaveId },
        data: { remnawaveId, remnawavePanelId: panelId },
      });
      if (written.count === 0) {
        return {
          row: describe(
            'raceLost',
            'raceLost',
            `the row no longer holds the identity it was selected with ('${row.remnawaveId ?? 'none'}') — ` +
              'a concurrent provision or link changed it while this repair was in flight; ' +
              'whatever it holds now is left alone',
            remnawaveId,
            panelId,
          ),
          partner: null,
        };
      }
      return {
        row: describe('linked', null, null, remnawaveId, panelId, { holdsLiveIdentity: true }),
        partner: null,
      };
    });
  }
}

/** The per-row constructor `reconcileRow` hands to its helpers. */
type DescribeRow = (
  outcome: PanelLinkReconciliationOutcome,
  reasonCode: PanelLinkRowReason | null,
  reason: string | null,
  remnawaveId?: string | null,
  panelId?: number | null,
  extra?: {
    readonly duplicateOfSubscriptionId?: string | null;
    readonly otherSubscriptionId?: string | null;
    readonly otherUserId?: string | null;
    readonly holdsLiveIdentity?: boolean;
  },
) => PanelLinkReconciliationRow;

/** The raw conflict probe's row, aliased column by column. */
interface RawHolderRow {
  readonly conflictId?: string | null;
  readonly conflictUserId?: string | null;
  readonly conflictRemnawaveId?: string | null;
  readonly conflictPanelId?: number | null;
  readonly conflictPanelUsername?: string | null;
}

/** Reads a caller-supplied bound, falling back rather than trusting it. */
function clampPositive(value: unknown, fallback: number, ceiling: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  if (floored < 1) return fallback;
  return Math.min(floored, ceiling);
}
