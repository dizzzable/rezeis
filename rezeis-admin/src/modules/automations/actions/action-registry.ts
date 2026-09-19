import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

import { paymentsConfig } from '../../../common/config/payments.config';
import {
  HEADER_FIELD_VALUE_RULE,
  INVALID_HEADER_ERROR_CODES,
  isHeaderFieldValue,
} from '../../../common/net/header-value';
import {
  checkOutboundUrl,
  describeOutboundUrlRefusal,
  describeRange,
  guardedAgents,
} from '../../../common/net/outbound-url';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EVENT_TYPES,
  SystemEventSeverity,
  SystemEventsService,
} from '../../../common/services/system-events.service';
import {
  AutomationActionContext,
  AutomationActionDefinition,
  AutomationActionResult,
  AutomationActionResultDetails,
} from '../interfaces/automation-action.interface';
import { UserBlockService } from '../../users/services/user-block.service';
import {
  HINT_AUDIENCES,
  HintAudienceService,
  type AudienceOutcome,
  type HintAudienceName,
} from '../../user-hints/services/hint-audience.service';
import { UserHintDeliveryService } from '../../user-hints/services/user-hint-delivery.service';
import { AUTOMATION_ACTION_TYPES, AutomationActionType } from '../automations.constants';
import { chainMetadata } from '../chain-depth';
import { CUSTOM_EVENT_TYPE_RULE, isCustomEventType, systemEventTypeOf } from '../custom-event-type';
import {
  AUTOMATION_NETWORK_PROBES,
  SYSTEM_NETWORK_PROBES,
  type AutomationNetworkProbes,
} from '../services/automation-network-probes';
import {
  BlockAddressUnverifiableError,
  BlockIpSafetyService,
  describeBlockProtection,
  type BlockAddressRefusal,
} from '../services/block-ip-safety.service';
import { parseBlockEntry } from '../utils/network-address.util';
import {
  ActionFailure,
  actionSkipped,
  actionSucceeded,
  type ActionHandlerOutcome,
} from './action-outcome';

