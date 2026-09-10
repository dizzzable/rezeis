import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  POPUP_CAPABLE_EVENTS,
  canCarryPopup,
} from '../src/modules/automations/popup-capable-events';
import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { resolveTriggerUserId } from '../src/modules/automations/actions/action-registry';

/**
 * THE LIST THAT SAYS WHICH EVENTS CAN CARRY A POP-UP, CHECKED AGAINST REALITY.
 *
 * A hand-written list is only worth having if something proves it. The one it
 * replaces was a regex — `/^(payment|subscription|user|promocode)\./` — living
 * in a test named "fires only on events that name a customer", and it passed on
 * all four of the shipped templates that could never fire.
 *
 * Two properties have to hold for every entry, and they fail in opposite ways:
 *
 *   EMITTED. A rule bound to a type nothing emits is never selected by the
 *   pattern filter, so it produces no execution row, no error and no log line.
 *   It is the quietest failure in the subsystem — the rule reads "enabled" for
 *   ever.
 *
 *   NAMES A CUSTOMER. An event that is emitted but carries no customer fails
 *   loudly, at firing time, after the moment has passed.
 *
 * The Remnawave family is checked BEHAVIOURALLY rather than by reading source,
 * because its type does not appear at the emit call at all — it is looked up in
 * a table and dereferenced as `mapped.type`. A source scan cannot see that, and
 * a source scan that guessed would be the same class of thing it is replacing.
 */

const ROOT = join(__dirname, '..');
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

