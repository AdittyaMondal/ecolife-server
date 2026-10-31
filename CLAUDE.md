# CLAUDE.md — ecolife-server

Instructions for AI agents working in this repository. Read this before writing code.

---

## 1. What this repo is

`ecolife-server` is the **API and domain layer** for EcoLife, a carbon-footprint tracker with
daily logging, goals, a points/coins economy, a marketplace and community events. It owns
**data, domain rules, auth and jobs**. It renders nothing.

**This is not a monorepo.** There are three independent repositories, one per developer:

| Repo | Owns | Runtime | Port | Owner |
|---|---|---|---|---|
| `ecolife-server` (this one) | data, domain rules, auth, jobs | Bun + Hono | 4000 | Adittya |
| `ecolife-web` | web rendering, admin console | Next.js 16 | 3000 | Yusuf |
| `ecolife-mobile` | the mobile app, QR scanning, offline | Expo 58 | — | Jenin |

Both clients talk to this server over HTTP and never query Postgres directly.

### The PRD is the source of truth

`../PRD-v2.md` (**outside this repo**, in the parent planning folder) is the authoritative
spec. `../SPRINT-PLAN.md` is the execution plan and ticket board.
**When this file and PRD-v2 disagree, PRD-v2 wins** — except where this file records something
already proven in code (§6), which wins over both.

> `../PRD.md` is **v1 and superseded**. It specified a Laravel→monorepo migration with an
> AgentHub capability marketplace. v2 is a greenfield build with no MCP, no AgentHub, no social
> feed and no AI coach. Do not implement from v1.

Markers used in PRD-v2:

- `[NEW]` — no v1 equivalent.
- `[CHANGE]` — deliberate divergence from v1.
- `[DEFERRED]` — explicitly out of scope. The 2D farm game is the big one: **do not build any
  part of it.** PRD-v2 §12 names the only three hooks v2 owes it.
- `[LESSON]` — a decision taken *because* v1's audit found the opposite approach broken. These
  are not optional and not up for redesign.

---

## 2. Current state — read this before assuming something exists

> **Sprint 0 is complete: the contract exists, the behaviour does not.**
> All 55 endpoints are declared, typed and documented. Every handler throws `GEN_501`.

What exists:

- Env config, zod-validated, fails fast at boot
- Drizzle client on the **pooled** endpoint; migrator on the **direct** endpoint
- An empty schema barrel at `src/database/schema/index.ts`
- `OpenAPIHono` app with request-id, logging, secure headers, CORS
- Response envelope, typed `DomainError`, error and not-found filters
- **The full API contract** — 9 modules, 55 paths, zod request/response schemas with realistic
  examples, generated to a committed `openapi.json`
- `docs/error-codes.md` — the code registry both clients branch on
- `health` module, fully implemented
- Tests covering the connection layer and the envelope

**What does not exist:** any table, any migration, auth, guards, the carbon engine, any domain
service or repository, jobs, WebSocket, seeds. Every route outside `health` is a declared
contract backed by `notImplemented()`. Do not claim otherwise, and do not import from an empty
directory.

The database is live and reachable but has **zero tables**. `pnpm migration:generate` reports
nothing to do until the schema in PRD-v2 §7 is written (ticket SRV-04).

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
| `pnpm gen:openapi` | Regenerate `openapi.json` from the route definitions |
| `pnpm gen:openapi:check` | Fail if `openapi.json` is stale (CI) |
| `pnpm mock` | Prism mock of `openapi.json` on :4010 — what the clients build against |

`npm run <script>` also works; dependencies are installed with **pnpm**.

### Before claiming work is done

Run all four. Do not report success on a subset:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

---

## 4. Non-negotiable rules

### 4.0 The contract is the product of this repo

Two developers are building against `openapi.json`. It is a **committed artifact**, not a
by-product.

- Declare every route with `createRoute()` on a router from `createModule()`. Never
  `new OpenAPIHono()` directly — the factory installs the `defaultHook` that routes zod
  validation failures through the envelope.
- Give every response field a realistic `.openapi({ example })`. Those examples **are** the
  mock the clients develop against, so a lazy example is a worse bug than a lazy handler.
- Run `pnpm gen:openapi` and **commit the result in the same PR** as any schema change.
- Announce it: `CONTRACT CHANGE: <endpoint> — <what moved>`. Both clients re-run their
  `gen:api` and get compile errors at the affected call sites.
- Declare only the status codes a route can actually produce. A documented 409 on an endpoint
  that cannot conflict is a lie the clients write dead branches against.
- **Every route currently declares `501`, because every handler currently throws it. Remove
  that `501` from a route the moment you implement it**, and regenerate. Leaving it behind is
  exactly the dead branch the previous bullet warns about — it just happens to be true today.

### 4.1 Every response uses the envelope

PRD-v2 §8. Never return a bare object.

