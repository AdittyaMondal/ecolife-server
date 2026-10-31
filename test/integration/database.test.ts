import { expect, test } from 'bun:test';
import { appDatabaseUrl, env } from '@config/env.ts';
import { pingDatabase, pool } from '@database/client.ts';

// Neon scales compute to zero; the first query after idle can take several
// seconds. Bun's default 5s test timeout is not enough for a cold start.
const COLD_START_TIMEOUT_MS = 30_000;

test('app traffic is routed to the pooled endpoint', () => {
  // The pooled URL must win when both are configured; app queries must never
  // go to the direct endpoint. Asserts on the host shape, not the credential.
  if (env.DATABASE_URL_POOLED) {
    expect(appDatabaseUrl).toContain('-pooler');
  } else {
    expect(appDatabaseUrl).toBe(env.DATABASE_URL);
  }
});

test('TLS is pinned to verify-full', () => {
  // pg currently aliases sslmode=require to verify-full but warns it will
  // weaken to libpq semantics. Fail loudly if someone downgrades it.
  expect(appDatabaseUrl).toContain('sslmode=verify-full');
});

test(
  'pooled connection is reachable',
  async () => {
    await pingDatabase();
  },
  COLD_START_TIMEOUT_MS,
);

test(
  'a real query round-trips through the pool',
  async () => {
    const result = await pool.query('select 1 as one, now() as at');
    expect(result.rows[0]?.one).toBe(1);
    // timestamptz must arrive as a Date, not a string.
    expect(result.rows[0]?.at).toBeInstanceOf(Date);
  },
  COLD_START_TIMEOUT_MS,
);
