import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';

import {
  BULLMQ_RETAINED_COMPLETED_JOBS,
  BULLMQ_RETAINED_FAILED_JOBS,
  runBullMqEnqueueWithTimeout,
} from '../../../common/queue/bullmq-enqueue-options';
import {
  RELAY_UNDELIVERED_RECORDER,
  type UndeliveredRecord,
  type UndeliveredRecorder,
} from '../../notifications/undelivered-record';
import { ConfigDeliveryState, type ConfigDeliveryReport, type ConfigHintOutcome } from './config-delivery-state';
import {
  CONFIG_DELIVERY_CHECK_DELAY_MS,
  CONFIG_DELIVERY_CHECK_JOB,
  CONFIG_DELIVERY_CHECK_QUEUE,
  CONFIG_DELIVERY_REPORT_FRESH_MS,
  CONFIG_VERSION_CONSUMERS,
  HINT_GROUPS,
  type ConfigDeliveryCheckJobData,
  type ConfigDeliveryTracker,
  type ConfigHintEvent,
  type ConfigVersionConsumer,
  type ConfigVersionKey,
} from './config-versions.constants';
import { ConfigVersionsService } from './config-versions.service';

/**
 * One thing the check found wrong with one group.
 *
 *  - `stale` — a process polls, and two minutes after the save it still holds
 *    the old version: it did not take the change (a value its guard refuses, a
 *    re-read that keeps failing).
 *  - `silent` — a process that reports this group has not polled for a while,
 *    and the hint did not get through either: nothing says the change arrived.
 *  - `hint-lost` — no process reports this group (a cabinet older than the
 *    version poll), and the hint did not get through: the old signal, kept for
 *    that cabinet.
 */
export type ConfigDeliveryFinding =
  | {
      readonly cause: 'stale';
      readonly group: ConfigVersionKey;
      readonly consumer: ConfigVersionConsumer;
      readonly held: string;
      readonly current: string;
    }
  | {
      readonly cause: 'silent';
      readonly group: ConfigVersionKey;
      readonly consumer: ConfigVersionConsumer;
      readonly silentForMs: number;
      readonly hintStatus: string | null;
    }
  | { readonly cause: 'hint-lost'; readonly group: ConfigVersionKey; readonly hintStatus: string };

/** What the operator reads for each group — what they saved, in their words. */
const GROUP_TITLES: Readonly<Record<ConfigVersionKey, string>> = {
  publicConfig: 'оформление кабинета',
  botConfig: 'настройки бота',
  landing: 'веб-лендинг',
  connectPage: 'экран подключения',
  platformPolicy: 'правила доступа',
  'legalDocuments.ru': 'документы',
  'legalDocuments.en': 'документы',
  customEmojiPacks: 'эмодзи-паки',
  guestSupport: 'поддержка без аккаунта',
};

const CONSUMER_TITLES: Readonly<Record<ConfigVersionConsumer, string>> = {
  api: 'сайт кабинета',
  bot: 'бот',
};

/**
 * ConfigDeliveryCheckService
 * ══════════════════════════
 * Did an operator's settings save reach the cabinet? The owner's rule
 * (24.09.2026): warn only if it has not arrived within two minutes.
 *
 * It used to be the relay's attempts that decided: two failed hint attempts ten
 * seconds apart, and a card. That warned about hints the cabinet no longer
 * needed — the cabinet's own poll catches a lost hint within twenty seconds —
 * and it could not see the failure that matters: a hint that arrived and a
 * change the cabinet still did not take.
 *
 * Now the evidence is what the cabinet HOLDS. Each of its processes reports the
 * version of every group it holds whenever it polls (`InternalConfigVersionsController`),
 * and two minutes after a hint this check compares those reports with what the
 * database says now:
 *
 *  - a fresh report holding the current version, or holding nothing (its next
 *    read asks the panel) — delivered;
 *  - a fresh report holding an older version — not taken (`stale`);
 *  - a report gone quiet — delivered if the relay delivered the hint, else
 *    nothing says it arrived (`silent`);
 *  - no report for the group at all — a cabinet from before the poll: the
 *    relay's outcome is the only evidence, as it always was (`hint-lost`).
 *
 * A later save of the same group supersedes an earlier one's check: only the
 * check of the latest save runs, so two saves a minute apart are judged by the
 * second one's deadline, not the first.
 *
 * The card is the relay's own `reiwa.relay_undelivered`, through the relay's
 * recorder: one alert per cause per cooldown (`undelivered-alert-gate.ts`).
 */
@Injectable()
export class ConfigDeliveryCheckService implements ConfigDeliveryTracker {
  private readonly logger = new Logger(ConfigDeliveryCheckService.name);

