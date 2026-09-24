import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { DECIMAL_PANEL_ID_PATTERN, UNLINKED_SUBSCRIPTIONS_PATH } from './stale-panel-link';

/**
 * The `reason` the boot count's card is raised under, which picks its header
 * (`EVENT_PRESENTATION['system.remnawave_sync'].variants`).
 */
export const STALE_PANEL_IDENTITY_CENSUS_REASON = 'stale_panel_identities';

/**
 * StalePanelIdentityCensus
 * ════════════════════════
 * At boot, counts the live subscriptions whose stored Remnawave identity is not
 * a decimal — the rows every destructive panel path refuses
 * (`isStalePanelIdentity`, `stale-panel-link.ts`) — and says so, out loud, while
 * there are any.
 *
 * WHY A COUNT AND NOT A REPAIR. Remnawave 2.x support is gone, and a row linked
 * on a 2.x panel keeps its uuid: nothing may rewrite it without proving whose
 * profile the new id is. The automatic panel-link check does exactly that, for
 * the rows it can prove, and lists the rest in «Подписки» → «Инструменты». This
 * count is the net under it: it asks nothing of the panel, needs no proof, and
 * tells the operator how many rows are still refused and where they are.
 *
 * ONE TEST, SPELLED ONCE. The SQL filter is {@link DECIMAL_PANEL_ID_PATTERN}, the
 * same pattern the per-row refusals test in code, so the count and the refusals
 * describe one set of rows: a uuid, an empty string and imported junk all count;
 * a decimal never does.
 *
 * WHERE AND WHEN. Worker (or single-container) only — `shouldRunSchedules()`,
 * the same rule every `@Cron` job here follows, so a split deployment counts
 * once, not twice. Not awaited: boot does not wait on a COUNT, and a database
 * that cannot answer yet costs a warning, never a failed start. Repeated on
 * every boot while the count is above zero — one COUNT per deploy, loud until
 * the population is gone.
 */
@Injectable()
export class StalePanelIdentityCensus implements OnApplicationBootstrap {
  private readonly logger = new Logger(StalePanelIdentityCensus.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly events: SystemEventsService,
  ) {}

  public onApplicationBootstrap(): void {
    if (!shouldRunSchedules()) return;
    // Not awaited, deliberately: see the class note. `run` never throws.
    void this.run();
  }

  /**
   * Counts and reports. Returns the count, or `null` when it could not be
   * taken. Never throws: a count that fails is a warning in the log, not a
   * second way for a process to fail.
   */
  public async run(): Promise<number | null> {
    let count: number;
    try {
      const rows = await this.prismaService.$queryRaw<Array<{ readonly stale: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS "stale"
        FROM "subscriptions"
        WHERE "status" <> 'DELETED'
          AND "remnawave_id" IS NOT NULL
          AND "remnawave_id" !~ ${DECIMAL_PANEL_ID_PATTERN}
      `);
      count = Number(rows[0]?.stale ?? 0);
    } catch (error: unknown) {
      this.logger.warn(
        `Could not count subscriptions with a non-numeric Remnawave identity: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
    if (count === 0) return 0;

    const message =
      `${count} live subscription(s) still store a Remnawave identity that is not a 3.x numeric ` +
      'id (a 2.x uuid, or imported junk). Deleting their profile, their devices or rotating ' +
      'their link is refused until they are linked to a numeric id.';
    this.logger.error(message);
    try {
      this.events.error(EVENT_TYPES.SYSTEM_REMNAWAVE_SYNC, 'SYSTEM', message, {
        subscriptions: count,
        reason: STALE_PANEL_IDENTITY_CENSUS_REASON,
        why:
          `Подписок, у которых сохранён нечисловой идентификатор Remnawave (так их выдавала панель ` +
          `2.x): ${count}. Панель 3.x по такому идентификатору профиль не находит, поэтому для этих ` +
          'подписок не выполняются удаление профиля, удаление устройств и перевыпуск ссылки.',
        nextSteps:
          'Автоматическая проверка привязки сама привязывает такие подписки, когда может доказать ' +
          `владельца. Остальные — в ${UNLINKED_SUBSCRIPTIONS_PATH}: у каждой нажмите «Привязать ` +
          'профиль». Оповещение повторяется при каждом запуске панели, пока такие подписки есть.',
      });
    } catch (error: unknown) {
      this.logger.warn(
        `Could not publish the non-numeric Remnawave identity count: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return count;
  }
}
