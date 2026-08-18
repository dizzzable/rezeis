import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  EVENT_TYPES,
  REGISTERED_EVENT_TYPES,
  SystemEventsService,
  type SystemEventCategory,
  type SystemEventSeverity,
} from '../src/common/services/system-events.service';
import {
  UNREGISTERED_EVENTS_SENTINEL,
  isEventTelegramAllowed,
} from '../src/common/services/telegram-delivery-target.util';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';

/**
 * The two producers that choose their event type at RUNTIME
 * ─────────────────────────────────────────────────────────
 * `test/system-event-registry.spec.ts` closes the loop for types written as a
 * literal or a constant. Two producers escape it by construction, because the
 * string does not exist until the event fires:
 *
 *   1. `AutomationActionRegistry.systemEvent` — the operator writes the type
 *      into the rule's action params. Free-form on purpose: rules emit
 *      domain-specific types that webhooks and other rules match on.
 *   2. `InternalEventsController` (`POST /api/internal/events`) — reiwa posts
 *      a `ReceiveSystemEventDto` whose `type` is a free `@IsString()` field.
 *
 * Neither can ever be in `EVENT_TYPES`, `EVENT_PRESENTATION` or the operator's
 * catalogue, so in `selected` mode — an exact-match allow-list — neither was
 * delivered at all. Silently: no log line, no card, nothing.
 *
 * The fix is one catch-all tick-box (`UNREGISTERED_EVENTS_SENTINEL`) plus a
 * real registration for `automation.custom`, the one FIXED string in that set
 * (the default when a rule omits `type`). What this file has to prove:
 *
 *   * a REGISTERED type keeps exact-match semantics — the catch-all cannot
 *     deliver something the operator was offered and declined;
 *   * nobody's delivery set widens by itself, for all three operator classes;
 *   * an unregistered type's card is readable rather than an empty header;
 *   * a type string cannot forge card structure in `parse_mode: 'HTML'`.
 *
 * Every "was NOT delivered" assertion below runs a control event through the
 * SAME harness in the same test. A harness that silently stopped rendering
 * would otherwise agree with `null` forever — the exact vacuous green this
 * project has eleven recorded instances of.
 */

const CATALOGUE_FILE = join(
  __dirname,
  '..',
  'web',
  'src',
  'features',
  'notifications',
  'notifications-page.tsx',
);

/** A type an automation rule could plausibly invent. Registered nowhere. */
const RUNTIME_AUTOMATION_TYPE = 'billing.invoice_voided';
/** A type the reiwa ingest could post. Registered nowhere. */
const RUNTIME_INGEST_TYPE = 'reiwa.queue_backlog';
/** Registered, presented, tickable — the exact-match control throughout. */
const REGISTERED_TICKED = EVENT_TYPES.PAYMENT_COMPLETED;
/** Registered and tickable, but deliberately never ticked below. */
const REGISTERED_UNTICKED = EVENT_TYPES.PAYMENT_REFUNDED;

