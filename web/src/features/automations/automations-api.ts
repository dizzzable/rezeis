import { api } from '@/lib/api';

export type AutomationTriggerKind = 'REALTIME' | 'CRON' | 'MANUAL';
export type AutomationExecutionStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
export type AutomationActionType =
  | 'notify_telegram'
  | 'webhook_post'
  | 'block_ip'
  | 'system_event'
  | 'block_user';

export interface AutomationActionDef {
  type: AutomationActionType | string;
  params: Record<string, unknown>;
}

export interface AutomationActionResult {
  index: number;
  type: string;
  status: 'success' | 'failed' | 'skipped';
  message?: string;
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

export async function getCatalog(): Promise<{ actionTypes: AutomationActionType[] }> {
  const res = await api.get(`${BASE}/catalog`);
  return res.data;
}

export async function listRules(): Promise<AutomationRule[]> {
  const res = await api.get<AutomationRule[]>(`${BASE}/rules`);
  return res.data;
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

export async function runRuleManually(
  id: string,
  triggerData: Record<string, unknown> = {},
): Promise<{
  executionId: string;
  status: string;
  actionResults: AutomationActionResult[];
  errorMessage: string | null;
}> {
  const res = await api.post(`${BASE}/rules/${id}/run`, { triggerData });
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
