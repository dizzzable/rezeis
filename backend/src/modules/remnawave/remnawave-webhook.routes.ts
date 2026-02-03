import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import {
    RemnawaveService,
    RemnawaveWebhookEvent,
    UserWebhookEvent,
    UserHwidDevicesEvent,
    NodeWebhookEvent,
} from '../../services/remnawave.service.js';
import { getRemnawaveConfig } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

/**
 * Webhook route definitions for Remnawave
 * Handles all webhook events from Remnawave panel
 */
export async function remnawaveWebhookRoutes(app: FastifyInstance) {
    const remnawaveService = new RemnawaveService(app.pg);
    const pool = app.pg;

    /**
     * POST /webhooks/remnawave
     * Main webhook endpoint for Remnawave events
     */
    app.post('/webhooks/remnawave', async (
        request: FastifyRequest,
        reply: FastifyReply
    ) => {
        try {
            const rawBody = JSON.stringify(request.body);
            const signature = request.headers['x-webhook-signature'] as string;
            const config = getRemnawaveConfig();

            // Verify webhook signature if configured
            if (config.webhookSecret && signature) {
                const isValid = remnawaveService.verifyWebhookSignature(rawBody, signature);
                if (!isValid) {
                    logger.warn('Invalid webhook signature received');
                    return reply.status(401).send({ error: 'Invalid signature' });
                }
            }

            // Parse webhook payload
            const event = remnawaveService.parseWebhookPayload(rawBody);

            // Log webhook event
            logger.info({ scope: event.scope, eventType: event.event }, 'Received Remnawave webhook');

            // Handle different event types using scope
            await handleWebhookEvent(event, pool);

            return reply.status(200).send({ received: true });
        } catch (error) {
            logger.error({ error }, 'Failed to process Remnawave webhook');
            return reply.status(400).send({ error: 'Invalid webhook payload' });
        }
    });

    /**
     * GET /webhooks/remnawave/health
     * Health check endpoint for webhook
     */
    app.get('/webhooks/remnawave/health', async (request: FastifyRequest, reply: FastifyReply) => {
        void request;
        const config = getRemnawaveConfig();
        return reply.send({
            status: 'ok',
            webhookConfigured: !!config.webhookSecret,
            syncEnabled: config.syncEnabled,
        });
    });
}

/**
 * Handle webhook events based on scope using SDK types
 */
async function handleWebhookEvent(event: RemnawaveWebhookEvent, pool: Pool): Promise<void> {
    // Handle based on scope
    switch (event.scope) {
        case 'user':
            await handleUserEvent(event as UserWebhookEvent, pool);
            return;

        case 'user_hwid_devices':
            await handleHwidEvent(event as UserHwidDevicesEvent, pool);
            return;

        case 'node':
            await handleNodeEvent(event as NodeWebhookEvent, pool);
            return;
    }
}

/**
 * Handle user-related webhook events using SDK types
 */
