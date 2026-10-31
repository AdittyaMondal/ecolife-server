import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { db } from '@database/client.ts';
import { organizationMembers, organizations, users } from '@database/schema/index.ts';
import { eq, like, sql } from 'drizzle-orm';
import { app } from '../../src/app.ts';

/**
 * Auth end to end, through the real Hono app against the real database.
 *
 * Deliberately exercises the failure paths, not just the happy one: the
 * happy path is the part that gets manually clicked anyway.
 */
const TIMEOUT = 30_000;
const PW = 'correct horse battery staple';
const email = () => `authtest-${crypto.randomUUID()}@example.test`;

const call = (path: string, init: RequestInit = {}) =>
  app.request(`/api/v1${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

const json = async (r: Response) => (await r.json()) as { status: boolean; data: any; error: any };

async function registerUser(extra: Record<string, unknown> = {}) {
  const addr = email();
  const res = await call('/auth/register', {
    method: 'POST',
    headers: { 'x-ecolife-platform': 'ios' },
    body: JSON.stringify({
      name: 'Auth Probe',
      email: addr,
      password: PW,
      timezone: 'Asia/Kolkata',
      ...extra,
    }),
  });
  return { addr, res, body: await json(res) };
}

beforeAll(async () => {
  await db.execute(sql`delete from users where email like 'authtest-%@example.test'`);
}, TIMEOUT);

/**
 * Every test here shares one IP bucket, and auth-strict is 10 per 15 minutes,
 * so without this the eleventh request in the FILE fails rather than the
 * eleventh in a test. Clearing per test keeps them independent while leaving
 * the limiter switched on — it is still asserted explicitly below, rather than
 * disabled in the test environment and never exercised.
 */
beforeEach(async () => {
  await db.execute(sql`delete from rate_limits`);
}, TIMEOUT);

afterAll(async () => {
  await db.execute(sql`delete from organizations where slug like 'authtest-%'`);
  await db.execute(sql`delete from users where email like 'authtest-%@example.test'`);
}, TIMEOUT);

describe('register', () => {
  it(
    'creates an account and returns a session',
    async () => {
      const { res, body } = await registerUser();
      expect(res.status).toBe(201);
      expect(body.status).toBe(true);
      expect(body.data.session.accessToken.length).toBeGreaterThan(20);
      expect(body.data.user.emailVerified).toBe(false);
      expect(body.data.user.organization).toBeNull();
    },
    TIMEOUT,
  );

  it(
    'rejects a duplicate email regardless of case',
    async () => {
      const { addr } = await registerUser();
      const res = await call('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Clash',
          email: addr.toUpperCase(),
          password: PW,
          timezone: 'Asia/Kolkata',
        }),
      });
      expect(res.status).toBe(409);
      expect((await json(res)).error.code).toBe('AUTH_005');
    },
    TIMEOUT,
  );

  it(
    'rejects a short password at the contract boundary',
    async () => {
      const res = await call('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name: 'X', email: email(), password: 'short', timezone: 'UTC' }),
      });
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe('GEN_400');
    },
    TIMEOUT,
  );
});

describe('login', () => {
  it(
    'signs in with the right password',
    async () => {
      const { addr } = await registerUser();
      const res = await call('/auth/login', {
        method: 'POST',
        headers: { 'x-ecolife-platform': 'ios' },
        body: JSON.stringify({ email: addr, password: PW }),
      });
      expect(res.status).toBe(200);
      expect((await json(res)).data.session.refreshToken).toBeTruthy();
    },
    TIMEOUT,
  );

  it(
    'gives an identical answer for a wrong password and an unknown account',
    async () => {
      const { addr } = await registerUser();
      const wrong = await call('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: addr, password: `${PW} nope` }),
      });
      const unknown = await call('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: email(), password: PW }),
      });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      // Identical code AND message: anything that differs is an enumeration oracle.
      expect((await json(wrong)).error).toEqual((await json(unknown)).error);
    },
    TIMEOUT,
  );

  it(
    'web gets an httpOnly cookie and NO token in the body',
    async () => {
      const { addr } = await registerUser();
      const res = await call('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: addr, password: PW }),
      });
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toContain('HttpOnly');
      // Returning it in the body to a browser would hand any XSS a 30-day credential.
      expect((await json(res)).data.session.refreshToken).toBeNull();
    },
    TIMEOUT,
  );
});

describe('refresh rotation and reuse detection', () => {
  it(
    'rotates, and revokes the whole family when an old token comes back',
    async () => {
      const { body } = await registerUser();
      const first = body.data.session.refreshToken as string;

      const r1 = await call('/auth/refresh', {
        method: 'POST',
        headers: { 'x-ecolife-platform': 'ios' },
        body: JSON.stringify({ refreshToken: first }),
      });
      expect(r1.status).toBe(200);
      const second = (await json(r1)).data.refreshToken as string;
      expect(second).not.toBe(first);

      // Replaying the first token is the signature of a stolen credential.
      const replay = await call('/auth/refresh', {
        method: 'POST',
        headers: { 'x-ecolife-platform': 'ios' },
        body: JSON.stringify({ refreshToken: first }),
      });
      expect(replay.status).toBe(401);
      expect((await json(replay)).error.details.reason).toBe('reused');

      // ...and the legitimate successor dies with it. Logging the real user out
      // is the only signal they get that something was wrong.
      const after = await call('/auth/refresh', {
        method: 'POST',
        headers: { 'x-ecolife-platform': 'ios' },
        body: JSON.stringify({ refreshToken: second }),
      });
      expect(after.status).toBe(401);
    },
    TIMEOUT,
  );
});

describe('guards', () => {
  it(
    '401s /me without a token, 200s with one',
    async () => {
      expect((await call('/auth/me')).status).toBe(401);
      const { body } = await registerUser();
      const res = await call('/auth/me', {
        headers: { Authorization: `Bearer ${body.data.session.accessToken}` },
      });
      expect(res.status).toBe(200);
      expect((await json(res)).data.email).toContain('authtest-');
    },
    TIMEOUT,
  );

  it(
    '401s a tampered token',
    async () => {
      const { body } = await registerUser();
      const t = body.data.session.accessToken as string;
      const res = await call('/auth/me', {
        headers: { Authorization: `Bearer ${t.slice(0, -2)}xx` },
      });
      expect(res.status).toBe(401);
    },
    TIMEOUT,
  );
});

describe('organization membership', () => {
  it(
    'reports the org on /me, and a pending org is reported as pending',
    async () => {
      const { body } = await registerUser();
      const userId = body.data.user.id as number;

      const [org] = await db
        .insert(organizations)
        .values({
          slug: `authtest-${crypto.randomUUID().slice(0, 8)}`,
          name: `Authtest Industries ${crypto.randomUUID().slice(0, 6)}`,
          type: 'industry',
        })
        .returning();
      if (!org) throw new Error('org insert returned nothing');
      await db
        .insert(organizationMembers)
        .values({ organizationId: org.id, userId, role: 'owner' })
        .execute();

      const res = await call('/auth/me', {
        headers: { Authorization: `Bearer ${body.data.session.accessToken}` },
      });
      const me = (await json(res)).data;
      expect(me.organization.type).toBe('industry');
      expect(me.organization.role).toBe('owner');
      // Default status is 'pending' — a claim, not a credential.
      expect(me.organization.status).toBe('pending');
    },
    TIMEOUT,
  );

  it(
    'allows only one organization per user',
    async () => {
      const { body } = await registerUser();
      const userId = body.data.user.id as number;
      const mk = async () => {
        const [o] = await db
          .insert(organizations)
          .values({
            slug: `authtest-${crypto.randomUUID().slice(0, 8)}`,
            name: `Authtest NGO ${crypto.randomUUID().slice(0, 6)}`,
            type: 'ngo',
          })
          .returning();
        return o!.id;
      };
      await db
        .insert(organizationMembers)
        .values({ organizationId: await mk(), userId })
        .execute();

      let err: unknown;
      try {
        await db
          .insert(organizationMembers)
          .values({ organizationId: await mk(), userId })
          .execute();
      } catch (e) {
        err = e;
      }
      expect((err as { cause?: { constraint?: string } })?.cause?.constraint).toBe(
        'one_org_per_user',
      );
    },
    TIMEOUT,
  );
});

describe('password reset', () => {
  it(
    'answers identically for a known and an unknown address',
    async () => {
      const { addr } = await registerUser();
      const known = await call('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: addr }),
      });
      const unknown = await call('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: email() }),
      });
      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect((await json(known)).data).toEqual((await json(unknown)).data);
    },
    TIMEOUT,
  );
});

describe('rate limiting', () => {
  it(
    'blocks repeated login attempts on one account with a Retry-After hint',
    async () => {
      const { addr } = await registerUser();
      let blocked = 0;
      let retryAfter = 0;
      // authStrict is 10/15min, keyed on IP AND on the submitted identifier.
      for (let i = 0; i < 14; i++) {
        const res = await call('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: addr, password: 'wrong wrong wrong' }),
        });
        if (res.status === 429) {
          blocked++;
          retryAfter = (await json(res)).error.details.retryAfterSeconds;
        }
      }
      expect(blocked).toBeGreaterThan(0);
      expect(retryAfter).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});
