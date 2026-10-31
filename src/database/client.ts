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
/**
 * Tests get their own database, and it is NOT optional.
 *
 * The suite registers users, writes logs and deletes accounts, so it must
 * never point at a branch anyone depends on. It did once: `neon init`
 * silently repointed `.env` at the production branch and the next full run
 * put 190 test accounts into it. `TEST_DATABASE_URL` plus the preload guard
 * in `src/common/testing/setup.ts` are the two halves of making that
 * impossible rather than merely unlikely.
 */
const connectionString =
  env.NODE_ENV === 'test' && env.TEST_DATABASE_URL ? env.TEST_DATABASE_URL : appDatabaseUrl;

export const pool = new Pool({
  connectionString,
  /**
   * Ten is right for one server process serving requests one at a time.
   * The suite is different: it runs whole flows back to back, and several
   * endpoints — /home most of all — fan out five or six queries at once, so
   * ten saturates and later tests fail on connection timeouts that look like
   * logic failures. Neon's pooler is in front either way.
   */
  max: env.NODE_ENV === 'test' ? 30 : 10,
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
