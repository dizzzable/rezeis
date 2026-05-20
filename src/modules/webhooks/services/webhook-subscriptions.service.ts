import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { WEBHOOK_EVENT_CATALOG } from '../webhooks.constants';

export interface WebhookSubscriptionListItem {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  /** Always `null` in list responses; only the create/regenerate endpoints expose the secret. */
  readonly secret: null;
  readonly eventTypes: readonly string[];
  readonly description: string | null;
  readonly isActive: boolean;
  readonly createdById: string | null;
  readonly lastDeliveredAt: string | null;
  readonly consecutiveFailures: number;
  readonly totalDeliveries: number;
  readonly totalFailures: number;
  readonly autoDisabledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WebhookSubscriptionCreateResult extends Omit<WebhookSubscriptionListItem, 'secret'> {
  /** Plaintext secret returned exactly once on creation / regeneration. */
  readonly secret: string;
}

export interface CreateSubscriptionInput {
  readonly name: string;
  readonly url: string;
  readonly eventTypes: readonly string[];
  readonly description: string | null;
  readonly isActive: boolean;
  readonly createdById: string | null;
}

export interface UpdateSubscriptionInput {
  readonly name?: string;
  readonly url?: string;
  readonly eventTypes?: readonly string[];
  readonly description?: string | null;
  readonly isActive?: boolean;
}

const URL_HTTP_PROTOCOL_REGEX = /^https?:\/\//i;
const ALLOWED_PATTERNS = new Set<string>(['*', ...WEBHOOK_EVENT_CATALOG]);

@Injectable()
export class WebhookSubscriptionsService {
  private readonly logger = new Logger(WebhookSubscriptionsService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  public async list(): Promise<readonly WebhookSubscriptionListItem[]> {
    const rows = await this.prismaService.webhookSubscription.findMany({
      orderBy: [{ createdAt: 'desc' }],
    });
    return rows.map(toListItem);
  }

  public async getById(id: string): Promise<WebhookSubscriptionListItem> {
    const row = await this.prismaService.webhookSubscription.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Webhook subscription not found');
    return toListItem(row);
  }

  public async create(input: CreateSubscriptionInput): Promise<WebhookSubscriptionCreateResult> {
    validateUrl(input.url);
    validateEventTypes(input.eventTypes);
    const secret = generateSecret();
    const created = await this.prismaService.webhookSubscription.create({
      data: {
        name: input.name,
        url: input.url,
        secret,
        eventTypes: [...input.eventTypes],
        description: input.description,
        isActive: input.isActive,
        createdById: input.createdById,
      },
    });
    this.logger.log(`Webhook subscription "${input.name}" created (${created.id})`);
    return toCreateResult(created);
  }

  public async update(
    id: string,
    input: UpdateSubscriptionInput,
  ): Promise<WebhookSubscriptionListItem> {
    if (input.url !== undefined) validateUrl(input.url);
    if (input.eventTypes !== undefined) validateEventTypes(input.eventTypes);
    try {
      const updated = await this.prismaService.webhookSubscription.update({
        where: { id },
        data: {
          name: input.name,
          url: input.url,
          eventTypes: input.eventTypes !== undefined ? [...input.eventTypes] : undefined,
          description: input.description,
          isActive: input.isActive,
          // Re-enabling clears the auto-disable marker so the dispatcher
          // resumes attempts.
          autoDisabledAt: input.isActive === true ? null : undefined,
          consecutiveFailures: input.isActive === true ? 0 : undefined,
        },
      });
      return toListItem(updated);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2025') {
        throw new NotFoundException('Webhook subscription not found');
      }
      throw err;
    }
  }

  public async delete(id: string): Promise<void> {
    try {
      await this.prismaService.webhookSubscription.delete({ where: { id } });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2025') {
        throw new NotFoundException('Webhook subscription not found');
      }
      throw err;
    }
  }

  /**
   * Issues a fresh signing secret. Returns the plaintext (one-time view)
   * so the operator can copy it into their receiver. Existing in-flight
   * deliveries continue to be signed with the OLD secret to avoid race
   * conditions; only fresh `dispatch()` calls pick up the new value.
   */
  public async regenerateSecret(id: string): Promise<WebhookSubscriptionCreateResult> {
    const secret = generateSecret();
    try {
      const updated = await this.prismaService.webhookSubscription.update({
        where: { id },
        data: { secret },
      });
      this.logger.log(`Webhook subscription ${id} secret regenerated`);
      return toCreateResult(updated);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2025') {
        throw new NotFoundException('Webhook subscription not found');
      }
      throw err;
    }
  }
}

function generateSecret(): string {
  return randomBytes(32).toString('hex');
}

function validateUrl(url: string): void {
  if (!URL_HTTP_PROTOCOL_REGEX.test(url.trim())) {
    throw new BadRequestException('URL must use http:// or https://');
  }
  try {
    // Throws on malformed URLs.
    new URL(url);
  } catch {
    throw new BadRequestException('URL is malformed');
  }
}

function validateEventTypes(eventTypes: readonly string[]): void {
  if (eventTypes.length === 0) return; // Empty == subscribe to all
  for (const value of eventTypes) {
    if (value === '*') continue;
    if (value.endsWith('.*')) {
      // Accept any namespace wildcard — operators can target plugins/
      // future event families that aren't in the catalog yet.
      const prefix = value.slice(0, -2);
      if (prefix.length === 0 || prefix.includes(' ')) {
        throw new BadRequestException(`Invalid wildcard pattern: "${value}"`);
      }
      continue;
    }
    if (!ALLOWED_PATTERNS.has(value)) {
      throw new BadRequestException(`Unknown event type: "${value}"`);
    }
  }
}

function toListItem(row: {
  id: string;
  name: string;
  url: string;
  eventTypes: string[];
  description: string | null;
  isActive: boolean;
  createdById: string | null;
  lastDeliveredAt: Date | null;
  consecutiveFailures: number;
  totalDeliveries: number;
  totalFailures: number;
  autoDisabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): WebhookSubscriptionListItem {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    secret: null,
    eventTypes: row.eventTypes,
    description: row.description,
    isActive: row.isActive,
    createdById: row.createdById,
    lastDeliveredAt: row.lastDeliveredAt?.toISOString() ?? null,
    consecutiveFailures: row.consecutiveFailures,
    totalDeliveries: row.totalDeliveries,
    totalFailures: row.totalFailures,
    autoDisabledAt: row.autoDisabledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toCreateResult(row: {
  id: string;
  name: string;
  url: string;
  secret: string;
  eventTypes: string[];
  description: string | null;
  isActive: boolean;
  createdById: string | null;
  lastDeliveredAt: Date | null;
  consecutiveFailures: number;
  totalDeliveries: number;
  totalFailures: number;
  autoDisabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): WebhookSubscriptionCreateResult {
  const item = toListItem(row);
  return { ...item, secret: row.secret };
}
