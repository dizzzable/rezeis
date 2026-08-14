import 'reflect-metadata';

import assert from 'node:assert/strict';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { REQUIRE_PERMISSION_KEY } from '../../src/modules/rbac/decorators/require-permission.decorator';

/**
 * What a controller's routes are declared to be — asked once, in one shape.
 *
 * Fifteen specs had grown their own copy of this. They agreed on the idea and
 * on nothing else: `assertRoute(method, path, requestMethod, action)` in one
 * file, `assertRoute(requestMethod, path, target)` in another — the SAME NAME
 * with the arguments in a different order. A reader moving between two of them
 * has to re-read the local definition to know what the call says, and a call
 * copied from the wrong neighbour type-checks whenever the two strings happen
 * to be interchangeable. Hence named expectations below: `{ method, path }`
 * cannot be transposed by accident.
 *
 * Every assertion takes a `label`. The copies asserted bare metadata, so a
 * failure read `'users' !== 'api_tokens'` with nothing saying which route was
 * being described. That is affordable while a human is staring at the file and
 * useless six months later in CI output.
 */

/** A controller method as reflection sees it: callable, arguments irrelevant. */
export type RouteHandler = (...args: never[]) => unknown;

/** A permission pair as `@RequirePermission` records it. */
export interface RoutePermission {
  readonly resource: string;
  readonly action: string;
}

/**
 * Every method on the controller that Nest will actually expose, sorted.
 *
 * This is the piece the hand-written route lists were missing. A spec that
 * names five routes and checks five routes passes forever after a sixth is
 * added — including one added with no `@RequirePermission` at all, which is
 * precisely what such a spec exists to prevent. Comparing against this list
 * turns "the routes I remembered" into "the routes there are".
 *
 * Sorted so the comparison is order-insensitive: declaration order is not part
 * of any contract, and a test that fails when a method is moved within the
 * class trains people to stop reading its failures.
 */
