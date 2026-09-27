import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb, getPool } from './index';

try {
  await migrate(getDb(), {migrationsFolder: new URL('../drizzle', import.meta.url).pathname});
  console.log('Database migrations applied');
} finally {
  await getPool().end();
}
