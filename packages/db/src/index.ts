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
export function getDb(client?: PoolClient) { return drizzle(client ?? getPool(), {schema}); }
export * from './schema';
export * from './traffic';
