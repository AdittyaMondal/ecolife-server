# CLAUDE.md — ecolife-server

Instructions for AI agents working in this repository. Read this before writing code.

---

## 1. What this repo is

`ecolife-server` is the **API and domain layer** for EcoLife, a personal carbon-footprint
tracker with social gamification. It owns **data, domain rules, auth, jobs and MCP**. It
renders nothing.

**This is not a monorepo.** There are two independent repositories:

| Repo | Owns | Runtime | Port |
|---|---|---|---|
| `ecolife-server` (this one) | data, domain rules, auth, jobs, MCP | Bun | 4000 |
| `ecolife-app` | rendering, PWA, UX | Node 22 / Next.js 16 | 3000 |

`ecolife-app` does not exist yet. When it does, it talks to this server through
`backendFetch()` and never queries Postgres directly.

### The PRD is the source of truth

`../PRD.md` (**outside this repo**, in the parent planning folder) is the authoritative spec —
~2800 lines covering the legacy system as-built, the target schema, the API surface, the
carbon formulas and the phasing. **When this file and the PRD disagree, the PRD wins.**

Markers used throughout the PRD:

- `[AS-BUILT]` — current behaviour of the legacy Laravel app. Parity target.
- `[CHANGE]` — deliberate divergence from legacy.
- `[NEW]` — does not exist today.

Before implementing a module, read its PRD section **and** its row in Appendix B (legacy
source map), which names the Laravel file the behaviour came from.

---

## 2. Current state — read this before assuming something exists

> **The data model is being redesigned.** The schema is deliberately empty and the database
> holds no tables. Do not resurrect the old identity tables from git history — wait for the
> new core.

What exists:

- Env config, zod-validated, fails fast at boot
- Drizzle client on the **pooled** endpoint; migrator on the **direct** endpoint
- An empty schema barrel at `src/database/schema/index.ts`
- Hono app with request-id, logging, secure headers, CORS
- Response envelope, typed `DomainError`, error and not-found filters
- `health` module — liveness + readiness
- Tests covering the connection layer and the envelope

**What does not exist:** any table, any migration, auth, guards, the carbon engine, every
domain module, jobs, WebSocket, AgentHub, seeds. Directories for them are scaffolded and
empty. Do not claim otherwise, and do not import from them.

The database is live and reachable, but has **zero tables**. `pnpm migration:generate` will
report nothing to do until the new schema is written.

---

## 3. Commands

| Command | Does |
|---|---|
| `pnpm dev` | Watch-mode server on :4000 |
| `pnpm start` | Run once, no watch |
| `pnpm build` | `tsc --noEmit` then bundle to `dist/` |
| `pnpm typecheck` | Types only |
| `pnpm lint` | Biome check (no writes) |
| `pnpm format` | Biome check with `--write` |
| `pnpm test` | `bun test` |
| `pnpm migration:generate` | Diff schema → new SQL migration |
| `pnpm migration:apply` | Apply pending migrations (direct connection) |
| `pnpm db:studio` | Drizzle Studio |

`npm run <script>` also works; dependencies are installed with **pnpm**.

### Before claiming work is done

Run all four. Do not report success on a subset:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

---

## 4. Non-negotiable rules

### 4.1 Every response uses the envelope

PRD §9.5. Never return a bare object.

```ts
// success
{ "status": true,  "data": { }, "error": null }
// failure
{ "status": false, "data": null, "error": { "code": "CARBON_014", "message": "…", "details": {} } }
```

Use `ok()` / `fail()` from `@common/interceptors/response-envelope.ts`. To fail from inside a
service, `throw new DomainError(code, message, status, details)` — the error filter maps it.
Error codes are `DOMAIN_NNN`.

**Never leak an internal error message or stack to the client.** Anything that is not a
`DomainError` becomes a generic `INTERNAL_001` 500, and the real error is logged server-side.

### 4.2 Pooled for traffic, direct for migrations

This is a Neon correctness rule, not a preference.

| Work | Connection | Where |
|---|---|---|
| All request traffic | **pooled** (`-pooler` host) | `DATABASE_URL_POOLED` → `@database/client.ts` |
| Migrations, `pg_dump`, `LISTEN/NOTIFY`, session-state work | **direct** | `DATABASE_URL` → `@database/migrate.ts` |

Driver is `node-postgres` (`pg`) with a reused `Pool`. This is correct for a long-running
server. **Do not switch to `@neondatabase/serverless`** — that driver is for serverless/edge
runtimes, which this is not.

There is a test asserting both the pooled routing and `sslmode=verify-full`. If you change the
connection layer and that test fails, the test is probably right.

### 4.3 Schema conventions — for the new core

- **One file per table** in `src/database/schema/`, re-exported from `index.ts`.
- `snake_case` columns, `id` as `bigserial`, `timestamptz` everywhere.
- Money-like integers are `integer` with a `CHECK >= 0`.
- Soft-delete (`deletedAt`) only where a UI needs it.
- Migrations are **generated, committed and forward-only**. Never hand-edit a generated SQL
  file, and never run ad-hoc DDL against the database.
- `enums.ts` is mirrored into `ecolife-app` by codegen (PRD §9.4). Keep declarations literal
  and one value per line so the parser can read them.
- Cite the PRD section in a comment at the top of each table file.

### 4.4 Module file convention