describe('the delivery gate for a type nobody could have ticked', () => {
  it('is asked about types that really are on opposite sides of the registry', () => {
    // Everything below turns on which branch a type takes, so the premise is
    // asserted rather than assumed: if `billing.invoice_voided` were somehow
    // registered, the catch-all tests would be exercising the exact-match
    // branch and proving nothing about the feature.
    assert.ok(
      REGISTERED_EVENT_TYPES.has(REGISTERED_TICKED) &&
        REGISTERED_EVENT_TYPES.has(REGISTERED_UNTICKED),
      'the control types must be registered, or the exact-match assertions below are vacuous',
    );
    assert.ok(
      !REGISTERED_EVENT_TYPES.has(RUNTIME_AUTOMATION_TYPE) &&
        !REGISTERED_EVENT_TYPES.has(RUNTIME_INGEST_TYPE),
      'the runtime types must NOT be registered, or the catch-all is never reached',
    );
    assert.ok(
      REGISTERED_EVENT_TYPES.size > 50,
      `only ${REGISTERED_EVENT_TYPES.size} registered types — the set, not the code, is wrong`,
    );
  });

  it('keeps a registered type exact-match whether or not the catch-all is ticked', () => {
    // The non-negotiable one. A tick-box exists for this type; the operator
    // did not tick it; that is an answer, and a catch-all meaning "things I
    // was never asked about" must not overrule it.
    const catchAllOnly = {
      eventsMode: 'selected' as const,
      events: [UNREGISTERED_EVENTS_SENTINEL],
      knownTypes: REGISTERED_EVENT_TYPES,
    };
    assert.equal(isEventTelegramAllowed(REGISTERED_UNTICKED, catchAllOnly), false);

    for (const events of [
      [REGISTERED_UNTICKED],
      [REGISTERED_UNTICKED, UNREGISTERED_EVENTS_SENTINEL],
    ]) {
      assert.equal(
        isEventTelegramAllowed(REGISTERED_UNTICKED, {
          eventsMode: 'selected',
          events,
          knownTypes: REGISTERED_EVENT_TYPES,
        }),
        true,
        'a ticked registered type must still be delivered',
      );
    }
  });

  it('delivers a runtime-chosen type only when the catch-all is ticked', () => {
    for (const type of [RUNTIME_AUTOMATION_TYPE, RUNTIME_INGEST_TYPE]) {
      assert.equal(
        isEventTelegramAllowed(type, {
          eventsMode: 'selected',
          events: [REGISTERED_TICKED],
          knownTypes: REGISTERED_EVENT_TYPES,
        }),
        false,
        `${type} must stay undelivered until the operator opts in`,
      );
      assert.equal(
        isEventTelegramAllowed(type, {
          eventsMode: 'selected',
          events: [REGISTERED_TICKED, UNREGISTERED_EVENTS_SENTINEL],
          knownTypes: REGISTERED_EVENT_TYPES,
        }),
        true,
        `${type} must be delivered once the catch-all is ticked`,
      );
    }
  });

  it('ignores the catch-all entirely in `all` mode', () => {
    // `all` mode never consulted the list and still must not: an operator who
    // never narrowed anything keeps receiving exactly what they received.
    for (const events of [[], [UNREGISTERED_EVENTS_SENTINEL]]) {
      assert.equal(
        isEventTelegramAllowed(RUNTIME_AUTOMATION_TYPE, {
          eventsMode: 'all',
          events,
          knownTypes: REGISTERED_EVENT_TYPES,
        }),
        true,
      );
    }
  });

  it('cannot be switched on by a stored selection that predates it', () => {
    // The sentinel is outside the event-type grammar, so no saved list of real
    // types can contain it and no producer can emit a matching type.
    const grammar = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;
    assert.ok(
      !grammar.test(UNREGISTERED_EVENTS_SENTINEL),
      `${UNREGISTERED_EVENTS_SENTINEL} is a legal event type — it could collide with a real one`,
    );
    assert.ok(
      [...REGISTERED_EVENT_TYPES].every((type) => grammar.test(type)),
      'a registered type breaks the grammar this sentinel relies on being outside',
    );
  });
});

