import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  EVENT_PRESENTATION,
  EVENT_TYPES,
  SystemEventsService,
  type SystemEventCategory,
  type SystemEventSeverity,
} from '../src/common/services/system-events.service';
import { OPERATIONAL_EVENT_TYPES } from '../src/modules/anti-fraud/detectors/remnawave-detectors';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';

/**
 * An emitted event type that nobody registered
 * ────────────────────────────────────────────
 * Registration is not decoration. An event type lives in three places and each
 * one does something different:
 *
 *   1. `EVENT_TYPES` — the shared registry every producer is supposed to draw
 *      from, and the list the other two are kept against.
 *   2. `EVENT_PRESENTATION` — the Telegram card's emoji + title. A type missing
 *      here still sends, but as `severityEmoji` + the raw machine message.
 *   3. the operator's catalogue in `notifications-page.tsx` — the tick-boxes.
 *      Telegram delivery in `selected` mode is an exact-match check against
 *      whatever the operator ticked, so a type that cannot be ticked is a type
 *      that is never delivered in that mode. Not "delivered without a title" —
 *      not delivered.
 *
 * That last one is how the panel-wide HWID average alert lost its Telegram card
 * without anything failing: it used to be a HIGH fraud signal that triggered
 * `notify`, moved to `SystemEventsService` under a new type string, and the new
 * string was in none of the three lists. In `all` mode it looked fine.
 *
 * The three lists were held against each other here from the start and still
 * drifted twenty-seven times, because both original assertions started FROM a
 * registry: `OPERATIONAL_EVENT_TYPES → EVENT_TYPES` and `EVENT_TYPES →
 * catalogue`. A producer that never entered a registry — `service.info('some.
 * thing', …)` — was invisible to both. Sixteen such producers existed. They are
 * gone now, and the assertions below are arranged so the two ways back in are
 * both red:
 *
 *   * a fresh bare literal            → `no producer emits a type …` (call sites)
 *   * a fresh constant, SPA untouched → `no registered type is untickable` /
 *                                       `every registered type has a card`
 *
 * A scan that finds nothing agrees with an empty list forever, so the call-site
 * scanner is itself exercised against a synthetic producer below rather than
 * trusted because the tree happens to be clean today.
 *
 * These tests then prove the whole path end to end on the real service —
 * because a registry that agrees with itself still says nothing about what an
 * operator receives.
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

const SRC_DIR = join(__dirname, '..', 'src');

/**
 * The types this change added to the operator's catalogue.
 *
 * Kept as data for one reason: to reconstruct the selection an operator saved
 * BEFORE the change and prove that none of these reaches them (see «a saved
 * selection is not widened…»). Registering a type makes it tickable; it must
 * not tick it.
 */
const NEWLY_CATALOGUED: readonly string[] = [
  'automation.telegram_notify',
  'broadcast.batch_completed',
  'broadcast.started',
  'client.error',
  'fraud.signal_escalated',
  'fraud.signal_severity_receded',
  'fraud.signal_transitioned',
  'fraud.signals_auto_resolved',
  'import.completed',
  'import.failed',
  'import.plan_assigned',
  'import.sync_enqueued',
  'payment.amount_mismatch',
  'payment.autopay_confirmation_required',
  'payment.fulfillment_recovered',
  'payment.method_autopay_updated',
  'payment.method_saved',
  'payment.method_unbound',
  'payment.notified_amount_short',
  'payment.refund_partial',
  'payment.refunded',
  'promocode.archived',
  'reiwa.error',
  'system.bulk_users_executed',
  'system.restore_completed',
  'trial.claim_late_success_over_cap',
  'user.accounts_merged',
];

