import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

/**
 * Every route is reachable only by someone entitled to reach it.
 *
 * WHAT THIS FILE USED TO CHECK, and why that was worth nothing:
 * it accepted a handler that carried `@UseGuards` **or `@Public()`**, at either
 * level, without looking at WHICH guard or at `@RequirePermission` at all.
 * `@Public()` is inert in this application - its only reader is
 * `src/common/guards/jwt-auth.guard.ts`, and that guard is registered nowhere,
 * globally or otherwise. So the single edit that removes all authentication
 * from a controller (delete its `@UseGuards`, add `@Public()`) left the spec
 * green, and the spec's name promised it would not. `@Public()` is deliberately
 * not consulted anywhere below; a decision about deleting it is pending
 * elsewhere, but nothing here may treat it as a credential.
 *
 * WHAT IT CHECKS NOW, by surface:
 *
 *   `admin/*`    - `AdminJwtAuthGuard` (who you are) AND `RbacGuard` plus a
 *                  `@RequirePermission` (what you may do). Both halves are
 *                  needed: `RbacGuard` waves an undecorated route straight
 *                  through by design (`rbac.guard.ts:41`), so a missing
 *                  decorator is not a 403 - it is an endpoint open to every
 *                  authenticated admin, quietly.
 *   `internal/*` - `InternalAdminAuthGuard`. A separate service-to-service
 *                  surface with its own shared-secret credential; RBAC has no
 *                  meaning there because the caller is a service, not a person.
 *   everything else - must be named in `UNAUTHENTICATED_ROUTES` below.
 *
 * The exemption lists are the point of the file as much as the rule is. A route
 * that carries no gate is not automatically a bug, but it must be a decision
 * somebody wrote down, with the reason attached, rather than an omission
 * indistinguishable from one.
 */

const sourceRoot = join(process.cwd(), 'src');

/** Decorators that make a method an HTTP route. */
const HTTP_METHOD_DECORATORS: ReadonlySet<string> = new Set([
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'Head',
  'Options',
  'All',
  'Search',
]);

/**
 * Routes served with NO credential of any kind. Anything here is reachable by
 * anyone on the internet who can address the process.
 *
 * `@Public()` does not put a route on this list and does not take one off it:
 * the decorator is inert (see the file header), so the only thing that makes a
 * route public is the absence of a guard that runs.
 */
const UNAUTHENTICATED_ROUTES: ReadonlyMap<string, string> = new Map([
  // Bootstrap discovery + first-admin registration + sign-in. `register`
  // refuses once any admin row exists (`AdminAuthService.bootstrapFirstAdmin`),
  // and `login` is the door itself.
  ['AdminAuthController.getStatus', 'reports whether the panel has been bootstrapped yet'],
  ['AdminAuthController.register', 'creates the first DEV admin; refuses once one exists'],
  ['AdminAuthController.login', 'issues the admin JWT; rate-limited via @Throttle'],
  // Sign-in alternatives. Each one ENDS in a session rather than assuming one.
  ['OAuthPublicController.getProviders', 'lists which sign-in providers are configured'],
  ['OAuthPublicController.telegramLogin', 'Telegram sign-in; verifies the Telegram signature'],
  ['OAuthPublicController.githubAuthorize', 'starts the GitHub OAuth redirect'],
  ['OAuthPublicController.githubCallback', 'GitHub OAuth callback; the provider calls it'],
  ['PasskeyPublicController.getAuthenticationOptions', 'passkey challenge, pre-sign-in'],
  ['PasskeyPublicController.verifyAuthentication', 'passkey assertion; verifies the signature'],
  // Liveness/readiness for the orchestrator, which has no credential to offer.
  ['AppController.getStatus', 'root service banner'],
  ['HealthController.getHealth', 'health probe'],
  ['HealthController.liveness', 'liveness probe'],
  ['HealthController.readiness', 'readiness probe'],
  // Inbound webhooks. The caller is a third party that cannot hold an admin
  // token; each verifies its own provider signature inside the handler.
  ['PublicPaymentWebhooksController.ingest', 'payment provider callback; signature-verified'],
  ['RemnawaveWebhookController.handleWebhook', 'Remnawave callback; signature-verified'],
  // One-shot, expiring, signed download link handed to an operator out of band.
  ['InternalBackupDownloadController.download', 'backup download by single-use token'],
  // Not literally unauthenticated: it carries its own dedicated guard rather
  // than an admin or internal credential, because the caller is a quest
  // partner's server.
  ['QuestPartnerCallbackController.callback', 'guarded by QuestPartnerCallbackGuard (HMAC)'],
]);