describe('what each class of operator receives once the catch-all exists', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  it('an operator who never opened the page still gets everything, and nothing new', async () => {
    // No `Settings` row at all — `loadTelegramConfig` takes its "no settings"
    // branch, which is `all` mode. This operator was ALREADY receiving the
    // runtime types (untitled); the change must leave that alone.
    for (const type of [RUNTIME_AUTOMATION_TYPE, REGISTERED_TICKED]) {
      const card = await renderCard({ type }, NEVER_CONFIGURED);
      assert.ok(card !== null, `${type} must keep reaching an operator in the default mode`);
    }
  });

  it('an operator in `all` mode is unaffected by the catch-all', async () => {
    const card = await renderCard({ type: RUNTIME_AUTOMATION_TYPE }, telegramRow('all', []));
    assert.ok(card !== null, '`all` mode must ignore the selection list, as before');
  });

  it('does not widen a selection saved before the catch-all existed', async () => {
    // Reconstructed from the SPA's own catalogue, minus the one type this
    // change added — i.e. every tick-box that existed when the operator saved.
    const savedBefore = readOperatorCatalogue().filter(
      (type) => type !== EVENT_TYPES.AUTOMATION_CUSTOM,
    );
    assert.ok(
      savedBefore.length > 50 &&
        savedBefore.includes(REGISTERED_TICKED) &&
        !savedBefore.includes(EVENT_TYPES.AUTOMATION_CUSTOM) &&
        !savedBefore.includes(UNREGISTERED_EVENTS_SENTINEL),
      'the reconstructed pre-change selection is wrong, so this test proves nothing',
    );
    const row = telegramRow('selected', savedBefore);

    // The control runs first: if the harness stopped delivering anything at
    // all, the three `null` assertions below would agree with a broken build.
    assert.ok(
      (await renderCard({ type: REGISTERED_TICKED }, row)) !== null,
      'the harness must still deliver a ticked type — otherwise the nulls below mean nothing',
    );

    for (const type of [
      RUNTIME_AUTOMATION_TYPE,
      RUNTIME_INGEST_TYPE,
      EVENT_TYPES.AUTOMATION_CUSTOM,
    ]) {
      assert.strictEqual(
        await renderCard({ type }, row),
        null,
        `${type} reached an operator who never ticked it — this change must not widen ` +
          'anyone’s delivery set',
      );
    }
  });

  it('delivers the runtime types, and only those, once the operator ticks the catch-all', async () => {
    const row = telegramRow('selected', [REGISTERED_TICKED, UNREGISTERED_EVENTS_SENTINEL]);

    for (const type of [RUNTIME_AUTOMATION_TYPE, RUNTIME_INGEST_TYPE]) {
      assert.ok(
        (await renderCard({ type }, row)) !== null,
        `${type} must reach an operator who ticked the catch-all`,
      );
    }
    assert.ok(
      (await renderCard({ type: REGISTERED_TICKED }, row)) !== null,
      'the ticked registered type must still arrive',
    );
    assert.strictEqual(
      await renderCard({ type: REGISTERED_UNTICKED }, row),
      null,
      `${REGISTERED_UNTICKED} has a tick-box and was not ticked — the catch-all must not ` +
        'deliver it anyway',
    );
  });
});

describe('the card for a type that has no presentation entry', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  it('names the machine type instead of leaving the operator to guess', async () => {
    // Before this line existed the type appeared ONLY inside the `#Event…`
    // hashtag, which strips the dots — so an operator receiving a card for a
    // rule they did not write had no way to find out what fired.
    const card = await renderCard(
      { type: RUNTIME_AUTOMATION_TYPE, message: 'Счёт аннулирован оператором' },
      CATCH_ALL_ROW,
    );
    assert.ok(card !== null, 'the catch-all must deliver this card at all');
    assert.ok(
      card.includes(`🏷 Незарегистрированный тип: <code>${RUNTIME_AUTOMATION_TYPE}</code>`),
      `card did not name the unregistered type:\n${card}`,
    );
    assert.ok(card.includes('Счёт аннулирован оператором'), 'the message is still the headline');
  });

  it('never renders an empty header when the producer sent no message', async () => {
    // `ReceiveSystemEventDto.message` is `@IsString() @MaxLength(2000)` with no
    // `@MinLength`, so an empty string is a valid ingest payload. The header
    // used to be `event.message` verbatim, i.e. `⚙️ <b></b>`.
    const card = await renderCard(
      { type: RUNTIME_INGEST_TYPE, message: '   ' },
      CATCH_ALL_ROW,
    );
    assert.ok(card !== null, 'the catch-all must deliver this card at all');
    assert.ok(!/<b>\s*<\/b>/.test(card), `card rendered an empty header:\n${card}`);
    assert.ok(
      card.includes(RUNTIME_INGEST_TYPE),
      'a card with no message must at least say which type fired',
    );
  });

  it('leaves a registered type’s card exactly as it was', async () => {
    // The degradation above must be confined to the unregistered branch.
    // Ticked explicitly — CATCH_ALL_ROW alone would (correctly) filter this
    // type out, which is asserted as an invariant further up.
    const card = await renderCard(
      { type: REGISTERED_TICKED, message: 'raw machine message' },
      telegramRow('selected', [REGISTERED_TICKED, UNREGISTERED_EVENTS_SENTINEL]),
    );
    assert.ok(card !== null);
    assert.ok(card.includes('Событие: Платёж получен!'));
    assert.ok(!card.includes('raw machine message'));
    assert.ok(
      !card.includes('Незарегистрированный тип'),
      'a registered type must not be labelled unregistered',
    );
  });
});

