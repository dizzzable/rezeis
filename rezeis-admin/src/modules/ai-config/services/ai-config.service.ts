import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import type { AiConfigSettings } from '../interfaces/ai-config.interface.js';
import { decryptApiKey, encryptApiKey } from '../utils/ai-secret-cipher.js';

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

  /** Master crypt key (validated at boot by env.schema, min 32 chars). */
  private cryptKey(): string {
    return process.env.REZEIS_CRYPT_KEY ?? '';
  }

  /**
   * Reads the API key from storage, decrypting the `apiKeyEnc` payload. Legacy
   * plaintext `apiKey` (written before at-rest encryption) is returned as-is and
   * gets re-encrypted on the next save. A decrypt failure fails safe (empty).
   */
  private readApiKey(stored: Record<string, unknown>): string {
    const enc = stored.apiKeyEnc;
    if (typeof enc === 'string' && enc.length > 0) {
      try {
        return decryptApiKey(enc, this.cryptKey());
      } catch {
        this.logger.warn('Failed to decrypt AI API key — returning empty');
        return '';
      }
    }
    const legacy = stored.apiKey;
    return typeof legacy === 'string' ? legacy : '';
  }

  /**
   * Returns the full AI-support settings (including the decrypted apiKey).
   * Called by the INTERNAL controller (the trusted BFF needs the real key to
   * call the provider) and by the service's own test/models helpers. It MUST
   * NOT be returned to the admin SPA — use {@link getSettingsMasked} there.
   */
  public async getSettings(): Promise<AiConfigSettings> {
    const settings = await this.prisma.settings.findFirst({ where: { id: 1 } });
    if (!settings) {
      return { baseUrl: '', apiKey: '', model: '', modelsEndpoint: '', enabled: false, systemPrompt: '' };
    }
    return this.mapStored((settings.aiSupportSettings ?? {}) as Record<string, unknown>);
  }

  /** Maps a stored `aiSupportSettings` JSON blob into the settings shape. */
  private mapStored(stored: Record<string, unknown>): AiConfigSettings {
    return {
      baseUrl: (stored.baseUrl as string) ?? '',
      apiKey: this.readApiKey(stored),
      model: (stored.model as string) ?? '',
      modelsEndpoint: (stored.modelsEndpoint as string) ?? '',
      enabled: stored.enabled === true,
      systemPrompt: typeof stored.systemPrompt === 'string' ? stored.systemPrompt : '',
    };
  }

  /**
   * Returns the masked AI-support settings (apiKey replaced with placeholders).
   * This is what the admin SPA receives — the raw key never reaches the browser.
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
   * existing values so omitted fields are preserved. The apiKey is stored
   * AES-256-GCM-encrypted (`apiKeyEnc`); a blank or masked incoming apiKey means
   * "keep the existing key", so a round-trip save from the masked admin view can
   * never overwrite the real key with the mask. Legacy plaintext `apiKey` is
   * dropped on write.
   */
  public async updateSettings(payload: Partial<AiConfigSettings>): Promise<AiConfigSettings> {
    const row = await this.prisma.settings.findFirst({ where: { id: 1 } });
    const storedNow = (row?.aiSupportSettings ?? {}) as Record<string, unknown>;
    const existing = this.mapStored(storedNow);

    const incomingKey = payload.apiKey;
    const keepExistingKey =
      incomingKey === undefined ||
      incomingKey.trim().length === 0 ||
      incomingKey.includes('***');

    const next: Record<string, unknown> = {
      baseUrl: payload.baseUrl ?? existing.baseUrl,
      model: payload.model ?? existing.model,
      modelsEndpoint: payload.modelsEndpoint ?? existing.modelsEndpoint,
      enabled: payload.enabled ?? existing.enabled,
      systemPrompt: payload.systemPrompt ?? existing.systemPrompt,
    };

    let resolvedApiKey = existing.apiKey;
    if (keepExistingKey) {
      // Preserve the stored encrypted blob VERBATIM so a decrypt failure or a
      // crypt-key rotation can never wipe the key on an unrelated save (e.g.
      // toggling `enabled`). Migrate a legacy plaintext key to encrypted form.
      if (typeof storedNow.apiKeyEnc === 'string' && storedNow.apiKeyEnc.length > 0) {
        next.apiKeyEnc = storedNow.apiKeyEnc;
      } else if (typeof storedNow.apiKey === 'string' && storedNow.apiKey.length > 0) {
        next.apiKeyEnc = encryptApiKey(storedNow.apiKey, this.cryptKey());
      }
    } else {
      resolvedApiKey = incomingKey;
      next.apiKeyEnc = encryptApiKey(incomingKey, this.cryptKey());
    }

    await this.prisma.settings.upsert({
      where: { id: 1 },
      create: { id: 1, aiSupportSettings: next as object },
      update: { aiSupportSettings: next as object },
    });

    return {
      baseUrl: next.baseUrl as string,
      apiKey: resolvedApiKey,
      model: next.model as string,
      modelsEndpoint: next.modelsEndpoint as string,
      enabled: next.enabled as boolean,
      systemPrompt: next.systemPrompt as string,
    };
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
      // Always test the CHAT endpoint the runtime/learning actually use — the
      // separate `modelsEndpoint` is only for the models listing (fetchModels).
      const endpoint = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;

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
