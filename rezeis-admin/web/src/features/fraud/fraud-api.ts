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
