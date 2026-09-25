import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ImportStatus, Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  describeStrictOutcome,
  RemnawaveStrictOutcome,
} from '../../remnawave/interfaces/remnawave-strict-outcome.interface';
import { panelExpiryToLocal, withLocalOpenEndKept } from '../../remnawave/services/panel-expiry';
import {
  RemnawaveApiService,
  RemnawavePanelUser,
  RemnawavePanelUserList,
} from '../../remnawave/services/remnawave-api.service';
import {
  finishTermModelReadback,
  judgePanelRowReadback,
  TERM_MODEL_MARKER_SELECT,
  withoutWithheldReadbackFields,
} from '../../remnawave/services/term-model-readback';
import { panelTrafficLimitToGb } from '../../remnawave/utils/panel-traffic-limit.util';
import {
  readRemnawaveProfileFacts,
  stampRemnawaveProfileFacts,
} from '../../remnawave/utils/remnawave-profile-facts.util';
import {
  readProfileOwnerMarker,
  readProfileOwnerMarkers,
} from '../../profile-sync/panel-owner-marker';

export interface RemnawaveImportSummary {
  readonly importRecordId: string;
  readonly fetched: number;
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly subscriptionsCreated: number;
  readonly subscriptionsUpdated: number;
  readonly descriptionWritebacks: number;
  readonly errors: readonly string[];
}

interface RunInput {
  readonly mode: 'import' | 'sync';
  readonly createdBy: string | null;
  /**
   * Optional: pre-allocated `ImportRecord.id` (created by the queue
   * producer in DRAFT status before enqueue). When provided, the
   * importer **updates** that row with the final stats instead of
   * creating a brand-new record. The frontend polls this id, so
   * creating a second record would leave the polled row stuck in
   * DRY_RUN — that was the "infinite progress dialog" bug we hit on
   * v0.3.8 launch.
   *
   * When `null` (e.g. CLI usage), the importer falls back to the old
   * behaviour and creates a fresh record so legacy callers still work.
   */
  readonly importRecordId?: string | null;
}

/**
 * The `where` arms that mean "this local row names THIS panel profile".
 *
 * WHY THIS IS NOT ONE COLUMN COMPARED TO ONE STRING, which is what it used to
 * be. `panelUser.uuid` is an identity STRING, not a UUID, and which string it
 * is depends on the panel that answered: Remnawave 2.x hands back the profile
 * uuid, 3.x dropped the uuid column outright and `parsePanelUserRow` therefore
 * keys the row by `String(id)` — a decimal. `Subscription.remnawaveId` carries
 * the same dual meaning, frozen at the moment the row was linked.
 *
 * So on a panel the operator has upgraded from 2.x to 3.x, every row linked in
 * the 2.x era stores a uuid while the panel now reports a decimal for the very
 * same profile, and `remnawaveId = panelUser.uuid` compares the two spellings
 * and finds them unequal. FOREVER — the stored string is deliberately not
 * rewritten (see `prisma/schema.prisma`, `Subscription.remnawaveId`). Every
 * such customer therefore looked brand new to the importer on the first sync
 * after the upgrade, and got a second Subscription — and, through
 * `matchOrCreateUser` Priority 4, a second User.
 *
 * The three arms are the three SOUND ways two records can be shown to name one
 * profile, and all three are immutable panel facts:
 *   • the stored identity equals the one the panel just reported;
 *   • the stored identity is the OTHER era's spelling of the same numeric id;
 *   • the recorded numeric id equals the panel's.
 *
 * DELIBERATELY NOT `remnawavePanelUsername`, even though it would close the
 * last gap: a name is not an identity. An operator can rename a profile, and a
 * name freed by a rename or a delete can later be taken by a DIFFERENT profile
 * — so matching on it would let this importer adopt somebody else's row. Same
 * reasoning, same conclusion as the link-repair endpoint's `namesSameProfile`
 * in `admin-user-subscriptions.controller.ts`, which is the canonical statement
 * of this question.
 *
 * The numeric arms are OMITTED, not compared against null, when the panel gave
 * no id: `remnawave_panel_id` carries no unique constraint (migration
 * 20260810160000 records why one cannot be added to live data), so
 * `remnawavePanelId: null` would match every row that has none — turning "who
 * is this profile" into "anybody". Same shape as the retirement fence in
 * `ProfileSyncProcessor.handleDelete`.
 *
 * Exported for the other readers of a panel row that must ask the same
 * question — whether a second live row names this profile — before they push
 * anything to it (`term-model-readback.ts`).
 */
