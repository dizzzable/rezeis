import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { RemnawaveProfileFactsService } from '../../remnawave/services/remnawave-profile-facts.service';
import { readAddOnRolloutFlags } from '../add-on-rollout.config';
import { isRollingResetDay } from '../domain/reset-cycle-policy';
import {
  judgeResetSchedule,
  readResetObservations,
  type ResetScheduleMismatch,
  type ResetScheduleVerdict,
  type ScheduledStrategy,
} from '../switches/reset-schedule-check';
import { AddOnSwitchesService } from '../switches/add-on-switches.service';

/** Profiles read per strategy per check, so the check has something to judge. */
const SAMPLES_PER_STRATEGY = 2;

/** Rolling candidates looked at to find the few whose day was today or yesterday. */
const ROLLING_CANDIDATES = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Russian name of a strategy, as the plan editor shows it. */
const STRATEGY_LABEL: Readonly<Record<ScheduledStrategy, string>> = {
  DAY: 'Каждый день',
  WEEK: 'Каждую неделю',
  MONTH: 'Ежемесячно (по календарю, 1-го числа)',
  MONTH_ROLLING: 'Ежемесячно (по дате создания)',
};

/** `UTC+03:00`, `UTC−03:00`, `UTC+05:45`. */
export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? '−' : '+';
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const rest = String(absolute % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${rest}`;
}

/** `03:05 UTC` — the observed and the expected moments, in one unambiguous zone. */
function utcTime(iso: string): string {
  return `${iso.slice(11, 16)} UTC`;
}

/** One line per strategy: what Remnawave did, what the zone predicts, and the zone that would explain it. */
export function describeMismatch(mismatch: ResetScheduleMismatch, timeZone: string): string {
  return (
    `сброс «${STRATEGY_LABEL[mismatch.strategy]}» прошёл в ${utcTime(mismatch.observedAt)}, а по поясу ` +
    `«${timeZone}» ожидался в ${utcTime(mismatch.expectedAt)} — так сбрасывает Remnawave в поясе ` +
    `${formatUtcOffset(mismatch.impliedUtcOffsetMinutes)}`
  );
}

/**
 * THE DAILY CHECK OF REMNAWAVE'S RESET SCHEDULE — see
 * `switches/reset-schedule-check.ts` for the rule. Once a day, in the worker:
 * a few profiles of every strategy are read (so there is something to judge
 * even while webhooks are off — a scheduled reset sends none), their resets
 * stamped, the window judged, and ONE operator card raised when Remnawave's
 * resets disagree with «Часовой пояс Remnawave». The page shows the same
 * verdict beside the zone field (`AddOnSwitchesService.view`), judged afresh on
 * every visit, so a corrected zone clears it at once.
 */
@Injectable()
export class ResetScheduleCheckService {
  private readonly logger = new Logger(ResetScheduleCheckService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    /** Reads a sample profile and stamps it; without it only what is stamped is judged. */
    @Optional() private readonly profileFacts?: RemnawaveProfileFactsService,
    /** The daily card; `@Optional()` for the specs that build this by hand. */
    @Optional() private readonly systemEvents?: SystemEventsService,
    /** «Часовой пояс Remnawave». */
    @Optional() private readonly addOnSwitches?: AddOnSwitchesService,
  ) {}

  /** 04:37 UTC: hours away from the reset minutes of the common zones, never inside a run. */
  @Cron('37 4 * * *', { name: 'remnawave-reset-schedule-check' })
  public async daily(): Promise<void> {
    if (!shouldRunSchedules()) return;
    try {
      await this.runCheck(new Date());
    } catch (error: unknown) {
      this.logger.warn(
        `Remnawave reset-schedule check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  public async runCheck(now: Date = new Date()): Promise<ResetScheduleVerdict> {
    const flags = await readAddOnRolloutFlags(this.addOnSwitches);
    await this.sampleProfiles(now);
    const { observations, resetScoped } = await readResetObservations(this.prismaService, now);
    const verdict = judgeResetSchedule({ observations, timeZone: flags.remnawaveTimeZone, resetScoped, now });
    if (verdict.status === 'mismatch') this.raiseCard(verdict);
    return verdict;
  }

  /**
   * A couple of live profiles of every strategy, read now: a calendar
   * strategy's last run reset them all at once; a rolling profile only on its
   * own day, so only profiles whose day was today or yesterday are taken.
   */
  private async sampleProfiles(now: Date): Promise<void> {
    if (this.profileFacts === undefined) return;
    const ids: string[] = [];
    for (const strategy of ['DAY', 'WEEK', 'MONTH'] as const) {
      const rows = await this.prismaService.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT s."id"
        FROM "subscriptions" s
        WHERE s."status" IN ('ACTIVE', 'LIMITED')
          AND s."remnawave_id" IS NOT NULL
          AND s."plan_snapshot"->>'trafficLimitStrategy' = ${strategy}
        ORDER BY random()
        LIMIT ${SAMPLES_PER_STRATEGY}
      `);
      ids.push(...rows.map((row) => row.id));
    }
    const rolling = await this.prismaService.$queryRaw<Array<{ id: string; createdAt: Date }>>(Prisma.sql`
      SELECT s."id", s."remnawave_profile_created_at" AS "createdAt"
      FROM "subscriptions" s
      WHERE s."status" IN ('ACTIVE', 'LIMITED')
        AND s."remnawave_id" IS NOT NULL
        AND s."remnawave_profile_created_at" IS NOT NULL
        AND s."plan_snapshot"->>'trafficLimitStrategy' = 'MONTH_ROLLING'
        AND EXTRACT(DAY FROM s."remnawave_profile_created_at" AT TIME ZONE 'UTC')::int = ANY(${rollingAnchorDays(now)}::int[])
      ORDER BY random()
      LIMIT ${ROLLING_CANDIDATES}
    `);
    const recent = [now, new Date(now.getTime() - DAY_MS)];
    ids.push(
      ...rolling
        .filter((row) => recent.some((day) => isRollingResetDay(new Date(row.createdAt), day)))
        .slice(0, SAMPLES_PER_STRATEGY)
        .map((row) => row.id),
    );
    for (const id of ids) {
      await this.profileFacts.refreshProfileFacts(id, now);
    }
  }

  private raiseCard(verdict: ResetScheduleVerdict): void {
    const lines = verdict.mismatches.map((mismatch) => describeMismatch(mismatch, verdict.timeZone));
    this.logger.warn(
      `Remnawave resets disagree with «Часовой пояс Remnawave» (${verdict.timeZone}): ` +
        verdict.mismatches.map((mismatch) => `${mismatch.strategy} at ${mismatch.observedAt}`).join(', '),
    );
    this.systemEvents?.warn(
      EVENT_TYPES.SYSTEM_ERROR,
      'SYSTEM',
      `Remnawave traffic resets disagree with the configured Remnawave time zone ${verdict.timeZone}: ` +
        verdict.mismatches
          .map((mismatch) => `${mismatch.strategy} observed ${mismatch.observedAt}, expected ${mismatch.expectedAt}`)
          .join('; '),
      {
        reason: 'remnawave_reset_schedule_drift',
        timeZone: verdict.timeZone,
        mismatches: verdict.mismatches,
        why:
          `Remnawave сбрасывает трафик не тогда, когда ожидает панель: ${lines.join('; ')}. ` +
          'Докупки трафика «до сброса» панель снимает по своему расписанию и ждёт подтверждения сброса не больше ' +
          '6 часов, а клиенту показывает время сброса по этому же расписанию — при расхождении и то, и другое неверно.',
        nextSteps:
          'Узнайте часовой пояс сервера Remnawave — строка TZ в его .env (нет строки — UTC) — и укажите его на ' +
          'странице «Доп. услуги» → «Настройки» → «Часовой пояс Remnawave». Если пояс указан верно, проверьте часы ' +
          'и планировщик сервера Remnawave.',
      },
    );
  }
}

/**
 * The UTC days of month whose profiles a rolling run resets today or
 * yesterday: the day itself, and — on a month's last day — every later day
 * number too (a profile created on the 31st is reset on the 30th).
 */
export function rollingAnchorDays(now: Date): number[] {
  const days = new Set<number>();
  for (const at of [now, new Date(now.getTime() - DAY_MS)]) {
    const day = at.getUTCDate();
    days.add(day);
    const last = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();
    if (day === last) for (let later = day + 1; later <= 31; later += 1) days.add(later);
  }
  return [...days].sort((left, right) => left - right);
}
