import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import express from 'express';
import { match as compilePathMatcher, pathToRegexp } from 'path-to-regexp';
import request from 'supertest';

import { declaredRoutesInOrder } from './helpers/controller-routes';

/**
 * No literal route in the tree is unreachable behind a parameterised sibling.
 *
 * `GET /api/admin/plans/stats` shipped broken and stayed broken: it is declared
 * on `AdminPlansStatsController` (`admin/plans/stats`), but `AdminPlansController`
 * (`admin/plans`, with `@Get(':planId')`) came first in the module's
 * `controllers` array, so Express matched `:planId` with planId="stats", looked
 * up a plan whose id cannot exist and answered 404 — for every operator, from
 * the day it was written. `GET /api/admin/promocodes/stats` was the same defect
 * copied into a second module. Neither was visible in either controller file:
 * both declared exactly the path they meant, and the fault lived in the
 * position of a name inside an array in a third file.
 *
 * That is why this spec exists rather than a per-controller assertion. Nest
 * registers routes in a strict three-level order — module insertion order, then
 * the module's `controllers` array, then declaration order within the class
 * (`routes-resolver.js:29-36`, `metadata-scanner.js:21`) — and Express answers
 * from the first registered route that matches. So "is this endpoint
 * reachable?" is a question about the WHOLE tree at once, and only a
 * whole-tree enumeration can answer it.
 *
 * The tree is discovered from disk rather than listed here. A hand-maintained
 * list of controllers is the failure this guards against wearing a different
 * hat: it would keep passing over a controller added next month, which is
 * exactly when the next one of these gets written.
 */

const REPO_ROOT = resolve(__dirname, '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

/**
 * Floors, not exact counts. An exact count turns every new controller into a
 * failing build for no reason and gets deleted; a floor only fires when
 * discovery itself broke — a renamed convention, a moved directory, a require
 * that silently yielded nothing — which is the case that would otherwise leave
 * this spec green while checking zero routes.
 */
const MINIMUM_CONTROLLERS = 100;
const MINIMUM_ROUTES = 500;

type ControllerClass = new (...args: never[]) => object;

interface RegisteredRoute {
  readonly controller: ControllerClass;
  readonly controllerName: string;
  readonly file: string;
  readonly handler: string;
  readonly method: RequestMethod;
  /** Full path with no leading slash, e.g. `admin/plans/:planId`. */
  readonly path: string;
  readonly moduleName: string;
  /** Index in the owning module's `controllers` array. */
  readonly controllerIndex: number;
  /** Declaration index within the controller class. */
  readonly methodIndex: number;
}

function walkFiles(directory: string, suffix: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(full, suffix, found);
    else if (entry.name.endsWith(suffix)) found.push(full);
  }
  return found;
}

function repoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join('/');
}

function exportedClasses(file: string): Array<[string, ControllerClass]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require(file) as Record<string, unknown>;
  return Object.entries(loaded)
    .filter((entry): entry is [string, ControllerClass] => typeof entry[1] === 'function')
    .map(([name, value]) => [name, value]);
}

/** `@Controller('a')` + `@Get('b')` → `a/b`; a bare decorator records `'/'`. */
function joinRoutePath(base: unknown, sub: unknown): string {
  const trim = (value: unknown): string =>
    value === undefined || value === null
      ? ''
      : String(value).replace(/^\/+/, '').replace(/\/+$/, '');
  const head = trim(base);
  const tail = trim(sub);
  if (head === '') return tail;
  if (tail === '') return head;
  return `${head}/${tail}`;
}

/**
 * Path matching is DELEGATED, not re-implemented.
 *
 * An earlier draft of this file compared path strings segment by segment, which
 * is only ever as correct as its author's memory of the routing syntax. That
 * memory is a bad thing to bet on here: Express 5 swapped path-to-regexp v4 for
 * v8, which removed inline regex constraints (`:id(\\d+)` now THROWS at boot),
 * renamed the optional-segment form and made wildcards require a name. A sweep
 * that quietly modelled v4 would hand back confident verdicts on any
 * non-trivial path — and a confident "safe" is worse here than no check at all.
 *
 * So the matcher below is built exactly the way Express builds a route layer.
 * `express@5.2.1` routes through `router@2.2.0`, whose `Layer` calls
 * `pathToRegexp.match(loosen(path), { sensitive, end: true, trailing: !strict })`
 * (`node_modules/router/lib/layer.js:86`, constructed at `router/index.js:428`),
 * where `loosen` drops a trailing slash and `caseSensitive`/`strict` are both
 * false by default. `router` resolves the SAME `path-to-regexp` install this
 * file imports, so these are not two implementations that have to be kept in
 * step — it is one implementation, called twice. The calibration test at the
 * top of the suite checks that claim against a running Express app rather than
 * trusting this comment.
 */
