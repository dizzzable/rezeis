import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { getEnv } from './env.js';
import { logger } from '../utils/logger.js';

/**
 * PostgreSQL pool instance
 */
let pool: Pool | null = null;

/**
 * Initialize PostgreSQL connection pool
 * @returns PostgreSQL pool instance
 */
export function initializePool(): Pool {
  const env = getEnv();

  pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  pool.on('error', (err: Error) => {
    logger.error({ err }, 'Unexpected PostgreSQL pool error');
  });

  pool.on('connect', () => {
    logger.debug('New PostgreSQL connection established');
  });

  return pool;
}

/**
 * Get PostgreSQL pool instance
 * @returns Pool instance
 * @throws Error if pool is not initialized
 */
export function getPool(): Pool {
  if (!pool) {
    throw new Error('Database pool not initialized. Call initializePool() first.');
  }
  return pool;
}

/**
 * Execute a query on the database
 * @param text SQL query text
 * @param params Query parameters
 * @returns Query result
 */
export async function query<T extends QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const pool = getPool();
  const start = Date.now();

  try {
    const result = await pool.query<T>(text, params);
    const duration = Date.now() - start;

    logger.debug({ query: text, duration, rows: result.rowCount }, 'Database query executed');

    return result;
  } catch (error) {
    logger.error({ query: text, error }, 'Database query failed');
    throw error;
  }
}

/**
 * Get a client from the pool for transactions
 * @returns Pool client
 */
export async function getClient(): Promise<PoolClient> {
  const pool = getPool();
  return await pool.connect();
}

/**
 * Close the database pool
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database pool closed');
  }
}

/**
 * Test database connection
 * @returns True if connection is successful
 */
export async function testConnection(): Promise<boolean> {
  try {
    const result = await query('SELECT NOW() as now');
    logger.info({ time: result.rows[0] }, 'Database connection successful');
    return true;
  } catch (error) {
    logger.error({ error }, 'Database connection failed');
    return false;
  }
}
