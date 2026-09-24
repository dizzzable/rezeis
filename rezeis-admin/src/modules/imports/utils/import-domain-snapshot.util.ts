/**
 * import-domain-snapshot.util
 * ───────────────────────────
 * The keys of a subscription's `planSnapshot` that belong to the IMPORT domain,
 * and the one rule for keeping them when a plan writer replaces the document.
 *
 * No imports but Prisma's types, on purpose: every writer of a plan snapshot —
 * «Назначить план», «Назначить план импортированным», and the payment path
 * next — can take it without dragging the importers' services along.
 */
import type { Prisma } from '@prisma/client';

/**
 * Written by the importers and by nothing else, into `planSnapshot`:
 *
 *  - which import made or last refreshed the row (`importedFrom`,
 *    `importRecordId`) — «Назначить план импортированным» and the post-import
 *    sync find a run's rows by the second, the plan cloner and the 3x-ui
 *    importer by the first;
 *  - the donor's own ids (`sourceSubscriptionId`, `sourceTariffId`,
 *    `originalPlanSnapshot`, `tariffName`, and 3x-ui's `email` / `subId` /
 *    `uuid`). `sourceSubscriptionId` is the ONLY key a re-import finds a row
 *    by on a panel that never issued the donor's identifiers: without it the
 *    re-import creates a second subscription for the customer, and a second
 *    Remnawave profile once «Синхронизировать с панелью после импорта» runs;
 *  - each importer's bookkeeping of donor facts that have no column here.
 *
 * NOT here, deliberately:
 *  - `planId`, the import domain's "linked to a plan of this panel" marker. It
 *    names a plan, so it follows the plan writer: {@link carryImportDomainKeys}
 *    keeps it in step with the new `id`, never at an old plan.
 *  - `tag`, `trafficLimitStrategy` and STEALTHNET's `currency`: donor facts
 *    under names a plan (or a payment) writes too. The profile-sync push reads
 *    `tag` and the strategy from the snapshot, so the plan's win
 *    (`reimportPlanSnapshot` writes the donor's only onto a row on no plan).
 *
 * `reimportPlanSnapshot`'s own keys are typed by this list, so an importer
 * that starts writing a new key does not compile until it is listed here — and
 * every plan writer carries it.
 */
export const IMPORT_DOMAIN_SNAPSHOT_KEYS = [
  // Every importer.
  'importedFrom',
  'importRecordId',
  // The backup importers: the donor's row and plan.
  'sourceSubscriptionId',
  'originalPlanSnapshot',
  // STEALTHNET and Bedolaga.
  'sourceTariffId',
  'tariffName',
  'backupExpireAt',
  // STEALTHNET.
  'durationDays',
  'extraDevices',
  'extraDevicesMonthlyPrice',
  // Bedolaga.
  'purchasedTrafficGb',
  'autopayEnabled',
  'backupTrafficUsedGb',
  // Altshop.
  'deviceType',
  // 3x-ui: its client and inbound. It finds its row by `importedFrom` alone.
  'email',
  'subId',
  'uuid',
  'inboundRemark',
  'inboundProtocol',
  'trafficResetDays',
] as const;

export type ImportDomainSnapshotKey = (typeof IMPORT_DOMAIN_SNAPSHOT_KEYS)[number];

/** An importer's own facts about one subscription: import-domain keys only. */
export type ImportDomainSnapshotFacts = {
  readonly [K in ImportDomainSnapshotKey]?: Prisma.InputJsonValue | null;
};

function jsonObjectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * `next` — the snapshot a PLAN writer builds from a plan and writes over the
 * whole column — with the import-domain keys of `stored` carried across.
 *
 * WHY. Prisma writes a `Json` column wholesale, and a plan writer's document is
 * built from the plan alone. «Назначить план» and «Назначить план
 * импортированным» used to drop every import key: on an installation the
 * customers were moved to from ANOTHER panel, the next import of the same
 * backup found the row by nothing (`sourceSubscriptionId` gone) and created a
 * second subscription — and a second profile once synced.
 *
 *  - A key `next` states itself is kept as `next` states it.
 *  - `planId`: set to `next.id` where `stored` carries one — the rule a plan
 *    migration follows (`buildMigratedPlanSnapshot`). Kept at an OLD plan it
 *    would count the row as still on that plan (the plan delete guard matches
 *    either key); dropped, a row the plan cloner linked would lose its "linked"
 *    marker.
 *  - Nothing else of `stored` survives: the plan's facts are `next`'s.
 *
 * A `next` that is not an object is returned as it is.
 */
export function carryImportDomainKeys(
  stored: Prisma.JsonValue | null | undefined,
  next: Prisma.InputJsonValue,
): Prisma.InputJsonValue {
  const base = jsonObjectOf(stored);
  const planned = jsonObjectOf(next);
  if (base === null || planned === null) return next;
  const carried: Record<string, unknown> = {};
  for (const key of IMPORT_DOMAIN_SNAPSHOT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(base, key) && !Object.prototype.hasOwnProperty.call(planned, key)) {
      carried[key] = base[key];
    }
  }
  const linked =
    typeof base['planId'] === 'string' &&
    typeof planned['id'] === 'string' &&
    !Object.prototype.hasOwnProperty.call(planned, 'planId');
  return {
    ...carried,
    ...planned,
    ...(linked ? { planId: planned['id'] } : {}),
  } as Prisma.InputJsonObject;
}
