/**
 * Stable identifiers for the Automations module.
 *
 * The queue name lives here so processors and the queue service stay
 * loosely coupled; the action-type strings are the canonical names the
 * rule engine understands and the frontend exposes in its rule editor.
 */

export const AUTOMATION_QUEUE = 'automation-execution';

export const AUTOMATION_JOB_NAMES = {
  EXECUTE_RULE: 'execute-rule',
} as const;

/** Built-in action types supported by the engine. */
export const AUTOMATION_ACTION_TYPES = [
  'notify_telegram',
  'webhook_post',
  'block_ip',
  'system_event',
  'block_user',
] as const;

export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

/** Maximum size of the trigger payload retained on `automation_executions`. */
export const AUTOMATION_PAYLOAD_TRUNCATE_BYTES = 8 * 1024;

/** Hard cap on how many rules can be evaluated against a single event. */
export const AUTOMATION_RULES_PER_EVENT_LIMIT = 64;