describe('the shared event registry against its producers and the operator catalogue', () => {
  it('registers every event type the anti-fraud detectors emit', () => {
    // `AntiFraudService.emitOperationalAlerts` passes `alert.type` straight
    // into `SystemEventsService.emit`, so whatever the detectors declare here
    // is a type that reaches production. An unregistered one has no card, no
    // tick-box, and no way for an operator to ask for it.
    const registered = new Set<string>(Object.values(EVENT_TYPES));
    const unregistered = Object.values(OPERATIONAL_EVENT_TYPES)
      .filter((type) => !registered.has(type))
      .sort();

    assert.deepStrictEqual(
      unregistered,
      [],
      `Detector event types missing from EVENT_TYPES: ${unregistered.join(', ')}. ` +
        'Add them to EVENT_TYPES, EVENT_PRESENTATION and the operator catalogue.',
    );
  });

  it('leaves no registered type untickable in `selected` mode', () => {
    const catalogued = new Set<string>(readOperatorCatalogue());
    const untickable = [...new Set<string>(Object.values(EVENT_TYPES))]
      .filter((type) => !catalogued.has(type))
      .sort();

    assert.deepStrictEqual(
      untickable,
      [],
      `Registered but untickable: ${untickable.join(', ')}. A type added to EVENT_TYPES ` +
        'must be added to EVENT_TYPE_CATALOG in ' +
        'web/src/features/notifications/notifications-page.tsx, in the category its emit ' +
        'site passes — or it is silently undeliverable whenever Telegram delivery runs in ' +
        '`selected` mode. This list was eleven entries long and is deliberately empty: ' +
        'catalogue the type, do not record it here.',
    );
  });

  it('gives every registered type a card of its own', () => {
    // Without an EVENT_PRESENTATION entry the card falls back to
    // `severityEmoji` + `event.message`, i.e. the sentence the producer wrote
    // for a log line. Delivered, but titled with machine text.
    const untitled = [...new Set<string>(Object.values(EVENT_TYPES))]
      .filter((type) => EVENT_PRESENTATION[type] === undefined)
      .sort();

    assert.deepStrictEqual(
      untitled,
      [],
      `Registered but untitled: ${untitled.join(', ')}. Add an EVENT_PRESENTATION entry, ` +
        'or the Telegram card shows the raw machine message as its header.',
    );
  });

  it('catalogues nothing that is not a registered type', () => {
    // The other direction: a tick-box for a string no producer emits is a
    // promise the operator can never collect on, and it silently survives a
    // rename on the backend side.
    const registered = new Set<string>(Object.values(EVENT_TYPES));
    const phantom = readOperatorCatalogue()
      .filter((type) => !registered.has(type))
      .sort();

    assert.deepStrictEqual(
      phantom,
      [],
      `EVENT_TYPE_CATALOG offers tick-boxes for types no producer emits: ${phantom.join(', ')}.`,
    );
  });

  it('leaves no producer emitting an event type as a bare literal', () => {
    // The assertions above all start FROM a registry, so a producer that never
    // joined one is invisible to them. This one starts from the call sites.
    //
    // It rejects EVERY bare literal, not only the unregistered ones. A literal
    // that happens to match a registered value today is the state all sixteen
    // of the originals passed through on their way to drifting: the string is
    // duplicated, so renaming the constant leaves the producer behind and
    // nothing goes red. `EVENT_TYPES.<NAME>` cannot drift from its own value.
    const offenders = [
      ...new Set(
        literalEventProducers().types.map(
          (producer) => `${producer.type} @ ${relativeToRepo(producer.file)}`,
        ),
      ),
    ].sort();

    assert.deepStrictEqual(
      offenders,
      [],
      `Event types emitted as bare string literals:\n  ${offenders.join('\n  ')}\n` +
        'Add a constant to EVENT_TYPES, give it a card in EVENT_PRESENTATION and a tick-box ' +
        'in EVENT_TYPE_CATALOG, and emit it as EVENT_TYPES.<NAME>. In `selected` mode an ' +
        'unregistered type is not delivered at all. This list was sixteen entries long and ' +
        'is deliberately empty: register the type, do not record it here.',
    );
  });

  it('would catch a feature that emits a fresh literal', () => {
    // The gate that matters. The scan above is expected to find NOTHING now, so
    // a broken regex or a mistyped directory would agree with `[]` forever —
    // the exact shape of green test this file exists to stop. Prove the scanner
    // works on source it is handed, independently of what the tree contains.
    const synthetic = [
      "this.systemEventsService.info(",
      "  'billing.invoice_voided',",
      "  'PAYMENT',",
      "  `voided`,",
      ");",
      "this.events.warn('shipping.delayed', 'SYSTEM', 'late');",
      "this.events.emit('quest.streak_broken', 'USER', 'x');",
      // Must NOT be swept up: ordinary logging, and a dotted string that is not
      // the first argument of an emit.
      "this.logger.warn('Fraud signal reconciliation failed');",
      "this.logger.error('remnawave.api timed out');",
      "this.events.info(EVENT_TYPES.USER_BLOCKED, 'USER', 'user.blocked happened');",
    ].join('\n');

    assert.deepStrictEqual(
      [...scanSourceForLiteralProducers(synthetic)].sort(),
      ['billing.invoice_voided', 'quest.streak_broken', 'shipping.delayed'],
      'the call-site scanner no longer detects a bare-literal producer — fix the scanner, ' +
        'because every other assertion in this file trusts it',
    );
  });

  it('scans the real producer tree rather than an empty one', () => {
    // The traversal half of the same gate: the regex can be perfect and still
    // find nothing if the walk visits no files.
    const producers = literalEventProducers();
    assert.ok(
      producers.filesScanned > 200,
      `walked only ${producers.filesScanned} .ts files under src/ — the scan, not the code, is wrong`,
    );
    assert.ok(
      producers.constantProducers.size > 50,
      `found only ${producers.constantProducers.size} EVENT_TYPES.<NAME> producers — ` +
        'the scan, not the code, is wrong',
    );
  });

  it('resolves every EVENT_TYPES.<NAME> a producer names to a titled, tickable type', () => {
    // Call-site side of the constant form. `EVENT_TYPES.FOO` cannot drift from
    // its own value, but the feature that adds one still has to touch the SPA
    // and EVENT_PRESENTATION — six commits in a row did not.
    const catalogued = new Set<string>(readOperatorCatalogue());
    const registry = EVENT_TYPES as Record<string, string>;
    const broken: string[] = [];
    for (const name of [...literalEventProducers().constantProducers].sort()) {
      const value = registry[name];
      if (value === undefined) broken.push(`${name} (not in EVENT_TYPES)`);
      else if (EVENT_PRESENTATION[value] === undefined) broken.push(`${name} (no card)`);
      else if (!catalogued.has(value)) broken.push(`${name} (no tick-box)`);
    }

    assert.deepStrictEqual(
      broken,
      [],
      `Producers reference EVENT_TYPES entries that are not fully registered: ${broken.join(', ')}.`,
    );
  });
});

