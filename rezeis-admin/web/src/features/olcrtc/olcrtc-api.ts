import api from '@/lib/api'

export type OlcrtcProvider = 'JITSI' | 'TELEMOST' | 'WBSTREAM'
export type OlcrtcTransport = 'VP8CHANNEL' | 'DATACHANNEL' | 'SEICHANNEL' | 'VIDEOCHANNEL'
export type OlcrtcGatewayStatus = 'ACTIVE' | 'DRAINING' | 'DISABLED' | 'UNHEALTHY'
export type OlcrtcRoomStatus = 'CREATING' | 'READY' | 'IN_USE' | 'EXPIRED' | 'INVALID' | 'DELETING' | 'DELETED'
export type OlcrtcSessionStatus = 'PROVISIONING' | 'PENDING_AGENT' | 'STARTING' | 'ACTIVE' | 'IDLE' | 'STOPPING' | 'STOPPED' | 'FAILED' | 'EXPIRED'

export interface OlcrtcProviderAccount {
  readonly id: string
  readonly provider: OlcrtcProvider
  readonly name: string
  readonly credentialHint: string | null
  readonly isEnabled: boolean
  readonly lastValidatedAt: string | null
  readonly lastValidationError: string | null
  readonly metadata: unknown
  readonly createdAt: string
  readonly updatedAt: string
}

export interface OlcrtcProfile {
  readonly id: string
  readonly name: string
  readonly provider: OlcrtcProvider
  readonly transport: OlcrtcTransport
  readonly providerAccountId: string | null
  readonly roomTemplate: string | null
  readonly transportOptions: unknown
  readonly priority: number
  readonly isEnabled: boolean
  readonly metadata: unknown
  readonly createdAt: string
}

export interface OlcrtcGateway {
  readonly id: string
  readonly name: string
  readonly status: OlcrtcGatewayStatus
  readonly capacity: number
  readonly activeSessions: number
  readonly lastSeenAt: string | null
  readonly version: string | null
}

export interface OlcrtcRoom {
  readonly id: string
  readonly provider: OlcrtcProvider
  readonly status: OlcrtcRoomStatus
  readonly externalRoomId: string
  readonly externalUrl: string | null
  readonly leaseSessionId: string | null
  readonly expiresAt: string | null
  readonly createdAt: string
}

export interface OlcrtcSession {
  readonly id: string
  readonly userId: string
  readonly subscriptionId: string
  readonly profileId: string
  readonly gatewayId: string | null
  readonly status: OlcrtcSessionStatus
  readonly provider: OlcrtcProvider
  readonly transport: string
  readonly agentSessionId: string | null
  readonly lastError: string | null
  readonly startedAt: string | null
  readonly expiresAt: string | null
  readonly lastSeenAt: string | null
  readonly stoppedAt: string | null
  readonly createdAt: string
}

export interface OlcrtcOverview {
  readonly providerAccounts: readonly OlcrtcProviderAccount[]
  readonly profiles: readonly OlcrtcProfile[]
  readonly gateways: readonly OlcrtcGateway[]
  readonly rooms: readonly OlcrtcRoom[]
  readonly sessions: readonly OlcrtcSession[]
  readonly counts: Record<string, number>
}

export interface OlcrtcLifecycleResult {
  readonly staleGateways: number
  readonly expiredSessions: number
  readonly stuckSessions: number
  readonly expiredRooms: number
}

export interface OlcrtcTrafficLedgerItem {
  readonly id: string
  readonly sessionId: string
  readonly rxBytes: string
  readonly txBytes: string
  readonly source: string
  readonly observedAt: string
  readonly idempotencyKey: string | null
  readonly metadata: unknown
  readonly createdAt: string
}

export interface OlcrtcTrafficLedgerResponse {
  readonly items: readonly OlcrtcTrafficLedgerItem[]
}

export interface OlcrtcTrafficLedgerQuery {
  readonly sessionId?: string
  readonly take?: number
}

export interface CreateProviderAccountInput {
  readonly provider: OlcrtcProvider
  readonly name: string
  readonly credentials?: Record<string, unknown>
  readonly credentialHint?: string | null
  readonly isEnabled?: boolean
  readonly metadata?: Record<string, unknown>
}

