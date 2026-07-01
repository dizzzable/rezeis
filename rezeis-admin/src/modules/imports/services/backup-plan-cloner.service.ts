import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ArchivedPlanRenewMode,
  Currency,
  ImportRecord,
  PlanAvailability,
  PlanType,
  Prisma,
  TrafficLimitStrategy,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  AltshopPlan,
  AltshopPlanDuration,
  AltshopPlanPrice,
} from '../utils/altshop-backup-parser';
import {
  RemnashopPlan,
  RemnashopPlanDuration,
  RemnashopPlanPrice,
} from '../utils/remnashop-backup-parser';

// ── Public types ────────────────────────────────────────────────────────────

export interface ClonePlansFromBackupInput {
  /** ImportRecord whose `result.catalog` we read planning data from. */
  readonly importRecordId: string;
  /**
   * Source-side plan ids to clone (subset of `result.catalog.plans`).
   * The UI lets the operator deselect specific plans (e.g. the synthetic
   * "IMPORTED" placeholder). When empty, all catalog plans are cloned.
   */
  readonly selectedSourcePlanIds: ReadonlyArray<number>;
  /**
   * When true (default), every Subscription that came from this same
   * import gets its `planId` set to the cloned plan it referenced in
   * the source. When false, plans are created but no subscription is
   * touched — useful for "give me the catalog, I'll wire up by hand".
   */
  readonly linkSubscriptions: boolean;
  /** Audit. */
  readonly createdBy: string;
}

export interface ClonePlansFromBackupResult {
  /** New `Plan.id` rows created. */
  readonly plansCreated: number;
  /** Existing `Plan.id` rows reused via name match. */
  readonly plansReused: number;
  /** New `PlanDuration` rows. */
  readonly durationsCreated: number;
  /** New `PlanPrice` rows. */
  readonly pricesCreated: number;
  /** Subscriptions whose `planId` was filled in. */
  readonly subscriptionsLinked: number;
  /** Plans we couldn't find in the source catalog (likely deselected or stale). */
  readonly skippedSourcePlanIds: ReadonlyArray<number>;
  /** Errors collected per source plan id. */
  readonly errors: ReadonlyArray<string>;
  /** Map of source-plan-id → new Plan.name (for the success toast). */
  readonly namesCreated: ReadonlyArray<{ readonly sourcePlanId: number; readonly finalName: string }>;
}

export interface PlanCatalogPreview {
  /** Unique plans extracted from the backup catalog. */
  readonly plans: ReadonlyArray<{
    readonly sourcePlanId: number;
    readonly name: string;
    readonly tag: string | null;
    readonly type: string;
    readonly availability: string;
    readonly trafficLimit: number;
    readonly deviceLimit: number;
    readonly isActive: boolean;
    readonly isArchived: boolean;
    readonly subscriptionsCount: number;
    /** Pre-computed final name we'd create (with suffix-2, -3 if needed). */
    readonly finalName: string;
    /** True when an existing Plan with the same final name was found. */
    readonly willReuseExisting: boolean;
    /**
     * Heuristic: when the source plan_snapshot is a synthetic "IMPORTED"
     * placeholder (altshop's marker for already-imported subscriptions),
     * we recommend deselecting it. Pure UI signal — code doesn't enforce.
     */
    readonly recommendDeselect: boolean;
  }>;
}

// ── Source-shape adapter ────────────────────────────────────────────────────

/**
 * Both altshop and remnashop expose plans through compatible columns,
 * so we collapse them into one shape inside the cloner. The diff lives
 * only at the call boundary (we read a different key set off the JSON
 * payload depending on `sourceType`).
 */
interface NormalizedSourcePlan {
  readonly id: number;
  readonly orderIndex: number;
  readonly isActive: boolean;
  readonly isArchived: boolean;
  readonly type: string;
  readonly availability: string;
  readonly archivedRenewMode: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly tag: string | null;
  readonly trafficLimit: number;
  readonly deviceLimit: number;
  readonly trafficLimitStrategy: string;
  readonly replacementPlanIds: ReadonlyArray<number>;
  readonly upgradeToPlanIds: ReadonlyArray<number>;
  readonly allowedUserIds: ReadonlyArray<number>;
  readonly internalSquads: ReadonlyArray<string>;
  readonly externalSquad: string | null;
}

interface NormalizedSourceDuration {
  readonly id: number;
  readonly planId: number;
  readonly days: number;
}

