import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES } from '../../../common/services/system-events.service';
import { POPUP_CAPABLE_EVENTS } from '../popup-capable-events';

/**
 * event-catalog.service
 * ─────────────────────
 * Every event a rule could be bound to — and whether it has ever actually
 * happened on THIS installation.
 *
 * ── Why "has it happened here" and not "is it emitted" ───────────────────────
 *
 * Because the second question cannot be answered honestly. The panel declares
 * 115 event types and emits far fewer, and a rule bound to one nothing emits
 * fails in perfect silence: the pattern filter never selects it, so there is no
 * execution row, no error and no log line, and the rule reads "enabled" in the
 * operator's list for ever. Four shipped pop-up templates lived in exactly that
 * state.
 *
 * The obvious fix is a list of the emitted ones. I wrote the scanner for it and
 * it was wrong in both directions: it missed `automation.custom`, which is
 * emitted through a variable rather than at the call, and
 * `remnawave.hwid_average_high`, which is emitted through a differently-named
 * alias of the same constants. A catalogue that marks a live event dead is as
 * harmful as one that marks a dead event live — an operator avoids a trigger
 * that works — and no regex over this codebase can be trusted not to do both.
 *
 * So the question is turned around. `SystemEventsService.persistEvent` writes
 * every event it emits into the audit log as `event.<type>`, which makes the
 * operator's own database the ground truth: not "is this emitted somewhere in
 * the source" but "has this fired HERE, and when". That is also the better
 * question. A type that fires on a Remnawave 2.8 install and never on a 2.7
 * one is not a fact about the source at all.
 *
 * ── Bounded on purpose ───────────────────────────────────────────────────────
 *
 * The audit log is the busiest table in the schema. The count is taken over a
 * window rather than over all history: it answers "does this happen here
 * nowadays", which is what somebody about to write a rule is asking, and it
 * keeps the query on the `created_at` index instead of walking years.
 */

/**
 * How far back "has this fired here" looks.
 *
 * TIED TO AUDIT RETENTION, not a constant of its own. The maintenance sweep
 * deletes audit rows older than `AUDIT_RETENTION_DAYS`, so a window wider than
 * retention is a window that reports "never happened" for anything whose last
 * occurrence has simply been swept — and the hint says that sentence to an
 * operator with a day count in it. An operator who shortens retention to keep
 * the database small would have been told, in so many words, that their yearly
 * events are dead triggers.
 */
export const EVENT_CATALOG_WINDOW_DAYS = Math.max(
  1,
  Number(process.env['AUDIT_RETENTION_DAYS']) || 90,
);

export interface CatalogEvent {
  readonly type: string;
  /**
   * False for a type the panel does not declare but has nevertheless emitted
   * here — an operator's own, raised by a `system_event` action or posted to
   * `/api/internal/events`.
   *
   * Those are a designed capability, not an accident, and the bridge matches
   * them verbatim, so a rule bound to one DOES fire. Dropping them turned this
   * catalogue's warning inside out: a trigger firing five hundred times a month
   * was reported as one the panel has never heard of.
   */
  readonly declared: boolean;
  /** The namespace before the first dot — how the panel groups them. */
  readonly namespace: string;
  /** True when a `show_hint` action bound to it can actually name a customer. */
  readonly popupCapable: boolean;
  /** How many times it fired here inside the window. */
  readonly seen: number;
  /** When it last fired here, or null if it never has. */
  readonly lastSeenAt: string | null;
}

@Injectable()
export class EventCatalogService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async listEvents(now: Date = new Date()): Promise<readonly CatalogEvent[]> {
    const since = new Date(now.getTime() - EVENT_CATALOG_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await this.prismaService.adminAuditLog.groupBy({
      by: ['action'],
      where: { action: { startsWith: 'event.' }, createdAt: { gte: since } },
      _count: { action: true },
      _max: { createdAt: true },
    });

    const observed = new Map<string, { seen: number; lastSeenAt: Date | null }>();
    for (const row of rows) {
      observed.set(row.action.slice('event.'.length), {
        seen: row._count.action,
        lastSeenAt: row._max.createdAt,
      });
    }

    const popupCapable = new Set(POPUP_CAPABLE_EVENTS.map((event) => event.type));

    // BOTH SETS, unioned.
    //
    // Every DECLARED type, because one that has never fired here is the single
    // most useful row in the list — it is the one an operator must not bind a
    // rule to — so it belongs here with a zero rather than absent because the
    // query found nothing.
    //
    // And every type actually OBSERVED, declared or not. An operator can mint
    // their own through a `system_event` action or `/api/internal/events`, and
    // the bridge matches those verbatim, so rules bound to them fire. Keeping
    // only the declared half made this catalogue warn hardest about exactly the
    // triggers that work.
    const types = new Set<string>([...Object.values(EVENT_TYPES), ...observed.keys()]);
    const declared = new Set<string>(Object.values(EVENT_TYPES));

    return [...types]
      .map((type) => {
        const seen = observed.get(type);
        return {
          type,
          declared: declared.has(type),
          namespace: type.includes('.') ? type.slice(0, type.indexOf('.')) : 'other',
          popupCapable: popupCapable.has(type),
          seen: seen?.seen ?? 0,
          lastSeenAt: seen?.lastSeenAt?.toISOString() ?? null,
        };
      })
      .sort((left, right) => left.type.localeCompare(right.type));
  }
}
