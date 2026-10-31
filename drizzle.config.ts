import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs under Node, which does not auto-load .env the way Bun does,
// so the npm scripts invoke it through `bun --bun`. Fail loudly rather than
// silently diffing against the wrong database.
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is not set. Run via `pnpm migration:generate`.');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './src/database/migrations',
  // Direct endpoint: drizzle-kit introspects and migrates, never pooled.
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
