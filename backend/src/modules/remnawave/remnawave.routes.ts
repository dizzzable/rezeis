import { FastifyInstance } from 'fastify';
import { RemnawaveController } from './remnawave.controller.js';
import { authenticate } from '../../middleware/auth.middleware.js';

export async function remnawaveRoutes(app: FastifyInstance) {
  const controller = new RemnawaveController(app.pg);

  // Config routes
  app.get('/remnawave/config', { preHandler: authenticate }, controller.getConfig);
  app.put('/remnawave/config', { preHandler: authenticate }, controller.updateConfig);
  app.post('/remnawave/config/test', { preHandler: authenticate }, controller.testConnection);

  // Server routes
  app.get('/remnawave/servers', { preHandler: authenticate }, controller.getServers);
  app.post('/remnawave/servers/sync', { preHandler: authenticate }, controller.syncServers);
  app.get('/remnawave/servers/:id', { preHandler: authenticate }, controller.getServer);
  app.patch('/remnawave/servers/:id', { preHandler: authenticate }, controller.updateServer);

  // Key routes
  app.get('/remnawave/keys', { preHandler: authenticate }, controller.getKeys);
  app.post('/remnawave/keys', { preHandler: authenticate }, controller.createKey);
  app.get('/remnawave/keys/:id', { preHandler: authenticate }, controller.getKey);
  app.patch('/remnawave/keys/:id', { preHandler: authenticate }, controller.updateKey);
  app.delete('/remnawave/keys/:id', { preHandler: authenticate }, controller.deleteKey);
  app.post('/remnawave/keys/:id/sync', { preHandler: authenticate }, controller.syncKey);
  app.get('/remnawave/keys/user/:id', { preHandler: authenticate }, controller.getUserKeys);

  // Traffic routes
  app.get('/remnawave/traffic', { preHandler: authenticate }, controller.getTrafficStats);
  app.get('/remnawave/traffic/user/:id', { preHandler: authenticate }, controller.getUserTraffic);

  // Sync routes
  app.post('/remnawave/sync', { preHandler: authenticate }, controller.triggerSync);
  app.get('/remnawave/sync/logs', { preHandler: authenticate }, controller.getSyncLogs);
  app.get('/remnawave/sync/status', { preHandler: authenticate }, controller.getSyncStatus);
}
