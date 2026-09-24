import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';

/**
 * GIVES BACK THE PLAN'S NAME TO SUBSCRIPTIONS AN EARLIER BACKUP RE-IMPORT
 * STRIPPED — once, automatically (the owner's decision of 24.09.2026).
 *
 * Until this patch a re-import of an Altshop, Remnashop or Bedolaga backup
 * rebuilt the snapshot of every subscription it found from donor facts and
 * carried `planId` alone across. A subscription the plan cloner or «Назначить
 * план импортированным» had linked to a plan came out with `planId` and no
 * `id` and no `name`: no plan name in the cabinet, in the bot or on an invoice,
 * and «Назначить план импортированным» skips it as already assigned. The
 * importers merge now (`reimportPlanSnapshot`); this repairs what they left.
 *
 * ── What it writes ─────────────────────────────────────────────────────────
 *
 * On a row whose snapshot names a plan by `planId` and not by `id`, from that
 * plan: `id`, `name`, `type`, `icon` — the plan's identity and what the
 * cabinet, the bot and the invoices show. Every other key stays as it is.
 *
 * NOT `tag`, `trafficLimitStrategy`, squads or limits: the profile-sync push
 * reads the first two from the snapshot and sends them to Remnawave, and the
 * limit keys are the baseline the renewal's override test compares the
 * columns with. A repair of presentation must not change what a customer is
 * served. (From here on the row names its plan by `id`, so a later edit of
 * that plan mirrors its tag and strategy into it — `PlanSnapshotSyncService`,
 * as for every subscription on a plan, and as for this one before the
 * re-import stripped it. The repair itself writes neither.)
 *
 * Skipped: a row whose plan is gone — no such plan, or a deleted one (gone for
 * the operator too: «Назначить план» refuses it).
 *
 * ── Where and when it runs, and why there ──────────────────────────────────
 *
 * At boot, in the process that runs scheduled work (`shouldRunSchedules`:
 * the worker, or the one container of a small install), not awaited — boot
 * never waits on the database. One statement:
 *
 *  - SAFE TO RUN TWICE. It selects only rows that name a plan by `planId` and
 *    not by `id`, and every row it repairs gains `id`. A second boot, a second
 *    worker or a blue/green twin finds nothing; two running at once serialise
 *    on the row locks, and the second re-reads the row and skips it.
 *  - ONCE, in effect. No writer strips a snapshot any more, so after the first
 *    pass the statement matches nothing and costs one scan per boot. That is
 *    why no "done" marker is kept: a marker would only add a way for the pass
 *    to be skipped while there is still something to repair.
 *  - Not a schema migration: the rule is the import domain's, it is tested
 *    with the importers, and it needs no deploy ordering.
 *  - Not inside a re-import: the rows it repairs are the ones nobody imports
 *    again.
 */
@Injectable()
export class StrippedPlanSnapshotRepairService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StrippedPlanSnapshotRepairService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  public onApplicationBootstrap(): void {
    if (!shouldRunSchedules()) return;
    // Not awaited, deliberately: see the class note.
    void this.restoreStrippedPlanSnapshots()
      .then((restored) => {
        if (restored > 0) {
          this.logger.log(
            `Restored the plan's id, name, type and icon on ${restored} subscription(s) an earlier backup re-import had stripped to planId`,
          );
        }
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `Plan snapshot repair skipped at boot; the next boot retries: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  /**
   * The repair itself. Returns how many subscriptions it restored — `0` on a
   * second run.
   */
  public async restoreStrippedPlanSnapshots(): Promise<number> {
    return this.prismaService.$executeRaw(Prisma.sql`
      UPDATE "subscriptions" AS s
      SET "plan_snapshot" = s."plan_snapshot" || jsonb_build_object(
            'id', p."id",
            'name', p."name",
            'type', p."type"::text,
            'icon', p."icon"
          ),
          "updated_at" = NOW()
      FROM "plans" AS p
      WHERE jsonb_typeof(s."plan_snapshot") = 'object'
        AND COALESCE(s."plan_snapshot"->>'id', '') = ''
        AND p."id" = s."plan_snapshot"->>'planId'
        AND p."deleted_at" IS NULL
    `);
  }
}
