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

/**
 * The values a result's `code` needs to be worded — a hint key, a customer id,
 * a count.
 *
 * Scalars only: a result is stored in a JSON column and read back by clients of
 * every age, and the SPA interpolates each value straight into a sentence.
 */
export type AutomationActionResultDetails = Readonly<
  Record<string, string | number | boolean | null>
>;

/** Result of executing one action — recorded on the execution row. */
export interface AutomationActionResult {
  readonly index: number;
  readonly type: AutomationActionType;
  readonly status: 'success' | 'failed' | 'skipped';
  /** English, for logs and for clients that predate `code`. */
  readonly message?: string;
  /**
   * Which named outcome this was, for the SPA to word in the operator's
   * language. Absent on action types that name none, and on every row written
   * before codes existed — a reader falls back to `message`.
   */
  readonly code?: string;
  /** What that wording needs. Present only beside a `code`. */
  readonly details?: AutomationActionResultDetails;
}

/**
 * An operator pressed «Запустить сейчас».
 *
 * On the context rather than in `triggerData`, and that is the whole point of
 * it: `triggerData` is a payload — an event's, or whatever an API caller put in
 * the run body — so anything read from it can be supplied by whoever shapes
 * that payload. This is set in exactly one place, `runManually`, and a queued
 * job cannot carry it.
 */
export interface AutomationManualRun {
  /** The admin who started the run, or `null` when none is known. */
  readonly adminId: string | null;
  /**
   * Queue a `show_hint` again for a customer who already has a delivery of a
   * hint that does not repeat. For this run only.
   */
  readonly showAgain: boolean;
  /**
   * The address the run was requested from, resolved the way `BlockedIpGuard`
   * resolves it. `block_ip` refuses to block it — the manual blocklist screen's
   * own self-lockout check, carried to the one other place an operator chooses
   * an address by hand. Absent or `null` when it could not be derived.
   */
  readonly requestIp?: string | null;
}

/**
 * Inputs handed to an action handler. The `triggerData` object is a
 * shallow projection of the trigger payload (event metadata, cron tick
 * info, the body of a manual run).
 */
export interface AutomationActionContext {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly trigger: string;
  readonly triggerData: Readonly<Record<string, unknown>>;
  /** Present only on a manual run. Absent on every automatic one. */
  readonly manual?: AutomationManualRun;
}