/**
 * `admin/*` routes that authenticate the admin but deliberately carry no
 * permission gate, because they act on the CALLING admin's own account or
 * session. A permission would be the wrong shape: there is no version of
 * "may read their own permissions" that another role should be able to deny.
 */
const SELF_SERVICE_ADMIN_ROUTES: ReadonlyMap<string, string> = new Map([
  ['AdminAuthController.getMe', 'the caller own profile'],
  ['AdminAuthController.changePassword', 'the caller own password'],
  ['AdminAuthPermissionsController.getPermissions', 'the caller own effective grants'],
  ['AdminTwoFactorController.status', 'the caller own TOTP enrolment'],
  ['AdminTwoFactorController.enroll', 'the caller own TOTP enrolment'],
  ['AdminTwoFactorController.confirm', 'the caller own TOTP enrolment'],
  ['AdminTwoFactorController.disable', 'the caller own TOTP enrolment'],
  ['AdminTwoFactorController.regenerateRecoveryCodes', 'the caller own recovery codes'],
  ['OAuthLinksController.getLinkedProviders', 'the caller own linked identities'],
  ['OAuthLinksController.unlinkProvider', 'the caller own linked identities'],
  ['PasskeyProtectedController.listPasskeys', 'the caller own passkeys'],
  ['PasskeyProtectedController.getRegistrationOptions', 'the caller own passkeys'],
  ['PasskeyProtectedController.verifyRegistration', 'the caller own passkeys'],
  ['PasskeyProtectedController.renamePasskey', 'the caller own passkeys'],
  ['PasskeyProtectedController.deletePasskey', 'the caller own passkeys'],
  ['AdminPushController.getPublicKey', 'the VAPID public key, needed to subscribe'],
  ['AdminPushController.subscribe', 'the caller own browser push subscription'],
  ['AdminPushController.unsubscribe', 'the caller own browser push subscription'],
  ['AdminPushController.sendTest', 'sends a push to the caller own subscription'],
  ['AdminNotificationPreferencesController.list', 'the caller own notification preferences'],
  ['AdminNotificationPreferencesController.update', 'the caller own notification preferences'],
  // `ThemePresetsService` scopes every one of these to `ownerId === currentAdmin.id`
  // (or `isShared`), so the authority is ownership rather than a permission.
  ['AdminThemePresetsController.list', 'the caller own + shared appearance presets'],
  ['AdminThemePresetsController.getActivePrefs', 'the caller own appearance selection'],
  ['AdminThemePresetsController.saveActivePrefs', 'the caller own appearance selection'],
  ['AdminThemePresetsController.create', 'a preset owned by the caller'],
  ['AdminThemePresetsController.update', 'refuses a preset the caller does not own'],
  ['AdminThemePresetsController.delete', 'refuses a preset the caller does not own'],
  // Documented in the controller: knowing whether an update exists is baseline
  // for any signed-in operator, and the release it points at is public anyway.
  ['AdminUpdateCheckerController.getStatus', 'cached public release information'],
  ['AdminUpdateCheckerController.refresh', 're-reads that public release information'],
  // Write-only sink for the SPA error boundary, keyed to the caller session.
  ['ClientErrorsController.report', 'reports a client-side error from the caller own session'],
]);

interface DecoratorInfo {
  readonly name: string;
  readonly call: ts.CallExpression | null;
}

function decoratorsOf(node: ts.Node): readonly DecoratorInfo[] {
  if (!ts.canHaveDecorators(node)) return [];
  return (ts.getDecorators(node) ?? []).map((decorator) => {
    const expression = decorator.expression;
    const identifier = ts.isCallExpression(expression) ? expression.expression : expression;
    return {
      name: ts.isIdentifier(identifier) ? identifier.text : identifier.getText(),
      call: ts.isCallExpression(expression) ? expression : null,
    };
  });
}

