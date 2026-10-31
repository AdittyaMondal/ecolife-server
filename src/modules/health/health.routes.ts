import { fail, ok } from '@common/interceptors/response-envelope.ts';
import { pingDatabase } from '@database/client.ts';
import { Hono } from 'hono';

export const healthRoutes = new Hono();

/** Liveness only — no dependencies touched. */
healthRoutes.get('/', (c) => ok(c, { service: 'ecolife-server', status: 'up' }));

/** Readiness — proves the Postgres connection is actually usable. */
healthRoutes.get('/ready', async (c) => {
  const startedAt = performance.now();
  try {
    await pingDatabase();
    return ok(c, {
      service: 'ecolife-server',
      database: 'reachable',
      latencyMs: Math.round(performance.now() - startedAt),
    });
  } catch (err) {
    console.error('database unreachable:', err);
    return fail(c, 'HEALTH_001', 'Database is unreachable.', 503);
  }
});
