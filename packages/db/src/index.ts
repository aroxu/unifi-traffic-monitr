import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool, type ClientConfig, type PoolClient } from 'pg';
import * as schema from './schema';

let pool: Pool | undefined;
function connectionConfig(): ClientConfig {
  const url = process.env.DATABASE_URL;
  const host = process.env.DB_HOST;
  if (!url && !host) throw new Error('DATABASE_URL or DB_HOST is required');
  return url ? {connectionString: url} : {
    host, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME ?? 'traffic',
    user: process.env.DB_USER ?? 'traffic', password: process.env.DB_PASSWORD
  };
}
export function createNotificationClient(): Client {
  return new Client({...connectionConfig(), connectionTimeoutMillis: 5000});
}
export function getPool(): Pool {
  if (pool) return pool;
  pool = new Pool({...connectionConfig(), max: 10});
  // pg emits errors from idle connections outside a query. Without a listener,
  // a brief database restart terminates the whole collector process.
  pool.on('error', () => console.error('Database idle connection lost; retrying on next query'));
  return pool;
}

/**
 * Run fn with a client checked out from the pool.
 *
 * pg-pool removes its own error listener while a client is checked out, so a
 * connection that drops in that time emits an 'error' event with no listener,
 * which ends the process. The listener here absorbs it. The client is closed
 * instead of returned to the pool when the connection failed, when fn threw
 * (it may have left a transaction or session lock behind), or when fn calls
 * discard().
 */
export async function withClient<T>(fn: (client: PoolClient, discard: () => void) => Promise<T>,
  from: Pool = getPool()): Promise<T> {
  const client = await from.connect();
  let broken = false;
  const onError = () => { broken = true; };
  client.on('error', onError);
  try {
    const result = await fn(client, () => { broken = true; });
    return result;
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    client.off('error', onError);
    client.release(broken);
  }
}
export function getDb(client?: PoolClient) { return drizzle(client ?? getPool(), {schema}); }
export * from './schema';
export * from './traffic';
