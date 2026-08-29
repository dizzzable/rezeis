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
import { UserBlockService } from '../../users/services/user-block.service';
import { UserHintDeliveryService } from '../../user-hints/services/user-hint-delivery.service';
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
    private readonly userBlockService: UserBlockService,
    private readonly userHintDeliveryService: UserHintDeliveryService,
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
      case 'show_hint':
        return this.showHint(action, context);
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
      EVENT_TYPES.AUTOMATION_TELEGRAM_NOTIFY,
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

  /**
   * Blocks the user named by the trigger — through the SAME cascade the two
   * operator screens use.
   *
   * IT USED TO WRITE THE FLAG AND NOTHING ELSE. No identity capture, so the
   * customer's Telegram id and e-mail were never listed and they could register
   * again in a minute. No device or IP capture. And, worst of the set, no sync
   * job and no dropped connections: the panel profile stayed ACTIVE and the
   * established tunnel kept carrying traffic, because the processor re-asserts
   * a blocked owner's status only when something else enqueues a job for that
   * subscription — and nothing did.
   *
   * Of the three writers of `isBlocked` this is the one that runs unattended,
   * at three in the morning, with nobody watching a screen. It is therefore the
   * last place where the flag should have been the whole story, and it was the
   * one place the unification missed.
   */
  private async blockUser(
    action: AutomationActionDefinition,
    context: AutomationActionContext,
  ): Promise<string> {
    const userId = resolveTriggerUserId(action.params, context.triggerData);
    if (!userId) throw new Error('block_user requires `userId` or trigger data with `userId`');
    // No admin id: a rule is not a person. The cascade records the origin
    // account on every row it writes, so an operator can still see where an
    // entry came from.
    const outcome = await this.userBlockService.block({
      userId,
      reason: `Automation rule "${context.ruleName}"`,
      adminId: null,
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
        // What the cascade actually managed. An unattended block that fell
        // short has to be visible in the event stream, not only in a log line
        // nobody is reading at 03:00.
        identitiesCaptured: outcome.identitiesCaptured,
        devicesCaptured: outcome.devicesCaptured,
        subscriptionsQueued: outcome.subscriptionsQueued,
      },
    );
    return `blocked user ${userId}`;
  }

  /**
   * Queues an in-cabinet hint for the customer this rule is about.
   *
   * ── Why this queues rather than shows ─────────────────────────────────
   *
   * Nothing here can show anything. A rule fires when its event arrives — a
   * payment webhook at three in the morning, a crypto confirmation twenty
   * minutes after the buyer closed the tab — and the customer is, as a rule,
   * not looking. So the action writes a row the cabinet drains on their next
   * visit, and every other property (once-only, expiry, supersession by group)
   * belongs to the queue rather than to this handler.
   *
   * ── Why it is not an error when nothing is queued ─────────────────────
   *
   * `raise()` answers `null` for four ordinary reasons: the hint is switched
   * off, the customer has already had it and it does not repeat, a newer hint
   * in the same group superseded it, or nobody authored it. Only the last is a
   * mistake, and the service logs that one loudly. Failing the action on the
   * other three would fill the execution log with red for a rule behaving
   * exactly as configured.
   */
  private async showHint(
    action: AutomationActionDefinition,
    context: AutomationActionContext,
  ): Promise<string> {
    const hintKey = readString(action.params, 'hintKey');
    if (!hintKey) throw new Error('show_hint requires `hintKey`');
    const userId = resolveTriggerUserId(action.params, context.triggerData);
    if (!userId) {
      // Named explicitly rather than swallowed: this is the one failure an
      // operator can act on, and it means they bound the hint to an event that
      // does not name a customer.
      throw new Error(
        'show_hint requires a trigger that names a customer — this event carries no userId',
      );
    }
    const delivery = await this.userHintDeliveryService.raise({
      userId,
      hintKey,
      source: `rule:${context.ruleId}`,
    });
    return delivery === null
      ? `hint "${hintKey}" was not queued for ${userId} (inactive, already delivered, or superseded)`
      : `queued hint "${hintKey}" for ${userId}`;
  }

  /**
   * Emit a custom event into the SystemEventsService stream.
   *
   * `type` stays free-form on purpose: rules emit domain-specific types that
   * downstream webhooks and other rules match on, so narrowing this to a picker
   * over `EVENT_TYPES` would break them. Such a type cannot be registered,
   * presented or ticked — the operator's catch-all tick-box
   * (`UNREGISTERED_EVENTS_SENTINEL`) is what makes it deliverable in `selected`
   * mode. The DEFAULT, by contrast, is a fixed string, so it is a real
   * registered constant with a card and a tick-box of its own.
   */
  private async systemEvent(
    action: AutomationActionDefinition,
    context: AutomationActionContext,
  ): Promise<string> {
    const type = readString(action.params, 'type') ?? EVENT_TYPES.AUTOMATION_CUSTOM;
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

/**
 * The customer a triggered rule is about.
 *
 * ── WHERE THE USER ID ACTUALLY IS, and why this function exists ───────────
 *
 * `AutomationEventBridgeService` builds the trigger payload as
 * `{ type, category, severity, message, metadata, timestamp }` — the customer
 * is named inside `metadata`, never at the top level. `SystemEventsService`
 * knows this and reads `metadata.userId` for its own Telegram cards.
 *
 * The `block_user` action did not. It read the TOP level, found nothing on
 * every realtime trigger, and threw "block_user requires `userId` or trigger
 * data with `userId`" — so the action worked only when an operator pinned a
 * specific user id into the rule's params, which is not a rule so much as a
 * one-shot. A rule that fires on `fraud.signal_opened` and blocks whoever it
 * names has never been able to work.
 *
 * Both places are read, in the order that lets an operator override: an
 * explicit `params.userId` wins, then the payload's top level (which a manual
 * trigger may set), then `metadata.userId`, which is where events put it.
 */
export function resolveTriggerUserId(
  params: Readonly<Record<string, unknown>>,
  triggerData: Readonly<Record<string, unknown>>,
): string | null {
  const explicit = readString(params, 'userId');
  if (explicit !== null) return explicit;
  const topLevel = readString(triggerData, 'userId');
  if (topLevel !== null) return topLevel;
  const metadata = triggerData['metadata'];
  if (typeof metadata !== 'object' || metadata === null) return null;
  return readString(metadata as Record<string, unknown>, 'userId');
}

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
