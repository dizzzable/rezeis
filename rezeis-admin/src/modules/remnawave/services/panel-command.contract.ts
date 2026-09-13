import type { ZodType } from 'zod';

/**
 * What a panel command is, structurally
 * ═════════════════════════════════════
 * One entry of the hand-owned table in `panel-commands.ts`: the path, the verb,
 * a human description, and the schemas for the inputs WE send. Everything a
 * call needs, which is what keeps `PanelCommandExecutor` generic instead of
 * twenty-one hand-written request helpers.
 *
 *   PANEL_COMMANDS.UpdateUserCommand.url           '/api/users/'
 *   PANEL_COMMANDS.UpdateUserCommand.method        'patch'
 *   PANEL_COMMANDS.UpdateUserCommand.body          zod — what the executor sends
 *
 * WHY THESE ARE OURS AND NOT THE VENDOR'S. They used to be the command objects
 * of `@remnawave/backend-contract`, shipped in the runtime image. Two costs came
 * with that, and neither bought anything a table of twenty-one entries cannot:
 *
 *   • one contract describes ONE panel release, while the fleet runs 3.2 through
 *     3.4 at once. Its response schemas were executed against every answer, so a
 *     field a later contract made required logged "drift" on every healthy older
 *     panel, and the pin could never move past the release that did it;
 *   • the package is AGPL-3.0-only and it rode into the published image.
 *
 * The request side of the twenty-one commands rezeis actually issues is
 * identical across every 3.x contract the fleet runs, so owning it costs a
 * table, and `test/panel-command-conformance.spec.ts` holds that table to EVERY
 * era's contract at build time — the vendor stays the authority, just not a
 * passenger. Responses are no longer validated here at all: the clients read
 * the panel's JSON with their own tolerant guards (see the consumer notes in
 * `panel-devices.client.ts` and `panel-infra.client.ts`).
 *
 * Deliberately LOOSE about which schemas are present: a GET by id has `params`
 * and no body, a create has a body and no params, and several have neither.
 */
export interface PanelCommand {
  /** Full path, or a builder for the routes that carry one path segment. */
  readonly url: string | ((segment: string) => string);
  readonly method: PanelMethod;
  /** The panel's own name for the endpoint. Appears in refusals, never on the wire. */
  readonly description: string;
  /**
   * The request body this command accepts. The executor validates against it
   * and SENDS THE PARSED OUTPUT, so defaults, key order and transforms declared
   * here reach the wire — see `test/panel-wire-bytes.spec.ts`.
   */
  readonly body?: ZodType;
  /** The path parameter, checked by the client before it becomes a path segment. */
  readonly params?: ZodType;
  /** The query string, checked by the client where the panel caps a value. */
  readonly query?: ZodType;
}

/** The verbs the panel actually uses. Anything else is a table we mistyped. */
export const PANEL_METHODS = ['get', 'post', 'patch', 'put', 'delete'] as const;
export type PanelMethod = (typeof PANEL_METHODS)[number];

export function isPanelMethod(value: string): value is PanelMethod {
  return (PANEL_METHODS as readonly string[]).includes(value);
}

/**
 * Resolve a command's path.
 *
 * `url` is a plain string for collection routes and a builder for the ones that
 * carry a path segment. Every builder in the table takes exactly ONE segment, so
 * a call that supplies none or several is a caller and a route that disagree —
 * and failing loudly beats building `/api/users/undefined`.
 */
export function resolveCommandUrl(command: PanelCommand, parts: readonly string[]): string {
  if (typeof command.url === 'string') {
    if (parts.length > 0) {
      throw new Error(
        `Command path takes no parameters but ${parts.length} were supplied — ` +
          'the caller and the route table disagree about this route',
      );
    }
    return command.url;
  }
  if (parts.length !== 1) {
    throw new Error(
      `Command path takes one parameter but ${parts.length} were supplied — ` +
        'the caller and the route table disagree about this route',
    );
  }
  return command.url(parts[0] as string);
}

/**
 * A short, log-safe rendering of a zod failure. Never includes the value.
 *
 * The MESSAGE only: a zod issue can carry `received`, and for a request that is
 * our own payload — on this integration customer emails and telegram ids — and
 * this string goes to the log and, on the enforcement path, to an operator.
 * Shared by the executor and the clients so a refusal reads the same whichever
 * layer made it.
 */
export function describeIssues(error: { readonly issues?: ReadonlyArray<unknown> }): string {
  const issues = Array.isArray(error.issues) ? error.issues : [];
  const rendered = issues.slice(0, 5).map((issue) => {
    const record = issue as { path?: unknown; message?: unknown };
    const path =
      Array.isArray(record.path) && record.path.length > 0 ? record.path.join('.') : '(root)';
    const message = typeof record.message === 'string' ? record.message : 'invalid';
    return `${path}: ${message}`;
  });
  const suffix = issues.length > rendered.length ? ` (+${issues.length - rendered.length} more)` : '';
  return rendered.length === 0 ? 'no detail' : `${rendered.join('; ')}${suffix}`;
}
