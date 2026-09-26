import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { RawCacheService } from '../../common/cache/raw-cache.service';
import { shouldRunSchedules } from '../../common/runtime/process-role.util';
import { EVENT_TYPES, SystemEventsService } from '../../common/services/system-events.service';
import { PANEL_VERSION } from './panel-capabilities';
import {
  BEHIND_CARD_CLAIM_TTL_SECONDS,
  BEHIND_CARD_DEBOUNCE_MS,
  BEHIND_RECENT_MS,
  behindCardKey,
  behindKey,
  PEER_RECORD_TTL_SECONDS,
} from './reiwa-peers.constants';
import {
  isSurfaceBehind,
  PEER_SURFACES,
  ReiwaPeerRegistry,
  type PeerSurface,
  type ReiwaSurfaceStatus,
} from './reiwa-peer-registry.service';

/** When a surface was first found behind, and at which version. */
interface BehindMark {
  readonly since: number;
  readonly version: string;
}

function readBehindMark(value: unknown): BehindMark | null {
  if (typeof value !== 'object' || value === null) return null;
  const { since, version } = value as { since?: unknown; version?: unknown };
  return typeof since === 'number' && Number.isFinite(since) && typeof version === 'string' ? { since, version } : null;
}

/** What one sweep did about a surface — for the specs and the log. */
export type BehindOutcome = 'sent' | 'already-sent' | 'waiting' | 'caught-up' | 'not-compared' | 'unreadable';

/** «(сайт и API)», «(бот)». */
const SURFACE_WORDS: Readonly<Record<PeerSurface, string>> = { api: 'сайт и API', bot: 'бот' };

/**
 * The card's Russian body: which cabinet, what does not work until it is
 * updated — the sales it withholds first — and that nothing is charged for it.
 */
export function describeBehind(status: ReiwaSurfaceStatus, versionLabel: string): string {
  const cabinet = versionLabel === 'unknown' ? 'Кабинет Reiwa неизвестной версии' : `Кабинет Reiwa ${versionLabel}`;
  const items = status.missing.map((row, index) => `• ${row.operatorText}${index === status.missing.length - 1 ? '.' : ';'}`);
  return [
    `${cabinet} (${SURFACE_WORDS[status.surface]}) старше этой панели ${PANEL_VERSION}. До его обновления:`,
    ...items,
    'Остальное работает, деньги за скрытое не списываются. Обновите Reiwa.',
  ].join('\n');
}

/**
 * ReiwaCabinetBehindService
 * ═════════════════════════
 * «🧩 Кабинет старше панели» (`reiwa.cabinet_behind`): one card when a cabinet
 * surface stays older than this panel expects — lacking a registered
 * capability — for ten minutes.
 *
 * Every five minutes, in the process that runs schedules, for the site-and-API
 * surface and the bot, each seen within the last day:
 *
 *  - behind, first found: the time and the version are noted
 *    (`behindKey`), nothing is sent;
 *  - behind for ten minutes at the same version: the card, once per surface
 *    and version (`claimOnce` on `behindCardKey`, 30 days) — a later update
 *    that still leaves it behind is a new version and a new card;
 *  - caught up: the note and that version's claim are cleared, so falling
 *    behind again is a new ten minutes and a new card.
 *
 * An ordinary update gap — panel first, cabinet within ten minutes — sends
 * nothing. A surface never seen is not compared (there is nothing to compare,
 * and «WEB Reiwa» says so); neither is one silent for more than a day. There
 * is no "caught up" card: the page shows the current state.
 */
@Injectable()
export class ReiwaCabinetBehindService {
  private readonly logger = new Logger(ReiwaCabinetBehindService.name);

  public constructor(
    private readonly peers: ReiwaPeerRegistry,
    private readonly store: RawCacheService,
    private readonly events: SystemEventsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  public async sweep(): Promise<void> {
    if (!shouldRunSchedules()) return;
    await this.check(Date.now());
  }

  /** One sweep over both surfaces. Never throws. */
  public async check(now: number): Promise<Readonly<Record<PeerSurface, BehindOutcome>>> {
    const outcomes = {} as Record<PeerSurface, BehindOutcome>;
    for (const surface of PEER_SURFACES) {
      try {
        outcomes[surface] = await this.checkSurface(surface, now);
      } catch (err: unknown) {
        this.logger.warn(`Could not check the cabinet's ${surface} surface: ${err instanceof Error ? err.message : String(err)}`);
        outcomes[surface] = 'unreadable';
      }
    }
    return outcomes;
  }

  private async checkSurface(surface: PeerSurface, now: number): Promise<BehindOutcome> {
    const status = await this.peers.surfaceStatus(surface, now);
    // Nothing could be read: decide nothing, keep every mark as it is.
    if (status.state === 'unavailable') return 'unreadable';
    const markKey = behindKey(surface);
    const mark = readBehindMark(await this.store.get<unknown>(markKey));
    const recent = status.lastSeenAt !== null && now - status.lastSeenAt <= BEHIND_RECENT_MS;

    if (!isSurfaceBehind(status) || !recent) {
      if (mark !== null) {
        await this.store.del(markKey);
        // Caught up: the card for that version may go out again should it
        // fall behind again. Merely unseen, it keeps its claim.
        if (recent && status.missing.length === 0) await this.store.del(behindCardKey(surface, mark.version));
      }
      return status.missing.length === 0 && status.state !== 'never' ? 'caught-up' : 'not-compared';
    }

    const version = status.version ?? 'unknown';
    if (mark === null || mark.version !== version) {
      await this.store.set(markKey, { since: now, version } satisfies BehindMark, PEER_RECORD_TTL_SECONDS);
      return 'waiting';
    }
    if (now - mark.since < BEHIND_CARD_DEBOUNCE_MS) return 'waiting';
    if (!(await this.store.claimOnce(behindCardKey(surface, version), BEHIND_CARD_CLAIM_TTL_SECONDS))) {
      return 'already-sent';
    }
    this.events.warn(
      EVENT_TYPES.REIWA_CABINET_BEHIND,
      'SYSTEM',
      `Reiwa ${version} (${surface}) is behind panel ${PANEL_VERSION}: it lacks ${status.missing.map((row) => row.id).join(', ')}`,
      {
        cabinetSurface: surface,
        cabinetVersion: version,
        panelVersion: PANEL_VERSION,
        missingCapabilities: status.missing.map((row) => row.id),
        behindSince: new Date(mark.since).toISOString(),
        note: describeBehind(status, version),
      },
    );
    return 'sent';
  }
}