```ts
// success
{ "status": true,  "data": { }, "error": null }
// failure
{ "status": false, "data": null, "error": { "code": "CARBON_014", "message": "…", "details": {} } }
```

Use `ok()` from `@common/interceptors/response-envelope.ts` for the success path. **To fail,
always `throw new DomainError(code, message, status, details)`** — the error filter maps it.

Do not *return* `fail()` from a route handler. A handler that returns both the success and the
failure envelope widens its return type into a union, and zod-openapi cannot match that
against the route's declared responses — it will not typecheck. `fail()` exists for the error
filter and the validation hook, not for handlers.

Error codes are `DOMAIN_NNN` and every one is registered in `docs/error-codes.md`.

**Never leak an internal error message or stack to the client.** Anything that is not a
`DomainError` becomes a generic `INTERNAL_001` 500, and the real error is logged server-side.

### 4.1.1 Never trust a client-supplied IP

`x-forwarded-for` and `x-real-ip` are set by whoever sends the request. Treating either as the
client's identity hands an attacker a rate-limit bypass and a poisoned audit trail — and
PRD-v2 §8.1 rate-limits `/auth/login` **per IP**, so this is the control standing between that
endpoint and a brute force.

The rule, for whoever implements the rate limiter (SRV-06) and the audit helper:

- **Default: use the socket address** and ignore `x-forwarded-for` entirely.
- A caller may assert an end-user IP **only** by presenting `INTERNAL_PROXY_TOKEN` in
  `x-ecolife-internal` and the address in `x-ecolife-client-ip`. That is how `ecolife-web`'s
  route handlers pass through the real user's IP without the browser being able to forge it.
- If a real reverse proxy is ever put in front of this server, read XFF from the **right**,
  skipping exactly `TRUSTED_PROXY_HOPS` entries. Never parse from the left — the leftmost
  entries are whatever the client wrote.
- Rate-limit keys are `userId ?? trustedIp`. Prefer `userId` wherever a route is
  authenticated; it cannot be spoofed.

A flagged review on `ecolife-web` (31/10/2026) came from forwarding the browser's own XFF
straight through. Do not reintroduce it on either side.

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
- `enums.ts` is mirrored into both client repos by codegen (PRD-v2 §9.4). Keep declarations
  literal and one value per line so the parser can read them.
- Cite the PRD-v2 section in a comment at the top of each table file.
- **Put invariants in the database, not only in a service.** PRD-v2 relies on this: a partial
  unique index for one-open-goal-per-user, a unique `(user_id, source, source_id)` on the
  reward ledger for idempotent awards, a check constraint for the 20% discount cap. These are
  `[LESSON]` items — v1's equivalent bugs were all "the service was supposed to check".

### 4.4 Module file convention

PRD-v2 §9.2. One concern per file, the same five names in every module:

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

PRD-v2 §6.1. Two clients with genuinely different needs, so the server issues both:

- Password hashing: `Bun.password.hash(pw, { algorithm: 'argon2id' })`.
- **Access token**: JWT, 15 minutes, returned in the body to both clients.
- **Refresh token**: opaque 32 random bytes, 30 days, **stored hashed** in `sessions`, rotated
  on every use, with reuse detection — a replayed token revokes the whole family.
- Web keeps the refresh token in an httpOnly `SameSite=Lax` Secure cookie set by a Next route
  handler; mobile keeps it in `expo-secure-store`. `POST /auth/refresh` accepts it from the
  cookie **or** the body, so one endpoint serves both.
- A `role` column gates admin. **Never a shared PIN** — that was v1's worst defect.
- Email verification is required before any reward is earned (PRD-v2 §4.4), not to browse.

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
- **`neon init` / `neon deploy` rewrite `.env` with NEON's naming, not ours.** They
  write `DATABASE_URL` = **pooled** and `DATABASE_URL_UNPOOLED` = direct, which is the exact
  inverse of §4.2. Left alone, migrations then run through PgBouncer. After any `neon` command
  that says "Pulled N Neon variables into .env", put it back:
  `DATABASE_URL` = direct (no `-pooler`), `DATABASE_URL_POOLED` = pooled, and delete
  `DATABASE_URL_UNPOOLED`. Back `.env` up first. They also downgrade `sslmode=verify-full`
  to `sslmode=require` — there is a test that catches this, and §6's note on `verify-full`
  says why it matters. `sed -i '' 's/sslmode=require/sslmode=verify-full/g' .env`.
- **`files-sdk` needs the AWS SDK hoisted.** It declares `@aws-sdk/*` as *peer* dependencies,
  and pnpm's isolated layout does not link a peer into the dependent's own folder, so
  `import '@aws-sdk/client-s3'` fails from inside `files-sdk` even though it is installed.
  `publicHoistPattern` in `pnpm-workspace.yaml` fixes it. Separately, Bun resolves a script
  outside the project from its OWN global cache — run storage scripts from the repo root or
  the import fails for a different reason that looks identical.
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