/**
 * Pure execution surface: takes `(context, action)` and produces a
 * `result`. `execute()` never throws — whatever a handler does, it answers
 * a result object, so the orchestrator can record per-action outcomes
 * without losing the rest of the action chain.
 *
 * A handler answers in one of three ways:
 *   - a string — a success with no code, which is what most handlers return;
 *   - an `ActionHandlerOutcome` (`actionSucceeded` / `actionSkipped`) — a
 *     success or a skip with a code the SPA can word;
 *   - by THROWING — a failure. `ActionFailure` carries a code and details onto
 *     the result; any other error fails the action with its message alone.
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
  private readonly networkProbes: AutomationNetworkProbes;

  public constructor(
    private readonly httpService: HttpService,
    private readonly prismaService: PrismaService,
    private readonly systemEventsService: SystemEventsService,
    private readonly userBlockService: UserBlockService,
    private readonly userHintDeliveryService: UserHintDeliveryService,
    private readonly hintAudienceService: HintAudienceService,
    @Inject(paymentsConfig.KEY)
    private readonly paymentsConfiguration: ConfigType<typeof paymentsConfig>,
    /**
     * The lockout check `block_ip` needs before it writes. Optional only so a
     * registry built by hand in a spec still constructs — and absent, the
     * action blocks NOTHING (`block_address_unverified`): a missing safety
     * check is not a reason to skip it.
     */
    @Optional()
    private readonly blockIpSafety?: BlockIpSafetyService,
    @Optional()
    @Inject(AUTOMATION_NETWORK_PROBES)
    networkProbes?: AutomationNetworkProbes,
  ) {
    this.networkProbes = networkProbes ?? SYSTEM_NETWORK_PROBES;
  }

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
      const answer = await this.dispatch(action, context);
      const outcome: ActionHandlerOutcome =
        typeof answer === 'string' ? { status: 'success', message: answer } : answer;
      return {
        index,
        type: action.type,
        status: outcome.status,
        message: outcome.message,
        ...codeFields(outcome.code, outcome.details),
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
        // Only a failure that was NAMED carries a code. A downstream call that
        // blew up is still a failure, and inventing a name for it would have
        // the SPA word a guess.
        ...(err instanceof ActionFailure ? codeFields(err.code, err.details) : {}),
      };
    }
  }

  // ── Action handlers ────────────────────────────────────────────────────

  private async dispatch(
    action: AutomationActionDefinition,
    context: AutomationActionContext,
  ): Promise<string | ActionHandlerOutcome> {
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
      case 'show_hint_to_audience':
        return this.showHintToAudience(action, context);
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
    // ── DO NOT REPORT A DELIVERY WE CANNOT SEE ───────────────────────────────
    //
    // `warn()` is `void` and fire-and-forget — correct for the event bus, which
    // must never fail the caller that raised the event. But this action then
    // answered `notify queued` and the rule was graded SUCCEEDED, so an operator
    // whose Telegram notifications were switched off, or who had never ticked
    // this event type, watched their alerting rule report a clean run on every
    // single fire while nothing was ever delivered. A dead alert that looks
    // healthy is worse than one that looks broken.
    //
    // The probe cannot promise delivery. It answers the two questions that are
    // knowable up front and that cover both silent deaths, and a rule whose
    // notification provably cannot arrive now FAILS with the reason.
    const delivery = await this.systemEventsService.describeTelegramDelivery(
      EVENT_TYPES.AUTOMATION_TELEGRAM_NOTIFY,
    );
    if (!delivery.deliverable) {
      throw new Error(
        `notification cannot be delivered: ${delivery.reason ?? 'Telegram delivery is unavailable'}`,
      );
    }
    this.systemEventsService.warn(
      EVENT_TYPES.AUTOMATION_TELEGRAM_NOTIFY,
      'SYSTEM',
      text,
      chainMetadata(context),
    );
    // "raised", not "queued": the event is on the bus, and what happens after
    // that is the notification settings' business, not this action's to claim.
    return `notification raised: ${text.slice(0, 64)}`;
  }

  /**
   * POSTs the event to the rule's URL, with the rule's optional
   * `Authorization` header — and never to the machine itself or to a cloud
   * metadata service (the policy, and why it allows private networks, is in
   * `common/net/outbound-url.ts`; the panel's own webhooks follow the same one).
   *
   * ── Checked twice, the second time where it cannot be dodged ─────────────
   *
   * The URL is judged statically first (`checkOutboundUrl`): the same check the
   * save runs, repeated because a rule saved before it existed, or written by
   * an import, never met it. Then the request goes out through agents whose
   * socket lookup refuses every address the policy refuses (`guardedAgents`),
   * so the address that is judged is the address that is dialled — a name
   * that resolves somewhere allowed for a check and to the loopback for the
   * request has nothing to exploit. `maxRedirects: 0`, as the panel's own
   * webhook dispatcher sends, so a receiver cannot bounce the request to a
   * refused address; `proxy: false`, so an environment proxy cannot carry it
   * past the lookup that makes the decision.
   *
   * The success message names the host and nothing more: a webhook URL often
   * carries its secret in the path, and the message is stored on the
   * execution row that everybody with `automations:view` can read.
   */
  private async webhookPost(
    action: AutomationActionDefinition,
    context: AutomationActionContext,
  ): Promise<string> {
    const target = checkOutboundUrl(action.params['url']);
    if (!target.ok) {
      throw new ActionFailure(
        `webhook_post: ${describeOutboundUrlRefusal(target.refusal)}`,
        'webhook_url_refused',
        {
          reason: target.refusal.reason,
          ...(target.refusal.range === undefined
            ? {}
            : { range: target.refusal.range.cidr, kind: target.refusal.range.kind }),
        },
      );
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const authHeader = readString(action.params, 'authorizationHeader');
    // A header saved before its characters were checked (a Cyrillic token,
    // say) would make Node throw ERR_INVALID_CHAR from inside the request —
    // an unnamed error, on every run. Named here instead, and nothing is sent.
    if (authHeader !== null && !isHeaderFieldValue(authHeader)) {
      throw new ActionFailure(
        `webhook_post: the Authorization header ${HEADER_FIELD_VALUE_RULE}, so nothing was sent`,
        'webhook_header_invalid',
      );
    }
    if (authHeader) headers.Authorization = authHeader;

    const agents = guardedAgents(this.networkProbes.lookupAll);
    try {
      await firstValueFrom(
        this.httpService.post(
          target.url.toString(),
          {
            ruleId: context.ruleId,
            ruleName: context.ruleName,
            trigger: context.trigger,
            triggerData: context.triggerData,
          },
          {
            headers,
            timeout: 10_000,
            maxRedirects: 0,
            proxy: false,
            httpAgent: agents.httpAgent,
            httpsAgent: agents.httpsAgent,
          },
        ),
      );
    } catch (err) {
      const refused = agents.refusal();
      if (refused !== null) {
        throw new ActionFailure(
          `webhook_post: refused to connect, because ${refused.host} resolves to ` +
            `${describeRange(refused.range)}: ${refused.address}`,
          'webhook_address_refused',
          {
            host: refused.host,
            address: refused.address,
            range: refused.range.cidr,
            kind: refused.range.kind,
          },
        );
      }
      // Whatever else Node refuses in a header is named as well, never passed
      // on raw: the check above is the one Node applies, so this is the belt
      // to its braces.
      if (isInvalidHeaderError(err)) {
        throw new ActionFailure(
          `webhook_post: a request header ${HEADER_FIELD_VALUE_RULE}, so nothing was sent`,
          'webhook_header_invalid',
        );
      }
      throw err;
    }
    return `POST to ${target.host}`;
  }

  /**
   * Adds the address the rule names, or the one its trigger carries, to the IP
   * blocklist — after the lockout check the manual screen never needed, because
   * a person was always there.
   *
   * ── What changed, and why each part is here ─────────────────────────────
   *
   * It used to write whatever string it was handed, straight into
   * `blocked_ips`. So a rule could list the reverse proxy's address, the
   * cabinet's, or the address every admin signs in from — and because
   * `BlockedIpGuard` runs before the allowlist and before sign-in, the only way
   * back from that is an UPDATE against the database.
   *
   *   PARSED, AND STORED CANONICAL, like `BlockedIpService.create`. A value
   *   that is not an address is refused by name instead of being written as a
   *   row the guard can never match; a mapped `::ffff:1.2.3.4` is stored as the
   *   `1.2.3.4` the guard compares.
   *
   *   A RANGE ONLY FROM THE RULE. A CIDR written into the rule's own `address`
   *   was checked at save and is on the screen for anybody to read. A trigger's
   *   payload — an event, or a manual run's body — names ONE address; a range
   *   arriving there did not come from where it claims to, and a rule must not
   *   widen a ban on its own (the block cascade refuses the same).
   *
   *   THE LOCKOUT CHECK (`BlockIpSafetyService`), with the requester's address
   *   on a manual run — see there for everything it protects. If it cannot be
   *   run, nothing is blocked.
   */
  private async blockIp(
    action: AutomationActionDefinition,
    context: AutomationActionContext,
  ): Promise<string> {
    const explicit = readString(action.params, 'address');
    const fromTrigger = readString(context.triggerData, 'ip')
      ?? readString(context.triggerData, 'ipAddress');
    const raw = explicit ?? fromTrigger;
    if (raw === null) {
      throw new ActionFailure(
        'block_ip requires `address` or trigger data with `ip`',
        'block_address_missing',
      );
    }
    const source = explicit !== null ? 'rule' : 'trigger';
    const entry = parseBlockEntry(raw);
    if (entry === null) {
      throw new ActionFailure(
        source === 'rule'
          ? 'block_ip: the rule\'s "address" is not an IP address or CIDR range'
          : 'block_ip: the address in the trigger data is not an IP address',
        'block_address_invalid',
        { source },
      );
    }
    if (source === 'trigger' && entry.prefix !== (entry.family === 4 ? 32 : 128)) {
      throw new ActionFailure(
        'block_ip: the trigger data names a range, and a range can only be written into the rule itself',
        'block_address_invalid',
        { source },
      );
    }
    const reason = readString(action.params, 'reason')
      ?? `Automated by rule "${context.ruleName}"`;
    const expiresAtRaw = readString(action.params, 'expiresAt');
    const expiresAt = expiresAtRaw === null ? null : new Date(expiresAtRaw);
    if (expiresAt !== null && Number.isNaN(expiresAt.getTime())) {
      throw new Error('block_ip: "expiresAt" is not a valid date');
    }

    const address = entry.canonical;
    if (this.blockIpSafety === undefined) {
      throw new ActionFailure(
        `block_ip: the lockout check is not available here, so ${address} was not blocked`,
        'block_address_unverified',
        { address },
      );
    }
    let refusal: BlockAddressRefusal | null;
    try {
      refusal = await this.blockIpSafety.refusalFor(entry, {
        requestIp: context.manual?.requestIp ?? null,
      });
    } catch (err) {
      if (!(err instanceof BlockAddressUnverifiableError)) throw err;
      // The reason — a database sentence — goes to the log, not to the row
      // everybody with `automations:view` reads.
      this.logger.warn(`block_ip for rule ${context.ruleId} stood down: ${err.message}`);
      throw new ActionFailure(
        `block_ip: could not read the administrators' addresses, so ${address} was not blocked`,
        'block_address_unverified',
        { address },
      );
    }
    if (refusal !== null) {
      throw new ActionFailure(
        `block_ip: refused to block ${address}, because it covers ${describeBlockProtection(refusal)}`,
        'block_address_protected',
        {
          address,
          protection: refusal.protection,
          ...(refusal.range === undefined ? {} : { range: refusal.range }),
        },
      );
    }

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

    // ── ALREADY BLOCKED ENDS HERE, and this guard is load-bearing ────────
    //
    // Blocking emits `user.blocked` carrying `metadata.userId`, and the
    // automation bridge dispatches every emitted event back into rule
    // matching. Before the customer could be resolved from `metadata` at all
    // this action threw on every realtime trigger, so the cycle was
    // unreachable; making the resolver work made it live.
    //
    // A rule an operator would plausibly write — REALTIME on `user.blocked`,
    // or `user.*`, or `*`, with a block action — then blocks, emits, matches,
    // blocks again, for ever: a device list read per subscription, a node
    // enumeration, a sync job and a `dropConnections` against the panel on
    // every lap, with nothing to stop it.
    //
    // Standing down here breaks the cycle at the second lap and is the right
    // answer on its own terms: an unattended rule has no business re-running a
    // cascade against somebody already blocked. The BULK screen deliberately
    // does re-run — that is an operator finishing a half-executed ban, with a
    // person deciding — and it does not come through here.
    const target = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: { isBlocked: true },
    });
    if (target?.isBlocked === true) {
      return `user ${userId} is already blocked; the rule stood down`;
    }
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
        ...chainMetadata(context),
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
   * ── When nothing is queued, the run says which reason it was ──────────
   *
   * The queue declines for three reasons, and they are graded apart:
   *
   *   - the hint is switched off, or this customer already has a delivery of
   *     a hint that does not repeat → SKIPPED. The rule is behaving exactly as
   *     configured, so this is not red — but it is not green either. A run
   *     graded SUCCEEDED while nothing was queued for anybody is what an
   *     operator pressing «Запустить сейчас» used to be shown;
   *   - nobody authored a hint with this key → FAILED. Always a mistake, and
   *     one the operator can fix.
   *
   * Supersession is not a reason: the queue never declines the hint being
   * raised because of its group — it queues it and lapses the older ones.
   *
   * ── A manual run names its customer from outside ───────────────────────
   *
   * The id arrives in the run body, so a manual run is the one place the
   * customer is looked up first: an id that matches nobody must read "no such
   * customer", not a foreign-key error from the insert. An event names a
   * customer the panel itself just acted on, and it gains no query here.
   * `showAgain` comes from the manual marker only — never from `triggerData`,
   * which a payload shapes.
   */
  private async showHint(
    action: AutomationActionDefinition,
    context: AutomationActionContext,
  ): Promise<ActionHandlerOutcome> {
    const hintKey = readString(action.params, 'hintKey');
    if (!hintKey) throw new ActionFailure('show_hint requires `hintKey`', 'hint_key_missing');
    const manual = context.manual;
    // ── ON A MANUAL RUN, THE CUSTOMER THE REQUEST NAMES ───────────────────
    //
    // `resolveTriggerUserId` lets a `params.userId` pinned on the action win
    // over the payload, and on an event that is right: the pin is the rule's
    // own decision. A manual run's request names the customer the operator
    // just chose, and a pin quietly sending the pop-up to somebody else is the
    // one answer they could not see coming. A request that names nobody falls
    // back to the rule's own resolution, pin included.
    const requested = manual === undefined ? null : readString(context.triggerData, 'userId');
    const userId = requested ?? resolveTriggerUserId(action.params, context.triggerData);
    if (!userId) {
      // Named explicitly rather than swallowed: an operator can act on it. They
      // bound the hint to an event that does not name a customer, or ran the
      // rule by hand without naming one.
      throw new ActionFailure(
        manual === undefined
          ? 'show_hint requires a trigger that names a customer — this event carries no userId'
          : 'show_hint requires a trigger that names a customer — this manual run named no userId',
        'customer_missing',
      );
    }
    if (manual !== undefined) {
      const customer = await this.prismaService.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (customer === null) {
        throw new ActionFailure(
          `show_hint: there is no customer with id ${userId}`,
          'customer_not_found',
          { userId },
        );
      }
    }
    const outcome = await this.userHintDeliveryService.raiseWithOutcome({
      userId,
      hintKey,
      // The delivery row is the only place an operator can later ask "why did
      // this customer see that", and a hint an operator sent by hand is a
      // different answer from one the rule sent on its own.
      source: manual === undefined ? `rule:${context.ruleId}` : `rule:${context.ruleId}:manual`,
      showAgain: manual !== undefined && manual.showAgain,
    });
    switch (outcome.kind) {
      case 'queued':
        return actionSucceeded(`queued hint "${hintKey}" for ${userId}`, 'hint_queued', {
          hintKey,
          userId,
        });
      case 'already_delivered':
        return actionSkipped(
          `hint "${hintKey}" was not queued for ${userId}: it does not repeat and this ` +
            'customer already has a delivery of it',
          'hint_already_delivered',
          { hintKey, userId },
        );
      case 'hint_inactive':
        return actionSkipped(
          `hint "${hintKey}" was not queued for ${userId}: the hint is switched off`,
          'hint_inactive',
          { hintKey },
        );
      case 'hint_missing':
        throw new ActionFailure(
          `hint "${hintKey}" does not exist, so nothing was queued for ${userId}`,
          'hint_missing',
          { hintKey },
        );
    }
  }

  /**
   * Queues a hint for everybody a QUERY selects, rather than for whoever an
   * event named.
   *
   * ── Why this action exists at all ─────────────────────────────────────
   *
   * Every other hint follows something that happened. The most useful one
   * follows something that did NOT happen — the customer paid a day ago and
   * has still never connected — and nothing emits an event for a thing not
   * occurring. So it is a scheduled query, and it belongs on a CRON rule.
   *
   * ── Standing down is a success, not a failure ─────────────────────────
   *
   * `HintAudienceService` answers `blind` when the connect signal is blind —
   * the panel has not read Remnawave for half an hour and no webhook arrived
   * in a day — so "has never connected" cannot be told from "we could not
   * look". Acting on that would hint people who are connected.
   *
   * The action reports that as a SUCCESS with the reason in its message,
   * deliberately. A failed execution invites an operator to retry, and a retry
   * cannot fix a missing webhook; the message is what tells them what to fix.
   * The audience service logs it at warn level as well.
   *
   * A REFUSAL is different: too many people for a pop-up, or a cohort the
   * database stopped at its statement timeout. Those are FAILED, with the same
   * `audience_blind` code and a `cause` — see the branch below.
   *
   * ── The hint is asked about BEFORE the audience ───────────────────────
   *
   * A hint that does not exist or is switched off makes every raise below a
   * no-op, and finding that out one customer at a time costs the full cohort
   * query plus up to five hundred reads — to report "queued 0 of 500", which
   * reads like a quiet night rather than a broken rule. Missing is FAILED (a
   * mistake to fix); switched off is SKIPPED (a choice somebody made).
   */
  private async showHintToAudience(
    action: AutomationActionDefinition,
    context: AutomationActionContext,
  ): Promise<ActionHandlerOutcome> {
    // ── NOT ON AN EVENT ──────────────────────────────────────────────────
    //
    // This action picks its own recipients, so the trigger contributes
    // nothing — but bound to a realtime rule it runs a full audience resolve
    // plus up to five hundred sequential raises on EVERY system event. One
    // `*` rule saved while the editor still had its default trigger kind turns
    // a payment burst into thousands of queries.
    //
    // The editor says so in words; words are not a constraint, and REALTIME is
    // what the drawer opens with.
    if (context.trigger.startsWith('event:')) {
      throw new Error(
        'show_hint_to_audience picks its own recipients and must run on a scheduled ' +
          'rule, not on an event trigger',
      );
    }
    const hintKey = readString(action.params, 'hintKey');
    if (!hintKey) {
      throw new ActionFailure('show_hint_to_audience requires `hintKey`', 'hint_key_missing');
    }
    const audience = readString(action.params, 'audience');
    if (audience === null || !(HINT_AUDIENCES as readonly string[]).includes(audience)) {
      throw new Error(
        `show_hint_to_audience requires \`audience\` to be one of: ${HINT_AUDIENCES.join(', ')}`,
      );
    }

    // THE RUN CLOCK STARTS HERE, above the first read rather than at the loop
    // below, because everything from this line on can WAIT. The hint-status
    // read and the cohort resolve are bounded at 30 s each; a budget that only
    // started counting after them would let a slow run spend 30 + 30 before its
    // first raise and still take its own 60 s on top — 120 s, exactly what the
    // route allows, so the operator would be answered 408 by the run this
    // budget exists to end politely. Counted from here, working out WHO to hint
    // comes out of the same sixty seconds as hinting them.
    const startedAt = Date.now();
    const hintStatus = await this.userHintDeliveryService.hintStatus(hintKey);
    if (hintStatus === 'missing') {
      throw new ActionFailure(
        `show_hint_to_audience: hint "${hintKey}" does not exist, so the audience was not resolved`,
        'hint_missing',
        { hintKey },
      );
    }
    if (hintStatus === 'inactive') {
      return actionSkipped(
        `hint "${hintKey}" is switched off, so the audience was not resolved`,
        'hint_inactive',
        { hintKey },
      );
    }

    // A THROW HERE IS A DATABASE SENTENCE. An unnamed throw becomes the
    // result's `message` verbatim (see `execute` above), and that message
    // travels in a 200 body and into `automation_executions.error_message` —
    // the one path `AdminSafeExceptionFilter` never sees. Until the resolve
    // was bounded this path was a WAIT rather than a throw; now that a busy
    // pool fails it in 10 s, the reason belongs where the per-customer
    // failures below already put it: the panel log.
    let outcome: AudienceOutcome;
    try {
      outcome = await this.hintAudienceService.resolve({
        audience: audience as HintAudienceName,
        afterHours: readNumber(action.params, 'afterHours'),
        beforeHours: readNumber(action.params, 'beforeHours'),
      });
    } catch (err) {
      this.logger.warn(
        `show_hint_to_audience: could not work out the audience "${audience}" for rule ` +
          `${context.ruleId}: ${describeFailure(err)}`,
      );
      // Deliberately UNNAMED: nothing was attempted, so there are no counts
      // to report and no new word for the panel to learn. It fails the run
      // exactly as any other blown-up call does.
      //
      // `cause` keeps the chain for anyone reading a stack; it is not copied
      // into the result, which takes `.message` and nothing else, so it adds
      // no database text to anything an operator is shown.
      throw new ErrorWithCause(
        `could not work out who to hint for audience "${audience}"; why is in the panel log`,
        { cause: err },
      );
    }
    if (outcome.kind === 'blind') {
      // A BACKWARDS WINDOW IS THE OPERATOR'S MISTAKE, and grading it green
      // hides it for ever. The justification for reporting blindness as
      // success — "a retry cannot fix a missing webhook" — does not cover a
      // pair of numbers somebody typed in the wrong order, which a retry
      // absolutely can fix once they are told.
      if (outcome.reason.includes('window is empty')) {
        throw new Error(`show_hint_to_audience: ${outcome.reason}`);
      }
      // `cause` is what the panel words: the reason stays for the log and for
      // a panel older than the word.
      return actionSucceeded(
        `stood down without hinting anybody: ${outcome.reason}`,
        'audience_blind',
        { reason: outcome.reason, cause: 'signal_blind' },
      );
    }
    if (outcome.kind === 'refused') {
      // REFUSED, NOT STOOD DOWN. Too many people for a pop-up, or a cohort the
      // database gave up on after its statement timeout: nobody was hinted,
      // and unlike a blind signal the operator has something to do — narrow
      // the window, send a broadcast instead, or look at why the database is
      // slow — so the run is red.
      //
      // The code is `audience_blind`, the one that already means "the audience
      // was not worked out, nobody was hinted", with `cause` saying which way;
      // the panel words each cause on its own. `reason` carries no database
      // text: it is the audience service's own sentence.
      throw new ActionFailure(
        `show_hint_to_audience hinted nobody: ${outcome.reason}`,
        'audience_blind',
        { audience, cause: outcome.cause, reason: outcome.reason, limit: outcome.limit },
      );
    }
    if (outcome.userIds.length === 0) {
      return actionSucceeded(`nobody matched the "${audience}" audience`, 'audience_empty', {
        audience,
      });
    }

    // Sequential, not parallel. This is a scheduled job with nowhere to be, and
    // the supersession check inside `raise()` reads and lapses rows for the
    // same customer — running the batch concurrently would race those against
    // each other for a customer matched twice.
    //
    // ── ONE FAILED RAISE IS ONE CUSTOMER, THREE IN A ROW ARE THE DATABASE ───
    //
    // A raise that throws used to end the loop and throw away the counts: one
    // customer deleted after the audience was resolved, or one moment of a
    // busy pool, and everybody after them went without the hint while the log
    // could not say how far the run had got. So a failure is counted and the
    // loop moves on — and it stops after
    // `AUDIENCE_RAISE_FAILURE_STREAK_LIMIT` failures in a row, when the
    // database is plainly not answering and every remaining customer would
    // wait out the raise's 30 s budget to fail the same way.
    //
    // ── AND THREE FAILURES BOUND NOTHING IF NOTHING FAILS ─────────────────
    //
    // Raises that SUCCEED can take just as long — each may wait up to 30 s for
    // a connection and its statements — and a run that is merely slow trips no
    // streak: five hundred raises at a second each is eight minutes, and
    // «Запустить сейчас» would be answered 408 at two of them while the loop
    // kept queueing behind the operator. So the action carries a WALL-CLOCK
    // budget as well — started at the top, before the first read, so that
    // working out who to hint is spent out of it too — and the loop stops on it
    // with the same partial answer.
    const matched = outcome.userIds.length;
    let queued = 0;
    let failed = 0;
    let attempted = 0;
    let failureStreak = 0;
    let stoppedBy: 'failures' | 'time' | null = null;
    let lastFailure = '';
    for (const userId of outcome.userIds) {
      if (failureStreak >= AUDIENCE_RAISE_FAILURE_STREAK_LIMIT) {
        stoppedBy = 'failures';
        break;
      }
      if (Date.now() - startedAt >= AUDIENCE_RUN_BUDGET_MS) {
        stoppedBy = 'time';
        break;
      }
      attempted += 1;
      try {
        const delivery = await this.userHintDeliveryService.raise({
          userId,
          hintKey,
          source: `audience:${audience}`,
        });
        failureStreak = 0;
        if (delivery !== null) queued += 1;
      } catch (err) {
        failed += 1;
        failureStreak += 1;
        lastFailure = describeFailure(err);
        this.logger.warn(
          `show_hint_to_audience: could not queue "${hintKey}" for ${userId} (rule ${context.ruleId}): ${lastFailure}`,
        );
      }
    }

    const notAttempted = matched - attempted;
    if (failed > 0 || notAttempted > 0) {
      // FAILED, with everything it did get done: the deliveries it queued stay
      // queued, and the counts say how far it got.
      //
      // THE DATABASE'S OWN SENTENCE IS NOT IN HERE. `message` reaches a 200
      // body, the operator’s screen and `automation_executions.error_message`
      // — the one path `AdminSafeExceptionFilter` never sees — and driver text
      // carries hosts, ports and internal names that the filter strips
      // everywhere else. It is in the log line above instead, per customer,
      // where whoever can read the panel log can read it.
      throw new ActionFailure(
        `queued "${hintKey}" for ${queued} of ${matched} matched ` +
          `${outcome.truncated ? '(capped) ' : ''}account(s); ${failed} could not be queued` +
          (stoppedBy === 'failures'
            ? `, and the run stopped after ${AUDIENCE_RAISE_FAILURE_STREAK_LIMIT} failures in a row, ` +
              `leaving ${notAttempted} not attempted`
            : '') +
          (stoppedBy === 'time'
            ? `, and the run stopped after ${Math.round(AUDIENCE_RUN_BUDGET_MS / 1000)} seconds, ` +
              `leaving ${notAttempted} not attempted`
            : '') +
          '; why each one failed is in the panel log',
        'audience_partial',
        {
          hintKey,
          audience,
          matched,
          queued,
          failed,
          notAttempted,
          stoppedEarly: notAttempted > 0,
          stoppedBy,
          capped: outcome.truncated,
        },
      );
    }

    // Both numbers, because they differ for an ordinary reason: the hint is
    // once-only, so a daily rule matches the same people again and queues
    // nothing for them. An operator seeing "matched 40, queued 3" is looking at
    // a rule working exactly as intended.
    return actionSucceeded(
      `queued "${hintKey}" for ${queued} of ${matched} matched ` +
        `${outcome.truncated ? '(capped) ' : ''}account(s)`,
      'audience_queued',
      {
        hintKey,
        audience,
        queued,
        matched,
        capped: outcome.truncated,
      },
    );
  }

  /**
   * Emit a custom event into the SystemEventsService stream.
   *
   * `type` is the rule's own name for its event — but only inside the rule's
   * own namespace, `automation.custom` and `automation.custom.<name>`
   * (`custom-event-type.ts`): a type of the panel's own would drive every rule,
   * quest, e-mail, push and webhook that trusts the bus. Other rules and
   * webhooks match on the custom name. Such a type cannot be registered,
   * presented or ticked — the operator's catch-all tick-box
   * (`UNREGISTERED_EVENTS_SENTINEL`) is what makes it deliverable in `selected`
   * mode. The DEFAULT, by contrast, is a fixed string, so it is a real
   * registered constant with a card and a tick-box of its own.
   *
   * The severity is the rule's; the category is not. It is AUTOMATION whatever
   * `params.category` says — see the emit below.
   */
  private async systemEvent(
    action: AutomationActionDefinition,
    context: AutomationActionContext,
  ): Promise<string> {
    // Only the rule's OWN events (`custom-event-type.ts`): a rule saved before
    // that was checked could still name `payment.completed`, and everything
    // downstream would take it for a real payment. Refused, and nothing emitted.
    const type = systemEventTypeOf(action.params);
    if (!isCustomEventType(type)) {
      throw new ActionFailure(
        `system_event: ${CUSTOM_EVENT_TYPE_RULE}, so nothing was emitted`,
        'system_event_type_refused',
        { type },
      );
    }
    const message = readString(action.params, 'message') ?? `Automation "${context.ruleName}" fired`;
    const severity = readSeverity(action.params, 'severity');
    // AUTOMATION, whatever the rule asks for. The category used to be the
    // rule's to pick, and SYSTEM + ERROR is how the panel's own critical errors
    // arrive: every subscribed admin's device showed the rule author's sentence
    // under «Система». The severity stays the rule's; where the event came from
    // is not the rule's to say. `params.category` is no longer read, so a rule
    // that still carries one saves and runs as before.
    this.systemEventsService.emit({
      type,
      category: 'AUTOMATION',
      severity,
      message,
      metadata: chainMetadata(context),
    });
    return `emitted ${type}`;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Failed raises IN A ROW after which an audience run stops.
 *
 * One failure is one customer — deleted after the audience was resolved, say —
 * and the rest of the audience is still owed its hint. Several in a row are the
 * database: out of connections, or gone, and grinding through the rest of a
 * 500-customer audience would cost hours to fail the same way.
 *
 * WHAT THREE COST, AND WHY IT IS NOT ADDED TO ANYTHING. Each failed raise can
 * take up to 30 s (`RAISE_TRANSACTION_OPTIONS` in the delivery service: 10 s to
 * get a connection, 20 s to finish), so three would be 90 s on their own. They
 * are not spent on top of the budget below: that clock starts at the top of the
 * action and is read before every raise, so against a database that slow the
 * TIME limit trips first — after two failures, at 60 s — and this limit is what
 * ends a run whose raises fail FAST. Whichever of the two trips, the action is
 * finished by 90 s.
 */
const AUDIENCE_RAISE_FAILURE_STREAK_LIMIT = 3;

/**
 * How long an audience run may spend — working out who to hint AND raising —
 * before it stops and reports what it managed.
 *
 * The streak limit above bounds only a run whose raises FAIL. One that merely
 * crawls — a busy pool handing each raise its connection after nine seconds,
 * say — trips nothing, and five hundred of those outlast every budget around
 * them: «Запустить сейчас» is answered 408 at 120 s (`LONG_TIMEOUT_PATTERNS`)
 * while the loop goes on queueing, which is the outcome the streak limit and
 * this budget both exist to prevent.
 *
 * THE CLOCK STARTS AT THE TOP OF THE ACTION, not at the top of the loop, and
 * that is load-bearing arithmetic rather than tidiness. The hint-status read
 * and the cohort resolve are bounded at 30 s EACH by their own transactions; a
 * budget that began only after them would allow 30 + 30 + 60 = 120 s, which is
 * exactly what the route allows (`LONG_TIMEOUT_PATTERNS`), so the operator
 * would be answered 408 by the very run this exists to end politely. Counted
 * from the top, those two reads spend the same sixty seconds the raises do.
 *
 * Read BEFORE each raise, so the one already under way can carry the action to
 * 90 s at worst (its own 30 s) — a 30 s margin under a manual run's 120 s,
 * whichever limit trips. A nightly run on a healthy install spends a second or
 * two here; one that reaches this budget says so, and the customers it did not
 * reach are counted rather than lost.
 */
const AUDIENCE_RUN_BUDGET_MS = 60_000;

/**
 * `Error` with ES2022's `cause`. `target` is ES2021 here, so the two-argument
 * constructor is not in the type library — the runtime (Node 24) has had it
 * for years, and the chain is worth keeping for whoever reads a stack.
 */
const ErrorWithCause = Error as unknown as new (
  message: string,
  options: { readonly cause: unknown },
) => Error;

/** An error as one line of text for a LOG LINE — never for an operator — and never unbounded. */
function describeFailure(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/**
 * `code` and `details` as result fields — or no fields at all.
 *
 * Omitted rather than set to `undefined`, so a result that names nothing has
 * exactly the shape it had before codes existed.
 */
function codeFields(
  code: string | undefined,
  details: AutomationActionResultDetails | undefined,
): Pick<AutomationActionResult, 'code' | 'details'> {
  if (code === undefined) return {};
  return details === undefined ? { code } : { code, details };
}

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
 * (`show_hint` on a MANUAL run reads the request's own `userId` before calling
 * this — see `showHint`. Every other caller gets this order as written.)
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
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const meta = metadata as Record<string, unknown>;
  const direct = readString(meta, 'userId');
  if (direct !== null) return direct;

  // ── THE TWO EVENTS THAT SPELL IT DIFFERENTLY ─────────────────────────
  //
  // Reading only `userId` still left the two bindings an operator is most
  // likely to reach for inert, and the comment above claimed otherwise.
  //
  //   `fraud.signal_opened` carries `fraudRezeisUserId`, set only when the
  //   signal names exactly one customer — which is precisely when acting on it
  //   is defensible.
  //
  //   `user.registered` from the Telegram bot carries `reiwaId`. Its web twin
  //   carries `userId`, so a welcome hint bound to both fired for half the
  //   customers and failed for the other half.
  //
  // `affectedUserIds` is read ONLY when it names exactly one account. A signal
  // about several people does not have "the" customer, and picking the first
  // would be inventing one.
  const fraud = readString(meta, 'fraudRezeisUserId');
  if (fraud !== null) return fraud;
  const reiwaId = readString(meta, 'reiwaId');
  if (reiwaId !== null) return reiwaId;
  const affected = meta['affectedUserIds'];
  if (Array.isArray(affected) && affected.length === 1 && typeof affected[0] === 'string') {
    const single = affected[0].trim();
    return single.length > 0 ? single : null;
  }
  return null;
}

/** An error Node's HTTP layer raises for a header value, bare or wrapped by axios. */
function isInvalidHeaderError(err: unknown): boolean {
  for (let current: unknown = err, depth = 0; current !== null && current !== undefined && depth < 3; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && INVALID_HEADER_ERROR_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function readString(params: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = params[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** An optional positive number from the action's params. */
function readNumber(
  params: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = params[key];
  // A NUMERIC STRING COUNTS. `params` is stored JSON validated only as an
  // object, so `{"afterHours": "72"}` is an ordinary thing for an API caller to
  // send — and dropping it silently was worse than rejecting it: both hours
  // vanished, the action fell back to the DEFAULT window, and it then reported
  // success naming a cohort the operator never asked for. The empty-window
  // guard never saw the pair either, so a reversed one could not be caught.
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric <= 0) return undefined;
  return numeric;
}

function readSeverity(
  params: Readonly<Record<string, unknown>>,
  key: string,
): SystemEventSeverity {
  const raw = readString(params, key);
  if (raw === 'WARNING' || raw === 'ERROR' || raw === 'INFO') return raw;
  return 'INFO';
}
