import { describe, expect, it } from 'bun:test';
import { db } from '@database/client.ts';
import { notifications } from '@database/schema/index.ts';
import { app } from '../../src/app.ts';

/** Reference data, the public methodology page, and notifications. */

const TIMEOUT = 30_000;
const PW = 'correct horse battery staple';

const call = (path: string, init: RequestInit = {}) =>
  app.request(`/api/v1${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

type Envelope = {
  status: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads arbitrary response JSON
  data: any;
  // biome-ignore lint/suspicious/noExplicitAny: details differ per error code
  error: { code: string; message: string; details: any };
};
const json = async (r: Response) => (await r.json()) as unknown as Envelope;

async function signUp() {
  const addr = `ref-${crypto.randomUUID()}@example.test`;
  const res = await call('/auth/register', {
    method: 'POST',
    headers: { 'x-ecolife-platform': 'ios' },
    body: JSON.stringify({ name: 'Ref Probe', email: addr, password: PW }),
  });
  const body = await json(res);
  return { token: body.data.session.accessToken as string, userId: body.data.user.id as number };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('reference data', () => {
  it(
    'matches cities on a prefix',
    async () => {
      const res = await call('/cities?q=mum');
      const body = await json(res);
      expect(res.status).toBe(200);
      expect(body.data.items.length).toBeGreaterThan(0);
      for (const city of body.data.items) {
        expect(city.name.toLowerCase().startsWith('mum')).toBe(true);
        expect(city.regionCode).toMatch(/^IN-/);
      }
    },
    TIMEOUT,
  );

  it(
    'treats a wildcard as a literal, not as "every city"',
    async () => {
      // Unescaped, `%` in an ILIKE pattern matches everything — a one-character
      // request that scans the whole table and returns it.
      const res = await call('/cities?q=%25');
      const body = await json(res);
      expect(res.status).toBe(200);
      expect(body.data.items).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'lists regions with a usable grid factor and tariff',
    async () => {
      const body = await json(await call('/regions'));
      expect(body.data.items.length).toBeGreaterThan(0);
      for (const r of body.data.items) {
        expect(r.gridKgPerKwh).toBeGreaterThan(0);
        expect(r.tariffPaisePerKwh).toBeGreaterThan(0);
      }
    },
    TIMEOUT,
  );

  it(
    'serves the methodology without a token — it is the credibility surface',
    async () => {
      const res = await call('/carbon/methodology');
      const body = await json(res);
      expect(res.status).toBe(200);
      expect(body.data.factorVersion).toBe(1);
      expect(body.data.factors.length).toBeGreaterThan(40);
      expect(body.data.caveat).toContain('averages');
    },
    TIMEOUT,
  );
});

describe('notifications', () => {
  it(
    'refuses an anonymous caller',
    async () => {
      expect((await call('/notifications')).status).toBe(401);
    },
    TIMEOUT,
  );

  it(
    'lists newest first, pages by cursor, and marks one read',
    async () => {
      const { token, userId } = await signUp();

      await db.insert(notifications).values(
        Array.from({ length: 3 }, (_, i) => ({
          userId,
          type: 'test',
          title: `Notice ${i + 1}`,
          body: null,
          linkPath: null,
        })),
      );

      const first = await json(await call('/notifications?limit=2', { headers: auth(token) }));
      expect(first.data.items).toHaveLength(2);
      expect(first.data.items[0].title).toBe('Notice 3');
      expect(first.data.pageInfo.hasMore).toBe(true);

      const next = await json(
        await call(`/notifications?limit=2&cursor=${first.data.pageInfo.nextCursor}`, {
          headers: auth(token),
        }),
      );
      expect(next.data.items).toHaveLength(1);
      expect(next.data.items[0].title).toBe('Notice 1');
      expect(next.data.pageInfo.hasMore).toBe(false);

      const target = first.data.items[0].id as number;
      expect(first.data.items[0].readAt).toBeNull();
      const marked = await json(
        await call(`/notifications/${target}/read`, { method: 'PATCH', headers: auth(token) }),
      );
      expect(marked.data.readAt).not.toBeNull();

      // Re-reading keeps the first timestamp rather than bumping it.
      const again = await json(
        await call(`/notifications/${target}/read`, { method: 'PATCH', headers: auth(token) }),
      );
      expect(again.data.readAt).toBe(marked.data.readAt);
    },
    TIMEOUT,
  );

  it(
    "will not let one user read another's notification, and says 404 not 403",
    async () => {
      const victim = await signUp();
      const attacker = await signUp();

      const [row] = await db
        .insert(notifications)
        .values({ userId: victim.userId, type: 'test', title: 'Private' })
        .returning({ id: notifications.id });

      const res = await call(`/notifications/${row?.id}/read`, {
        method: 'PATCH',
        headers: auth(attacker.token),
      });
      // 403 would confirm the id exists. Both answers have to be identical.
      expect(res.status).toBe(404);
      expect((await json(res)).error.code).toBe('NOTIF_001');
    },
    TIMEOUT,
  );

  it(
    'rejects a malformed cursor rather than silently ignoring it',
    async () => {
      const { token } = await signUp();
      const res = await call('/notifications?cursor=not-a-cursor', { headers: auth(token) });
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe('GEN_400');
    },
    TIMEOUT,
  );
});
