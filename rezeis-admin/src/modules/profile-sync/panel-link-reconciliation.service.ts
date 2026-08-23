import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../common/services/system-events.service';
import {
  panelShortUuidFromConfigUrl,
  type StoredPanelIdentity,
} from '../remnawave/services/panel-user-address';
import { RemnawaveApiService } from '../remnawave/services/remnawave-api.service';
import { assertPanelProfileOwnership } from './profile-sync.processor';

/** How many rows one database page carries. Bounds memory, not panel load. */
export const PANEL_LINK_RECONCILIATION_DEFAULT_CHUNK = 25;
export const PANEL_LINK_RECONCILIATION_MAX_CHUNK = 100;
/**
 * How many rows ONE invocation may examine. Each row costs the panel a resolve
 * plus a profile read, so the ceiling is a panel-load budget rather than a
 * database one — an operator repairing a large backlog runs the endpoint again
 * with `startAfterId`, and each run is independently reportable.
 */
export const PANEL_LINK_RECONCILIATION_DEFAULT_LIMIT = 200;
export const PANEL_LINK_RECONCILIATION_MAX_LIMIT = 1000;

/**
 * The two panel eras this sweep can conclude, and the ONLY two strings
 * {@link PanelLinkReconciliationReport.panelEra} ever carries besides `null`.
 *
 * Spelled as constants rather than inlined because three separate things read
 * them — the selection gate, the report, and the per-row reasons — and a
 * mismatch between any two of those would be a sweep that says it looked at one
 * era while gating on another.
 */
export const PANEL_ERA_2X = '2.x';
export const PANEL_ERA_3X = '3.x';

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
 * What happened to ONE row. Everything that is not `linked`/`wouldLink` is
 * reported to the operator BY NAME — silence is the disease this sweep repairs,
 * so it is not allowed to be the way the sweep reports its own failures.
 */
export type PanelLinkReconciliationOutcome =
  /** The link was written. */
  | 'linked'
  /** A dry run: every check passed and a real run would write the link. */
  | 'wouldLink'
  /** The panel could not name the profile from either route. */
  | 'unresolved'
  /** The profile carries somebody else's `reiwa_id` marker. */
  | 'notOwned'
  /** Another live subscription already holds that panel profile. */
  | 'conflict'
  /**
   * The row was IDENTIFIED as holding a stale identity and could NOT be
   * repaired — and the reason is one no other member covers.
   *
   * WHY THIS IS THE NARROW MEANING, chosen over the wide one. The wide reading
   * ("every stale row this sweep touched") was rejected because `linked` and
   * `wouldLink` already carry the one distinction an operator acts on: whether
   * a write HAPPENED or would happen. Collapsing repaired stale rows onto a
   * single `staleIdentity` member would make a dry run and a real run report
   * the same string for the same row, which is the exact class of report this
   * whole service exists to stop producing. A repaired stale row is therefore
   * `linked`/`wouldLink`, and {@link PanelLinkReconciliationRow.storedRemnawaveId}
   * is what shows the operator the dead uuid it used to hold.
   *
   * That leaves exactly two ways to be stale and unrepairable, and both are
   * reported here rather than folded into `unresolved`, which would say "the
   * panel did not answer" about a row the panel was never asked about:
   *   • no resolve route at all — neither a `config_url` to recover a
   *     subscription short UUID from, nor a `remnawave_panel_username`;
   *   • the panel answers for the profile with the identity the row ALREADY
   *     holds, so there is nothing to rewrite. The detected era and the panel's
   *     own answer disagree, and a repair invented from that disagreement is
   *     how this bug class is made in the first place.
   */
  | 'staleIdentity'
  /**
   * Two LIVE rows of ONE customer on ONE panel profile — the pair the 2.x → 3.x
   * identity split produced, not a collision between two unrelated
   * subscriptions.
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
   * "is this link broken?" cannot see either of them. The remaining duplicate
   * would sit there forever, live on a profile another live row also owns.
   *

   * NOT REPAIRED BY THIS SWEEP, deliberately: merging two subscriptions moves
   * history, payments and referral links, and that belongs behind its own dry
   * run rather than inside a link repair.
   *
   * A pair contributes TWO rows to {@link PanelLinkReconciliationReport.unrepaired}
   * — the scanned half and the half it collided with — because an operator who
   * is shown only one of them cannot see which is which, and the wrong-looking
   * one is the LIVE one. See {@link PanelLinkReconciliationRow.holdsLiveIdentity}.
   */
  | 'duplicatePair'
  /** A concurrent CREATE linked the row first; its link is left alone. */
  | 'raceLost';

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
  /** The identity that was (or would be) written; `null` when nothing resolved. */
  readonly remnawaveId: string | null;
  /**
   * What the row holds RIGHT NOW, before this sweep touched anything: `null`
   * for the missing-identity population, the dead 2.x uuid for the stale one.
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
   * pair at all (the holder is still named in {@link reason}).
   */
  readonly duplicateOfSubscriptionId: string | null;
  /**
   * True when the subscription THIS record describes is bound to the live panel
   * profile as this report leaves the database.
   *
   * THE FIELD EXISTS BECAUSE THE POLARITY IS BACKWARDS FROM INSTINCT. In the
   * pair this defect produced, the OLDER row — the one carrying the customer's
   * history, payments and plan, the one that looks legitimate — stores a 2.x
   * uuid the 3.x panel no longer answers to, and is bound to NOTHING. The
   * NEWER, wrong-looking duplicate stores the current decimal and is the row
   * actually pointing at the live profile. An operator who deletes the
   * wrong-looking card issues a panel DELETE against a paying customer's live
   * profile. So this is stated as a field rather than left to be inferred from
   * {@link storedRemnawaveId}, which requires knowing the era to read.
   *
   * Per outcome:
   *   `linked`             true  — the write just bound it.
   *   `wouldLink`          false — a dry run wrote nothing; it is still dead.
   *   `staleIdentity`      true only in the "panel already agrees" case.
   *   `duplicatePair`      via a resolve: false on the scanned half, true on the
   *                        partner. Via `storedIdentity`: TRUE ON BOTH — both
   *                        rows store the identity, so both are bound and
   *                        neither may be deleted.
   *   `raceLost`           false — something else wrote an identity this sweep
   *                        never verified, so there is nothing to vouch for.
   *   everything else      false.
   */
  readonly holdsLiveIdentity: boolean;
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
   * `true` when the run stopped at `limit` with the selection not exhausted.
   * The operator runs again from {@link nextCursor}.
   */
  readonly hasMore: boolean;
  /** The id of the last row examined, or `null` when nothing was. */
  readonly nextCursor: string | null;
  /**
   * How many of {@link scanned} came from the STALE-identity population,
   * whatever became of them. Zero on a 2.x panel and on an unidentified one,
   * where that population is not selected at all.
   */
  readonly staleIdentityScanned: number;
  /** How many duplicate PAIRS were diagnosed (each is two rows in `unrepaired`). */
  readonly duplicatePairs: number;
  /**
   * How many of {@link duplicatePairs} were found by the SHARED-IDENTITY arm —
   * two live rows storing one identity — rather than by resolving a row that
   * could not name its profile.
   *
   * Reported separately for the same reason {@link staleIdentityScanned} is: an
   * operator reading zero has to be able to tell "there were none" from "that
   * arm did not run". It does not run on a 2.x panel, and it does not run on a
   * panel whose era could not be read.
   */
  readonly sharedIdentityPairs: number;
  /**
   * Which era the sweep believed it was talking to: {@link PANEL_ERA_2X},
   * {@link PANEL_ERA_3X}, or `null` when it could not tell.
   *
   * An operator reading a report of zero repairs must be able to see whether
   * the sweep was even LOOKING. `null` is not a small number of repairs, it is
   * a sweep that refused to guess an era and therefore left the second
   * population out entirely.
   */
  readonly panelEra: string | null;
}

