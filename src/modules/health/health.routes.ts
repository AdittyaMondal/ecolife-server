import { DomainError } from '@common/errors/domain-error.ts';
import { ok } from '@common/interceptors/response-envelope.ts';
import { jsonError, jsonOk } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { pingDatabase } from '@database/client.ts';
import { createRoute } from '@hono/zod-openapi';
import { livenessSchema, readinessSchema } from './health.schema.ts';

export const healthRoutes = createModule();

/** Liveness only — no dependencies touched. */
healthRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['health'],
    summary: 'Liveness probe',
    responses: { 200: jsonOk(livenessSchema, 'Service is up') },
  }),
  (c) => ok(c, { service: 'ecolife-server', status: 'up' as const }, 200),
);

/** Readiness — proves the Postgres connection is actually usable. */
healthRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/ready',
    tags: ['health'],
    summary: 'Readiness probe — verifies the database is reachable',
    responses: {
      200: jsonOk(readinessSchema, 'Database reachable'),
      503: jsonError('Database unreachable'),
    },
  }),
  async (c) => {
    const startedAt = performance.now();
    try {
      await pingDatabase();
    } catch (err) {
      console.error('database unreachable:', err);
      // Thrown, not returned: a handler that returns both the success and the
      // failure envelope widens its return type into a union, and zod-openapi
      // cannot match that against the route's declared responses. The error
      // filter maps DomainError onto the failure envelope (CLAUDE.md §4.1).
      throw new DomainError('HEALTH_001', 'Database is unreachable.', 503);
    }
    return ok(
      c,
      {
        service: 'ecolife-server',
        database: 'reachable' as const,
        latencyMs: Math.round(performance.now() - startedAt),
      },
      200,
    );
  },
);
