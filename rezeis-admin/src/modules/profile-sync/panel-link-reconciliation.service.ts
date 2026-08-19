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
  /** A concurrent CREATE linked the row first; its link is left alone. */
  | 'raceLost';

export interface PanelLinkReconciliationRow {
  readonly subscriptionId: string;
  readonly userId: string;
  /** The stored `remnawave_panel_username` — the operator's handle on the row. */
  readonly panelUsername: string;
  /** Which of the two routes was tried. Exactly one is, per row. */
  readonly resolvedBy: 'shortUuid' | 'username';
  readonly outcome: PanelLinkReconciliationOutcome;
  /** The identity that was (or would be) written; `null` when nothing resolved. */
  readonly remnawaveId: string | null;
  readonly panelId: number | null;
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
  /** Every row that was NOT repaired, each carrying its own reason. */
  readonly unrepaired: readonly PanelLinkReconciliationRow[];
  /**
   * `true` when the run stopped at `limit` with the selection not exhausted.
   * The operator runs again from {@link nextCursor}.
   */
  readonly hasMore: boolean;
  /** The id of the last row examined, or `null` when nothing was. */
  readonly nextCursor: string | null;
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
  readonly remnawavePanelUsername: string | null;
  readonly configUrl: string | null;
}

/**
 * PanelLinkReconciliationService
 * ──────────────────────────────
 * A deliberate, operator-initiated repair for subscriptions whose panel profile
 * EXISTS but whose `remnawave_id` is NULL.
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

    const repaired: PanelLinkReconciliationRow[] = [];
    const unrepaired: PanelLinkReconciliationRow[] = [];
    let cursor: string | null =
      typeof options.startAfterId === 'string' && options.startAfterId.length > 0
        ? options.startAfterId
        : null;
    let scanned = 0;
    let hasMore = false;

    while (scanned < limit) {
      // One more than needed, so "the cap was reached AND rows remain" is
      // answered without a second query — and without reporting `hasMore` for a
      // selection that merely happened to end exactly on the boundary.
      const page = await this.selectBrokenLinks(cursor, Math.min(chunkSize, limit - scanned) + 1);
      const rows = page.slice(0, Math.min(chunkSize, limit - scanned));
      if (rows.length === 0) break;

      for (const row of rows) {
        const result = await this.reconcileRow(row, dryRun);
        (result.outcome === 'linked' || result.outcome === 'wouldLink'
          ? repaired
          : unrepaired
        ).push(result);
        // Named in the log too, not only in the response body: the operator who
        // triggers this from the SPA sees the report, the one reading logs a
        // week later sees the same rows.
        if (result.reason !== null) {
          this.logger.warn(
            `Panel link reconciliation: subscription ${result.subscriptionId} (user ` +
              `${result.userId}, panel username '${result.panelUsername}', tried ` +
              `${result.resolvedBy}) not repaired — ${result.outcome}: ${result.reason}`,
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
    };

    if (scanned > 0) {
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
        },
      );
    }
    return report;
  }

  /**
   * The damaged rows, paged by id.
   *
   * Paged by `id > cursor` rather than by OFFSET on purpose: a real run REMOVES
   * rows from this selection as it repairs them, and an offset walk over a
   * shrinking set skips one row for every row it fixes.
   */
  private async selectBrokenLinks(cursor: string | null, take: number): Promise<BrokenLinkRow[]> {
    return this.prismaService.subscription.findMany({
      where: {
        status: { not: SubscriptionStatus.DELETED },
        remnawaveId: null,
        remnawavePanelUsername: { not: null },
        configUrl: { not: null },
        ...(cursor === null ? {} : { id: { gt: cursor } }),
      },
      orderBy: { id: 'asc' },
      take,
      select: { id: true, userId: true, remnawavePanelUsername: true, configUrl: true },
    });
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
   */
  private async reconcileRow(
    row: BrokenLinkRow,
    dryRun: boolean,
  ): Promise<PanelLinkReconciliationRow> {
    const panelUsername = row.remnawavePanelUsername ?? '';
    const shortUuid = panelShortUuidFromConfigUrl(row.configUrl ?? null);
    const useShortUuid = shortUuid !== null && shortUuid.length > 0;
    const resolvedBy: 'shortUuid' | 'username' = useShortUuid ? 'shortUuid' : 'username';
    const describe = (
      outcome: PanelLinkReconciliationOutcome,
      reason: string | null,
      remnawaveId: string | null = null,
      panelId: number | null = null,
    ): PanelLinkReconciliationRow => ({
      subscriptionId: row.id,
      userId: row.userId,
      panelUsername,
      resolvedBy,
      outcome,
      remnawaveId,
      panelId,
      reason,
    });

    if (!useShortUuid && panelUsername.length === 0) {
      // Unreachable through the selection (it requires a non-null username),
      // but an empty string passes `IS NOT NULL` — and resolving by it would
      // ask the panel "which user is called nothing?" and act on the answer.
      return describe('unresolved', 'no subscription short UUID and no panel username');
    }

    const selector = useShortUuid
      ? { shortUuid: shortUuid as string }
      : { username: panelUsername };
    const resolved = await this.remnawaveApiService.resolvePanelIdentity(selector);
    if (resolved === null) {
      return describe(
        'unresolved',
        useShortUuid
          ? `panel did not resolve shortUuid '${shortUuid}'`
          : `panel did not resolve username '${panelUsername}'`,
      );
    }

    // WHICH SPELLING TO STORE IS READ OFF THE PANEL'S OWN ANSWER, not off a
    // version probe — the same rule `parsePanelUserRow` follows for read rows.
    // A 2.x panel returns the profile's `uuid` and that is what every 2.x-era
    // route wants; a 3.x panel has none to return and keys everything by the
    // numeric id. Writing the other era's spelling would recreate, by hand,
    // exactly the unaddressable row this sweep exists to repair.
    const remnawaveId =
      typeof resolved.uuid === 'string' && resolved.uuid.length > 0
        ? resolved.uuid
        : String(resolved.id);

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
      return describe(
        'unresolved',
        outcome.kind === 'missing'
          ? `panel resolved ${resolvedBy} to profile ${remnawaveId} but that profile is gone`
          : `panel profile ${remnawaveId} could not be read back (panel unavailable or ` +
            'undecodable body); nothing was changed',
        remnawaveId,
        resolved.id,
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
      return describe('notOwned', (err as Error).message, remnawaveId, resolved.id);
    }

    if (dryRun) {
      // The preview asks the exclusivity question too. A dry run that reported
      // "would link" for a row a real run would refuse is not a preview.
      const conflict = await this.prismaService.subscription.findFirst({
        where: {
          id: { not: row.id },
          status: { not: SubscriptionStatus.DELETED },
          OR: [{ remnawaveId }, { remnawavePanelId: resolved.id }],
        },
        select: { id: true },
      });
      if (conflict !== null) {
        return describe(
          'conflict',
          `subscription ${conflict.id} is already live on panel profile ${remnawaveId}`,
          remnawaveId,
          resolved.id,
        );
      }
      return describe('wouldLink', null, remnawaveId, resolved.id);
    }

    return this.writeLink(row, remnawaveId, resolved.id, describe);
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
   * THE FENCE IS `remnawave_id IS NULL`. A concurrent CREATE that has already
   * re-linked this row must WIN: it linked a profile it just provisioned or
   * adopted under a lock, while this sweep is acting on a fact it read before
   * the round-trip. Overwriting it would detach a live profile and leave an
   * orphan on the panel.
   */
  private async writeLink(
    row: BrokenLinkRow,
    remnawaveId: string,
    panelId: number,
    describe: (
      outcome: PanelLinkReconciliationOutcome,
      reason: string | null,
      remnawaveId?: string | null,
      panelId?: number | null,
    ) => PanelLinkReconciliationRow,
  ): Promise<PanelLinkReconciliationRow> {
    return this.prismaService.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext(${`remnawave-profile:${remnawaveId}`})::bigint)
      `);
      // `panelId` is proven a safe integer by `resolvePanelIdentity`, so the
      // `IS NOT NULL` guard `persistProfileLink` needs around its nullable
      // argument has nothing to guard here and is left out rather than written
      // as dead code. The question asked is otherwise identical.
      const conflicts = await tx.$queryRaw<Array<{ conflictId?: string | null }>>(Prisma.sql`
        SELECT "id" AS "conflictId"
        FROM "subscriptions"
        WHERE "id" <> ${row.id}
          AND "status" <> 'DELETED'
          AND (
            "remnawave_id" = ${remnawaveId}
            OR "remnawave_panel_id" = ${panelId}::int
          )
        LIMIT 1
      `);
      const conflictId = conflicts[0]?.conflictId;
      if (typeof conflictId === 'string' && conflictId.length > 0) {
        return describe(
          'conflict',
          `subscription ${conflictId} is already live on panel profile ${remnawaveId}; two ` +
            "subscriptions sharing one panel profile overwrite each other and delete each other's " +
            'service',
          remnawaveId,
          panelId,
        );
      }

      const written = await tx.subscription.updateMany({
        where: { id: row.id, remnawaveId: null },
        data: { remnawaveId, remnawavePanelId: panelId },
      });
      if (written.count === 0) {
        return describe(
          'raceLost',
          'the row was linked by a concurrent provision while this repair was in flight; its ' +
            'link is left alone',
          remnawaveId,
          panelId,
        );
      }
      return describe('linked', null, remnawaveId, panelId);
    });
  }
}

/** Reads a caller-supplied bound, falling back rather than trusting it. */
function clampPositive(value: unknown, fallback: number, ceiling: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  if (floored < 1) return fallback;
  return Math.min(floored, ceiling);
}