async function handleUserEvent(
    event: UserWebhookEvent,
    pool: Pool
): Promise<void> {
    const { event: eventType, data: user } = event;

    switch (eventType) {
        case 'user.created':
            logger.info({ userUuid: user.uuid }, 'User created in Remnawave');
            // TODO: Sync user to local database if needed
            break;

        case 'user.modified':
            logger.info({ userUuid: user.uuid }, 'User modified in Remnawave');
            // TODO: Update user in local database
            break;

        case 'user.deleted':
            logger.info({ userUuid: user.uuid }, 'User deleted from Remnawave');
            // Clean up local references
            await pool.query(
                'UPDATE subscriptions SET remnawave_uuid = NULL WHERE remnawave_uuid = $1',
                [user.uuid]
            );
            break;

        case 'user.revoked':
            logger.info({ userUuid: user.uuid }, 'User UUID revoked in Remnawave');
            // Update subscription status
            await pool.query(
                "UPDATE subscriptions SET status = 'revoked' WHERE remnawave_uuid = $1",
                [user.uuid]
            );
            break;

        case 'user.disabled':
            logger.info({ userUuid: user.uuid }, 'User disabled in Remnawave');
            await pool.query(
                "UPDATE subscriptions SET status = 'disabled' WHERE remnawave_uuid = $1",
                [user.uuid]
            );
            break;

        case 'user.enabled':
            logger.info({ userUuid: user.uuid }, 'User enabled in Remnawave');
            await pool.query(
                "UPDATE subscriptions SET status = 'active' WHERE remnawave_uuid = $1",
                [user.uuid]
            );
            break;

        case 'user.limited':
            logger.info({ userUuid: user.uuid }, 'User traffic limit reached in Remnawave');
            await pool.query(
                "UPDATE subscriptions SET status = 'limited', traffic_limited_at = NOW() WHERE remnawave_uuid = $1",
                [user.uuid]
            );
            break;

        case 'user.expired':
            logger.info({ userUuid: user.uuid }, 'User subscription expired in Remnawave');
            await pool.query(
                "UPDATE subscriptions SET status = 'expired' WHERE remnawave_uuid = $1",
                [user.uuid]
            );
            break;

        case 'user.first_connected':
            logger.info({ userUuid: user.uuid }, 'User first connected to Remnawave');
            await pool.query(
                "UPDATE subscriptions SET first_connected_at = NOW() WHERE remnawave_uuid = $1",
                [user.uuid]
            );
            break;

        case 'user.expires_in_72_hours':
        case 'user.expires_in_48_hours':
        case 'user.expires_in_24_hours':
            logger.info({
                userUuid: user.uuid,
                hours: eventType.includes('72') ? 72 : eventType.includes('48') ? 48 : 24
            },
                'User subscription expiring soon');
            // TODO: Send notification to user
            break;

        case 'user.expired_24_hours_ago':
            logger.info({ userUuid: user.uuid }, 'User subscription expired 24 hours ago');
            // TODO: Send expiration notification or cleanup
            break;

        case 'user.traffic_reset':
            logger.info({ userUuid: user.uuid }, 'User traffic reset in Remnawave');
            break;

        case 'user.bandwidth_usage_threshold_reached':
            logger.info({ userUuid: user.uuid }, 'User bandwidth threshold reached');
            break;

        case 'user.not_connected':
            logger.info({ userUuid: user.uuid }, 'User not connected');
            break;

        default:
            logger.warn({ eventType }, 'Unhandled user event type');
    }
}

/**
 * Handle HWID device webhook events using SDK types
 */
async function handleHwidEvent(
    event: UserHwidDevicesEvent,
    pool: Pool
): Promise<void> {
    void pool;
    const { event: eventType, data } = event;
    const { user, hwidUserDevice } = data;

    switch (eventType) {
        case 'user_hwid_devices.added':
            logger.info({ userUuid: user.uuid, hwid: hwidUserDevice.hwid }, 'HWID device added');
            break;

        case 'user_hwid_devices.deleted':
            logger.info({ userUuid: user.uuid, hwid: hwidUserDevice.hwid }, 'HWID device deleted');
            break;

        default:
            logger.warn({ eventType }, 'Unhandled HWID event type');
    }
}

/**
 * Handle node webhook events using SDK types
 */
async function handleNodeEvent(
    event: NodeWebhookEvent,
    pool: Pool
): Promise<void> {
    void pool;
    const { event: eventType, data: node } = event;

    switch (eventType) {
        case 'node.connection_lost':
            logger.warn({ nodeUuid: node.uuid, nodeName: node.name }, 'Node connection lost');
            break;

        case 'node.connection_restored':
            logger.info({ nodeUuid: node.uuid, nodeName: node.name }, 'Node connection restored');
            break;

        case 'node.traffic_notify':
            logger.info({ nodeUuid: node.uuid, nodeName: node.name }, 'Node traffic threshold reached');
            break;

        case 'node.created':
            logger.info({ nodeUuid: node.uuid, nodeName: node.name }, 'Node created');
            break;

        case 'node.modified':
            logger.info({ nodeUuid: node.uuid, nodeName: node.name }, 'Node modified');
            break;

        case 'node.disabled':
            logger.warn({ nodeUuid: node.uuid, nodeName: node.name }, 'Node disabled');
            break;

        case 'node.enabled':
            logger.info({ nodeUuid: node.uuid, nodeName: node.name }, 'Node enabled');
            break;

        case 'node.deleted':
            logger.info({ nodeUuid: node.uuid, nodeName: node.name }, 'Node deleted');
            break;

        default:
            logger.warn({ eventType }, 'Unhandled node event type');
    }
}
