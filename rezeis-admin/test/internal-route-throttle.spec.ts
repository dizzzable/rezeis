import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

/**
 * Who may be rate-limited per address, and who may not.
 *
 * `ThrottleModule` registers `ThrottlerGuard` globally: 600 requests per 60
 * seconds PER CALLER IP. On the `admin/*` surface that is one operator's
 * browser and the limit means what it reads as. On `internal/*` it does not:
 * every call comes from the cabinet's BACKEND — one address, on behalf of the
 * whole customer base at once — so 600 a minute is 600 for everybody together.
 * A busy install reaches it on ordinary traffic, and past it the cabinet stops
 * working for every customer at once, which is how «у клиентов не появляются
 * подсказки» was first reported.
 *
 * So the rule, by credential rather than by path:
 *
 *   behind `InternalAdminAuthGuard` — the caller is the one service holding the
 *     shared secret. Throttling it throttles customers, and it protects nothing
 *     that the secret does not already protect. These carry `@SkipThrottle()`.
 *
 *   anything else under `internal/*` — the caller is NOT that service. It is
 *     reached with its own credential from an address nobody vouches for, and
 *     the per-address limit is the only volume protection it has. These keep
 *     it, and each one must be named below with the credential it does use:
 *     a NEW `internal/*` route that answers without the shared secret is then
 *     a decision somebody wrote down, not an omission that reads like one.
 *
 * The exemption maps are as much the point as the rule. Both are checked for
 * STALE entries too — an exemption naming a controller that no longer exists is
 * how a guard quietly stops guarding the thing it was written for.
 */

const sourceRoot = join(process.cwd(), 'src');

/** The credential that means "this is the cabinet's backend". */
const SHARED_SECRET_GUARD = 'InternalAdminAuthGuard';

/**
 * `internal/*` controllers that answer WITHOUT the shared secret, and what they
 * use instead. They keep the per-address limit: the caller is not the cabinet.
 */
const OWN_CREDENTIAL: ReadonlyMap<string, string> = new Map([
  [
    'InternalBackupDownloadController',
    'single-use HMAC token minted by rezeis, fetched by the reiwa bot on the split ' +
      'deployment; the response is a full pg_dump, so the volume limit is worth keeping',
  ],
  [
    'QuestPartnerCallbackController',
    'per-partner HMAC over the raw body with nonce dedup; called by EXTERNAL partners ' +
      'from arbitrary addresses, which is exactly what a per-address limit is for',
  ],
]);

/**
 * Controllers behind the shared secret that nevertheless keep the limit. Empty
 * on purpose — the entry that lands here must carry the reason the general
 * argument does not apply to it.
 */
const THROTTLED_ON_PURPOSE: ReadonlyMap<string, string> = new Map([]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function decoratorName(dec: ts.Decorator): string | null {
  const expr = ts.isCallExpression(dec.expression) ? dec.expression.expression : dec.expression;
  return ts.isIdentifier(expr) ? expr.text : null;
}

function decoratorArgs(dec: ts.Decorator): string[] {
  if (!ts.isCallExpression(dec.expression)) return [];
  return dec.expression.arguments.map((arg) =>
    ts.isIdentifier(arg) ? arg.text : ts.isStringLiteral(arg) ? arg.text : '?',
  );
}

interface InternalController {
  readonly name: string;
  readonly file: string;
  readonly path: string;
  readonly guards: ReadonlySet<string>;
  readonly skipsThrottle: boolean;
}

function internalControllers(): InternalController[] {
  const found: InternalController[] = [];

  for (const file of walk(sourceRoot)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );

    source.forEachChild((node) => {
      if (!ts.isClassDeclaration(node) || node.name === undefined) return;
      const decorators = ts.getDecorators(node) ?? [];

      const controller = decorators.find((d) => decoratorName(d) === 'Controller');
      if (controller === undefined) return;
      const path = decoratorArgs(controller)[0] ?? '';
      if (!path.startsWith('internal')) return;

      // Class level AND method level: `InternalAdminController` declares its
      // guard per route, and a class-only read files it as unguarded.
      const guards = new Set<string>([
        ...decorators.filter((d) => decoratorName(d) === 'UseGuards').flatMap(decoratorArgs),
        ...node.members.flatMap((member) =>
          // `ClassElement` is wider than what `getDecorators` accepts — an
          // index signature cannot carry one — so narrow it rather than
          // casting the difference away.
          ts.canHaveDecorators(member)
            ? (ts.getDecorators(member) ?? [])
                .filter((d) => decoratorName(d) === 'UseGuards')
                .flatMap(decoratorArgs)
            : [],
        ),
      ]);

      found.push({
        name: node.name.text,
        file: relative(process.cwd(), file).replace(/\\/g, '/'),
        path,
        guards,
        skipsThrottle: decorators.some((d) => decoratorName(d) === 'SkipThrottle'),
      });
    });
  }

  return found;
}

