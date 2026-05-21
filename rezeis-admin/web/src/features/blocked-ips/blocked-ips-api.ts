import { api } from '@/lib/api';

export interface BlockedIp {
  id: string;
  address: string;
  reason: string | null;
  source: string;
  createdById: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListBlockedIpsResponse {
  items: BlockedIp[];
  total: number;
  limit: number;
  offset: number;
}

const BASE = '/admin/blocked-ips';

export async function listBlockedIps(params: { limit?: number; offset?: number } = {}): Promise<ListBlockedIpsResponse> {
  const res = await api.get<ListBlockedIpsResponse>(BASE, { params });
  return res.data;
}

export async function createBlockedIp(payload: {
  address: string;
  reason?: string;
  expiresAt?: string;
}): Promise<BlockedIp> {
  const res = await api.post<BlockedIp>(BASE, payload);
  return res.data;
}

export async function updateBlockedIp(id: string, payload: { reason?: string; expiresAt?: string | null }): Promise<BlockedIp> {
  const res = await api.patch<BlockedIp>(`${BASE}/${id}`, payload);
  return res.data;
}

export async function deleteBlockedIp(id: string): Promise<void> {
  await api.delete(`${BASE}/${id}`);
}