/**
 * Bare `…info|warn|error|emit('<type>', …)` producers in one source file.
 *
 * Split out from the walk so the regex can be exercised against source this
 * file controls — see «would catch a feature that emits a fresh literal».
 *
 * Deliberately only the direct-literal form. `emit({ type })` with a variable is
 * covered by the detectors' assertion above, and the constant form is covered by
 * `scanSourceForConstantProducers`; matching a bare `type:` property would sweep
 * up unrelated discriminated unions and make this test fail for reasons that are
 * not about event delivery.
 */
function scanSourceForLiteralProducers(source: string): readonly string[] {
  const pattern = /\.\s*(?:info|warn|error|emit)\(\s*\n?\s*'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)'/g;
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

/**
 * Every `EVENT_TYPES.<NAME>` a file names.
 *
 * Not restricted to the argument position of an `info|warn|error|emit` call: the
 * constant reaches `emit` through ternaries (`notification-templates.service`),
 * locals (`partners.service`) and lookup tables (`REMNAWAVE_WEBHOOK_EVENT_MAP`),
 * and a shape-matching regex would quietly miss whichever shape gets written
 * next. `EVENT_TYPES` has exactly one purpose, so every mention of it is a type
 * that must be registered, titled and tickable.
 */
function scanSourceForConstantProducers(source: string): readonly string[] {
  return [...source.matchAll(/EVENT_TYPES\.([A-Z0-9_]+)/g)].map((match) => match[1]);
}

/** `src/modules/x/y.ts` — enough to find the offending call site. */
function relativeToRepo(file: string): string {
  const parts = file.split(/[\\/]/);
  const root = parts.lastIndexOf('src');
  return (root === -1 ? parts : parts.slice(root)).join('/');
}

interface ProducerScan {
  readonly types: readonly { readonly type: string; readonly file: string }[];
  readonly constantProducers: ReadonlySet<string>;
  readonly filesScanned: number;
}

/** Memoised: four assertions share one walk of ~850 files. */
let producerScan: ProducerScan | null = null;

/** Both producer shapes across every `.ts` file under `src/`. */
function literalEventProducers(): ProducerScan {
  if (producerScan !== null) return producerScan;
  const types: { type: string; file: string }[] = [];
  const constantProducers = new Set<string>();
  let filesScanned = 0;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        filesScanned += 1;
        const source = readFileSync(full, 'utf8');
        for (const type of scanSourceForLiteralProducers(source)) types.push({ type, file: full });
        // The registry's own module declares every name; only its consumers
        // say anything about what is actually produced.
        if (full.endsWith('system-events.service.ts')) continue;
        for (const name of scanSourceForConstantProducers(source)) constantProducers.add(name);
      }
    }
  };
  walk(SRC_DIR);
  producerScan = { types, constantProducers, filesScanned };
  return producerScan;
}

