import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb, getPool } from './index';

try {
  await migrate(getDb(), {migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url))});
  console.log('Database migrations applied');
} finally {
  await getPool().end();
}