function compileRouteMatcher(routePath: string): (url: string) => boolean {
  const withLeadingSlash = `/${routePath}`;
  const loosened =
    withLeadingSlash === '/' ? withLeadingSlash : withLeadingSlash.replace(/\/+$/, '');
  const matcher = compilePathMatcher(loosened, {
    sensitive: false,
    end: true,
    trailing: true,
    decode: decodeURIComponent,
  });
  return (url: string): boolean => matcher(`/${url}`) !== false;
}

/**
 * No parameters at all — the path can only ever match itself.
 *
 * Asked of the parser rather than of the string, so `:param`, `*wildcard` and
 * optional groups are all classified by the same code Express classifies them
 * with.
 */
function isLiteralPath(routePath: string): boolean {
  return pathToRegexp(`/${routePath}`).keys.length === 0;
}

function buildRouteTable(): {
  readonly routes: readonly RegisteredRoute[];
  readonly controllerCount: number;
  readonly unregistered: readonly string[];
  readonly multiRegistered: readonly string[];
} {
  const controllers = new Map<ControllerClass, { name: string; file: string }>();
  for (const file of walkFiles(SRC_ROOT, '.controller.ts')) {
    for (const [name, value] of exportedClasses(file)) {
      if (Reflect.getMetadata(PATH_METADATA, value) === undefined) continue;
      controllers.set(value, { name, file: repoPath(file) });
    }
  }

  const owner = new Map<ControllerClass, { moduleName: string; index: number }>();
  const registrations = new Map<ControllerClass, string[]>();
  for (const file of walkFiles(SRC_ROOT, '.module.ts')) {
    for (const [moduleName, value] of exportedClasses(file)) {
      const declared = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, value) as unknown;
      if (!Array.isArray(declared)) continue;
      declared.forEach((controller: ControllerClass, index: number) => {
        registrations.set(controller, [...(registrations.get(controller) ?? []), moduleName]);
        if (!owner.has(controller)) owner.set(controller, { moduleName, index });
      });
    }
  }

  const routes: RegisteredRoute[] = [];
  for (const [controller, meta] of controllers) {
    const base = Reflect.getMetadata(PATH_METADATA, controller);
    const registration = owner.get(controller);
    declaredRoutesInOrder(controller).forEach((route, methodIndex) => {
      routes.push({
        controller,
        controllerName: meta.name,
        file: meta.file,
        handler: route.handler,
        method: route.method,
        path: joinRoutePath(base, route.path),
        moduleName: registration?.moduleName ?? '(unregistered)',
        controllerIndex: registration?.index ?? -1,
        methodIndex,
      });
    });
  }

  return {
    routes,
    controllerCount: controllers.size,
    unregistered: [...controllers]
      .filter(([controller]) => !registrations.has(controller))
      .map(([, meta]) => `${meta.name} (${meta.file})`),
    multiRegistered: [...registrations]
      .filter(([, modules]) => modules.length > 1)
      .map(([controller, modules]) => `${controllers.get(controller)?.name} in ${modules.join(', ')}`),
  };
}

function describeRoute(route: RegisteredRoute): string {
  return `${RequestMethod[route.method] ?? route.method} /${route.path} -> ${route.controllerName}.${route.handler} (${route.file})`;
}

/**
 * Satisfy the environment schema BEFORE the tree is walked, and not because
 * this file has any opinion about configuration.
 *
 * `buildRouteTable()` below `require`s every `*.controller.ts` and every
 * `*.module.ts` under `src/`. That is the point of the sweep — a route table
 * assembled from anything less than the real tree would miss exactly the
 * controller somebody forgot to register. But it also drags in the config
 * layer, and `validateEnvironment` (`src/common/config/env.schema.ts`) refuses
 * an absent `REZEIS_CRYPT_KEY` / `DATABASE_PASSWORD`.
 *
 * The refusal arrives as a REJECTED PROMISE, so it does not fail the require.
 * It settles whenever the loop gets to it, which on a fast machine is after
 * the process has already exited — and on a slow CI runner is after the last
 * test in this file finished. Node's runner then reports "a resource generated
 * asynchronous activity after the test ended", attributes the unhandled
 * rejection to whichever test was still open, and fails the FILE while every
 * assertion in it passed. That is precisely how this arrived: green locally,
 * red on CI, with no failing test named.
 *
 * Setting the two values here makes the validation resolve instead of reject.
 * It changes nothing this file asserts — the sweep reads route metadata off
 * decorators and never reads config — and it is deliberately the smallest set
 * that satisfies the schema rather than a copy of `.env.example`: if this list
 * has to grow, that is a signal a new module started validating at import
 * time, which is worth noticing rather than papering over.
 */
