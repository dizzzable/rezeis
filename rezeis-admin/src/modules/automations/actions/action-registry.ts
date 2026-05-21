import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

import { paymentsConfig } from '../../../common/config/payments.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EVENT_TYPES,
  SystemEventCategory,
  SystemEventSeverity,
  SystemEventsService,
} from '../../../common/services/system-events.service';
import {
  AutomationActionContext,
  AutomationActionDefinition,
  AutomationActionResult,
} from '../interfaces/automation-action.interface';
import { AUTOMATION_ACTION_TYPES, AutomationActionType } from '../automations.constants';

/**
 * Pure execution surface: takes `(context, action)` and produces a
 * `result`. Action handlers never throw — they always return a result
 * object so the orchestrator can record per-action outcomes without
 * losing the rest of the action chain.
 *
 * Adding a new action type
 * ────────────────────────
 *   1. Append the type to `AUTOMATION_ACTION_TYPES`.
 *   2. Add a private handler method below.
 *   3. Wire it in the `dispatch` switch.
 *   4. Update the frontend rule editor to render the new params shape.
 */
@Injectable()
export class AutomationActionRegistry {
  private readonly logger = new Logger(AutomationActionRegistry.name);

  public constructor(
    private readonly httpService: HttpService,
    private readonly prismaService: PrismaService,
    private readonly systemEventsService: SystemEventsService,
    @Inject(paymentsConfig.KEY)
    private readonly paymentsConfiguration: ConfigType<typeof paymentsConfig>,
  ) {}

  public listSupportedTypes(): readonly AutomationActionType[] {
    return AUTOMATION_ACTION_TYPES;
  }

  public async execute(
    index: number,
    action: AutomationActionDefinition,
    context: AutomationActionContext,
  ): Promise<AutomationActionResult> {
    if (!(AUTOMATION_ACTION_TYPES as readonly string[]).includes(action.type)) {
      return {
        index,
        type: action.type,
        status: 'skipped',
        message: `Unknown action type: ${action.type}`,
      };
    }
    try {
      const message = await this.dispatch(action, context);
      return {
        index,
        type: action.type,
        status: 'success',
        message,
      };
    } catch (err) {
      const errorMessage = (err as Error).message;
      this.logger.warn(
        `Action ${action.type} failed for rule ${context.ruleId}: ${errorMessage}`,
      );
      return {
        index,
        type: action.type,
        status: 'failed',
        message: errorMessage,
      };
    }
  }

  // ── Action handlers ────────────────────────────────────────────────────

  private async dispatch(
    action: AutomationActionDefinition,
    context: AutomationActionContext,
  ): Promise<string> {
    switch (action.type) {
      case 'notify_telegram':
        return this.notifyTelegram(action, context);
      case 'webhook_post':
        return this.webhookPost(action, context);
      case 'block_ip':
        return this.blockIp(action, context);
      case 'block_user':
        return this.blockUser(action, context);
      case 'system_event':
        return this.systemEvent(action, context);
      default:
        return 'noop';
    }
  }

  /** Emits a Telegram message via `SystemEventsService.warn()` so it goes
   * through the existing notifications pipeline (settings → topic → bot). */
  private async notifyTelegram(
    action: AutomationActionDefinition,
    context: AutomationActionContext,
  ): Promise<string> {
    const text = readString(action.params, 'text') ?? `Automation rule "${context.ruleName}" fired`;
    this.systemEventsService.warn(
      'automation.telegram_notify',
      'SYSTEM',
      text,
      {
        ruleId: context.ruleId,
        ruleName: context.ruleName,
        trigger: context.trigger,
      },
    );
    return `notify queued: ${text.slice(0, 64)}`;
  }

