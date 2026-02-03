import 'dotenv/config';
import { startServer } from './app.js';

/**
 * Application entry point
 */
async function main(): Promise<void> {
  await startServer();
}

main();
