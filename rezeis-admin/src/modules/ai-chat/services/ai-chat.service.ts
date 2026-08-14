import { randomUUID } from 'node:crypto';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import OpenAI from 'openai';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { PurchaseChannel } from '../../../common/types/prisma-enums';
import type { PlanCatalogQueryContextInterface } from '../../plans/interfaces/plan-catalog.interface';
import { PlanCatalogService } from '../../plans/services/plan-catalog.service';
import { FaqService } from '../../faq/services/faq.service';
import { AiConfigService } from '../../ai-config/services/ai-config.service';

// ── Exported types / constants ──────────────────────────────────────────────

/** Names of the AI-callable functions exposed to the model. */
export type AiChatToolName = 'getTariffs' | 'getFaq';

/** OpenAI tool definitions for function calling. */
export const AI_TOOL_DEFINITIONS: readonly ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'getTariffs',
      description:
        'Получить список активных тарифов (планов подписки) из панели управления. Возвращает названия, описания, лимиты и цены.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getFaq',
      description:
        'Получить список активных вопросов и ответов из базы знаний (FAQ). Можно фильтровать по языку.',
      parameters: {
        type: 'object',
        properties: {
          locale: {
            type: 'string',
            description:
              'Код языка для фильтрации FAQ (например "ru" или "en"). Если не указан, возвращаются все активные записи.',
          },
        },
        required: [],
      },
    },
  },
] as const;

// ── Internal types ──────────────────────────────────────────────────────────

export interface ConversationRecord {
  readonly id: string;
  /**
   * The signed-in admin this conversation belongs to, and the only thing that
   * opens it.
   *
   * It used to be `userId`, taken from the request body or the URL, which made
   * the caller the author of their own identity: `POST message` accepted any
   * `userId`, and `GET conversations/:conversationId/messages` accepted any id
   * with no owner check at all. There is exactly one identity a request to this
   * controller actually proves — the admin in the JWT — so that is the one
   * recorded here. Nothing a caller can type participates in access.
   *
   * Named for the principal rather than left as `userId` on purpose: the whole
   * defect was a field that read like an owner and was not one.
   */
  readonly ownerAdminId: string;
  readonly createdAt: Date;
  /** Last time a turn was appended. Drives idle eviction — see below. */
  readonly updatedAt: Date;
}

export interface MessageRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: Date;
}

/**
 * Ceilings for the in-memory store.
 *
 * The store used to be two module-level `Map`s that nothing ever cleaned:
 * every conversation and every message a process had ever seen stayed
 * resident until restart, so the only bound on memory was uptime. These three
 * numbers replace "grows until something dies" with a stated worst case:
 * 100 conversations x 80 messages x ~4 KB of content (the `SendMessageDto`
 * cap, and `max_tokens: 1024` on the reply) is on the order of 32 MB, and that
 * is the pathological ceiling rather than the expected size.
 *
 * The cap is global, not per admin. Two superadmins chatting hard can evict
 * each other's oldest threads — an availability nuisance on a surface with no
 * UI, and the alternative (per-owner caps) makes the total unbounded again in
 * the number of admins.
 */
const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES_PER_CONVERSATION = 80;
const CONVERSATION_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The single answer to "that conversation is not yours" AND "there is no such
 * conversation".
 *
 * Two different answers would be an existence oracle: a caller who can tell
 * "403" from "404" can confirm which conversation ids are real without ever
 * reading one. It carries no id, both because it has nothing to say to a
 * caller who does not own the row and because `AdminSafeExceptionFilter`
 * scrubs id-shaped text out of error bodies anyway.
 */
const CONVERSATION_NOT_FOUND = 'Conversation not found';

/**
 * Which conversations must leave the store, given all of them and the current
 * instant: the ones idle past the TTL, plus the least recently touched of
 * whatever is left over the cap.
 *
 * Pure and exported so both rules can be tested. The age rule is otherwise
 * unreachable from the service's public surface without waiting a day, and an
 * eviction branch that nothing exercises is an eviction branch that deletes
 * the wrong rows the first time it runs.
 */