PRD §9.2. One concern per file, the same five names in every module:

| File | Responsibility |
|---|---|
| `x.routes.ts` | Hono router: path, method, guards, zod validation. Calls the service. **No business logic.** |
| `x.service.ts` | Business rules. Framework-free, directly unit-testable. |
| `x.repository.ts` | Every Drizzle query for this module. **No other module queries these tables.** |
| `x.schema.ts` | Zod request/response schemas — the module's wire contract. |
| `x.service.spec.ts` | Colocated `bun test` spec. |

Hono routers, not a decorator framework.

### 4.5 Env

Every variable is declared in `src/config/env.ts` and parsed at boot. A missing **required**
variable is a startup failure, never a silent fallback. When you add a variable:

1. Add it to the zod schema in `src/config/env.ts`.
2. Add it to `.env.example` by **name only** — never a value.
3. Read it via `import { env } from '@config/env.ts'`, never `process.env` directly.

Secrets for modules that do not exist yet are `.optional()` and become required when the
module lands.

### 4.6 Secrets

- `.env` is gitignored. Keep it that way.
- Never print a connection string, API key or token — not in logs, errors, test output or a
  commit. `env.ts` reports failing variable **names and reasons only**.
- Never write a real credential into `.env.example`, a test fixture, a comment or this file.

### 4.7 Auth, when you build it

PRD §9.6 mandates: `Bun.password.hash` (argon2id) + an opaque 32-random-byte base64url token
in an httpOnly, `SameSite=Lax`, Secure cookie, backed by a `sessions` table. ~80 lines, zero
dependencies. A `role` column replaces the legacy shared admin PIN — do not reintroduce a PIN.

---

## 5. Path aliases

Declared in `tsconfig.json`; Bun resolves them natively.

```
@common/*    → src/common/*
@config/*    → src/config/*
@database/*  → src/database/*
@modules/*   → src/modules/*
@types/*     → src/types/*
```

Imports carry the `.ts` extension (`allowImportingTsExtensions`).

**One exception:** files under `src/database/schema/` use **relative** imports. `drizzle-kit`
loads the schema barrel through esbuild, which does not resolve tsconfig paths. Aliases there
break `migration:generate`.

---

## 6. Gotchas already paid for

Hard-won; do not rediscover them.

- **`pnpm install` and esbuild.** pnpm 12 blocks postinstall scripts. The setting lives in
  `pnpm-workspace.yaml` as `allowBuilds: { esbuild: true }` — **not** `onlyBuiltDependencies`,
  and **not** in `package.json`. Written by `pnpm approve-builds esbuild --yes`. Without it
  `pnpm install` exits 1.
- **`drizzle-kit` needs Bun to see `.env`.** It runs under Node, which does not auto-load
  `.env`. The scripts invoke it as `bun --bun drizzle-kit …`. Calling `drizzle-kit` bare
  throws "DATABASE_URL is not set".
- **`sslmode=verify-full`, not `require`.** `pg` currently aliases `require` to `verify-full`
  but warns that a future major will weaken it to libpq semantics. The connection strings pin
  `verify-full` so the strong behaviour survives the upgrade.
- **`channel_binding=require`** in the URL is a libpq option. `pg` ignores it. Harmless, kept
  for parity with the console-issued string.
- **Drizzle builders are thenables, not Promises.** `expect(db.insert(…)).rejects` silently
  fails to work. Call `.execute()` when you need a real Promise.
- **Constraint names live on `error.cause`.** Drizzle wraps driver errors as
  `Failed query: …`. Assert `(err.cause as { constraint?: string }).constraint`, not the
  message, so a test cannot pass on an unrelated failure.
- **First query after idle is slow (~1s, sometimes more).** Neon scales compute to zero. This
  is a cold start, not a bug. Do not add a retry loop or a timeout "fix" to *production* code.
  Tests that touch the database do carry an explicit 30s timeout, because Bun's 5s default is
  genuinely too short for a cold start — without it the suite flakes.
- **`closeDatabase()` is idempotent, and only the test preload calls it.** The pool is a
  module singleton shared across every test file in a `bun test` process. A per-file
  `afterAll` closes it while a sibling file is still querying. Teardown lives in
  `src/common/testing/setup.ts`, preloaded via `bunfig.toml`.
- **Postgres is 18.6**, though the PRD says 16. Neon's current default. Everything the PRD
  needs — native enums, partial unique indexes, window functions, triggers — is present.
- **`pnpm` is 12.5.1**, not the `10.x` in PRD §9.2. Pinned to what is installed; pinning 10.x
  makes corepack chase a version that is not there.

---

## 7. Style

Biome, single quotes, 2-space indent, 100-column lines, import organisation on. Run
`pnpm format` rather than hand-aligning. Generated migrations are excluded from Biome.

Write code that matches the surrounding code. Comments explain **why**, not what.

---

## 8. Working agreements

- **Read the PRD section before implementing.** It usually contains the exact formula,
  constant or SQL you are about to guess at.
- **Do not add a dependency** without checking PRD §9.6, which already names the chosen tool
  for most concerns. Prefer the standard library and Bun built-ins.
- **Do not invent scope.** The PRD defines the system; implement what is asked.
- **Report honestly.** If a test fails, say so and show the output. If you skipped a step, say
  which. Never claim a command passed without running it.