function guardsOf(node: ts.Node): readonly string[] {
  return decoratorsOf(node).flatMap((decorator) =>
    decorator.name === 'UseGuards' && decorator.call
      ? decorator.call.arguments.map((argument) => argument.getText())
      : [],
  );
}

function controllerFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return controllerFiles(path);
    return path.endsWith('.controller.ts') ? [path] : [];
  });
}

type Surface = 'admin' | 'internal' | 'other';

interface RouteFacts {
  /** `ClassName.method` - unique across the tree, and what the lists above use. */
  readonly key: string;
  readonly file: string;
  readonly surface: Surface;
  readonly guards: readonly string[];
  readonly hasRequiredPermission: boolean;
}

function unquote(literal: string): string {
  return literal.replace(/^['"`]|['"`]$/g, '');
}

/**
 * The surface a route belongs to, from its FULL path.
 *
 * Not from the `@Controller()` argument alone: two analytics controllers
 * declare `@Controller()` with no base and spell `admin/analytics/...` on each
 * handler, so reading only the base classifies fifteen fully-gated admin routes
 * as "other" and the exemption list absorbs the mistake.
 */
function surfaceOf(basePath: string, handlerPath: string): Surface {
  const full = [unquote(basePath), unquote(handlerPath)]
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter((part) => part.length > 0)
    .join('/');
  if (full === 'admin' || full.startsWith('admin/')) return 'admin';
  if (full === 'internal' || full.startsWith('internal/')) return 'internal';
  return 'other';
}

/**
 * A route is governed by the admin rules when it is under `admin/` OR when it
 * presents the admin credential from somewhere else. `ai-chat` is the second
 * case: base path outside `admin/`, but `AdminJwtAuthGuard` + `RbacGuard` +
 * `@RequirePermission('settings', 'edit')` on the class. Keying the rule to the
 * credential rather than to the URL prefix means moving an admin route to a
 * different prefix cannot quietly move it out of scope.
 */
function isAdminGoverned(route: RouteFacts): boolean {
  return route.surface === 'admin' || route.guards.includes('AdminJwtAuthGuard');
}

function collectRoutes(): readonly RouteFacts[] {
  const routes: RouteFacts[] = [];
  for (const file of controllerFiles(sourceRoot)) {
    const source = readFileSync(file, 'utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    tree.forEachChild((node) => {
      if (!ts.isClassDeclaration(node) || node.name === undefined) return;
      const classDecorators = decoratorsOf(node);
      const controller = classDecorators.find((d) => d.name === 'Controller');
      if (!controller) return;
      const basePath =
        controller.call && controller.call.arguments.length > 0
          ? controller.call.arguments[0]!.getText()
          : '';
      const classGuards = guardsOf(node);
      const classHasPermission = classDecorators.some((d) => d.name === 'RequirePermission');

      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const memberDecorators = decoratorsOf(member);
        const httpDecorator = memberDecorators.find((d) =>
          HTTP_METHOD_DECORATORS.has(d.name),
        );
        if (httpDecorator === undefined) continue;
        const handlerPath =
          httpDecorator.call && httpDecorator.call.arguments.length > 0
            ? httpDecorator.call.arguments[0]!.getText()
            : '';
        routes.push({
          key: `${node.name!.text}.${member.name.getText(tree)}`,
          file: relative(process.cwd(), file).split(sep).join('/'),
          surface: surfaceOf(basePath, handlerPath),
          guards: [...classGuards, ...guardsOf(member)],
          // Resolved the way `RbacGuard` resolves it: `getAllAndOverride`
          // over [handler, class], so either level counts.
          hasRequiredPermission:
            classHasPermission || memberDecorators.some((d) => d.name === 'RequirePermission'),
        });
      }
    });
  }
  return routes;
}

const routes = collectRoutes();