export interface UpdateProviderAccountInput {
  readonly provider?: OlcrtcProvider
  readonly name?: string
  readonly credentials?: Record<string, unknown> | null
  readonly credentialHint?: string | null
  readonly isEnabled?: boolean
  readonly metadata?: Record<string, unknown>
}

export interface CreateProfileInput {
  readonly name: string
  readonly provider: OlcrtcProvider
  readonly transport: OlcrtcTransport
  readonly providerAccountId?: string | null
  readonly roomTemplate?: string | null
  readonly transportOptions?: Record<string, unknown>
  readonly priority?: number
  readonly isEnabled?: boolean
  readonly metadata?: Record<string, unknown>
}

export interface UpdateProfileInput {
  readonly name?: string
  readonly provider?: OlcrtcProvider
  readonly transport?: OlcrtcTransport
  readonly providerAccountId?: string | null
  readonly roomTemplate?: string | null
  readonly transportOptions?: Record<string, unknown>
  readonly priority?: number
  readonly isEnabled?: boolean
  readonly metadata?: Record<string, unknown>
}

export interface UpdateGatewayInput {
  readonly managementUrl?: string
  readonly status?: OlcrtcGatewayStatus
  readonly capacity?: number
  readonly version?: string | null
  readonly health?: Record<string, unknown>
  readonly metadata?: Record<string, unknown>
}

export interface UpdateRoomInput {
  readonly status?: OlcrtcRoomStatus
  readonly leaseSessionId?: string | null
  readonly expiresAt?: string | null
  readonly lastVerifiedAt?: string | null
  readonly metadata?: Record<string, unknown>
}

export interface UpdateSessionInput {
  readonly status?: OlcrtcSessionStatus
  readonly lastError?: string | null
  readonly expiresAt?: string | null
  readonly stoppedAt?: string | null
  readonly metadata?: Record<string, unknown>
}

export const olcrtcApi = {
  async getOverview(): Promise<OlcrtcOverview> {
    const { data } = await api.get<OlcrtcOverview>('/admin/olcrtc/overview')
    return data
  },

  async runLifecycle(): Promise<OlcrtcLifecycleResult> {
    const { data } = await api.post<OlcrtcLifecycleResult>('/admin/olcrtc/lifecycle/run')
    return data
  },

  async listTrafficLedger(query: OlcrtcTrafficLedgerQuery = {}): Promise<OlcrtcTrafficLedgerResponse> {
    const { data } = await api.get<OlcrtcTrafficLedgerResponse>('/admin/olcrtc/traffic', { params: query })
    return data
  },

  async createProviderAccount(input: CreateProviderAccountInput): Promise<OlcrtcProviderAccount> {
    const { data } = await api.post<OlcrtcProviderAccount>('/admin/olcrtc/provider-accounts', input)
    return data
  },

  async updateProviderAccount(id: string, input: UpdateProviderAccountInput): Promise<OlcrtcProviderAccount> {
    const { data } = await api.patch<OlcrtcProviderAccount>(`/admin/olcrtc/provider-accounts/${id}`, input)
    return data
  },

  async createProfile(input: CreateProfileInput): Promise<OlcrtcProfile> {
    const { data } = await api.post<OlcrtcProfile>('/admin/olcrtc/profiles', input)
    return data
  },

  async updateProfile(id: string, input: UpdateProfileInput): Promise<OlcrtcProfile> {
    const { data } = await api.patch<OlcrtcProfile>(`/admin/olcrtc/profiles/${id}`, input)
    return data
  },

  async updateGateway(id: string, input: UpdateGatewayInput): Promise<OlcrtcGateway> {
    const { data } = await api.patch<OlcrtcGateway>(`/admin/olcrtc/gateways/${id}`, input)
    return data
  },

  async updateRoom(id: string, input: UpdateRoomInput): Promise<OlcrtcRoom> {
    const { data } = await api.patch<OlcrtcRoom>(`/admin/olcrtc/rooms/${id}`, input)
    return data
  },

  async updateSession(id: string, input: UpdateSessionInput): Promise<OlcrtcSession> {
    const { data } = await api.patch<OlcrtcSession>(`/admin/olcrtc/sessions/${id}`, input)
    return data
  },
}
