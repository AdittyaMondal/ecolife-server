import { z } from 'zod';

/**
 * Zod schema over process.env. The server refuses to boot on invalid input
 * (PRD-v2 Appendix B: "A missing required variable is a startup failure, never
 * a silent fallback").
 *
 * Secrets for modules that do not exist yet are optional here and become
 * required as those modules land.
 */
const postgresUrl = z.string().refine((v) => /^postgres(ql)?:\/\//.test(v), {
  message: 'must be a postgres:// or postgresql:// connection string',
});

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  /** Direct endpoint — Drizzle migrations, pg_dump, LISTEN/NOTIFY. */
  DATABASE_URL: postgresUrl,
  /** Pooled (-pooler) endpoint — all application query traffic. */
  DATABASE_URL_POOLED: postgresUrl.optional(),

  /** Access token signing key. Required before the auth module lands. */
  JWT_SECRET: z.string().min(32).optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  SESSION_COOKIE_NAME: z.string().min(1).default('ecolife_refresh'),

  /**
   * Web origin(s) allowed by CORS. The mobile client is not
   * browser-origin-bound and needs no entry here.
   *
   * Comma-separated for more than one, e.g. the deployed site plus
   * http://localhost:3000 while developing against the hosted API.
   */
  APP_ORIGIN: z
    .string()
    .min(1)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  /**
   * This server's own public base URL, e.g. https://api.ecolife.app.
   *
   * Presentation only: it puts the real host at the top of the OpenAPI
   * `servers` list, so the "try it" button on /docs calls the deployment
   * instead of http://localhost:4000. Nothing routes on it, and leaving it
   * unset changes no behaviour.
   */
  PUBLIC_API_URL: z.string().url().optional(),

  /**
   * Shared secret proving a request came from our own Next server.
   *
   * Only a caller presenting this may assert the end user's IP via
   * `x-ecolife-client-ip`. Without it the server uses the socket address and
   * IGNORES any `x-forwarded-for`, because that header is attacker-controlled
   * and per-IP rate limits are what stand between /auth/login and a brute
   * force. Required once the rate limiter lands (SRV-06).
   */
  INTERNAL_PROXY_TOKEN: z.string().min(32).optional(),
  /** Number of proxy hops we actually operate, counted from the right of XFF. */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

  /**
   * Serve the browsable API reference at /docs.
   *
   * Its own flag, deliberately not keyed off NODE_ENV: turning the whole app
   * to 'development' just to get a docs page would also drop `secure` from
   * the refresh-token cookie, sending a 30-day credential over plain HTTP.
   * One switch, one effect.
   *
   * Set API_DOCS_TOKEN alongside it to require `?token=`. The page lists every
   * endpoint, parameter and shape, which is a free map for anyone probing.
   */
  ENABLE_API_DOCS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  API_DOCS_TOKEN: z.string().min(16).optional(),
  /** Deep-link scheme used by event passes: ecolife://pass/{code} */
  MOBILE_SCHEME: z.string().min(1).default('ecolife'),

  // --- Economy (PRD-v2 §4.3). Server-authoritative; clients only preview. ---
  COINS_PER_RUPEE: z.coerce.number().int().positive().default(10),
  MAX_DISCOUNT_PCT: z.coerce.number().int().min(1).max(100).default(20),

  // --- Not yet wired; required once their module lands ---
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('EcoLife <no-reply@ecolife.app>'),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    // Report names and reasons only — never the values.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    console.error(`Invalid environment. Refusing to boot.\n${issues}`);
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();

/** Pooled endpoint for app traffic; falls back to direct when not configured. */
export const appDatabaseUrl = env.DATABASE_URL_POOLED ?? env.DATABASE_URL;
