import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

export type RegistrationChannel = 'web' | 'tma' | 'bot' | 'oauth';

export interface RegistrationUtmInput {
  readonly source?: string | null;
  readonly medium?: string | null;
  readonly campaign?: string | null;
  readonly content?: string | null;
  readonly term?: string | null;
  readonly raw?: string | null;
}

export interface RegistrationSnapshotInput {
  readonly userId: string;
  readonly channel: RegistrationChannel;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly referer?: string | null;
  readonly utm?: RegistrationUtmInput | null;
}

const IP_MAX = 64;
const UA_MAX = 512;
const REFERER_MAX = 1024;
const UTM_FIELD_MAX = 128;
const UTM_RAW_MAX = 512;

/**
 * Write-once registration network snapshot. Never overwrites existing values;
 * never throws to the caller (best-effort). Used for web register analytics
 * (raw IP / UA / Referer / UTM). Bot first-touch ad acquisition stays separate.
 */
@Injectable()
export class RegistrationSnapshotService {
  private readonly logger = new Logger(RegistrationSnapshotService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  public async captureBestEffort(input: RegistrationSnapshotInput): Promise<void> {
    try {
      const data = this.sanitize(input);
      if (data === null) {
        return;
      }
      // First-touch only: registrationChannel null means no snapshot yet.
      await this.prismaService.user.updateMany({
        where: {
          id: input.userId,
          registrationChannel: null,
        },
        data,
      });
    } catch (error: unknown) {
      this.logger.warn(
        `registration snapshot failed for user ${input.userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private sanitize(input: RegistrationSnapshotInput): Prisma.UserUpdateManyMutationInput | null {
    const ip = clamp(input.ip, IP_MAX);
    const userAgent = clamp(input.userAgent, UA_MAX);
    const referer = sanitizeReferer(input.referer);
    const utm = sanitizeUtm(input.utm);

    if (ip === null && userAgent === null && referer === null && utm === null) {
      // Still stamp channel if provided so bot/tma markers show on Analytics.
      if (!input.channel) return null;
      return { registrationChannel: input.channel };
    }

    return {
      registrationIp: ip,
      registrationUserAgent: userAgent,
      registrationReferer: referer,
      registrationUtm: utm === null ? undefined : (utm as Prisma.InputJsonValue),
      registrationChannel: input.channel,
    };
  }
}

function clamp(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Strip query/fragment from referer — landing host/path only for privacy. */
function sanitizeReferer(value: string | null | undefined): string | null {
  const raw = clamp(value, REFERER_MAX);
  if (raw === null) return null;
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`.slice(0, REFERER_MAX);
  } catch {
    return raw;
  }
}

function sanitizeUtm(utm: RegistrationUtmInput | null | undefined): Record<string, string> | null {
  if (utm === null || utm === undefined) return null;
  const out: Record<string, string> = {};
  const map: Array<[keyof RegistrationUtmInput, number]> = [
    ['source', UTM_FIELD_MAX],
    ['medium', UTM_FIELD_MAX],
    ['campaign', UTM_FIELD_MAX],
    ['content', UTM_FIELD_MAX],
    ['term', UTM_FIELD_MAX],
    ['raw', UTM_RAW_MAX],
  ];
  for (const [key, max] of map) {
    const v = clamp(utm[key] ?? null, max);
    if (v !== null) out[key] = v;
  }
  return Object.keys(out).length === 0 ? null : out;
}