process.env.REZEIS_CRYPT_KEY ??= 'route-shadowing-spec-crypt-key-0123456789';
process.env.DATABASE_PASSWORD ??= 'route-shadowing-spec-db-password';

const table = buildRouteTable();

/**
 * Paths handed to a live Express router to check this file's two premises
 * against reality: that the first registered matching route answers, and that
 * `compileRouteMatcher` agrees with Express about what "matching" means.
 *
 * No expected booleans are written down — the assertion compares the helper to
 * the running router, so it cannot be satisfied by an expectation copied from
 * the helper it is meant to check. The list deliberately reaches past the
 * `:param` form the tree uses today into the v8 syntax it does not, because a
 * route in one of those forms is precisely the one this file would misjudge.
 */
const MATCHER_PROBES: ReadonlyArray<{ readonly pattern: string; readonly url: string }> = [
  { pattern: 'admin/plans/:planId', url: 'admin/plans/stats' },
  { pattern: 'admin/plans/:planId', url: 'admin/plans/a/b' },
  { pattern: 'admin/plans/:planId', url: 'admin/plans' },
  { pattern: 'admin/plans/:planId/move', url: 'admin/plans/x/move' },
  { pattern: 'admin/plans/:planId/move', url: 'admin/plans/x/archive' },
  { pattern: 'admin/plans/options/internal', url: 'admin/plans/options/internal' },
  { pattern: 'admin/plans/options/internal', url: 'admin/plans/options/external' },
  { pattern: 'admin/plans/options/internal', url: 'admin/plans/OPTIONS/internal' },
  { pattern: 'admin/files/*rest', url: 'admin/files/a/b/c' },
  { pattern: 'admin/files/*rest', url: 'admin/files' },
  { pattern: 'admin/plans{/:planId}', url: 'admin/plans' },
  { pattern: 'admin/plans{/:planId}', url: 'admin/plans/x' },
];

async function expressMatches(pattern: string, url: string): Promise<boolean> {
  const application = express();
  application.get(`/${pattern}`, (_request, response) => {
    response.status(200).end('matched');
  });
  const response = await request(application).get(`/${url}`);
  return response.status === 200;
}

