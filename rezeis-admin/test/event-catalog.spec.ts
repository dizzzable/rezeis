import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { POPUP_CAPABLE_EVENTS } from '../src/modules/automations/popup-capable-events';
import {
  EVENT_CATALOG_WINDOW_DAYS,
  EventCatalogService,
} from '../src/modules/automations/services/event-catalog.service';

/**
 * "WHICH TRIGGERS EXIST" — ANSWERED FROM THE OPERATOR'S OWN DATA.
 *
 * A rule bound to a type nothing emits is the quietest failure in this
 * subsystem: no execution row, no error, no log line, and the rule reads
 * "enabled" for ever. Four shipped pop-up templates lived in exactly that state
 * and the only way anybody could have found out was that customers never
 * mentioned them.
 *
 * The obvious guard is a list of the emitted types. A scanner for it was
 * written and was wrong in BOTH directions — it missed an event emitted through
 * a variable and one emitted through a differently-named alias of the same
 * constants. A catalogue that marks a live event dead is as harmful as the
 * reverse, so the source is not the authority here. The audit log is: every
 * emitted event is persisted as `event.<type>`, which makes "has this fired on
 * this installation" a fact rather than an inference.
 */

const NOW = new Date('2026-09-09T12:00:00.000Z');

function buildService(
  rows: Array<{ action: string; count: number; last: string }>,
): { service: EventCatalogService; args: Record<string, unknown>[] } {
  const args: Record<string, unknown>[] = [];
  const prisma = {
    adminAuditLog: {
      groupBy: async (query: Record<string, unknown>) => {
        args.push(query);
        // HONOURS THE FILTER. A fake that returned every row whatever the where
        // clause said made "ignores an audit row that is not an event" pass for
        // a reason of its own — `'users.export'.slice(6)` happens not to be a
        // declared type — and kept passing with the filter deleted outright.
        const where = query['where'] as { action?: { startsWith?: string } } | undefined;
        const prefix = where?.action?.startsWith ?? '';
        return rows
          .filter((row) => row.action.startsWith(prefix))
          .map((row) => ({
            action: row.action,
            _count: { action: row.count },
            _max: { createdAt: new Date(row.last) },
          }));
      },
    },
  };
  return { service: new EventCatalogService(prisma as never), args };
}

