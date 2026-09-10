/**
 * chain-depth
 * ───────────
 * How far an event is from the thing that actually happened, and the stop that
 * keeps a rule from feeding itself.
 *
 * ── Why a cycle is reachable at all ──────────────────────────────────────────
 *
 * Every emitted event goes back into rule matching. `SystemEventsService.emit`
 * calls `deliverRealtime`, which is the only caller of
 * `RealtimeGateway.broadcast`, and the automations bridge monkey-patches that
 * method so every broadcast is also dispatched into the matcher. Three actions
 * emit: `system_event` (a FREE-FORM type read from the rule's own params),
 * `notify_telegram`, and `block_user`.
 *
 * So a single rule closes a loop with no wildcard and no second rule:
 * `triggerSpec: 'automation.*'` with `{type: 'system_event', params: {type:
 * 'automation.custom'}}` runs for ever. Two rules close one without any
 * wildcard at all — A emits Y, B triggers on Y and emits X, A triggers on X.
 *
 * Every lap costs a queue job, an `automation_executions` INSERT, an
 * `automation_rules` UPDATE, an audit-log write, a Telegram delivery attempt
 * and an outbound webhook POST. Nothing in the module counted hops, and rule
 * chaining is a DOCUMENTED, deliberate feature — so this cannot be solved by
 * refusing to chain.
 *
 * ── What is counted, and what is not ─────────────────────────────────────────
 *
 * The depth rides in the metadata of the event an action emits, so it counts
 * ONE thing: how many automation hops separate this event from a real one.
 * Something that happened in the world — a payment, a registration, a webhook —
 * carries no depth at all and starts at zero. Two rules chained deliberately
 * still work; a rule that reaches itself runs out of hops instead of running
 * out of database.
 *
 * The limit is deliberately small. A chain four hops long is not a workflow
 * anybody drew on purpose, and the point of a cap is to be reached by mistakes
 * rather than by designs.
 */

/**
 * Where the hop count rides.
 *
 * In the metadata rather than beside it because that is the only part of the
 * payload that survives the whole route: the bridge projects the event into
 * `triggerData`, the executor hands that to the action, and the action puts a
 * fresh metadata object on whatever it emits. A field anywhere else would have
 * to be threaded through three interfaces that all belong to other concerns.
 *
 * The name is prefixed so it cannot collide with a domain field, and it is
 * plain enough to be recognisable in an audit row — an operator looking at a
 * runaway chain should be able to see the number climbing.
 */
export const AUTOMATION_CHAIN_DEPTH_KEY = 'automationChainDepth';

/**
 * Hops allowed before an event stops being dispatched to rules.
 *
 * Four, because two is a chain somebody built (a rule raises a custom type and
 * a second rule acts on it) and four is room for one more link than anybody has
 * asked for. A cycle reaches it in four laps instead of never.
 */
export const AUTOMATION_CHAIN_DEPTH_LIMIT = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * How many automation hops produced this event.
 *
 * Zero for anything that came from the world rather than from a rule, and zero
 * for a value that is not a sane count — a negative or a fractional depth is a
 * payload somebody built by hand, and treating it as "fresh" is the reading
 * that cannot be used to bypass the cap.
 */
export function chainDepthOf(metadata: unknown): number {
  if (!isRecord(metadata)) return 0;
  const raw = metadata[AUTOMATION_CHAIN_DEPTH_KEY];
  const depth = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isInteger(depth) || depth <= 0) return 0;
  return Math.min(depth, AUTOMATION_CHAIN_DEPTH_LIMIT);
}

/**
 * The rule that emitted this event, when one did.
 *
 * `chainMetadata` already writes `ruleId` beside the depth, and the guard that
 * stops an exhausted chain was logging neither — an operator was told a limit
 * was hit and given no way to find what hit it.
 */
export function chainOriginOf(metadata: unknown): string | null {
  if (!isRecord(metadata)) return null;
  const ruleId = metadata['ruleId'];
  return typeof ruleId === 'string' && ruleId.length > 0 ? ruleId : null;
}

/** True when this event has travelled far enough and must not fire more rules. */
export function chainExhausted(metadata: unknown): boolean {
  return chainDepthOf(metadata) >= AUTOMATION_CHAIN_DEPTH_LIMIT;
}

/**
 * The hop count alone, for carrying a chain across a boundary that is not an
 * automation hop.
 *
 * A relay job, for instance: it is the SAME chain travelling through a queue,
 * so the count neither increases nor resets. Returns an empty object when
 * there is nothing to carry, so it can be spread unconditionally.
 */
export function chainDepthMetadata(metadata: unknown): Record<string, unknown> {
  const depth = chainDepthOf(metadata);
  return depth === 0 ? {} : { [AUTOMATION_CHAIN_DEPTH_KEY]: depth };
}

/**
 * The metadata every action puts on an event it emits.
 *
 * One helper rather than the same three fields written out in three handlers:
 * they were already identical, and the depth is the fourth thing that has to be
 * on all of them or the cap has a hole exactly the shape of whichever handler
 * was forgotten.
 */
export function chainMetadata(context: {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly trigger: string;
  readonly triggerData: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    ruleId: context.ruleId,
    ruleName: context.ruleName,
    trigger: context.trigger,
    [AUTOMATION_CHAIN_DEPTH_KEY]: chainDepthOf(context.triggerData['metadata']) + 1,
  };
}
