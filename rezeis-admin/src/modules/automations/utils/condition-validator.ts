/**
 * What a rule's conditions may be, decided against what
 * `expression-evaluator.ts` actually does with them.
 *
 * ── Why the evaluator cannot be the check ────────────────────────────────────
 *
 * The evaluator is total by design: a typo must never take the engine down for
 * every other rule. So everything it does not understand collapses to `false`
 * without a word — an unknown operator, an object with two keys, `{}` inside an
 * expression — and an arity it does not expect is read as `undefined` operands.
 * A rule saved with any of those is a rule that is SKIPPED "conditions did not
 * match" on every run, for ever, and the only place that says so is a run log
 * the operator may never open. Refused at save, it is said while they are still
 * looking at the form.
 *
 * ── What is accepted, precisely ──────────────────────────────────────────────
 *
 *   top level   `null` (no conditions), `{}` (no conditions — the evaluator
 *               special-cases it), or one condition;
 *   operation   an object with exactly ONE key, the operator:
 *                 `==` `!=` `>` `>=` `<` `<=` `in` — a list of exactly two
 *                   operands;
 *                 `and` `or` — a list of at least one condition, or one
 *                   condition on its own;
 *                 `not` — one condition, alone or in a one-item list (the
 *                   evaluator wraps a bare operand itself);
 *   operand     a string, number, boolean or null; a `$path` variable; a nested
 *               operation; or — only as the second operand of `in` — a list of
 *               plain values, which the evaluator compares item by item;
 *   condition   (inside `and` / `or` / `not`) an operation, a `$path` variable
 *               (its truthiness) or a boolean. A plain string, number or null
 *               there is refused: it is always true or always false, and it is
 *               almost always a comparison with its operator forgotten;
 *   variable    `$` followed by dot-separated names, none empty and none of
 *               `__proto__`, `prototype`, `constructor` — the evaluator reads
 *               any property, and those are not data.
 *
 * Plus two ceilings on what a pasted blob can cost on every event:
 * `CONDITION_MAX_DEPTH`, so no evaluation recurses thousands of frames deep,
 * and `CONDITION_MAX_NODES`, so none walks an unbounded tree. The second is
 * set far above anything written by hand, deliberately: a list of a few
 * thousand customer ids for `in`, or a few hundred comparisons, is a real
 * condition and must pass.
 */

export const CONDITION_COMPARISON_OPERATORS = ['==', '!=', '>', '>=', '<', '<=', 'in'] as const;
export const CONDITION_LOGICAL_OPERATORS = ['and', 'or', 'not'] as const;
export const CONDITION_OPERATORS: readonly string[] = [
  ...CONDITION_COMPARISON_OPERATORS,
  ...CONDITION_LOGICAL_OPERATORS,
];

/** Operations nested inside one another, the top one included. */
export const CONDITION_MAX_DEPTH = 16;
/**
 * Every value in the tree, operations and operands alike — each item of an
 * `in` list included. Ten thousand is a bound on cost, not on intent: a
 * ceiling in the hundreds would refuse an `in` list of a few hundred customer
 * ids, or an `or` of some sixty comparisons.
 */
export const CONDITION_MAX_NODES = 10_000;

const FORBIDDEN_PATH_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

/** The first thing wrong with a set of conditions: where, and what. */
export interface ConditionProblem {
  /** A JSON pointer into the conditions (`/and/1/==/0`); empty for the top level. */
  readonly pointer: string;
  readonly problem: string;
}

class Problem extends Error {
  public constructor(
    public readonly pointer: string,
    public readonly problem: string,
  ) {
    super(problem);
  }
}

interface Walk {
  nodes: number;
}

/** The first problem with `conditions`, or null when the evaluator understands all of it. */
export function findConditionProblem(conditions: unknown): ConditionProblem | null {
  if (conditions === null || conditions === undefined) return null;
  if (isPlainObject(conditions) && Object.keys(conditions).length === 0) return null;
  try {
    // The top level is a condition like any other: `evaluateCondition` takes
    // the truth of whatever it is handed.
    checkCondition(conditions, '', 0, { nodes: 0 });
    return null;
  } catch (err) {
    if (err instanceof Problem) return { pointer: err.pointer, problem: err.problem };
    throw err;
  }
}

/** The refusal sentence for a problem. */
export function describeConditionProblem(found: ConditionProblem): string {
  const where = found.pointer.length === 0 ? 'the top level' : found.pointer;
  return `Conditions: at ${where}, ${found.problem}`;
}

