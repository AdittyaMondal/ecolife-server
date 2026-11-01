import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { verifyPassword } from '@common/auth/password.ts';
import { freshIpHeaders } from '@common/testing/client-ip.ts';
import { env } from '@config/env.ts';
import { db } from '@database/client.ts';
import { users } from '@database/schema/index.ts';
import { eq, sql } from 'drizzle-orm';
import { app } from '../../src/app.ts';

/**
 * POST /auth/google (PRD-v2 §6.1).
 *
 * Google is stubbed at `globalThis.fetch`, scoped to its two hosts and
 * delegating everything else, because the thing under test is what the server
 * does with Google's answers — not Google. `app.request()` is in-process and
 * never touches global fetch, so nothing else in the suite is affected.
 */

const TIMEOUT = 30_000;
const CLIENT_ID = env.GOOGLE_OAUTH_CLIENT_IDS[0] as string;

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
  // biome-ignore lint/suspicious/noExplicitAny: a test reads arbitrary response JSON
  data: any;
  // biome-ignore lint/suspicious/noExplicitAny: details differ per error code
  error: { code: string; message: string; details: any };
};
const json = async (r: Response) => (await r.json()) as unknown as Envelope;

const realFetch = globalThis.fetch;
const TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo';
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** Bun's types do not expose the DOM `RequestInfo` alias; take it from fetch. */
type FetchInput = Parameters<typeof globalThis.fetch>[0];

type Stub = {
  tokeninfo?: Record<string, unknown> | number;
  userinfo?: Record<string, unknown> | number;
};

/** Replaces fetch for the two Google endpoints. A number means "fail with this status". */
function stubGoogle(stub: Stub) {
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pick = url.startsWith(TOKENINFO)
      ? stub.tokeninfo
      : url.startsWith(USERINFO)
        ? stub.userinfo
        : undefined;
    if (pick === undefined) return realFetch(input, init);
    if (typeof pick === 'number') return new Response('{}', { status: pick });
    return Response.json(pick);
  }) as typeof globalThis.fetch;
}

/** The happy path: a token issued to OUR client, carrying a verified email. */
const good = (email: string, over: Record<string, unknown> = {}): Stub => ({
  tokeninfo: { aud: CLIENT_ID, scope: 'openid email profile', expires_in: 3599 },
  userinfo: {
    sub: '1234567890',
    email,
    email_verified: true,
    name: 'Asha Google',
    picture: 'https://lh3.googleusercontent.com/a/example=s96-c',
    ...over,
  },
});

const addr = () => `g-${crypto.randomUUID()}@example.test`;
const googleIn = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  call('/auth/google', { method: 'POST', headers, body: JSON.stringify(body) });