export function panelProfileClaims(panelUser: RemnawavePanelUser): Prisma.SubscriptionWhereInput[] {
  const claims: Prisma.SubscriptionWhereInput[] = [{ remnawaveId: panelUser.uuid }];
  const panelId = panelUser.panelId;
  if (panelId !== null && Number.isSafeInteger(panelId)) {
    // On 3.x the first arm and this one are the same string; an OR does not
    // care, and spelling both out keeps the rule readable on either era.
    claims.push({ remnawaveId: String(panelId) }, { remnawavePanelId: panelId });
  }
  return claims;
}

/**
 * The claim of a subscription whose interrupted CREATE is about to adopt this
 * profile — `null` when the profile has no name to be claimed by.
 *
 * `ProfileSyncProcessor.handleCreate` records the name it chose, and the
 * customer it chose it for, BEFORE the POST that makes the profile, and the
 * retry asks for that name first and adopts what it finds. A sync that ran in
 * between imported the profile as a SECOND subscription: the retry then found
 * it held by that row and refused, and no tool could untangle the pair — the
 * merge has no route, the link repair does not select the paid row, the manual
 * link answers "already linked", and deleting the imported row deleted the
 * live profile. So such a profile is the CREATE's: this importer neither makes
 * a row for it nor updates the pending one (its update would stamp a paid
 * purchase `importedFrom: 'remnawave'` and overwrite it from the panel).
 *
 * A claim in the sense of `panelProfileClaims`, answered the way the CREATE
 * answers it: bound to the owner the marker line proves, so a profile under a
 * recorded name whose line names somebody else — it won the name from that
 * CREATE — is imported as usual. One whose lines prove nobody is left as well:
 * the CREATE refuses it for an operator.
 */
function pendingCreateClaim(panelUser: RemnawavePanelUser): Prisma.SubscriptionWhereInput | null {
  if (!panelUser.username) return null;
  const owner = readProfileOwnerMarker(panelUser.description);
  return {
    remnawavePendingUsername: panelUser.username,
    ...(owner !== null ? { remnawavePendingOwnerId: owner } : {}),
    status: { not: SubscriptionStatus.DELETED },
  };
}

/**
 * A stored `Json` column read back as a plain object, or `{}` when it is
 * anything else (null, an array, a scalar — all legal in that column).
 *
 * Exists so an UPDATE can MERGE into `planSnapshot` instead of replacing it.
 * Prisma has no per-key update for a `Json` column: whatever object reaches the
 * client is written over the whole document.
 */
function jsonObjectOf(value: unknown): Prisma.InputJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Prisma.InputJsonObject)
    : {};
}

/**
 * Two-way Remnawave importer/synchronizer.
 *
 * Matching priority (first hit wins):
 *   1. the description's marker LINE "reiwa_id: {cuid}" → exact match by PK.
 *      Read by `readProfileOwnerMarker`: a line that IS the marker, never a
 *      `reiwa_id:` elsewhere in the text — the display name on the line above
 *      is the customer's own text and could name somebody else's id.
 *   2. telegramId → unique match
 *   3. email → unique match
 *   4. existing Subscription.remnawaveId → recovers web-only users that
 *      have no Telegram/email but were previously linked through import.
 *      Without this step every re-import would create a fresh duplicate
 *      User row for them since their only handle is `WebAccount.login`,
 *      which Remnawave knows nothing about.
 *   5. No match → create new User (import mode only; sync skips)
 *
 * After matching/creating a User:
 *   - Creates or updates a Subscription with remnawaveId = panelUser.uuid
 *   - Writes back "reiwa_id: {user.id}" into Remnawave description (if missing)
 */
