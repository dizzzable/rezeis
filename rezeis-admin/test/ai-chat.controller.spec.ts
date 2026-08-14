import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { AiChatController } from '../src/modules/ai-chat/controllers/ai-chat.controller';
import { AiChatService } from '../src/modules/ai-chat/services/ai-chat.service';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { SYSTEM_ROLES, isValidPermission } from '../src/modules/rbac/rbac.resources';
import {
  assertEffectiveRoutePermission,
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  routeLabel,
  type RouteHandler,
  type RoutePermission,
} from './helpers/controller-routes';

/** Where the controller answers — stated once, checked below and used in labels. */
const BASE_PATH = 'ai-chat';

/**
 * The same gate the rest of the AI-Support feature already carries:
 * `AdminAiConfigController` and `AdminAiInstructionController` both declare
 * `@RequirePermission('settings', 'edit')` on the class. Configuring the
 * assistant and driving it are one feature with one owner, so they share one
 * permission rather than drifting apart.
 *
 * Two properties of these routes make the previous state — admin JWT only —
 * worth closing rather than recording as intentional:
 *
 *   - `POST message` spends the operator's money. It calls the OpenAI-compatible
 *     endpoint configured in AI-Support settings with the stored API key, in a
 *     tool-calling loop that can issue several completions per request.
 *   - the transcript routes read and write stored conversations, and this gate
 *     is what decides which admins reach them at all.
 *
 * The gate is not the whole answer and never was. `GET
 * conversations/:conversationId/messages` used to return any transcript to any
 * holder of `settings:edit` who named its id — ids minted as
 * `conv_${Date.now()}_${counter}`, guessable by construction — and `POST
 * message` took the conversation's owner from the request body. Who owns a
 * conversation is now the signed-in admin, enforced in the service and pinned
 * by `ai-chat.service.spec.ts`; this spec covers the gate, which is the
 * question of who may use the feature rather than whose rows they see.
 */
const SETTINGS_EDIT: RoutePermission = { resource: 'settings', action: 'edit' };

/** An AI-chat route as this spec states it. */
interface AiChatRoute {
  readonly handler: RouteHandler;
  readonly method: RequestMethod;
  readonly path: string;
}

