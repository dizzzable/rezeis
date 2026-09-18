/**
 * Tiny JSON-logic-style evaluator used by automation conditions.
 *
 * Why not a real JSON-logic library?
 *   We need a small, well-understood subset that the frontend rule editor
 *   can also render. Pulling a full JSON-logic implementation is overkill
 *   and broadens the attack surface (some operators do things like reach
 *   into prototypes). The 9 operators below cover ~95 % of plausible
 *   automation conditions.
 *
 * Supported operators
 *   { "==": [a, b] }              // strict equality
 *   { "!=": [a, b] }
 *   { ">":  [a, b] } / "<", ">=", "<="
 *   { "in": [needle, haystack] }  // string substring OR array contains
 *   { "and": [c1, c2, ...] }
 *   { "or":  [c1, c2, ...] }
 *   { "not": [c] }
 *
 * Variables
 *   String operands starting with `$` are resolved against the data
 *   object using dot-notation (`$user.id`, `$metadata.severity`). Any
 *   other primitive (string, number, boolean, null) is taken as-is.
 *
 * The evaluator is total: malformed expressions return `false` rather
 * than throwing, so a typo in a rule never crashes the engine.
 */

export type LogicValue = string | number | boolean | null;

export type LogicExpression =
  | LogicValue
  | { readonly [key: string]: LogicExpression[] | LogicExpression };

/**
 * Evaluate `expression` against `data` and return the boolean outcome.
 * Returns `true` when the expression is `null`, `undefined` or `{}`, so an
 * empty conditions field means "always match".
 */
export function evaluateCondition(
  expression: LogicExpression | null | undefined,
  data: Readonly<Record<string, unknown>>,
): boolean {
  if (expression === null || expression === undefined) return true;
  // ── `{}` AT THE TOP IS "NO CONDITIONS" ─────────────────────────────────
  //
  // A rule is saved with `{}` when its conditions box holds just the braces —
  // typed, or an expression cleared down to them — or when an API caller sends
  // it, and the SPA reads `{}` as no conditions everywhere it looks
  // (`trigger-map.ts`, the run dialog). Here it fell into the
  // malformed-expression branch below — an object that is not exactly one
  // operator — and answered false, so such a rule was SKIPPED "conditions did
  // not match" on every run, automatic or manual.
  //
  // That made every such rule a rule that had never run. The migration
  // `20260915160000_automation_rules_empty_conditions_switched_off` switches
  // the enabled event and schedule ones off, with an audit row each, so this
  // line cannot start them on the upgrade: an operator switches one back on
  // after checking what it does.
  //
  // At the TOP only. Nested inside `and`/`or`/`not`, `{}` keeps its old
  // meaning (a malformed operand, false): nothing the editor produces puts one
  // there, and reading a malformed operand as true would widen a hand-written
  // expression rather than narrow it.
  if (isEmptyObject(expression)) return true;
  return Boolean(evaluate(expression, data));
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function evaluate(
  expression: LogicExpression,
  data: Readonly<Record<string, unknown>>,
): unknown {
  if (expression === null || expression === undefined) return null;
  if (typeof expression !== 'object' || Array.isArray(expression)) {
    return resolveValue(expression as LogicValue, data);
  }

  const keys = Object.keys(expression);
  if (keys.length !== 1) return false;
  const op = keys[0];
  const rawArgs = (expression as Record<string, unknown>)[op];
  const args: unknown[] = Array.isArray(rawArgs) ? rawArgs : [rawArgs];

  switch (op) {
    case '==':
      return primitiveEqual(evaluate(args[0] as LogicExpression, data), evaluate(args[1] as LogicExpression, data));
    case '!=':
      return !primitiveEqual(evaluate(args[0] as LogicExpression, data), evaluate(args[1] as LogicExpression, data));
    case '>':
    case '>=':
    case '<':
    case '<=':
      return compare(op, evaluate(args[0] as LogicExpression, data), evaluate(args[1] as LogicExpression, data));
    case 'in':
      return inOp(evaluate(args[0] as LogicExpression, data), evaluate(args[1] as LogicExpression, data));
    case 'and':
      return args.every((arg) => Boolean(evaluate(arg as LogicExpression, data)));
    case 'or':
      return args.some((arg) => Boolean(evaluate(arg as LogicExpression, data)));
    case 'not':
      return !evaluate(args[0] as LogicExpression, data);
    default:
      // Unknown operator → treat the whole expression as `false`. The
      // alternative (throwing) would let a typo in one rule break the
      // engine for every other rule.
      return false;
  }
}

function resolveValue(value: LogicValue, data: Readonly<Record<string, unknown>>): unknown {
  if (typeof value !== 'string') return value;
  if (value.startsWith('$')) {
    const path = value.slice(1);
    return readPath(data, path);
  }
  return value;
}

/**
 * Reads `obj.foo.bar` from a path string using dot-notation. Returns
 * `undefined` whenever any segment is missing — the evaluator coerces
 * that into a falsy value before comparison, which matches operator
 * intuition ("missing field never equals anything but null").
 */
function readPath(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined || typeof obj !== 'object') return undefined;
  const segments = path.split('.');
  let current: unknown = obj;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function primitiveEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Numeric-string equality: `42 == "42"` should match because operators
  // typically express numeric thresholds as numbers but DB values often
  // arrive as strings (BigInt JSON serialisation).
  const an = Number(a);
  const bn = Number(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn) && an === bn) return true;
  return false;
}

function compare(op: '>' | '>=' | '<' | '<=', a: unknown, b: unknown): boolean {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isNaN(an) || Number.isNaN(bn)) return false;
  switch (op) {
    case '>':
      return an > bn;
    case '>=':
      return an >= bn;
    case '<':
      return an < bn;
    case '<=':
      return an <= bn;
  }
}

function inOp(needle: unknown, haystack: unknown): boolean {
  if (typeof haystack === 'string') {
    return haystack.includes(String(needle));
  }
  if (Array.isArray(haystack)) {
    return haystack.some((item) => primitiveEqual(item, needle));
  }
  return false;
}
