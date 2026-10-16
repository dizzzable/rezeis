import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AiConfigSettings } from '../src/modules/ai-config/interfaces/ai-config.interface';
import {
  SupportAiResponderService,
  type SupportAiModelClient,
} from '../src/modules/support-ai/support-ai-responder.service';

/**
 * The AI assistant answering inside a ticket (16.10.2026): its reply is an
 * ordinary support reply the client is told about, its transfer goes to the
 * operators, and it never talks over a person who got there first.
 */

interface Message {
  id: string;
  authorType: 'USER' | 'ADMIN' | 'SYSTEM';
  content: string;
  metadata: unknown;
  attachments: Array<{ filename: string }>;
}

type Completion = { content: string | null; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> };

function build(opts: {
  readonly messages?: Message[];
  readonly aiActive?: boolean;
  readonly completions?: Completion[];
  readonly aiReplies?: number;
  readonly enabled?: boolean;
  /** Runs while the model "thinks" — an operator answering, the client writing. */
  readonly duringModel?: (state: { aiActive: boolean; messages: Message[] }) => void;
} = {}) {
  const state = {
    aiActive: opts.aiActive ?? true,
    messages: opts.messages ?? [{ id: 'm-1', authorType: 'USER', content: 'Не работает VPN', metadata: null, attachments: [] }],
  };
  const written: Array<{ authorType: string; authorId: string | null; content: string; metadata: unknown }> = [];
  const notified: string[] = [];
  const handOffs: string[] = [];
  const modelCalls: unknown[] = [];

  const prisma = {
    supportTicket: {
      findUnique: async () => ({
        id: 't-1',
        subject: 'VPN',
        status: 'OPEN',
        aiActive: state.aiActive,
        user: { id: 'u-1', language: 'EN' },
        messages: [...state.messages].reverse(),
      }),
    },
    supportTicketMessage: { count: async () => opts.aiReplies ?? 0 },
  };
  const aiConfig = {
    getSettings: async (): Promise<AiConfigSettings> => ({
      enabled: opts.enabled !== false,
      apiKey: 'sk-test',
      baseUrl: '',
      model: 'test-model',
      modelsEndpoint: '',
      systemPrompt: '',
    }),
  };
  const tickets = {
    addMessage: async (input: { authorType: Message['authorType']; authorId: string | null; content: string; metadata?: unknown }) => {
      written.push({ authorType: input.authorType, authorId: input.authorId, content: input.content, metadata: input.metadata });
      state.messages.push({ id: `w-${written.length}`, authorType: input.authorType, content: input.content, metadata: input.metadata ?? null, attachments: [] });
    },
  };
  const dispatch = {
    handOff: async (_ticketId: string, reason: string) => {
      if (!state.aiActive) return false;
      state.aiActive = false;
      handOffs.push(reason);
      return true;
    },
  };
  const completions = [...(opts.completions ?? [{ content: 'Переустановите профиль.' }])];

  class Scripted extends SupportAiResponderService {
    protected override createClient(): SupportAiModelClient {
      return {
        chat: {
          completions: {
            create: async (params) => {
              modelCalls.push(params);
              opts.duringModel?.(state);
              const next = completions.shift() ?? { content: '' };
              return {
                id: 'c',
                object: 'chat.completion',
                created: 0,
                model: 'test-model',
                choices: [
                  {
                    index: 0,
                    finish_reason: next.toolCalls ? 'tool_calls' : 'stop',
                    logprobs: null,
                    message: {
                      role: 'assistant',
                      content: next.content,
                      refusal: null,
                      ...(next.toolCalls
                        ? {
                            tool_calls: next.toolCalls.map((call, i) => ({
                              id: `call-${i}`,
                              type: 'function' as const,
                              function: { name: call.name, arguments: JSON.stringify(call.args) },
                            })),
                          }
                        : {}),
                    },
                  },
                ],
              } as never;
            },
          },
        },
      };
    }
  }

  const service = new Scripted(
    prisma as never,
    aiConfig as never,
    { getPublicInstructions: async () => [] } as never,
    { getCatalogPlans: async () => [] } as never,
    { getPublicFaq: async () => [] } as never,
    tickets as never,
    { notifyAdminReply: async (input: { ticketId: string }) => void notified.push(input.ticketId) } as never,
    dispatch as never,
  );
  return { service, state, written, notified, handOffs, modelCalls };
}

