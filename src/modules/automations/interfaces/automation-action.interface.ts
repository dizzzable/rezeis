import { AutomationActionType } from '../automations.constants';

/**
 * Single action declaration inside `AutomationRule.actions`.
 *
 * Action params are loosely typed on purpose — every action handler
 * validates its own slice. We intentionally store the raw declarations
 * on the rule so the editor can roundtrip them without losing fields it
 * doesn't understand yet.
 */
export interface AutomationActionDefinition {
  readonly type: AutomationActionType;
  readonly params: Readonly<Record<string, unknown>>;
}

/** Result of executing one action — recorded on the execution row. */
export interface AutomationActionResult {
  readonly index: number;
  readonly type: AutomationActionType;
  readonly status: 'success' | 'failed' | 'skipped';
  readonly message?: string;
}

/**
 * Inputs handed to an action handler. The `triggerData` object is a
 * shallow projection of the trigger payload (event metadata, cron tick
 * info, manual-run admin id).
 */
export interface AutomationActionContext {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly trigger: string;
  readonly triggerData: Readonly<Record<string, unknown>>;
}
