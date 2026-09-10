/**
 * event-pattern
 * ─────────────
 * What a rule's trigger spec means, in one place.
 *
 * It used to live in `automation-event-bridge.service.ts`, which is the only
 * place that needed it — until the save-time pop-up check needed the same
 * grammar and could not import it without pulling a NestJS service, its Prisma
 * dependency and the realtime gateway into a pure predicate. It grew a second
 * implementation instead, and the two disagreed on the one wildcard the panel's
 * own help text advertises: `*`.
 *
 * A second opinion about what a pattern means is the shape of defect this whole
 * change set is about. There is one now.
 */

/**
 * Match an event type against a glob-like pattern.
 *
 *   `*`                  → match anything
 *   `payment.*`          → namespace match (`payment` itself, or anything
 *                          starting with `payment.`)
 *   `payment.completed`  → exact match
 *
 * Empty patterns never match — defensive, a rule with no spec is effectively
 * unfinished.
 */
export function matchEventPattern(pattern: string, eventType: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === '*') return true;
  if (trimmed.endsWith('.*')) {
    const prefix = trimmed.slice(0, -2);
    return eventType === prefix || eventType.startsWith(`${prefix}.`);
  }
  return eventType === trimmed;
}