describe('an operational alert an operator has ticked', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  it('reaches Telegram with its own card, not the raw detector message', async () => {
    // The operator ticks everything the catalogue offers and runs in `selected`
    // mode — the configuration under which the HWID alert went silent. The
    // selection handed to the service is the SPA's own list, so a type the page
    // cannot render a tick-box for cannot be selected here either.
    const catalogue = readOperatorCatalogue();

    const hwid = await renderOperatorCard(
      {
        type: OPERATIONAL_EVENT_TYPES.REMNAWAVE_HWID_AVERAGE_HIGH,
        category: 'REMNAWAVE',
        severity: 'WARNING',
        message: 'Panel-wide HWID average is 5.4 devices per user',
        metadata: { kind: 'hwid_average', band: 5, averageDevicesPerUser: 5.4 },
      },
      catalogue,
    );
    const geo = await renderOperatorCard(
      {
        type: OPERATIONAL_EVENT_TYPES.NODE_GEO_CONCENTRATION,
        category: 'NODE',
        severity: 'INFO',
        message: '92% of online users (46/50) are connected through DE nodes',
        metadata: { kind: 'geo_concentration', band: 90, country: 'DE' },
      },
      catalogue,
    );

    assert.ok(
      hwid !== null,
      'the panel-wide HWID average alert must survive the `selected` mode filter — ' +
        'this is the alert that lost its Telegram card',
    );
    assert.ok(geo !== null, 'the geo concentration alert must survive the `selected` mode filter');

    // Delivered AND titled: a type missing from EVENT_PRESENTATION arrives as
    // the raw detector sentence, which is written for a log, not for a person.
    assert.ok(hwid.includes('Событие: Среднее число устройств на пользователя выросло!'));
    assert.ok(geo.includes('Событие: Концентрация онлайна в одной стране!'));
    assert.ok(!hwid.includes('Panel-wide HWID average'));
    assert.ok(!geo.includes('92% of online users'));
  });

  it('delivers a refund an operator has now ticked, titled rather than raw', async () => {
    // `payment.refunded` was registered and presented but had no tick-box, so
    // it was undeliverable in `selected` mode however the operator configured
    // the page — the same silence the project already paid to fix once. Proven
    // through the real service so the exported EVENT_PRESENTATION is shown to
    // be the map the card actually reads, not a second copy that agrees.
    const card = await renderOperatorCard(
      {
        type: EVENT_TYPES.PAYMENT_REFUNDED,
        category: 'PAYMENT',
        severity: 'WARNING',
        message: 'Refund/chargeback on fulfilled transaction tx-1 — reversing side-effects',
        metadata: { paymentId: 'pay-1', amount: 49900, currency: 'RUB' },
      },
      readOperatorCatalogue(),
    );

    assert.ok(card !== null, '`payment.refunded` must be deliverable once it is tickable');
    assert.ok(card.includes('Событие: Платёж возвращён!'));
    assert.ok(!card.includes('reversing side-effects'));
  });

  it('does not widen a selection an operator saved before these types existed', async () => {
    // The product invariant of this change: registering a type makes it
    // TICKABLE, never TICKED. A stored selection is an exact-match allow-list,
    // so an operator who saved one before these entries existed must keep
    // receiving exactly what they chose — a new tick-box is not consent.
    const savedBeforeThisChange = readOperatorCatalogue().filter(
      (type) => !NEWLY_CATALOGUED.includes(type),
    );
    assert.ok(
      savedBeforeThisChange.length > 50 && !savedBeforeThisChange.includes('payment.refunded'),
      'the reconstructed pre-change selection is wrong, so this test proves nothing',
    );

    for (const type of ['payment.refunded', 'payment.amount_mismatch', 'client.error']) {
      const card = await renderOperatorCard(
        {
          type,
          category: 'PAYMENT',
          severity: 'WARNING',
          message: 'x',
          metadata: {},
        },
        savedBeforeThisChange,
      );
      assert.strictEqual(
        card,
        null,
        `${type} reached an operator who never ticked it — registering a type must not ` +
          'retroactively start delivering it',
      );
    }
  });

  it('still delivers everything to an operator who never narrowed the list', async () => {
    // The `all`-mode counterpart, and the reason the change is safe rather than
    // merely conservative: an operator in `all` mode (the default for anyone
    // who never opened the page) was ALREADY receiving these types — untitled.
    // The set they receive must be unchanged.
    const card = await renderOperatorCard(
      {
        type: EVENT_TYPES.PAYMENT_REFUNDED,
        category: 'PAYMENT',
        severity: 'WARNING',
        message: 'x',
        metadata: {},
      },
      [],
      'all',
    );
    assert.ok(card !== null, '`all` mode must keep delivering every type, selection ignored');
  });
});

