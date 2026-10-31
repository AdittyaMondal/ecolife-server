import { appDatabaseUrl, env } from '@config/env.ts';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index.ts';

/**
 * node-postgres with a reused Pool.
 *
 * Driver choice follows the Neon agent skill: `node-postgres` is correct for a
 * long-running server process that reuses its pool across requests. The
 * `@neondatabase/serverless` driver is for serverless/edge runtimes, which this
 * is not. Traffic goes to the POOLED (-pooler) endpoint; migrations use the
 * direct endpoint (see migrate.ts).
 */
export const pool = new Pool({
  connectionString: appDatabaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  allowExitOnIdle: env.NODE_ENV === 'test',
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;

/** Liveness probe for the health module. Throws if the database is unreachable. */
export async function pingDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('select 1');
  } finally {
    client.release();
  }
}

let closed = false;

/**
 * Idempotent: pg throws "Called end on pool more than once" on a second call,
 * and the pool is a module singleton shared by every caller (and every test
 * file in a `bun test` process).
 */
export async function closeDatabase(): Promise<void> {
  if (closed) return;
  closed = true;
  await pool.end();
}