export function routeHandlerNames(controller: new (...args: never[]) => object): string[] {
  const names = new Set<string>();
  // Up the prototype chain, not just own properties. No controller in this tree
  // extends another today, so this changes nothing right now — but the failure
  // it prevents is the silent kind: a base class's routes would simply not
  // appear, and every "these are all the routes" assertion built on the list
  // would keep passing while describing a subset.
  let proto: object | null = controller.prototype as object;
  while (proto !== null && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const fn = (proto as Record<string, unknown>)[name];
      if (typeof fn !== 'function') continue;
      // `METHOD_METADATA` is what `@Get`/`@Post`/… stamp on. A helper method
      // with no HTTP decorator carries none and is not a route.
      if (Reflect.getMetadata(METHOD_METADATA, fn) === undefined) continue;
      names.add(name);
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return [...names].sort();
}

/** One declared route: which handler, which verb, which sub-path. */
export interface DeclaredRoute {
  readonly handler: string;
  readonly method: RequestMethod;
  /** As `@Get(...)` recorded it: `'/'` for a bare decorator. */
  readonly path: string | undefined;
}

/**
 * Every route the controller declares, IN DECLARATION ORDER — deliberately not
 * sorted.
 *
 * Its neighbour `routeHandlerNames` sorts, and says why: declaration order is
 * not part of any contract, and a test that fails when a method moves within a
 * class trains people to stop reading its failures. That is true of every
 * question those assertions ask — and false of exactly one.
 *
 * Express answers from the FIRST route registered for a method, and Nest
 * registers a controller's routes in the order `MetadataScanner` walks the
 * prototype (`metadata-scanner.js:21` — `Object.getOwnPropertyNames`, i.e.
 * declaration order). So for the question "can a parameterised route swallow a
 * literal sibling", position IS the contract: `@Get(':planId')` above
 * `@Get('stats')` makes the second unreachable, and moving one line fixes or
 * breaks a production endpoint with no other visible change.
 * `admin-plans.controller.ts` hoists `@Patch('reorder')` above `:planId` for
 * this reason and says so in a comment.
 *
 * Sorting this list would therefore not make it more robust; it would make it
 * blind. `test/route-shadowing.spec.ts` is the caller that needs it.
 *
 * Accessors are skipped rather than read, matching `MetadataScanner` — reading
 * a getter to see whether it is a route would RUN it.
 */
export function declaredRoutesInOrder(
  controller: new (...args: never[]) => object,
): DeclaredRoute[] {
  const routes: DeclaredRoute[] = [];
  const seen = new Set<string>();
  let proto: object | null = controller.prototype as object;
  while (proto !== null && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || seen.has(name)) continue;
      seen.add(name);
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (descriptor === undefined || descriptor.get || descriptor.set) continue;
      const fn = descriptor.value as unknown;
      if (typeof fn !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
      if (method === undefined) continue;
      routes.push({
        handler: name,
        method,
        path: Reflect.getMetadata(PATH_METADATA, fn) as string | undefined,
      });
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return routes;
}

/**
 * The permissions a route is ACTUALLY gated on, resolved the way the guard
 * resolves them.
 *
 * `RbacGuard` reads `getAllAndOverride(KEY, [handler, class])`, so a
 * handler-level `@RequirePermission` REPLACES the class-level one rather than
 * adding to it. This matters more than it looks: 29 controllers in this tree
 * declare their permission on the CLASS, and for their routes reading metadata
 * off the handler alone returns `undefined` — a spec that does so is describing
 * nothing while appearing to describe a gate.
 *
 * Returns `undefined` when neither level declares one.
 */
export function effectiveRoutePermissions(
  controller: new (...args: never[]) => object,
  handler: RouteHandler,
): RoutePermission[] | undefined {
  const own = Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler) as
    | RoutePermission[]
    | undefined;
  if (own !== undefined) return own;
  return Reflect.getMetadata(REQUIRE_PERMISSION_KEY, controller) as
    | RoutePermission[]
    | undefined;
}

/**
 * Every route on this controller is gated on something.
 *
 * This is the assertion the hand-written route lists could not make. `RbacGuard`
 * passes an undecorated route straight through — deliberately, so it can be
 * applied globally without breaking unmarked endpoints (`rbac.guard.ts:41`) —
 * which means a forgotten `@RequirePermission` on an admin route is not an
 * error and not a 403. It is simply open to every authenticated admin, quietly,
 * for as long as nobody reads the file.
 *
 * `allowUngated` exists because some routes legitimately carry none; naming
 * them here is the point, so that "this one is deliberate" is written down
 * rather than inferred from silence.
 */
export function assertEveryRouteGuarded(
  controller: new (...args: never[]) => object,
  allowUngated: readonly string[] = [],
): void {
  const ungated = routeHandlerNames(controller).filter((name) => {
    const handler = (controller.prototype as Record<string, RouteHandler>)[name];
    const permissions = effectiveRoutePermissions(controller, handler);
    return permissions === undefined || permissions.length === 0;
  });
  assert.deepStrictEqual(
    ungated.sort(),
    [...allowUngated].sort(),
    `${controller.name}: these routes carry no @RequirePermission at any level, so RbacGuard ` +
      'lets every authenticated admin through — list one here only if that is intended',
  );
}

/**
 * The controller exposes exactly these routes and no others.
 *
 * Give it the full sorted list; it fails on an addition as loudly as on a
 * removal, which is the whole point.
 */
export function assertRouteHandlers(
  controller: new (...args: never[]) => object,
  expected: readonly string[],
): void {
  assert.deepStrictEqual(
    routeHandlerNames(controller),
    [...expected].sort(),
    `${controller.name} exposes a different set of routes than this spec claims to cover — ` +
      'a route added without one here goes unchecked',
  );
}

/**
 * This handler answers on this HTTP method and this path.
 *
 * `path` is `string | undefined` and REQUIRED, not optional: a bare `@Get()`
 * records no path, and "the caller meant undefined" must not be spelled the
 * same way as "the caller forgot to say".
 */
export function assertRoute(
  handler: RouteHandler,
  expected: { readonly method: RequestMethod; readonly path: string | undefined },
  label: string,
): void {
  assert.equal(
    Reflect.getMetadata(METHOD_METADATA, handler),
    expected.method,
    `${label}: declared on a different HTTP method than the route contract states`,
  );
  assert.equal(
    Reflect.getMetadata(PATH_METADATA, handler),
    expected.path,
    `${label}: declared on a different path than the route contract states`,
  );
}

/**
 * This handler is gated on exactly these permissions.
 *
 * Accepts one pair or several. `deepStrictEqual` against the whole recorded
 * array is deliberate: asserting only that a required pair is PRESENT would
 * pass a route that also picked up a second, weaker gate.
 */
export function assertRoutePermission(
  handler: RouteHandler,
  expected: RoutePermission | readonly RoutePermission[],
  label: string,
): void {
  const wanted = Array.isArray(expected) ? [...expected] : [expected as RoutePermission];
  assert.deepStrictEqual(
    Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler),
    wanted,
    `${label}: gated on different permissions than the route contract states`,
  );
}

