import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import type { AiConfigSettings } from '../interfaces/ai-config.interface.js';

/**
 * Manages the AI-support configuration stored in the singleton Settings row.
 *
 * The aiSupportSettings JSON column has the shape:
 *   { baseUrl: string, apiKey: string, model: string, modelsEndpoint: string }
 */
@Injectable()
export class AiConfigService {
  private readonly logger = new Logger(AiConfigService.name);

  public constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
  ) {}

  /**
   * Returns the full AI-support settings (including apiKey).
   * Called by the admin controller (direct get).
   */
  public async getSettings(): Promise<AiConfigSettings> {
    const settings = await this.prisma.settings.findFirst({ where: { id: 1 } });
    if (!settings) {
      return { baseUrl: '', apiKey: '', model: '', modelsEndpoint: '' };
    }
    const stored = (settings.aiSupportSettings ?? {}) as Record<string, unknown>;
    return {
      baseUrl: (stored.baseUrl as string) ?? '',
      apiKey: (stored.apiKey as string) ?? '',
      model: (stored.model as string) ?? '',
      modelsEndpoint: (stored.modelsEndpoint as string) ?? '',
    };
  }

  /**
   * Returns the masked AI-support settings (apiKey replaced with placeholders).
   * Called by the internal controller — the chatbot never needs the raw key.
   */
  public async getSettingsMasked(): Promise<AiConfigSettings> {
    const full = await this.getSettings();
    return {
      ...full,
      apiKey: full.apiKey ? this.maskApiKey(full.apiKey) : '',
    };
  }

  /**
   * Updates the aiSupportSettings JSON column. Merges partial payload over
   * existing values so omitted fields are preserved.
   */
  public async updateSettings(payload: Partial<AiConfigSettings>): Promise<AiConfigSettings> {
    const existing = await this.getSettings();
    const merged: AiConfigSettings = {
      baseUrl: payload.baseUrl ?? existing.baseUrl,
      apiKey: payload.apiKey ?? existing.apiKey,
      model: payload.model ?? existing.model,
      modelsEndpoint: payload.modelsEndpoint ?? existing.modelsEndpoint,
    };

    await this.prisma.settings.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        aiSupportSettings: merged as unknown as object,
      },
      update: {
        aiSupportSettings: merged as unknown as object,
      },
    });

    return merged;
  }

  /**
   * Tests the configured AI endpoint by sending a simple chat-completion
   * request and verifying a successful response.
   */
  public async testConnection(): Promise<{ ok: boolean; message: string }> {
    const config = await this.getSettings();
    if (!config.baseUrl) {
      throw new BadRequestException('AI_CONFIG_BASE_URL_NOT_CONFIGURED');
    }
    if (!config.apiKey) {
      throw new BadRequestException('AI_CONFIG_API_KEY_NOT_CONFIGURED');
    }

    try {
      const endpoint = config.modelsEndpoint && config.modelsEndpoint.trim()
        ? config.modelsEndpoint
        : `${config.baseUrl}/chat/completions`;

      const { data } = await firstValueFrom(
        this.httpService.post(
          endpoint,
          {
            model: config.model || 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'test' }],
            max_tokens: 5,
          },
          {
            headers: {
              'Authorization': `Bearer ${config.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 15_000,
          },
        ),
      );

      return {
        ok: true,
        message: `Connection successful — model responded: ${(data as Record<string, unknown>)?.id ?? 'OK'}`,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`AI config connection test failed: ${message}`);
      return { ok: false, message: `Connection failed: ${message}` };
    }
  }

  /**
   * Fetches available models from the configured endpoint.
   */
  public async fetchModels(): Promise<{ id: string; name?: string }[]> {
    const config = await this.getSettings();
    if (!config.baseUrl) {
      throw new BadRequestException('AI_CONFIG_BASE_URL_NOT_CONFIGURED');
    }

    const modelsUrl = config.modelsEndpoint && config.modelsEndpoint.trim()
      ? config.modelsEndpoint
      : `${config.baseUrl}/models`;

    try {
      const { data } = await firstValueFrom(
        this.httpService.get(modelsUrl, {
          headers: {
            ...(config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {}),
          },
          timeout: 15_000,
        }),
      );

      // Handle both { data: [...] } and [...] response shapes
      const rawData = data as Record<string, unknown>;
      const models = Array.isArray(rawData.data)
        ? (rawData.data as { id: string; name?: string }[])
        : Array.isArray(rawData)
          ? (rawData as { id: string; name?: string }[])
          : [];

      return models.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
      }));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`AI config fetch models failed: ${message}`);
      throw new BadRequestException(`Failed to fetch models: ${message}`);
    }
  }

  private maskApiKey(key: string): string {
    if (key.length <= 6) return '***';
    return key.slice(0, 3) + '***' + key.slice(-3);
  }
}
