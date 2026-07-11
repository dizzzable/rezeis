import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { RawCacheService } from '../../../common/cache/raw-cache.service';
import { verifyWebhookSignature } from '../../../common/http/webhook-signature.util';
import { QuestPartnerService } from '../services/quest-partner.service';

const SIGNATURE_HEADER = 'x-rezeis-signature';
/** Nonce TTL must exceed the ±5-min signature window so a replay can't outlive it. */
const NONCE_TTL_SECONDS = 15 * 60;

interface PartnerCallbackBody {
  readonly partnerSlug: string;
  readonly questId: string;
  readonly nonce: string;
  readonly telegramId?: string;
  readonly userRef?: string;
}

/**
 * Authenticates a partner postback WITHOUT the global admin token. Each partner
 * signs `t=<sec>,v1=<hmac>` over `<t>.<rawBody>` with its own secret (resolved
 * by slug, scoped to the quest). Verification order: parse raw body → resolve
 * per-partner secret → verify signature over the RAW bytes → atomic nonce claim
 * (fail-closed). Any failure is a typed 4xx, never a 500.
 */
@Injectable()
export class QuestPartnerCallbackGuard implements CanActivate {
  public constructor(
    private readonly partnerService: QuestPartnerService,
    private readonly cache: RawCacheService,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      rawBody?: Buffer;
      headers: Record<string, string | string[] | undefined>;
      partnerCallback?: PartnerCallbackBody;
    }>();

    const raw = req.rawBody;
    if (raw === undefined || raw.length === 0) {
      throw new BadRequestException('Missing request body');
    }
    const rawBody = raw.toString('utf8');

    const body = parseBody(rawBody);
    if (body === null) throw new BadRequestException('Malformed partner callback body');

    // 1. Per-partner secret, scoped to the quest (rejects slug/quest mismatch).
    const secret = await this.partnerService.resolveCallbackSecret(body.questId, body.partnerSlug);
    if (secret === null) {
      throw new UnauthorizedException('Unknown or mismatched partner');
    }

    // 2. Verify the signature over the RAW bytes (never a re-serialized DTO).
    const header = readHeader(req.headers[SIGNATURE_HEADER]);
    if (header === null) throw new UnauthorizedException('Missing partner signature');
    const verdict = verifyWebhookSignature({ secret, body: rawBody, header });
    if (!verdict.valid) {
      throw new UnauthorizedException(`Partner signature rejected: ${verdict.reason}`);
    }

    // 3. Atomic nonce dedup (fail-closed on cache outage — see claimOnce).
    const nonceKey = `quest:partner:nonce:${body.partnerSlug}:${body.nonce}`;
    const fresh = await this.cache.claimOnce(nonceKey, NONCE_TTL_SECONDS);
    if (!fresh) {
      throw new UnauthorizedException('Duplicate or replayed partner callback');
    }

    req.partnerCallback = body;
    return true;
  }
}

function parseBody(raw: string): PartnerCallbackBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  const partnerSlug = typeof p.partnerSlug === 'string' ? p.partnerSlug : '';
  const questId = typeof p.questId === 'string' ? p.questId : '';
  const nonce = typeof p.nonce === 'string' ? p.nonce : '';
  if (partnerSlug === '' || questId === '' || nonce === '') return null;
  const telegramId = typeof p.telegramId === 'string' ? p.telegramId : undefined;
  const userRef = typeof p.userRef === 'string' ? p.userRef : undefined;
  if (telegramId === undefined && userRef === undefined) return null;
  return { partnerSlug, questId, nonce, telegramId, userRef };
}

function readHeader(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}