describe('the event catalogue', () => {
  it('lists every type the panel declares, fired or not', async () => {
    // THE ROWS THAT MATTER MOST ARE THE ZEROES. An event that has never fired
    // here is the one an operator must not bind a rule to, so it has to be
    // present with a zero rather than absent because the query found nothing.
    const { service } = buildService([]);

    const events = await service.listEvents(NOW);

    assert.equal(events.length, Object.values(EVENT_TYPES).length);
    assert.ok(events.length >= 100, `catalogue holds ${events.length} types`);
    assert.ok(events.every((event) => event.seen === 0 && event.lastSeenAt === null));
  });

  it('counts what actually fired, from the audit log', async () => {
    const { service } = buildService([
      { action: 'event.payment.failed', count: 12, last: '2026-09-08T10:00:00.000Z' },
    ]);

    const events = await service.listEvents(NOW);
    const failed = events.find((event) => event.type === 'payment.failed');

    assert.equal(failed?.seen, 12);
    assert.equal(failed?.lastSeenAt, '2026-09-08T10:00:00.000Z');
  });

  it('ignores an audit row that is not an event', async () => {
    // The audit log holds the operator's own actions too — `users.export`,
    // `users.registration.export`. Counting those as events would invent a
    // type nobody can bind a rule to and give it activity.
    const { service } = buildService([
      { action: 'users.export', count: 99, last: '2026-09-08T10:00:00.000Z' },
    ]);

    const events = await service.listEvents(NOW);

    assert.ok(events.every((event) => event.seen === 0));
    assert.equal(
      events.some((event) => event.type.includes('export')),
      false,
      "an operator's own action was catalogued as an event",
    );
  });

  it("keeps an event the operator minted themselves", async () => {
    // THE DEFECT THIS UNION EXISTS FOR. A `system_event` action with an
    // explicit type, or a POST to `/api/internal/events`, emits a type the
    // panel does not declare — and the bridge matches those verbatim, so rules
    // bound to them fire. Keeping only the declared half meant the trigger hint
    // reported "the panel does not know this event" for one firing five hundred
    // times a month, and "has not happened here once" for a `automation.*`
    // pattern that was busy.
    const { service } = buildService([
      { action: 'event.ops.nightly_report', count: 500, last: '2026-09-08T10:00:00.000Z' },
    ]);

    const events = await service.listEvents(NOW);
    const minted = events.find((event) => event.type === 'ops.nightly_report');

    assert.ok(minted, 'an event that fires here is missing from the catalogue');
    assert.equal(minted.seen, 500);
    assert.equal(minted.declared, false, 'it is not one of ours and should not claim to be');
  });

  it('still marks the panel’s own types as declared', () => {
    // The other half: without it, "declared" could be hard-coded false and the
    // case above would not notice.
    const { service } = buildService([]);

    return service.listEvents(NOW).then((events) => {
      const known = events.find((event) => event.type === 'payment.failed');
      assert.equal(known?.declared, true);
    });
  });

  it('asks the database for events only, and only inside the window', async () => {
    // The audit log is the busiest table in the schema. An unbounded group-by
    // over it walks years to answer a question about this month.
    const { service, args } = buildService([]);

    await service.listEvents(NOW);

    const where = args[0]?.['where'] as {
      action: { startsWith: string };
      createdAt: { gte: Date };
    };
    assert.equal(where.action.startsWith, 'event.');
    const days = (NOW.getTime() - where.createdAt.gte.getTime()) / (24 * 60 * 60 * 1000);
    assert.equal(days, EVENT_CATALOG_WINDOW_DAYS);
  });

  it('marks exactly the events that can carry a pop-up', async () => {
    // The same list the save-time check refuses on, so the catalogue and the
    // refusal cannot tell an operator two different things.
    const { service } = buildService([]);

    const events = await service.listEvents(NOW);
    const marked = events.filter((event) => event.popupCapable).map((event) => event.type);

    assert.deepEqual(
      marked.sort(),
      POPUP_CAPABLE_EVENTS.map((event) => event.type).sort(),
    );
  });

  it('groups by the namespace the panel names things with', async () => {
    const { service } = buildService([]);

    const events = await service.listEvents(NOW);
    const payment = events.find((event) => event.type === 'payment.failed');
    const namespaces = new Set(events.map((event) => event.namespace));

    assert.equal(payment?.namespace, 'payment');
    assert.ok(namespaces.size >= 10, `found ${namespaces.size} namespaces`);
    // Anti-emptiness on the other side: everything landing in one bucket would
    // make the grouping useless while still passing the check above.
    assert.ok(!namespaces.has(''));
  });
});

describe('the string the catalogue is joined on', () => {
  /**
   * THE ONE COUPLING THE WHOLE FEATURE RESTS ON, and nothing asserted it.
   *
   * `SystemEventsService.persistEvent` writes every emitted event into the
   * audit log as `event.<type>`, and `EventCatalogService` strips exactly that
   * prefix back off. Change either side and the join silently yields nothing:
   * all 115 types return `seen: 0`, so the trigger hint tells an operator "has
   * not happened here once in the last N days" under EVERY trigger they type —
   * warning them away from all of them at once — and the system audit feed
   * empties in the same instant.
   *
   * Verified: renaming the prefix to `events.` left the entire panel suite
   * green. This is the one line that would have made that loud.
   */
  const EVENTS = readFileSync(
    join(__dirname, '..', 'src', 'common', 'services', 'system-events.service.ts'),
    'utf8',
  );

  it('is written by persistEvent as `event.<type>`', () => {
    const at = EVENTS.indexOf('private async persistEvent(');
    assert.ok(at >= 0, 'persistEvent is gone');
    const body = EVENTS.slice(at, EVENTS.indexOf('\n  }', at));

    assert.match(body, /action:\s*`event\.\$\{event\.type\}`/);
  });

  it('is read back by the catalogue with the same prefix', () => {
    const catalog = readFileSync(
      join(__dirname, '..', 'src', 'modules', 'automations', 'services', 'event-catalog.service.ts'),
      'utf8',
    );

    assert.match(catalog, /startsWith:\s*'event\.'/);
    assert.match(catalog, /slice\('event\.'\.length\)/);
  });
});
