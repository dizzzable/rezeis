import 'reflect-metadata';

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';

import { HttpException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { AiConfigService } from '../src/modules/ai-config/services/ai-config.service';
import {
  AiChatService,
  selectEvictableConversations,
  type ConversationRecord,
} from '../src/modules/ai-chat/services/ai-chat.service';
import { FaqService } from '../src/modules/faq/services/faq.service';
import { PlanCatalogService } from '../src/modules/plans/services/plan-catalog.service';

/**
 * Who may read and write an AI-chat conversation.
 *
 * `AiChatController` is gated on `settings:edit`, and that spec covers the
 * gate: which admins reach the feature. This one covers the question the gate
 * cannot answer — of the admins who reach it, whose rows do they see.
 *
 * The state these tests were written against:
 *
 *   - `getHistory(conversationId)` took an id and no caller, so holding an id
 *     WAS the authorisation. Reading back another admin's transcript needed
 *     nothing but the string, and ids were `conv_${Date.now()}_${counter}` —
 *     minted from the clock and a counter that restarts at 0 on every boot.
 *   - `generateResponse(userId, message, conversationId)` took the owner from
 *     the request body, so a caller could append their turn, and the model's
 *     reply, to a conversation belonging to someone else.
 *   - `listConversations(userId)` filtered on a path segment the caller chose.
 *
 * All three are now keyed on the signed-in admin. Ownership is enforced in the
 * service rather than the controller on purpose: a check that lives in the
 * handler protects the route it is written on, and the next route to be added
 * starts unprotected.
 */

const ADMIN_A = 'admin-a';
const ADMIN_B = 'admin-b';

/**
 * A local OpenAI-compatible endpoint, so the tests exercise the real
 * `generateResponse` path — including the part that persists both turns.
 *
 * With AI-Support disabled the method returns early and stores nothing, which
 * would make "a stranger cannot write here" pass for the wrong reason: not
 * because the write was refused, but because no write was attempted.
 */
let baseUrl = '';
let server: http.Server;

before(async () => {
  server = http.createServer((request, response) => {
    request.on('data', () => undefined);
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl-stub',
          object: 'chat.completion',
          created: 0,
          model: 'stub-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'stub reply' },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the stub AI endpoint did not bind to a TCP port');
  }
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('AiChatService conversation ownership', () => {
  it('does not open another admin\'s conversation to whoever names its id', async () => {
    const service = await createService();
    const mine = service.createConversation(ADMIN_A);
    await service.generateResponse(ADMIN_A, 'my private question', mine.id);

    assert.throws(
      () => service.getHistory(ADMIN_B, mine.id),
      NotFoundException,
      'an admin holding only the conversation id read a transcript that is not theirs',
    );
    // And the refusal is not "nobody may read this": the owner still can.
    assert.deepStrictEqual(
      service.getHistory(ADMIN_A, mine.id).map((message) => message.content),
      ['my private question', 'stub reply'],
    );
  });

  it('answers "not yours" exactly as it answers "never existed"', async () => {
    const service = await createService();
    const mine = service.createConversation(ADMIN_A);
    await service.generateResponse(ADMIN_A, 'my private question', mine.id);

    const foreign = captureRefusal(() => service.getHistory(ADMIN_B, mine.id));
    const absent = captureRefusal(() =>
      service.getHistory(ADMIN_B, 'conv_00000000-0000-4000-8000-000000000000'),
    );

    // Status AND body, not just status: a shared 404 whose message differs is
    // the same oracle one HTTP hop later. If these two can be told apart, a
    // caller can confirm which ids are real without ever reading one, and the
    // unguessable id is all that stands between them and the whole store.
    assert.deepStrictEqual(foreign, absent);
    assert.equal(foreign.status, 404);
  });

  it('refuses a turn sent into another admin\'s conversation, and leaves it untouched', async () => {
    const service = await createService();
    const mine = service.createConversation(ADMIN_A);
    await service.generateResponse(ADMIN_A, 'my private question', mine.id);

    await assert.rejects(
      () => service.generateResponse(ADMIN_B, 'injected by a stranger', mine.id),
      NotFoundException,
      'a stranger appended a turn to a conversation they do not own',
    );

    assert.deepStrictEqual(
      service.getHistory(ADMIN_A, mine.id).map((message) => message.content),
      ['my private question', 'stub reply'],
      'the refused turn must not appear in the owner\'s transcript',
    );
  });

  it('keeps the owner\'s own conversation fully usable across turns', async () => {
    const service = await createService();
    const created = service.createConversation(ADMIN_A);
    // A real gap in the clock so the `updatedAt` assertion below is about the
    // field moving rather than about how fast the loopback socket was.
    await delay(2);

    const first = await service.generateResponse(ADMIN_A, 'first', created.id);
    const second = await service.generateResponse(ADMIN_A, 'second', created.id);

    assert.equal(first.conversationId, created.id);
    assert.equal(second.conversationId, created.id, 'a continued chat must stay one conversation');
    assert.deepStrictEqual(
      service.getHistory(ADMIN_A, created.id).map((message) => message.content),
      ['first', 'stub reply', 'second', 'stub reply'],
    );

    const listed = service.listConversations(ADMIN_A);
    assert.deepStrictEqual(
      listed.map((conversation) => conversation.id),
      [created.id],
    );
    assert.equal(listed[0].ownerAdminId, ADMIN_A);
    assert.deepStrictEqual(service.listConversations(ADMIN_B), []);
    assert.ok(
      listed[0].updatedAt.getTime() > listed[0].createdAt.getTime(),
      'updatedAt must move when a turn is appended — idle eviction reads it, and a field ' +
        'frozen at creation time would drop a conversation that is in daily use',
    );
  });

  it('does not let the conversation store grow without bound', async () => {
    const service = await createService();
    const created: ConversationRecord[] = [];
    for (let index = 0; index < 130; index += 1) {
      created.push(service.createConversation(ADMIN_A));
    }

    const kept = service.listConversations(ADMIN_A);
    assert.equal(kept.length, 100, 'the store must stop at its stated ceiling, not at uptime');
    // Newest kept, oldest dropped — and the dropped ones answer like any other
    // id the caller may not have.
    assert.deepStrictEqual(
      new Set(kept.map((conversation) => conversation.id)),
      new Set(created.slice(30).map((conversation) => conversation.id)),
    );
    assert.throws(() => service.getHistory(ADMIN_A, created[0].id), NotFoundException);
  });

  it('does not let a single conversation grow without bound', async () => {
    const service = await createService();
    const created = service.createConversation(ADMIN_A);
    for (let turn = 1; turn <= 45; turn += 1) {
      await service.generateResponse(ADMIN_A, `turn ${turn}`, created.id);
    }

    // 45 turns is 90 stored messages; the ceiling is 80.
    const history = service.getHistory(ADMIN_A, created.id);
    assert.equal(history.length, 80);
    assert.equal(history[history.length - 2].content, 'turn 45', 'the newest turns are the kept ones');
    assert.equal(history[0].content, 'turn 6', 'and the oldest are what goes');
  });

  it('marks conversations idle past the TTL as evictable, whatever the count', () => {
    const now = Date.parse('2026-08-14T12:00:00.000Z');
    const day = 24 * 60 * 60 * 1000;
    const records: readonly ConversationRecord[] = [
      buildRecord('conv_fresh', now - 60_000),
      buildRecord('conv_stale', now - day - 1),
      buildRecord('conv_exactly-a-day', now - day),
    ];

    // Tested through the exported rule because the age branch is otherwise
    // unreachable from the service without waiting a day — and an eviction
    // branch nothing exercises is one that deletes the wrong rows the first
    // time it runs, in a process nobody is watching.
    assert.deepStrictEqual(selectEvictableConversations(records, now), [
      'conv_stale',
      'conv_exactly-a-day',
    ]);
    assert.deepStrictEqual(selectEvictableConversations([records[0]], now), []);
  });
});

/** The service with a stub provider set: only the AI endpoint has to be real. */
async function createService(): Promise<AiChatService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      AiChatService,
      // `getTariffs` / `getFaq` are never reached: the stub endpoint above
      // always answers `finish_reason: 'stop'`, so the tool-calling loop does
      // not run and these three are only here to satisfy the constructor.
      { provide: PrismaService, useValue: {} },
      { provide: PlanCatalogService, useValue: {} },
      { provide: FaqService, useValue: {} },
      {
        provide: AiConfigService,
        useValue: {
          getSettings: async () => ({
            baseUrl,
            apiKey: 'stub-key',
            model: 'stub-model',
            modelsEndpoint: '',
            enabled: true,
            systemPrompt: '',
          }),
        },
      },
    ],
  }).compile();
  return moduleRef.get(AiChatService);
}

/** Status and body of the refusal a call produced, or a failure if it produced none. */
function captureRefusal(run: () => unknown): { readonly status: number; readonly body: unknown } {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpException) {
      return { status: error.getStatus(), body: error.getResponse() };
    }
    throw error;
  }
  return assert.fail('expected the call to be refused, but it returned a value');
}

function buildRecord(id: string, updatedAtMs: number): ConversationRecord {
  return {
    id,
    ownerAdminId: ADMIN_A,
    createdAt: new Date(updatedAtMs),
    updatedAt: new Date(updatedAtMs),
  };
}
