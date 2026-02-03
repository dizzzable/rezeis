import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { RemnawaveService } from '../../services/remnawave.service.js';

/**
 * Remnawave controller
 * Handles Remnawave API operations
 */
export class RemnawaveController {
  private readonly service: RemnawaveService;

  constructor(pool: Pool) {
    this.service = new RemnawaveService(pool);
  }

  /**
   * Get Remnawave configuration
   */
  async getConfig(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    void request;
    try {
      const stats = await this.service.getSystemStats();
      reply.send({ success: true, data: { stats } });
    } catch (err) {
      void err;
      reply.status(500).send({ success: false, error: 'Failed to get config' });
    }
  }

  /**
   * Update Remnawave configuration
   */
  async updateConfig(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    void request;
    reply.status(501).send({ success: false, error: 'Not implemented' });
  }

  /**
   * Test Remnawave connection
   */
  async testConnection(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    void request;
    try {
      const result = await this.service.testConnection();
      reply.send({ success: result.success, message: result.message });
    } catch (err) {
      void err;
      reply.status(500).send({ success: false, error: 'Connection test failed' });
    }
  }

  /**
   * Get all servers
   */
  async getServers(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    void request;
    try {
      const servers = await this.service.getAllNodes();
      reply.send({ success: true, data: servers });
    } catch (err) {
      void err;
      reply.status(500).send({ success: false, error: 'Failed to get servers' });
    }
  }

  /**
   * Sync servers from Remnawave
   */
  async syncServers(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    void request;
    try {
      const servers = await this.service.getAllNodes();
      reply.send({ success: true, data: { synced: servers.length } });
    } catch (err) {
      void err;
      reply.status(500).send({ success: false, error: 'Failed to sync servers' });
    }
  }

  /**
   * Get server by ID
   */
  async getServer(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const params = request.params as { id: string };
      const nodes = await this.service.getAllNodes();
      const server = nodes.find((n) => n.uuid === params.id);
      if (!server) {
        reply.status(404).send({ success: false, error: 'Server not found' });
        return;
      }
      reply.send({ success: true, data: server });
    } catch (err) {
      void err;
      reply.status(500).send({ success: false, error: 'Failed to get server' });
    }
  }

  /**
   * Update server
   */
  async updateServer(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    void request;
    reply.status(501).send({ success: false, error: 'Not implemented' });
  }

  /**
   * Get all keys (users)
   */
  async getKeys(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    void request;
    try {
      const users = await this.service.getAllUsers();
      reply.send({ success: true, data: users });
    } catch (err) {
      void err;
      reply.status(500).send({ success: false, error: 'Failed to get keys' });
    }
  }

  /**
   * Create new key (user)
   */
  async createKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = request.body as { username: string; trafficLimitBytes: number; expireAt: string };
      const user = await this.service.createUser(body);
      reply.status(201).send({ success: true, data: user });
    } catch (err) {
      void err;
      reply.status(500).send({ success: false, error: 'Failed to create key' });
    }
  }

  /**
   * Get key (user) by ID
   */
  async getKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const params = request.params as { id: string };
      const user = await this.service.getUserByUuid(params.id);
      if (!user) {
        reply.status(404).send({ success: false, error: 'Key not found' });
        return;
      }
      reply.send({ success: true, data: user });
    } catch (err) {
      void err;
      reply.status(500).send({ success: false, error: 'Failed to get key' });
    }
  }

  /**
   * Update key (user)
   */
  async updateKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const params = request.params as { id: string };
      const body = request.body as { trafficLimitBytes?: number; expireAt?: string; status?: 'ACTIVE' | 'DISABLED' };
      const user = await this.service.updateUser(params.id, body);
      reply.send({ success: true, data: user });
    } catch (err) {
      void err;
      reply.status(500).send({ success: false, error: 'Failed to update key' });
    }
  }

  /**
   * Delete key (user)
   */
  async deleteKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const params = request.params as { id: string };
      await this.service.deleteUser(params.id);
      reply.send({ success: true, message: 'Key deleted' });
    } catch (err) {
      void err;
      reply.status(500).send({ success: false, error: 'Failed to delete key' });
    }
  }

  /**
   * Sync key with Remnawave
   */
  async syncKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    void request;
    reply.status(501).send({ success: false, error: 'Not implemented' });
  }

  /**
   * Get keys (users) by user ID
   */
  async getUserKeys(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const params = request.params as { id: string };
      const users = await this.service.getUsersByTelegramId(params.id);
      reply.send({ success: true, data: users });
    } catch (err) {
      void err;
      reply.status(500).send({ success: false, error: 'Failed to get user keys' });
    }
  }

  /**
   * Get traffic statistics
   */
  async getTrafficStats(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    void request;
    try {
      const users = await this.service.getAllUsers();
      const totalTraffic = users.reduce((sum, u) => sum + (u.userTraffic?.usedTrafficBytes || 0), 0);
      reply.send({ success: true, data: { totalTraffic, userCount: users.length } });
    } catch (err) {
      void err;
      reply.status(500).send({ success: false, error: 'Failed to get traffic stats' });
    }
  }

  /**
   * Get user traffic
   */
  async getUserTraffic(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const params = request.params as { id: string };
      const user = await this.service.getUserByUuid(params.id);
      if (!user) {
        reply.status(404).send({ success: false, error: 'User not found' });
        return;
      }
      reply.send({ success: true, data: { trafficUsed: user.userTraffic?.usedTrafficBytes || 0, trafficLimit: user.trafficLimitBytes } });
    } catch (err) {
      void err;
      reply.status(500).send({ success: false, error: 'Failed to get user traffic' });
    }
  }

  /**
   * Trigger manual sync
   */
  async triggerSync(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    void request;
    reply.status(501).send({ success: false, error: 'Not implemented' });
  }

  /**
   * Get sync logs
   */
  async getSyncLogs(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    void request;
    reply.status(501).send({ success: false, error: 'Not implemented' });
  }

  /**
   * Get sync status
   */
  async getSyncStatus(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    void request;
    try {
      const result = await this.service.testConnection();
      reply.send({ success: true, data: { connected: result.success } });
    } catch (err) {
      void err;
      reply.status(500).send({ success: false, error: 'Failed to get sync status' });
    }
  }
}
