import { EVENT_TYPES } from '../../common/services/system-events.service';

/**
 * Which event types a rule's `system_event` action may emit.
 *
 * ── Why not any type ──────────────────────────────────────────────────────
 *
 * The action puts its event on the same bus the panel's own events travel,
 * and everything downstream trusts that bus: other operators' rules (with
 * `block_user`, `webhook_post`, `block_ip`), quests, e-mails, pushes and the
 * outgoing webhooks. A MANUAL rule emitting a forged `payment.completed` drove
 * every one of them as though a customer had paid. So a rule may emit only its
 * OWN events, in a namespace no real event can use.
 *
 * ── The namespace ─────────────────────────────────────────────────────────
 *
 * The codebase already has one: `automation.custom` (`EVENT_TYPES.
 * AUTOMATION_CUSTOM`) is the action's default type, with its own Telegram card
 * and tick-box, and a rule chain on `automation.*` is the documented example
 * (`chain-depth.ts`). So a custom type is `automation.custom` itself or a name
 * under it — `automation.custom.<name>[.<name>…]`, lower-case letters, digits,
 * `_` and `-`. The panel's own `automation.telegram_notify` stays out of reach:
 * it is not under `automation.custom.`.
 *
 * No real event may ever live under `automation.custom.`: the spec
 * `automation-system-event-namespace.spec.ts` walks `EVENT_TYPES` and fails if
 * one does.
 */
export const CUSTOM_EVENT_TYPE_ROOT = EVENT_TYPES.AUTOMATION_CUSTOM;

const CUSTOM_EVENT_TYPE = /^automation\.custom(?:\.[a-z0-9_-]+)*$/;

/** The longest custom type accepted — far beyond any name written by hand. */
export const CUSTOM_EVENT_TYPE_MAX_LENGTH = 128;

/** Whether `type` is a custom automation event type (see above). */
export function isCustomEventType(type: string): boolean {
  return type.length <= CUSTOM_EVENT_TYPE_MAX_LENGTH && CUSTOM_EVENT_TYPE.test(type);
}

/**
 * The type a `system_event` action will emit, from its params: its own `type`
 * when that is a non-empty string, the default otherwise — exactly what the
 * action itself reads.
 */
export function systemEventTypeOf(params: Readonly<Record<string, unknown>>): string {
  const value = params['type'];
  if (typeof value !== 'string') return CUSTOM_EVENT_TYPE_ROOT;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : CUSTOM_EVENT_TYPE_ROOT;
}

/** The refusal, as the save and the run both word it. Names no part of the type. */
export const CUSTOM_EVENT_TYPE_RULE =
  'a rule may emit only its own events: "automation.custom", or a type that starts with "automation.custom."';
