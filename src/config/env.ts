import { z } from 'zod';

/**
 * Zod schema over process.env. The server refuses to boot on invalid input
 * (PRD Appendix A: "A missing required variable is a startup failure, never a
 * silent fallback").
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

  SESSION_COOKIE_NAME: z.string().min(1).default('ecolife_session'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  APP_ORIGIN: z.string().min(1),

  // --- Not yet wired; required once their module lands ---
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_DAILY_TOKEN_BUDGET: z.coerce.number().int().positive().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  WHATSAPP_API_URL: z.string().optional(),
  WHATSAPP_INSTANCE_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  MERCHANT_NOTIFY_NUMBER: z.string().optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  AGENTHUB_URL: z.string().optional(),
  AGENTHUB_KEY: z.string().optional(),
  AGENTHUB_SIGNING_KEY: z.string().optional(),
  ELECTRICITY_MAPS_TOKEN: z.string().optional(),
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