describe('a runtime type string is not a way to write HTML into an operator chat', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  it('strips markup out of the hashtag instead of emitting it verbatim', async () => {
    // `eventTypeToHashtag` interpolated the type into a `parse_mode: 'HTML'`
    // message with no escaping at all. Both producers behind the catch-all
    // choose that string, and the ingest one is a cross-service boundary, so
    // this was a real injection: the type could close a tag and open its own.
    const card = await renderCard(
      { type: 'evil</b><b>injected', message: 'ingested' },
      CATCH_ALL_ROW,
    );
    assert.ok(card !== null, 'the catch-all must deliver this card at all');

    // Positive first: both places the type appears must be present, or a card
    // that simply dropped the type would pass the negative assertions below.
    assert.ok(
      card.includes('#EventEvilbbinjected'),
      `hashtag was not built from the sanitised type:\n${card}`,
    );
    assert.ok(
      card.includes('<code>evil&lt;/b&gt;&lt;b&gt;injected</code>'),
      `the type line did not escape the payload:\n${card}`,
    );
    assert.ok(
      !card.includes('evil</b>'),
      `raw markup from the event type survived into the card:\n${card}`,
    );
  });

  it('escapes a forged card structure in the message the same way', async () => {
    // The other half of the ingest payload. `message` becomes the header of an
    // unregistered card, so it must not be able to close the blockquote the
    // card is about to open and forge a section of its own.
    const forged = '</blockquote><b>Событие: Платёж получен!</b>';
    const card = await renderCard(
      { type: RUNTIME_INGEST_TYPE, message: forged },
      CATCH_ALL_ROW,
    );
    assert.ok(card !== null, 'the catch-all must deliver this card at all');
    assert.ok(
      card.includes('&lt;/blockquote&gt;&lt;b&gt;'),
      `the forged message was not escaped:\n${card}`,
    );
    assert.ok(!card.includes(forged), `the forged message survived verbatim:\n${card}`);
  });
});

describe('the operator page offers the catch-all the gate honours', () => {
  it('declares the same sentinel string as the backend', () => {
    const source = readFileSync(CATALOGUE_FILE, 'utf8');
    const declaration = /const UNREGISTERED_EVENTS_SENTINEL = '([^']+)'/.exec(source);
    assert.ok(
      declaration !== null,
      `UNREGISTERED_EVENTS_SENTINEL is not declared in ${CATALOGUE_FILE} — the tick-box the ` +
        'delivery gate depends on cannot be rendered, and every runtime-typed event is ' +
        'undeliverable in `selected` mode again',
    );
    assert.strictEqual(
      declaration[1],
      UNREGISTERED_EVENTS_SENTINEL,
      'the page writes a different sentinel than the gate reads — ticking the box would ' +
        'store a string nothing matches',
    );
    assert.ok(
      source.includes('selectedSet.has(UNREGISTERED_EVENTS_SENTINEL)'),
      'the sentinel is declared but no checkbox is bound to it',
    );
  });

  it('keeps the sentinel out of the tick-box catalogue', () => {
    // Inside EVENT_TYPE_CATALOG it would be swept up by "select all", by the
    // never-saved default selection, and by the registry spec that holds the
    // catalogue equal to EVENT_TYPES — i.e. it would default to ON.
    const catalogue = readOperatorCatalogue();
    assert.ok(
      !catalogue.includes(UNREGISTERED_EVENTS_SENTINEL),
      'the catch-all sentinel is inside EVENT_TYPE_CATALOG, so "select all" would tick it',
    );
    assert.ok(
      catalogue.includes(EVENT_TYPES.AUTOMATION_CUSTOM),
      `${EVENT_TYPES.AUTOMATION_CUSTOM} is the automations default and must have a tick-box`,
    );
  });
});