/**
 * This route resolves — the way `RbacGuard` resolves it — to exactly these
 * permissions, wherever they are declared.
 *
 * The sibling above reads the handler alone, which is right for the majority
 * style (a decorator per route) and cannot pass vacuously: a class-gated route
 * gives it `undefined` against a non-empty expectation, so it fails loudly
 * rather than describing nothing. But 29 controllers here declare on the CLASS,
 * and for those it can only fail — there is no way to state their real gate.
 *
 * Two specs had already grown this function locally, word for word, because of
 * that. Which is the shape this file exists to stop: one rule, one home. Both
 * assertions are kept because they answer different questions — "this route
 * carries its own decorator, and it says X" versus "whatever the levels, the
 * guard ends up demanding X" — and a spec on a handler-declared controller is
 * more precise for saying the former.
 */
export function assertEffectiveRoutePermission(
  controller: new (...args: never[]) => object,
  handler: RouteHandler,
  expected: RoutePermission | readonly RoutePermission[],
  label: string,
): void {
  const wanted = Array.isArray(expected) ? [...expected] : [expected as RoutePermission];
  assert.deepStrictEqual(
    effectiveRoutePermissions(controller, handler),
    wanted,
    `${label}: RbacGuard resolves a different permission than the route contract states`,
  );
}

/**
 * This route carries NO permission at ANY level, and that is the intent.
 *
 * The internal controllers are the case: they sit behind `InternalAdminAuthGuard`
 * as a whole and declare no per-route permission, so "no `@RequirePermission`
 * here" is the contract rather than an omission. Without a way to say so, a
 * spec can only describe the routes that ARE gated, and a decorator added to an
 * internal route later goes unremarked — while doing nothing, because `RbacGuard`
 * never runs on those routes. An inert security decorator is worse than none:
 * it reads, to the next person, as protection.
 *
 * Takes the CONTROLLER as well as the handler, and resolves through
 * `effectiveRoutePermissions`, for the same reason that function exists. Reading
 * `REQUIRE_PERMISSION_KEY` off the handler alone — which is what this did — is
 * blind to the class level, and a class-level `@RequirePermission` is how 29
 * controllers in this tree declare their gate. So on a route gated by its class
 * the handler-only check found `undefined` and asserted, out loud and in a spec
 * named for the property, that the route was gated on NOTHING — the exact
 * opposite of what `RbacGuard` would do with it. Its sibling
 * `assertEveryRouteGuarded` had always read both levels; two functions in one
 * file disagreeing about what "ungated" means is the kind of gap that is only
 * ever found the hard way.
 *
 * "Ungated" is spelled exactly as `assertEveryRouteGuarded` spells it: no
 * effective permissions, meaning absent metadata OR an empty list — the two
 * `RbacGuard` waves through identically (`rbac.guard.ts:41`).
 *
 * Spelled as its own function rather than `assertRoutePermission(handler, [])`,
 * which would compare an empty array against absent metadata and fail.
 */
export function assertRouteUngated(
  controller: new (...args: never[]) => object,
  handler: RouteHandler,
  label: string,
): void {
  // The message must not guess which level carries the decorator: "you
  // decorated the method" and "you decorated the class" are different mistakes
  // with different fixes. Only the failure path spends it, and a metadata read
  // is cheap enough not to bother deferring.
  const declaredOnHandler =
    Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler) !== undefined;
  const level = declaredOnHandler ? 'this handler' : `the ${controller.name} class`;
  assert.deepStrictEqual(
    effectiveRoutePermissions(controller, handler) ?? [],
    [],
    `${label}: a @RequirePermission is declared on ${level}, so RbacGuard resolves this route ` +
      'to the permissions shown — but this spec states the route is gated on nothing at any ' +
      'level. Either the gate is real, and it belongs in an effective-permission assertion ' +
      'rather than here; or RbacGuard is not among this controller\'s guards, nothing reads the ' +
      'metadata, and the decorator restricts no one while reading as protection. Either way the ' +
      'decision has to be made and written down',
  );
}

/**
 * `POST admin/imports/:importId/cancel` — the human-readable name of a route,
 * for the `label` every assertion above takes.
 *
 * Every migrated spec had grown the same four lines to build this. Passing the
 * controller's base path explicitly (rather than reading `PATH_METADATA` off
 * the class) keeps the label honest for controllers whose base is composed at
 * registration time.
 */
export function routeLabel(
  base: string,
  method: RequestMethod,
  path: string | undefined,
): string {
  const verb = RequestMethod[method] ?? String(method);
  // A bare `@Get()` records `'/'`, not `''` or `undefined` — so the root route
  // of every controller hits this, and naively concatenating it produced a
  // label with a trailing slash on every spec that migrated. All three spellings
  // mean "the controller's own path".
  const tail = path === undefined || path === '' || path === '/' ? '' : `/${path}`;
  return `${verb} ${base}${tail}`.replace(/\/{2,}/g, '/');
}
