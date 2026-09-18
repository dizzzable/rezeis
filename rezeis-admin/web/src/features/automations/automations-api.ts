import { api } from '@/lib/api';
import { expectArray } from '@/lib/api-utils';

export type AutomationTriggerKind = 'REALTIME' | 'CRON' | 'MANUAL';
export type AutomationExecutionStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
export type AutomationActionType =
  | 'notify_telegram'
  | 'webhook_post'
  | 'block_ip'
  | 'system_event'
  | 'block_user'
  | 'show_hint'
  | 'show_hint_to_audience';

export interface AutomationActionDef {
  type: AutomationActionType | string;
  params: Record<string, unknown>;
}

export interface AutomationActionResult {
  index: number;
  type: string;
  status: 'success' | 'failed' | 'skipped';
  /** English, for logs and older clients. The operator is shown `code` when there is one. */
  message?: string;
  /**
   * What happened, as a stable token the panel words in the operator's
   * language (`run-result-copy.ts`). Absent on rows written before codes
   * existed and on action types that carry none.
   */
  code?: string;
  /** The values the sentence for `code` names: `hintKey`, `userId`, `audience`, … */
  details?: Record<string, string | number | boolean | null>;
}

/** The answer to a manual run. */
export interface ManualRunResult {
  executionId: string;
  status: string;
  actionResults: AutomationActionResult[];
  errorMessage: string | null;
}

export interface AutomationRule {
  id: string;
  name: string;
  description: string | null;
  isEnabled: boolean;
  triggerKind: AutomationTriggerKind;
  triggerSpec: string;
  conditions: unknown | null;
  actions: AutomationActionDef[];
  createdById: string | null;
  lastRunAt: string | null;
  lastRunStatus: AutomationExecutionStatus | null;
  lastRunMessage: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationExecution {
  id: string;
  ruleId: string;
  status: AutomationExecutionStatus;
  trigger: string;
  triggerPayload: Record<string, unknown>;
  actionResults: AutomationActionResult[];
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  createdAt: string;
}

const BASE = '/admin/automations';

export interface UpsertRulePayload {
  name: string;
  description?: string;
  isEnabled?: boolean;
  triggerKind: AutomationTriggerKind;
  triggerSpec: string;
  conditions?: unknown;
  actions: AutomationActionDef[];
}

export interface AutomationCatalog {
  actionTypes: AutomationActionType[]
  /**
   * Sets of events that arrive together as one act by one customer, e.g. a
   * purchase emitting `payment.completed`, `subscription.created` and
   * `referral.qualified` within a second. Served by the panel rather than
   * duplicated here: it is knowledge about this product's flows, and a second
   * copy would be a second thing to update when a flow changes.
   */
  coincidentEventGroups: string[][]
  /**
   * What each action type needs on top of the automations permissions — the
   * very map the panel enforces on a save, on switching a rule on and on «Run
   * now» (`automation-action-permissions.ts`). Absent from a panel older than
   * that map, and then nothing is greyed out: the server still refuses.
   */
  actionPermissions?: Record<string, ReadonlyArray<{ resource: string; action: string }>>
}

export async function getCatalog(): Promise<AutomationCatalog> {
  const res = await api.get(`${BASE}/catalog`);
  return res.data;
}

export async function listRules(): Promise<AutomationRule[]> {
  const res = await api.get(`${BASE}/rules`);
  return expectArray<AutomationRule>(res.data);
}

export async function getRule(id: string): Promise<AutomationRule> {
  const res = await api.get<AutomationRule>(`${BASE}/rules/${id}`);
  return res.data;
}

export async function createRule(payload: UpsertRulePayload): Promise<AutomationRule> {
  const res = await api.post<AutomationRule>(`${BASE}/rules`, payload);
  return res.data;
}

export async function updateRule(id: string, payload: UpsertRulePayload): Promise<AutomationRule> {
  const res = await api.put<AutomationRule>(`${BASE}/rules/${id}`, payload);
  return res.data;
}

export async function toggleRule(id: string, isEnabled: boolean): Promise<AutomationRule> {
  const res = await api.patch<AutomationRule>(`${BASE}/rules/${id}/toggle`, { isEnabled });
  return res.data;
}

export async function deleteRule(id: string): Promise<void> {
  await api.delete(`${BASE}/rules/${id}`);
}

/**
 * How long a manual run is waited for.
 *
 * A run executes every action of the rule inside the request — a webhook, an
 * audience of up to five hundred — and the client default is thirty seconds.
 * The panel gives this route the same two minutes (its long-timeout list), so
 * the browser giving up first would report as failed a run that is still going.
 */
export const MANUAL_RUN_TIMEOUT_MS = 120_000;

/**
 * Runs a rule now, whatever its switch says.
 *
 * `triggerData.userId` names the customer the run is about. `showAgain` lets a
 * `show_hint` action queue a once-only hint for a customer who already had it —
 * for THIS run only. It travels beside `triggerData`, never inside it: the
 * server reads it from the body alone, so no event payload can carry it.
 *
 * Sent only when the caller decided it. An absent field and `false` mean the
 * same to the server today, but a body that always names it would put a
 * decision in every request nobody made.
 */
export async function runRuleManually(
  id: string,
  triggerData: Record<string, unknown> = {},
  options: { readonly showAgain?: boolean } = {},
): Promise<ManualRunResult> {
  const body: { triggerData: Record<string, unknown>; showAgain?: boolean } = { triggerData };
  if (options.showAgain !== undefined) body.showAgain = options.showAgain;
  const res = await api.post<ManualRunResult>(`${BASE}/rules/${id}/run`, body, {
    timeout: MANUAL_RUN_TIMEOUT_MS,
  });
  return res.data;
}

export async function listExecutions(
  ruleId: string | null,
  params: { limit?: number; cursor?: string } = {},
): Promise<{ items: AutomationExecution[]; nextCursor: string | null }> {
  const url = ruleId === null ? `${BASE}/executions` : `${BASE}/rules/${ruleId}/executions`;
  const res = await api.get(url, { params });
  return res.data;
}
