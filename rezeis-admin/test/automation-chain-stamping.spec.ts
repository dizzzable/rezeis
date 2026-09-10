import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * THE LOOP GUARD IS ONLY AS GOOD AS THE PLACES THAT STAMP IT.
 *
 * `chain-depth.ts` counts automation hops so a rule cannot feed itself for
 * ever, and `automation-chain-depth.spec.ts` pins both halves of the counting:
 * `chainMetadata` as a pure function, and the bridge refusing to dispatch an
 * exhausted event. Neither joins them. Nothing anywhere constructs the action
 * registry and checks that an emitted event actually carries the depth.
 *
 * That gap is the whole guard: removing `chainMetadata` from the `system_event`
 * handler — the action the guard's own header names as the one that closes a
 * self-loop unaided — left the entire panel suite green.
 *
 * A behavioural test per action would mean building the registry with six
 * collaborators to observe one metadata field. This reads the source instead
 * and asserts the property that matters: every event this file emits carries
 * the stamp. It is a weaker check than a run, and it is the one that fails when
 * somebody adds a fourth emitting action and forgets.
 */

const REGISTRY = readFileSync(
  join(__dirname, '..', 'src', 'modules', 'automations', 'actions', 'action-registry.ts'),
  'utf8',
);

/** `emit`, `info`, `warn` and `error` on the events service — every way out. */
const EMIT_CALL = /this\.systemEventsService\.(emit|info|warn|error)\s*\(/g;

/**
 * The SAME four methods on ANY injected collaborator.
 *
 * `EMIT_CALL` is spelled against one field name, so it is blind by
 * construction to the case it exists to catch: a fourth emitting action wired
 * to its own reference — `this.events`, `this.systemEvents`, a second
 * injection of the same class under another name — emits an unstamped event
 * while `EMIT_CALL` still finds the three old calls and the file stays green.
 * Comparing the two sets turns "the regex missed it" into a failure.
 */
const ANY_EMIT_CALL = /this\.([A-Za-z0-9_$]+)\.(emit|info|warn|error)\s*\(/g;

/**
 * The service parked in a local, which puts the call out of BOTH regexes'
 * reach: `const events = this.systemEventsService; events.emit(...)`.
 */
const ALIASED = /(?:const|let|var)\s+[A-Za-z0-9_$]+\s*=\s*this\.systemEventsService\s*;/;

/** The text of one call, from its opening paren to the matching close. */
function callAt(source: string, openParen: number): string {
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

describe('every action that emits an event', () => {
  const calls = Array.from(REGISTRY.matchAll(EMIT_CALL), (match) => ({
    method: match[1],
    text: callAt(REGISTRY, match.index + match[0].length - 1),
  }));

  it('was found at all', () => {
    // Anti-emptiness anchor. A regex that matched nothing would agree with a
    // registry that stamps nothing — which is the state this file exists to
    // make impossible.
    assert.ok(calls.length >= 3, `found ${calls.length} emit calls in the action registry`);
  });

  it('is the only way out of this file', () => {
    // Anti-BLINDNESS anchor, which is a different thing from the count above:
    // three stamped calls do not mean there are only three.
    const receivers = new Set(
      Array.from(REGISTRY.matchAll(ANY_EMIT_CALL), (match) => match[1]),
    );
    receivers.delete('systemEventsService');
    // `logger.warn` writes a line to stdout and reaches no event stream, so it
    // has nothing to stamp. Named rather than pattern-matched: a receiver that
    // is genuinely inert has to be waved through by hand, once, with a reason.
    receivers.delete('logger');

    assert.deepEqual(
      [...receivers].sort(),
      [],
      'something else in the registry emits, and the check below never looks at it',
    );
    assert.equal(
      ALIASED.test(REGISTRY),
      false,
      'the events service is held in a local, where neither regex can see the call',
    );
  });

  it('stamps the chain depth on what it emits', () => {
    const unstamped = calls.filter((call) => !call.text.includes('chainMetadata('));
    assert.deepEqual(
      unstamped.map((call) => `${call.method}(${call.text.slice(1, 90)}…`),
      [],
      'an action emits an event without the hop count, so a rule can reach itself through it',
    );
  });
});