export function selectEvictableConversations(
  records: readonly ConversationRecord[],
  now: number,
): string[] {
  const evictable: string[] = [];
  const live: ConversationRecord[] = [];
  for (const record of records) {
    if (now - record.updatedAt.getTime() >= CONVERSATION_IDLE_TTL_MS) {
      evictable.push(record.id);
    } else {
      live.push(record);
    }
  }
  if (live.length > MAX_CONVERSATIONS) {
    // Oldest touch first: the threads the caller is least likely still in.
    live.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
    for (const record of live.slice(0, live.length - MAX_CONVERSATIONS)) {
      evictable.push(record.id);
    }
  }
  return evictable;
}

/**
 * AI Chat service — interfaces with an OpenAI-compatible API to provide
 * a conversational support agent that answers questions about the Rezeis
 * platform, VPN connection troubleshooting, and the FAQ.
 *
 * The system prompt is tuned for a friendly, Russian-speaking VPN support
 * persona. No Remnawave / Xray / protocol details are exposed.
 *
 * Supports OpenAI function calling: the model can query live tariff data
 * (PlanCatalogService) and FAQ (FaqService) at runtime instead of relying
 * on static knowledge.
 *
 * Who owns a conversation
 *   The signed-in admin, and nobody else. The persona above is written for
 *   subscribers ("обратитесь в поддержку через тикеты" is advice you give a
 *   customer, not an operator), but the only surface that reaches this service
 *   is `AiChatController`, gated on `settings:edit` — superadmin alone. So the
 *   only principal a request proves is the admin in the JWT, and that is what
 *   {@link ConversationRecord.ownerAdminId} holds.
 *
 *   If a subscriber-facing surface is ever added, it arrives with its own
 *   guard and its own authenticated principal; the owner is read from that
 *   guard the same way. What must not come back either way is an owner named
 *   by the caller in a body field or a path segment, which is what this used
 *   to do.
 */