function checkOperation(value: unknown, pointer: string, depth: number, walk: Walk): void {
  count(walk, pointer);
  if (depth > CONDITION_MAX_DEPTH) {
    throw new Problem(pointer, `conditions are nested more than ${CONDITION_MAX_DEPTH} levels deep`);
  }
  if (!isPlainObject(value)) {
    throw new Problem(pointer, 'expected an object with exactly one operator');
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    throw new Problem(pointer, 'expected an object with exactly one operator');
  }
  const operator = keys[0];
  const args = value[operator];
  const here = `${pointer}/${escapePointer(operator)}`;
  if ((CONDITION_COMPARISON_OPERATORS as readonly string[]).includes(operator)) {
    if (!Array.isArray(args) || args.length !== 2) {
      throw new Problem(here, `"${operator}" takes exactly 2 operands, in a list`);
    }
    count(walk, here);
    checkOperand(args[0], `${here}/0`, depth, walk, false);
    checkOperand(args[1], `${here}/1`, depth, walk, operator === 'in');
    return;
  }
  if (operator === 'and' || operator === 'or') {
    // A bare condition is wrapped by the evaluator, exactly as for `not`. An
    // EMPTY list is not: `and: []` matches everything and `or: []` nothing,
    // for ever, which is a half-typed box rather than a rule anybody meant.
    if (!Array.isArray(args)) {
      checkCondition(args, here, depth, walk);
      return;
    }
    if (args.length === 0) {
      throw new Problem(here, `"${operator}" needs a list of at least one condition`);
    }
    count(walk, here);
    args.forEach((condition, index) => checkCondition(condition, `${here}/${index}`, depth, walk));
    return;
  }
  if (operator === 'not') {
    // The evaluator wraps a bare operand in a list itself, so `{ "not": {...} }`
    // and `{ "not": [{...}] }` mean the same — and anything else is a second
    // operand it would silently ignore.
    if (Array.isArray(args)) {
      if (args.length !== 1) throw new Problem(here, '"not" takes exactly one condition');
      count(walk, here);
      checkCondition(args[0], `${here}/0`, depth, walk);
      return;
    }
    checkCondition(args, here, depth, walk);
    return;
  }
  throw new Problem(pointer, unknownOperator(operator));
}

/** Something whose truth decides: inside `and`, `or` and `not`. */
function checkCondition(value: unknown, pointer: string, depth: number, walk: Walk): void {
  if (typeof value === 'boolean') {
    count(walk, pointer);
    return;
  }
  if (typeof value === 'string' && value.startsWith('$')) {
    count(walk, pointer);
    checkVariable(value, pointer);
    return;
  }
  if (isPlainObject(value)) {
    checkOperation(value, pointer, depth + 1, walk);
    return;
  }
  if (Array.isArray(value)) {
    throw new Problem(pointer, 'a list is allowed only as the second operand of "in"');
  }
  throw new Problem(
    pointer,
    'a plain value cannot stand for a condition: it is always true or always false; compare it, for example with "=="',
  );
}

/** A value being compared: an operand of `==`, `>`, `in` and the rest. */
function checkOperand(
  value: unknown,
  pointer: string,
  depth: number,
  walk: Walk,
  listAllowed: boolean,
): void {
  if (Array.isArray(value)) {
    if (!listAllowed) throw new Problem(pointer, 'a list is allowed only as the second operand of "in"');
    count(walk, pointer);
    value.forEach((item, index) => {
      count(walk, `${pointer}/${index}`);
      if (!isPlainValue(item)) {
        throw new Problem(`${pointer}/${index}`, 'a list for "in" may hold only plain values');
      }
    });
    return;
  }
  if (isPlainObject(value)) {
    checkOperation(value, pointer, depth + 1, walk);
    return;
  }
  if (!isPlainValue(value)) {
    throw new Problem(pointer, 'expected a plain value, a "$" variable or an operation');
  }
  count(walk, pointer);
  if (typeof value === 'string' && value.startsWith('$')) checkVariable(value, pointer);
}

function checkVariable(value: string, pointer: string): void {
  const segments = value.slice(1).split('.');
  const usable = segments.every(
    (segment) => segment.length > 0 && !FORBIDDEN_PATH_SEGMENTS.has(segment),
  );
  if (!usable) throw new Problem(pointer, 'the variable is not a usable path: "$" and names separated by dots');
}

function count(walk: Walk, pointer: string): void {
  walk.nodes += 1;
  if (walk.nodes > CONDITION_MAX_NODES) {
    throw new Problem(pointer, `conditions have more than ${CONDITION_MAX_NODES} parts`);
  }
}

function unknownOperator(operator: string): string {
  const known = CONDITION_OPERATORS.join(', ');
  // Echoed only when it is short and looks like an operator: the sentence
  // travels through a response filter that swallows anything resembling a
  // secret, and a pasted blob is no use to read back anyway.
  return /^[\w$<>=!.-]{1,24}$/.test(operator)
    ? `unknown operator "${operator}" (known: ${known})`
    : `unknown operator (known: ${known})`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** RFC 6901: `~` and `/` inside a key. */
function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}
