import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { freshIpHeaders } from '@common/testing/client-ip.ts';
import { db } from '@database/client.ts';
import {
  organizationMembers,
  organizations,
  rateLimits,
  sessions,
} from '@database/schema/index.ts';
import { and, eq, like, ne, sql } from 'drizzle-orm';
import { app } from '../../src/app.ts';

/**
 * Auth end to end, through the real Hono app against the real database.
 *
 * Deliberately exercises the failure paths, not just the happy one: the
 * happy path is the part that gets manually clicked anyway.
 */
const TIMEOUT = 30_000;
const PW = 'correct horse battery staple';
/** auth-strict is 10; the identifier-only bucket is 5x looser. */
const BUCKET_CEILING = 50;
const email = () => `authtest-${crypto.randomUUID()}@example.test`;

/**
 * Every request asserts its OWN client IP. Without this the whole suite
 * shares one loopback rate-limit bucket and exceeds /auth/register's limit
 * of 10 per 15 minutes. See src/common/testing/client-ip.ts.
 */
const call = (path: string, init: RequestInit = {}) =>
  app.request(`/api/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...freshIpHeaders(),
      ...(init.headers ?? {}),
    },
  });

type Envelope = {
  status: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads arbitrary response JSON; typing every shape here would duplicate the contract without checking it
  data: any;
  // biome-ignore lint/suspicious/noExplicitAny: same — details differ per error code
  error: { code: string; message: string; details: any };
};
const json = async (r: Response) => (await r.json()) as unknown as Envelope;

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
        // A guard, not `!`: biome's unsafe autofix rewrites `!` to `?.`, which
        // silently widens this to number | undefined and breaks the insert.
        if (!o) throw new Error('organization insert returned no row');
        return o.id;
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
    'charges the identifier bucket on a FAILED login but not on a successful one',
    async () => {
      const { addr } = await registerUser();
      const buckets = async () =>
        (
          await db
            .select({ subject: rateLimits.subject, count: rateLimits.count })
            .from(rateLimits)
            .where(like(rateLimits.subject, `%${addr.toLowerCase()}%`))
        ).reduce((n, r) => n + r.count, 0);

      await db.execute(sql`delete from rate_limits`);

      await call('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: addr, password: 'definitely wrong' }),
      });
      const afterFailure = await buckets();
      expect(afterFailure).toBeGreaterThan(0);

      await call('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: addr, password: PW }),
      });
      // The whole point of the fix: typing your password correctly must never
      // move you closer to being locked out. Anyone who knows your address could
      // otherwise block you with ten bad guesses.
      expect(await buckets()).toBe(afterFailure);
    },
    TIMEOUT,
  );

  it(
    'blocks once the identifier bucket is genuinely exhausted',
    async () => {
      const { addr } = await registerUser();
      await db.execute(sql`delete from rate_limits`);

      // Drive the loose identifier bucket to its ceiling directly. Doing this
      // through HTTP would mean 50+ argon2 verifies, which is slow for no extra
      // coverage — the route's wiring is asserted by the test above.
      const { consumeFailedAttempt } = await import('@common/middleware/rate-limit.ts');
      const fakeCtx = { req: { header: () => undefined }, env: undefined } as never;

      let blocked = false;
      let retryAfter = 0;
      for (let i = 0; i < BUCKET_CEILING + 2 && !blocked; i++) {
        try {
          await consumeFailedAttempt(fakeCtx, addr, {
            name: 'auth-strict',
            limit: 10,
            windowSeconds: 900,
          });
        } catch (e) {
          blocked = true;
          retryAfter =
            (e as { details?: { retryAfterSeconds?: number } }).details?.retryAfterSeconds ?? 0;
        }
      }
      expect(blocked).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});

describe('rotation is atomic under concurrency', () => {
  it(
    'lets exactly one of ten simultaneous rotations win, and revokes the family',
    async () => {
      const { startSession, rotateSession } = await import('@common/auth/session.ts');
      const { body } = await registerUser();
      const userId = body.data.user.id as number;

      const { refreshToken, familyId } = await startSession(userId, 'ios');
      // The bug this guards: a read-then-write let two concurrent requests both
      // see revoked_at IS NULL, both pass the check and both rotate — producing
      // two live tokens and silently defeating reuse detection. That race IS the
      // attack, because a stolen token used at the same moment as the victim's
      // would go unnoticed.
      const results = await Promise.all(
        Array.from({ length: 10 }, () => rotateSession(refreshToken)),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.reason === 'reused')).toHaveLength(9);

      // Scoped to THIS family. The registration session is a separate family
      // and must survive — revoking it would mean one compromised token logged
      // the user out of unrelated devices.
      const family = await db.select().from(sessions).where(eq(sessions.familyId, familyId));
      expect(family.length).toBeGreaterThan(1);
      expect(family.every((r) => r.revokedAt !== null)).toBe(true);

      const others = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, userId), ne(sessions.familyId, familyId)));
      expect(others.some((r) => r.revokedAt === null)).toBe(true);
    },
    TIMEOUT,
  );
});

describe('brute force is blocked even when the guess is right', () => {
  it(
    'rejects a correct password once that attacker has spent the account bucket',
    async () => {
      const { assertNotLockedOut, consumeFailedAttempt, isExhausted, identifierIpSubject } =
        await import('@common/middleware/rate-limit.ts');
      await db.execute(sql`delete from rate_limits`);

      const victim = `victim-${crypto.randomUUID()}@example.test`;
      const bucket = { name: 'auth-strict', limit: 10, windowSeconds: 900 };

      // One attacker, one victim account.
      const attacker = {
        req: { header: () => undefined },
        env: { requestIP: () => ({ address: '203.0.113.9' }) },
      } as never;

      for (let i = 0; i < bucket.limit; i++) {
        await consumeFailedAttempt(attacker, victim, bucket);
      }

      const subject = identifierIpSubject('login', victim, '203.0.113.9');
      expect(subject).not.toBeNull();
      expect(await isExhausted(subject as string, bucket)).toBe(true);

      // The regression this guards: charging only on failure removed the
      // pre-check, so the eleventh guess — including a CORRECT one — would have
      // sailed through. A right answer reached by brute force is still brute
      // force.
      let blocked = false;
      try {
        await assertNotLockedOut(attacker, victim, bucket);
      } catch {
        blocked = true;
      }
      expect(blocked).toBe(true);

      // ...and the victim signing in from their own machine is unaffected,
      // which is the whole reason the bucket is keyed on identifier+IP.
      const elsewhere = {
        req: { header: () => undefined },
        env: { requestIP: () => ({ address: '198.51.100.4' }) },
      } as never;
      let victimBlocked = false;
      try {
        await assertNotLockedOut(elsewhere, victim, bucket);
      } catch {
        victimBlocked = true;
      }
      expect(victimBlocked).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'still has teeth when no client IP can be determined',
    async () => {
      const { assertNotLockedOut, consumeFailedAttempt } = await import(
        '@common/middleware/rate-limit.ts'
      );
      await db.execute(sql`delete from rate_limits`);

      const victim = `noip-${crypto.randomUUID()}@example.test`;
      const bucket = { name: 'auth-strict', limit: 10, windowSeconds: 900 };

      // No requestIP and no trusted proxy header: the per-IP limiter skips and
      // the tight identifier+IP bucket cannot even be keyed. Before the loose
      // fallback existed, that combination meant UNLIMITED password guesses.
      const unknown = { req: { header: () => undefined }, env: undefined } as never;

      let blockedEarly = false;
      try {
        await assertNotLockedOut(unknown, victim, bucket);
      } catch {
        blockedEarly = true;
      }
      expect(blockedEarly).toBe(false);

      // The loose bucket is 5x, so it takes 50 failures, not 10.
      for (let i = 0; i < bucket.limit * 5; i++) {
        await consumeFailedAttempt(unknown, victim, bucket);
      }

      let blocked = false;
      try {
        await assertNotLockedOut(unknown, victim, bucket);
      } catch {
        blocked = true;
      }
      expect(blocked).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'keeps register and login buckets apart, so neither can lock the other',
    async () => {
      const { assertIdentifierNotLockedOut, consumeIdentifier } = await import(
        '@common/middleware/rate-limit.ts'
      );
      await db.execute(sql`delete from rate_limits`);

      const addr = `scoped-${crypto.randomUUID()}@example.test`;
      const bucket = { name: 'auth-strict', limit: 10, windowSeconds: 900 };
      const attacker = {
        req: { header: () => undefined },
        env: { requestIP: () => ({ address: '203.0.113.77' }) },
      } as never;

      // Spend the whole register budget for this address, tight and loose.
      // `consume` throws as soon as the tight bucket (10) is full, long before
      // the loose one (50) is — swallow that and keep charging, because the
      // claim under test is about which SCOPE is affected, not when it trips.
      for (let i = 0; i < bucket.limit * 5; i++) {
        await consumeIdentifier(attacker, 'register', addr, bucket).catch(() => {});
      }

      let registerBlocked = false;
      try {
        await assertIdentifierNotLockedOut(attacker, 'register', addr, bucket);
      } catch {
        registerBlocked = true;
      }
      expect(registerBlocked).toBe(true);

      // Login must be untouched: sharing one bucket would mean anyone able to
      // hammer /register could lock an existing account out of /login.
      let loginBlocked = false;
      try {
        await assertIdentifierNotLockedOut(attacker, 'login', addr, bucket);
      } catch {
        loginBlocked = true;
      }
      expect(loginBlocked).toBe(false);
    },
    TIMEOUT,
  );
});
