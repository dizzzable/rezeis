/**
 * reimport-plan-snapshot.util
 * ───────────────────────────
 * The `planSnapshot` an importer (Altshop, Remnashop, STEALTHNET, Bedolaga,
 * 3x-ui) writes: onto a new subscription, and onto one a previous run — or the
 * panel since — already shaped.
 */
import type { Prisma } from '@prisma/client';

import { readBulkAssignmentSnapshot } from '../services/bulk-plan-assignment.service';
import type { ImportDomainSnapshotFacts } from './import-domain-snapshot.util';

/** What a backup states about one subscription, split by who owns each key. */
export interface DonorSnapshotFacts {
  /**
   * The import domain's own keys — `importedFrom`, `importRecordId`,
   * `sourceSubscriptionId`, `originalPlanSnapshot`, … — refreshed from the
   * backup on every run. Typed by `IMPORT_DOMAIN_SNAPSHOT_KEYS`: a key missing
   * from that list is one the plan writers would drop, so it does not compile.
   */
  readonly own: ImportDomainSnapshotFacts;
  /**
   * Donor facts under names a plan snapshot uses too: `tag` and
   * `trafficLimitStrategy`, which the panel push reads from the snapshot, and
   * STEALTHNET's `currency`, which a payment writes there. The donor's to
   * state only while the snapshot names no plan.
   */
  readonly planFacts?: Prisma.InputJsonObject;
}

/**
 * The snapshot to write: the STORED one, with the backup's facts merged in.
 *
 * MERGED INTO, never rebuilt — the Remnawave importer's rule. Prisma writes a
 * `Json` column wholesale, and these importers used to build the document from
 * donor facts alone and carry `planId` across (STEALTHNET and 3x-ui not even
 * that). A re-import therefore dropped every key the row had gained since the
 * first one: the plan an operator assigned (`id`, `name`, the limits, the
 * squads — «Назначить план», «Назначить план импортированным», the plan
 * cloner), the duration autopay renews by (`selectedDurationDays`) and the
 * payment's own keys. The customer's plan name vanished from the cabinet, the
 * bot and invoices, and the limits read UNDECIDABLE at the next renewal.
 *
 *  - Keys the backup does not state are kept, whoever wrote them.
 *  - `own` is written over the stored values.
 *  - `planFacts` are written only while the stored snapshot names no plan
 *    (`id` or `planId`, the test «Назначить план импортированным» reads —
 *    {@link readBulkAssignmentSnapshot}). On a row on a plan they are the
 *    plan's, and a donor's reset strategy or tag written over them would be
 *    pushed to the panel.
 *
 * A re-import never moves a row onto another plan. No backup names a plan of
 * this panel: the donor's own is `originalPlanSnapshot`, and the one link to a
 * local plan is the stored `id` / `planId`, which is kept. So a row stays on
 * its plan, with its term — which is why nothing here rotates one. (A customer
 * who switched plans in the donor bot between two backups stays on the plan
 * this panel gave them: the owner's decision of 24.09.2026.)
 *
 * With no stored snapshot (a new row) this is the backup's facts alone.
 */
export function reimportPlanSnapshot(
  stored: Prisma.JsonValue | undefined,
  donor: DonorSnapshotFacts,
): Prisma.InputJsonObject {
  const base: Prisma.JsonObject =
    typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored : {};
  const onPlan = readBulkAssignmentSnapshot(base) === 'ALREADY_ASSIGNED';
  return {
    ...(base as Prisma.InputJsonObject),
    ...(onPlan ? {} : donor.planFacts),
    ...(donor.own as Prisma.InputJsonObject),
  };
}