// ── Harness ─────────────────────────────────────────────────────────────────

/** A `Settings` row shaped the way `loadTelegramConfig` reads it. */
function telegramRow(eventsMode: 'all' | 'selected', events: readonly string[]): unknown {
  return {
    systemNotifications: {
      telegram: {
        enabled: false,
        chatId: null,
        devChatId: null,
        eventsMode,
        events: [...events],
      },
    },
  };
}

/** No `Settings` row at all — an operator who never opened the page. */
const NEVER_CONFIGURED = null;

/** `selected` mode with the catch-all ticked and nothing else. */
const CATCH_ALL_ROW = telegramRow('selected', [UNREGISTERED_EVENTS_SENTINEL]);

/**
 * The rendered Telegram card for one event, or `null` when the delivery gate
 * filtered it out.
 *
 * Goes through the real `SystemEventsService` on the token-less dev-fallback
 * path (the same route `system-events-card-format.spec.ts` uses) so the gate,
 * the config reader and the formatter are all the production ones.
 */
async function renderCard(
  event: {
    readonly type: string;
    readonly category?: SystemEventCategory;
    readonly severity?: SystemEventSeverity;
    readonly message?: string;
    readonly metadata?: Record<string, unknown>;
  },
  settingsRow: unknown,
): Promise<string | null> {
  let cardText: string | null = null;
  // The dev firehose rides the durable relay queue now; this suite is about
  // WHICH events get through the selection gate, not which road they take, so
  // capture the card off either one.
  const capture = (event: string, meta: Record<string, unknown>): void => {
    if (event === 'reiwa.dev.notify') cardText = meta['text'] as string;
  };
  const notifier = {
    deliverRelayEvent: async (event: string, meta: Record<string, unknown>) => {
      capture(event, meta);
      return { status: 'unconfirmed', messageId: null, httpStatus: 204, detail: null };
    },
  };
  const relayQueue = {
    enqueue: async (event: string, meta: Record<string, unknown>) => {
      capture(event, meta);
      return true;
    },
  };

  const service = new SystemEventsService(
    {
      settings: { findFirst: async () => settingsRow },
      adminAuditLog: { create: async () => ({}) },
    } as never,
    { enabled: false, urls: [] } as never,
    {
      post: () => {
        throw new Error('Bot API must not be called without a token');
      },
    } as never,
    {
      get: (token: unknown) => {
        if (token === BotNotifierClient) return notifier;
        if (token === ReiwaRelayQueueService) return relayQueue;
        throw new Error('not registered');
      },
    } as never,
  );

  service.emit({
    type: event.type,
    category: event.category ?? 'SYSTEM',
    // INFO on purpose: an ERROR event is rendered by `formatErrorEventCardHtml`,
    // whose header is fixed and never interpolates the type.
    severity: event.severity ?? 'INFO',
    message: event.message ?? 'x',
    metadata: event.metadata ?? {},
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  return cardText;
}

/**
 * The event types the operator's page can draw a tick-box for, read out of the
 * SPA source. Same parse as `system-event-registry.spec.ts`, including its
 * sanity gate — an empty list must be a red test, not silent agreement.
 */
function readOperatorCatalogue(): readonly string[] {
  const source = readFileSync(CATALOGUE_FILE, 'utf8');
  const declaration = source.indexOf('const EVENT_TYPE_CATALOG');
  assert.ok(declaration >= 0, `EVENT_TYPE_CATALOG not found in ${CATALOGUE_FILE}`);

  const open = source.indexOf('= {', declaration) + 2;
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  assert.ok(close > open, 'EVENT_TYPE_CATALOG literal is not brace-balanced');

  const types = [...source.slice(open, close + 1).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(
    types.length > 50 && types.includes('node.connection_lost'),
    `parsed ${types.length} event types out of the catalogue — the parse, not the catalogue, is wrong`,
  );
  return types;
}
