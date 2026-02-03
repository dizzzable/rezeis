import apiClient from './client';

export interface ServerStats {
    id: string;
    uuid: string;
    name: string;
    address: string;
    port: number | null;
    countryCode: string;
    tags: string[];
    isConnected: boolean;
    isDisabled: boolean;
    usersOnline: number;
    trafficUsedBytes: number;
    trafficLimitBytes: number | null;
    loadPercentage: number;
    lastUpdated: string;
}

export interface MonitoringOverview {
    totalServers: number;
    onlineServers: number;
    offlineServers: number;
    totalUsersOnline: number;
    averageLoadPercentage: number;
    lastUpdated: string;
}

export interface ServerHistoryPoint {
    timestamp: string;
    usersOnline: number;
    trafficUsedBytes: number;
    loadPercentage: number;
}

export interface ServerRecommendation {
    serverId: string;
    serverName: string;
    countryCode: string;
    reason: string;
    score: number;
    usersOnline: number;
    loadPercentage: number;
}

export interface WebSocketInfo {
    websocketEndpoint: string;
    messageTypes: string[];
    updateInterval: number;
}

class MonitoringService {
    // Get all servers statistics
    async getServersStats(): Promise<{ success: boolean; data: ServerStats[] }> {
        const response = await apiClient.get('/monitoring/servers');
        return response.data;
    }

    // Get monitoring overview
    async getOverview(): Promise<{ success: boolean; data: MonitoringOverview }> {
        const response = await apiClient.get('/monitoring/overview');
        return response.data;
    }

    // Get specific server details
    async getServerDetails(id: string): Promise<{ success: boolean; data: ServerStats }> {
        const response = await apiClient.get(`/monitoring/servers/${id}`);
        return response.data;
    }

    // Get server history
    async getServerHistory(id: string): Promise<{ success: boolean; data: ServerHistoryPoint[] }> {
        const response = await apiClient.get(`/monitoring/servers/${id}/history`);
        return response.data;
    }

    // Get recommended server
    async getRecommendedServer(): Promise<{ success: boolean; data: ServerRecommendation }> {
        const response = await apiClient.get('/monitoring/servers/recommended');
        return response.data;
    }

    // Get servers ranking (sorted by load)
    async getServersRanking(): Promise<{ success: boolean; data: ServerStats[] }> {
        const response = await apiClient.get('/monitoring/servers/ranking');
        return response.data;
    }

    // Force refresh server data
    async forceRefresh(): Promise<{ success: boolean; data: ServerStats[]; message: string }> {
        const response = await apiClient.post('/monitoring/refresh');
        return response.data;
    }

    // Get WebSocket connection info
    async getWebSocketInfo(): Promise<{ success: boolean; data: WebSocketInfo }> {
        const response = await apiClient.get('/monitoring/websocket-info');
        return response.data;
    }
}

export const monitoringService = new MonitoringService();
