import type { ZodType } from 'zod';

/**
 * What a contract command is, structurally
 * ════════════════════════════════════════
 * `@remnawave/backend-contract` ships 218 of these. Each one carries
 * everything a call needs — the path, the verb, and the schemas for both
 * directions — which is what makes the executor generic instead of 48
 * hand-written methods:
 *
 *   UpdateUserCommand.url                              '/api/users/'
 *   UpdateUserCommand.endpointDetails.REQUEST_METHOD   'patch'
 *   UpdateUserCommand.RequestBodySchema                zod
 *   UpdateUserCommand.ResponseSchema                   zod
 *
 * The package exports no common interface for them, so this is the structural
 * type we hold them by. It is deliberately LOOSE about which schemas are
 * present: a GET by id has `RequestParamSchema` and no body, `CreateUser` has
 * a body and no params, and a few have neither.
 *
 * WHY A STRUCTURAL TYPE AND NOT AN IMPORT, and the decision behind it.
 *
 * Until this migration the contract packages were `devDependencies` — a CI
 * oracle, with ZERO imports in `src/` — and the runtime image stage runs
 * `npm ci --omit=dev`, so none of them shipped. Taking the routes, verbs and
 * schemas from the package at RUNTIME changes that: the command objects are
 * values, read at call time, so the package now has to ship. It moves to
 * `dependencies`.
 *
 * That is a real cost and it is worth stating rather than absorbing quietly:
 * one more package in the image, and its single dependency `zod` becomes a
 * production dependency too. What it buys is that a route, a verb, a required
 * field or an error code can no longer drift silently — the vendor's own
 * definition is the one being used, instead of a hand-copied literal that
 * agrees with it only until someone edits the panel.
 *
 * The structural type stays regardless, for a different reason: the package
 * exports no common interface over its 218 commands, so this is the only way
 * to hold one generically. Commands still arrive as ARGUMENTS rather than
 * being reached for here, which keeps this file free of any dependency on the
 * package at all and lets a test drive the executor with a hand-built command.
 */
export interface PanelCommand {
  /** Full path, or a builder for the parameterised ones (`GET_BY_ID`). */
  readonly url: string | ((...parts: string[]) => string);
  readonly endpointDetails: {
    readonly REQUEST_METHOD: string;
    readonly METHOD_DESCRIPTION?: string;
  };
  readonly RequestBodySchema?: ZodType;
  readonly RequestParamSchema?: ZodType;
  readonly RequestQuerySchema?: ZodType;
  readonly ResponseSchema?: ZodType;
}

/** The verbs the panel actually uses. Anything else is a contract we misread. */
export const PANEL_METHODS = ['get', 'post', 'patch', 'put', 'delete'] as const;
export type PanelMethod = (typeof PANEL_METHODS)[number];

export function isPanelMethod(value: string): value is PanelMethod {
  return (PANEL_METHODS as readonly string[]).includes(value);
}

/**
 * Resolve a command's path.
 *
 * `url` is a plain string for collection routes and a function for the ones
 * that take path parts (`GET_BY_ID`, `DELETE`, `RESET_TRAFFIC`, …). The
 * function form is the vendor's own builder, so a route that moves in a later
 * contract moves here with it — which is the whole point of taking the path
 * from the package instead of writing `/api/users/${id}` by hand.
 */
export function resolveCommandUrl(command: PanelCommand, parts: readonly string[]): string {
  if (typeof command.url === 'string') {
    if (parts.length > 0) {
      throw new Error(
        `Command path takes no parameters but ${parts.length} were supplied — ` +
          'the caller and the contract disagree about this route',
      );
    }
    return command.url;
  }
  return command.url(...parts);
}