  public constructor(
    private readonly versions: ConfigVersionsService,
    private readonly state: ConfigDeliveryState,
    @InjectQueue(CONFIG_DELIVERY_CHECK_QUEUE)
    private readonly queue: Queue<ConfigDeliveryCheckJobData>,
    @Inject(RELAY_UNDELIVERED_RECORDER)
    private readonly recordUndelivered: UndeliveredRecorder,
  ) {}

  public async hintSent(event: ConfigHintEvent, reason: string): Promise<void> {
    // First, and whatever happens after: the next poll must be told the save.
    this.versions.bust();
    const savedAt = Date.now();
    const groups = HINT_GROUPS[event];
    try {
      await Promise.all(groups.map((group) => this.state.markSave(group, savedAt)));
      await runBullMqEnqueueWithTimeout(() =>
        this.queue.add(
          CONFIG_DELIVERY_CHECK_JOB,
          { event, groups, savedAt, reason },
          {
            delay: CONFIG_DELIVERY_CHECK_DELAY_MS,
            attempts: 1,
            removeOnComplete: BULLMQ_RETAINED_COMPLETED_JOBS,
            removeOnFail: BULLMQ_RETAINED_FAILED_JOBS,
          },
        ),
      );
    } catch (err: unknown) {
      // No check, no card: the cabinet's poll still delivers the change; what
      // is lost is only the warning should it not.
      this.logger.warn(
        `Could not schedule the delivery check of ${event}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  public async hintSettled(event: ConfigHintEvent, delivered: boolean, status: string): Promise<void> {
    await this.state.recordHintOutcome(event, { delivered, status, at: Date.now() });
  }

  /**
   * The check of one save, two minutes after it. Answers what it found; the
   * findings have already gone to the operator's card when it returns.
   */
  public async check(data: ConfigDeliveryCheckJobData, now: number = Date.now()): Promise<readonly ConfigDeliveryFinding[]> {
    const groups: ConfigVersionKey[] = [];
    for (const group of data.groups) {
      const latest = await this.state.latestSave(group);
      // A later save's own check owns this group.
      if (latest !== null && latest > data.savedAt) continue;
      groups.push(group);
    }
    if (groups.length === 0) return [];

    const [current, reports, hint] = await Promise.all([
      this.versions.current({ fresh: true }),
      this.state.reports(),
      this.state.hintOutcome(data.event),
    ]);
    // The relay's word on THIS save's hint, not an older one of the same kind.
    const settled: ConfigHintOutcome | null = hint !== null && hint.at >= data.savedAt ? hint : null;

    const findings: ConfigDeliveryFinding[] = [];
    for (const group of groups) {
      const version = current[group];
      // Unreadable right now: nothing to compare with, and no card on a guess.
      if (version === undefined) continue;
      const trackers = CONFIG_VERSION_CONSUMERS.filter((consumer) => reportsGroup(reports[consumer], group));
      if (trackers.length === 0) {
        if (settled !== null && !settled.delivered) {
          findings.push({ cause: 'hint-lost', group, hintStatus: settled.status });
        }
        continue;
      }
      for (const consumer of trackers) {
        const report = reports[consumer] as ConfigDeliveryReport;
        const held = report.held[group];
        if (now - report.reportedAt > CONFIG_DELIVERY_REPORT_FRESH_MS) {
          // Quiet, but the hint itself got through: the cabinet dropped its
          // copy, and it is the poll that is failing, not the delivery.
          if (settled?.delivered === true) continue;
          findings.push({
            cause: 'silent',
            group,
            consumer,
            silentForMs: now - report.reportedAt,
            hintStatus: settled?.status ?? null,
          });
        } else if (typeof held === 'string' && held !== version) {
          findings.push({ cause: 'stale', group, consumer, held, current: version });
        }
      }
    }

    for (const record of buildConfigDeliveryRecords(data, findings)) {
      try {
        await this.recordUndelivered(record);
      } catch (err: unknown) {
        this.logger.warn(`Could not record an undelivered settings change: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return findings;
  }
}

function reportsGroup(report: ConfigDeliveryReport | null, group: ConfigVersionKey): boolean {
  return report !== null && Object.prototype.hasOwnProperty.call(report.held, group);
}

function titlesOf(groups: readonly ConfigVersionKey[]): string {
  return [...new Set(groups.map((group) => GROUP_TITLES[group]))].join(', ');
}

function consumersOf(consumers: readonly ConfigVersionConsumer[]): string {
  return [...new Set(consumers)].map((consumer) => CONSUMER_TITLES[consumer]).join(' и ');
}

/**
 * The operator's cards for one check: at most one per cause, each naming every
 * group and process it covers. The signature is the cause and what it covers —
 * never the save — so a cause that persists across saves is one card per
 * cooldown with a count, not one per save.
 */
export function buildConfigDeliveryRecords(
  data: ConfigDeliveryCheckJobData,
  findings: readonly ConfigDeliveryFinding[],
): UndeliveredRecord[] {
  const records: UndeliveredRecord[] = [];

  const stale = findings.filter((f): f is Extract<ConfigDeliveryFinding, { cause: 'stale' }> => f.cause === 'stale');
  if (stale.length > 0) {
    const pairs = [...new Set(stale.map((f) => `${f.consumer}:${f.group}`))].sort();
    records.push({
      message: `The cabinet did not take a settings change within 2 minutes: ${pairs.join(', ')}`,
      metadata: {
        reason: 'config_not_delivered',
        relayEvent: data.event,
        relayStatus: 'not-applied',
        detail: stale
          .map((f) => `${f.consumer} ${f.group}: holds ${f.held}, current ${f.current}`)
          .join('; '),
        why:
          `Через 2 минуты после сохранения ${consumersOf(stale.map((f) => f.consumer))} всё ещё ` +
          `держит прежние ${titlesOf(stale.map((f) => f.group))}, хотя сверяется с панелью: скорее ` +
          'всего, кабинет не принял новое значение. Проверьте: откройте кабинет и обновите ' +
          'страницу, в боте отправьте /start. Если осталось старое — причину по оформлению ' +
          'кабинет присылает в «Журнал аудита» → «Системные события», остальное видно в журнале ' +
          'контейнера: docker compose logs reiwa или reiwa-bot.',
        configGroups: [...new Set(stale.map((f) => f.group))],
        consumers: [...new Set(stale.map((f) => f.consumer))],
      },
      signature: JSON.stringify(['config-delivery', 'not-applied', pairs]),
    });
  }

  const silent = findings.filter((f): f is Extract<ConfigDeliveryFinding, { cause: 'silent' }> => f.cause === 'silent');
  if (silent.length > 0) {
    const consumers = [...new Set(silent.map((f) => f.consumer))].sort();
    const minutes = Math.max(1, Math.round(Math.max(...silent.map((f) => f.silentForMs)) / 60_000));
    const hintStatus = silent.find((f) => f.hintStatus !== null)?.hintStatus ?? null;
    records.push({
      message: `No cabinet process confirmed a settings change within 2 minutes: ${consumers.join(', ')}`,
      metadata: {
        reason: 'config_not_delivered',
        relayEvent: data.event,
        relayStatus: 'no-check-in',
        detail:
          `${consumers.join(', ')} last polled ${minutes} min ago; ` +
          (hintStatus === null ? 'no relay outcome for the hint' : `hint ${hintStatus}`),
        why:
          `Изменение (${titlesOf(silent.map((f) => f.group))}) не подтверждено: ` +
          `${consumersOf(consumers)} не сверяется с панелью уже около ${minutes} мин., и сигнал ` +
          'об изменении до кабинета не дошёл. Кабинет подхватит изменение сам, как только снова ' +
          'увидит панель. Проверьте, что контейнеры reiwa и reiwa-bot запущены (docker compose ' +
          'ps в папке кабинета) и что в .env кабинета верны адрес панели REZEIS_HOST и токен ' +
          'REZEIS_TOKEN.',
        configGroups: [...new Set(silent.map((f) => f.group))],
        consumers,
      },
      signature: JSON.stringify(['config-delivery', 'no-check-in', consumers]),
    });
  }

  const lost = findings.filter((f): f is Extract<ConfigDeliveryFinding, { cause: 'hint-lost' }> => f.cause === 'hint-lost');
  if (lost.length > 0) {
    const status = lost[0]?.hintStatus ?? 'unknown';
    records.push({
      message: `Reiwa relay did not deliver ${data.event} (${status}), and the cabinet does not report what it holds`,
      metadata: {
        reason: 'config_not_delivered',
        relayEvent: data.event,
        relayStatus: status,
        why:
          `Сигнал об изменении (${titlesOf(lost.map((f) => f.group))}) не доставлен в кабинет, а ` +
          'кабинет не сообщает, какие настройки держит: его версия старше панели. Он подхватит ' +
          'изменение сам в течение 5 минут. Обновите кабинет до версии, выпущенной вместе с этой ' +
          'панелью, — тогда панель будет видеть, что изменение дошло.',
        configGroups: [...new Set(lost.map((f) => f.group))],
      },
      signature: JSON.stringify(['config-delivery', 'hint-lost', data.event, status]),
    });
  }

  return records;
}
