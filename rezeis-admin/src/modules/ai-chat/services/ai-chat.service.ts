import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

import { PrismaService } from '../../../common/prisma/prisma.service';

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
  ) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    const baseUrl = this.configService.get<string>('OPENAI_API_URL');
    this.model = this.configService.get<string>('OPENAI_MODEL') ?? 'gpt-4o-mini';

    if (apiKey) {
      this.openai = new OpenAI({
        apiKey,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
      });
      this.logger.log(`AI Chat initialised with model=${this.model} url=${baseUrl || 'https://api.openai.com/v1'}`);
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

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...recentMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: message },
    ];

    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages,
        temperature: 0.7,
        max_tokens: 1024,
      });

      const reply = response.choices[0]?.message?.content ?? '…';

      // Persist to in-memory store
      this.saveMessage(convoId, 'user', message);
      this.saveMessage(convoId, 'assistant', reply);

      return { reply, conversationId: convoId };
    } catch (error) {
      this.logger.error(`OpenAI API call failed: ${(error as Error).message}`, (error as Error).stack);
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
