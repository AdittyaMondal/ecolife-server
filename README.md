# ecolife-server

API and domain layer for **EcoLife** — a personal carbon-footprint tracker with social
gamification. Bun + Hono + Drizzle + PostgreSQL (Neon).

This is one of two independent repositories. The other, `ecolife-app` (Next.js), owns
rendering and the PWA, and talks to this server over HTTP. The product spec is `../PRD.md`.

> **Status: foundation only.** Env config, database connection, Hono app, response envelope
> and a health module. **The data model is being redesigned — the schema is empty and the
> database has no tables.** See [CLAUDE.md](./CLAUDE.md) §2.

## Requirements

- [Bun](https://bun.sh) 1.2+
- [pnpm](https://pnpm.io) 12+
- A PostgreSQL database (Neon)

## Setup

```bash
pnpm install
cp .env.example .env     # then fill in DATABASE_URL and DATABASE_URL_POOLED
pnpm dev
```

`.env` is gitignored and must never be committed.

### Connection strings

Two are needed, both from the Neon console:

| Variable | Endpoint | Used by |
|---|---|---|
| `DATABASE_URL` | direct | migrations, `pg_dump`, `LISTEN/NOTIFY` |
| `DATABASE_URL_POOLED` | `-pooler` | all application traffic |

Pin `sslmode=verify-full`. See [CLAUDE.md](./CLAUDE.md) §6 for why.

## Adding the schema

The schema barrel is intentionally empty. To add the new core:

1. Write one file per table in `src/database/schema/`, following the conventions in
   [CLAUDE.md](./CLAUDE.md) §4.3 and PRD §10.
2. Re-export each from `src/database/schema/index.ts`.
3. `pnpm migration:generate` — review the generated SQL.
4. `pnpm migration:apply`.

Migrations are committed and forward-only. Never hand-edit generated SQL.

## Scripts

| Command | Does |
|---|---|
| `pnpm dev` | Watch-mode server on :4000 |
| `pnpm start` | Run once |
| `pnpm build` | Typecheck, then bundle to `dist/` |
| `pnpm typecheck` | Types only |
| `pnpm lint` / `pnpm format` | Biome, check / write |
| `pnpm test` | `bun test` |
| `pnpm migration:generate` | Diff schema → new SQL migration |
| `pnpm migration:apply` | Apply pending migrations |
| `pnpm db:studio` | Drizzle Studio |

## Endpoints

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/v1/health` | Liveness. Touches nothing. |
| `GET` | `/api/v1/health/ready` | Readiness. Runs `select 1`; 503 if Postgres is unreachable. |

Every response uses one envelope:

```jsonc
// success
{ "status": true,  "data": { }, "error": null }
// failure
{ "status": false, "data": null, "error": { "code": "HEALTH_001", "message": "…", "details": {} } }
```

## Layout

```
src/
  app.ts           Hono root, middleware chain, route mounting
  main.ts          Bun.serve entrypoint
  common/          envelope · errors · filters   (auth/guards/carbon/… scaffolded, empty)
  config/env.ts    zod over process.env; refuses to boot if invalid
  database/
    client.ts      pooled Pool + Drizzle
    migrate.ts     direct connection, forward-only
    schema/        EMPTY — one file per table goes here
    migrations/    EMPTY — generated SQL, committed
  modules/health/  liveness + readiness
test/integration/  connection layer + envelope
```

## Contributing

Read [CLAUDE.md](./CLAUDE.md) first. Before opening a PR:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```
