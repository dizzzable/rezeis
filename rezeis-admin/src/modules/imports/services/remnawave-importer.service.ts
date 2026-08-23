import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ImportStatus, Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  describeStrictOutcome,
  RemnawaveStrictOutcome,
} from '../../remnawave/interfaces/remnawave-strict-outcome.interface';
import {
  RemnawaveApiService,
  RemnawavePanelUser,
  RemnawavePanelUserList,
} from '../../remnawave/services/remnawave-api.service';
import { panelTrafficLimitToGb } from '../../remnawave/utils/panel-traffic-limit.util';

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

const REIWA_ID_REGEX = /reiwa_id:\s*([a-z0-9]+)/i;

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
 */
function panelProfileClaims(panelUser: RemnawavePanelUser): Prisma.SubscriptionWhereInput[] {
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
 *   1. description contains "reiwa_id: {cuid}" → exact match by PK
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
        const subResult = await this.syncSubscription(userId, panelUser, input.importRecordId ?? null);
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
    // Priority 1: reiwa_id in description
    const reiwaIdMatch = panelUser.description?.match(REIWA_ID_REGEX);
    if (reiwaIdMatch) {
      const reiwaId = reiwaIdMatch[1];
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

    const newUser = await this.prismaService.user.create({
      data: {
        telegramId: panelUser.telegramId !== null ? BigInt(panelUser.telegramId) : null,
        username: panelUser.username || null,
        email: panelUser.email || null,
        name: panelUser.username || panelUser.uuid.slice(0, 8),
      },
    });
    return newUser.id;
  }

  private async updateUserFields(userId: string, panelUser: RemnawavePanelUser): Promise<void> {
    const data: Prisma.UserUpdateInput = {};
    if (panelUser.username) data.username = panelUser.username;
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
   */
  private async syncSubscription(
    userId: string,
    panelUser: RemnawavePanelUser,
    importRecordId: string | null,
  ): Promise<'created' | 'updated' | 'skipped'> {
    // Is any local row ALREADY this panel profile? Asked over every sound
    // spelling of the profile's identity — see `panelProfileClaims`. Oldest
    // first, so that on a database that already carries the duplicates this
    // defect produced the importer converges on the ORIGINAL row rather than
    // alternating between it and its duplicate from run to run.
    const existing = await this.prismaService.subscription.findFirst({
      where: { OR: panelProfileClaims(panelUser) },
      orderBy: { createdAt: 'asc' },
      select: { id: true, userId: true, planSnapshot: true },
    });

    const status = this.mapStatus(panelUser.status);
    // Panel bytes → our whole-GB column, through the one converter every
    // writer of this column shares. A positive cap never rounds down to `0`,
    // because `0` here means zero gigabytes, not unlimited — this line used
    // to lack that floor and disagreed with the webhook mirror on 0.4 GB.
    const trafficLimitGb = panelTrafficLimitToGb(panelUser.trafficLimitBytes);
    const expiresAt = panelUser.expireAt ? new Date(panelUser.expireAt) : null;
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
      expiresAt,
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
      // Update existing subscription
      await this.prismaService.subscription.update({
        where: { id: existing.id },
        data: subscriptionData,
      });
      // If subscription belongs to a different user (edge case: user was re-matched)
      if (existing.userId !== userId) {
        await this.prismaService.subscription.update({
          where: { id: existing.id },
          data: { user: { connect: { id: userId } } },
        });
      }
      return 'updated';
    }

    // Create new subscription
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
    if (REIWA_ID_REGEX.test(currentDescription)) {
      // Already has reiwa_id — nothing to do
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
