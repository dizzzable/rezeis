import { Pool } from 'pg';
import {
    REST_API,
    GetAllNodesCommand,
    GetAllUsersCommand,
    GetUserByUuidCommand,
    GetAllHostsCommand,
    GetUserHwidDevicesCommand,
    GetStatsCommand,
    HostsSchema,
    HwidUserDeviceSchema,
} from '@remnawave/backend-contract';
import type { z } from 'zod';
import {
    getRemnawaveConfig,
    getRemnawaveApiUrl,
    getRemnawaveHeaders,
} from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Remnawave Node type from SDK - using GetAllNodesCommand.Response array element
 */
export type RemnawaveNode = GetAllNodesCommand.Response['response'][number];

/**
 * Remnawave User type from SDK - using GetUserByUuidCommand.Response
 */
export type RemnawaveUser = GetUserByUuidCommand.Response['response'];

/**
 * Extended user type with subscription URL and traffic info from API response
 * Used for getAllUsers response
 */
export type RemnawaveUserExtended = GetAllUsersCommand.Response['response']['users'][number];

/**
 * Remnawave Host type derived from SDK schema
 */
export type RemnawaveHost = z.infer<typeof HostsSchema>;

/**
 * Remnawave HWID Device type derived from SDK schema
 */
export type RemnawaveHwidDevice = z.infer<typeof HwidUserDeviceSchema>;

/**
 * Create user request type
 */
export interface CreateUserRequest {
    username: string;
    trafficLimitBytes: number;
    expireAt: string;
    telegramId?: number;
    hwidDeviceLimit?: number;
}

/**
 * Update user request type
 */
export interface UpdateUserRequest {
    username?: string;
    trafficLimitBytes?: number;
    expireAt?: string;
    status?: 'ACTIVE' | 'DISABLED';
}

/**
 * System stats type from SDK
 */
export type RemnawaveSystemStats = GetStatsCommand.Response['response'];

/**
 * Remnawave API Client using @remnawave/backend-contract
 * Provides typed methods for interacting with Remnawave API
 */
export class RemnawaveService {
    private baseUrl: string;
    private headers: Record<string, string>;

    constructor(_pool?: Pool) {
        getRemnawaveConfig(); // Initialize config
        this.baseUrl = getRemnawaveApiUrl();
        this.headers = getRemnawaveHeaders();
    }