@Injectable()
export class RemnawaveImporterService {
  private readonly logger = new Logger(RemnawaveImporterService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
  ) {}

  public async run(input: RunInput): Promise<RemnawaveImportSummary> {
    // This importer WRITES for every row it is handed — it creates users,
    // rebinds `Subscription.userId`, and records `createdUserIds` as the
    // rollback set. A shortened list is therefore not a smaller import, it is a
    // wrong one: the rollback set no longer describes the run, and a row whose
    // uuid we could not decode would land on `remnawaveId: ''`, a key with no
    // unique index that every other uuid-less row collapses onto. Unlike the
    // backup importers (which fail soft to their donor values), there is no
    // safe degraded mode here — anything short of a vouched-for read refuses.
    let bulk: RemnawaveStrictOutcome<RemnawavePanelUserList>;
    // When this run ASKED the panel — before the page walk, not after it. A
    // subscription in the term model takes an expiry from this read only when
    // nothing rezeis pushed to its profile landed after this instant: a push
    // that completes while the walk runs, or while this loop reaches the row,
    // is newer than what was read (`term-model-readback.ts`).
    const readAt = new Date();
    try {
      bulk = await this.remnawaveApiService.strictGetAllPanelUsers();
    } catch (err) {
      this.logger.error(`strictGetAllPanelUsers threw: ${(err as Error).message}`);
      throw new ServiceUnavailableException('REMNAWAVE_INTEGRATION_UNAVAILABLE');
    }
    if (bulk.kind !== 'ok') {
      this.logger.error(
        `Remnawave import refused: the panel user list is not trustworthy (${describeStrictOutcome(bulk)})`,
      );
      throw new ServiceUnavailableException('REMNAWAVE_INTEGRATION_UNAVAILABLE');
    }
    // `ok` is not the whole answer: the adapter also reports whether its page
    // walk reached the END of the list, and it hands back `complete: false` when
    // it stopped at the 25 000-row ceiling. Those rows are real, so the OVERLAY
    // consumers keep the prefix and confirm each miss per-uuid — but this
    // importer has no such second signal and never looks for one. For it a
    // prefix is a wrong import, not a small one: a 30 000-user panel would
    // finish COMMITTED with `errors: []` while 5 000 paying customers got no
    // account, and `rollback.createdUserIds` would describe only the prefix. So
    // the same refusal as every other untrustworthy read.
    //
    // `=== false` and not `!complete`, matching `remnawave-overlay.util.ts` and
    // `sharing-detectors.ts`: the adapter is the only real producer and always
    // sets the flag, so its ABSENCE is a hand-built list (a test double), which
    // means "a normal, complete read" — never a silent refusal of every import.
    if (bulk.value.complete === false) {
      this.logger.error(
        `Remnawave import refused: the panel user list is a PREFIX — the walk stopped at the page ceiling ` +
          `holding ${bulk.value.users.length} of ${bulk.value.total} rows`,
      );
      throw new ServiceUnavailableException('REMNAWAVE_INTEGRATION_UNAVAILABLE');
    }
    const panelUsers: readonly RemnawavePanelUser[] = bulk.value.users;

    const errors: string[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let subscriptionsCreated = 0;
    let subscriptionsUpdated = 0;
    let descriptionWritebacks = 0;
    // Ids of users this run newly created (not matched/updated) — persisted in
    // `result.rollback.createdUserIds` so an operator can undo the import,
    // deleting exactly these users (and their cascaded subs/web-accounts).
    const createdUserIds: string[] = [];

    for (const panelUser of panelUsers) {
      try {
        // A profile an interrupted CREATE is still linking is that CREATE's —
        // see `pendingCreateClaim`. Asked before anything is matched, so not
        // even an account is made for it.
        const pendingClaim = pendingCreateClaim(panelUser);
        if (pendingClaim !== null) {
          const pending = await this.prismaService.subscription.findFirst({
            where: pendingClaim,
            select: { id: true },
          });
          if (pending !== null) {
            this.logger.log(
              `Remnawave profile '${panelUser.username}' is the one subscription ${pending.id}'s ` +
                'interrupted CREATE recorded; leaving it for that CREATE to adopt',
            );
            skipped += 1;
            continue;
          }
        }

        const userId = await this.matchOrCreateUser(panelUser, input.mode);
        if (userId === null) {
          skipped += 1;
          continue;
        }

        // Check if this was a creation or update
        const wasCreated = await this.wasJustCreated(userId);
        if (wasCreated) {
          created += 1;
          createdUserIds.push(userId);
        } else {
          updated += 1;
        }

        // ── Subscription sync ─────────────────────────────────────────────
        const subResult = await this.syncSubscription(userId, panelUser, input.importRecordId ?? null, readAt);
        if (subResult === 'created') subscriptionsCreated += 1;
        if (subResult === 'updated') subscriptionsUpdated += 1;

        // ── Write back reiwa_id to Remnawave description ──────────────────
        const wroteBack = await this.writeBackReiwaId(userId, panelUser);
        if (wroteBack) descriptionWritebacks += 1;
      } catch (err) {
        const identifier = panelUser.telegramId ?? panelUser.username ?? panelUser.uuid;
        const message = `${identifier}: ${(err as Error).message}`;
        errors.push(message);
        this.logger.warn(`Importer row failed: ${message}`);
      }
    }

    const finalStatus = errors.length === 0 ? ImportStatus.COMMITTED : ImportStatus.FAILED;
    const resultPayload = {
      mode: input.mode,
      fetched: panelUsers.length,
      created,
      updated,
      skipped,
      subscriptionsCreated,
      subscriptionsUpdated,
      descriptionWritebacks,
      errors,
      // `hasMatchedWrites` blocks a destructive rollback when this run UPDATED
      // pre-existing users (their prior state is not snapshotted, so deleting
      // them on undo would lose unrestorable data). Must be set by EVERY
      // importer that can update matched users — see ImportsService.rollback.
      rollback: { createdUserIds, hasMatchedWrites: updated > 0 },
    } satisfies Prisma.InputJsonValue;
    const errorMessage = errors.length === 0 ? null : errors.slice(0, 5).join('; ');

    // Prefer the pre-allocated record id (created by ImportQueueService
    // before enqueue) so the row the SPA is polling becomes the row
    // we finalize. Falling back to a fresh create() keeps the legacy
    // CLI/test paths working when no id is supplied.
    const importRecord = input.importRecordId
      ? await this.prismaService.importRecord.update({
          where: { id: input.importRecordId },
          data: {
            status: finalStatus,
            recordsTotal: panelUsers.length,
            recordsOk: created + updated,
            recordsFailed: errors.length,
            result: resultPayload,
            errorMessage,
            committedAt: new Date(),
          },
        })
      : await this.prismaService.importRecord.create({
          data: {
            filename: `remnawave-${input.mode}-${new Date().toISOString()}.json`,
            sourceType: 'remnawave',
            status: finalStatus,
            recordsTotal: panelUsers.length,
            recordsOk: created + updated,
            recordsFailed: errors.length,
            result: resultPayload,
            errorMessage,
            createdBy: input.createdBy,
            committedAt: new Date(),
          },
        });

    return {
      importRecordId: importRecord.id,
      fetched: panelUsers.length,
      created,
      updated,
      skipped,
      subscriptionsCreated,
      subscriptionsUpdated,
      descriptionWritebacks,
      errors,
    };
  }

  // ── User matching ─────────────────────────────────────────────────────────

  /**
   * Match a Remnawave panel user to a local User, or create one.
   * Returns the local User ID, or null if skipped.
   */
  private async matchOrCreateUser(
    panelUser: RemnawavePanelUser,
    mode: 'import' | 'sync',
  ): Promise<string | null> {
    // Priority 1: the reiwa_id marker LINE in the description. Only a line that
    // is the marker counts, and only when every such line names one owner: a
    // Telegram first name of `reiwa_id: <victim>` used to move this profile —
    // and the subscription built from it — into the victim's account.
    const reiwaId = readProfileOwnerMarker(panelUser.description);
    if (reiwaId !== null) {
      const user = await this.prismaService.user.findUnique({
        where: { id: reiwaId },
        select: { id: true },
      });
      if (user) {
        await this.updateUserFields(user.id, panelUser);
        return user.id;
      }
      // reiwa_id in description but user not found locally — fall through
    }

    // Priority 2: telegramId
    if (panelUser.telegramId !== null) {
      const telegramIdBigInt = BigInt(panelUser.telegramId);
      const user = await this.prismaService.user.findUnique({
        where: { telegramId: telegramIdBigInt },
        select: { id: true },
      });
      if (user) {
        await this.updateUserFields(user.id, panelUser);
        return user.id;
      }
    }

    // Priority 3: email
    if (panelUser.email) {
      const user = await this.prismaService.user.findUnique({
        where: { email: panelUser.email },
        select: { id: true },
      });
      if (user) {
        await this.updateUserFields(user.id, panelUser);
        return user.id;
      }
    }

    // Priority 4: existing Subscription that already names this panel
    // profile. This catches the realistic case where a user signed up
    // through the web cabinet (no Telegram, no email — only a
    // WebAccount.login) and was previously linked through `import`.
    // Without this priority, every subsequent `import` would create a
    // brand-new User dupe because there's no other way to identify a
    // web-only customer from the panel side.
    //
    // A MISS HERE IS THE WORST MISS IN THIS FILE. Priority 5 does not skip on
    // a miss in `import` mode — it CREATES a User. So the moment this question
    // is asked in a form that cannot match, every re-import mints a second
    // customer account for somebody who already has one, and `syncSubscription`
    // then hangs a second Subscription off it.
    const existingSub = await this.prismaService.subscription.findFirst({
      where: { OR: panelProfileClaims(panelUser) },
      orderBy: { createdAt: 'asc' },
      select: { userId: true },
    });
    if (existingSub) {
      await this.updateUserFields(existingSub.userId, panelUser);
      return existingSub.userId;
    }

    // Priority 5: No match — create (import mode only)
    if (mode === 'sync') {
      return null;
    }

    const handle = this.publicHandleFrom(panelUser);
    const newUser = await this.prismaService.user.create({
      data: {
        telegramId: panelUser.telegramId !== null ? BigInt(panelUser.telegramId) : null,
        username: handle,
        email: panelUser.email || null,
        name: handle ?? panelUser.uuid.slice(0, 8),
      },
    });
    return newUser.id;
  }

  /**
   * The panel username as a PUBLIC HANDLE — or `null` when it is not one.
   *
   * A profile whose description carries a `reiwa_id` marker LINE was created
   * by US, and its username is the string our own naming service generated,
   * `{prefix}_{identity}_{suffix}` — never a handle a person chose. Copying it
   * into `User.username` is how `2GET_Lant35_sub` came to stand on the
   * operator's screen as a subscriber's public username; and because the
   * importer runs on every sync, correcting it by hand never stuck. Any marker
   * line counts here, even lines that disagree: the question is "did we write
   * this description", not "whose is it".
   *
   * For a FOREIGN profile the panel username may be the only handle that
   * exists. That is the case this field was added for, and it still works.
   */
  private publicHandleFrom(panelUser: RemnawavePanelUser): string | null {
    if (!panelUser.username) return null;
    if (readProfileOwnerMarkers(panelUser.description).length > 0) return null;
    return panelUser.username;
  }

  private async updateUserFields(userId: string, panelUser: RemnawavePanelUser): Promise<void> {
    // Filled ONLY into an account that has no handle yet, and never over one
    // it already has: the local value is what the subscriber or the operator
    // set, and this method runs on every sync. Conditional write rather than
    // read-then-write, so two syncs racing cannot both decide it is empty.
    const handle = this.publicHandleFrom(panelUser);
    if (handle !== null) {
      await this.prismaService.user.updateMany({
        where: { id: userId, OR: [{ username: null }, { username: '' }] },
        data: { username: handle },
      });
    }

    const data: Prisma.UserUpdateInput = {};
    if (panelUser.email) data.email = panelUser.email;
    if (panelUser.telegramId !== null) data.telegramId = BigInt(panelUser.telegramId);
    if (Object.keys(data).length > 0) {
      await this.prismaService.user.update({ where: { id: userId }, data });
    }
  }

  private async wasJustCreated(userId: string): Promise<boolean> {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: { createdAt: true },
    });
    if (!user) return false;
    // If created within last 5 seconds, it was just created by us
    return Date.now() - user.createdAt.getTime() < 5000;
  }

  // ── Subscription sync ─────────────────────────────────────────────────────

  /**
   * Create or update a Subscription linked to the Remnawave profile.
   *
   * An existing row IN THE TERM MODEL is updated by the rule every Remnawave
   * read-back shares (`term-model-readback.ts`): its limits are never taken
   * from the panel — a profile holding other ones gets rezeis' own pushed back
   * — and its expiry only when nothing rezeis pushed landed after `readAt`.
   * Everything else, and every row outside the model or being created, is
   * written as before.
   *
   * `readAt` is the moment `run` ASKED the panel, and has no default on
   * purpose: "now" is after the answer, which is the one wrong time.
   */
  private async syncSubscription(
    userId: string,
    panelUser: RemnawavePanelUser,
    importRecordId: string | null,
    readAt: Date,
  ): Promise<'created' | 'updated' | 'skipped'> {
    // Is any local row ALREADY this panel profile? Asked over every sound
    // spelling of the profile's identity — see `panelProfileClaims`. Oldest
    // first, so that on a database that already carries the duplicates this
    // defect produced the importer converges on the ORIGINAL row rather than
    // alternating between it and its duplicate from run to run.
    const existing = await this.prismaService.subscription.findFirst({
      where: { OR: panelProfileClaims(panelUser) },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        userId: true,
        planSnapshot: true,
        remnawaveId: true,
        trafficLimit: true,
        deviceLimit: true,
        // A subscription with no end keeps it (`withLocalOpenEndKept`).
        expiresAt: true,
        ...TERM_MODEL_MARKER_SELECT,
      },
    });

    const status = this.mapStatus(panelUser.status);
    // Panel bytes → our whole-GB column, through the one converter every
    // writer of this column shares. A positive cap never rounds down to `0`,
    // because `0` here means zero gigabytes, not unlimited — this line used
    // to lack that floor and disagreed with the webhook mirror on 0.4 GB.
    const trafficLimitGb = panelTrafficLimitToGb(panelUser.trafficLimitBytes);
    // A date in 2099 is "no end", `null` as rezeis holds it; a profile that
    // states no readable date leaves an existing row's alone (`panel-expiry.ts`).
    const statedExpiresAt = panelExpiryToLocal(panelUser.expireAt);
    const expiresAt = statedExpiresAt ?? null;
    // The supplementary identity columns, written from a panel row that carries
    // them on BOTH eras (2.x returns the numeric id beside the uuid; 3.x keys
    // everything by it). Never written as null: a value we could not read must
    // not erase one that was recorded earlier.
    //
    // NOT COSMETIC. `ProfileSyncProcessor.panelProfileClaimedByAnother` — the
    // one guard standing between a DELETE and somebody else's live panel
    // profile — asks whether another row claims this profile, and it can only
    // ask through these columns. Every row this importer created left both
    // NULL, which is precisely why that guard was disarmed for exactly the
    // population this importer produces.
    const panelIdentityColumns = {
      ...(panelUser.panelId !== null && Number.isSafeInteger(panelUser.panelId)
        ? { remnawavePanelId: panelUser.panelId }
        : {}),
      ...(panelUser.username.length > 0
        ? { remnawavePanelUsername: panelUser.username }
        : {}),
    };

    const subscriptionData: Prisma.SubscriptionUpdateInput = {
      status,
      trafficLimit: trafficLimitGb,
      deviceLimit: panelUser.hwidDeviceLimit,
      configUrl: panelUser.subscriptionUrl || null,
      ...(statedExpiresAt === undefined ? {} : { expiresAt: statedExpiresAt }),
      internalSquads: panelUser.activeInternalSquads?.map((s) => s.uuid) ?? [],
      externalSquad: panelUser.externalSquadUuid ?? null,
      ...panelIdentityColumns,
      // MERGED INTO, never replaced. Prisma writes a `Json` column WHOLESALE —
      // there is no per-key update — so an object literal built only from panel
      // facts silently drops every key the row already carried. `name` is one
      // of them, and it is what the cabinet, the bot and every invoice render
      // as the customer's plan: a sync that matched a row used to leave it
      // nameless. The spread has to happen HERE, at the call site, because by
      // the time the value reaches Prisma it is just a document to overwrite.
      planSnapshot: {
        ...jsonObjectOf(existing?.planSnapshot),
        importedFrom: 'remnawave',
        // Durable link for bulk plan re-assignment (see BulkPlanAssignmentService).
        ...(importRecordId ? { importRecordId } : {}),
        tag: panelUser.tag,
        trafficLimitStrategy: panelUser.trafficLimitStrategy,
      } satisfies Prisma.InputJsonValue,
    };

    if (existing) {
      // In the term model: asked BEFORE the write, which then leaves the limits
      // out (and the expiry, when the panel's own state outranks this read).
      const verdict = await judgePanelRowReadback(this.prismaService, {
        existing,
        panel: panelUser,
        readAt,
        claims: panelProfileClaims(panelUser),
      });
      // Update existing subscription. Outside the model too, a subscription
      // with no end keeps it: the profile's date is not taken over it, nor an
      // EXPIRED derived from that date (`withLocalOpenEndKept`).
      await this.prismaService.subscription.update({
        where: { id: existing.id },
        data:
          verdict === null
            ? withLocalOpenEndKept(subscriptionData, existing.expiresAt)
            : withoutWithheldReadbackFields(subscriptionData, verdict),
      });
      await this.stampProfileFacts(existing.id, panelUser);
      if (verdict !== null) {
        // After the write: the push is built from the columns when it runs.
        // Queued, not sent from here — this service has no queue, and the
        // five-minute profile-sync sweep picks the PENDING row up. (The backup
        // imports' «Синхронизировать с панелью после импорта» skips a row that
        // already has a push waiting, so it never doubles this one.)
        await finishTermModelReadback(this.prismaService, verdict, {
          subscriptionId: existing.id,
          profile: panelUser.uuid,
          source: 'Remnawave import',
          logger: this.logger,
        });
      }
      // If subscription belongs to a different user (edge case: user was re-matched)
      if (existing.userId !== userId) {
        await this.prismaService.subscription.update({
          where: { id: existing.id },
          data: { user: { connect: { id: userId } } },
        });
      }
      return 'updated';
    }

    // Create new subscription. A new row has no earlier fact to keep, so the
    // profile's two facts go in with it (`remnawave-profile-facts.util.ts`).
    const facts = readRemnawaveProfileFacts(panelUser);
    await this.prismaService.subscription.create({
      data: {
        user: { connect: { id: userId } },
        remnawaveId: panelUser.uuid,
        status,
        trafficLimit: trafficLimitGb,
        deviceLimit: panelUser.hwidDeviceLimit,
        configUrl: panelUser.subscriptionUrl || null,
        expiresAt,
        startedAt: new Date(),
        internalSquads: panelUser.activeInternalSquads?.map((s) => s.uuid) ?? [],
        externalSquad: panelUser.externalSquadUuid ?? null,
        ...panelIdentityColumns,
        ...(facts.createdAt === null ? {} : { remnawaveProfileCreatedAt: facts.createdAt }),
        ...(facts.lastTrafficResetAt === null ? {} : { remnawaveLastTrafficResetAt: facts.lastTrafficResetAt }),
        planSnapshot: {
          importedFrom: 'remnawave',
          // Durable link for bulk plan re-assignment (see BulkPlanAssignmentService).
          ...(importRecordId ? { importRecordId } : {}),
          tag: panelUser.tag,
          trafficLimitStrategy: panelUser.trafficLimitStrategy,
        } satisfies Prisma.InputJsonValue,
      },
    });

    // Set as current subscription if user doesn't have one
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: { currentSubscriptionId: true },
    });
    if (!user?.currentSubscriptionId) {
      const sub = await this.prismaService.subscription.findFirst({
        where: { userId, OR: panelProfileClaims(panelUser) },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (sub) {
        await this.prismaService.user.update({
          where: { id: userId },
          data: { currentSubscriptionId: sub.id },
        });
      }
    }

    return 'created';
  }

  /**
   * The profile's `createdAt` and `lastTrafficResetAt` onto a row this import
   * matched, whatever its status and whatever the read-back rule took of the
   * rest — never null over a value, the reset only forward
   * (`remnawave-profile-facts.util.ts`). A failure costs the stamp, not the
   * import.
   */
  private async stampProfileFacts(subscriptionId: string, panelUser: RemnawavePanelUser): Promise<void> {
    try {
      await stampRemnawaveProfileFacts(this.prismaService, [subscriptionId], readRemnawaveProfileFacts(panelUser));
    } catch (error: unknown) {
      this.logger.warn(
        `Remnawave profile facts not stamped for subscription ${subscriptionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private mapStatus(remnawaveStatus: string): SubscriptionStatus {
    switch (remnawaveStatus.toUpperCase()) {
      case 'ACTIVE': return SubscriptionStatus.ACTIVE;
      case 'DISABLED': return SubscriptionStatus.DISABLED;
      case 'LIMITED': return SubscriptionStatus.LIMITED;
      case 'EXPIRED': return SubscriptionStatus.EXPIRED;
      case 'DELETED': return SubscriptionStatus.DELETED;
      default: return SubscriptionStatus.ACTIVE;
    }
  }

  // ── Write-back reiwa_id to Remnawave ──────────────────────────────────────

  /**
   * If the Remnawave profile's description doesn't contain reiwa_id,
   * write it back so future syncs can match instantly.
   *
   * Returns:
   *   true  — successfully wrote reiwa_id
   *   false — already had reiwa_id, nothing to do
   *
   * On API failure: throws so the caller can record the error against
   * this row instead of silently swallowing the failure (which is what
   * caused descriptionWritebacks=0 for every import on Remnawave 2.7.x
   * before the contract URL fix).
   */
  private async writeBackReiwaId(
    userId: string,
    panelUser: RemnawavePanelUser,
  ): Promise<boolean> {
    const currentDescription = panelUser.description ?? '';
    if (readProfileOwnerMarkers(currentDescription).length > 0) {
      // Already has a reiwa_id LINE — nothing to do. Any marker line stops the
      // write: appending a second one that disagrees would leave the
      // description proving nobody. A `reiwa_id:` elsewhere in a line is not a
      // marker, so such a profile still gets its line written.
      return false;
    }

    const newDescription = currentDescription.length > 0
      ? `${currentDescription}\nreiwa_id: ${userId}`
      : `reiwa_id: ${userId}`;

    await this.remnawaveApiService.updatePanelUser(panelUser.uuid, {
      description: newDescription,
    });
    return true;
  }
}
