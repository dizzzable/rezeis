import { loadOlcrtcAgentConfig } from './olcrtc-agent/config';
import { OlcrtcAgentDaemon } from './olcrtc-agent/daemon';
import { JsonOlcrtcAgentLogger } from './olcrtc-agent/logger';

async function main(): Promise<void> {
  const config = loadOlcrtcAgentConfig();
  const logger = new JsonOlcrtcAgentLogger();
  const daemon = new OlcrtcAgentDaemon(config, logger);

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info('shutdown signal received', { signal });
    void daemon.stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  logger.info('agent starting', {
    gatewayName: config.gatewayName,
    baseUrl: config.baseUrl,
    capacity: config.capacity,
    commandMode: config.sessionCommand !== null,
  });
  await daemon.start();
}

void main().catch((error) => {
  new JsonOlcrtcAgentLogger(process.stderr).error('fatal startup error', { error });
  process.exitCode = 1;
});
