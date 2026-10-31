import { env } from '@config/env.ts';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';

/**
 * Applies committed, forward-only migrations.
 *
 * Uses a single DIRECT connection (not -pooler): the Neon skill is explicit
 * that schema migrations must not run through the connection pooler.
 */
const client = new Client({ connectionString: env.DATABASE_URL });

await client.connect();
try {
  await migrate(drizzle(client), { migrationsFolder: './src/database/migrations' });
  console.log('migrations applied');
} finally {
  await client.end();
}