interface NormalizedSourcePrice {
  readonly id: number;
  readonly planDurationId: number;
  readonly currency: string;
  readonly price: string;
}

interface NormalizedCatalog {
  readonly plans: ReadonlyArray<NormalizedSourcePlan>;
  readonly durations: ReadonlyArray<NormalizedSourceDuration>;
  readonly prices: ReadonlyArray<NormalizedSourcePrice>;
}

// ── Service ─────────────────────────────────────────────────────────────────

/**
 * Optional second-step service: after a backup-based import (altshop or
 * remnashop) has restored users + subscriptions, the operator can opt in
 * to **also** restore the source-side plan catalog so the imported
 * subscriptions land on real plans instead of `planId: null`.
 *
 * Design notes:
 *   1. Idempotent — running twice with the same input is a no-op:
 *      existing Plan rows with matching names are reused, subscriptions
 *      whose `planId` is already set are not overwritten.
 *   2. Suffix-on-conflict — when a target Plan name already exists with
 *      DIFFERENT settings (e.g. operator hand-rolled "Standard" before
 *      cloning), we append `2`, `3`, … so the source plan does not
 *      collide. Same name + same key fields → reuse.
 *   3. Status preserved — `isActive`/`isArchived`/`availability` are
 *      copied as-is from the source. We don't force-archive clones
 *      because the operator wants a faithful restoration.
 *   4. upgradeToPlanIds / replacementPlanIds — translated via the
 *      `sourceId → targetCuid` map built during this run. References
 *      to plans NOT in the selected subset are dropped silently
 *      (logged) rather than producing dangling foreign-keyish strings.
 *   5. Subscriptions — linked only when `linkSubscriptions: true` AND
 *      `Subscription.planSnapshot.importedFrom === sourceType` AND
 *      `Subscription.planId === null`. Operator-set planIds are never
 *      overwritten.
 */