/**
 * The event types the operator's page can draw a tick-box for.
 *
 * Read out of the SPA source rather than duplicated here: a copy would agree
 * with itself forever while the page drifted, which is the failure this file
 * exists to catch.
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
  // Sanity gate on the parse itself: if the page is restructured so this stops
  // reading the catalogue, that must be a red test and not an empty list quietly
  // agreeing with everything.
  assert.ok(
    types.length > 50 && types.includes('node.connection_lost'),
    `parsed ${types.length} event types out of the catalogue — the parse, not the catalogue, is wrong`,
  );
  return types;
}

/** The rendered Telegram card for one event, or `null` when it was filtered out. */
async function renderOperatorCard(
  event: {
    readonly type: string;
    readonly category: SystemEventCategory;
    readonly severity: SystemEventSeverity;
    readonly message: string;
    readonly metadata: Record<string, unknown>;
  },
  selectedEvents: readonly string[],
  eventsMode: 'all' | 'selected' = 'selected',
): Promise<string | null> {
  let cardText: string | null = null;
  const notifier = {
    notifyDev: async (input: { text: string }) => {
      cardText = input.text;
    },
    notifyDevDocument: async () => undefined,
  };

  const service = new SystemEventsService(
    {
      settings: {
        findFirst: async () => ({
          systemNotifications: {
            telegram: {
              enabled: false,
              chatId: null,
              devChatId: null,
              eventsMode,
              events: [...selectedEvents],
            },
          },
        }),
      },
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
        throw new Error('not registered');
      },
    } as never,
  );

  // Emitted exactly as `AntiFraudService.emitOperationalAlerts` does it.
  service.emit(event);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return cardText;
}