describe('the assistant answers in the ticket', () => {
  it('as an ordinary support reply, marked for the panel, and tells the client', async () => {
    const { service, written, notified, handOffs } = build();
    assert.equal(await service.answer({ ticketId: 't-1', messageId: 'm-1' }), 'answered');
    assert.equal(written.length, 1);
    assert.equal(written[0].authorType, 'ADMIN');
    assert.equal(written[0].authorId, null);
    assert.deepEqual(written[0].metadata, { ai: true, model: 'test-model' });
    assert.equal(written[0].content, 'Переустановите профиль.');
    assert.deepEqual(notified, ['t-1'], 'told the way an operator\'s reply is');
    assert.deepEqual(handOffs, []);
  });

  it('stands down when the job\'s message is no longer the last word', async () => {
    const { service, written, modelCalls } = build({
      messages: [
        { id: 'm-1', authorType: 'USER', content: 'раз', metadata: null, attachments: [] },
        { id: 'm-2', authorType: 'USER', content: 'два', metadata: null, attachments: [] },
      ],
    });
    assert.equal(await service.answer({ ticketId: 't-1', messageId: 'm-1' }), 'skipped');
    assert.equal(modelCalls.length, 0, 'no paid call for a message the next job answers');
    assert.equal(written.length, 0);
  });

  it('stands down when it no longer leads the thread', async () => {
    const { service, written } = build({ aiActive: false });
    assert.equal(await service.answer({ ticketId: 't-1', messageId: 'm-1' }), 'skipped');
    assert.equal(written.length, 0);
  });

  it('never talks over an operator who answered while the model was writing', async () => {
    const { service, written } = build({
      duringModel: (state) => {
        state.aiActive = false;
        state.messages.push({ id: 'op-1', authorType: 'ADMIN', content: 'Я помогу', metadata: null, attachments: [] });
      },
    });
    assert.equal(await service.answer({ ticketId: 't-1', messageId: 'm-1' }), 'skipped');
    assert.equal(written.length, 0);
  });

  it('throws on an empty answer, so the job is retried and, at last, handed over', async () => {
    const { service } = build({ completions: [{ content: '   ' }] });
    await assert.rejects(() => service.answer({ ticketId: 't-1', messageId: 'm-1' }), /no text/);
  });
});

describe('the assistant hands the thread over', () => {
  it('writes its own words to the client, then calls the operators with its reason', async () => {
    const { service, written, handOffs } = build({
      completions: [
        { content: null, toolCalls: [{ name: 'transfer_to_operator', args: { reason: 'возврат денег' } }] },
        { content: 'Передаю ваш вопрос специалисту, он ответит здесь.' },
      ],
    });
    assert.equal(await service.answer({ ticketId: 't-1', messageId: 'm-1' }), 'handed_off');
    assert.equal(written.length, 1);
    assert.equal(written[0].content, 'Передаю ваш вопрос специалисту, он ответит здесь.');
    assert.deepEqual(handOffs, ['возврат денег']);
  });

  it('still says something to the client when the model wrote nothing, in the client\'s language', async () => {
    const { service, written } = build({
      completions: [
        { content: null, toolCalls: [{ name: 'transfer_to_operator', args: { reason: 'человек' } }] },
        { content: '' },
      ],
    });
    await service.answer({ ticketId: 't-1', messageId: 'm-1' });
    assert.match(written[0].content, /^Передал ваш вопрос специалисту/, 'Cyrillic in, Russian out');
  });

  it('after its answers run out, without calling the model again', async () => {
    const { service, written, handOffs, modelCalls } = build({ aiReplies: 12 });
    assert.equal(await service.answer({ ticketId: 't-1', messageId: 'm-1' }), 'handed_off');
    assert.deepEqual(handOffs, ['ai_limit']);
    assert.equal(modelCalls.length, 0);
    assert.equal(written.length, 1, 'one line to the client');
  });

  it('when it was switched off under the thread', async () => {
    const { service, handOffs } = build({ enabled: false });
    assert.equal(await service.answer({ ticketId: 't-1', messageId: 'm-1' }), 'handed_off');
    assert.deepEqual(handOffs, ['ai_off']);
  });

  it('when every attempt failed, with a line to the client — once', async () => {
    const { service, written, handOffs } = build();
    await service.giveUp({ ticketId: 't-1', messageId: 'm-1' });
    await service.giveUp({ ticketId: 't-1', messageId: 'm-1' });
    assert.deepEqual(handOffs, ['ai_error']);
    assert.equal(written.length, 1);
  });
});
