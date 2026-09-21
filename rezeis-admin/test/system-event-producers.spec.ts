import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const PACKAGE_ROOT = join(__dirname, '..');
const SERVICE = join(PACKAGE_ROOT, 'src/common/services/system-events.service.ts');

/**
 * EVERY REGISTERED EVENT TYPE HAS SOMETHING THAT RAISES IT.
 *
 * `payment.checkout_created` had a name in `EVENT_TYPES`, a title and an emoji
 * in `EVENT_PRESENTATION`, a line in the outbound-webhook list and a tick-box
 * in the operator's Telegram settings — and no producer at all. An operator
 * could tick «Создан счёт на оплату», wait, and conclude the panel was broken.
 * Nothing failed, because nothing was watching: a type nobody raises is
 * indistinguishable, from every other test in this repo, from one that works.
 *
 * So the rule is written down here. A type either has a producer in `src/`, or
 * it is on the list below WITH ITS REASON.
 */

/**
 * Registered, and nothing in `src/` raises it. EMPTY, and it should stay that
 * way.
 *
 * It held four names until 21.09.2026, each with a reason that read
 * plausibly — the audit log already records it, the webhooks page already
 * shows it, nothing watches for it. The owner's answer was that a card an
 * operator can tick and never receive is worse than any of those reasons is
 * good, so all four were built:
 *
 *   payment.webhook_received — `payment-webhook-ingress.service.ts`, once per
 *       ACCEPTED, non-duplicate notification;
 *   promocode.created — `promocode-lifecycle.service.ts`, after the row exists;
 *   promocode.depleted — the same file, at the crossing, under the row lock;
 *   user.role_changed — `admin-admins.controller.ts`, only when authority
 *       actually moved.
 *
 * NOTHING IS ADDED HERE TO MAKE THIS SPEC PASS. If a type belongs to a
 * feature, give it a producer; if it does not, do not register it. A name put
 * back on this list needs its reason written beside it, and the test below
 * will delete it again the moment somebody gives it a producer.
 */
const DECLARED_WITHOUT_PRODUCER: ReadonlySet<string> = new Set<string>([]);

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (entry.endsWith('.ts')) files.push(path);
  }
  return files;
}

/** `NAME: 'dotted.type',` as declared in `EVENT_TYPES`. */
function registeredTypes(): ReadonlyMap<string, string> {
  const source = readFileSync(SERVICE, 'utf8');
  const types = new Map<string, string>();
  for (const match of source.matchAll(/^ {2}([A-Z0-9_]+): '([a-z0-9_.]+)',/gm)) {
    types.set(match[1], match[2]);
  }
  return types;
}

/** True when anything in `corpus` raises `name`/`type`. */
function hasProducer(corpus: string, name: string, type: string): boolean {
  if (new RegExp(`EVENT_TYPES\\.${name}\\b`).test(corpus)) return true;
  const literal = type.replace(/\./g, '\\.');
  return new RegExp(`(info|warn|error)\\(\\s*['"\`]${literal}['"\`]`).test(corpus);
}

describe('every registered system event has a producer', () => {
  const types = registeredTypes();
  const moduleFiles = sourceFiles(join(PACKAGE_ROOT, 'src')).filter((file) => file !== SERVICE);
  const moduleCorpus = moduleFiles.map((file) => readFileSync(file, 'utf8')).join('\n');

  it('reads the table and the tree it checks against', () => {
    // Anchors. An empty offender list below means nothing unless the scan
    // really read something: a rename that breaks either the regex or the
    // path fails HERE, loudly, instead of passing silently forever.
    assert.ok(types.size > 100, `only ${types.size} event types parsed — did EVENT_TYPES move?`);
    assert.ok(moduleFiles.length > 100, `only ${moduleFiles.length} source files found`);
  });

  it('can tell a raised type from an unraised one', () => {
    // The rule, run against known answers, so the assertion below cannot pass
    // by being broken. `payment.completed` is raised in several services.
    assert.equal(hasProducer(moduleCorpus, 'PAYMENT_COMPLETED', 'payment.completed'), true);
    assert.equal(
      hasProducer('nothing in this file raises anything', 'PAYMENT_COMPLETED', 'payment.completed'),
      false,
    );
  });

  it('names every type nobody raises', () => {
    const orphans = [...types]
      .filter(([name]) => !DECLARED_WITHOUT_PRODUCER.has(name))
      .filter(([name, type]) => !hasProducer(moduleCorpus, name, type))
      .map(([name, type]) => `${name} (${type})`);

    assert.deepStrictEqual(orphans, []);
  });

  // The two tests below hold the LIST, and pass trivially while it is empty.
  // They are kept deliberately: the list is one line away from being used
  // again, and the day it is, these are what stop it rotting.
  it('keeps the exception list honest: every name on it is still registered', () => {
    // A type that was deleted must leave this list with it, or the list becomes
    // a graveyard that quietly excuses the next orphan that reuses the name.
    const stale = [...DECLARED_WITHOUT_PRODUCER].filter((name) => !types.has(name));
    assert.deepStrictEqual(stale, []);
  });

  it('holds the exception list to what it is for: a type with a producer must leave it', () => {
    // The opposite mistake, and the one that turns this spec into decoration:
    // a name stays on the list after somebody gives it a producer, and the
    // list stops describing anything.
    const excused = [...DECLARED_WITHOUT_PRODUCER]
      .filter((name) => types.has(name))
      .filter((name) => hasProducer(moduleCorpus, name, types.get(name) as string));

    assert.deepStrictEqual(excused, []);
  });
});