beforeAll(() => {
  if (!CLIENT_ID) throw new Error('GOOGLE_OAUTH_CLIENT_IDS must be set to run these tests');
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('POST /auth/google — first sign-in', () => {
  it(
    'creates a verified account and returns a session shaped like /auth/login',
    async () => {
      const email = addr();
      stubGoogle(good(email));

      const res = await googleIn(
        { accessToken: 'ya29.stub', timezone: 'Asia/Kolkata' },
        { 'x-ecolife-platform': 'ios' },
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.status).toBe(true);

      // Same shape as login: session + user.
      expect(typeof body.data.session.accessToken).toBe('string');
      expect(typeof body.data.session.accessTokenExpiresIn).toBe('number');
      // ios asked for it in the body.
      expect(typeof body.data.session.refreshToken).toBe('string');
      expect(body.data.user.email).toBe(email);
      expect(body.data.user.name).toBe('Asha Google');

      const [row] = await db.select().from(users).where(eq(users.email, email));
      expect(row).toBeDefined();
      // Google verified the address, so rewards are not gated (§4.4).
      expect(row?.emailVerifiedAt).not.toBeNull();
      expect(row?.timezone).toBe('Asia/Kolkata');
      expect(row?.avatarUrl).toBe('https://lh3.googleusercontent.com/a/example=s96-c');
    },
    TIMEOUT,
  );

  it(
    'stores no usable password, so /auth/login stays closed for the account',
    async () => {
      const email = addr();
      stubGoogle(good(email));
      expect((await googleIn({ accessToken: 'ya29.stub', timezone: 'UTC' })).status).toBe(200);
      globalThis.fetch = realFetch;

      const [row] = await db.select().from(users).where(eq(users.email, email));
      // NOT NULL is satisfied, but nothing verifies against it.
      expect(row?.passwordHash).toBeTruthy();
      expect(await verifyPassword('', row?.passwordHash ?? '')).toBe(false);
      expect(await verifyPassword('password', row?.passwordHash ?? '')).toBe(false);

      // And the HTTP path agrees.
      const login = await call('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password: 'correct horse battery staple' }),
      });
      expect(login.status).toBe(401);
    },
    TIMEOUT,
  );

  it(
    'falls back to the local-part when Google sends no name',
    async () => {
      const email = addr();
      stubGoogle(good(email, { name: undefined, given_name: undefined }));
      const body = await json(await googleIn({ accessToken: 'ya29.stub', timezone: 'UTC' }));
      expect(body.data.user.name).toBe(email.split('@')[0]);
    },
    TIMEOUT,
  );

  it(
    'refuses a non-https avatar rather than storing it',
    async () => {
      const email = addr();
      // An http or javascript: URL reaches an <img src> in both clients.
      stubGoogle(good(email, { picture: 'javascript:alert(1)' }));
      expect((await googleIn({ accessToken: 'ya29.stub', timezone: 'UTC' })).status).toBe(200);
      globalThis.fetch = realFetch;

      const [row] = await db.select().from(users).where(eq(users.email, email));
      expect(row?.avatarUrl).toBeNull();
    },
    TIMEOUT,
  );

  it(
    'delivers the refresh token as a cookie, not in the body, for a browser',
    async () => {
      const email = addr();
      stubGoogle(good(email));
      // No x-ecolife-platform header at all — treated as web.
      const res = await googleIn({ accessToken: 'ya29.stub', timezone: 'UTC' });
      expect(res.status).toBe(200);
      expect((await json(res)).data.session.refreshToken).toBeNull();
      expect(res.headers.getSetCookie().join(';')).toContain('ecolife_refresh');
    },
    TIMEOUT,
  );
});

describe('POST /auth/google — returning user', () => {
  it(
    'takes an UNVERIFIED account over, so a pre-registered address cannot be hijacked',
    async () => {
      // Register locally first, leaving the email unverified.
      const email = addr();
      const reg = await call('/auth/register', {
        method: 'POST',
        headers: { 'x-ecolife-platform': 'ios' },
        body: JSON.stringify({
          name: 'Local Signup',
          email,
          password: 'correct horse battery staple',
          timezone: 'UTC',
        }),
      });
      expect(reg.status).toBe(201);
      const userId = (await json(reg)).data.user.id as number;
      await db.update(users).set({ emailVerifiedAt: null }).where(eq(users.id, userId)).execute();

      const [before] = await db.select().from(users).where(eq(users.id, userId));
      const squatterHash = before?.passwordHash;

      stubGoogle(good(email));
      const res = await googleIn(
        { accessToken: 'ya29.stub', timezone: 'UTC' },
        { 'x-ecolife-platform': 'ios' },
      );
      expect(res.status).toBe(200);
      // The row and its data are kept — the verified owner inherits them.
      expect((await json(res)).data.user.id).toBe(userId);

      const [row] = await db.select().from(users).where(eq(users.id, userId));
      // Google proved the address, so the local verify-email step is satisfied.
      expect(row?.emailVerifiedAt).not.toBeNull();
      // The local name is kept; Google does not get to rename an account.
      expect(row?.name).toBe('Local Signup');

      /**
       * The attack this closes: whoever registered the address and never
       * verified it still knew the password. Adopting the row as-is would have
       * handed them the victim's account. The password must be gone.
       */
      expect(row?.passwordHash).not.toBe(squatterHash);
      const login = await call('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password: 'correct horse battery staple' }),
      });
      expect(login.status).toBe(401);
    },
    TIMEOUT,
  );

  it(
    'revokes the squatter\u2019s existing sessions when it takes the account over',
    async () => {
      const email = addr();
      const reg = await call('/auth/register', {
        method: 'POST',
        headers: { 'x-ecolife-platform': 'ios' },
        body: JSON.stringify({
          name: 'Squatter',
          email,
          password: 'correct horse battery staple',
          timezone: 'UTC',
        }),
      });
      expect(reg.status).toBe(201);
      const regBody = await json(reg);
      const userId = regBody.data.user.id as number;
      const squatterRefresh = regBody.data.session.refreshToken as string;
      await db.update(users).set({ emailVerifiedAt: null }).where(eq(users.id, userId)).execute();

      // The squatter's refresh token works right up to the takeover.
      const beforeTakeover = await call('/auth/refresh', {
        method: 'POST',
        headers: { 'x-ecolife-platform': 'ios' },
        body: JSON.stringify({ refreshToken: squatterRefresh }),
      });
      expect(beforeTakeover.status).toBe(200);
      const rotated = (await json(beforeTakeover)).data.refreshToken as string;

      stubGoogle(good(email));
      expect(
        (
          await googleIn(
            { accessToken: 'ya29.stub', timezone: 'UTC' },
            { 'x-ecolife-platform': 'ios' },
          )
        ).status,
      ).toBe(200);
      globalThis.fetch = realFetch;

      // ...and is dead afterwards. A session they already held is not a way
      // back into an account that has changed hands.
      const after = await call('/auth/refresh', {
        method: 'POST',
        headers: { 'x-ecolife-platform': 'ios' },
        body: JSON.stringify({ refreshToken: rotated }),
      });
      expect(after.status).toBe(401);
    },
    TIMEOUT,
  );

  it(
    'signs a VERIFIED account straight in, leaving its password alone',
    async () => {
      const email = addr();
      const password = 'correct horse battery staple';
      const reg = await call('/auth/register', {
        method: 'POST',
        headers: { 'x-ecolife-platform': 'ios' },
        body: JSON.stringify({ name: 'Verified Local', email, password, timezone: 'UTC' }),
      });
      expect(reg.status).toBe(201);
      const userId = (await json(reg)).data.user.id as number;
      // Both sides have proven the address, so this is the same person and
      // there is nothing to take over.
      await db
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(users.id, userId))
        .execute();

      stubGoogle(good(email));
      expect(
        (
          await googleIn(
            { accessToken: 'ya29.stub', timezone: 'UTC' },
            { 'x-ecolife-platform': 'ios' },
          )
        ).status,
      ).toBe(200);
      globalThis.fetch = realFetch;

      // Their password still works — we did not lock a legitimate user out.
      const login = await call('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      expect(login.status).toBe(200);
    },
    TIMEOUT,
  );

  it(
    'creates exactly one account when the same address signs in twice',
    async () => {
      const email = addr();
      stubGoogle(good(email));
      expect((await googleIn({ accessToken: 'ya29.stub', timezone: 'UTC' })).status).toBe(200);
      stubGoogle(good(email));
      expect((await googleIn({ accessToken: 'ya29.stub', timezone: 'UTC' })).status).toBe(200);
      globalThis.fetch = realFetch;

      const [count] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`);
      expect(count?.n).toBe(1);
    },
    TIMEOUT,
  );

  it(
    'matches case-insensitively, so Google casing cannot fork an account',
    async () => {
      const email = addr();
      stubGoogle(good(email));
      const first = await json(await googleIn({ accessToken: 'ya29.stub', timezone: 'UTC' }));

      stubGoogle(good(email.toUpperCase()));
      const second = await json(await googleIn({ accessToken: 'ya29.stub', timezone: 'UTC' }));
      expect(second.data.user.id).toBe(first.data.user.id);
    },
    TIMEOUT,
  );
});

describe('POST /auth/google — rejections are opaque', () => {
  const cases: [string, Stub][] = [
    [
      'a token issued to somebody else’s client',
      {
        tokeninfo: { aud: '000000000000-attacker.apps.googleusercontent.com' },
        userinfo: { email: 'victim@example.test', email_verified: true },
      },
    ],
    [
      'tokeninfo with no audience at all',
      {
        tokeninfo: { scope: 'email' },
        userinfo: { email: 'x@example.test', email_verified: true },
      },
    ],
    [
      'an unverified Google email',
      {
        tokeninfo: { aud: CLIENT_ID },
        userinfo: { email: 'x@example.test', email_verified: false },
      },
    ],
    [
      'no email on the token',
      { tokeninfo: { aud: CLIENT_ID }, userinfo: { email_verified: true } },
    ],
    ['a rejected token (tokeninfo 400)', { tokeninfo: 400, userinfo: 401 }],
    ['Google returning a server error', { tokeninfo: 500, userinfo: 500 }],
  ];

  for (const [name, stub] of cases) {
    it(
      `answers 401 AUTH_001 for ${name}`,
      async () => {
        stubGoogle(stub);
        const res = await googleIn({ accessToken: 'ya29.stub', timezone: 'UTC' });
        expect(res.status).toBe(401);
        const body = await json(res);
        // One message for every cause: which check failed is not the caller's
        // business, and saying would make this an oracle for probing client
        // ids and which addresses exist.
        expect(body.error.code).toBe('AUTH_001');
        expect(body.error.message).toBe('Google sign-in was not accepted.');
      },
      TIMEOUT,
    );
  }

  it(
    'never creates a user for a rejected token',
    async () => {
      const email = addr();
      stubGoogle({
        tokeninfo: { aud: 'not-ours.apps.googleusercontent.com' },
        userinfo: { email, email_verified: true },
      });
      expect((await googleIn({ accessToken: 'ya29.stub', timezone: 'UTC' })).status).toBe(401);
      globalThis.fetch = realFetch;

      const [count] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`);
      expect(count?.n).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'validates the body before calling Google',
    async () => {
      let called = false;
      globalThis.fetch = (async (...args: Parameters<typeof realFetch>) => {
        called = true;
        return realFetch(...args);
      }) as typeof globalThis.fetch;

      const res = await googleIn({ timezone: 'UTC' });
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe('GEN_400');
      // An empty or oversized body must not become an outbound request.
      expect(called).toBe(false);
    },
    TIMEOUT,
  );
});