const CONTROLLERS = internalControllers();

test('the sweep actually finds the internal surface', () => {
  // Anti-vacuity: every assertion below is "for each controller found", and a
  // discovery that silently returns nothing would pass all of them. The panel
  // had 46 of these when this was written; the floor is deliberately well under
  // that so deleting a module does not fail the build, while a broken walk or a
  // renamed decorator — which would return 0 or a handful — does.
  assert.ok(
    CONTROLLERS.length >= 40,
    `found only ${CONTROLLERS.length} internal controllers; the AST sweep is probably broken`,
  );
});

test('a route behind the shared secret is not throttled per address', () => {
  const offenders = CONTROLLERS.filter(
    (c) =>
      c.guards.has(SHARED_SECRET_GUARD) &&
      !c.skipsThrottle &&
      !THROTTLED_ON_PURPOSE.has(c.name),
  ).map((c) => `${c.name} (${c.file})`);

  assert.deepEqual(
    offenders,
    [],
    'These answer only to the cabinet’s backend, so the global 600/minute per-IP ' +
      'limit is a limit on every customer at once. Add @SkipThrottle() — or, if this ' +
      'one genuinely needs the limit, name it in THROTTLED_ON_PURPOSE with the reason.',
  );
});

test('a route that answers without the shared secret keeps its limit', () => {
  const lifted = CONTROLLERS.filter(
    (c) => !c.guards.has(SHARED_SECRET_GUARD) && c.skipsThrottle,
  ).map((c) => `${c.name} (${c.file})`);

  assert.deepEqual(
    lifted,
    [],
    'The caller here is not the cabinet’s backend, so the per-address limit is real ' +
      'protection rather than a limit on customers. Remove @SkipThrottle().',
  );
});

test('every internal route without the shared secret is a written-down decision', () => {
  const undeclared = CONTROLLERS.filter(
    (c) => !c.guards.has(SHARED_SECRET_GUARD) && !OWN_CREDENTIAL.has(c.name),
  ).map((c) => `${c.name} (${c.path}) — guards: [${[...c.guards].join(', ') || 'none'}]`);

  assert.deepEqual(
    undeclared,
    [],
    'A new internal/* route that does not use InternalAdminAuthGuard must be named in ' +
      'OWN_CREDENTIAL with the credential it uses instead — otherwise an unauthenticated ' +
      'service route is indistinguishable from a deliberate one.',
  );
});

test('no exemption outlives the controller it was written for', () => {
  const names = new Set(CONTROLLERS.map((c) => c.name));
  const stale = [...OWN_CREDENTIAL.keys(), ...THROTTLED_ON_PURPOSE.keys()].filter(
    (name) => !names.has(name),
  );

  assert.deepEqual(
    stale,
    [],
    'These are exempted from a rule they are no longer subject to. An exemption that ' +
      'names nothing is a hole waiting for a controller of the same name.',
  );
});