  /** POST a JSON payload to an arbitrary URL with optional auth header. */
  private async webhookPost(
    action: AutomationActionDefinition,
    context: AutomationActionContext,
  ): Promise<string> {
    const url = readString(action.params, 'url');
    if (!url) throw new Error('webhook_post requires `url`');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const authHeader = readString(action.params, 'authorizationHeader');
    if (authHeader) headers.Authorization = authHeader;

    await firstValueFrom(
      this.httpService.post(
        url,
        {
          ruleId: context.ruleId,
          ruleName: context.ruleName,
          trigger: context.trigger,
          triggerData: context.triggerData,
        },
        { headers, timeout: 10_000 },
      ),
    );
    return `POST ${url}`;
  }

  /** Inserts a row into `blocked_ips` for the IP carried by the trigger. */
  private async blockIp(
    action: AutomationActionDefinition,
    context: AutomationActionContext,
  ): Promise<string> {
    const explicit = readString(action.params, 'address');
    const fromTrigger = readString(context.triggerData, 'ip')
      ?? readString(context.triggerData, 'ipAddress');
    const address = explicit ?? fromTrigger;
    if (!address) throw new Error('block_ip requires `address` or trigger data with `ip`');
    const reason = readString(action.params, 'reason')
      ?? `Automated by rule "${context.ruleName}"`;
    const expiresAtRaw = readString(action.params, 'expiresAt');
    const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;

    await this.prismaService.blockedIp.upsert({
      where: { address },
      update: {
        reason,
        source: 'automation',
        expiresAt,
      },
      create: {
        address,
        reason,
        source: 'automation',
        expiresAt,
      },
    });
    return `blocked ${address}`;
  }

  /** Sets `users.isBlocked = true` for the user id carried by the trigger. */
  private async blockUser(
    action: AutomationActionDefinition,
    context: AutomationActionContext,
  ): Promise<string> {
    const explicit = readString(action.params, 'userId');
    const fromTrigger = readString(context.triggerData, 'userId');
    const userId = explicit ?? fromTrigger;
    if (!userId) throw new Error('block_user requires `userId` or trigger data with `userId`');
    await this.prismaService.user.update({
      where: { id: userId },
      data: { isBlocked: true },
    });
    this.systemEventsService.warn(
      EVENT_TYPES.USER_BLOCKED,
      'USER',
      `User blocked by automation "${context.ruleName}"`,
      {
        userId,
        ruleId: context.ruleId,
        ruleName: context.ruleName,
        trigger: context.trigger,
      },
    );
    return `blocked user ${userId}`;
  }

  /** Emit a custom event into the SystemEventsService stream. */
  private async systemEvent(
    action: AutomationActionDefinition,
    context: AutomationActionContext,
  ): Promise<string> {
    const type = readString(action.params, 'type') ?? 'automation.custom';
    const message = readString(action.params, 'message') ?? `Automation "${context.ruleName}" fired`;
    const severity = readSeverity(action.params, 'severity');
    const category = readCategory(action.params, 'category');
    this.systemEventsService.emit({
      type,
      category,
      severity,
      message,
      metadata: {
        ruleId: context.ruleId,
        ruleName: context.ruleName,
        trigger: context.trigger,
      },
    });
    return `emitted ${type}`;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function readString(params: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = params[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readSeverity(
  params: Readonly<Record<string, unknown>>,
  key: string,
): SystemEventSeverity {
  const raw = readString(params, key);
  if (raw === 'WARNING' || raw === 'ERROR' || raw === 'INFO') return raw;
  return 'INFO';
}

function readCategory(
  params: Readonly<Record<string, unknown>>,
  key: string,
): SystemEventCategory {
  const raw = readString(params, key);
  const allowed: readonly SystemEventCategory[] = [
    'USER',
    'AUTH',
    'SUBSCRIPTION',
    'PAYMENT',
    'REFERRAL',
    'PARTNER',
    'PROMOCODE',
    'SYSTEM',
  ];
  if (raw !== null && (allowed as readonly string[]).includes(raw)) {
    return raw as SystemEventCategory;
  }
  return 'SYSTEM';
}
