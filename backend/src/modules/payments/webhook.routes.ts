import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '../../utils/logger.js';
import { getPool } from '../../config/database.js';
import { PaymentWebhookHandler, WebhookHandlerError } from './webhook.base.js';
import {
  CryptopayWebhookHandler,
  YooKassaWebhookHandler,
  HeleketWebhookHandler,
  Pal24WebhookHandler,
  PlategaWebhookHandler,
  WataWebhookHandler,
  TelegramStarsWebhookHandler,
} from './handlers/index.js';

/**
 * Get webhook handler for a gateway
 * @param gateway - Gateway name
 * @returns Handler instance or undefined
 */
function getWebhookHandler(gateway: string): PaymentWebhookHandler | undefined {
  const handlers: Record<string, PaymentWebhookHandler> = {
    cryptopay: new CryptopayWebhookHandler(),
    yookassa: new YooKassaWebhookHandler(),
    heleket: new HeleketWebhookHandler(),
    pal24: new Pal24WebhookHandler(),
    platega: new PlategaWebhookHandler(),
    wata: new WataWebhookHandler(),
    'telegram-stars': new TelegramStarsWebhookHandler(),
  };
  return handlers[gateway.toLowerCase()];
}

/**
 * Get webhook secret for a gateway from database
 * @param gateway - Gateway name
 * @returns Webhook secret or null
 */
async function getGatewayWebhookSecret(gateway: string): Promise<string | null> {
  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT config->>'webhookSecret' as webhook_secret
       FROM gateways
       WHERE LOWER(name) = LOWER($1) AND is_active = true`,
      [gateway]
    );
    return result.rows[0]?.webhook_secret || null;
  } catch (error) {
    logger.error({ error, gateway }, 'Failed to get gateway webhook secret');
    return null;
  }
}

/**
 * Get allowed IPs for a gateway from database
 * @param gateway - Gateway name
 * @returns Array of allowed IPs or null
 */
async function getGatewayAllowedIps(gateway: string): Promise<string[] | null> {
  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT config->>'allowedIps' as allowed_ips
       FROM gateways
       WHERE LOWER(name) = LOWER($1) AND is_active = true`,
      [gateway]
    );
    const ips = result.rows[0]?.allowed_ips;
    return ips ? JSON.parse(ips) : null;
  } catch (error) {
    logger.error({ error, gateway }, 'Failed to get gateway allowed IPs');
    return null;
  }
}

/**
 * Check if request IP is allowed
 * @param requestIp - Request IP address
 * @param allowedIps - Array of allowed IPs
 * @returns True if allowed
 */
function isIpAllowed(requestIp: string, allowedIps: string[] | null): boolean {
  if (!allowedIps || allowedIps.length === 0) {
    return true; // No IP restrictions
  }
  return allowedIps.includes(requestIp);
}

/**
 * Log webhook request for debugging
 * @param gateway - Gateway name
 * @param request - Fastify request
 * @param body - Request body
 */
async function logWebhookRequest(
  gateway: string,
  request: FastifyRequest,
  body: unknown
): Promise<void> {
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO webhook_logs (gateway, payload, headers, ip_address, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [
        gateway,
        JSON.stringify(body),
        JSON.stringify(request.headers),
        request.ip,
      ]
    );
  } catch (error) {
    logger.error({ error, gateway }, 'Failed to log webhook request');
  }
}

/**
 * Handle incoming webhook
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
async function handleWebhook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { gateway } = request.params as { gateway: string };
  const body = request.body;
  const rawBody = JSON.stringify(body);

  // Log webhook request
  await logWebhookRequest(gateway, request, body);

  logger.info({ gateway, ip: request.ip }, 'Received webhook request');

  // Get handler for gateway
  const handler = getWebhookHandler(gateway);
  if (!handler) {
    logger.warn({ gateway }, 'Unknown gateway for webhook');
    reply.status(400).send({
      success: false,
      message: `Unknown gateway: ${gateway}`,
    });
    return;
  }

  // Check IP whitelist
  const allowedIps = await getGatewayAllowedIps(gateway);
  if (!isIpAllowed(request.ip, allowedIps)) {
    logger.warn({ gateway, ip: request.ip }, 'Webhook request from unauthorized IP');
    reply.status(403).send({
      success: false,
      message: 'Unauthorized IP address',
    });
    return;
  }

  // Get webhook secret
  const webhookSecret = await getGatewayWebhookSecret(gateway);
  if (!webhookSecret) {
    logger.warn({ gateway }, 'No webhook secret configured for gateway');
  }

  // Get signature from headers
  const signature =
    (request.headers['x-signature'] as string) ||
    (request.headers['x-hub-signature'] as string) ||
    (request.headers['x-cryptopay-signature'] as string) ||
    (request.headers['x-wata-signature'] as string) ||
    '';

  // Validate signature if secret is configured
  if (webhookSecret && signature) {
    const isValid = handler.validateSignature(rawBody, signature, webhookSecret);
    if (!isValid) {
      logger.warn({ gateway }, 'Invalid webhook signature');
      reply.status(401).send({
        success: false,
        message: 'Invalid signature',
      });
      return;
    }
  } else if (webhookSecret && !signature) {
    // If secret is configured but no signature provided
    logger.warn({ gateway }, 'Webhook signature missing');
    reply.status(401).send({
      success: false,
      message: 'Signature required',
    });
    return;
  }

  try {
    // Parse payload
    const payload = handler.parsePayload(body);

    // Process webhook
    const result = await handler.processWebhook(payload);

    // Send response
    reply.status(result.statusCode || 200).send({
      success: result.success,
      message: result.message,
      paymentId: result.paymentId,
    });
  } catch (error) {
    if (error instanceof WebhookHandlerError) {
      reply.status(error.statusCode).send({
        success: false,
        message: error.message,
      });
    } else {
      logger.error({ error, gateway }, 'Unexpected error processing webhook');
      reply.status(500).send({
        success: false,
        message: 'Internal server error',
      });
    }
  }
}

/**
 * Handle webhook verification request
 * Some gateways require URL verification via GET request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
async function handleWebhookVerify(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { gateway } = request.params as { gateway: string };

  logger.info({ gateway }, 'Webhook verification request');

  // Check if gateway exists
  const handler = getWebhookHandler(gateway);
  if (!handler) {
    reply.status(404).send({
      success: false,
      message: `Gateway not found: ${gateway}`,
    });
    return;
  }

  // Return verification response
  reply.send({
    success: true,
    message: 'Webhook endpoint verified',
    gateway: handler.gatewayName,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Get webhook URL for a gateway
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
async function getWebhookUrl(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { gateway } = request.params as { gateway: string };
  const baseUrl = `${request.protocol}://${request.hostname}`;
  const webhookUrl = `${baseUrl}/webhook/payments/${gateway}`;

  reply.send({
    gateway,
    webhookUrl,
    verificationUrl: `${webhookUrl}/verify`,
    documentation: 'Use this URL in your payment gateway settings',
  });
}

/**
 * Register webhook routes
 * @param app - Fastify instance
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // Main webhook endpoint
  app.post('/:gateway', handleWebhook);

  // Webhook verification endpoint (for gateways that require URL verification)
  app.get('/:gateway/verify', handleWebhookVerify);

  // Get webhook URL info
  app.get('/:gateway/url', getWebhookUrl);
}
