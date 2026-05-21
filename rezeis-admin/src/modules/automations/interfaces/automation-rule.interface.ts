import {
  AutomationExecutionStatus,
  AutomationTriggerKind,
} from '@prisma/client';

import { AutomationActionDefinition, AutomationActionResult } from './automation-action.interface';
import { LogicExpression } from '../utils/expression-evaluator';

/**
 * Public projection of an `AutomationRule` row. The frontend rule editor
 * round-trips this shape, so any new field MUST be additive (the editor
 * preserves unknown fields verbatim).
 */
export interface AutomationRuleInterface {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isEnabled: boolean;
  readonly triggerKind: AutomationTriggerKind;
  readonly triggerSpec: string;
  readonly conditions: LogicExpression | null;
  readonly actions: readonly AutomationActionDefinition[];
  readonly createdById: string | null;
  readonly lastRunAt: string | null;
  readonly lastRunStatus: AutomationExecutionStatus | null;
  readonly lastRunMessage: string | null;
  readonly runCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Public projection of `AutomationExecution` row. */
export interface AutomationExecutionInterface {
  readonly id: string;
  readonly ruleId: string;
  readonly status: AutomationExecutionStatus;
  readonly trigger: string;
  readonly triggerPayload: Readonly<Record<string, unknown>>;
  readonly actionResults: readonly AutomationActionResult[];
  readonly errorMessage: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly createdAt: string;
}

export interface ListExecutionsResult {
  readonly items: readonly AutomationExecutionInterface[];
  readonly nextCursor: string | null;
}