    /**
     * Make authenticated request to Remnawave API using SDK route constants
     */
    private async request<T>(
        endpoint: string,
        options: RequestInit = {}
    ): Promise<T> {
        const url = `${this.baseUrl}${endpoint}`;

        try {
            const response = await fetch(url, {
                ...options,
                headers: {
                    ...this.headers,
                    ...(options.headers || {}),
                },
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Remnawave API error: ${response.status} ${errorText}`);
            }

            // Handle empty responses
            const contentType = response.headers.get('content-type');
            if (contentType?.includes('application/json')) {
                return await response.json() as T;
            }

            return {} as T;
        } catch (error) {
            logger.error({ error, url }, 'Remnawave API request failed');
            throw error;
        }
    }

    // ==================== USER MANAGEMENT ====================

    /**
     * Get all users from Remnawave using SDK route constants
     */
    async getAllUsers(start = 0, size = 100): Promise<RemnawaveUserExtended[]> {
        const url = `${REST_API.USERS.GET}?start=${start}&size=${size}`;
        const response = await this.request<GetAllUsersCommand.Response>(url);
        return response.response.users;
    }

    /**
     * Get user by UUID using SDK route constants
     */
    async getUserByUuid(uuid: string): Promise<GetUserByUuidCommand.Response['response'] | null> {
        try {
            const response = await this.request<GetUserByUuidCommand.Response>(
                REST_API.USERS.GET_BY_UUID(uuid)
            );
            return response.response;
        } catch (error) {
            if ((error as Error).message.includes('404')) {
                return null;
            }
            throw error;
        }
    }

    /**
     * Get users by Telegram ID using SDK route constants
     */
    async getUsersByTelegramId(telegramId: string): Promise<RemnawaveUserExtended[]> {
        const response = await this.request<GetAllUsersCommand.Response>(
            REST_API.USERS.GET_BY.TELEGRAM_ID(telegramId)
        );
        return response.response.users;
    }

    /**
     * Create new user in Remnawave using SDK route constants
     */
    async createUser(data: CreateUserRequest): Promise<GetUserByUuidCommand.Response['response']> {
        const response = await this.request<GetUserByUuidCommand.Response>(REST_API.USERS.CREATE, {
            method: 'POST',
            body: JSON.stringify(data),
        });
        return response.response;
    }

    /**
     * Update user in Remnawave using SDK route constants
     */
    async updateUser(uuid: string, data: UpdateUserRequest): Promise<GetUserByUuidCommand.Response['response']> {
        const response = await this.request<GetUserByUuidCommand.Response>(REST_API.USERS.UPDATE, {
            method: 'PATCH',
            headers: {
                'x-uuid': uuid,
            },
            body: JSON.stringify(data),
        });
        return response.response;
    }

    /**
     * Delete user from Remnawave using SDK route constants
     */
    async deleteUser(uuid: string): Promise<void> {
        await this.request<void>(REST_API.USERS.DELETE(uuid), {
            method: 'DELETE',
        });
    }

    /**
     * Enable user using SDK route constants
     */
    async enableUser(uuid: string): Promise<void> {
        await this.request<void>(REST_API.USERS.ACTIONS.ENABLE(uuid), {
            method: 'POST',
        });
    }

    /**
     * Disable user using SDK route constants
     */
    async disableUser(uuid: string): Promise<void> {
        await this.request<void>(REST_API.USERS.ACTIONS.DISABLE(uuid), {
            method: 'POST',
        });
    }

    /**
     * Reset user traffic using SDK route constants
     */
    async resetUserTraffic(uuid: string): Promise<void> {
        await this.request<void>(REST_API.USERS.ACTIONS.RESET_TRAFFIC(uuid), {
            method: 'POST',
        });
    }

    /**
     * Revoke user subscription using SDK route constants
     */
    async revokeUser(uuid: string): Promise<void> {
        await this.request<void>(REST_API.USERS.ACTIONS.REVOKE_SUBSCRIPTION(uuid), {
            method: 'POST',
        });
    }

    // ==================== HWID DEVICES ====================

    /**
     * Get HWID devices for user using SDK route constants
     */
    async getUserHwidDevices(uuid: string): Promise<RemnawaveHwidDevice[]> {
        const response = await this.request<GetUserHwidDevicesCommand.Response>(
            REST_API.HWID.GET_USER_HWID_DEVICES(uuid)
        );
        return response.response.devices;
    }

    /**
     * Delete HWID device from user using SDK route constants
     */
    async deleteHwidDevice(userUuid: string, hwid: string): Promise<void> {
        await this.request<void>(REST_API.HWID.DELETE_USER_HWID_DEVICE, {
            method: 'POST',
            body: JSON.stringify({ userUuid, hwid }),
        });
    }

    // ==================== SERVERS & NODES ====================

    /**
     * Get all hosts from Remnawave using SDK route constants
     */
    async getAllHosts(): Promise<RemnawaveHost[]> {
        const response = await this.request<GetAllHostsCommand.Response>(REST_API.HOSTS.GET);
        return response.response;
    }

    /**
     * Get all nodes from Remnawave using SDK route constants
     */
    async getAllNodes(): Promise<RemnawaveNode[]> {
        const response = await this.request<GetAllNodesCommand.Response>(REST_API.NODES.GET);
        return response.response;
    }

    /**
     * Get node by UUID using SDK route constants
     */
    async getNodeByUuid(uuid: string): Promise<RemnawaveNode | null> {
        try {
            const response = await this.request<{ response: RemnawaveNode }>(
                REST_API.NODES.GET_BY_UUID(uuid)
            );
            return response.response;
        } catch (error) {
            if ((error as Error).message.includes('404')) {
                return null;
            }
            throw error;
        }
    }

    // ==================== SYSTEM ====================

    /**
     * Get system statistics using SDK route constants
     */
    async getSystemStats(): Promise<RemnawaveSystemStats> {
        const response = await this.request<GetStatsCommand.Response>(
            REST_API.SYSTEM.STATS.SYSTEM_STATS
        );
        return response.response;
    }

    /**
     * Test connection to Remnawave panel
     */
    async testConnection(): Promise<{ success: boolean; message: string }> {
        try {
            const stats = await this.getSystemStats();
            return {
                success: true,
                message: `Connected successfully. CPU: ${stats.cpu.physicalCores} cores, Uptime: ${Math.floor(stats.uptime / 3600)}h`,
            };
        } catch (error) {
            return {
                success: false,
                message: `Connection failed: ${(error as Error).message}`,
            };
        }
    }

    // ==================== WEBHOOK HANDLING ====================

    /**
     * Verify webhook signature
     * @param body Raw request body
     * @param signature Signature from header
     */
    verifyWebhookSignature(body: string, signature: string): boolean {
        const crypto = require('crypto');
        const config = getRemnawaveConfig();

        const expectedSignature = crypto
            .createHmac('sha256', config.webhookSecret)
            .update(body)
            .digest('hex');

        return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
        );
    }

    /**
     * Parse webhook payload
     */
    parseWebhookPayload(body: string): RemnawaveWebhookEvent {
        return JSON.parse(body);
    }
}

/**
 * Webhook event types from Remnawave (using SDK types)
 */
export type RemnawaveWebhookEvent =
    | UserWebhookEvent
    | UserHwidDevicesEvent
    | NodeWebhookEvent;

export interface UserWebhookEvent {
    scope: 'user';
    event:
        | 'user.created'
        | 'user.modified'
        | 'user.deleted'
        | 'user.revoked'
        | 'user.disabled'
        | 'user.enabled'
        | 'user.limited'
        | 'user.expired'
        | 'user.traffic_reset'
        | 'user.expires_in_72_hours'
        | 'user.expires_in_48_hours'
        | 'user.expires_in_24_hours'
        | 'user.expired_24_hours_ago'
        | 'user.first_connected'
        | 'user.bandwidth_usage_threshold_reached'
        | 'user.not_connected';
    timestamp: string;
    data: {
        uuid: string;
        id: number;
        shortUuid: string;
        username: string;
        status?: 'ACTIVE' | 'DISABLED' | 'LIMITED' | 'EXPIRED';
        trafficLimitBytes?: number;
        expireAt: string;
        telegramId: number | null;
        subscriptionUrl: string;
        userTraffic: {
            usedTrafficBytes: number;
            lifetimeUsedTrafficBytes: number;
        };
    };
}

export interface UserHwidDevicesEvent {
    scope: 'user_hwid_devices';
    event: 'user_hwid_devices.added' | 'user_hwid_devices.deleted';
    timestamp: string;
    data: {
        user: {
            uuid: string;
            username: string;
        };
        hwidUserDevice: {
            hwid: string;
            userUuid: string;
        };
    };
}

export interface NodeWebhookEvent {
    scope: 'node';
    event: 'node.created' | 'node.modified' | 'node.disabled' | 'node.enabled' | 'node.deleted' | 'node.connection_lost' | 'node.connection_restored' | 'node.traffic_notify';
    timestamp: string;
    data: {
        uuid: string;
        name: string;
        address: string;
        isConnected: boolean;
        isDisabled: boolean;
        countryCode: string;
        tags: string[];
    };
}

/**
 * Factory function to create RemnawaveService instance
 */
export function createRemnawaveService(pool?: Pool): RemnawaveService {
    return new RemnawaveService(pool);
}