export interface PanelLinkReconciliationOptions {
  /**
   * Writes happen ONLY on an explicit `false`. Anything else — omitted,
   * mistyped, a truthy string from a form — is a dry run, so the failure mode
   * of a malformed request is "reported nothing, changed nothing".
   */
  readonly dryRun?: boolean;
  readonly limit?: number;
  readonly chunkSize?: number;
  /** Resume point: only rows with `id > startAfterId` are considered. */
  readonly startAfterId?: string | null;
}

/** The row shape the selection reads. Nothing else is needed to repair one. */
interface BrokenLinkRow {
  readonly id: string;
  readonly userId: string;
  /**
   * `null` for the missing-identity population; the stale (uuid-shaped) string
   * for the second one. Which population a row came from is read off THIS
   * field and nothing else — the two selection arms are mutually exclusive on
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
 * A deliberate, operator-initiated repair for subscriptions whose panel profile
 * EXISTS but which cannot name it. Two populations, one sweep, one report — the
 * per-row `outcome` says which of them a row came from and what became of it.
 *
 * NOTHING HERE MUTATES THE PANEL. The only two panel calls are
 * `resolvePanelIdentity` (`POST /api/users/resolve`, a read behind a POST) and
 * `getPanelUserOutcome` (a profile read). No create, no rename, no delete. That
 * is a property to preserve, not a coincidence: every repair this service
 * performs is a LOCAL write correcting which panel profile a local row NAMES.
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
 *   • the manual link-repair endpoint refuses unless `remnawaveId` is null and
 *     writes all of them together.
 * So `status <> DELETED AND remnawave_id IS NULL AND remnawave_panel_username
 * IS NOT NULL AND config_url IS NOT NULL` selects exactly the damaged rows and
 * nothing else. It is deliberately NOT widened to "any unlinked row": those are
 * the ordinary pre-provision state, and asking the panel to name a profile for
 * them would invent links for subscriptions that never had one.
 *
 * ── POPULATION 2: A STALE IDENTITY (3.x PANELS ONLY) ─────────────────────────
 *
 * Remnawave 3.x dropped the `uuid` column outright, so `parsePanelUserRow` keys
 * a 3.x row by `String(id)` — a decimal. `Subscription.remnawaveId` stores
 * whichever spelling was current when the row was linked and is deliberately
 * never rewritten. After an operator upgrades 2.x → 3.x, every row linked in
 * the old era therefore holds a uuid for a profile the panel now reports a
 * decimal for, and `remnawaveId = panelUser.uuid` compares two spellings of one
 * identity and finds them unequal FOREVER.
 *
 * THE SHAPE TEST IS SOUND AND IT IS THE SAME ONE THE LINK-REPAIR ENDPOINT USES.
 * `admin-user-subscriptions.controller.ts` (the `namesSameProfile` block, in
 * the "which comparisons are sound" list) states it: "a uuid always carries
 * `-`, so it never equals a decimal". So on a panel PROVEN to be 3.x, a live
 * row whose identity contains `-` is provably holding a name the panel cannot
 * answer to — there is no legitimate way for a 3.x panel to have issued it.
 *
 * THE ERA IS DISCOVERED, NEVER ASSUMED — see {@link detectPanelEra}. On a 2.x
 * panel a uuid-shaped identity is CORRECT, so this population is empty and the
 * sweep behaves exactly as it did before it existed. When the era cannot be
 * read, the population is empty too and the report says so with
 * `panelEra: null`: inventing a repair from an unknown era is how this class of
 * bug is made.
 *
 * WHAT THIS SWEEP DOES NOT DO. It does not merge the duplicate pair the defect
 * produced. It diagnoses it (`duplicatePair`, with both halves named and the
 * live one flagged) and stops.
 *
 * NOT A CRON, NOT A STARTUP HOOK. One resolve and one profile read per row go
 * to the panel; that is a cost an operator chooses to pay, at a moment of their
 * choosing, having first seen a dry run.
 */
@Injectable()
export class PanelLinkReconciliationService {
  private readonly logger = new Logger(PanelLinkReconciliationService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly events: SystemEventsService,
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
    const chunkSize = clampPositive(
      options.chunkSize,
      PANEL_LINK_RECONCILIATION_DEFAULT_CHUNK,
      PANEL_LINK_RECONCILIATION_MAX_CHUNK,
    );

    // ASKED ONCE, BEFORE THE WALK, and reported. A per-page re-read could see
    // the era move mid-sweep and produce one report describing two panels.
    const panelEra = await this.detectPanelEra();
    const includeStale = panelEra === PANEL_ERA_3X;
    // THE SAME GATE, AND IT IS A DELIBERATE CHOICE RATHER THAN A REUSED FLAG.
    //
    // Shared identity is a different QUESTION from stale identity: it compares
    // two local rows with each other instead of comparing one row's spelling
    // against an era, so nothing in the comparison itself needs to know which
    // panel is answering. It is gated anyway, on three grounds:
    //
    //  1. THE POPULATION IS DEFINED BY THE DEFECT, AND THE DEFECT IS 2.x → 3.x.
    //     Two live rows of one customer on one profile is what the identity
    //     split produces. On a panel PROVEN to be 2.x that provenance does not
    //     hold, and what a shared identity means there is something this sweep
    //     has not established. Every pair reported here is a merge nomination,
    //     and a merge moves payments, referral spends and the operator's plan.
    //     Nominating one from a population we cannot explain is the same
    //     invention the stale arm refuses to make.
    //  2. FAIL CLOSED ON THE ERA, WHICH IS THE RULE THIS FILE ALREADY OBEYS.
    //     `'unknown'` is what version detection returns for a panel that is
    //     unreachable, a token that expired and a body that would not parse.
    //     Making the new arm the one place where an unread panel WIDENS what
    //     the sweep proposes to merge would invert that rule exactly where it
    //     matters most.
    //  3. THERE IS NOTHING TO CONVERGE ON 2.x. The invisible state this arm
    //     exists to see is manufactured by a MERGE — the survivor takes the
    //     duplicate's identity — and merges only come from pairs, and pairs are
    //     only nominated on a proven 3.x panel. No pairs, no merges, nothing to
    //     converge.
    //  4. THE ARM'S OWN PREDICATE IS ERA-RELATIVE, so it cannot be written
    //     without a proven era at all. It reports duplicates whose identity is
    //     ALREADY WELL FORMED, and it leaves the stale ones to the walk — and
    //     "stale" means uuid-shaped, which is true on 3.x and FALSE on 2.x,
    //     where a uuid is exactly what a correct identity looks like. Running
    //     this arm on an unidentified panel would not merely widen it; it would
    //     make its central exclusion meaningless.
    //
    // THE COST IS NAMED, NOT HIDDEN: a 2.x install carrying genuinely shared
    // identities is not reported. That is a smaller harm than nominating merges
    // off a panel this sweep could not identify.
    const includeSharedIdentity = panelEra === PANEL_ERA_3X;

    const repaired: PanelLinkReconciliationRow[] = [];
    const unrepaired: PanelLinkReconciliationRow[] = [];
    /**
     * Every pair the WALK already named, so the shared-identity arm does not
     * report the same two rows a second time.
     *
     * Only exact pairs are suppressed. A row already named in one pair is NOT
     * struck out of others: a walk pair the merge later refuses would then
     * silently starve every shared pair its members belong to, and silence is
     * the disease this whole sweep exists to end.
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

    while (scanned < limit) {
      // One more than needed, so "the cap was reached AND rows remain" is
      // answered without a second query — and without reporting `hasMore` for a
      // selection that merely happened to end exactly on the boundary.
      const page = await this.selectBrokenLinks(
        cursor,
        Math.min(chunkSize, limit - scanned) + 1,
        includeStale,
      );
      const rows = page.slice(0, Math.min(chunkSize, limit - scanned));
      if (rows.length === 0) break;

      for (const row of rows) {
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
        // Named in the log too, not only in the response body: the operator who
        // triggers this from the SPA sees the report, the one reading logs a
        // week later sees the same rows.
        if (result.reason !== null) {
          this.logger.warn(
            `Panel link reconciliation: subscription ${result.subscriptionId} (user ` +
              `${result.userId}, panel username '${result.panelUsername}', stored identity ` +
              `'${result.storedRemnawaveId ?? 'none'}', tried ${result.resolvedBy}) not ` +
              `repaired — ${result.outcome}: ${result.reason}`,
          );
        }
        if (verdict.partner !== null) {
          this.logger.warn(
            `Panel link reconciliation: subscription ${verdict.partner.subscriptionId} is the ` +
              `LIVE half of the duplicate pair with ${result.subscriptionId} — ` +
              `${verdict.partner.reason}`,
          );
        }
        cursor = row.id;
        scanned += 1;
      }

      // ASSIGNED, never latched. The extra row proves only that THIS page did
      // not drain the selection; the next page may. A `hasMore = true` that is
      // never cleared survives the chunk that finished the walk and sends the
      // operator round a loop of runs that repair nothing — a report that lies
      // in the same direction as the defect this whole sweep repairs.
      hasMore = page.length > rows.length;
      if (!hasMore) break;
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
    // it can do is REMOVE one, by repairing a stale row — and reading after the
    // fact is what keeps this arm from reporting a pair that no longer exists.)
    //
    // NOT SCOPED BY THE CURSOR. `startAfterId` pages the WALK, whose selection
    // shrinks as it repairs; this arm is one whole-table aggregate whose answer
    // is not a page of rows. Scoping it to the cursor would hide every cluster
    // behind the resume point, which is exactly the silent skip the cursor
    // exists to prevent. Re-reporting an already-merged cluster is not the
    // opposite risk it looks like: a merge retires one half, the group drops to
    // one member, and the pair stops being reported by itself.
    const shared = includeSharedIdentity
      ? await this.selectSharedIdentityPairs(walkPairKeys)
      : { rows: [], pairs: 0, truncated: false };
    for (const row of shared.rows) unrepaired.push(row);
    duplicatePairs += shared.pairs;
    if (shared.truncated) hasMore = true;
    for (const row of shared.rows) {
      if (row.duplicateOfSubscriptionId === null) continue;
      // The PROFILE both halves name, and separately what THIS half stores.
      // They are not always the same string: on a pair found through the numeric
      // panel id one half can still be holding a 2.x uuid, and a log line that
      // printed the stored value as though it were the profile would name a
      // dead identity as the live one.
      this.logger.warn(
        `Panel link reconciliation: subscriptions ${row.subscriptionId} and ` +
          `${row.duplicateOfSubscriptionId} (user ${row.userId}) are BOTH live and BOTH name ` +
          `panel profile ${row.remnawaveId ?? 'unknown'}; this half stores ` +
          `'${row.storedRemnawaveId ?? 'none'}' — ${row.reason}`,
      );
    }

    const linked = repaired.filter((row) => row.outcome === 'linked').length;
    const wouldLink = repaired.length - linked;
    const report: PanelLinkReconciliationReport = {
      dryRun,
      scanned,
      linked,
      wouldLink,
      repaired,
      unrepaired,
      hasMore,
      nextCursor: cursor,
      staleIdentityScanned,
      duplicatePairs,
      sharedIdentityPairs: shared.pairs,
      panelEra,
    };

    // A RUN THAT SCANNED NOTHING AND FOUND A CLUSTER IS STILL A RUN THAT FOUND
    // SOMETHING. The shared-identity arm reaches rows the walk does not select
    // at all, so gating the operator's event feed on `scanned` alone would make
    // the one report this arm exists to produce the one report nobody sees.
    if (scanned > 0 || shared.pairs > 0) {
      this.events.info(
        EVENT_TYPES.SYSTEM_REMNAWAVE_SYNC,
        'SYSTEM',
        dryRun
          ? `Panel link reconciliation (dry run): ${wouldLink} of ${scanned} rows repairable`
          : `Panel link reconciliation: linked ${linked} of ${scanned} rows`,
        {
          dryRun,
          scanned,
          linked,
          wouldLink,
          unrepaired: unrepaired.length,
          hasMore,
          panelEra,
          staleIdentityScanned,
          duplicatePairs,
          sharedIdentityPairs: shared.pairs,
        },
      );
    }
    return report;
  }

  /**
   * Which era of the panel API this sweep is talking to — DISCOVERED, and never
   * defaulted.
   *
   * `getPanelShape()` already performs and caches this detection (one
   * `GET /api/system/stats/recap` per five minutes, shared with every other
   * version-gated feature), so this is a read of an existing fact rather than a
   * probe of its own. `addressing` is the derived field that answers the exact
   * question the stale population turns on: `'uuid'` is the era where a
   * uuid-shaped identity is CORRECT, `'id'` is the era where it cannot be.
   *
   * `'unknown'` YIELDS `null`, NOT A GUESS. Version detection folds every
   * failure — 401, timeout, DNS, an unconfigured token, a panel mid-restart —
   * into "no version". Reading that as 3.x would mark every legitimately
   * uuid-identified row on a 2.x panel as stale and rewrite it to a decimal
   * that panel has never heard of: the same unaddressable row this sweep exists
   * to repair, manufactured by the repair. The report carries the `null` so an
   * operator seeing zero stale rows can tell "there were none" from "the sweep
   * could not tell whether to look".
   */
  private async detectPanelEra(): Promise<string | null> {
    let addressing: string;
    try {
      addressing = (await this.remnawaveApiService.getPanelShape()).addressing;
    } catch (err: unknown) {
      this.logger.warn(
        'Panel link reconciliation: the panel era could not be read ' +
          `(${(err as Error).message}); the stale-identity population is left OUT of this sweep`,
      );
      return null;
    }
    if (addressing === 'uuid') return PANEL_ERA_2X;
    if (addressing === 'id') return PANEL_ERA_3X;
    this.logger.warn(
      'Panel link reconciliation: the panel did not identify its era, so the stale-identity ' +
        'population is left OUT of this sweep — a uuid-shaped identity is correct on 2.x and ' +
        'rewriting one on a guess would strand the row it repaired',
    );
    return null;
  }

  /**
   * The damaged rows, paged by id, as ONE union across both populations.
   *
   * Paged by `id > cursor` rather than by OFFSET on purpose: a real run REMOVES
   * rows from this selection as it repairs them, and an offset walk over a
   * shrinking set skips one row for every row it fixes. THAT STILL HOLDS FOR
   * THE WIDENED PREDICATE, and for the same reason on both arms: repairing a
   * missing-identity row makes `remnawave_id` non-null, and repairing a stale
   * one rewrites it from the uuid to the decimal, which no longer contains `-`.
   * Either way the row leaves the selection under the sweep's own feet. Rows
   * that are NOT repaired stay in it, and the cursor — advanced per ROW, not
   * per page — is what keeps the walk from re-reading them forever.
   *
   * THE THREE ARMS, and why the third is not merged into the second:
   *
   *  1. missing identity — the decoder-defect signature, exactly as before.
   *  2. stale identity WITH a resolve route. A repair needs one of the two
   *     routes, so this is the arm that can actually be fixed.
   *  3. stale identity with NEITHER route. Unrepairable by any means: nothing
   *     on the row can name a profile to the panel. It is selected anyway so
   *     that it is REPORTED — by name, with a reason, and without costing a
   *     panel round-trip — instead of being silently absent from a report whose
   *     whole purpose is to end silence. {@link reconcileRow} short-circuits it
   *     before either panel call.
   */
  private async selectBrokenLinks(
    cursor: string | null,
    take: number,
    includeStale: boolean,
  ): Promise<BrokenLinkRow[]> {
    const missingIdentity: Prisma.SubscriptionWhereInput = {
      remnawaveId: null,
      remnawavePanelUsername: { not: null },
      configUrl: { not: null },
    };
    // `contains: '-'` is the whole shape test, and it is exact rather than
    // approximate: a panel id is decimal and can never contain a hyphen, a uuid
    // always does. Only reached when the era is PROVEN 3.x by the caller.
    const staleWithRoute: Prisma.SubscriptionWhereInput = {
      remnawaveId: { contains: '-' },
      OR: [{ configUrl: { not: null } }, { remnawavePanelUsername: { not: null } }],
    };
    const staleWithoutRoute: Prisma.SubscriptionWhereInput = {
      remnawaveId: { contains: '-' },
      configUrl: null,
      remnawavePanelUsername: null,
    };
    return this.prismaService.subscription.findMany({
      where: {
        status: { not: SubscriptionStatus.DELETED },
        ...(cursor === null ? {} : { id: { gt: cursor } }),
        OR: includeStale
          ? [missingIdentity, staleWithRoute, staleWithoutRoute]
          : [missingIdentity],
      },
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        userId: true,
        remnawaveId: true,
        remnawavePanelUsername: true,
        configUrl: true,
      },
    });
  }