@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);

  /** Number of recent message pairs to include as context. */
  private readonly contextWindow = 10;

  /**
   * Per-instance, in-memory, and deliberately still not a database.
   *
   * Instance fields rather than the module-level `Map`s they replace: two
   * services would have silently shared one store, and every spec in a process
   * inherited whatever the previous one left behind.
   *
   * The properties a reader should not have to discover: this survives
   * requests, not restarts; the API and worker containers each hold their own
   * copy and never see each other's; and a second API replica would answer
   * "no such conversation" for a thread its sibling is holding. All three are
   * acceptable only because this surface has no UI and no callers — see the
   * eviction ceilings above for what keeps it bounded meanwhile.
   */
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly messages = new Map<string, MessageRecord[]>();

  public constructor(
    private readonly prisma: PrismaService,
    private readonly planCatalogService: PlanCatalogService,
    private readonly faqService: FaqService,
    private readonly aiConfigService: AiConfigService,
  ) {}

  /**
   * Builds an OpenAI client from panel AI-Support settings (encrypted key).
   * Returns null when disabled or unconfigured — never reads OPENAI_* env.
   */
  private async resolveClient(): Promise<{
    openai: OpenAI;
    model: string;
    systemPrompt: string;
  } | null> {
    const settings = await this.aiConfigService.getSettings();
    if (!settings.enabled || !settings.apiKey) {
      return null;
    }
    return {
      openai: new OpenAI({
        apiKey: settings.apiKey,
        ...(settings.baseUrl ? { baseURL: settings.baseUrl } : {}),
      }),
      model: settings.model || 'gpt-4o-mini',
      systemPrompt: settings.systemPrompt || '',
    };
  }

  /**
   * Generates a response from the AI model given a user message and
   * optional conversation context.
   *
   * Uses OpenAI function calling: the model can request live tariff data
   * (getTariffs) or FAQ entries (getFaq). Tool calls are resolved against
   * PlanCatalogService / FaqService and the results are fed back to the
   * model until a final text response is produced.
   *
   * `ownerAdminId` is the signed-in admin, never a caller-supplied id. Passing
   * a `conversationId` owned by someone else answers exactly as an unknown one
   * does.
   */
  public async generateResponse(
    ownerAdminId: string,
    message: string,
    conversationId?: string,
  ): Promise<{ reply: string; conversationId: string }> {
    // Authorise before anything else — before the provider call that spends
    // the operator's money, and before the "AI is off" early return below.
    // Ordered this way so "you may not write here" is the answer whatever the
    // panel's AI-Support settings happen to say; a refusal that depends on
    // configuration is a refusal that stops when the configuration changes.
    const existing =
      conversationId === undefined
        ? null
        : this.requireOwnConversation(ownerAdminId, conversationId);

    const runtime = await this.resolveClient();
    if (!runtime) {
      return {
        reply:
          '🤖 AI-чат временно недоступен. Пожалуйста, обратитесь в поддержку ' +
          'через тикеты или напишите в Telegram. (настройте AI-Support в панели)',
        conversationId: existing?.id ?? 'none',
      };
    }

    // Resolve or create conversation
    const convoId = existing?.id ?? this.createConversation(ownerAdminId).id;

    // Build message history for context
    const history = this.readHistory(convoId);
    const recentMessages = history.slice(-this.contextWindow * 2);

    const systemPrompt = this.buildSystemPrompt(runtime.systemPrompt);

    // Use OpenAI SDK native types so we can pass tool messages
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...recentMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: message },
    ];

    try {
      let response = await runtime.openai.chat.completions.create({
        model: runtime.model,
        messages,
        tools: [...AI_TOOL_DEFINITIONS],
        tool_choice: 'auto',
        temperature: 0.7,
        max_tokens: 1024,
      });

      let choice = response.choices[0];

      // ── Tool-calling loop ──────────────────────────────────────────
      // Keep resolving tool calls until the model returns a plain-text reply.
      while (choice.finish_reason === 'tool_calls') {
        const assistantMsg = choice.message;
        // `finish_reason` and `tool_calls` arrive as independent fields, and a
        // custom OpenAI-compatible endpoint (the AI-Support settings allow one)
        // can report the first without the second. Bind the array once so the
        // check that ends the loop and the iteration below read the same value.
        const toolCalls = assistantMsg.tool_calls;
        if (!toolCalls) break;

        messages.push(assistantMsg);

        for (const toolCall of toolCalls) {
          const args: Record<string, unknown> = JSON.parse(toolCall.function.arguments);
          let result: string;

          switch (toolCall.function.name as AiChatToolName) {
            case 'getTariffs':
              result = await this.executeGetTariffs();
              break;
            case 'getFaq':
              result = await this.executeGetFaq(args.locale as string | undefined);
              break;
            default:
              result = JSON.stringify({
                error: `Неизвестная функция: ${toolCall.function.name}`,
              });
              break;
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result,
          });
        }

        // Next iteration — send tool results back to the model
        response = await runtime.openai.chat.completions.create({
          model: runtime.model,
          messages,
          tools: [...AI_TOOL_DEFINITIONS],
          tool_choice: 'auto',
          temperature: 0.7,
          max_tokens: 1024,
        });

        choice = response.choices[0];
      }

      const reply = choice.message?.content ?? '…';

      // Persist to in-memory store
      this.saveMessage(convoId, 'user', message);
      this.saveMessage(convoId, 'assistant', reply);

      return { reply, conversationId: convoId };
    } catch (error) {
      this.logger.error(
        `OpenAI API call failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
      return {
        reply:
          '😔 Произошла ошибка при обращении к AI. Пожалуйста, повторите попытку позже.',
        conversationId: convoId,
      };
    }
  }

  /**
   * Creates a new conversation owned by the signed-in admin.
   *
   * Ids were `conv_${Date.now()}_${counter}` — guessable by construction, so
   * an id was both the name of a conversation and, in the absence of any owner
   * check, the permission to read it. The owner check is what closes that; a
   * random id is the belt to its braces, and removes the enumeration entirely
   * rather than making it merely useless.
   */
  public createConversation(ownerAdminId: string): ConversationRecord {
    const now = new Date();
    const record: ConversationRecord = {
      id: `conv_${randomUUID()}`,
      ownerAdminId,
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(record.id, record);
    this.messages.set(record.id, []);
    // After the insert, so `size <= MAX_CONVERSATIONS` holds after every write
    // rather than one write later.
    this.evictOverflow();
    return record;
  }

  /**
   * Lists the conversations belonging to the signed-in admin.
   *
   * There is no way to ask for anyone else's: the route that used to take a
   * `:userId` in the path is now `GET conversations` and reads the JWT.
   */
  public listConversations(ownerAdminId: string): ConversationRecord[] {
    const results: ConversationRecord[] = [];
    for (const conv of this.conversations.values()) {
      if (conv.ownerAdminId === ownerAdminId) {
        results.push(conv);
      }
    }
    return results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Returns the message history of a conversation the caller owns.
   *
   * Throws {@link NotFoundException} when the conversation is unknown, evicted,
   * or someone else's — the same exception with the same message in all three
   * cases, so an id that guesses right learns nothing an id that guesses wrong
   * does not.
   */
  public getHistory(ownerAdminId: string, conversationId: string): MessageRecord[] {
    this.requireOwnConversation(ownerAdminId, conversationId);
    return this.readHistory(conversationId);
  }

  /**
   * Searches the knowledge base for relevant context.
   * Currently returns a placeholder; will be backed by vector search
   * or full-text search over the knowledge/ markdown files.
   */
  public async searchKnowledge(query: string): Promise<string> {
    // Placeholder: return a static pointer to the knowledge directory.
    return `По вашему запросу "${query}" информация будет доступна после обновления базы знаний.`;
  }

  // ── Tool execution helpers ────────────────────────────────────────────────

  /**
   * Fetches the current active tariff plans from PlanCatalogService and
   * returns them as a JSON string the model can read.
   */
  private async executeGetTariffs(): Promise<string> {
    try {
      const query: PlanCatalogQueryContextInterface = {
        channel: 'WEB' as PurchaseChannel,
      };
      const plans = await this.planCatalogService.getCatalogPlans(query);
      const summary = plans.map((p) => ({
        name: p.name,
        description: p.description,
        type: p.type,
        trafficLimit: p.trafficLimit,
        deviceLimit: p.deviceLimit,
        isTrial: p.isTrial,
        trialFree: p.trialFree,
        durations: p.durations.map((d) => ({
          days: d.days,
          prices: d.prices.map((pr) => ({
            price: pr.price,
            currency: pr.currency,
            gatewayType: pr.gatewayType,
          })),
        })),
        displayPrices: p.displayPrices.map((dp) => ({
          price: dp.price,
          currency: dp.currency,
          days: dp.days,
        })),
      }));
      return JSON.stringify(summary);
    } catch (err) {
      this.logger.error(`getTariffs failed: ${(err as Error).message}`);
      return JSON.stringify({ error: 'Не удалось получить список тарифов.' });
    }
  }

  /**
   * Fetches active FAQ entries from FaqService and returns them as a
   * JSON string the model can read.
   */
  private async executeGetFaq(locale?: string): Promise<string> {
    try {
      const items = await this.faqService.getPublicFaq(locale ?? null);
      const summary = items.map((item) => ({
        question: item.question,
        answer: item.answer,
      }));
      return JSON.stringify(summary);
    } catch (err) {
      this.logger.error(`getFaq failed: ${(err as Error).message}`);
      return JSON.stringify({ error: 'Не удалось получить FAQ.' });
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Builds the system prompt for the AI support persona.
   * Operator `systemPrompt` from panel is appended as lower-priority context.
   */
  private buildSystemPrompt(operatorPersona?: string): string {
    const base = [
      'Ты — дружелюбный и компетентный ассистент технической поддержки.',
      'Ты отвечаешь вежливо и понятно (по умолчанию на русском).',
      '',
      'Твоя задача — помогать с публичными вопросами о сервисе:',
      '- Настройка и использование VPN-приложений',
      '- Решение проблем с подключением',
      '- Информация о тарифах и подписках',
      '- Общие вопросы о платформе',
      '',
      'ВАЖНЫЕ ПРАВИЛА:',
      '- Только рекомендации: нет системных действий (подписки, платежи, доступы).',
      '- НЕ упоминай Remnawave, Xray, протоколы или технические детали реализации.',
      '- НЕ раскрывай внутреннюю архитектуру сервиса.',
      '- НЕ давай инструкции по обходу блокировок или настройке в обход правил.',
      '- Если не знаешь ответа — предложи обратиться в поддержку через тикеты.',
      '- Будь краток и по делу. Не используй сложную техническую лексику.',
      '',
      'Ты можешь запрашивать актуальные тарифы и FAQ из панели управления, когда это необходимо.',
    ].join('\n');
    const extra = (operatorPersona ?? '').trim();
    if (!extra) return base;
    return `${base}\n\n--- Контекст оператора (справочно) ---\n${extra.slice(0, 8_000)}\n---`;
  }

  /**
   * The conversation, if this admin owns it. Otherwise the one refusal that
   * covers unknown, evicted and foreign alike.
   */
  private requireOwnConversation(
    ownerAdminId: string,
    conversationId: string,
  ): ConversationRecord {
    const record = this.conversations.get(conversationId);
    if (record === undefined || record.ownerAdminId !== ownerAdminId) {
      throw new NotFoundException(CONVERSATION_NOT_FOUND);
    }
    return record;
  }

  /**
   * Transcript read WITHOUT an ownership check — for callers that have already
   * passed one. Private, and it stays that way: the public
   * {@link getHistory} is this plus {@link requireOwnConversation}.
   */
  private readHistory(conversationId: string): MessageRecord[] {
    return [...(this.messages.get(conversationId) ?? [])];
  }

  /**
   * Saves a message to the in-memory store, oldest-first trimmed to
   * {@link MAX_MESSAGES_PER_CONVERSATION}.
   *
   * The trim keeps far more than `contextWindow * 2` messages, so what the
   * model is sent is never affected — only what an unbounded process would
   * otherwise hold forever.
   */
  private saveMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
  ): void {
    const record: MessageRecord = {
      id: `msg_${randomUUID()}`,
      conversationId,
      role,
      content,
      createdAt: new Date(),
    };
    const existing = this.messages.get(conversationId) ?? [];
    existing.push(record);
    if (existing.length > MAX_MESSAGES_PER_CONVERSATION) {
      existing.splice(0, existing.length - MAX_MESSAGES_PER_CONVERSATION);
    }
    this.messages.set(conversationId, existing);
    this.touch(conversationId);
  }

  /**
   * Moves a conversation's `updatedAt` to now.
   *
   * It was written once at creation and never again, which made the field a
   * synonym for `createdAt` — fine while nothing read it, wrong the moment
   * idle eviction does: a thread in daily use would have been dropped on its
   * first birthday.
   */
  private touch(conversationId: string): void {
    const existing = this.conversations.get(conversationId);
    if (existing === undefined) return;
    this.conversations.set(conversationId, { ...existing, updatedAt: new Date() });
  }

  /** Applies {@link selectEvictableConversations} to the live store. */
  private evictOverflow(): void {
    const doomed = selectEvictableConversations([...this.conversations.values()], Date.now());
    for (const id of doomed) {
      this.conversations.delete(id);
      // Both maps or neither — a message list left behind is a leak that no
      // conversation cap can see.
      this.messages.delete(id);
    }
  }
}
