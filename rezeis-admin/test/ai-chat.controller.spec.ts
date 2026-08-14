import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AiChatController } from '../src/modules/ai-chat/controllers/ai-chat.controller';
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
 *   - `GET conversations/:conversationId/messages` reads back a conversation by
 *     id with no ownership check, and ids are minted as
 *     `conv_${Date.now()}_${counter}` (`ai-chat.service.ts:261`) — guessable by
 *     construction, so any authenticated admin could enumerate another
 *     caller's transcript.
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
        path: 'conversations/:userId',
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

  it('delegates each route to AiChatService', async () => {
    const calls: unknown[] = [];
    const controller = new AiChatController({
      generateResponse: async (userId: string, message: string, conversationId?: string) => {
        calls.push(['generateResponse', userId, message, conversationId]);
        return { reply: 'hi', conversationId: 'conv_1' };
      },
      createConversation: (userId: string) => {
        calls.push(['createConversation', userId]);
        return { id: 'conv_1', userId, createdAt: new Date(0), updatedAt: new Date(0) };
      },
      listConversations: (userId: string) => {
        calls.push(['listConversations', userId]);
        return [];
      },
      getHistory: (conversationId: string) => {
        calls.push(['getHistory', conversationId]);
        return [];
      },
      searchKnowledge: async (query: string) => {
        calls.push(['searchKnowledge', query]);
        return 'nothing yet';
      },
    } as never);

    assert.deepStrictEqual(
      await controller.sendMessage({ userId: 'u-1', message: 'hello', conversationId: 'conv_1' }),
      { reply: 'hi', conversationId: 'conv_1' },
    );
    assert.deepStrictEqual(controller.createConversation({ userId: 'u-1' }), {
      id: 'conv_1',
      userId: 'u-1',
    });
    assert.deepStrictEqual(controller.listConversations('u-1'), []);
    assert.deepStrictEqual(controller.getConversationMessages('conv_1'), []);
    assert.deepStrictEqual(await controller.searchKnowledge({ query: 'vpn' }), {
      result: 'nothing yet',
    });

    assert.deepStrictEqual(calls, [
      ['generateResponse', 'u-1', 'hello', 'conv_1'],
      ['createConversation', 'u-1'],
      ['listConversations', 'u-1'],
      ['getHistory', 'conv_1'],
      ['searchKnowledge', 'vpn'],
    ]);
  });
});
