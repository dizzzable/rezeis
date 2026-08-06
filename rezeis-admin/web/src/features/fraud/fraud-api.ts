import { api } from '@/lib/api';

export type FraudSeverity = 'LOW' | 'MEDIUM' | 'HIGH';
export type FraudStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'DISMISSED';

export interface FraudSignal {
  id: string;
  code: string;
  severity: FraudSeverity;
  status: FraudStatus;
  title: string;
  description: string;
  score: number;
  confidence: number;
  affectedUserIds: string[];
  metadata: Record<string, unknown>;
  lastAction: string;
  detectedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListFraudSignalsResponse {
  items: FraudSignal[];
  nextCursor: string | null;
}

export interface FraudStats {
  open: number;
  acknowledged: number;
  resolved: number;
  dismissed: number;
  bySeverity: { LOW: number; MEDIUM: number; HIGH: number };
}

const BASE = '/admin/fraud';

export interface ListFraudSignalsParams {
  status?: FraudStatus;
  severity?: FraudSeverity;
  code?: string;
  limit?: number;
  cursor?: string;
}

export async function listFraudSignals(
  params: ListFraudSignalsParams = {},
): Promise<ListFraudSignalsResponse> {
  const res = await api.get<ListFraudSignalsResponse>(`${BASE}/signals`, { params });
  return res.data;
}

export async function getFraudStats(): Promise<FraudStats> {
  const res = await api.get<FraudStats>(`${BASE}/stats`);
  return res.data;
}

export interface FraudTrendPoint {
  date: string;
  high: number;
  medium: number;
  low: number;
}

export async function getFraudTrend(days = 14): Promise<FraudTrendPoint[]> {
  const res = await api.get<FraudTrendPoint[]>(`${BASE}/trend`, { params: { days } });
  return res.data;
}

export interface FraudSharingOffender {
  signalId: string;
  code: string;
  severity: FraudSeverity;
  kind: 'hwid_overage' | 'ip_sharing';
  count: number;
  deviceLimit: number;
  remnawaveUuid: string | null;
  affectedUserIds: string[];
  telegramId: string | null;
  score: number;
}

export async function getFraudTopOffenders(limit = 10): Promise<FraudSharingOffender[]> {
  const res = await api.get<FraudSharingOffender[]>(`${BASE}/top-offenders`, { params: { limit } });
  return res.data;
}

export async function transitionFraudSignal(
  id: string,
  payload: { status: Exclude<FraudStatus, 'OPEN'>; note?: string },
): Promise<FraudSignal> {
  const res = await api.post<FraudSignal>(`${BASE}/signals/${id}/transition`, payload);
  return res.data;
}

export async function runFraudDetectors(): Promise<{ ok: true; processed: number }> {
  const res = await api.post<{ ok: true; processed: number }>(`${BASE}/detectors/run`);
  return res.data;
}

export interface FraudEnforceResult {
  ok: boolean;
  dropped: { by: string; count: number };
}

/** Drops a flagged signal's live connections (by user, default, or by IP). */
export async function enforceDropConnections(
  signalId: string,
  payload: { mode?: 'user' | 'ip' } = {},
): Promise<FraudEnforceResult> {
  const res = await api.post<FraudEnforceResult>(`${BASE}/signals/${signalId}/enforce`, payload);
  return res.data;
}

// ── Held candidates & exemptions ─────────────────────────────────────────

/**
 * A condition a detector produced that did NOT become a signal — either still
 * gathering the consecutive observations the gate requires, or covered by an
 * operator exemption. The point of surfacing it is that a suppression which
 * leaves no trace is indistinguishable from a detector that quietly stopped.
 */
export interface PendingFraudCandidate {
  id: string;
  code: string;
  conditionKey: string;
  observations: number;
  requiredObservations: number;
  severity: FraudSeverity;
  lastSeverity: FraudSeverity;
  score: number;
  title: string;
  affectedUserIds: string[];
  heldBy: 'streak' | 'exemption';
  exemptionId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface FraudExemption {
  id: string;
  userId: string;
  codes: string[];
  reason: string;
  expiresAt: string;
  createdBy: string | null;
  createdByLogin: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  createdAt: string;
  active: boolean;
}

export async function getPendingFraudCandidates(limit = 50): Promise<PendingFraudCandidate[]> {
  const res = await api.get<PendingFraudCandidate[]>(`${BASE}/pending`, { params: { limit } });
  return res.data;
}

export async function listFraudExemptions(
  params: { userId?: string; activeOnly?: boolean } = {},
): Promise<FraudExemption[]> {
  const res = await api.get<FraudExemption[]>(`${BASE}/exemptions`, { params });
  return res.data;
}

/** `expiresAt` is an ISO date — the API rejects a missing or past one. */
export async function createFraudExemption(payload: {
  userId: string;
  codes: string[];
  reason: string;
  expiresAt: string;
}): Promise<FraudExemption> {
  const res = await api.post<FraudExemption>(`${BASE}/exemptions`, payload);
  return res.data;
}

export async function revokeFraudExemption(id: string): Promise<FraudExemption> {
  const res = await api.post<FraudExemption>(`${BASE}/exemptions/${id}/revoke`);
  return res.data;
}

/**
 * The detector codes an exemption may name.
 *
 * MUST list every code in `AntiFraudService.runDetectors`'s plan. This is the
 * only place an operator can pick a code, so a registered detector missing from
 * here is one nobody can ever clear a customer of — the same "built, but the
 * operator cannot reach it" shape the detector registry itself has repeatedly
 * shipped. `test/anti-fraud-module-wiring.spec.ts` holds this list against the
 * run plan.
 *
 * Only the four `observational` ones are gated by sustained evidence, but an
 * exemption is meaningful for any code — a user cleared of promocode abuse
 * should stop being re-flagged for it too, so the full detector set is offered.
 */
export const FRAUD_DETECTOR_CODES = [
  'SUBSCRIPTION_SHARING_HWID',
  'SUBSCRIPTION_SHARING_IP',
  'SUBSCRIPTION_UA_TUNNEL',
  'NODE_TRAFFIC_USER_ABUSE',
  'EXCESSIVE_FAILED_PAYMENTS',
  'RAPID_REFERRAL_VELOCITY',
  'PROMO_ABUSE',
  'RAPID_CHURN',
] as const;

// ── Detector accuracy (read-only feedback loop) ─────────────────────────────

/**
 * One detector code's record over the reporting window.
 *
 * `resolved` is the whole RESOLVED bucket; `operatorResolved` and `autoResolved`
 * split it by whether a named admin or the detector run itself closed the row,
 * and only the former is a human verdict. `dismissed` is the operator pressing
 * "Dismiss — false positive".
 */
export interface DetectorAccuracyRow {
  code: string;
  total: number;
  open: number;
  acknowledged: number;
  resolved: number;
  operatorResolved: number;
  autoResolved: number;
  dismissed: number;
  systemDismissed: number;
  /** `dismissed + operatorResolved` — the denominator of the rate. */
  adjudicated: number;
  /** `null` when `adjudicated` is under `minAdjudicatedForRate`. Never confuse with `0`. */
  falsePositiveRate: number | null;
}

export interface DetectorAccuracyReport {
  windowDays: number;
  since: string;
  until: string;
  minAdjudicatedForRate: number;
  rows: DetectorAccuracyRow[];
}

export async function getDetectorAccuracy(days = 30): Promise<DetectorAccuracyReport> {
  const res = await api.get<DetectorAccuracyReport>(`${BASE}/detector-accuracy`, {
    params: { days },
  });
  return res.data;
}

export interface SignalLiveIpNode {
  nodeUuid: string;
  nodeName: string;
  countryCode: string | null;
  ips: Array<{ ip: string; lastSeen: string }>;
}

/** Live per-node source IPs for a signal's user (ip-control drilldown). */
export async function getSignalLiveIps(signalId: string): Promise<SignalLiveIpNode[]> {
  const res = await api.get<SignalLiveIpNode[]>(`${BASE}/signals/${signalId}/live-ips`);
  return res.data;
}