test('the route scan actually found the controllers it claims to check', () => {
  // A guard-coverage spec that silently collected nothing would pass every
  // assertion below and mean none of them. The floor is deliberately well under
  // the current count (600+ routes across 100+ controllers) so it fails on a
  // broken scan, not on ordinary growth or removal.
  assert.ok(
    routes.length > 300,
    `only ${routes.length} routes were parsed out of src/ - the scan is broken, not the tree`,
  );
  const keys = routes.map((route) => route.key);
  assert.deepEqual(
    keys.filter((key, index) => keys.indexOf(key) !== index),
    [],
    'two routes share a Class.method key, so the exemption lists below are ambiguous',
  );
});

test('every admin route is authenticated as an admin', () => {
  const failures = routes
    .filter((route) => route.surface === 'admin')
    .filter((route) => !UNAUTHENTICATED_ROUTES.has(route.key))
    .filter((route) => !route.guards.includes('AdminJwtAuthGuard'))
    .map((route) => `${route.key} (${route.file})`);
  assert.deepEqual(
    failures,
    [],
    'admin/* routes reachable without AdminJwtAuthGuard. Add the guard, or - if the route is '
      + 'genuinely meant to be served to anonymous callers - name it in UNAUTHENTICATED_ROUTES '
      + 'with the reason. @Public() is not an answer: nothing reads it',
  );
});

test('every admin route is gated on a permission, not merely on being signed in', () => {
  const failures = routes
    .filter(isAdminGoverned)
    .filter(
      (route) =>
        !UNAUTHENTICATED_ROUTES.has(route.key) && !SELF_SERVICE_ADMIN_ROUTES.has(route.key),
    )
    .filter((route) => !route.guards.includes('RbacGuard') || !route.hasRequiredPermission)
    .map(
      (route) =>
        `${route.key} (${route.file}) [RbacGuard=${route.guards.includes('RbacGuard')} `
        + `@RequirePermission=${route.hasRequiredPermission}]`,
    );
  assert.deepEqual(
    failures,
    [],
    'admin/* routes that any authenticated admin can call regardless of role. Both halves are '
      + 'required: RbacGuard in @UseGuards, and a @RequirePermission on the handler or the class. '
      + 'A route acting only on the caller own account belongs in SELF_SERVICE_ADMIN_ROUTES',
  );
});

test('every internal route carries the service-to-service credential', () => {
  const failures = routes
    .filter((route) => route.surface === 'internal')
    .filter((route) => !UNAUTHENTICATED_ROUTES.has(route.key))
    .filter((route) => !route.guards.includes('InternalAdminAuthGuard'))
    .map((route) => `${route.key} (${route.file})`);
  assert.deepEqual(
    failures,
    [],
    'internal/* routes without InternalAdminAuthGuard. These are called by reiwa and the bot '
      + 'with a shared secret; an unguarded one is an open API over customer data',
  );
});

test('every route outside admin/ and internal/ presents a credential or is named public', () => {
  const failures = routes
    .filter((route) => route.surface === 'other')
    .filter(
      (route) =>
        !route.guards.includes('AdminJwtAuthGuard')
        && !route.guards.includes('InternalAdminAuthGuard'),
    )
    .filter((route) => !UNAUTHENTICATED_ROUTES.has(route.key))
    .map((route) => `${route.key} (${route.file})`);
  assert.deepEqual(
    failures,
    [],
    'routes on neither the admin nor the internal surface, carrying neither credential, and not '
      + 'named in UNAUTHENTICATED_ROUTES. Either move them under one of the two prefixes so they '
      + 'inherit that surface rules, or write down here who is meant to reach them',
  );
});

test('the exemption lists still describe routes that exist', () => {
  const known = new Set(routes.map((route) => route.key));
  const stale = [
    ...[...UNAUTHENTICATED_ROUTES.keys()].map((key) => `UNAUTHENTICATED_ROUTES: ${key}`),
    ...[...SELF_SERVICE_ADMIN_ROUTES.keys()].map((key) => `SELF_SERVICE_ADMIN_ROUTES: ${key}`),
  ].filter((entry) => !known.has(entry.slice(entry.indexOf(': ') + 2)));
  assert.deepEqual(
    stale,
    [],
    'an exemption names a route that no longer exists. Renaming a handler silently drops it out '
      + 'of the list it was exempted by, and the next reader has no way to tell an obsolete entry '
      + 'from a live one',
  );
});