describe('route shadowing across the whole controller tree', () => {
  it('matches paths the way a running Express router does', async () => {
    const disagreements: string[] = [];
    for (const probe of MATCHER_PROBES) {
      const modelled = compileRouteMatcher(probe.pattern)(probe.url);
      const actual = await expressMatches(probe.pattern, probe.url);
      if (modelled !== actual) {
        disagreements.push(
          `pattern "/${probe.pattern}" vs url "/${probe.url}": this file says ${modelled}, ` +
            `Express says ${actual}`,
        );
      }
    }
    assert.deepStrictEqual(
      disagreements,
      [],
      'the matcher this spec sweeps the tree with no longer behaves like the router it is ' +
        'reasoning about, so every verdict below is unreliable — most likely Express or ' +
        'path-to-regexp changed path syntax under us',
    );
  });

  it('sorts parameterised paths from literal ones the way the syntax reads', () => {
    // `isLiteralPath` asks the parser, which is right — but it means a change in
    // what the parser reports as a "key" would silently move routes into the
    // literal bucket, where they are never used as a shadowing pattern and a
    // real shadow goes unreported. Green, and blind. So the classification is
    // pinned against the plain reading of the same probe paths.
    const misclassified = MATCHER_PROBES.map((probe) => probe.pattern)
      .filter((pattern, index, all) => all.indexOf(pattern) === index)
      .filter((pattern) => isLiteralPath(pattern) !== !/[:*{]/.test(pattern));
    assert.deepStrictEqual(
      misclassified,
      [],
      'these paths are classified as literal/parameterised opposite to how they read — the ' +
        'sweep partitions the whole tree with this function, and a parameterised route filed as ' +
        'a literal is one this spec will never check anything against',
    );
  });

  it('answers a request from the FIRST registered matching route', async () => {
    // The premise the whole file rests on. If Express ever started preferring
    // the most specific route instead, this spec would keep reporting shadows
    // that no longer exist and people would start ignoring it — so the premise
    // is measured rather than assumed.
    const application = express();
    application.get('/probe/:id', (_request, response) => response.status(200).end('param'));
    application.get('/probe/literal', (_request, response) => response.status(200).end('literal'));

    const response = await request(application).get('/probe/literal');

    assert.equal(
      response.text,
      'param',
      'Express no longer answers from the first registered route — route order has stopped ' +
        'being what decides reachability, and this spec needs rewriting rather than trusting',
    );
  });

  it('discovered the real controller tree, so the checks below are not vacuous', () => {
    assert.ok(
      table.controllerCount >= MINIMUM_CONTROLLERS,
      `only ${table.controllerCount} controllers were discovered under src/ — the walk looks for ` +
        `*.controller.ts and reads @Controller metadata off every exported class; if the naming ` +
        `convention moved, every assertion in this file is now passing over nothing`,
    );
    assert.ok(
      table.routes.length >= MINIMUM_ROUTES,
      `only ${table.routes.length} routes were discovered — route metadata is no longer being ` +
        'read the way Nest reads it, so this spec is green while checking almost nothing',
    );
  });

  it('registers every controller in exactly one module', () => {
    // Not tidiness. Registration order is what decides shadowing, and a
    // controller registered nowhere has no order at all while a controller
    // registered twice has two — either way the verdicts below stop meaning
    // anything, so this has to fail loudly rather than be silently skipped.
    assert.deepStrictEqual(
      table.unregistered,
      [],
      'these controllers appear in no module @Module({ controllers }) — they serve no traffic, ' +
        'and this spec cannot reason about the order of routes that are never registered',
    );
    assert.deepStrictEqual(
      table.multiRegistered,
      [],
      'these controllers are registered by more than one module, so which registration wins ' +
        'depends on module resolution order and the shadowing verdicts below are unreliable',
    );
  });

  it('leaves no literal route unreachable behind a parameterised one', () => {
    const literals = table.routes.filter((route) => isLiteralPath(route.path));
    // Compiled once per parameterised route rather than once per comparison —
    // this is ~200 patterns against ~400 literals.
    const patterns = table.routes
      .filter((route) => !isLiteralPath(route.path))
      .map((route) => ({ route, covers: compileRouteMatcher(route.path) }));
    const shadowed: string[] = [];
    const undecidable: string[] = [];

    for (const literal of literals) {
      for (const { route: pattern, covers } of patterns) {
        const sameVerb =
          pattern.method === literal.method ||
          pattern.method === RequestMethod.ALL ||
          literal.method === RequestMethod.ALL;
        if (!sameVerb) continue;
        if (!covers(literal.path)) continue;

        const pair = `${describeRoute(literal)}\n      is covered by ${describeRoute(pattern)}`;
        if (pattern.controller === literal.controller) {
          // One class: declaration order decides, and it is visible in the file.
          if (pattern.methodIndex < literal.methodIndex) {
            shadowed.push(`${pair}\n      FIX: declare the literal route above the parameterised one`);
          }
          continue;
        }
        if (pattern.moduleName === literal.moduleName) {
          // Two classes, one module: the `controllers` array order decides, and
          // it is visible in neither controller file. This is the plans/stats
          // shape.
          if (pattern.controllerIndex < literal.controllerIndex) {
            shadowed.push(
              `${pair}\n      FIX: in ${literal.moduleName}, move ${literal.controllerName} ` +
                `above ${pattern.controllerName} in the controllers array`,
            );
          }
          continue;
        }
        // Two modules: the winner is decided by the order Nest inserts modules
        // while walking the import graph from AppModule — not by anything
        // written in either module file. This spec deliberately refuses to
        // model that rather than guess it, because a guess that comes out
        // "safe" is worse than no check at all.
        undecidable.push(pair);
      }
    }

    assert.deepStrictEqual(
      undecidable,
      [],
      'a literal route and a parameterised route that covers it are registered by DIFFERENT ' +
        'modules, so which one answers is decided by module import-graph order — invisible in ' +
        'both files and liable to change when an unrelated import is added. Move them into one ' +
        'module, or give the literal a path the pattern cannot match',
    );
    assert.deepStrictEqual(
      shadowed,
      [],
      'these literal routes are registered AFTER a parameterised route that matches them, so ' +
        'Express answers every request to them from the parameterised handler and the literal ' +
        'endpoint is dead — typically a 404 from a lookup for an id that cannot exist. ' +
        'Note that constraining the param instead is not available: Express 5 uses ' +
        'path-to-regexp v8, which removed inline regex and throws on `:id(pattern)` at boot',
    );
  });
});
