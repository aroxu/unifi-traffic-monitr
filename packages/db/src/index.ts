import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import * as schema from './schema';

let pool: Pool | undefined;
export function getPool(): Pool {
  const url = process.env.DATABASE_URL;
  const host = process.env.DB_HOST;
  if (!url && !host) throw new Error('DATABASE_URL or DB_HOST is required');
  if (pool) return pool;
  pool = new Pool(url ? {connectionString: url, max: 10} : {
    host, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME ?? 'traffic',
    user: process.env.DB_USER ?? 'traffic', password: process.env.DB_PASSWORD, max: 10
  });
  // pg emits errors from idle connections outside a query. Without a listener,
  // a brief database restart terminates the whole collector process.
  pool.on('error', () => console.error('Database idle connection lost; retrying on next query'));
  return pool;
}
export function getDb(client?: PoolClient) { return drizzle(client ?? getPool(), {schema}); }
export * from './schema';
export * from './traffic';
