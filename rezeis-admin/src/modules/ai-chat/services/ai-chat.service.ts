import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { PurchaseChannel } from '../../../common/types/prisma-enums';
import type { PlanCatalogQueryContextInterface } from '../../plans/interfaces/plan-catalog.interface';
import { PlanCatalogService } from '../../plans/services/plan-catalog.service';
import { FaqService } from '../../faq/services/faq.service';

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

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ConversationRecord {
  id: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
}

/**
 * In-memory store for AI chat conversations. In a full deployment this
 * would be replaced by database-backed models; the interface matches
 * what the controller expects so swapping the backend is transparent.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _conversations = new Map<string, ConversationRecord>();
const _messages = new Map<string, MessageRecord[]>();

let conversationCounter = 0;
let messageCounter = 0;

/**
 * AI Chat service — interfaces with an OpenAI-compatible API to provide
 * a conversational support agent that helps users understand the Rezeis
 * platform, troubleshoot VPN connections, and answer FAQs.
 *
 * The system prompt is tuned for a friendly, Russian-speaking VPN support
 * persona. No Remnawave / Xray / protocol details are exposed.
 *
 * Supports OpenAI function calling: the model can query live tariff data
 * (PlanCatalogService) and FAQ (FaqService) at runtime instead of relying
 * on static knowledge.
 */
@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);
  private readonly openai: OpenAI | null = null;
  private readonly model: string;

  /** Number of recent message pairs to include as context. */
  private readonly contextWindow = 10;

  public constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly planCatalogService: PlanCatalogService,
    private readonly faqService: FaqService,
  ) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    const baseUrl = this.configService.get<string>('OPENAI_API_URL');
    this.model = this.configService.get<string>('OPENAI_MODEL') ?? 'gpt-4o-mini';

    if (apiKey) {
      this.openai = new OpenAI({
        apiKey,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
      });
      this.logger.log(
        `AI Chat initialised with model=${this.model} url=${baseUrl || 'https://api.openai.com/v1'}`,
      );
    } else {
      this.logger.warn(
        'OPENAI_API_KEY is not set — AI Chat is unavailable. ' +
          'Set OPENAI_API_KEY (and optionally OPENAI_API_URL / OPENAI_MODEL) in .env to enable.',
      );
    }
  }

  /**
   * Generates a response from the AI model given a user message and
   * optional conversation context.
   *
   * Uses OpenAI function calling: the model can request live tariff data
   * (getTariffs) or FAQ entries (getFaq). Tool calls are resolved against
   * PlanCatalogService / FaqService and the results are fed back to the
   * model until a final text response is produced.
   */
  public async generateResponse(
    userId: string,
    message: string,
    conversationId?: string,
  ): Promise<{ reply: string; conversationId: string }> {
    if (!this.openai) {
      return {
        reply:
          '🤖 AI-чат временно недоступен. Пожалуйста, обратитесь в поддержку ' +
          'через тикеты или напишите в Telegram. (OPENAI_API_KEY не настроен)',
        conversationId: conversationId ?? 'none',
      };
    }

    // Resolve or create conversation
    const convoId = conversationId ?? this.createConversation(userId).id;

    // Build message history for context
    const history = this.getHistory(convoId);
    const recentMessages = history.slice(-this.contextWindow * 2);

    const systemPrompt = this.buildSystemPrompt();

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
      let response = await this.openai.chat.completions.create({
        model: this.model,
        messages,
        tools: [...AI_TOOL_DEFINITIONS],
        tool_choice: 'auto',
        temperature: 0.7,
        max_tokens: 1024,
      });

      let choice = response.choices[0];

      // ── Tool-calling loop ──────────────────────────────────────────
      // Keep resolving tool calls until the model returns a plain-text reply.
      while (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
        const assistantMsg = choice.message;
        messages.push(assistantMsg);

        for (const toolCall of assistantMsg.tool_calls) {
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
        response = await this.openai.chat.completions.create({
          model: this.model,
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
   * Creates a new conversation record for the given user.
   */
  public createConversation(userId: string): ConversationRecord {
    conversationCounter += 1;
    const id = `conv_${Date.now()}_${conversationCounter}`;
    const now = new Date();
    const record: ConversationRecord = { id, userId, createdAt: now, updatedAt: now };
    _conversations.set(id, record);
    _messages.set(id, []);
    return record;
  }

  /**
   * Lists all conversations for a given user.
   */
  public listConversations(userId: string): ConversationRecord[] {
    const results: ConversationRecord[] = [];
    for (const conv of _conversations.values()) {
      if (conv.userId === userId) {
        results.push(conv);
      }
    }
    return results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Returns the message history for a conversation.
   */
  public getHistory(conversationId: string): MessageRecord[] {
    return _messages.get(conversationId) ?? [];
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
   */
  private buildSystemPrompt(): string {
    return [
      'Ты — дружелюбный и компетентный ассистент технической поддержки Rezeis.',
      'Ты отвечаешь исключительно на русском языке, вежливо и понятно.',
      '',
      'Твоя задача — помогать пользователям с вопросами о сервисе Rezeis:',
      '- Настройка и использование VPN-приложений',
      '- Решение проблем с подключением',
      '- Информация о тарифах и подписках',
      '- Общие вопросы о платформе',
      '',
      'ВАЖНЫЕ ПРАВИЛА:',
      '- НЕ упоминай Remnawave, Xray, протоколы или технические детали реализации.',
      '- НЕ раскрывай внутреннюю архитектуру сервиса.',
      '- НЕ давай инструкции по обходу блокировок или настройке в обход правил.',
      '- Если не знаешь ответа — предложи обратиться в поддержку через тикеты.',
      '- Будь краток и по делу. Не используй сложную техническую лексику.',
      '- Обращайся к пользователю на «ты».',
      '',
      'Ты можешь запрашивать актуальные тарифы и FAQ из панели управления, когда это необходимо для ответа пользователю.',
      '',
      'Приветствуй пользователя дружелюбно и предлагай помощь по списку выше.',
    ].join('\n');
  }

  /**
   * Saves a message to the in-memory store.
   */
  private saveMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
  ): void {
    messageCounter += 1;
    const record: MessageRecord = {
      id: `msg_${Date.now()}_${messageCounter}`,
      conversationId,
      role,
      content,
      createdAt: new Date(),
    };
    const existing = _messages.get(conversationId);
    if (existing) {
      existing.push(record);
    } else {
      _messages.set(conversationId, [record]);
    }
  }
}
