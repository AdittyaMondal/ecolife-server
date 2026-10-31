import { z } from '@hono/zod-openapi';

export const livenessSchema = z
  .object({
    service: z.string().openapi({ example: 'ecolife-server' }),
    status: z.literal('up'),
  })
  .openapi('Liveness');

export const readinessSchema = z
  .object({
    service: z.string().openapi({ example: 'ecolife-server' }),
    database: z.literal('reachable'),
    latencyMs: z.number().int().openapi({ example: 42 }),
  })
  .openapi('Readiness');