  /**
   * TWO LIVE ROWS OF ONE CUSTOMER THAT ALREADY NAME THE SAME PANEL PROFILE.
   *
   * ── WHY THE OTHER SELECTION CANNOT ASK THIS ──────────────────────────────
   *
   * {@link selectBrokenLinks} asks "is THIS link broken?" — `remnawave_id IS
   * NULL`, or uuid-shaped on a proven 3.x panel. That is a predicate over one
   * row at a time, and no predicate over one row can notice that a DIFFERENT
   * row holds the same string. So the moment both halves of a cluster carry a
   * well-formed identity the cluster becomes invisible — which is precisely the
   * state a MERGE leaves behind, because the survivor takes the duplicate's
   * identity. A cluster of three therefore used to stop halfway: the first
   * merge was found, the second never was, and the customer was left with two
   * live rows able to overwrite and delete each other's service.
   *
   * ── WHAT COUNTS AS IDENTITY HERE, AND WHAT DOES NOT ──────────────────────
   *
   * The two IMMUTABLE identifiers, and only those — the same two-angled
   * question `writeLink`'s conflict probe asks:
   *
   *   • `remnawave_id`, non-null and EQUAL as strings. Whatever era spelled it,
   *     a profile's identity is that profile's forever, so two live rows
   *     carrying the identical string carry one profile. Cross-era spellings
   *     (a uuid against a decimal) are never compared, because they are never
   *     equal — that is the second angle's job.
   *   • `remnawave_panel_id`, non-null and EQUAL. A numeric panel id names one
   *     profile forever too, and it is how a 2.x-era row and an importer-minted
   *     one can be shown to be the same profile despite two spellings.
   *
   * NULLS ARE EXCLUDED FROM BOTH, not compared. `remnawave_panel_id` carries no
   * unique constraint (migration 20260810160000 records why one cannot be added
   * to live data), so grouping nulls together would put every row that has none
   * in one bucket and turn "who is this profile" into "anybody" — the same trap
   * `panelProfileClaims` and `handleDelete`'s retirement fence are written
   * around.
   *
   * `remnawave_panel_username` IS DELIBERATELY NOT IDENTITY, and this is the one
   * exclusion that would look like a free win. A name is not an identity: panel
   * usernames are DETERMINISTIC (`clampPanelUsername` documents that determinism
   * as a requirement, because the CREATE path uses the name as its
   * crash-recovery key), so a profile that was deleted frees its name and the
   * NEXT profile provisioned for that customer inherits it. Two live rows
   * sharing a username are then the row that lost its profile and the row that
   * got the replacement — two DIFFERENT profiles. Merging them would move a live
   * subscription's history onto a dead row and retire the live one. Same trap,
   * same conclusion as `namesSameProfile` in
   * `admin-user-subscriptions.controller.ts` and as `panelProfileClaims`.
   *
   * `config_url` is excluded for a weaker but sufficient reason: it is a resolve
   * ROUTE, not an identity. It is regenerated when a subscription link is
   * rotated, so one profile can have had two.
   *
   * ── SAME CUSTOMER ONLY ───────────────────────────────────────────────────
   *
   * Groups are formed per `user_id`. Two rows of DIFFERENT customers sharing an
   * identity is a genuine collision, not this defect's pair, and
   * {@link describeCollision} already explains why nothing sound distinguishes
   * "one customer the importer split in two" from "two customers" — there is no
   * marker tying two Users together. A merge moves payments and referral spends
   * between subscriptions, so a pair is claimed only where the owner is proven
   * identical.
   *
   * ── NO PANEL CALL, AND NO WRITE ──────────────────────────────────────────
   *
   * The resolve routes exist because a row that cannot name its profile needs
   * the panel to name it. These rows already name it — twice — so the panel has
   * nothing to add, and this arm makes no call at all. It also writes nothing:
   * it reports the pair, and the survivor rule, the ownership proof and every
   * guard live in `DuplicateSubscriptionMergeService`, which re-verifies each
   * pair from the database AND the panel before a byte is written.
   *
   * ── COST ─────────────────────────────────────────────────────────────────
   *
   * THREE statements per invocation, and the number does not move with the size
   * of the table: two aggregates that return only the identities held more than
   * once (a single grouped pass each, served by `@@index([remnawaveId])` and
   * `@@index([remnawavePanelId])`), then ONE `IN` lookup for the member rows of
   * those identities. Two statements when nothing is shared, because the
   * lookup is skipped. Explicitly NOT a self-join and NOT a probe per row: the
   * only alternatives that answer this question are `O(n²)` or `N+1`, and this
   * runs over a live subscriptions table.
   *
   * ── WHICH MEMBER IS THE SURVIVOR ─────────────────────────────────────────
   *
   * The oldest, and it is decided by the ORDER BY on the members query —
   * `created_at ASC, id ASC`, the same order the dry-run holder probe and
   * `writeLink`'s raw probe use, and the order the fixed importer converges on.
   * Every pair is anchored on the group's FIRST member, so the oldest row of the
   * WHOLE cluster is one half of every pair the cluster produces. Pairing
   * neighbours instead would let a cluster converge on some middle row and only
   * reach the oldest after another round.
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
        // STALE SPELLINGS ARE THE WALK'S POPULATION, NOT THIS ONE, and the two
        // are kept mutually exclusive the same way the walk's own two arms are.
        // Two live rows sharing a dead 2.x uuid ARE on one profile — but the
        // walk already selects both, resolves them on the panel and diagnoses
        // the pair with the panel's own answer rather than with a string match.
        // Claiming them here as well would report one row under two verdicts at
        // once ("this would be repaired" and "this is half of a pair"), and an
        // operator cannot act on both. This arm's remit is the duplicate whose
        // identity is ALREADY WELL FORMED — the one nothing else can see.
        //
        // `contains: '-'` is the same exact shape test the stale arm uses, and
        // it means "stale" only because the caller proved the era is 3.x.
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
          `identity ${member.userId} ${member.remnawaveId}`,
          { remnawaveId: member.remnawaveId, panelId: null, members: [] },
          member,
        );
      }
      if (member.remnawavePanelId !== null && panelIdSet.has(member.remnawavePanelId)) {
        collect(
          `panelId ${member.userId} ${member.remnawavePanelId}`,
          {
            // The identity spelling for a group keyed by the numeric id. Sound
            // because this arm only runs on a panel PROVEN to be 3.x, where the
            // decimal id IS the identity — the same rule `parsePanelUserRow`
            // follows for a 3.x row.
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
      remnawaveId: group.remnawaveId,
      storedRemnawaveId: self.remnawaveId,
      panelId: self.remnawavePanelId ?? group.panelId,
      duplicateOfSubscriptionId: other.id,
      holdsLiveIdentity: true,
      reason:
        `subscription ${other.id} — the SAME customer (${self.userId}) — is LIVE on panel ` +
        `profile ${group.remnawaveId}, and so is this row: both of them STORE that identity. ` +
        'This is not a broken link, it is two live subscriptions on one profile, and they ' +
        "overwrite and delete each other's service. BOTH halves are bound to the live profile, " +
        'so unlike the pair a broken link produces there is no wrong-looking half here — ' +
        `deleting EITHER enqueues a panel DELETE against a paying customer's live profile. ` +
        `Subscription ${older} is the OLDER row and is the one a merge keeps. Nothing was ` +
        'changed, and merging the two is not the job of this sweep.',
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
   *     to resolve: panel usernames are DETERMINISTIC (`clampPanelUsername`
   *     documents that determinism as a requirement, because the CREATE path
   *     uses the name as its crash-recovery key), so a profile that was deleted
   *     and re-provisioned carries the SAME name as the one this row lost.
   *     Resolving by name can therefore land on a DIFFERENT, live profile —
   *     the same trap `panelProfileClaimedByAnother` guards the DELETE path
   *     against. The ownership check below is what makes route 2 usable at all.
   *
   * THE STORED IDENTITY IS NEVER USED AS A RESOLVE KEY. For the stale
   * population it is precisely the string the panel cannot answer to, and for
   * the other one there is none. Both populations therefore take the same two
   * routes, in the same order, and the code below does not branch on which it
   * is looking at until it comes to the WRITE FENCE.
   */
  private async reconcileRow(row: BrokenLinkRow, dryRun: boolean): Promise<RowVerdict> {
    const stored = row.remnawaveId;
    const panelUsername = row.remnawavePanelUsername ?? '';
    const shortUuid = panelShortUuidFromConfigUrl(row.configUrl ?? null);
    const useShortUuid = shortUuid !== null && shortUuid.length > 0;
    const resolvedBy: 'shortUuid' | 'username' = useShortUuid ? 'shortUuid' : 'username';
    const describe = (
      outcome: PanelLinkReconciliationOutcome,
      reason: string | null,
      remnawaveId: string | null = null,
      panelId: number | null = null,
      extra: {
        readonly duplicateOfSubscriptionId?: string | null;
        readonly holdsLiveIdentity?: boolean;
      } = {},
    ): PanelLinkReconciliationRow => ({
      subscriptionId: row.id,
      userId: row.userId,
      panelUsername,
      resolvedBy,
      outcome,
      remnawaveId,
      storedRemnawaveId: stored,
      panelId,
      duplicateOfSubscriptionId: extra.duplicateOfSubscriptionId ?? null,
      holdsLiveIdentity: extra.holdsLiveIdentity ?? false,
      reason,
    });
    const alone = (result: PanelLinkReconciliationRow): RowVerdict => ({
      row: result,
      partner: null,
    });

    if (!useShortUuid && panelUsername.length === 0) {
      // Population 1 cannot reach this (its arm requires a non-null username),
      // but an empty string passes `IS NOT NULL` — and resolving by it would
      // ask the panel "which user is called nothing?" and act on the answer.
      // Population 2's third arm reaches it BY DESIGN: those rows are selected
      // in order to be named here, and they cost the panel nothing.
      return alone(
        stored === null
          ? describe('unresolved', 'no subscription short UUID and no panel username')
          : describe(
              'staleIdentity',
              `stored identity '${stored}' is a 2.x uuid that a ${PANEL_ERA_3X} panel cannot ` +
                'answer to, and neither a subscription short UUID nor a panel username was ever ' +
                'recorded for this row — there is no resolve route at all, so nothing can repair ' +
                'it automatically. The panel profile must be identified by hand.',
            ),
      );
    }

    const selector = useShortUuid
      ? { shortUuid: shortUuid as string }
      : { username: panelUsername };
    const resolved = await this.remnawaveApiService.resolvePanelIdentity(selector);
    if (resolved === null) {
      return alone(
        describe(
          'unresolved',
          useShortUuid
            ? `panel did not resolve shortUuid '${shortUuid}'`
            : `panel did not resolve username '${panelUsername}'`,
        ),
      );
    }

    // WHICH SPELLING TO STORE IS READ OFF THE PANEL'S OWN ANSWER, not off a
    // version probe — the same rule `parsePanelUserRow` follows for read rows.
    // A 2.x panel returns the profile's `uuid` and that is what every 2.x-era
    // route wants; a 3.x panel has none to return and keys everything by the
    // numeric id. Writing the other era's spelling would recreate, by hand,
    // exactly the unaddressable row this sweep exists to repair.
    //
    // The ERA gates which rows are selected; the ANSWER decides what is
    // written. Those are two different questions and neither substitutes for
    // the other.
    const remnawaveId =
      typeof resolved.uuid === 'string' && resolved.uuid.length > 0
        ? resolved.uuid
        : String(resolved.id);

    if (stored !== null && stored === remnawaveId) {
      // The row was selected as stale and the panel answers with the very
      // string it already holds. Nothing to rewrite, and no repair may be
      // invented from the disagreement between the detected era and this
      // answer — that invention is the whole bug class. Short-circuited before
      // the profile read: there is no adoption to prove when nothing changes.
      return alone(
        describe(
          'staleIdentity',
          `the panel answers for this profile with the identity the row already holds ` +
            `('${stored}'), so there is nothing to rewrite — this sweep detected the ` +
            `${PANEL_ERA_3X} era and the panel's own answer disagrees with it. Nothing was ` +
            'changed.',
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
    // The probe carries the identity and the numeric id and NOTHING ELSE: no
    // username, no short UUID. That is deliberate. Those two fields are what
    // `panelUserAddress` falls back to when it cannot build a path segment, and
    // a hidden second resolve — by name — is precisely the landing this method
    // refuses to make. Without them an unaddressable probe answers `impossible`
    // and the row is reported unresolved instead of being resolved by a key we
    // ruled out.
    const probe: StoredPanelIdentity = {
      remnawaveId,
      panelId: resolved.id,
      panelUsername: null,
    };
    const outcome = await this.remnawaveApiService.getPanelUserOutcome(probe);
    if (outcome.kind !== 'ok') {
      return alone(
        describe(
          'unresolved',
          outcome.kind === 'missing'
            ? `panel resolved ${resolvedBy} to profile ${remnawaveId} but that profile is gone`
            : `panel profile ${remnawaveId} could not be read back (panel unavailable or ` +
              'undecodable body); nothing was changed',
          remnawaveId,
          resolved.id,
        ),
      );
    }

    try {
      // "A profile answers to this name" is not "this profile is mine". Same
      // helper the CREATE path adopts a profile through, with the same
      // semantics: a PROVEN mismatch refuses; a description with no marker
      // (imported, or hand-edited by an operator) stays indeterminate and is
      // allowed, because failing those closed would strand every legacy profile
      // with no other route back.
      assertPanelProfileOwnership(panelUsername, outcome.user.description, row.userId);
    } catch (err: unknown) {
      return alone(describe('notOwned', (err as Error).message, remnawaveId, resolved.id));
    }

    if (dryRun) {
      // The preview asks the exclusivity question too. A dry run that reported
      // "would link" for a row a real run would refuse is not a preview.
      //
      // ORDERED, BECAUSE THIS ANSWER PICKS A MERGE PARTNER. A cluster of THREE
      // or more live rows naming one profile is reachable: the importer cannot
      // match a 2.x-era row whose `remnawave_panel_id` was never recorded, so
      // it keeps minting, and every mint is another live row on that profile.
      // `DuplicateSubscriptionMergeService.discoverPairs` takes
      // `duplicateOfSubscriptionId` — this row — as the pair's other half. With
      // no `orderBy` that is whichever row Postgres happened to return first,
      // so two identical runs can name two different pairs and the preview an
      // operator approved is not the merge they get. The merge's own survivor
      // rule is deterministic; this was the non-determinism UPSTREAM of it.
      //
      // `createdAt` ASC then `id` ASC, and the SAME order as the raw probe in
      // {@link writeLink}. Oldest-first is not an arbitrary tiebreak — it is the
      // rule the merge derives its survivor from and the one the fixed importer
      // converges on (`orderBy: { createdAt: 'asc' }`), so all three agree that
      // the oldest live row naming a profile is the canonical one. `id` settles
      // an exact `createdAt` tie: the merge refuses to guess which of two rows
      // stamped at the same instant carries the history, but the REPORT still
      // has to name the same pair every time it is run.
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
      return alone(describe('wouldLink', null, remnawaveId, resolved.id));
    }

    return this.writeLink(row, remnawaveId, resolved.id, describe, resolvedBy);
  }

  /**
   * Two live rows on one panel profile: which of the two things is it?
   *
   * A GENUINE COLLISION (different customers) is the dangerous one and keeps
   * the old `conflict` name and refusal. THE PAIR THIS DEFECT PRODUCED (both
   * rows on one `userId`) is a different animal: the importer saw one customer
   * as two after the 2.x → 3.x identity split and minted a second Subscription
   * for the profile they already had. It is reported as `duplicatePair` and
   * NOT repaired here — merging carries history, payments and referral links,
   * and belongs behind its own dry run.
   *
   * BOTH HALVES ARE EMITTED, and the polarity is the point. The scanned half is
   * the OLDER row: it holds the customer's history and a 2.x uuid that names
   * NOTHING on this panel. The holder is the NEWER, wrong-looking duplicate,
   * and it is the row actually bound to the LIVE profile. An operator who
   * deletes the wrong-looking card issues a panel DELETE against a paying
   * customer's live profile, so a report that lists a pair without saying which
   * half is live is worse than no report at all.
   *
   * CROSS-USER PAIRS ARE NOT DETECTABLE and are therefore not claimed. When the
   * importer minted a second USER as well (`matchOrCreateUser` Priority 5), it
   * wrote no marker tying the two Users together — no column on `User`, no
   * column on `Subscription`, and `wasJustCreated` reads a five-second
   * `createdAt` window that is long gone. Nothing sound distinguishes "one
   * customer the importer split in two" from "two customers whose rows collided
   * on one profile", so such a pair is reported as `conflict`: the weaker, safer
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
          `subscription ${holder.id} is already live on panel profile ${remnawaveId}; it belongs ` +
            `to a DIFFERENT customer (${holderOwner}, not ${row.userId}), so this is a genuine ` +
            'collision and not the duplicate pair the 2.x/3.x identity split produces. Two ' +
            "subscriptions sharing one panel profile overwrite each other and delete each other's " +
            'service, so nothing was changed.',
          remnawaveId,
          panelId,
        ),
        partner: null,
      };
    }
    return {
      row: describe(
        'duplicatePair',
        `subscription ${holder.id} — the SAME customer (${row.userId}) — is already live on panel ` +
          `profile ${remnawaveId}, which is the profile this row resolves to. This is the pair ` +
          'the 2.x/3.x identity split produced. THIS row does NOT hold the live identity: it ' +
          `stores '${row.remnawaveId ?? 'nothing'}'. Subscription ${holder.id} does. Nothing was ` +
          'changed, and merging the two is not the job of this sweep.',
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
        remnawaveId,
        storedRemnawaveId: holder.remnawaveId,
        panelId: holder.remnawavePanelId ?? panelId,
        duplicateOfSubscriptionId: row.id,
        holdsLiveIdentity: true,
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
   * IMMUTABLE identifiers are asked about. A uuid and a numeric panel id each
   * name one profile forever, so a match is a proven double-link. The panel
   * USERNAME is deliberately not part of it — it is mutable and re-derivable,
   * so a stale row still carrying the name of a profile that no longer exists
   * would wedge every future repair under that name.
   *
   * AND IT IS ORDERED THE WAY THE DRY RUN ORDERS IT — `created_at` ASC, then
   * `id` ASC. `LIMIT 1` with no `ORDER BY` hands back whichever row the plan
   * reached first, which is not a promise Postgres makes twice. In a cluster of
   * three live rows on one profile that lets the write path and the preview name
   * two DIFFERENT holders for the same database — and the preview's answer is
   * what `DuplicateSubscriptionMergeService.discoverPairs` merges on. Both
   * probes ask one question, in one order.
   *
   * THE FENCE IS "THE ROW STILL HOLDS WHAT IT HELD WHEN WE SELECTED IT" — a
   * compare-and-swap on `remnawave_id`, which is `IS NULL` for population 1 and
   * `= <the stale uuid>` for population 2. One expression, both populations,
   * and the same guarantee in each: a concurrent CREATE that has already
   * re-linked this row must WIN, because it linked a profile it just
   * provisioned or adopted under a lock while this sweep is acting on a fact it
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
      // `panelId` is proven a safe integer by `resolvePanelIdentity`, so the
      // `IS NOT NULL` guard `persistProfileLink` needs around its nullable
      // argument has nothing to guard here and is left out rather than written
      // as dead code. The question asked is otherwise identical.
      //
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
        row: describe('linked', null, remnawaveId, panelId, { holdsLiveIdentity: true }),
        partner: null,
      };
    });
  }
}

/** The per-row constructor `reconcileRow` hands to its helpers. */
type DescribeRow = (
  outcome: PanelLinkReconciliationOutcome,
  reason: string | null,
  remnawaveId?: string | null,
  panelId?: number | null,
  extra?: {
    readonly duplicateOfSubscriptionId?: string | null;
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
