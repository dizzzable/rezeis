import { buildInternalSignature, INTERNAL_SIGNATURE_HEADER, INTERNAL_TIMESTAMP_HEADER } from '../common/http/internal-signature.util';

export interface InternalClientOptions {
  readonly baseUrl: string;
  readonly apiToken: string;
  readonly sharedSecret?: string;
}

export interface OlcrtcClaimedSession {
  readonly sessionId: string;
  readonly agentSessionId: string;
  readonly userId: string;
  readonly subscriptionId: string;
  readonly profileId: string;
  readonly provider: string;
  readonly transport: string;
  readonly cryptoKey: string;
  readonly subscriptionUri: string | null;
  readonly room: null | {
    readonly id: string;
    readonly externalRoomId: string;
    readonly externalUrl: string | null;
  };
  readonly expiresAt: string | null;
}

export class OlcrtcInternalClient {
  public constructor(private readonly options: InternalClientOptions) {}

  public heartbeat(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post<Record<string, unknown>>('/api/internal/olcrtc/gateways/heartbeat', input);
  }

  public claim(gatewayName: string): Promise<OlcrtcClaimedSession | null> {
    return this.post<OlcrtcClaimedSession | null>('/api/internal/olcrtc/sessions/claim', { gatewayName });
  }

  public report(sessionId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post<Record<string, unknown>>(`/api/internal/olcrtc/sessions/${encodeURIComponent(sessionId)}/report`, input);
  }

  public traffic(sessionId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post<Record<string, unknown>>(`/api/internal/olcrtc/sessions/${encodeURIComponent(sessionId)}/traffic`, input);
  }

  private async post<T>(path: string, input: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify(input);
    const response = await fetch(new URL(path, normalizedBaseUrl(this.options.baseUrl)), {
      method: 'POST',
      headers: buildInternalRequestHeaders({
        apiToken: this.options.apiToken,
        sharedSecret: this.options.sharedSecret,
        method: 'POST',
        path,
        body,
      }),
      body,
    });
    if (!response.ok) {
      const message = await response.text().catch(() => '');
      throw new Error(`OLCRTC internal API ${response.status} ${response.statusText}${message ? `: ${message}` : ''}`);
    }
    if (response.status === 204) return null as T;
    return await response.json() as T;
  }
}

export function buildInternalRequestHeaders(input: {
  readonly apiToken: string;
  readonly sharedSecret?: string;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly nowMs?: number;
}): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.apiToken}`,
    'content-type': 'application/json',
  };
  if (input.sharedSecret && input.sharedSecret.length > 0) {
    const timestamp = String(input.nowMs ?? Date.now());
    headers[INTERNAL_TIMESTAMP_HEADER] = timestamp;
    headers[INTERNAL_SIGNATURE_HEADER] = buildInternalSignature({
      secret: input.sharedSecret,
      method: input.method,
      path: input.path,
      body: input.body,
      timestamp,
    });
  }
  return headers;
}

function normalizedBaseUrl(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
