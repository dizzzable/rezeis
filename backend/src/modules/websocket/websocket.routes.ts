import type { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { wsServer, WebSocketServer } from '../../websocket/websocket.server.js';
import { pubSubService } from '../../websocket/pubsub.service.js';
import { logger } from '../../utils/logger.js';
import type { ConnectionType } from '../../websocket/types.js';

/**
 * WebSocket controller
 */
class WebSocketController {
  /**
   * Get WebSocket server status
   */
  async handleGetStatus(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    void request;
    const stats = wsServer.getStats();
    reply.send({
      success: true,
      data: {
        status: 'running',
        ...stats,
      },
    });
  }

  /**
   * Get WebSocket server statistics
   */
  async handleGetStats(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    void request;
    const stats = wsServer.getStats();
    reply.send({
      success: true,
      data: stats,
    });
  }

  /**
   * Get list of connected clients (admin only)
   */
  async handleGetClients(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    void request;
    const clients = wsServer.getClients();
    reply.send({
      success: true,
      data: clients,
    });
  }

  /**
   * Broadcast message to all clients (admin only)
   */
  async handleBroadcast(
    request: FastifyRequest<{ Body: { message: string; type?: string; priority?: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const { message, type = 'system:broadcast', priority = 'normal' } = request.body;

    await wsServer.broadcast({
      type,
      payload: { message, priority },
      timestamp: Date.now(),
    });

    // Also publish to Redis for other instances
    await pubSubService.broadcast({ message, priority });

    reply.send({
      success: true,
      message: 'Broadcast sent',
    });
  }

  /**
   * Send message to a specific user (admin only)
   */
  async handleSendToUser(
    request: FastifyRequest<{ Body: { userId: string; message: string; type?: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const { userId, message, type = 'system:message' } = request.body;

    await wsServer.sendToUser(userId, {
      type,
      payload: { message },
      timestamp: Date.now(),
    });

    reply.send({
      success: true,
      message: 'Message sent',
    });
  }

  /**
   * Send message to a channel (admin only)
   */
  async handleSendToChannel(
    request: FastifyRequest<{ Body: { channel: string; message: string; type?: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const { channel, message, type = 'system:message' } = request.body;

    await wsServer.broadcastToChannel(channel, {
      type,
      payload: { message },
      timestamp: Date.now(),
    });

    reply.send({
      success: true,
      message: 'Channel message sent',
    });
  }

  /**
   * Disconnect a client (admin only)
   */
  async handleDisconnectClient(
    request: FastifyRequest<{ Body: { clientId: string; reason?: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const { clientId } = request.body;

    const success = await wsServer.disconnectClient(clientId);

    if (success) {
      reply.send({
        success: true,
        message: 'Client disconnected',
      });
    } else {
      reply.status(404).send({
        success: false,
        error: 'Client not found',
      });
    }
  }
}

/**
 * Handle WebSocket connection
 */
async function handleWebSocketConnection(
  socket: WebSocket,
  request: FastifyRequest,
  connectionType: ConnectionType
): Promise<void> {
  void request;
  const clientId = WebSocketServer.generateClientId();

  logger.info({ clientId, connectionType }, 'WebSocket connection established');

  // Handle the connection with the WebSocket server
  await wsServer.handleConnection(socket as unknown as import('ws').WebSocket, clientId, connectionType);
}

/**
 * Configure WebSocket routes
 */
export async function websocketRoutes(
  fastify: FastifyInstance,
  options: FastifyPluginOptions
): Promise<void> {
  void options;
  const controller = new WebSocketController();

  // WebSocket endpoint for clients
  fastify.get('/client', { websocket: true }, function (socket, request) {
    handleWebSocketConnection(socket, request, 'client').catch((err) => {
      logger.error({ err }, 'Error handling client WebSocket connection');
    });
  });

  // WebSocket endpoint for admins
  fastify.get('/admin', { websocket: true }, function (socket, request) {
    handleWebSocketConnection(socket, request, 'admin').catch((err) => {
      logger.error({ err }, 'Error handling admin WebSocket connection');
    });
  });

  // API Routes for WebSocket management

  // GET /ws/status - WebSocket server status
  fastify.get('/status', {
    schema: {
      tags: ['websocket'],
      summary: 'Get WebSocket server status',
      description: 'Get current status and statistics of the WebSocket server',
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                status: { type: 'string' },
                totalConnections: { type: 'number' },
                authenticatedConnections: { type: 'number' },
                clientConnections: { type: 'number' },
                adminConnections: { type: 'number' },
                subscriptionsByChannel: { type: 'object' },
              },
            },
          },
        },
      },
    },
    handler: controller.handleGetStatus,
  });

  // GET /ws/stats - WebSocket statistics
  fastify.get('/stats', {
    schema: {
      tags: ['websocket'],
      summary: 'Get WebSocket statistics',
      description: 'Get detailed statistics about WebSocket connections',
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                totalConnections: { type: 'number' },
                authenticatedConnections: { type: 'number' },
                clientConnections: { type: 'number' },
                adminConnections: { type: 'number' },
                subscriptionsByChannel: { type: 'object' },
              },
            },
          },
        },
      },
    },
    handler: controller.handleGetStats,
  });

  // GET /ws/clients - List connected clients (admin only)
  fastify.get('/clients', {
    schema: {
      tags: ['websocket'],
      summary: 'List connected clients',
      description: 'Get a list of all connected WebSocket clients (admin only)',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  userId: { type: 'string' },
                  connectionType: { type: 'string' },
                  isAuthenticated: { type: 'boolean' },
                  subscriptions: { type: 'array', items: { type: 'string' } },
                  connectedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleGetClients,
  });

  // POST /ws/broadcast - Broadcast message to all clients (admin only)
  fastify.post('/broadcast', {
    schema: {
      tags: ['websocket'],
      summary: 'Broadcast message',
      description: 'Send a message to all connected WebSocket clients (admin only)',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string' },
          type: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleBroadcast,
  });

  // POST /ws/send-to-user - Send message to specific user (admin only)
  fastify.post('/send-to-user', {
    schema: {
      tags: ['websocket'],
      summary: 'Send message to user',
      description: 'Send a message to a specific user (admin only)',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['userId', 'message'],
        properties: {
          userId: { type: 'string' },
          message: { type: 'string' },
          type: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleSendToUser,
  });

  // POST /ws/send-to-channel - Send message to channel (admin only)
  fastify.post('/send-to-channel', {
    schema: {
      tags: ['websocket'],
      summary: 'Send message to channel',
      description: 'Send a message to all subscribers of a channel (admin only)',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['channel', 'message'],
        properties: {
          channel: { type: 'string' },
          message: { type: 'string' },
          type: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleSendToChannel,
  });

  // POST /ws/disconnect-client - Disconnect a client (admin only)
  fastify.post('/disconnect-client', {
    schema: {
      tags: ['websocket'],
      summary: 'Disconnect client',
      description: 'Force disconnect a WebSocket client (admin only)',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['clientId'],
        properties: {
          clientId: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        404: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleDisconnectClient,
  });
}