describe('AiChatController', () => {
  it('is guarded by admin JWT and RBAC guards', () => {
    // The controller's own docblock used to read "Authentication is
    // intentionally omitted for now" while `AdminJwtAuthGuard` was in fact
    // applied — the comment describing the gate and the gate itself had already
    // drifted once. `RbacGuard` is asserted here rather than inferred from the
    // class decorator because without it the decorator sets metadata nobody
    // reads: the route looks gated and admits everyone.
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, AiChatController), [
      AdminJwtAuthGuard,
      RbacGuard,
    ]);
  });

  it('gates every AI chat route on settings:edit', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AiChatController), BASE_PATH);
    assertRouteHandlers(AiChatController, [
      'createConversation',
      'getConversationMessages',
      'listConversations',
      'searchKnowledge',
      'sendMessage',
    ]);

    const routes: readonly AiChatRoute[] = [
      {
        handler: AiChatController.prototype.sendMessage,
        method: RequestMethod.POST,
        path: 'message',
      },
      {
        handler: AiChatController.prototype.createConversation,
        method: RequestMethod.POST,
        path: 'conversations',
      },
      {
        handler: AiChatController.prototype.listConversations,
        method: RequestMethod.GET,
        // Was `conversations/:userId`. The parameter is gone, not validated —
        // the owner comes from the JWT, so there is nothing left for a caller
        // to name. Worth stating here because the two `conversations/:*` routes
        // never did shadow each other (Express matches `:userId` against a
        // single segment, so `/conversations/x/messages` reached only the
        // messages route) — the leak was the missing owner check, not routing.
        path: 'conversations',
      },
      {
        handler: AiChatController.prototype.getConversationMessages,
        method: RequestMethod.GET,
        path: 'conversations/:conversationId/messages',
      },
      {
        handler: AiChatController.prototype.searchKnowledge,
        method: RequestMethod.POST,
        path: 'search',
      },
    ];

    for (const route of routes) {
      const label = routeLabel(BASE_PATH, route.method, route.path);
      assertRoute(route.handler, { method: route.method, path: route.path }, label);
      // Resolved the way `RbacGuard` resolves it — through handler THEN class —
      // because the gate is declared once on the class. Reading the handler
      // alone would return `undefined` for every route here.
      assertEffectiveRoutePermission(AiChatController, route.handler, SETTINGS_EDIT, label);
    }

    // A sixth route added to this controller inherits the class gate, so it is
    // covered the moment it exists — but it still has to be NOTICED, which is
    // what `assertRouteHandlers` above forces. This line covers the other case:
    // a route that overrides the class gate with its own empty or absent one.
    assertEveryRouteGuarded(AiChatController, []);
  });

  it('declares settings:edit in the catalog and names the roles the gate excludes', () => {
    assert.equal(isValidPermission(SETTINGS_EDIT.resource, SETTINGS_EDIT.action), true);

    // Unlike the quick-search gate, this one DOES narrow the surface, and the
    // roles it narrows it to are worth writing down rather than discovering in
    // production. `settings:edit` is held by `superadmin` alone among the
    // seeds — the same set that could already configure AI-Support — so this
    // spec pins the intended answer instead of asserting "nobody lost anything".
    const holders = SYSTEM_ROLES.filter((seed) =>
      seed.permissions.some(
        (p) => p.resource === SETTINGS_EDIT.resource && p.action === SETTINGS_EDIT.action,
      ),
    ).map((seed) => seed.name);
    assert.deepStrictEqual(
      holders,
      [],
      'no non-superadmin seed is expected to hold settings:edit — if one now does, the AI chat ' +
        'surface just widened to it and that has to be a decision, not a side effect',
    );
  });

  it('delegates each route to AiChatService, naming the subject from the JWT', async () => {
    const calls: unknown[] = [];
    const stub = {
      generateResponse: async (ownerAdminId: string, message: string, conversationId?: string) => {
        calls.push(['generateResponse', ownerAdminId, message, conversationId]);
        return { reply: 'hi', conversationId: 'conv_1' };
      },
      createConversation: (ownerAdminId: string) => {
        calls.push(['createConversation', ownerAdminId]);
        return {
          id: 'conv_1',
          ownerAdminId,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
      },
      listConversations: (ownerAdminId: string) => {
        calls.push(['listConversations', ownerAdminId]);
        return [];
      },
      getHistory: (ownerAdminId: string, conversationId: string) => {
        calls.push(['getHistory', ownerAdminId, conversationId]);
        return [];
      },
      searchKnowledge: async (query: string) => {
        calls.push(['searchKnowledge', query]);
        return 'nothing yet';
      },
    } satisfies Pick<
      AiChatService,
      | 'createConversation'
      | 'generateResponse'
      | 'getHistory'
      | 'listConversations'
      | 'searchKnowledge'
    >;

    // Built through the DI container. The previous spelling constructed the
    // controller directly and widened the stub to `never` to make it compile,
    // which switched off the only check that ties these arguments to the real
    // service signature — and the argument that matters here is the one that
    // changed: each handler now passes the ADMIN's id.
    // The guards are overridden rather than wired: Nest instantiates the
    // enhancers of anything it loads, and the real `RbacGuard` drags in
    // `RbacService`, `PrismaService` and most of a real container for a test
    // that calls five methods directly. Nothing is lost — which guards are
    // attached is asserted from metadata in the first test, and no request
    // passes through them here.
    const moduleRef = await Test.createTestingModule({
      providers: [AiChatController, { provide: AiChatService, useValue: stub }],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RbacGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const controller = moduleRef.get(AiChatController);
    const admin = buildAdmin('admin-7');

    assert.deepStrictEqual(
      await controller.sendMessage(admin, { message: 'hello', conversationId: 'conv_1' }),
      { reply: 'hi', conversationId: 'conv_1' },
    );
    assert.deepStrictEqual(controller.createConversation(admin), { id: 'conv_1' });
    assert.deepStrictEqual(controller.listConversations(admin), []);
    assert.deepStrictEqual(controller.getConversationMessages(admin, 'conv_1'), []);
    assert.deepStrictEqual(await controller.searchKnowledge({ query: 'vpn' }), {
      result: 'nothing yet',
    });

    // Every subject below is `admin-7` — the id from the token — and none of it
    // came off the wire. The four routes that used to accept a `userId` in the
    // body or the path have nowhere left to read one from.
    assert.deepStrictEqual(calls, [
      ['generateResponse', 'admin-7', 'hello', 'conv_1'],
      ['createConversation', 'admin-7'],
      ['listConversations', 'admin-7'],
      ['getHistory', 'admin-7', 'conv_1'],
      ['searchKnowledge', 'vpn'],
    ]);
  });
});

/** The shape `@CurrentAdmin()` hands a handler, with only the id varying. */
function buildAdmin(id: string): CurrentAdminInterface {
  return {
    id,
    login: 'root',
    email: null,
    name: null,
    role: UserRole.ADMIN,
    isActive: true,
    tokenVersion: 1,
    createdAt: new Date(0),
    lastLoginAt: null,
    lastLoginIp: null,
    rbacRoleId: null,
    mustChangePassword: false,
  };
}
