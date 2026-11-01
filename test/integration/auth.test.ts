import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { freshIpHeaders } from '@common/testing/client-ip.ts';
import { db } from '@database/client.ts';
import {
  organizationMembers,
  organizations,
  rateLimits,
  sessions,
} from '@database/schema/index.ts';
import { and, eq, isNotNull, like, ne, sql } from 'drizzle-orm';
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
        // NINE characters, deliberately. The previous value was 'short' (5),
        // which is rejected at a minimum of 10 AND at 6 — so this test sat
        // green straight through passwordSchema being lowered to 6 and could
        // never have caught it. One below the limit is the only value that
        // actually asserts the limit.
        body: JSON.stringify({
          name: 'X',
          email: email(),
          password: 'abcdefghi',
          timezone: 'UTC',
        }),
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
    'rotates, and treats an immediate replay as a race rather than a theft',
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

      /**
       * An IMMEDIATE replay is inside the 10s grace window, and the server
       * cannot tell it from a second browser tab racing itself — so it is
       * refused as AUTH_009 and the family survives.
       *
       * This is the deliberate cost of the grace window. It used to assert a
       * 401 and a burned family, which was the behaviour that signed users out
       * of every device for opening a second tab. The theft case has not been
       * given up: a replay from OUTSIDE the window still burns everything, and
       * that is asserted in 'still burns the family for a replay from outside
       * the grace window' below.
       */
      const replay = await call('/auth/refresh', {
        method: 'POST',
        headers: { 'x-ecolife-platform': 'ios' },
        body: JSON.stringify({ refreshToken: first }),
      });
      expect(replay.status).toBe(409);
      expect((await json(replay)).error.details.reason).toBe('raced');

      // ...and the legitimate successor LIVES. That is the fix.
      const after = await call('/auth/refresh', {
        method: 'POST',
        headers: { 'x-ecolife-platform': 'ios' },
        body: JSON.stringify({ refreshToken: second }),
      });
      expect(after.status).toBe(200);
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
          code: String(Math.floor(100000 + Math.random() * 900000)),
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
            code: String(Math.floor(100000 + Math.random() * 900000)),
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
    'lets exactly one of ten simultaneous rotations win, and keeps the user signed in',
    async () => {
      const { startSession, rotateSession } = await import('@common/auth/session.ts');
      const { body } = await registerUser();
      const userId = body.data.user.id as number;

      const { refreshToken, familyId } = await startSession(userId, 'ios');
      // Two things are being guarded here, and they pull in opposite directions.
      //
      // Atomicity: a read-then-write let two concurrent requests both see
      // revoked_at IS NULL, both pass the check and both rotate — two live
      // tokens, and reuse detection silently defeated. Exactly one must win.
      //
      // But the losers are NOT an attack. The web app holds one refresh cookie
      // and each tab is its own JS context, so a second tab produces exactly
      // this race on a page load. Burning the family here logged people out of
      // every device for opening a second tab — measured as one 200, one 401
      // and zero live sessions. Losers are now `raced`, and the family lives.
      const results = await Promise.all(
        Array.from({ length: 10 }, () => rotateSession(refreshToken)),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.reason === 'raced')).toHaveLength(9);
      expect(results.filter((r) => !r.ok && r.reason === 'reused')).toHaveLength(0);

      // The winner's new token is live, so the user is still signed in.
      const family = await db.select().from(sessions).where(eq(sessions.familyId, familyId));
      expect(family.length).toBeGreaterThan(1);
      expect(family.filter((r) => r.revokedAt === null)).toHaveLength(1);

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
      // A smaller bucket than production's. The claim under test is that the
      // loose fallback is CONSULTED when no IP is available, not what the
      // ceiling happens to be — and at this latency fifty sequential charges
      // is thirty seconds of round trips for no extra coverage.
      const bucket = { name: 'auth-strict-noip', limit: 2, windowSeconds: 900 };

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

/**
 * The bug: opening the web app in a second tab signed the user out of every
 * device. One refresh cookie, two JS contexts, two concurrent rotations — the
 * loser was treated as a replayed stolen token and burned the family.
 *
 * The fix is a 10s grace window, so these tests have to hold BOTH ends: a race
 * must not sign anyone out, and a genuine replay must still burn.
 */
describe('a racing refresh does not sign the user out', () => {
  it(
    'keeps the session alive when two tabs refresh the same cookie at once',
    async () => {
      const { body } = await registerUser();
      const userId = body.data.user.id as number;
      const first = body.data.session.refreshToken as string;

      const live = async () =>
        (await db.select().from(sessions).where(eq(sessions.userId, userId))).filter(
          (r) => r.revokedAt === null,
        ).length;

      expect(await live()).toBe(1);

      const [a, b] = await Promise.all([
        call('/auth/refresh', {
          method: 'POST',
          headers: { 'x-ecolife-platform': 'ios' },
          body: JSON.stringify({ refreshToken: first }),
        }),
        call('/auth/refresh', {
          method: 'POST',
          headers: { 'x-ecolife-platform': 'ios' },
          body: JSON.stringify({ refreshToken: first }),
        }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);

      // 409 + AUTH_009, NOT 401 — a client must never read this as a sign-out.
      const loser = a.status === 409 ? a : b;
      expect((await json(loser)).error.code).toBe('AUTH_009');

      // The whole point: the user is still signed in, on exactly one token.
      expect(await live()).toBe(1);

      const winner = a.status === 200 ? a : b;
      const rotated = (await json(winner)).data.refreshToken as string;
      const again = await call('/auth/refresh', {
        method: 'POST',
        headers: { 'x-ecolife-platform': 'ios' },
        body: JSON.stringify({ refreshToken: rotated }),
      });
      expect(again.status).toBe(200);
    },
    TIMEOUT,
  );

  it(
    'still burns the family for a replay from outside the grace window',
    async () => {
      const { startSession, rotateSession } = await import('@common/auth/session.ts');
      const { body } = await registerUser();
      const userId = body.data.user.id as number;
      const { refreshToken, familyId } = await startSession(userId, 'ios');

      const rotated = await rotateSession(refreshToken);
      expect(rotated.ok).toBe(true);

      // Age the spent token past the window instead of sleeping ten seconds.
      // This is the theft case: a token copied earlier and replayed later.
      // Only the SPENT row. Backdating the whole family would revoke the
      // winner's live token too, and the test would then pass for the wrong
      // reason — it must be the grace window that expires, not the session.
      await db
        .update(sessions)
        .set({ revokedAt: new Date(Date.now() - 60_000) })
        .where(and(eq(sessions.familyId, familyId), isNotNull(sessions.revokedAt)))
        .execute();

      const replay = await rotateSession(refreshToken);
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.reason).toBe('reused');

      // Every token in the family is dead — the control that matters is intact.
      const family = await db.select().from(sessions).where(eq(sessions.familyId, familyId));
      expect(family.every((r) => r.revokedAt !== null)).toBe(true);
    },
    TIMEOUT,
  );
});
