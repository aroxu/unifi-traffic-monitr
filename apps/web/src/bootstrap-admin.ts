import {getPool} from '@utm/db';
import {auth} from './lib/auth';

const pool = getPool();

try {
  const existing = await pool.query<{count: string}>('SELECT count(*)::text AS count FROM "user"');
  if (Number(existing.rows[0]?.count ?? 0) > 0) {
    console.log('Admin bootstrap skipped: users already exist');
  } else {
    const email = process.env.ADMIN_EMAIL?.trim();
    const password = process.env.ADMIN_PASSWORD;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length < 8) {
      throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD (at least 8 characters) are required for a new database');
    }
    await auth.api.createUser({body: {email, password, name: 'Admin', role: 'admin', data: {emailVerified: true}}});
    console.log('Initial admin created');
  }
} finally {
  await pool.end();
}
