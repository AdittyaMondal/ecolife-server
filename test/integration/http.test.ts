import { expect, test } from 'bun:test';
import type { Envelope } from '@common/interceptors/response-envelope.ts';
import { app } from '../../src/app.ts';

type Readiness = { service: string; database: string; latencyMs: number };

// Readiness hits Postgres; a Neon cold start can exceed Bun's 5s default.
const COLD_START_TIMEOUT_MS = 30_000;

test('liveness returns the success envelope', async () => {
  const res = await app.fetch(new Request('http://localhost/api/v1/health'));
  expect(res.status).toBe(200);

  expect(await res.json()).toEqual({
    status: true,
    data: { service: 'ecolife-server', status: 'up' },
    error: null,
  });
});

test(
  'readiness reports a reachable database',
  async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/health/ready'));
    expect(res.status).toBe(200);

    const body = (await res.json()) as Envelope<Readiness>;
    expect(body.error).toBeNull();
    if (!body.status) throw new Error('expected a success envelope');

    expect(body.data.service).toBe('ecolife-server');
    expect(body.data.database).toBe('reachable');
    expect(body.data.latencyMs).toBeGreaterThanOrEqual(0);
  },
  COLD_START_TIMEOUT_MS,
);

test('an unknown route returns the failure envelope, not a bare 404', async () => {
  const res = await app.fetch(new Request('http://localhost/api/v1/nope'));
  expect(res.status).toBe(404);

  const body = (await res.json()) as Envelope<never>;
  expect(body.data).toBeNull();
  if (body.status) throw new Error('expected a failure envelope');

  expect(body.error.code).toBe('HTTP_404');
  expect(body.error.message).toBeString();
});
