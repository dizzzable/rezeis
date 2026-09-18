import type { AutomationActionResultDetails } from '../interfaces/automation-action.interface';

/**
 * Every code an action result can carry.
 *
 * The SPA words a result from its code, so a code is a contract with a screen
 * and a typo in one is an untranslated sentence in front of an operator. A
 * union makes that typo a compile error here instead. The result itself keeps
 * `code?: string`, because rows written before a code existed — or by a newer
 * panel — still have to be readable.
 */
export type AutomationActionResultCode =
  // show_hint
  | 'hint_queued'
  | 'hint_already_delivered'
  | 'hint_inactive'
  | 'hint_missing'
  | 'hint_key_missing'
  | 'customer_missing'
  | 'customer_not_found'
  // show_hint_to_audience (it shares `hint_key_missing`, `hint_missing` and `hint_inactive`)
  | 'audience_queued'
  | 'audience_partial'
  | 'audience_empty'
  | 'audience_blind';

/**
 * What a handler answers when it did not fail.
 *
 * A bare string is still an answer — a success with no code — and every
 * handler with nothing to name keeps returning one. This is for the two things
 * a string cannot say: that the action stood aside rather than acted
 * (`skipped`), and which named outcome it was.
 */
export interface ActionHandlerOutcome {
  readonly status: 'success' | 'skipped';
  readonly message: string;
  readonly code?: AutomationActionResultCode;
  readonly details?: AutomationActionResultDetails;
}

/** The action did what it is for. */
export function actionSucceeded(
  message: string,
  code: AutomationActionResultCode,
  details?: AutomationActionResultDetails,
): ActionHandlerOutcome {
  return { status: 'success', message, code, ...(details === undefined ? {} : { details }) };
}

/**
 * The action stood aside, and that is not a failure: nothing is wrong that a
 * retry or an edit would fix. A run whose every action stood aside is graded
 * SKIPPED rather than SUCCEEDED, so the operator is not shown green for a run
 * that reached nobody.
 */
export function actionSkipped(
  message: string,
  code: AutomationActionResultCode,
  details?: AutomationActionResultDetails,
): ActionHandlerOutcome {
  return { status: 'skipped', message, code, ...(details === undefined ? {} : { details }) };
}

/**
 * A failure with a name.
 *
 * THROWN, like every other failure a handler has. `execute()` already turns
 * anything thrown into a failed result — a refusal written on purpose and a
 * downstream call that blew up part-way land in the same place — and this one
 * additionally carries its code and details onto that result. A plain `Error`
 * still fails the action, just without a code.
 */
export class ActionFailure extends Error {
  public constructor(
    message: string,
    public readonly code: AutomationActionResultCode,
    public readonly details?: AutomationActionResultDetails,
  ) {
    super(message);
    this.name = 'ActionFailure';
  }
}