describe('every event the list calls pop-up capable', () => {
  it('has entries at all', () => {
    // Anti-emptiness anchor: an empty list makes every loop below pass by
    // iterating nothing, which is the shape of a test that watches nothing.
    assert.ok(POPUP_CAPABLE_EVENTS.length >= 10);
  });

  it('names a type the panel actually declares', () => {
    const declared = new Set<string>(Object.values(EVENT_TYPES));
    for (const event of POPUP_CAPABLE_EVENTS) {
      assert.ok(
        declared.has(event.type),
        `${event.type} is not in EVENT_TYPES — a trigger nothing can ever emit`,
      );
    }
  });

  it('points at a file that EMITS it, not merely one that names it', () => {
    // A MENTION IS NOT AN EMIT, and the weaker check let the whole failure back
    // in. Pointing `emittedIn` at `system-events.service.ts` — where every type
    // is DECLARED — satisfied "the file mentions it" for any type at all,
    // including `subscription.renewed`, which is declared and emitted from
    // nowhere. That is exactly the silent rule this list exists to prevent, and
    // the list's own guard would have waved it through.
    //
    // So the file must both name the type AND call an emitter. The Remnawave
    // family is the one exception, checked behaviourally by
    // `remnawave-webhook-names-the-customer.spec.ts` instead: its type never
    // appears at the emit call — it is looked up in a table and dereferenced as
    // `mapped.type` — so no source scan can see it, and one that guessed would
    // be the same class of thing this list replaces.
    const EMITTER = /(systemEvents|systemEventsService|events)\s*\.\s*(emit|info|warn|error)\s*\(/;
    for (const event of POPUP_CAPABLE_EVENTS) {
      const source = read(event.emittedIn);
      const constantName = Object.entries(EVENT_TYPES).find(([, value]) => value === event.type)?.[0];
      assert.ok(constantName, `${event.type} has no EVENT_TYPES constant`);
      assert.ok(
        source.includes(`EVENT_TYPES.${constantName}`) || source.includes(`'${event.type}'`),
        `${event.emittedIn} does not mention ${event.type}`,
      );
      assert.match(
        source,
        EMITTER,
        `${event.emittedIn} names ${event.type} but emits nothing — a rule bound to it ` +
          'would never be selected, and would read "enabled" for ever',
      );
    }
  });

  /**
   * The EMIT CALL, not the file it lives in.
   *
   * Scanning the whole file was the defect. `userId` appears sixteen times in
   * `internal-user-edge.service.ts` for unrelated reasons, so swapping
   * `user.registered`'s `namedBy` from `reiwaId` to `userId` — which would
   * break every welcome pop-up at firing time, because the resolver reads the
   * key the emitter actually writes — left this file green. That is the exact
   * mutation the case's own comment claimed to have closed.
   */
  function emitCallsNaming(source: string, constantName: string): string[] {
    const needle = `EVENT_TYPES.${constantName}`;
    const calls: string[] = [];
    for (const match of source.matchAll(new RegExp(needle.replace('.', '\\.'), 'g'))) {
      // Walk out to the innermost call that contains this reference.
      let open = source.lastIndexOf('(', match.index);
      while (open > 0) {
        const call = balancedFrom(source, open);
        if (call.includes(needle)) {
          calls.push(call);
          break;
        }
        open = source.lastIndexOf('(', open - 1);
      }
    }
    return calls;
  }

  function balancedFrom(source: string, openParen: number): string {
    let depth = 0;
    for (let index = openParen; index < source.length; index += 1) {
      const character = source[index];
      if (character === '(' || character === '[' || character === '{') depth += 1;
      else if (character === ')' || character === ']' || character === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(openParen, index + 1);
      }
    }
    return source.slice(openParen);
  }

  /**
   * Entries whose customer key is attached AWAY from the emit call, and where.
   *
   * Two shapes, both real: the Remnawave enrichment builds the whole metadata
   * object in `enrichUserMetadata`, and the anti-fraud service builds its
   * payload in `buildFraudNotifyPayload` before the emit. Neither call site
   * names a key, so a call-scoped scan cannot see one.
   *
   * LISTED, not inferred. A new entry that quietly stops naming its key at the
   * call is then a failure rather than a silent addition here — which is the
   * difference between an exception and a hole.
   */
  const NAMED_ELSEWHERE = new Map([
    ['user.first_traffic', 'enrichUserMetadata builds the metadata'],
    ['fraud.signal_opened', 'buildFraudNotifyPayload sets payload.fraudRezeisUserId'],
  ]);

  it('names the customer under the key it claims, at the emit call', () => {
    const constantOf = new Map(
      Object.entries(EVENT_TYPES).map(([name, type]) => [type as string, name]),
    );
    const offenders: string[] = [];

    for (const event of POPUP_CAPABLE_EVENTS) {
      if (event.type.startsWith('remnawave.') || NAMED_ELSEWHERE.has(event.type)) continue;
      const constantName = constantOf.get(event.type);
      assert.ok(constantName, `${event.type} has no EVENT_TYPES constant`);

      const calls = emitCallsNaming(read(event.emittedIn), constantName);
      assert.ok(calls.length > 0, `${event.emittedIn} does not emit ${event.type}`);

      // `key: value` or the shorthand `key,` — the OAuth registration path
      // writes `userId,` with no colon, and a pattern that only knew the
      // colon form would call a true entry a defect.
      const names = new RegExp(String.raw`\b${event.namedBy}\s*[:=,}]`);
      const silent = calls.filter((call) => !names.test(call));
      if (silent.length === calls.length) {
        offenders.push(`${event.type} promises ${event.namedBy} and its emit call writes none`);
      }
    }

    assert.deepEqual(offenders, []);
  });

  it('is refused by nothing the runtime would refuse', () => {
    // The list's whole claim, expressed through the runtime's own resolver: an
    // event carrying the key this entry promises must resolve to a customer.
    for (const event of POPUP_CAPABLE_EVENTS) {
      const metadata =
        event.namedBy === 'affectedUserIds'
          ? { affectedUserIds: ['u-1'] }
          : { [event.namedBy]: 'u-1' };
      assert.equal(
        resolveTriggerUserId({}, { metadata }),
        'u-1',
        `${event.type} promises to name the customer under ${event.namedBy}, which the resolver does not read`,
      );
    }
  });
});

describe('the trigger every ready-made pop-up binds to', () => {
  /**
   * The templates live in the SPA and this is the API's test suite, so the
   * triggers are parsed out of the SPA source rather than imported. That is the
   * same reach across the package boundary `hint-templates-server-contract`
   * makes in the other direction, and for the same reason: the two halves ship
   * in one image and nothing else compares them.
   */
  const TEMPLATES = read('web/src/features/automations/hint-templates.ts');
  const triggers = Array.from(
    TEMPLATES.matchAll(/triggerSpec:\s*'([^']+)'/g),
    (match) => match[1],
  );

  it('was found at all', () => {
    assert.ok(triggers.length >= 8, `parsed ${triggers.length} triggers out of hint-templates.ts`);
  });

  it('can carry a pop-up', () => {
    const dead = triggers.filter((trigger) => !canCarryPopup(trigger));
    assert.deepEqual(
      dead,
      [],
      'these ready-made pop-ups are bound to triggers that cannot fire one',
    );
  });
});

describe('canCarryPopup', () => {
  it('accepts a wildcard that covers at least one capable event', () => {
    assert.equal(canCarryPopup('remnawave.user.*'), true);
    assert.equal(canCarryPopup('payment.*'), true);
  });

  it('refuses a wildcard that covers none', () => {
    assert.equal(canCarryPopup('node.*'), false);
  });

  it('refuses an empty trigger, which is what MANUAL rules carry', () => {
    assert.equal(canCarryPopup(''), false);
    assert.equal(canCarryPopup('   '), false);
  });

  it('accepts the bare wildcard the rule editor advertises', () => {
    // `*` matches everything at run time, so a pop-up rule written that way
    // fires on every capable event. Refusing it was a second, wrong copy
    // of the pattern grammar; `matchEventPattern` is the only copy now.
    assert.equal(canCarryPopup('*'), true);
  });

  it('refuses three of the four names the shipped templates used to carry', () => {
    // The fourth, `subscription.trial_granted`, is legitimately capable now —
    // this change set gave it an emitter. It cannot be in this list.
    //
    // Two of these are types declared and emitted from nowhere; one is a key of
    // Remnawave's own webhook map rather than an event type at all.
    for (const dead of [
      'subscription.expired',
      'user.expire_soon',
      'user.bandwidth_usage_threshold_reached',
    ]) {
      assert.equal(canCarryPopup(dead), false, `${dead} must not be considered capable`);
    }
  });
});