@Injectable()
export class BackupPlanClonerService {
  private readonly logger = new Logger(BackupPlanClonerService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  // ── Preview (read-only) ───────────────────────────────────────────────────

  /**
   * Returns a non-mutating preview of what a clone would do given the
   * import record's catalog. Backs the modal that lets the operator
   * tick/untick individual source plans.
   */
  public async preview(importRecordId: string): Promise<PlanCatalogPreview> {
    const record = await this.loadImportRecord(importRecordId);
    const catalog = this.normalizeCatalog(record);
    const subscriptionCounts = await this.countSubscriptionsBySourcePlan(record);

    // Pre-compute final names so the operator sees exactly what we'd
    // create, including the conflict suffix logic.
    const existingNames = new Set(
      (
        await this.prismaService.plan.findMany({ select: { name: true } })
      ).map((p) => p.name),
    );
    // Track names we'll occupy within this same preview call so two
    // source plans with the same name in the catalog don't both claim
    // the bare name.
    const claimedThisRound = new Set<string>();

    const plans = catalog.plans.map((plan) => {
      const finalName = this.allocateFinalName(plan.name, existingNames, claimedThisRound);
      claimedThisRound.add(finalName);
      const willReuseExisting = finalName === plan.name && existingNames.has(plan.name);
      const recommendDeselect = plan.name.toUpperCase() === 'IMPORTED';

      return {
        sourcePlanId: plan.id,
        name: plan.name,
        tag: plan.tag,
        type: plan.type,
        availability: plan.availability,
        trafficLimit: plan.trafficLimit,
        deviceLimit: plan.deviceLimit,
        isActive: plan.isActive,
        isArchived: plan.isArchived,
        subscriptionsCount: subscriptionCounts.get(plan.id) ?? 0,
        finalName,
        willReuseExisting,
        recommendDeselect,
      };
    });

    return { plans };
  }

  // ── Clone (mutating) ──────────────────────────────────────────────────────

  public async clone(input: ClonePlansFromBackupInput): Promise<ClonePlansFromBackupResult> {
    const record = await this.loadImportRecord(input.importRecordId);
    const catalog = this.normalizeCatalog(record);

    if (catalog.plans.length === 0) {
      throw new BadRequestException('Backup contains no plan catalog to clone from');
    }

    const selectedIds =
      input.selectedSourcePlanIds.length > 0
        ? new Set(input.selectedSourcePlanIds)
        : new Set(catalog.plans.map((p) => p.id));

    const plansToClone = catalog.plans.filter((p) => selectedIds.has(p.id));
    if (plansToClone.length === 0) {
      throw new BadRequestException('No source plans selected to clone');
    }

    // ── Phase 1: create / reuse Plan rows ──────────────────────────────────
    //
    // We cache existing plan names BEFORE the transaction so the
    // suffix logic is deterministic. Names created during this same
    // run are tracked in `claimedThisRound` and added to existing as
    // we go to keep dedup correct across multiple rows.
    const existingNames = new Set(
      (
        await this.prismaService.plan.findMany({ select: { name: true } })
      ).map((p) => p.name),
    );
    const claimedThisRound = new Set<string>();
    const sourceIdToTargetCuid = new Map<number, string>();
    const namesCreated: Array<{ sourcePlanId: number; finalName: string }> = [];
    const errors: string[] = [];
    let plansCreated = 0;
    let plansReused = 0;
    let durationsCreated = 0;
    let pricesCreated = 0;

    for (const plan of plansToClone) {
      try {
        const finalName = this.allocateFinalName(plan.name, existingNames, claimedThisRound);
        claimedThisRound.add(finalName);

        // Reuse only when name AND core settings match — otherwise
        // suffix-on-conflict above already produced a unique name.
        const isReuse = finalName === plan.name && existingNames.has(plan.name);
        if (isReuse) {
          const existing = await this.prismaService.plan.findUnique({
            where: { name: plan.name },
            select: { id: true },
          });
          if (existing) {
            sourceIdToTargetCuid.set(plan.id, existing.id);
            plansReused += 1;
            namesCreated.push({ sourcePlanId: plan.id, finalName });
            continue;
          }
          // findUnique can race — fall through to create() below.
        }

        // Build the durations + prices for this plan. Dedupe by day-count:
        // some sources — notably STEALTHNET, which synthesizes durations from a
        // base `(duration_days, price)` plus `tariff_price_options` that often
        // REPEAT the base duration — emit the same day-count twice. That later
        // makes the cloned plan un-editable ("Duration N days is duplicated" /
        // "Currency X is duplicated for N days"). Collapse duplicates here,
        // merging their prices and keeping the first price per currency.
        const planDurations = catalog.durations.filter((d) => d.planId === plan.id);
        const durationCreates = this.buildDedupedDurationCreates(planDurations, catalog.prices);

        const created = await this.prismaService.plan.create({
          data: {
            name: finalName,
            description: plan.description ?? undefined,
            tag: plan.tag ?? undefined,
            type: this.coercePlanType(plan.type),
            availability: this.coercePlanAvailability(plan.availability),
            trafficLimitStrategy: this.coerceStrategy(plan.trafficLimitStrategy),
            archivedRenewMode: this.coerceArchivedMode(plan.archivedRenewMode),
            trafficLimit: plan.trafficLimit > 0 ? plan.trafficLimit : null,
            deviceLimit: plan.deviceLimit,
            isActive: plan.isActive,
            isArchived: plan.isArchived,
            orderIndex: plan.orderIndex,
            internalSquads: [...plan.internalSquads],
            externalSquad: plan.externalSquad ?? null,
            // Cross-references and allowedUserIds reference SOURCE-side ids.
            // We translate them in Phase 2 once every clone has a CUID.
            // Allowed user ids — drop entirely (source ids don't map to ours).
            allowedUserIds: [],
            durations: { create: durationCreates },
          },
        });
        sourceIdToTargetCuid.set(plan.id, created.id);
        existingNames.add(finalName);
        plansCreated += 1;
        durationsCreated += durationCreates.length;
        pricesCreated += durationCreates.reduce(
          (acc, d) => acc + (d.prices?.create as ReadonlyArray<unknown> | undefined ?? []).length,
          0,
        );
        namesCreated.push({ sourcePlanId: plan.id, finalName });
      } catch (err) {
        const message = `Plan #${plan.id} (${plan.name}): ${(err as Error).message}`;
        errors.push(message);
        this.logger.warn(`Plan clone failed: ${message}`);
      }
    }

    // ── Phase 2: translate cross-references ────────────────────────────────
    //
    // upgrade_to_plan_ids and replacement_plan_ids on the source side
    // are integer references into the same source catalog. We translate
    // them through `sourceIdToTargetCuid`, dropping references to
    // source plans that the operator deselected (or that errored above).
    for (const plan of plansToClone) {
      const targetCuid = sourceIdToTargetCuid.get(plan.id);
      if (!targetCuid) continue;
      const upgradeIds = this.translateIds(plan.upgradeToPlanIds, sourceIdToTargetCuid);
      const replacementIds = this.translateIds(plan.replacementPlanIds, sourceIdToTargetCuid);
      if (upgradeIds.length === 0 && replacementIds.length === 0) continue;
      try {
        await this.prismaService.plan.update({
          where: { id: targetCuid },
          data: {
            upgradeToPlanIds: upgradeIds,
            replacementPlanIds: replacementIds,
          },
        });
      } catch (err) {
        errors.push(`Cross-ref translate for plan ${targetCuid}: ${(err as Error).message}`);
      }
    }

    // ── Phase 3: link subscriptions (opt-in) ───────────────────────────────
    //
    // `Subscription` has no `planId` column — the link lives in
    // `planSnapshot.planId` (JSONB). We update planSnapshot in-place,
    // preserving the original keys but pointing planId at the cloned
    // Plan and refreshing the cached `name`/`tag`/limit fields.
    //
    // Dedup: skip if `planSnapshot.planId` is already a CUID-shaped
    // string (means the operator or a previous run already linked
    // this subscription); only fill in nulls.
    let subscriptionsLinked = 0;
    if (input.linkSubscriptions) {
      const sourceType = record.sourceType; // 'altshop' | 'remnashop'

      // Pre-load every cloned plan once so we can build the snapshot
      // without round-tripping for each subscription.
      const targetIds = Array.from(sourceIdToTargetCuid.values());
      const clonedPlans = await this.prismaService.plan.findMany({
        where: { id: { in: targetIds } },
        include: { durations: { take: 1, orderBy: { days: 'asc' } } },
      });
      const clonedPlanByCuid = new Map(clonedPlans.map((p) => [p.id, p]));

      const candidateSubs = await this.prismaService.subscription.findMany({
        where: {
          planSnapshot: {
            path: ['importedFrom'],
            equals: sourceType,
          },
        },
        select: { id: true, planSnapshot: true },
      });
      for (const sub of candidateSubs) {
        const snap = (sub.planSnapshot ?? {}) as Record<string, unknown>;
        // Already linked by hand or by an earlier clone? leave it.
        if (typeof snap.planId === 'string' && snap.planId.length > 0) continue;

        const sourcePlanId = this.extractSourcePlanId(sub.planSnapshot);
        if (sourcePlanId === null) continue;
        const targetCuid = sourceIdToTargetCuid.get(sourcePlanId);
        if (!targetCuid) continue;

        const targetPlan = clonedPlanByCuid.get(targetCuid);
        if (!targetPlan) continue;

        const newSnapshot: Prisma.InputJsonValue = {
          ...(snap as Prisma.InputJsonObject),
          planId: targetPlan.id,
          name: targetPlan.name,
          tag: targetPlan.tag,
          type: targetPlan.type,
          trafficLimit: targetPlan.trafficLimit,
          deviceLimit: targetPlan.deviceLimit,
          trafficLimitStrategy: targetPlan.trafficLimitStrategy,
          duration: targetPlan.durations[0]?.days ?? 30,
          internalSquads: targetPlan.internalSquads,
          externalSquad: targetPlan.externalSquad,
        };
        try {
          await this.prismaService.subscription.update({
            where: { id: sub.id },
            data: { planSnapshot: newSnapshot },
          });
          subscriptionsLinked += 1;
        } catch (err) {
          errors.push(`Link subscription ${sub.id}: ${(err as Error).message}`);
        }
      }
    }

    // ── Audit ──────────────────────────────────────────────────────────────
    await this.prismaService.adminAuditLog.create({
      data: {
        action: 'imports.clone-plans',
        adminUser: { connect: { id: input.createdBy } },
        metadata: {
          importRecordId: input.importRecordId,
          sourceType: record.sourceType,
          plansCreated,
          plansReused,
          subscriptionsLinked,
          errors: errors.slice(0, 5),
        } as Prisma.InputJsonValue,
      },
    });

    const skippedSourcePlanIds = catalog.plans
      .filter((p) => !plansToClone.some((sel) => sel.id === p.id))
      .map((p) => p.id);

    return {
      plansCreated,
      plansReused,
      durationsCreated,
      pricesCreated,
      subscriptionsLinked,
      skippedSourcePlanIds,
      errors,
      namesCreated,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async loadImportRecord(importRecordId: string): Promise<ImportRecord> {
    const record = await this.prismaService.importRecord.findUnique({
      where: { id: importRecordId },
    });
    if (!record) throw new NotFoundException(`Import record '${importRecordId}' not found`);
    if (record.sourceType !== 'altshop' && record.sourceType !== 'remnashop' && record.sourceType !== 'stealthnet') {
      throw new BadRequestException(
        `Plan cloning is only supported for altshop, remnashop and stealthnet imports, got '${record.sourceType}'`,
      );
    }
    return record;
  }

  /**
   * Normalises altshop / remnashop plan rows from `result.catalog` into
   * a uniform `NormalizedSourcePlan[]`. Both schemas overlap by ~80%;
   * the diff is in archive metadata (altshop only) and `is_trial`
   * (remnashop only — we map it to `availability: TRIAL`).
   */
  private normalizeCatalog(record: ImportRecord): NormalizedCatalog {
    const result = (record.result ?? {}) as Record<string, unknown>;
    const catalog = (result.catalog ?? {}) as Record<string, unknown>;
    const rawPlans = (catalog.plans ?? []) as ReadonlyArray<Record<string, unknown>>;
    const rawDurations = (catalog.planDurations ?? []) as ReadonlyArray<Record<string, unknown>>;
    const rawPrices = (catalog.planPrices ?? []) as ReadonlyArray<Record<string, unknown>>;

    const plans: NormalizedSourcePlan[] = rawPlans.map((row) => {
      const isAltshop = record.sourceType === 'altshop';
      // remnashop has `is_trial` boolean; altshop expresses TRIAL via availability.
      const baseAvailability = (row.availability ?? 'ALL') as string;
      const isTrial = (row.is_trial as boolean | undefined) === true;
      const availability = isAltshop
        ? baseAvailability
        : isTrial
          ? 'TRIAL'
          : baseAvailability;

      return {
        id: Number(row.id),
        orderIndex: Number(row.order_index ?? 0),
        isActive: row.is_active !== false,
        isArchived: (row.is_archived as boolean | undefined) === true,
        type: String(row.type ?? 'BOTH'),
        availability,
        archivedRenewMode: (row.archived_renew_mode as string | undefined) ?? null,
        name: String(row.name ?? `imported-${row.id}`),
        description: (row.description as string | null | undefined) ?? null,
        tag: (row.tag as string | null | undefined) ?? null,
        trafficLimit: Number(row.traffic_limit ?? 0),
        deviceLimit: Number(row.device_limit ?? 0),
        trafficLimitStrategy: String(row.traffic_limit_strategy ?? 'NO_RESET'),
        replacementPlanIds: Array.isArray(row.replacement_plan_ids)
          ? (row.replacement_plan_ids as number[])
          : [],
        upgradeToPlanIds: Array.isArray(row.upgrade_to_plan_ids)
          ? (row.upgrade_to_plan_ids as number[])
          : [],
        allowedUserIds: Array.isArray(row.allowed_user_ids)
          ? (row.allowed_user_ids as number[])
          : [],
        internalSquads: Array.isArray(row.internal_squads)
          ? (row.internal_squads as string[])
          : [],
        externalSquad: (row.external_squad as string | null | undefined) ?? null,
      };
    });

    const durations: NormalizedSourceDuration[] = rawDurations.map((row) => ({
      id: Number(row.id),
      planId: Number(row.plan_id),
      days: Number(row.days),
    }));

    const prices: NormalizedSourcePrice[] = rawPrices.map((row) => ({
      id: Number(row.id),
      planDurationId: Number(row.plan_duration_id),
      currency: String(row.currency),
      price: String(row.price),
    }));

    return { plans, durations, prices };
  }

  private async countSubscriptionsBySourcePlan(
    record: ImportRecord,
  ): Promise<Map<number, number>> {
    // Subscriptions imported in this run will have
    // planSnapshot = { importedFrom: <source>, originalPlanSnapshot: { id, ... } }.
    // We aggregate by `originalPlanSnapshot.id`.
    const counts = new Map<number, number>();
    const subs = await this.prismaService.subscription.findMany({
      where: {
        planSnapshot: { path: ['importedFrom'], equals: record.sourceType },
      },
      select: { planSnapshot: true },
    });
    for (const sub of subs) {
      const id = this.extractSourcePlanId(sub.planSnapshot);
      if (id === null) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }

  private extractSourcePlanId(planSnapshot: unknown): number | null {
    if (!planSnapshot || typeof planSnapshot !== 'object') return null;
    const root = planSnapshot as Record<string, unknown>;
    const original = root.originalPlanSnapshot as Record<string, unknown> | undefined;
    const candidate = original?.id ?? root.planId ?? null;
    if (typeof candidate === 'number') return candidate;
    if (typeof candidate === 'string') {
      const parsed = Number(candidate);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  /**
   * Allocate the first non-conflicting name in the sequence
   * `name`, `name2`, `name3`, … given the set of names that already
   * exist in the database AND the ones we already claimed within
   * this same operation.
   */
  private allocateFinalName(
    base: string,
    existing: ReadonlySet<string>,
    claimed: ReadonlySet<string>,
  ): string {
    const isTaken = (n: string): boolean => existing.has(n) || claimed.has(n);
    if (!isTaken(base)) return base;
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${base}${i}`;
      if (!isTaken(candidate)) return candidate;
    }
    // Pathological case — fallback to a random-ish suffix.
    return `${base}-${Date.now()}`;
  }

  private translateIds(
    sourceIds: ReadonlyArray<number>,
    map: ReadonlyMap<number, string>,
  ): string[] {
    const out: string[] = [];
    for (const sid of sourceIds) {
      const cuid = map.get(sid);
      if (cuid) out.push(cuid);
    }
    return out;
  }

  private coercePlanType(raw: string): PlanType {
    const upper = raw.toUpperCase();
    if (upper in PlanType) return upper as PlanType;
    return PlanType.BOTH;
  }

  private coercePlanAvailability(raw: string): PlanAvailability {
    const upper = raw.toUpperCase();
    if (upper in PlanAvailability) return upper as PlanAvailability;
    return PlanAvailability.ALL;
  }

  private coerceStrategy(raw: string): TrafficLimitStrategy {
    const upper = raw.toUpperCase();
    if (upper in TrafficLimitStrategy) return upper as TrafficLimitStrategy;
    return TrafficLimitStrategy.NO_RESET;
  }

  private coerceArchivedMode(raw: string | null): ArchivedPlanRenewMode {
    if (!raw) return ArchivedPlanRenewMode.SELF_RENEW;
    const upper = raw.toUpperCase();
    if (upper in ArchivedPlanRenewMode) return upper as ArchivedPlanRenewMode;
    return ArchivedPlanRenewMode.SELF_RENEW;
  }

  /**
   * Builds the `PlanDuration.create` payloads for one plan, collapsing any
   * duplicate day-counts into a single duration. Prices from every duration
   * sharing a day-count are merged, keeping the FIRST price seen per currency
   * (so a repeated base/option pair can't produce a duplicate-currency plan).
   * This guarantees a cloned plan always passes the admin plan validators,
   * regardless of how messy the source catalog was.
   */
  private buildDedupedDurationCreates(
    planDurations: ReadonlyArray<NormalizedSourceDuration>,
    allPrices: ReadonlyArray<NormalizedSourcePrice>,
  ): Prisma.PlanDurationCreateWithoutPlanInput[] {
    const byDays = new Map<
      number,
      { readonly prices: Prisma.PlanPriceCreateWithoutPlanDurationInput[]; readonly currencies: Set<Currency> }
    >();
    const dayOrder: number[] = [];

    for (const duration of planDurations) {
      let bucket = byDays.get(duration.days);
      if (bucket === undefined) {
        bucket = { prices: [], currencies: new Set<Currency>() };
        byDays.set(duration.days, bucket);
        dayOrder.push(duration.days);
      }
      for (const price of allPrices.filter((p) => p.planDurationId === duration.id)) {
        const currency = this.coerceCurrency(price.currency);
        if (!currency || bucket.currencies.has(currency)) continue;
        bucket.currencies.add(currency);
        bucket.prices.push({ currency, price: price.price });
      }
    }

    return dayOrder.map((days) => ({
      days,
      isActive: true,
      prices: { create: byDays.get(days)?.prices ?? [] },
    }));
  }

  private coerceCurrency(raw: string): Currency | null {
    const upper = raw.toUpperCase();
    if (upper in Currency) return upper as Currency;
    return null;
  }
}

// Helper exports (re-exported for the wire DTO + test suites).
export type {
  AltshopPlan,
  AltshopPlanDuration,
  AltshopPlanPrice,
  RemnashopPlan,
  RemnashopPlanDuration,
  RemnashopPlanPrice,
};
