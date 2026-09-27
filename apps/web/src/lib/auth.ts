import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { getDb } from '@utm/db';
import * as authSchema from '@utm/db/auth-schema';

export const auth = betterAuth({
  database: drizzleAdapter(getDb(), {provider: 'pg', schema: authSchema}),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  emailAndPassword: {enabled: true, disableSignUp: true},
  plugins: [admin()],
});
