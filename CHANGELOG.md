# Changelog

All notable changes to `ecolife-server`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Repository scaffold per PRD §9.2 — Bun + Hono + Drizzle + PostgreSQL, Biome, pnpm.
- `src/config/env.ts` — zod schema over `process.env`; refuses to boot on invalid input and
  reports failing variable names only, never values.
- `src/database/client.ts` — `node-postgres` pool on the pooled Neon endpoint.
- `src/database/migrate.ts` — forward-only migrator on the direct endpoint.
- Response envelope, `DomainError`, and the error/not-found filters (PRD §9.5).
- Hono app with request-id, logging, secure headers and CORS.
- `health` module: `GET /api/v1/health` (liveness) and `/api/v1/health/ready` (readiness).
- Tests covering pooled routing, TLS mode, database reachability and the envelope on both
  success and failure paths.
- `CLAUDE.md` / `AGENTS.md` agent instructions.

### Notes

- **No schema.** The data model is being redesigned; `src/database/schema/` is an empty barrel
  and the database has no tables. One file per table goes in when the new core is decided.
- Database is PostgreSQL 18.6 (Neon default), not the 16 named in the PRD. No schema impact.
- pnpm is 12.5.1, not the `10.x` named in PRD §9.2; pinned to the installed version.
