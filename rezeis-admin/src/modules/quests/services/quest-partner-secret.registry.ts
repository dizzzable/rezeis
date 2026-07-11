import { Injectable } from '@nestjs/common';

/**
 * Per-partner HMAC secret store, keyed by `partnerSlug`.
 *
 * Secrets are sourced from the `QUEST_PARTNER_SECRETS` env var (a JSON object
 * `{ "<slug>": "<secret>" }`) and NEVER live in `Quest.params` — params are
 * projected to the cabinet via `mapQuest`, so a secret there would leak. The
 * quest only references a partner by slug; the secret is resolved server-side
 * for signature verification of the partner callback.
 */
@Injectable()
export class QuestPartnerSecretRegistry {
  private readonly secrets: ReadonlyMap<string, string>;

  public constructor(secrets: Record<string, string>) {
    this.secrets = new Map(Object.entries(secrets));
  }

  /** Build a registry from the raw env value; empty (never throws) on junk. */
  public static fromEnv(raw: string | undefined): QuestPartnerSecretRegistry {
    if (typeof raw !== 'string' || raw.trim() === '') {
      return new QuestPartnerSecretRegistry({});
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return new QuestPartnerSecretRegistry({});
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return new QuestPartnerSecretRegistry({});
    }
    const clean: Record<string, string> = {};
    for (const [slug, secret] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof secret === 'string' && secret.length > 0) clean[slug] = secret;
    }
    return new QuestPartnerSecretRegistry(clean);
  }

  public getSecret(slug: string): string | null {
    return this.secrets.get(slug) ?? null;
  }

  public has(slug: string): boolean {
    return this.secrets.has(slug);
  }
}
